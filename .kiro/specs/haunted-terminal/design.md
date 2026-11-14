# Design Document: Haunted Terminal

## Overview

Haunted Terminal is a crypto paper-trading terminal with two clients (a Next.js web UI and a Ratatui TUI) that share one Bun server. The server supervises a native Rust engine that runs as a child process. All trading is simulated. Each signed-in wallet trades on its own paper account, and everyone else shares one guest account.

The design follows three rules that the requirements depend on:

1. **One protocol definition.** Every message type lives in the Rust `protocol` crate. ts-rs generates the TypeScript types, so the engine, server, web UI, and TUI cannot drift apart.
2. **One order path.** Every order, from any source, goes through the server's Router and Risk_Engine before a Command reaches the engine (Req 18).
3. **Deterministic core.** The engine's trading logic is a pure state machine driven by market-data time, not wall-clock time. This makes replay deterministic (Req 6.6, 12.6) and lets the core be tested with property-based tests without I/O.

The journal of orders, fills, and rejections lives in a Postgres database on Neon's Free plan. The server writes to it through Prisma ORM 7 (Prisma Client with a driver adapter) from a background queue, so a sleeping or unreachable database never delays or blocks an order (Req 20). Prisma Migrate owns the schema, and the container's start script applies migrations before the server starts. The paper accounts themselves stay in engine memory and all of them reset on every engine restart (Req 15.7, 15.8).

### Scope change: wallet accounts, TUI pairing, and Backpack data

The user approved this scope change after Tasks 1–3 and 4.1–4.3 were built. The five user decisions below are fixed. The design choices that follow from them are marked as Decisions A6 onwards in the sections where they apply.

**Facts this change relies on** (verified by the user from the vendors' docs; content was rephrased for compliance with licensing restrictions):

- Backpack Exchange has a public WebSocket at `wss://ws.backpack.exchange`. A client subscribes with `{"method":"SUBSCRIBE","params":["depth.SOL_USDC","trade.SOL_USDC"]}`, and messages arrive as `{"stream": "...", "data": {...}}`. Public streams need no authentication. An aggregated depth stream that emits every 200, 600, or 1000 ms also exists. Public REST market endpoints (markets, depth, klines, trades) live under `https://api.backpack.exchange`. Exact field names and the kline endpoint are checked against [docs.backpack.exchange](https://docs.backpack.exchange/) in Task 7.1.
- Jupiter has no devnet or testnet for swaps, and Backpack has no public testnet, so no testnet is used anywhere.
- Phantom and Backpack both implement Wallet Standard and Sign In With Solana (SIWS, in the style of CAIP-122). A wallet that lacks the `solana:signIn` feature can sign a SIWS-formatted message with `solana:signMessage`. The server verifies an Ed25519 signature over the message bytes. Addresses are base58.

**Decision A1: Execution stays paper only.** The Rust Matcher fills paper orders against the live (or replayed) public book. There are no real funds, no wallet transactions, and no authenticated exchange endpoints. "Paper fills on live public data" replaces any idea of testnet trading.

**Decision A2: One paper account per wallet, plus a shared guest account.** Each signed-in wallet gets its own Paper_Account with Account_Id `w_<base58 address>`. Connections without a valid Session_Token trade on the shared Account_Id `guest`, so judges without a wallet can use the app. This replaces the old "one shared paper account, no login" rule (Req 14). Every account, guest and wallet, resets when the engine restarts (Req 15.7, 15.8).

**Decision A3: Wallet sign-in with SIWS in the web UI.** Phantom and Backpack sign in through Wallet Standard and SIWS. The server issues a single-use Nonce that expires in 5 minutes, verifies the Ed25519 signature, and issues a stateless HMAC-SHA256 Session_Token signed with `SESSION_SECRET` (24 h expiry). The WebSocket authenticates with `ClientMessage::Authenticate { token }` after connect, because browsers can't set WebSocket headers. The wallet signs only the SIWS message, never a transaction (Req 45–47, 49).

**Decision A4: TUI pairing, device-code style.** The TUI gets an 8-character Pairing_Code from `POST /auth/pair`, shows it with a pair URL, and the user confirms the pairing in the web UI after signing in there. The TUI collects its Session_Token by polling `POST /auth/pair/poll` with the code and a TUI-generated Pairing_Secret, so someone who only knows the code can't take the token (Req 48).

**Decision A5: Live data from Coinbase or Backpack.** `LIVE_VENUE=coinbase|backpack` picks the venue in live mode, default `backpack`. Replay stays the default `DATA_MODE` for judges. Internal symbols stay BTC-USD, ETH-USD, and SOL-USD. Backpack's USDC pairs are treated as USD (Req 5, 43, 44).

## Architecture

```mermaid
flowchart LR
  subgraph Render
    S[Static site<br/>Next.js export]
    subgraph Docker[Docker web service]
      G[Bun server - Hono]
      E[Rust engine sidecar]
    end
  end
  B[Browser] -- loads --> S
  B -- wss /ws --> G
  T[TUI binary<br/>Windows / macOS] -- wss /ws --> G
  M[MCP stdio process<br/>launched by Kiro] -- ws + REST --> G
  W[Phantom / Backpack<br/>browser wallet] -- signs SIWS message only --> B
  B -- /auth/nonce, /auth/verify, /auth/pair/confirm --> G
  T -- /auth/pair, /auth/pair/poll --> G
  G -- JSON lines on stdin --> E
  E -- JSON lines on stdout --> G
  E -- stderr logs --> G
  E --> C[(Coinbase public WS / REST)]
  E --> BP[(Backpack public WS / REST)]
  E --> F[(fixtures/*.jsonl)]
  G -- Prisma Client + PrismaNeon<br/>DATABASE_URL, pooled --> N[(Neon Postgres<br/>journal)]
  SS[start.ts<br/>prisma migrate deploy] -- DIRECT_URL, direct --> N
  SS -- then starts --> G
```

### Process and data flow

```mermaid
sequenceDiagram
  participant C as Client (web/TUI)
  participant GW as Gateway
  participant P as Parser / LLM
  participant R as Router
  participant RK as Risk_Engine
  participant E as Engine
  participant Q as Journal_Queue
  participant DB as Neon Postgres
  GW-->>C: hello, session(account_id = guest)
  C->>GW: authenticate(token)   (only if the client holds a Session_Token)
  GW-->>C: session(account_id = w_<address>, address)
  C->>GW: command_text "BUY BTC 0.1 LMT 64000"
  GW->>P: parse
  P-->>GW: Order_Preview (preview_id)
  GW-->>C: preview
  C->>GW: confirm(preview_id)
  GW->>R: submit(order, source=client, account_id from the Connection_Session)
  R->>RK: check(order, that account's positions and open orders, market, now)
  alt rejected
    RK-->>R: reason
    R->>Q: enqueue rejection (sync, in memory)
    R-->>C: OrderRejected
  else approved
    R->>Q: enqueue order (sync, in memory)
    R->>E: PlaceOrder{account_id} (does not wait for the DB)
    E-->>GW: OrderAck / Fill / Position {account_id}
    GW->>Q: enqueue fill
    GW-->>C: publish on topic account:<account_id> only
  end
  Note over Q,DB: Journal_Writer runs in the background
  Q-)DB: createMany runs in one $transaction, retried with backoff
```

## Repository Layout

```
trade/
├─ .kiro/                 steering/, hooks/, specs/haunted-terminal/, settings/mcp.json
├─ rust/
│  ├─ Cargo.toml          workspace (protocol, engine, tui)
│  ├─ clippy.toml
│  ├─ .cargo/config.toml  TS_RS_EXPORT_DIR → ../shared/protocol
│  └─ crates/
│     ├─ protocol/        message types, wire codec, instruments
│     ├─ engine/          sidecar binary
│     └─ tui/             terminal client binary
├─ server/                Bun + Hono
│  ├─ prisma.config.ts    Prisma CLI config (schema path, migrations path, DIRECT_URL)
│  ├─ prisma/
│  │  ├─ schema.prisma    journal models
│  │  └─ migrations/      Prisma Migrate: <timestamp>_<name>/migration.sql + migration_lock.toml
│  ├─ scripts/start.ts    Start_Script: config check → prisma migrate deploy → server
│  └─ src/generated/prisma/  generated Prisma Client (gitignored, from `bun run db:generate`)
├─ web/                   Next.js 16 static export
├─ shared/
│  ├─ protocol/           generated TS (do not edit)
│  ├─ siws.ts             SIWS_Parser + SIWS_Formatter (hand-written, dependency-free; used by server and web)
│  └─ keymap.json
├─ fixtures/              replay data
├─ Dockerfile
├─ render.yaml
└─ .github/workflows/     ci.yml, release.yml
```

Root `package.json` declares Bun workspaces `server`, `web`, `shared`. `bun run check` runs `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`, then `check:ts`: `bun run db:generate` (`prisma generate`, which needs no database), `tsc --noEmit` for each TS package, and `bun test` (Req 41.2). The generated Prisma Client is gitignored, so generation must come before the typecheck (Decision J1).

## Components and Interfaces

### 1. Protocol crate (`rust/crates/protocol`)

#### Numeric types

| Type | Rust | Meaning | JSON |
|---|---|---|---|
| `Price` | `struct Price(i64)` | count of Ticks | decimal string, e.g. `"6400000"` |
| `Qty` | `struct Qty(i64)` | count of Lots (signed for positions) | decimal string |
| `Money` | `struct Money(i64)` | USD × 10⁻¹⁰ (`MONEY_DECIMALS = 10`) | decimal string |
| `TimeMs` | `i64` | Unix epoch milliseconds | number |
| indicator values | `f64` | the only floats (Req 1.5) | number |

All three i64 newtypes serialize as JSON strings. JavaScript numbers lose precision above 2⁵³, and `Money` passes that at about $900,000. TypeScript code converts them with `BigInt`. ts-rs annotates them as `string` (`#[ts(type = "string")]`).

#### Instruments (Req 4)

```rust
pub struct Instrument {
    pub symbol: &'static str,     // "BTC-USD"
    pub short: &'static str,      // "BTC"
    pub price_decimals: u32,      // tick = 10^-price_decimals USD
    pub qty_decimals: u32,        // lot  = 10^-qty_decimals base units
}
pub fn instrument(symbol: &str) -> Option<&'static Instrument>;
```

Tick and lot sizes are powers of ten, and `price_decimals + qty_decimals <= MONEY_DECIMALS`, so notional is exact:

```
notional(price, qty) = price.0 as i128 * qty.0 as i128 * 10^(MONEY_DECIMALS - pd - qd)   // checked → Money
```

Table:

| Symbol | price_decimals (tick) | qty_decimals (lot) |
|---|---|---|
| BTC-USD | 2 (0.01) | 8 (0.00000001) |
| ETH-USD | 2 (0.01) | 8 (0.00000001) |
| SOL-USD | 2 (0.01) | 8 (0.00000001) |

**Decision A6: Fixed internal decimals, exact venue conversion.** The table above is fixed for every venue (Req 44.3). The engine does not adapt decimals at startup from the active venue. Reasons: fixtures recorded from one venue replay the same under any `LIVE_VENUE`; the protocol, journal, and clients never see two precisions for one symbol; and the existing completed work (Tasks 2 and 4) already assumes this table. Venue prices and sizes are decimal strings, converted to ticks and lots with exact string arithmetic (`venue::to_ticks(&str) -> Result<Price, Inexact>`), never floats.

- Venue increments: the design expects both venues to quote these three pairs with ticks of 0.01 or coarser and size steps of 0.00000001 or coarser. This is not verified yet. Task 7.1 reads each value from the Backpack markets endpoint and the Coinbase products endpoint. If a venue tick is finer than 0.01 (for example SOL at 0.001), the user decides in Task 7.1 whether to raise `price_decimals` for that symbol in a protocol change, since the table is shared. At live startup the engine reads that metadata and logs an error for any symbol whose tick or step is not a whole multiple of the internal tick or lot (Req 44.4).
- Values that don't fit: a message holding a price or quantity with more decimals than the table allows (non-zero digits past the 2nd or 8th place) is dropped, never rounded, and counted. The count is logged at most once every 10 s (Req 44.5). Rounding was rejected because a rounded book level could merge with its neighbour and a rounded trade would change volume and VWAP.
- Trailing zeros are fine: `"64000.10"` and `"64000.1"` both convert to 6400010 ticks.

The instrument table is also sent to clients in the `hello` message, so the web UI and TUI format ticks and lots without their own copy.

#### Engine Commands (server → engine, Req 1.1)

Internally tagged with `#[serde(tag = "type", rename_all = "snake_case")]`.

```rust
pub enum Command {
    Subscribe   { symbol: String, timeframe: Timeframe },
    Unsubscribe { symbol: String, timeframe: Timeframe },
    PlaceOrder  { account_id: AccountId, order_id: OrderId, symbol: String, side: Side, qty: Qty, kind: OrderKind },
    Cancel      { account_id: AccountId, order_id: OrderId },
    CancelAll   { account_id: AccountId },
    StartReplay { fixture: String, speed: u32 },
    ResetAccount{ account_id: AccountId },
    Ping        { id: u64 },
}
pub enum Side { Buy, Sell }
pub enum Timeframe { M1, M5, M15, H1, D1 }            // serde: "1m","5m","15m","1h","1d"
pub enum OrderKind { Market, Limit { price: Price }, Stop { stop_price: Price } }
pub struct OrderId(String);                          // 1..=64 chars of [A-Za-z0-9_-]
pub struct AccountId(String);                        // 1..=64 chars of [A-Za-z0-9_]: "guest" or "w_<base58 address>"
pub enum Venue { Coinbase, Backpack }                // serde: "coinbase", "backpack"
```

**Decision A7: `account_id` on order Commands and account Events (protocol v2).** Tasks 2.x shipped protocol version 1 without accounts. Task 17 adds `account_id` to `PlaceOrder`, `Cancel`, `CancelAll`, and `ResetAccount`, and to `OrderAck`, `OrderRejected`, `Fill`, and `Position`, and bumps `protocol_version` to 2 (Req 1.9).

- `AccountId` is a newtype like `OrderId`. `decode_command` rejects an id outside 1..=64 characters of `[A-Za-z0-9_]` with an `Error` event (Req 1.10, 2.5). The engine treats it as an opaque key; only the server knows the `guest` / `w_` convention. A base58 Solana address is 32 to 44 characters from an alphabet inside `[A-Za-z0-9]`, so `w_<address>` is at most 46 characters.
- `CancelAll` and `ResetAccount` change from unit variants to struct variants. On the wire: `{"type":"cancel_all","account_id":"guest"}`.
- There is no "reset every account" command. Every account resets when the engine restarts, which is the only global reset (Req 15.7).

#### Engine Events (engine → server, Req 1.2)

```rust
pub enum Event {
    Candle      { symbol, timeframe, snapshot: bool, bars: Vec<Bar> },   // snapshot=true: history (≤500)
    Trade       { symbol, price: Price, qty: Qty, side: Side, ts: TimeMs },
    Book        { symbol, bids: Vec<Level>, asks: Vec<Level>, spread: Option<Price>,
                  imbalance_bps: i32, ts: TimeMs },                     // imbalance in [-10000, 10000]
    Indicators  { symbol, timeframe, ts: TimeMs, values: IndicatorValues },
    OrderAck    { account_id, order_id, status: OrderStatus },            // accepted | canceled | filled
    OrderRejected { account_id, order_id, reason: String },
    Fill        { account_id, order_id, symbol, side, price: Price, qty: Qty, fee: Money, remaining: Qty, ts: TimeMs },
    Position    { account_id, symbol, qty: Qty, avg_entry: Option<Price>, realized: Money, unrealized: Money },
    Heartbeat   { ts: TimeMs },
    Pong        { id: u64 },
    Error       { code: ErrorCode, message: String },
}
pub struct Bar { pub t: TimeMs, pub open: Price, pub high: Price, pub low: Price, pub close: Price, pub volume: Qty }
pub struct Level { pub price: Price, pub qty: Qty }
pub struct IndicatorValues { ema, sma, vwap, bb_upper, bb_mid, bb_lower, rsi, atr: Option<f64> }
```

Imbalance is in basis points, `(bid_qty − ask_qty) × 10000 / (bid_qty + ask_qty)` over the top N levels, so it stays an integer (Req 1.5).

#### Client ↔ Server messages

These live in the protocol crate too (module `client`), so the TUI parses them with the same types and TS gets generated types.

```rust
pub enum ClientMessage {                    // tag "type"
    Subscribe   { symbol, timeframe },
    Unsubscribe { symbol, timeframe },
    CommandText { request_id: String, text: String },   // "BUY ..." or "? plain English"
    Confirm     { request_id: String, preview_id: String },
    Discard     { preview_id: String },
    Cancel      { request_id: String, order_id: OrderId },
    CancelAll   { request_id: String },                 // client confirms first (Req 30.5)
    FlattenAll  { request_id: String },                 // client confirms first (Req 30.4)
    ResetAccount{ request_id: String },                 // resets the connection's own account only
    Authenticate{ token: String },                      // Session_Token; sent after connect (Req 1.7, 46.2)
    Ping        { id: u64 },
}
pub enum ServerMessage {                    // tag "type"
    Hello       { protocol_version: u32, data_mode: DataMode, venue: Option<Venue>,   // venue: Some in live mode only
                  engine_running: bool, instruments: Vec<InstrumentInfo> },
    Event       { event: Event },
    Preview     { request_id: String, preview: OrderPreview },
    ParseError  { request_id: String, message: String, position: usize },
    Notice      { kind: NoticeKind, message: String },
    // NoticeKind: account_reset | engine_down | engine_up | llm_disabled | auth_failed | session_expired | signed_out
    Session     { account_id: AccountId, address: Option<String> },  // sent after Hello and after every account change (Req 1.8, 46)
    Pong        { id: u64 },
}
pub struct OrderPreview { pub preview_id: String, pub text: String, pub action: PreviewAction, pub expires_at: TimeMs }
pub enum PreviewAction { Place { symbol, side, qty: Qty, kind: OrderKind }, CancelAll, FlattenAll }
```

#### Wire codec (Req 2)

- One message per line, UTF-8, `\n` terminated. `serde_json::to_string` never emits raw newlines, so each message is one line.
- `decode_command(line: &str) -> Result<Command, ProtocolError>` parses and then validates ranges (symbol known, qty > 0, prices > 0, speed 1..=50, order id format). Failures map to `Event::Error` (Req 2.4, 2.5).
- TypeScript is exported with `cargo test -p protocol` (ts-rs export tests), wrapped by `bun run gen:protocol`. `TS_RS_EXPORT_DIR` is set in `rust/.cargo/config.toml` so the files land in `shared/protocol/`. The generated files are committed.

### 2. Engine (`rust/crates/engine`)

```
engine/src/
├─ main.rs          clap: `engine run --mode replay|live --venue coinbase|backpack --fee-bps 5 --fixtures <dir>`,
│                   `engine record --venue coinbase|backpack --symbols ... --out <fixture> [--duration]`, `engine synth`
├─ runtime.rs       tokio wiring: stdin reader, stdout writer, feed task, 1 s heartbeat timer
├─ core.rs          Engine state machine (pure, no I/O)
├─ feed/
│  ├─ mod.rs        MarketMsg (normalized market data)
│  ├─ replay.rs     fixture reader, speed control, looping
│  ├─ venue.rs      Venue enum, Venue_Symbol_Map, exact decimal → tick/lot conversion, drop counter
│  ├─ coinbase.rs   Coinbase_Adapter: WS + REST backfill (live mode)
│  ├─ backpack.rs   Backpack_Adapter: WS + REST snapshot/backfill (live mode)
│  └─ fixture.rs    fixture line encode/decode
├─ candles.rs       Candle_Builder
├─ book.rs          Order_Book
├─ indicators.rs    Indicator_Engine
├─ matcher.rs       Matcher (open orders keyed by order id, each tagged with its AccountId)
└─ account.rs       Accounts: BTreeMap<AccountId, PaperAccount>; Paper_Account and Positions
```

#### Runtime

A single tokio task owns the `Engine` and selects over three inputs:

1. lines from stdin → `decode_command` → `engine.on_command(cmd)`,
2. `MarketMsg` values from the feed task → `engine.on_market(msg)`,
3. a 1 s interval → `Event::Heartbeat` with wall-clock time (Req 3.4).

Output events go to a stdout writer task, one JSON line each, flushed after each batch. Logs go to stderr through `tracing_subscriber::fmt().with_writer(std::io::stderr)` (Req 3.3). When stdin reaches EOF, the runtime shuts down the feed and exits with code 0 (Req 3.5).

#### Core

```rust
impl Engine {
    pub fn on_command(&mut self, cmd: Command) -> Vec<Event>;
    pub fn on_market(&mut self, msg: MarketMsg) -> Vec<Event>;
}
pub enum MarketMsg {
    Trade    { symbol, price: Price, qty: Qty, side: Side, ts: TimeMs },
    BookSnapshot { symbol, bids: Vec<Level>, asks: Vec<Level>, ts: TimeMs },
    BookDelta    { symbol, side: Side, price: Price, qty: Qty, ts: TimeMs },
}
```

The core keeps "now" as the timestamp of the latest market message. Book throttling, stop triggers, order timestamps, and candle buckets all use that time. Because the core never reads the clock, the same inputs always produce the same events.

#### Market feed

- **Replay (default, Req 6).** `StartReplay { fixture, speed }` loads `fixtures/<fixture>`. The name must match `^[a-z0-9-]+\.jsonl$`, which blocks path traversal. Messages are released with `recorded_delay / speed` between them. When the file ends, replay loops and shifts timestamps by the fixture duration, so a hosted demo can run for days. The server sends `StartReplay` after each engine start when `DATA_MODE=replay`.
- **Fixture format.** One `{"recv": TimeMs, "msg": MarketMsg}` per line. The Recorder normalizes Coinbase messages into `MarketMsg` before writing, so replay and live go through identical code (Req 7). A fixture may contain several symbols. The default fixture is `fixtures/demo.jsonl` with BTC-USD, ETH-USD, and SOL-USD.
- **`engine synth`.** Writes a seeded random-walk fixture (trades, book snapshots, and deltas) so the repo has demo data before any live recording.
- **Live (Req 5, 43, 44).** `--venue` (from the server's `LIVE_VENUE`, default `backpack`) picks the adapter. Both adapters use tokio-tungstenite with rustls and the `ring` provider, send no credentials, reconnect with exponential backoff (500 ms doubling to 30 s, emitting an `Error` event on each disconnect), resubscribe, and emit only `MarketMsg` values with internal symbols. The engine core never sees venue symbols or venue JSON.
  - **Coinbase_Adapter (Req 5).** Coinbase public market-data WebSocket (trades and level2), plus REST candle backfill on subscribe. Exact endpoints and channel names are confirmed against Coinbase docs in Task 7.1.
  - **Backpack_Adapter (Req 43).** See "Backpack_Adapter" below.
- **Venue_Symbol_Map (Req 44.2).** A static table in `feed/venue.rs`:

  | Internal | Coinbase | Backpack |
  |---|---|---|
  | BTC-USD | BTC-USD | BTC_USDC |
  | ETH-USD | ETH-USD | ETH_USDC |
  | SOL-USD | SOL-USD | SOL_USDC |

  **Decision A8: USDC is treated as USD.** Backpack's pairs quote in USDC. The terminal shows them as `-USD` symbols and does no FX conversion. The README and the status bar ("LIVE · Backpack (USDC)") say so. USDC normally trades within a fraction of a percent of USD, which is below the noise of a paper-trading demo.

#### Backpack_Adapter (Req 43)

Endpoint facts come from the user's check of the Backpack docs (see the Overview). Field names below are placeholders until Task 7.1 confirms them against [docs.backpack.exchange](https://docs.backpack.exchange/).

- **Connect:** `wss://ws.backpack.exchange`, then one `{"method":"SUBSCRIBE","params":["trade.BTC_USDC","depth.BTC_USDC", ...]}` for all three symbols. Messages arrive as `{"stream": "<stream name>", "data": {...}}`. The adapter dispatches on the stream name prefix (`trade.` or `depth.`) and the symbol suffix, and ignores unknown streams with a debug log.
- **Depth stream choice:** the real-time `depth.<symbol>` stream, not the aggregated 200/600/1000 ms variant, because the engine already throttles Book events to 100 ms of market time (Req 9.7) and the sequence check below needs every update. If Task 7.1 finds the real-time stream too heavy for the free Render instance, switching to the 200 ms variant is a one-line change, provided the aggregated stream keeps first/last update ids.
- **Book sync (Req 43.5, 43.6):** the expected protocol, in the usual exchange style, is: buffer depth updates after subscribing; fetch `GET https://api.backpack.exchange/api/v1/depth?symbol=<sym>`, which returns a snapshot with a last update id; drop buffered updates at or before that id; emit `MarketMsg::BookSnapshot` and then one `BookDelta` per changed level for each later update. Each update carries a first and last update id. If an update's first id isn't the previous last id + 1, the adapter discards its local state for that symbol and resyncs from a new snapshot. Task 7.1 confirms the id field names and their exact continuity rule.
- **Trades:** each trade message becomes `MarketMsg::Trade`. The aggressor side comes from the venue's buyer-is-maker flag (maker buyer → aggressor sell). Backpack timestamps may be in microseconds; Task 7.1 confirms the unit, and the adapter converts to `TimeMs`.
- **Backfill (Req 43.2):** on a candle subscription in live mode, `GET https://api.backpack.exchange/api/v1/klines?symbol=<sym>&interval=<1m|5m|15m|1h|1d>&startTime=<s>` (parameter names and time unit confirmed in Task 7.1), converted with `venue::to_ticks`/`to_lots` and fed to the Candle_Builder as closed history bars before live trades.
- **Keepalive:** tungstenite answers server pings automatically. If Backpack also expects a client ping or an application-level message, Task 7.1 adds it.
- **Decimals:** every price and size string goes through `venue::to_ticks`/`to_lots` (Decision A6). A value that doesn't fit drops the whole message and bumps the drop counter.
- **Recorder (Req 7.1):** `engine record --venue backpack` runs the same adapter and writes its normalized `MarketMsg` output as fixture lines, so Backpack fixtures replay through the same code as Coinbase ones.

#### Candle_Builder (Req 8)

- Buckets are `floor(ts / tf_ms) * tf_ms` in UTC. 1d uses 86 400 000 ms.
- Each trade updates the 1m bar. Higher timeframe bars are updated by merging the 1m update: `high = max`, `low = min`, `close = latest`, `volume += qty`, `open` set when the bucket starts. This is aggregation of 1m bars (Req 8.3). A property test checks it against building each timeframe directly from trades (Req 8.6).
- Each (symbol, timeframe) keeps a `VecDeque<Bar>` of the latest 500 bars (Req 8.7).
- On `Subscribe`, the engine emits `Candle { snapshot: true, bars }` before any live update for that subscription. After that, each change to the current bar emits `Candle { snapshot: false, bars: [bar] }` (Req 8.8).

#### Order_Book (Req 9)

- Per symbol: `BTreeMap<Price, Qty>` for bids and asks.
- Snapshot replaces both sides. A delta with qty > 0 sets the level, qty = 0 removes it, and qty < 0 is discarded with an `Error` event.
- **Crossed-book rule (9.5).** After a bid delta at price p, remove asks with price ≤ p. After an ask delta at p, remove bids with price ≥ p. This keeps best bid < best ask.
- `N = 20` levels per side in `Book` events.
- **Throttle (9.7).** A dirty book is emitted when market time ≥ `last_emit + 100 ms`. A dirty book that misses its window is emitted on the next market message for that symbol after the window passes. Using market time keeps replay deterministic.

#### Indicator_Engine (Req 10)

Fixed parameters: EMA(20), SMA(20), Bollinger(20, 2σ), RSI(14, Wilder), ATR(14, Wilder), VWAP anchored to the UTC day.

Each indicator keeps committed state for closed bars and offers a non-mutating `peek(current_bar)` for the forming bar. When a bar closes, its values are committed. This gives incremental updates on every candle change (10.1) without corrupting state. Values are `None` until the window has enough bars.

#### Matcher (Req 11, 12)

- Orders match against the engine's view of the market book. Paper orders don't change the market book. Within one matching pass, an order walks levels from the best price and fills each part at that level's price (12.2).
- **Market:** walks the opposite side. Any unfilled remainder stays open and is retried on the next book update (12.1).
- **Limit buy/sell:** fills only at prices ≤ / ≥ the limit (11.2, 11.3, 11.10). The remainder rests and is re-checked on each book update for its symbol (11.4).
- **Stop:** triggers when the last trade price reaches or crosses the stop price (buy: last ≥ stop, sell: last ≤ stop), then becomes a market order (11.5).
- **Fees:** `fee = notional × fee_bps / 10_000`, rounded toward zero, in `Money` (12.3).
- **Events:** `OrderAck accepted` on acceptance, a `Fill` per fill with `remaining`, then `OrderAck filled` when remaining reaches 0. `Cancel` of an unknown id gives `OrderRejected` (11.9).
- Invariant: `filled + remaining == original` for every order (12.5).
- **Accounts (Req 14):** every open order stores its `AccountId`. Fills settle against that account only. `Cancel { account_id, order_id }` for an order that is open under a different account gives `OrderRejected` naming the order id, and the order stays open (14.6). `CancelAll { account_id }` removes only that account's orders (14.7). Paper fills never change the market book (14.8), so one account's fill can't change the liquidity another account sees. Matching passes over the open orders run in order-id insertion order across all accounts, which keeps output deterministic (P7, P16) and gives each account the events it would get alone (P28).

#### Paper_Account (Req 13, 14)

**Decision A9: Account map in the engine, created lazily, capped at 1,000.** `Accounts` is a `BTreeMap<AccountId, PaperAccount>` (a BTreeMap so iteration order, and therefore event order, is deterministic). The first `PlaceOrder` for an unknown `AccountId` creates a flat account (14.4). When 1,000 accounts already exist, a `PlaceOrder` for a new account gets `OrderRejected { reason: "account_limit" }` (14.5). The cap bounds engine memory, because wallet keypairs are free to create. Accounts are never evicted while the engine runs, so realized P&L stays visible; the engine restart that resets everything also frees them. `Cancel`, `CancelAll`, and `ResetAccount` for an unknown account create nothing: `Cancel` gets `OrderRejected`, the other two are no-ops that still emit the flat `Position` events for `ResetAccount`.

Each `PaperAccount`, per symbol, tracks a signed `qty: Qty`, `cost_basis: Money` (signed, the notional of the open position), and `realized: Money`.

- **Increasing fill:** `cost_basis += notional(fill)`. `avg_entry = cost_basis / qty`, rounded to the nearest tick for display only.
- **Reducing fill of r lots:** `removed = cost_basis × r / |qty|` (i128, toward zero; the whole basis when the position closes). `realized += direction × (notional(fill) − removed) − fee`.
- **Fill that crosses zero:** split into a reducing part and an opening part.
- **Unrealized:** `notional(last, qty) − cost_basis`, recomputed when the last trade price changes (13.3). A trade emits a `Position` event for each account with a non-zero position in that symbol, in `AccountId` order.
- **`ResetAccount { account_id }`:** cancels that account's orders, flattens its positions, zeroes its P&L, and emits `Position` for every symbol with that `account_id` (14.3). Other accounts are untouched.

Exact integer basis tracking makes the round-trip property (13.5) hold with no rounding.

### 3. Server (`server/`)

```
server/src/
├─ main.ts              wires everything; Bun.serve
├─ config.ts            Zod env schema (Req 16)
├─ protocol.ts          Zod schemas mirroring generated types; bigint helpers
├─ engine/
│  ├─ lines.ts          incremental JSON-lines splitter
│  ├─ backoff.ts        500 ms → 30 s, reset after 60 s uptime
│  └─ supervisor.ts     Bun.spawn, stdin writer, stdout/stderr readers, restart
├─ gateway/
│  ├─ origin.ts         ALLOWED_ORIGINS check
│  ├─ clients.ts        per-client state, subscription ref-counts, Bun topics
│  └─ ws.ts             ClientMessage handling
├─ http.ts              Hono app: /health, /orders, /positions, /journal, /quote/:symbol, /candles/:symbol; mounts auth routes; CORS
├─ auth/
│  ├─ siws.ts           SIWS_Parser, SIWS_Formatter, field checks (pure)
│  ├─ ed25519.ts        verifyEd25519(pub, msg, sig) via WebCrypto; base58 via @scure/base
│  ├─ token.ts          Session_Token issue/verify (HMAC-SHA256), Token_Denylist (pure, injectable clock)
│  ├─ nonces.ts         Nonce store: single use, 5 min expiry, bound to address + origin (pure, injectable clock)
│  ├─ pairing.ts        Pairing store: create, confirm, poll (pure, injectable clock)
│  ├─ ratelimit.ts      per-IP fixed-window limiter (pure, injectable clock)
│  ├─ clientip.ts       client IP from the request (proxy-aware)
│  ├─ bearer.ts         Authorization header → AccountId | 401, shared by REST routes
│  └─ routes.ts         /auth/nonce, /auth/verify, /auth/logout, /auth/pair, /auth/pair/confirm, /auth/pair/poll
├─ state/
│  ├─ market.ts         last trade, top of book, candle cache per (symbol, tf)
│  └─ account.ts        positions + open orders per AccountId, from engine events
├─ commands/
│  ├─ parser.ts         Command_Parser
│  ├─ formatter.ts      Command_Formatter
│  └─ previews.ts       pending previews (id → client, action, expiry 60 s)
├─ risk/
│  ├─ limits.ts         Risk_Limits defaults
│  └─ risk.ts           pure check(order, ctx) → Approve | Reject(reason)
├─ router.ts            the only sender of order Commands
├─ journal/
│  ├─ store.ts          JournalStore interface, record and row types, mergeJournal()
│  ├─ prisma.ts         PrismaJournalStore + createPrismaJournalStore() adapter factory
│  ├─ adapter.ts        pickAdapter(url, DB_ADAPTER) → "neon" | "pg" (pure)
│  ├─ memory.ts         MemoryJournalStore (tests; local runs without DATABASE_URL)
│  ├─ queue.ts          bounded Journal_Queue + Journal_Writer (batching, retry, Journal_Status)
│  └─ deploy.ts         runs `prisma migrate deploy` via Bun.spawn with DIRECT_URL, redacted output
├─ generated/prisma/    generated Prisma Client (gitignored; never hand-edit)
├─ llm/
│  ├─ provider.ts       LLM_Provider interface
│  ├─ openai.ts         OpenAI structured output
│  └─ parser.ts         LLM_Order_Parser
└─ mcp/main.ts          MCP stdio server (separate process)
```

#### Configuration (Req 16)

| Var | Default | Notes |
|---|---|---|
| `PORT` | `8080` | Render sets this |
| `ENGINE_PATH` | `rust/target/release/engine(.exe)` | `.exe` added on `win32` |
| `DATA_MODE` | `replay` | `replay` \| `live` |
| `LIVE_VENUE` | `backpack` | `coinbase` \| `backpack`. Passed to the engine as `--venue`. Ignored in replay mode (Req 44.1) |
| `REPLAY_FIXTURE` | `demo.jsonl` | |
| `ALLOWED_ORIGINS` | `http://localhost:3000` | comma-separated |
| `WEB_URL` | first entry of `ALLOWED_ORIGINS` | origin of the web UI, used to build the TUI pair URL `<WEB_URL>/pair?code=…`. Must be listed in `ALLOWED_ORIGINS`, else exit 1 (16.9) |
| `SESSION_SECRET` | unset | **secret**. HMAC key for Session_Tokens. At least 32 bytes (UTF-8 length). Required when `NODE_ENV=production` (16.7). Unset outside production: a random 32-byte secret per process, with a warning that tokens won't survive a restart (16.8). Render: `generateValue: true` (Decision A12) |
| `DATABASE_URL` | unset | **secret** (the whole URL, not just the password). Neon **pooled** connection string (`…-pooler…`) with `sslmode=require`. Used at runtime by the Prisma Client through the driver adapter. Required when `NODE_ENV=production` (16.5). Unset outside production: in-memory journal with a warning (16.6). Local value comes from `.env` (gitignored). Render: set in the dashboard (`sync: false`) |
| `DIRECT_URL` | unset | **secret** (the whole URL). Neon **direct** (non-pooled) connection string with `sslmode=require`. Used only by Prisma Migrate (`prisma.config.ts`, the Start_Script). Required when `NODE_ENV=production` (16.5). Local value from `.env`. Render: dashboard (`sync: false`) |
| `DB_ADAPTER` | unset | `pg` or unset. `pg` forces `@prisma/adapter-pg`. Unset: the adapter is chosen from the `DATABASE_URL` host (Decision J3) |
| `KILL_SWITCH` | `false` | `true` \| `false` |
| `OPENAI_API_KEY` | unset | secret; never logged |
| `OPENAI_MODEL` | set in Task 13 | verified against current OpenAI models then |
| `NODE_ENV` | unset | `production` makes both `DATABASE_URL` and `DIRECT_URL` required (16.5). The Dockerfile sets `ENV NODE_ENV=production` |

`DATABASE_URL` and `DIRECT_URL` are validated with Zod as URLs whose scheme is `postgres:` or `postgresql:`. The schema does not require `sslmode=require`, because the CI service container has no TLS. The README tells users to keep `sslmode=require` in both Neon URLs.

Invalid values log the variable name (never its value) and exit with code 1. With `NODE_ENV=production`, each of `DATABASE_URL` and `DIRECT_URL` that is unset is logged by name, then the process exits with code 1 (16.5). The parsed config object redacts `OPENAI_API_KEY`, `DATABASE_URL`, `DIRECT_URL`, and `SESSION_SECRET` in `toJSON` and `inspect`. A `redactSecrets(text)` helper replaces any occurrence of the full `DATABASE_URL`, the full `DIRECT_URL`, either password, `OPENAI_API_KEY`, or `SESSION_SECRET` with `***`. Session_Tokens and Pairing_Secrets are never logged at all: the auth routes log only the outcome, the account id, and the jti (Req 16.4). The request logger drops the `Authorization` header and the bodies of `/auth/*` requests. Every Prisma Client error, every Prisma Client `warn`/`error` log event, and every line of `prisma migrate deploy` output passes through it before it reaches the log, because driver and CLI errors can quote connection details (16.4).

#### Engine_Supervisor (Req 15)

- `Bun.spawn([enginePath, "run", "--mode", mode, "--venue", liveVenue, "--fixtures", dir], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })`. `--venue` is passed in both modes and used only in live mode.
- stdout goes through `lines.ts` and Zod `EventSchema`. Invalid lines are logged and dropped. stderr is forwarded to the server log with an `[engine]` prefix.
- **On exit:** mark the engine down, broadcast `Notice engine_down`, clear the account cache, schedule a restart with `backoff.next()`.
- **On start:** generate a new Session_Id with `crypto.randomUUID()` and hand it to the journal (20.18), send `StartReplay` (replay mode), resend every active subscription, broadcast `Notice account_reset` (only after a restart) and `engine_up` (15.4, 15.7). Account state is not restored from the journal (15.8).
- The backoff object is a pure class with an injectable clock, so it's unit-testable.

#### Gateway (Req 17)

- `Bun.serve({ fetch, websocket })`. `/ws` upgrades go through `origin.ts`. A request with an `Origin` header not in `ALLOWED_ORIGINS` gets 403. Requests without `Origin` (TUI, MCP, CLI tools) are allowed, because browsers always send it and the check exists to stop other websites. Everything else goes to the Hono app.
- On open, send `Hello`.
- Each client message is validated with Zod. Invalid messages get a `ServerMessage::Event(Error)` and the connection stays open (17.4).
- **Subscriptions** are ref-counted per (symbol, tf):
  - The first subscriber triggers an engine `Subscribe`, and the engine's history snapshot is cached.
  - Later subscribers get the cached snapshot directly.
  - The last unsubscribe sends `Unsubscribe`.
- **Bun pub/sub topics:**
  - `candles:<symbol>:<tf>` carries Candle and Indicators.
  - `market:<symbol>` carries Trade and Book.
  - `account:<account_id>` carries OrderAck, Fill, and Position for that account only (17.7). This replaces the global `account` topic that Task 3.5 built.
  - `notices` carries Notice messages about the engine and account resets, and every connection subscribes to it on open (17.9).
  - `OrderRejected` is sent only to the requesting connection (19.7). An engine `OrderRejected` whose requester has closed goes to `account:<account_id>` (17.10).
- **Connection_Session (Req 46).** Each connection's `ws.data` holds `{ accountId, address, jti, exp }`. On open it is the guest session, the connection subscribes to `account:guest` and `notices`, and the gateway sends `Hello` then `Session { account_id: "guest", address: null }` (46.1).
  - `Authenticate { token }` → `auth.verifyToken(token, now)`. Accepted: unsubscribe the old `account:` topic, subscribe `account:w_<address>`, store the session, record `jti → connection` in the gateway's index, send `Session` (46.2). Rejected: switch to guest the same way, send `Session` and `Notice auth_failed` (46.3). Either way, the connection's pending previews are discarded when the account changes (46.4).
  - Expiry: the Router checks `exp` on each order request. A request after `exp` is rejected with `session_expired`, and the connection drops to guest with `Session` and `Notice session_expired` (46.5). There is no per-connection timer.
  - Logout: when the Auth_Service denylists a jti, the gateway looks it up in the `jti → connections` index and drops each of those connections to guest with `Session` and `Notice signed_out` (46.6).
  - The pure function `routeAccountEvent(event, sessions) → connectionIds` decides delivery and is the subject of P34. Publishing then uses the topic, which gives the same set.
- **Decision A10: Topic per account, not a server-side filter.** Bun's `publish` to `account:<id>` reaches only subscribed sockets, with no per-socket loop in TypeScript. Changing a connection's account is an unsubscribe plus a subscribe. The alternative, one `account` topic plus a filter, would need a manual loop over every socket for every fill.

#### Command_Parser and Command_Formatter (Req 21)

Grammar (keywords case-insensitive, tokens separated by whitespace):

```
command  := order | "CANCEL" "ALL" | "FLAT"
order    := side symbol amount [ ("LMT" | "STP") price ]
side     := "BUY" | "SELL"
symbol   := "BTC" | "ETH" | "SOL" | "BTC-USD" | "ETH-USD" | "SOL-USD"
amount   := decimal | percent "%"          ; percent in (0, 100]
decimal  := digits [ "." digits ]
```

- `parse(text, ctx) → { ok: ParsedCommand } | { error: { message, position } }`. `position` is the character offset of the first invalid token (21.5).
- Decimal → ticks/lots uses string arithmetic on the instrument's decimals, never floats. A value with more decimals than the instrument allows is a parse error naming the value (4.4).
- **`%` amounts** resolve against the current position: `floor(|pos| × pct / 100)` lots, with the side as typed. A result of 0 is a parse error. A percent amount can't be combined with LMT/STP in this version, so it's a market order.
- `format(ParsedCommand) → string` produces canonical text, e.g. `BUY BTC-USD 0.1 LMT 64000.00`. `parse(format(c)) == c` (21.9).

#### Risk_Engine (Req 19)

`check(order, ctx) → { ok: true } | { ok: false, reason }`, where `ctx = { limits, positions, openOrderCount, lastPrice, bestBid, bestAsk, killSwitch, rateWindow(clientId), now }`. The function is pure, and the token bucket state is passed in and returned. `positions` and `openOrderCount` are those of the order's account (from `state/account.ts`, keyed by `AccountId`), so `max_position` and `max_open_orders` apply per account (19.2, 19.3). `rateWindow` stays keyed by connection id, so two tabs on one wallet each get their own rate (19.5). The limits are the same for every account.

Rules run in this order, and the first failure wins:

1. `kill_switch`
2. `rate_limit` (default 10 orders per rolling second per client)
3. `max_open_orders` (default 50)
4. `price_band` (limit/stop price within ±10 % of last trade)
5. `max_order_value` (default $250,000 notional; market orders priced at best opposite, falling back to last)
6. `max_position` (per symbol, default 5 BTC, 100 ETH, 2,000 SOL in lots)

All money math uses `bigint`. If there's no reference price (no trade yet), market orders are rejected with `price_band`.

#### Router (Req 18, 22)

- The only module holding a reference to `supervisor.send` for `PlaceOrder`, `Cancel`, `CancelAll`, `ResetAccount`. This is enforced by module structure, and a test checks no other module imports the sender.
- **Account derivation (Req 18.5, 18.6).** `submit(order, origin)` takes `origin = { connectionId, session, source }`, where `session` is the gateway's Connection_Session object for that connection. The Router reads `accountId` from `origin.session` and stamps it on every Command it sends. Client_Message schemas have no account field. Zod's `z.object` strips unknown keys (the schemas from Task 3.2 are not `.strict()`), so a client-supplied `account_id` is dropped at the boundary and never reaches the Router. The Router's types don't accept an account from the message either. P35 generates messages with extra `account_id`/`accountId` fields and checks that every sent Command carries the session's account.
- Before risk, the Router checks `session.exp`: an expired wallet session rejects the order with `session_expired` (46.5).
- `submit(order, origin)` where `source ∈ {web, tui, mcp, llm}` with a client id. It generates `order_id = "o_" + base36(counter) + "_" + random`. Then it runs risk, enqueues the journal record with a synchronous in-memory `journal.enqueue(record)`, and sends to the engine. It never awaits a database write, so orders keep working while the journal is down or Neon is waking (20.8, 20.9). While the engine is down it rejects with `engine_unavailable` (15.5).
- `confirm(previewId, clientId)` only accepts a preview created for the same client and not expired (22.4).
- `flattenAll` creates one market order per non-flat position of the requester's account and submits each through `submit`, so each passes risk.
- Cancel, cancel-all, and reset go through the router but not the risk limits, since they reduce exposure. Each carries the requester's `account_id`, so a guest can't cancel or reset a wallet account, and one wallet can't touch another (14.6, 14.7). `ResetAccount` from a guest connection resets the shared guest account, as before the scope change.

#### Journal (Req 20)

The journal is a Postgres database on Neon's Free plan, reached through Prisma ORM 7. The decisions below are marked so the user can revisit each one.

**Sources for the Prisma decisions:** [Neon: Connect from Prisma to Neon](https://neon.com/docs/guides/prisma) (Prisma ORM 7 with `prisma`, `@prisma/client`, and `@prisma/adapter-neon` on the same major version), [Neon: Schema migration with Prisma ORM](https://neon.com/docs/guides/prisma-migrations) (Prisma Migrate needs a direct, non-pooled connection), and [Bun: Use Prisma with Bun](https://bun.com/docs/guides/ecosystem/prisma). Prisma 7 requires a driver adapter, an explicit generator `output` path, and ESM, and reads the datasource URL from `prisma.config.ts`. The npm `latest` tag of `prisma` currently points at a Prisma 8 prerelease, so an unpinned install would pull a mismatched CLI. These facts were verified by the user; content was rephrased for compliance with licensing restrictions.

**Neon Free plan facts this design relies on** (from [neon.com/pricing](https://neon.com/pricing), as verified by the user on 2026-11-04): $0 with no card, 1 GB storage and 100 CU-hours per project per month, 5 GB egress, compute scales to zero after 5 minutes idle (this can't be disabled), the first query after idle wakes the compute in a few hundred ms, projects are not paused for inactivity, and up to 10 branches per project.

**Decision J1: ORM is Prisma ORM 7.** It replaces the earlier raw SQL driver design.

- **Packages:** `prisma` (CLI), `@prisma/client`, `@prisma/adapter-neon`, and `@prisma/adapter-pg`, all in `server/package.json` `dependencies` and all exact-pinned (`bun add --exact`) to the **same** 7.x version. Task 11.4 picks the newest 7.x release from npm by explicit version, never through the `latest` tag. `prisma` is a runtime dependency, not a dev dependency, because the Start_Script runs `prisma migrate deploy` inside the production image (Decision J5).
- **Schema:** `server/prisma/schema.prisma`. **CLI config:** `server/prisma.config.ts`.
- **Generator:** `provider = "prisma-client"` with `output = "../src/generated/prisma"`. The server imports `PrismaClient` from `./generated/prisma/client` (exact entry file verified in Task 11.4). The package is ESM (`"type": "module"` is already set in `server/package.json`).
- **Generated client is gitignored** (`server/src/generated/` in `.gitignore`) and never hand-edited. Server `package.json` gets `"db:generate": "prisma generate"`. Root `package.json` gets `"db:generate": "bun run --cwd server db:generate"`, and `check:ts` becomes `bun run db:generate && bun run typecheck && bun test`. `prisma generate` reads only the schema, so `bun run check` still needs no database on Windows or macOS.
- `server/tsconfig.json` adds `prisma.config.ts` to `include` so the config file is type-checked.

```prisma
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

datasource db {
  provider = "postgresql"   // URL comes from prisma.config.ts, not from the schema
}
```

```ts
// server/prisma.config.ts — used only by the Prisma CLI
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    // Direct (non-pooled) Neon URL; Prisma Migrate only (20.16).
    // Read without throwing, so `prisma generate` works with DIRECT_URL unset.
    url: process.env.DIRECT_URL ?? "",
  },
});
```

**Decision J2: Two connection strings, both secret.**

| Var | Neon endpoint | Used by | Why |
|---|---|---|---|
| `DATABASE_URL` | pooled (`…-pooler…`) | Prisma Client at runtime, through the driver adapter | many short queries; Neon's pooler multiplexes them |
| `DIRECT_URL` | direct | Prisma Migrate only (`prisma.config.ts`, `prisma migrate deploy` in the Start_Script, `prisma migrate dev` on a developer machine) | Neon's migrations guide says Prisma Migrate needs a direct connection. The pooler runs PgBouncer in transaction mode, which breaks Migrate's session-level advisory lock |

Both URLs are secrets in full: never logged, never returned in a response, never written to a file other than the gitignored `.env`, never committed. Both are required in production (16.5). In `render.yaml`, both are declared with `sync: false` (38.4). This replaces `JOURNAL_PATH`.

**Decision J3: Driver adapter chosen by a factory.** `@prisma/adapter-neon` talks to Neon's serverless driver, which reaches Neon's proxy and does not work against a plain Postgres server such as the CI `postgres:17` container or a local Docker Postgres. `journal/adapter.ts` exports a pure `pickAdapter(databaseUrl, dbAdapter)`:

- `DB_ADAPTER=pg` → `"pg"`.
- Otherwise, the `DATABASE_URL` hostname ends with `.neon.tech` → `"neon"`.
- Otherwise → `"pg"`.

`createPrismaJournalStore(config)` builds the adapter from that choice and passes it to `new PrismaClient({ adapter, log })`:

```ts
const pool = { connectionString: config.databaseUrl, max: 4, idleTimeoutMillis: 60_000, connectionTimeoutMillis: 5_000 };
const adapter = pickAdapter(config.databaseUrl, config.dbAdapter) === "neon"
  ? new PrismaNeon(pool)     // @prisma/adapter-neon
  : new PrismaPg(pool);      // @prisma/adapter-pg
const prisma = new PrismaClient({
  adapter,
  log: [{ emit: "event", level: "warn" }, { emit: "event", level: "error" }],  // handlers redact, then log
});
```

- A small pool (`max: 4`) is enough, because Neon's pooler multiplexes server-side.
- `idleTimeoutMillis: 60_000` closes idle connections so nothing holds Neon's compute awake.
- `query`-level logging is never enabled.
- The pool option names, whether each adapter accepts a config object or a `pg`/Neon `Pool`, and whether Bun's global `WebSocket` needs to be passed to the Neon driver are checked against the Prisma 7 adapter docs in Task 11.4.

**Decision J4: Journal writes are off the order path.**

```ts
interface JournalQueue {
  enqueue(record: JournalRecord): void;   // sync, O(1), never throws, never awaits
  status(): "up" | "down";                // Journal_Status, read by /health
  stats(): { queued: number; dropped: number; poisoned: number };
  setMigrated(ok: boolean): void;         // called by the Start_Script (Decision J5)
  flush(deadlineMs: number): Promise<void>;
}
```

- `enqueue` stamps the record with `record_id = crypto.randomUUID()`, the current Session_Id, and `ts = Date.now()`, and appends it to an in-memory ring. The Router and the fill handler call it and move on (20.1–20.3, 20.8).
- **Bound:** at most `JOURNAL_QUEUE_MAX = 10_000` records waiting. Enqueueing into a full queue drops the oldest waiting record and increments `dropped`. The server logs the dropped count at most once every 10 s while drops are happening (20.11). The batch in flight (at most 500 records) is held separately, so total memory stays bounded.
- **Journal_Writer:** a single background loop. It waits until the queue is non-empty, takes up to 500 records from the head, and calls `store.insertBatch(batch)`. On success it releases the batch and sets the status to `up`. On a connection error or timeout it keeps the batch, sets the status to `down`, logs the redacted error, and retries after `backoff.next()` (500 ms doubling to 30 s, the same `backoff.ts` as the supervisor) (20.10).
- **Migrations first:** while `setMigrated(true)` has not been called, the writer takes nothing from the queue and the status stays `down` (20.17).
- **Probing while down:** if the status is `down`, migrations are done, and the queue is empty, the writer calls `store.ping()` (`prisma.$queryRaw` tagged template `SELECT 1`) on the same backoff until it succeeds. Probing happens only while `down`, so it doesn't keep Neon awake.
- **Error classification:** a rejected `insertBatch` is classified by `classifyPrismaError(err)`:
  - **Poison** (deterministic data or constraint errors): `PrismaClientKnownRequestError` with code P2000 (value too long), P2002 (unique constraint), P2006 (invalid value), P2007 (data validation), P2011 (null constraint), or P2020 (value out of range), and `PrismaClientValidationError`. The writer retries that batch one record at a time. Each record that still fails with a poison error is dropped with one redacted log line naming its `record_id` and the Prisma code, counted in `poisoned`. The status stays `up`. A bad record can't block the queue.
  - **Unreachable** (everything else, including P1001, P1002, P1008, P1017, P2024, `PrismaClientInitializationError`, and unmapped driver adapter errors): keep the batch, set the status `down`, back off (20.10). Unknown errors count as unreachable, so a record is never dropped by mistake.
  - Task 11.4 checks which codes the Prisma 7 driver adapters actually raise for these Postgres errors and adjusts the poison list. The classifier is a pure function with unit tests.
- **Idempotent retries:** a commit can succeed and still report a network error to the client. Each table has `record_id UUID UNIQUE`, and every insert is `createMany({ data, skipDuplicates: true })`, which Prisma sends as `INSERT … ON CONFLICT DO NOTHING`. A retried batch never duplicates rows. This is what makes P26 hold.
- **Insertion order:** `insertBatch` splits the batch into maximal runs of consecutive records of the same kind (order, fill, rejection) and issues one `createMany` per run, in queue order, inside one batch `prisma.$transaction([...])`. Each `createMany` is a single multi-row `INSERT` whose `seq` defaults are drawn from the shared `journal_seq` sequence in row order, so `seq` follows enqueue order across all three tables (P26). Skipped duplicates may leave gaps in `seq`, which is harmless.
- **Shutdown:** on `SIGTERM` (Render deploys and restarts), the server stops accepting orders and calls `flush(5_000)` before exiting. Records still queued after 5 s are lost, and the count is logged.
- **Order path while down:** orders, fills, and broadcasts keep working. Only `/orders` and `/journal` are affected (20.9, 20.13).

**Decision J5: Schema, migrations, and sessions.** Prisma Migrate owns the Journal schema. Render's free plan has no `preDeployCommand`, so Migrations can't run as a separate deploy step. The Start_Script applies them at container start instead.

The schema in `server/prisma/schema.prisma` (after the generator and datasource blocks in Decision J1):

```prisma
model JournalOrder {
  id         BigInt  @id @default(autoincrement())
  seq        BigInt  @default(dbgenerated("nextval('journal_seq'::regclass)"))
  record_id  String  @unique @db.Uuid
  session_id String
  account_id String            // "guest" or "w_<address>" (20.27)
  ts         BigInt            // server wall-clock epoch ms at enqueue
  order_id   String
  source     String            // web | tui | mcp | llm
  client_id  String
  symbol     String
  side       String            // buy | sell
  kind       String            // market | limit | stop
  qty        BigInt            // Lots
  price      BigInt?           // Ticks: limit or stop price; null for market

  @@index([account_id, session_id, ts, seq])
  @@index([account_id, ts, seq])
  @@map("orders")
}

model JournalFill {
  id         BigInt  @id @default(autoincrement())
  seq        BigInt  @default(dbgenerated("nextval('journal_seq'::regclass)"))
  record_id  String  @unique @db.Uuid
  session_id String
  account_id String
  ts         BigInt            // server wall-clock epoch ms at enqueue
  market_ts  BigInt            // Fill.ts from the engine (market time)
  order_id   String
  symbol     String
  side       String
  price      BigInt            // Ticks
  qty        BigInt            // Lots
  fee        BigInt            // Money
  remaining  BigInt            // Lots

  @@index([account_id, session_id, ts, seq])
  @@index([account_id, ts, seq])
  @@map("fills")
}

model JournalRejection {
  id         BigInt  @id @default(autoincrement())
  seq        BigInt  @default(dbgenerated("nextval('journal_seq'::regclass)"))
  record_id  String  @unique @db.Uuid
  session_id String
  account_id String
  ts         BigInt
  order_id   String
  source     String            // web | tui | mcp | llm | engine
  reason     String
  detail     String?

  @@index([account_id, session_id, ts, seq])
  @@index([account_id, ts, seq])
  @@map("rejections")
}
```

- **Naming:** models are PascalCase in TypeScript and map to the snake_case tables `orders`, `fills`, and `rejections` with `@@map`. Field names are already snake_case, so they need no `@map`.
- **`id` and `seq`:** `id` is each table's own autoincrement primary key. Per-table sequences can't break ties between rows of different tables, such as an order and its fill with the same `ts`. `seq` draws from one sequence, `journal_seq`, shared by all three tables, and is the tiebreak for insertion order (20.7). Prisma's schema language can't declare a standalone sequence, so the first Migration creates it.
- **Why `::regclass`:** Postgres stores the default `nextval('journal_seq')` as `nextval('journal_seq'::regclass)`. Prisma compares the `dbgenerated` text in the schema with the default it reads back from the database, so writing the stored form avoids false drift reports. Task 11.4 confirms with `prisma migrate diff` that the schema and the Migrations agree.
- **Migrations:** each Migration is a directory `server/prisma/migrations/<timestamp>_<name>/` with a committed `migration.sql`, plus one `migration_lock.toml` in `migrations/`. The first is `<timestamp>_init`. Its `migration.sql` starts with `CREATE SEQUENCE journal_seq;`, before the `CREATE TABLE` statements that reference it. It is generated with `prisma migrate dev --create-only --name init` against a development database and then edited, or written by hand. Prisma Migrate records applied Migrations in its own `_prisma_migrations` table.
- **Concurrent starts:** `prisma migrate deploy` takes Prisma Migrate's own Postgres advisory lock for the duration of the run, so two containers that start at the same time (for example, during a Render deploy overlap) apply each Migration once. The lock is session-level, which is why Migrate connects over `DIRECT_URL` and never through the PgBouncer pooler (Decision J2).
- **Start_Script (`server/scripts/start.ts`, using `journal/deploy.ts`):**
  1. Validate the configuration with the Zod env schema. A failure logs the variable names and exits with code 1 (16.2, 16.5).
  2. Run `prisma migrate deploy` with `Bun.spawn`. `prisma.config.ts` reads `DIRECT_URL` from the environment, so `DIRECT_URL` is the Migrate connection string (20.16). Every stdout and stderr line passes through `redactSecrets()` before it is logged (16.4).
  3. Exit code 0: call `setMigrated(true)` and start the server in the same process (20.15).
  4. Non-zero exit or spawn failure: log the redacted error, start the server anyway with Journal_Status `down`, and retry the deploy in the background on `backoff.ts` delays (500 ms doubling to 30 s). The writer holds records in the queue until a retry succeeds and calls `setMigrated(true)` (20.17). `/health` still answers 200, so Render doesn't kill the instance while Neon is waking or unreachable.
  5. When `DATABASE_URL` is unset outside production, there is nothing to migrate. The Start_Script skips the deploy and the server uses `MemoryJournalStore` (16.6).
- **Column rules (20.22):** Price, Qty, Money, `ts`, and `market_ts` are Prisma `BigInt`, stored as Postgres `BIGINT` and returned by Prisma Client as JavaScript `bigint`. JSON responses encode them as decimal strings, as the protocol does. `ts` is epoch ms.
- **Why `ts` is wall-clock:** fill events carry market time, which in replay mode comes from the fixture and shifts on each loop. Ordering the journal by a mix of market time and wall-clock time would interleave records wrongly. Every row's `ts` is the server's `Date.now()` at enqueue, and fills keep the engine time in `market_ts`.
- **Accounts (20.27, 20.30):** every record carries the `account_id` of the order's origin, stamped by the Router (orders, risk rejections) or taken from the engine event (fills, engine rejections). The `account_id` column is part of the first Migration (`init`), because Task 11.4 has not been built yet, so no extra Migration is needed.
- **`/orders` and `/journal` order (20.7, 20.24):** each table is read with Prisma Client `findMany` filtered by `account_id` and by `session_id` (unless `session=all`), ordered by `ts` desc then `seq` desc, with `take: limit`. The pure `mergeJournal()` merges the per-table results, keeps the most recent `limit` records, and returns them sorted ascending by `(ts, seq)`.
- **Sessions (20.18):** the paper account still resets on each engine restart, and nothing is restored from the journal (15.7, 15.8). The journal outlives Render restarts, so every row carries `session_id`, the Session_Id generated at each engine start. Records enqueued while the engine is down after an exit keep the previous Session_Id until the next start. Records already in the queue keep the Session_Id they were stamped with. The `session` query parameter is described under Endpoints.

**Decision J6: Testing without a database.** `JournalStore` is an interface with two implementations. It has no `migrate()`: Prisma Migrate applies the schema in the Start_Script (Decision J5), not the store.

```ts
interface JournalStore {
  insertBatch(records: readonly JournalRecord[]): Promise<void>;   // idempotent on record_id
  listOrders(q: { account: AccountId; session: string | "all"; limit: number }): Promise<OrderRow[]>;
  listJournal(q: { account: AccountId; session: string | "all"; limit: number }): Promise<JournalRow[]>;
  // both return the most recent `limit` rows of that account, sorted ascending by (ts, seq)
  ping(): Promise<void>;
  close(): Promise<void>;
}
```

- `PrismaJournalStore` (`prisma.ts`, built by `createPrismaJournalStore()` in Decision J3) uses only the Prisma Client API and `$queryRaw`/`$executeRaw` tagged templates, never `$queryRawUnsafe` or `$executeRawUnsafe`.
  - `insertBatch` issues one `createMany({ data, skipDuplicates: true })` per run of same-kind records, in queue order, inside one batch `prisma.$transaction([...])` (Decision J4). If any statement fails, Postgres rolls back the whole batch, so a retry starts from a clean state, and `skipDuplicates` covers a batch that committed but reported an error.
  - When the batch fails and `classifyPrismaError(err)` returns `poison`, the writer retries the batch row by row (one `createMany` with one record each). Each record that still fails with a poison error, a known Prisma data or constraint error, is dropped with one redacted log line that names its `record_id` and the Prisma code. Any `unreachable` result during the row-by-row retry stops it, keeps the remaining records, and sets the status `down`.
  - `ping()` is `prisma.$queryRaw` tagged template `SELECT 1`. `close()` calls `prisma.$disconnect()`.
- `MemoryJournalStore` (`memory.ts`) keeps arrays, assigns `seq` from one counter, ignores duplicate `record_id`s, and accepts a fault-injection hook (fail the next n calls, or commit and then throw). Unit tests, router tests, and P26 use it, so `bun run check` passes on Windows and macOS with no database (41.7). It is also the store when `DATABASE_URL` is unset outside production (16.6).
- The same contract property (P27) runs against both stores, the Prisma one through `@prisma/adapter-pg`, so the fake can't drift from Postgres.

**Decision J7: Deploy.** In `render.yaml`, `haunted-terminal-server` drops `JOURNAL_PATH` and declares both `DATABASE_URL` and `DIRECT_URL` with `sync: false` (38.4). `DB_ADAPTER` is left unset, so `pickAdapter` chooses the Neon adapter from the host. There is no `preDeployCommand`, because the Start_Script runs the Migrations. The `buildFilter` includes `server/prisma/**`, so a schema or Migration change triggers a deploy. The user creates a Neon project, copies the **pooled** connection string as `DATABASE_URL` and the **direct** connection string as `DIRECT_URL`, and pastes both into the Render dashboard. Neither URL is ever committed. Both are required in production: the image sets `NODE_ENV=production`, so the Start_Script exits with code 1 if either is unset (16.5).

**Endpoints:**

| Endpoint | Behaviour |
|---|---|
| `GET /health` | `200 { engine: "running" \| "stopped", db: "up" \| "down" }`. `db` is the in-memory Journal_Status. This endpoint never queries the database (17.5, 17.8). Render polls `/health`, and a query there would keep Neon's compute awake around the clock and use the 100 CU-hour allowance. |
| Caller account for `GET /positions`, `/orders`, `/journal` | `auth/bearer.ts`: no `Authorization` header → `guest`. `Authorization: Bearer <Session_Token>` that the Auth_Service accepts → `w_<address>`. A header that is present but malformed, or a token that is invalid, expired, or denylisted → `401 { error: "invalid_token" }`, checked before the query parameters (20.28, 20.29). Falling back to guest on a bad token was rejected because it would show the guest account to a caller who asked for their own. `/positions` returns that account's positions from `state/account.ts` (20.6). `/orders` and `/journal` return only that account's records (20.30). `/quote` and `/candles` are market data and take no account. |
| `GET /orders`, `GET /journal` query parameters | Validated with Zod before anything else, so a bad parameter returns 400 even while the status is `down`. `session`: `z.enum(["all"]).optional()`. Omitted: records of the current Session_Id only (20.19). `all`: records of every Session_Id (20.20). Any other value: `400` with the Zod error message (20.21). `limit`: optional string of decimal digits, converted to an integer and checked to be from 1 to 5000 inclusive. Omitted: 500 (20.25). Any other value, such as `0`, `5001`, `1.5`, `1e3`, `-1`, `abc`, or an empty string: `400` with the Zod error message (20.26). |
| `GET /orders`, `GET /journal` results | While the status is `down`: `503 { error: "journal_unavailable" }` immediately (20.13). Otherwise run the query through `PrismaJournalStore` (or `MemoryJournalStore`) with a 5 s limit. A connection error or timeout returns 503 and sets the status to `down` (20.14). On success: `200` with a JSON array of the most recent `limit` records, sorted ascending by `(ts, seq)` (20.7, 20.24, 20.25). `/journal` merges orders, fills, and rejections, each tagged with its kind, and `limit` applies to the merged list. BigInt fields are decimal strings. Responses reflect what has been written: records still in the Journal_Queue are not included, so a fill can appear a moment after its `Fill` event. |

**Free-plan budget:** compute runs only while the server queries. With no `/health` queries, no keep-alive, and a 60 s client idle timeout, Neon scales to zero 5 minutes after the last journal write. Assuming a 0.25 CU compute (not verified here; check the Neon project's compute size), 100 CU-hours covers about 400 active hours a month. A journal row is a few hundred bytes, so 1 GB holds millions of rows. No retention job is planned.

#### LLM_Order_Parser (Req 23)

- `LLM_Provider.interpret(text, context) → Promise<unknown>`. The OpenAI implementation uses structured output with a JSON schema. An `AbortSignal.timeout(15_000)` enforces the time limit (23.5).
- **Output schema (Zod):**
  - `action`: `place` | `cancel_all` | `flatten` | `unclear`
  - `side`, `symbol`
  - `amount`: `{absolute: decimal-string}` | `{percent_of_position: number}`
  - `order_type`: `market` | `limit` | `stop`
  - `price`: `{absolute: decimal-string}` | `{relative_to_last_pct: number}`
- The validated intent is turned into command text with the Command_Formatter and then parsed by the Command_Parser. The LLM path therefore yields the exact same `Order_Preview` as typing (23.3). `unclear` or a failed validation is an error with no preview (23.4).
- Without `OPENAI_API_KEY`, `?` input returns `Notice llm_disabled` (23.7).

#### MCP server (Req 24)

A separate stdio process, `bun run server/src/mcp/main.ts`, built with `@modelcontextprotocol/sdk`. It acts as a client of the running server (`TERMINAL_URL`, default `http://localhost:8080`):

| Tool | Implementation |
|---|---|
| `get_quote(symbol)` | `GET /quote/:symbol` → best bid, best ask, last |
| `get_candles(symbol, timeframe, limit?)` | `GET /candles/:symbol?timeframe=` |
| `get_positions()` | `GET /positions` |
| `preview_order(command)` | WS `CommandText` → returns preview, does not confirm |
| `place_paper_order(command)` | WS `CommandText` then `Confirm` → result (fill, ack, or rejection reason) |

Because orders go over the same WebSocket protocol, they pass through the Router and Risk_Engine like any client (24.6). Tool arguments are validated with Zod (24.7). The tool is registered in `.kiro/settings/mcp.json` (24.8).

**Account (24.9–24.11):** with `TERMINAL_TOKEN` unset, the MCP process trades on the guest account. With `TERMINAL_TOKEN` set to a Session_Token (for example, the token from the TUI's Token_Store after pairing), the process sends `Authenticate { token }` after each WebSocket connect and `Authorization: Bearer` on each REST call. `TERMINAL_TOKEN` is a secret: it is read only from the environment, never logged, and never echoed in a tool result. The committed `.kiro/settings/mcp.json` never contains a token value. Task 14.3 checks whether Kiro's `mcp.json` `env` block can reference a variable from the user's environment; if not, the README tells users to set `TERMINAL_TOKEN` in the environment Kiro starts from. If the server answers `Notice auth_failed` or 401, tools return an error that says the token was rejected, without the token.

#### Auth_Service (Req 45, 46, 48, 49)

All auth state lives in server memory except the Session_Token itself, which is stateless. Every store is a pure class with an injectable clock (`now: () => number`), so the property tests drive time directly.

```mermaid
sequenceDiagram
  participant W as Wallet (Phantom / Backpack)
  participant UI as Web_UI
  participant A as Auth_Service
  participant GW as Gateway
  UI->>A: POST /auth/nonce {address}  (Origin checked)
  A-->>UI: {nonce, fields: domain, address, statement, uri, version, chainId, issuedAt, expirationTime}
  alt wallet has solana:signIn
    UI->>W: signIn(fields)
    W-->>UI: {account, signedMessage, signature}
  else signMessage fallback
    UI->>UI: message = SIWS_Formatter(fields)  (shared TS formatter)
    UI->>W: signMessage(message bytes)
    W-->>UI: {signedMessage, signature}
  end
  UI->>A: POST /auth/verify {message (base64), signature (base64)}
  A->>A: parse, check fields, consume nonce, Ed25519 verify
  A-->>UI: {token, account_id, address, exp}
  UI->>GW: authenticate(token)
  GW-->>UI: session(w_<address>)
```

**Endpoints.** All are `POST` with JSON bodies validated by Zod. All are CORS-enabled for `ALLOWED_ORIGINS` only (Hono `cors` with an origin allowlist, credentials off, `Authorization` allowed). `/auth/nonce` and `/auth/verify` also require an `Origin` header in `ALLOWED_ORIGINS` and answer 403 otherwise (45.2), because the SIWS domain is bound to it.

| Endpoint | Body | Success | Errors |
|---|---|---|---|
| `/auth/nonce` | `{ address }` | `200 { nonce, fields }` | 400 bad address (45.3), 403 origin, 429 |
| `/auth/verify` | `{ message, signature }` (base64) | `200 { token, account_id, address, exp }` | 400 malformed, 401 any check failed (45.5), 403 origin, 429 |
| `/auth/logout` | none; `Authorization: Bearer` | `204` | 401 bad token, 429 |
| `/auth/pair` | `{ verifier }` (base64url SHA-256 of the Pairing_Secret) | `200 { code, pair_url, expires_in: 300, interval: 2 }` | 400, 429 |
| `/auth/pair/confirm` | `{ code }`; `Authorization: Bearer` (web session) | `204` | 401 bad token, 404 unknown/expired/used code, 429 |
| `/auth/pair/poll` | `{ code, secret }` | `200 { status: "pending" }` or `200 { status: "ok", token, account_id, address, exp }` | 404 unknown/expired/used code or wrong secret (48.8), 429 |

**SIWS message (Req 45.1, 45.8–45.10).** The fields and line format follow the Sign In With Solana specification:

```
<domain> wants you to sign in with your Solana account:
<address>

Sign in to Haunted Terminal paper trading. This signature does not authorize any transaction.

URI: <origin>
Version: 1
Chain ID: solana:mainnet
Nonce: <nonce>
Issued At: <ISO 8601 UTC>
Expiration Time: <ISO 8601 UTC, issuedAt + 5 min>
```

- `siws.ts` exports `parseSiws(text) → Result<SiwsFields, SiwsError>` and `formatSiws(fields) → string`. The parser accepts the optional SIWS fields (`Not Before`, `Request ID`, `Resources`) so a wallet that adds them still parses, but the checks below require our nine fields. `formatSiws` is also used by the web UI for the `signMessage` fallback, so it lives in a dependency-free module the web can import (`shared/siws.ts`, re-exported by `server/src/auth/siws.ts`).
- Nonce: 16 random bytes, base58 (22 characters), alphanumeric as SIWS requires.
- `checkSiws(fields, ctx)` is pure and returns the first failing check: domain equals the request origin's host; URI equals the request origin; address is base58 of 32 bytes; nonce is known, unused, unexpired, and was issued for this address and origin; chain ID is `solana:mainnet`; version is `1`; statement equals the Sign_In_Statement; `Expiration Time` > now; `Issued At` ≤ now + 60 s of clock skew (45.5). P31 mutates each field.
- The nonce is consumed before the signature check, whatever the outcome (45.6), so a captured signed message can't be replayed and a failed attempt can't be retried with the same nonce.
- The chain ID is an identity claim only. The server never contacts a Solana RPC endpoint (49.3).

**Decision A11: Ed25519 through WebCrypto, base58 through `@scure/base`.** `ed25519.ts` exports `verifyEd25519(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean>`, implemented with `crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"])` and `crypto.subtle.verify("Ed25519", key, signature, message)`. Bun implements WebCrypto Ed25519, so no crypto dependency is needed. Task 18.2 proves it on Bun 1.4.4 with the RFC 8032 test vectors (TEST 1–3) in a unit test. If Bun's WebCrypto rejects Ed25519 there, the fallback is `@noble/curves` (`ed25519.verify`, audited, pure TypeScript), exact-pinned, behind the same function signature. base58 decoding uses `@scure/base` (`base58.decode`), audited by the same author, exact-pinned. Signature length must be 64 and public key length 32 before calling verify.

**Decision A12: Session_Token format and `SESSION_SECRET`.**

- Format: `v1.<payload>.<mac>`, where `payload = base64url(JSON {sub: address, iat, exp, jti})` and `mac = base64url(HMAC-SHA256(SESSION_SECRET, "v1." + payload))`. `exp = iat + 24 h` (epoch seconds), `jti = crypto.randomUUID()`. The Account_Id is derived from `sub` as `w_<sub>`, never read from the payload separately.
- Verify: split into exactly three parts, check the prefix, recompute the MAC with `crypto.subtle.verify("HMAC", …)` (constant time), only then parse the payload with Zod, check `sub` is base58 of 32 bytes, `exp > now`, and `jti` not in the Token_Denylist (45.13). Any failure returns the same `invalid_token` result.
- Stateless: tokens survive server restarts as long as `SESSION_SECRET` is unchanged. Rotating the secret signs everyone out.
- **Token_Denylist (45.14):** `Map<jti, exp>`, pruned of expired entries on each insert and every 10 minutes. It is in memory only, so a server restart forgets it and a signed-out token is valid again until its 24 h expiry. This is accepted: logout is best effort, and the README says so.
- **Render:** `SESSION_SECRET` is declared with `generateValue: true` (38.5). Render generates a random base64 value (256 bits) once when the Blueprint is created and keeps it across deploys, so operators and judges deploying the Blueprint have nothing to paste, and the value never enters the Repository. `sync: false` was the alternative, but it adds a manual step with no security gain.

**Rate limits (45.15, 48.9).** `ratelimit.ts` is a fixed-window counter keyed by `(route, ip)`, pruned every minute.

| Route | Limit |
|---|---|
| `/auth/nonce`, `/auth/verify`, `/auth/logout` | 10 per minute per IP |
| `/auth/pair` | 5 per minute per IP |
| `/auth/pair/confirm` | 10 per minute per IP |
| `/auth/pair/poll` | 1 per 2 s per Pairing_Code, and 60 per minute per IP |

Client IP (`clientip.ts`): with `NODE_ENV=production`, the rightmost entry of `X-Forwarded-For`, which Render's proxy appends (an entry further left can be forged by the client). Otherwise `server.requestIP(req)`. Task 18.6 confirms Render's header behaviour; if it differs, the function changes, not the limits.

**Pairing (Req 48, Decision A4).**

```mermaid
sequenceDiagram
  participant T as TUI
  participant A as Auth_Service
  participant UI as Web_UI (/pair page)
  T->>T: secret = 32 random bytes
  T->>A: POST /auth/pair {verifier: b64url(sha256(secret))}
  A-->>T: {code: "K7QM-4XZP", pair_url, expires_in: 300, interval: 2}
  T->>T: show code + URL
  UI->>UI: user opens pair_url, signs in with wallet if needed
  UI->>A: POST /auth/pair/confirm {code} + Bearer (web token)
  loop every 2 s until ok / 404 / expiry
    T->>A: POST /auth/pair/poll {code, secret}
    A-->>T: pending | ok {token}
  end
  T->>T: write Token_Store, send authenticate(token)
```

- Pairing_Code: 8 characters drawn uniformly (rejection sampling on `crypto.getRandomValues`) from the 31-character alphabet `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, about 39.6 bits. Displayed as `XXXX-XXXX`; input is upper-cased and the hyphen removed before lookup. With a 5-minute life and the rate limits above, guessing a live code is impractical, and a guessed code alone yields nothing without the secret.
- **Decision A13: Polling with a secret, not WebSocket delivery.** The TUI polls `/auth/pair/poll` with the code and its Pairing_Secret. The server stores only the SHA-256 verifier and compares hashes in constant time. Someone who sees the code (shoulder-surfing, a screen share) can confirm it in their own browser at worst, which would pair the TUI to the attacker's wallet, not leak the victim's token; the /pair page warns "Only confirm a code shown in your own terminal". WebSocket delivery was rejected because it ties the pairing to one live connection, which breaks when the free Render instance restarts or the TUI reconnects mid-pairing, and it adds a message type for a one-time flow.
- The token issued on poll is a fresh Session_Token for the confirmed address with its own jti, so signing out of the web UI doesn't sign out the TUI, and vice versa.
- Pairings are deleted on successful poll, on expiry (swept every 30 s), and when the 1,000-entry pairing table is full (oldest first), which bounds memory.

### 4. Shared keymap (`shared/keymap.json`, Req 32)

```json
{
  "version": 1,
  "contexts": {
    "global":  { "1": "timeframe.1m", "2": "timeframe.5m", "3": "timeframe.15m", "4": "timeframe.1h", "5": "timeframe.1d",
                 "Tab": "symbol.next", "Shift+Tab": "symbol.prev",
                 "B": "order.buy", "S": "order.sell", "F": "account.flatten", "X": "orders.cancel_all",
                 "E": "indicator.ema", "W": "indicator.vwap", "O": "indicator.bollinger", "R": "indicator.rsi", "T": "indicator.atr",
                 ":": "command.focus", "P": "auth.pair", "Q": "app.quit" },
    "chart":   { "+": "chart.zoom_in", "-": "chart.zoom_out", "Left": "chart.pan_back", "Right": "chart.pan_forward" },
    "book":    { "Up": "book.up", "Down": "book.down", "Enter": "book.prefill" },
    "orders":  { "Up": "orders.up", "Down": "orders.down", "Delete": "order.cancel" },
    "command": { "Up": "history.prev", "Down": "history.next", "Enter": "command.submit", "Escape": "command.blur" },
    "dialog":  { "Enter": "dialog.confirm", "Y": "dialog.confirm", "Escape": "dialog.cancel", "N": "dialog.cancel" }
  }
}
```

- **Lookup order:** the focused context first (`dialog` > `command` > `chart`/`book`/`orders`), then `global`. While the command bar has focus, letter keys type text, and only `command` bindings apply.
- **Validation:** single letters are case-insensitive. Both loaders (TS and Rust) reject a context that binds the same normalized key twice (32.4). `app.quit` and `auth.pair` are TUI-only, and the web loader ignores them. (The web UI signs in with buttons, Req 47.)

### 5. Web UI (`web/`)

- **Build:** Next.js 16 App Router, `output: 'export'`, TypeScript, Tailwind, zustand. The page is a single client component tree, with no server-side data fetching (Req 37).
- **`lib/socket.ts`:** `useTerminalSocket(url)` manages the WebSocket. It reconnects with backoff (250 ms doubling, capped at 10 s) and shows "waking server" while disconnected. On reconnect it resubscribes to the selected symbol and timeframe (Req 33).
- **`lib/store.ts`:** zustand store with slices for connection, instruments, selection (symbol, timeframe), candles, indicators, book, tape, positions, orders, preview, notices, and command history. Reducers are pure functions (`applyServerMessage(state, msg)`), so they are tested without React.
- **Components:**
  - `Watchlist`, `ChartPanel` (Lightweight Charts with candles, volume, and overlay line series), `IndicatorPane` (RSI/ATR)
  - `OrderBook` (depth bars, click to prefill), `TradesTape`, `Positions`, `OpenOrders` (✕ cancel), `PnL`
  - `CommandBar` (history), `PreviewDialog`, `ConfirmDialog`, `StatusBar` (connection state, `REPLAY` or `LIVE · <venue>` from `Hello`, Req 44.7)
  - `WalletMenu` (sign-in buttons, shortened address, sign out, `GUEST` label), and the `/pair` page
- **Wallet sign-in (Req 47, 49).**
  - **Decision A14: `@wallet-standard/app` instead of `@solana/wallet-adapter-react`.** The web UI uses `getWallets()` from `@wallet-standard/app`, with feature-name constants from `@solana/wallet-standard-features` and `@wallet-standard/features`. Reasons: the app never sends a transaction, so it needs no `@solana/web3.js` connection, no `ConnectionProvider`, and no adapter modal, which `@solana/wallet-adapter-react` brings along with a much larger bundle; Phantom and Backpack both register through Wallet Standard, so auto-detection works without per-wallet adapters; and with the lighter library the transaction features are never imported, which makes Req 49.2 easy to check with a grep test. The cost is a small hand-written button list instead of a ready-made modal. All three packages are exact-pinned (`bun add --exact`) in `web/package.json`; Task 20.1 picks the newest release of each from npm by explicit version (not verified here).
  - `lib/wallets.ts`: `getWallets().get()` plus the `register`/`unregister` events, filtered to wallets named Phantom or Backpack that have `standard:connect` and either `solana:signIn` or `solana:signMessage` (47.1). Other Wallet Standard wallets are not shown in this version.
  - `lib/auth.ts`: `signIn(wallet)` runs connect → `/auth/nonce` → `solana:signIn` (or `formatSiws` + `solana:signMessage`) → `/auth/verify` (47.2). It only ever calls `standard:connect`, `standard:disconnect`, `solana:signIn`, and `solana:signMessage` (47.3, 49.2). A test fails the build if any file under `web/` mentions `signTransaction`, `signAndSendTransaction`, or `signAndSendAllTransactions`.
  - Token storage: `localStorage["ht.session"] = { token, address, exp }`, so a reload stays signed in for up to 24 h (47.6). This is a paper-trading token with no access to funds, and the static site loads no third-party scripts, so `localStorage` is accepted; `sessionStorage` would sign users out on every new tab. An expired entry is deleted on load.
  - `useTerminalSocket` sends `Authenticate` right after `Hello` on every (re)connect when a token is stored (33.4), and the store applies `Session` and the `auth_failed`/`session_expired`/`signed_out` notices (deleting the stored token on any of them).
  - Signed in, `WalletMenu` shows `AbCd…WxYz` and "Sign out" (47.4). Sign out calls `/auth/logout`, deletes the token, calls `standard:disconnect` if present, and the server moves the connection to guest (47.5, 46.6). With no supported wallet, it shows "No Phantom or Backpack wallet found. Trading as guest." (47.7). The account panels show a `GUEST` label while the session is guest (47.8).
- **`/pair` page (Req 48.4, 48.5).** `app/pair/page.tsx`, a client component that reads `code` with `useSearchParams` inside `Suspense` (required for a static export). It shows the code in large type, the warning "Only confirm a code shown in your own terminal", the sign-in buttons if needed, and a Confirm button that calls `/auth/pair/confirm`. Nothing is sent until Confirm is clicked.
- **Charts:** loaded with `next/dynamic(() => import(...), { ssr: false })` (25.5). Zoom and pan use Lightweight Charts' built-in wheel and drag handling. `+`, `−`, `←`, `→` call `timeScale()` methods.
- **Keyboard:** one `keydown` listener resolves keys through the keymap and the focus context.

### 6. TUI (`rust/crates/tui`)

```
tui/src/
├─ main.rs          clap (--server, --version, --guest, --logout); terminal guard; panic hook
├─ net.rs           tokio-tungstenite client task ↔ mpsc channels; reconnect with backoff ≤ 10 s; Authenticate after connect
├─ auth.rs          Token_Store (load/save/delete), pairing client (POST /auth/pair, poll), logout
├─ app.rs           App state (mirrors the web store) + update(ServerMessage) + handle(Action)
├─ keymap.rs        include_str!("../../../../shared/keymap.json") + validation
├─ hitmap.rs        HitMap
├─ ui/              layout + panels
└─ widgets/
   ├─ candle_chart.rs   CandleChart_Widget
   └─ depth_bar.rs
```

- **Terminal guard:** enables raw mode, the alternate screen, and mouse capture. `Drop` restores all three. A panic hook restores the terminal before the default hook prints the message (36.3, 36.4).
- **Event loop:** `tokio::select!` over crossterm `EventStream`, network messages, and a 33 ms tick. A frame is drawn on a tick only if state is dirty, so there are at most 30 redraws per second (34.3).
- **CandleChart_Widget:**
  - Each candle occupies one column. Rows map prices linearly over the visible high/low range.
  - The body uses full and half blocks (`█ ▀ ▄`) for half-row resolution. The wick uses `│ ╽ ╿`.
  - Bullish candles are green, bearish red. Volume uses `▁▂▃▄▅▆▇█` in the bottom rows. A price axis is drawn on the right.
  - Overlays (EMA, VWAP, Bollinger) use a braille `Canvas` layer drawn over the same price scale (34.1, 34.2).
  - The visible window `(offset, width)` supports zoom and pan.
- **HitMap:** a `Vec<(Rect, HitTarget)>` rebuilt every frame during draw. `resolve(x, y)` returns the last-registered rectangle containing the point, so children win over parents. Each target is a panel plus an optional item (book level i, order id, watchlist symbol, timeframe button) (35.1–35.3).
- **Default server URL:** `wss://haunted-terminal-server.onrender.com/ws` (36.1). The REST base URL for pairing and logout is derived from it (`wss://host/ws` → `https://host`).
- **Sign-in by pairing (Req 48, Decision A4, A13).**
  - Token_Store: `dirs::config_dir()/haunted-terminal/session.json` holding `{ server, token, address, exp }` (on Windows `%APPDATA%\haunted-terminal\`, on macOS `~/Library/Application Support/haunted-terminal/`). On macOS (and any Unix) the file is created with mode `0600` through `OpenOptionsExt::mode` and written atomically (temp file + rename). On Windows the file inherits the per-user profile ACL. A token is used only for the server it was issued by.
  - Startup: without `--guest`, an unexpired stored token for this server is sent as `Authenticate` after each connect (48.12). `--guest` skips the token and leaves the file alone (48.13). `--logout` posts the token to `/auth/logout`, deletes the file, and exits 0 without entering the full-screen UI (48.14).
  - Pairing: the `P` key (`auth.pair`) opens a dialog, generates the Pairing_Secret with `getrandom`, posts the verifier, shows `XXXX-XXXX` and the pair URL, and polls every `interval` seconds. `ok` saves the token, sends `Authenticate`, and closes the dialog. 404 or expiry shows "Pairing expired, press P to retry". Esc cancels and forgets the secret.
  - HTTP client: `reqwest` with `default-features = false` and rustls (the `ring` provider, the same as the engine). Task 21.1 confirms the feature names for the pinned reqwest version.
  - The status bar shows `GUEST` or the shortened address next to `REPLAY`/`LIVE · <venue>` (44.7, 47.8).

### 7. Deployment, release, CI

- **`Dockerfile`:**
  - Stage `engine` (`rust:1.94-bookworm`) runs `cargo build --release -p engine`.
  - Stage `runtime` (`oven/bun:1.4.4-debian`) installs production server dependencies, which include the exact-pinned `prisma` CLI (Decision J1). It then copies `server/` (including `server/prisma.config.ts`, `server/prisma/schema.prisma`, `server/prisma/migrations/`, and `server/scripts/start.ts`), `shared/`, `fixtures/`, and the engine binary to `/app/bin/engine`.
  - Runs `bun run db:generate` during the build, before switching to the non-root user, so the generated Prisma Client is in the image. The build also checks that the Prisma CLI's migration engine runs on the Debian runtime image (for example, that OpenSSL is present).
  - Sets `ENV NODE_ENV=production`, so a missing `DATABASE_URL` or `DIRECT_URL` stops the server (16.5).
  - Runs as `USER bun` (39.3).
  - `CMD` runs the Start_Script, `bun server/scripts/start.ts`, which applies pending Migrations with `prisma migrate deploy` over `DIRECT_URL` and then starts the server in the same process (20.15, 20.16, Decision J5).
- **`render.yaml`:** as in the agreed plan (Req 38). The web build installs Bun 1.4.4 and runs `bun run --cwd web build`, which publishes `web/out`. `haunted-terminal-server` has no `JOURNAL_PATH` and declares `DATABASE_URL` and `DIRECT_URL`, both with `sync: false`, so Render prompts for them in the dashboard and the values never enter the Repository (38.4). `DB_ADAPTER` is not declared, so the Neon adapter is chosen from the host. There is no `preDeployCommand`. The `buildFilter` includes `server/prisma/**` (Decision J7). `SESSION_SECRET` is declared with `generateValue: true` (38.5, Decision A12). `LIVE_VENUE` is declared as `backpack` and `DATA_MODE` stays `replay`. `WEB_URL` is set to the static site's URL, which is also in `ALLOWED_ORIGINS`.
- **`ci.yml`:**
  - `check` job: matrix of `windows-latest` and `macos-latest` running `bun run check`. `TEST_DATABASE_URL` is unset there, so the Postgres tests are skipped (41.7).
  - `journal-pg` job on `ubuntu-latest`: a `postgres:17` service container (GitHub service containers only run on Linux runners) with `POSTGRES_PASSWORD=postgres`, a `pg_isready` health check, and port 5432. Steps: `bun install`, `bun run db:generate`, then `bunx prisma migrate deploy` in `server/` with `DIRECT_URL=postgres://postgres:postgres@localhost:5432/postgres`, then the journal contract tests (`bun test server`) with `TEST_DATABASE_URL` set to the same URL and `DB_ADAPTER=pg` (41.5). This throwaway URL is not a secret.
  - `docker-smoke` job on `ubuntu-latest`: the same `postgres:17` service. It builds the image, runs it with `--network host` and the container URL `postgres://postgres:postgres@localhost:5432/postgres` as both `-e DATABASE_URL` and `-e DIRECT_URL`, and runs `server/scripts/smoke.ts`: wait for `/health` to report `db: "up"` (the Start_Script has applied the Migrations), connect, place an order, receive a Fill, then poll `GET /journal` until the order and fill rows appear (41.3, 41.6). The URL is not a Neon host, so `pickAdapter` chooses `@prisma/adapter-pg`.
  - Validates `render.yaml` against Render's JSON schema from SchemaStore.
- **`release.yml`:**
  - Triggered on `v*` tags.
  - Windows MSVC zip and macOS universal tar.gz (built with `lipo`), each containing `tui` and `engine`.
  - Each archive gets a SHA-256 checksum, and each job smoke-tests `tui --version` and an engine ping (Req 40).

## Data Models

| Store | Owner | Contents |
|---|---|---|
| Engine memory | engine | books, candle rings, indicator state, open orders, positions |
| Server cache | server `state/` | last trade, top of book, candle snapshots per (symbol, tf), positions, open orders. Cleared on engine restart |
| Journal | Neon Postgres via Prisma Client and `PrismaJournalStore` (`MemoryJournalStore` in tests and in local runs without `DATABASE_URL`) | Tables `orders`, `fills`, `rejections` (models `JournalOrder`, `JournalFill`, `JournalRejection`), plus Prisma Migrate's own `_prisma_migrations`. Every row has `id` (per-table autoincrement), `seq` (from the shared `journal_seq` sequence), `record_id` (UUID, unique), `session_id`, and `ts`. Price, Qty, Money, and times are Prisma `BigInt` / Postgres `BIGINT`. Schema changes ship as Migrations in `server/prisma/migrations/`. Persists across server and Render restarts |
| Journal_Queue | server memory | up to 10,000 waiting records plus one in-flight batch of up to 500. Lost if the process dies before the writer drains it |
| Session_Id | server memory | current engine session id, regenerated on each engine start |
| Pending previews | server memory | preview id → client id, account id, action, expiry. Discarded when the connection's account changes (46.4) |
| Paper accounts | engine memory | `BTreeMap<AccountId, PaperAccount>`, at most 1,000. All reset on engine restart |
| Connection_Session | server memory, per WebSocket | account id, address, jti, exp; plus the gateway's `jti → connections` index |
| Nonces | server memory | nonce → address, origin, issued at, expiry, used flag. Swept after expiry |
| Token_Denylist | server memory | jti → exp. Lost on server restart (Decision A12) |
| Pairings | server memory | code → verifier hash, expiry, bound address or none. At most 1,000. Lost on restart |
| Rate-limit windows | server memory | (route, ip) → count, window start |
| Session_Token | client: web `localStorage`, TUI Token_Store, MCP `TERMINAL_TOKEN` env | stateless; verified with `SESSION_SECRET` |
| Client store | web zustand / TUI `App` | a mirror of server messages for display |

## Error Handling

| Failure | Behaviour |
|---|---|
| Malformed or out-of-range engine command | `Event::Error { code, message }` with no panic. The engine keeps reading (2.4, 2.5) |
| Unknown symbol | `Error` naming the symbol (4.2) |
| Bad fixture / speed | `Error` naming the fixture, with replay state unchanged (6.4, 6.5) |
| Negative book delta | Delta dropped, `Error` emitted (9.4) |
| Engine crash | Supervisor restarts it with backoff, and clients get `engine_down`, then `engine_up` + `account_reset` |
| Engine down during order | `OrderRejected engine_unavailable` (15.5) |
| Invalid client message | `Error` to that client, connection kept (17.4) |
| Disallowed origin | 403 on upgrade (17.2) |
| Bad env var | Log the name, exit 1 (16.2) |
| `DATABASE_URL` or `DIRECT_URL` missing with `NODE_ENV=production` | Log the name of each unset variable, exit 1 (16.5) |
| `DATABASE_URL` missing outside production | `MemoryJournalStore`, warning logged (16.6) |
| Neon waking from scale-to-zero | The first query waits a few hundred ms. The writer and endpoints just see a slower query. No error, no status change |
| DB unreachable at startup | `prisma migrate deploy` fails. The Start_Script starts the server anyway with Journal_Status `down`, retries the deploy in the background on backoff, and records wait in the queue (20.17) |
| `prisma migrate deploy` exits non-zero (unreachable DB or a failing Migration) | Redacted CLI output logged, server started with Journal_Status `down`, deploy retried in the background on `backoff.ts` delays (500 ms → 30 s). The writer holds records until a retry succeeds and `setMigrated(true)` is called. Prisma Migrate marks a Migration that failed partway as failed in `_prisma_migrations`, and later deploys stop on it until it is resolved, so the status stays `down` and the log repeats the redacted error |
| DB unreachable during writes (`classifyPrismaError` → `unreachable`: P1001, P1002, P1008, P1017, P2024, `PrismaClientInitializationError`, unmapped adapter errors) | Batch kept, status `down`, redacted error logged, retry 500 ms → 30 s. Orders keep flowing (20.9, 20.10) |
| Commit succeeded but the client saw an error | The retried batch uses `createMany({ skipDuplicates: true })` on the unique `record_id`, so no duplicate rows |
| Batch rejected with a known data or constraint error (`classifyPrismaError` → `poison`: P2000, P2002, P2006, P2007, P2011, P2020, `PrismaClientValidationError`) | Retried one record at a time. Each record that still fails is dropped with one redacted log line naming its `record_id` and the Prisma code, and counted in `poisoned`. The status stays `up` and the queue keeps moving |
| Bad `limit` parameter on `/orders` or `/journal` | 400 with the Zod error message (20.26) |
| Journal_Queue full | Oldest waiting record dropped. Dropped count logged at most every 10 s (20.11) |
| `/orders` or `/journal` while status `down` | `503 { error: "journal_unavailable" }` (20.13) |
| `/orders` or `/journal` query fails or exceeds 5 s | 503, status set to `down` (20.14) |
| `session` parameter other than `all` | 400 with the Zod error message (20.21) |
| SIGTERM | Stop accepting orders, flush the queue for up to 5 s, log the number of unwritten records, exit |
| LLM timeout or invalid output | Error to the client, no preview (23.4, 23.5) |
| Coinbase disconnect | `Error` event, reconnect with backoff (5.5) |
| Backpack disconnect | `Error` event, reconnect with backoff, resubscribe, new REST depth snapshot (43.5, 43.7) |
| Backpack depth sequence gap | Local book for that symbol discarded, new REST snapshot, `BookSnapshot` emitted (43.6) |
| Venue value with more decimals than the Instrument_Table | Message dropped, counter logged at most every 10 s (44.5) |
| Venue tick or lot not a multiple of the internal tick or lot at startup | Error logged naming the symbol (44.4) |
| `PlaceOrder` for a new account when 1,000 exist | `OrderRejected account_limit` (14.5) |
| `Cancel` of another account's order | `OrderRejected` naming the order id; order stays open (14.6) |
| `SESSION_SECRET` unset or < 32 bytes in production | Log the name, exit 1 (16.7) |
| `SESSION_SECRET` unset outside production | Random per-process secret, warning logged (16.8) |
| `WEB_URL` not in `ALLOWED_ORIGINS` | Log the name, exit 1 (16.9) |
| `/auth/nonce` or `/auth/verify` without an allowed Origin | 403 (45.2) |
| Bad address on `/auth/nonce` | 400 (45.3) |
| SIWS check or signature fails | 401 `{ error: "sign_in_failed" }`; nonce already consumed; the reason is logged server-side only (45.5, 45.6) |
| Auth rate limit exceeded | 429 with `Retry-After` (45.15, 48.9) |
| `Authenticate` with a bad token | Connection stays or becomes guest, `Session` + `Notice auth_failed` (46.3) |
| Order after the session token expired | `OrderRejected session_expired`, connection becomes guest with `Session` + `Notice session_expired` (46.5) |
| Logout | jti denylisted; every connection on that jti becomes guest with `Notice signed_out` (46.6) |
| Bad Bearer token on `/positions`, `/orders`, `/journal` | 401 `{ error: "invalid_token" }` (20.29) |
| Pairing poll for an unknown, used, or expired code, or wrong secret | 404, no token (48.8) |
| Server restart | Denylist, nonces, and pairings are lost. Tokens stay valid until expiry. Pending sign-ins and pairings must restart |
| Wallet rejects the sign-in prompt | Web UI shows "Sign-in cancelled" and stays guest |
| `TERMINAL_TOKEN` rejected | MCP tools return "terminal token rejected" without the token (24.11) |
| Client disconnected | "waking server" banner, reconnect ≤ 10 s (33) |
| TUI panic | Terminal restored, then the panic is printed (36.4) |

The Rust library code has no `unwrap`/`expect`. This is enforced by `clippy::unwrap_used` and `clippy::expect_used` at deny level, with tests exempt through `clippy.toml`. Errors use `thiserror` enums.

## Correctness Properties

Each property becomes one property-based test: proptest in Rust, fast-check in TypeScript.

| # | Property | Validates | Test location |
|---|---|---|---|
| P1 | JSON round-trip for every Command, Event, ClientMessage, ServerMessage | 2.3 | protocol |
| P2 | Arbitrary input lines never panic the decoder; invalid ones yield `Error` | 2.4, 2.5 | protocol, engine |
| P3 | Fixture line encode → decode is identity | 7.3 | engine `feed::fixture` |
| P4 | Every candle has low ≤ open, close ≤ high | 8.4 | engine `candles` |
| P5 | Candle volume = sum of trade qty in its interval | 8.5 | engine `candles` |
| P6 | Aggregated higher-timeframe candles = directly built candles | 8.6 | engine `candles` |
| P7 | Replaying the same fixture and commands gives the same events (excluding Heartbeat) | 6.6 | engine `core` |
| P8 | All book level quantities > 0 | 9.9 | engine `book` |
| P9 | Best bid < best ask whenever both sides are non-empty | 9.10 | engine `book` |
| P10 | Snapshot + deltas = snapshot of final levels | 9.11 | engine `book` |
| P11 | EMA within [min, max] of the inputs seen | 10.3 | engine `indicators` |
| P12 | RSI within [0, 100] | 10.4 | engine `indicators` |
| P13 | Incremental SMA = naive mean of the window | 10.5 | engine `indicators` |
| P14 | Limit fills respect the limit price | 11.10 | engine `matcher` |
| P15 | filled + remaining = original | 12.5 | engine `matcher` |
| P16 | Same inputs give identical fills | 12.6 | engine `matcher` |
| P17 | Buy q @ b then sell q @ s: flat, realized = (s − b)·q − fees | 13.5 | engine `account` |
| P18 | For any multi-account state and order request, every approved order satisfies every limit evaluated against its own account's positions and open orders, with the rate counted per connection | 19.2, 19.3, 19.5, 19.8 | server `risk` |
| P19 | Kill switch on: zero approvals | 19.9 | server `risk` |
| P20 | Well-formed commands always parse | 21.7 | server `commands` |
| P21 | Malformed strings give an error and no order | 21.8 | server `commands` |
| P22 | parse(format(c)) = c | 21.9 | server `commands` |
| P23 | Hit map resolves to at most one target, and that target contains the point | 35.3 | tui `hitmap` |
| P24 | Keymap has no duplicate normalized key per context | 32.4 | shared (TS) + tui (Rust) |
| P25 | Backoff delays are non-decreasing and capped at 30 s, and reset after 60 s uptime | 15.2, 15.3 | server `engine/backoff` |
| P26 | For any sequence of journal records and any pattern of store failures (connection errors, and commits that succeed but report an error), once the store recovers and the queue drains, the store holds every enqueued record not dropped exactly once, in enqueue order, and `dropped` equals the number of records evicted from a full queue | 20.1, 20.2, 20.3, 20.10, 20.11, 20.12 | server `journal/queue` (MemoryJournalStore with fault injection, small queue bound) |
| P27 | For any set of journal records across several accounts and sessions with arbitrary i64 Price, Qty, Money, and `ts` values (including i64 min and max), after `insertBatch`, `listJournal({account: a, session: s})` returns exactly the records of account a and session s, `listJournal({account: a, session: "all"})` returns all records of account a, both sorted by `(ts, seq)`, and every field equals what was written | 20.7, 20.19, 20.20, 20.22, 20.23, 20.27, 20.30, 20.31 | server `journal` contract test, run against MemoryJournalStore always and PrismaJournalStore (through `@prisma/adapter-pg`) when `TEST_DATABASE_URL` is set |
| P28 | For any interleaved sequence of market data and order Commands (PlaceOrder, Cancel including ids of other accounts' orders, CancelAll, ResetAccount) across several AccountIds, the OrderAck, OrderRejected, Fill, and Position events of each account equal those from running that account's Commands alone against the same market data (account isolation) | 14.1, 14.3, 14.6, 14.7, 14.8, 14.9 | engine `core` |
| P29 | For any token payload, pair of secrets, clock time, tamper operation, and denylist contents, `verifyToken` accepts a token if and only if it was issued under the current secret, is unmodified, has `exp > now`, and its jti is not denylisted | 45.12, 45.13, 45.14 | server `auth/token` |
| P30 | For any valid SIWS field set (including the optional fields), `parseSiws(formatSiws(f))` equals f | 45.8, 45.9, 45.10 | `shared/siws` (TS) |
| P31 | For any keypair and valid SIWS field set signed with it, verification succeeds unmodified, and fails after changing any one of domain, URI, address, nonce, chain ID, version, statement, or expiration time, or any byte of the signature; after any attempt the nonce is consumed | 45.4, 45.5, 45.6, 45.11 | server `auth/siws` + `auth/nonces` |
| P32 | For any sequence of create, confirm, poll (right or wrong secret), and clock-advance operations over several Pairings, a token is issued for each Pairing at most once, only to a poll with the matching secret, only after confirmation, and only before expiry | 48.6, 48.7, 48.8, 48.10 | server `auth/pairing` |
| P33 | For any tick or lot count in range, formatting it as a decimal string (with or without trailing zeros) and converting back gives the same count; for any decimal string with a non-zero digit beyond the allowed decimals, conversion returns `Inexact` | 44.5, 44.6 | engine `feed::venue` |
| P34 | For any set of connections with Connection_Sessions (including account switches between events) and any sequence of OrderAck, Fill, and Position events, each connection receives exactly the events whose account_id equals its session's account at delivery time | 17.7, 17.10, 17.11 | server `gateway` (pure `routeAccountEvent` + FakeSocket topics) |
| P35 | For any Connection_Sessions and Client_Message sequences, including messages with extra `account_id`/`accountId` fields, every Command the Router sends carries the account_id of the requesting connection's session | 18.5, 18.6 | server `router` (fake engine sender) |

## Testing Strategy

- **Scope change additions:**
  - Rust proptest: P28 (engine core, several accounts), P33 (venue decimals). P1 and P2 generators gain `AccountId` (valid and invalid), `Authenticate`, `Session`, `Venue`, and the new `NoticeKind` values.
  - TS fast-check: P29–P32, P34, P35; P18 and P27 generators gain accounts.
  - Unit and example tests: RFC 8032 Ed25519 vectors on Bun's WebCrypto; config rules for `SESSION_SECRET`, `WEB_URL`, `LIVE_VENUE`; redaction of `SESSION_SECRET`, Session_Tokens, and Pairing_Secrets in logs; auth route status codes (200/204/400/401/403/404/429) with a fake clock; gateway `Session` after `Hello`, accept/reject/expiry/logout downgrade with FakeSocket; Bearer scoping on `/positions`, `/orders`, `/journal`; MCP `TERMINAL_TOKEN` against a mock server; venue symbol map; Backpack and Coinbase captured messages; Backpack sequence-gap resync with crafted update ids; reconnect against a mock WS server; web sign-in with a fake Wallet Standard wallet that records which features were called; a grep test that no file under `web/` names a transaction-signing feature (49.2); TUI Token_Store round-trip in a temp dir with mode `0600` checked on Unix; TUI pairing against a mock HTTP server; `--guest` and `--logout`.
  - Tests must not contact Backpack, Coinbase, or any Solana RPC. Verification tests stub `fetch` to throw (49.3).
- **Rust:** unit tests next to each module. proptest for P1–P17, P23, P24, P28, P33. `TestBackend` buffer assertions for TUI panels and the candle widget at fixed sizes and after resize. Golden tests compare indicators against hand-computed values.
- **TypeScript:** `bun test` with fast-check for P18–P22, P24–P27, P29–P32, P34, P35. Unit tests for the config schema (including the `DATABASE_URL`, `DIRECT_URL`, and `NODE_ENV` rules), secret redaction (no log line or response contains either URL or its password, including Prisma Client log events and `prisma migrate deploy` output), origin check, line splitter, store reducers, keymap loader, LLM parser with a mock provider, `/health` (returns `db` without calling the store), and the `/orders` and `/journal` status codes (200; 400 for a bad `session` or `limit`; 503) with the default (500) and maximum (5000) `limit`.
- **Journal logic units:** `pickAdapter` cases (`DB_ADAPTER=pg`, `.neon.tech` host, other hosts). `classifyPrismaError` cases for each poison code, `PrismaClientValidationError`, the listed unreachable codes, and an unknown error (unreachable). The Start_Script with a fake deploy that fails and then succeeds: the server starts with Journal_Status `down`, records stay queued, the deploy is retried on backoff, and the status becomes `up` once the deploy succeeds and the queue drains.
- **Journal without a database:** the queue, router, and endpoint tests use `MemoryJournalStore`, so `bun run check` needs no database on Windows or macOS (Decision J6).
- **Journal with Postgres:** `server/src/journal/prisma.test.ts` runs `PrismaJournalStore` through `@prisma/adapter-pg` and wraps its tests in `describe.skipIf(!process.env.TEST_DATABASE_URL)` (41.7). It expects the Migrations to be applied already with `prisma migrate deploy` (the `journal-pg` CI job does this first). It covers P27 against Postgres, i64 min/max round-trips for every `BIGINT` field, `skipDuplicates` dedupe on a retried batch, and `seq` following enqueue order across the three tables. Between cases it clears the tables with a `$executeRaw` tagged template. The suite refuses to run if `TEST_DATABASE_URL` equals `DATABASE_URL` or `DIRECT_URL`, because it deletes journal rows, so `TEST_DATABASE_URL` must point at a disposable database.
- **Optional local Postgres:** the user can point `TEST_DATABASE_URL` (in `.env`) at a Neon dev branch. Neon's Free plan allows 10 branches per project. Use the branch's direct (non-pooled) URL for tests.
- **Integration:** `bun test` spawns the real engine binary (built by `cargo build`) and checks heartbeat, restart, order → fill → journal record (MemoryJournalStore, plus Postgres when `TEST_DATABASE_URL` is set), and that orders still fill while the store is failing.
- **Smoke:** `server/scripts/smoke.ts` runs against a Docker container in CI, with the `postgres:17` service URL passed as both `DATABASE_URL` and `DIRECT_URL`. Reaching `db: "up"` shows that the Start_Script applied the Migrations.
- **CI:** `bun run check` on Windows and macOS. The `journal-pg` job (Postgres tests), the Docker smoke test, and the render.yaml schema check run on Linux, because GitHub service containers only run on Linux runners.
- **PBT settings:** fast-check runs each property at least 100 times (`numRuns: 100`). P27 against Postgres inserts each generated record set in one batch, so 100 runs stay fast.
