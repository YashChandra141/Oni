# Tech Stack and Conventions

## Standing rule: ask before every command
The user must approve every shell or terminal command (cargo, bun, git, rustup, docker, npm, etc.) before it runs. State the exact command, the working directory, and why it's needed, then wait. Creating and editing files does not need approval. Never run destructive commands. Never commit secrets.

## Stack
| Part | Choice |
|---|---|
| Rust | Cargo workspace in `rust/` (crates `protocol`, `engine`, `tui`), Rust 1.94, edition 2024 |
| Server | Bun 1.4.4, Hono, `Bun.serve` WebSockets, `Bun.spawn`, Zod, `bun test` + fast-check. No database: orders, fills, and rejections live in an in-memory Activity_Log for the current engine run |
| Web | Next.js 16 App Router as a static export (`output: 'export'`), TypeScript, Tailwind, zustand, TradingView Lightweight Charts |
| Auth | Sign In With Solana (SIWS) messages; Ed25519 verification with WebCrypto (`crypto.subtle`, Ed25519) in Bun, falling back to exact-pinned `@noble/curves` only if Bun's WebCrypto lacks Ed25519; base58 with `@scure/base`; stateless HMAC-SHA256 Session_Tokens signed with `SESSION_SECRET` (24 h, jti, in-memory logout denylist) |
| Wallets (web) | `@wallet-standard/app` (`getWallets()`) with `@wallet-standard/features` and `@solana/wallet-standard-features`, not `@solana/wallet-adapter-react`: no transactions are ever sent, so no `@solana/web3.js` connection is needed. Phantom and Backpack only |
| TUI auth | Device-code pairing over `POST /auth/pair` and `/auth/pair/poll`; `reqwest` (rustls, ring); token file in `dirs::config_dir()/haunted-terminal/session.json`, mode 0600 on Unix |
| Agents | `@modelcontextprotocol/sdk` (MCP). One `LlmProvider` interface with four implementations (OpenAI, Anthropic, NVIDIA NIM, Ollama) behind plain `fetch`; used by the plain-English order parser and the AI analyst |
| News | One `NewsProvider` interface: NewsAPI (local development only) and CryptoPanic (hosted), cached in server memory |
| Deploy | Render Blueprint (`render.yaml`), Dockerfile `rust:1.94-bookworm` → `oven/bun:1.4.4-debian`. No database service |

## Layout
```
rust/crates/{protocol,engine,tui}   server/   web/   shared/{protocol,keymap.json}   fixtures/
```
Root `package.json` declares Bun workspaces `server`, `web`, `shared`.

## Commands
- `bun run check`: everything (cargo fmt check, clippy `-D warnings`, cargo test, tsc, bun test). Must pass before a task is marked done. It needs no database, no API key, and no network.
- `bun run gen:protocol`: regenerate `shared/protocol/*.ts` from the Rust protocol crate (added in Task 2).
- `bun run bench:latency`: start the server and engine in replay mode, drive loopback clients, and print p50 and p95 for the latency targets.

## TypeScript conventions
- Prefer Bun APIs (`Bun.serve`, `Bun.spawn`, `Bun.file`, `bun:test`) over Node equivalents.
- Validate every external input with Zod at the boundary: env vars, WebSocket messages, engine stdout lines, LLM output, news and DEX responses, MCP tool arguments, REST params.
- Protocol types come from `shared/protocol/` (generated). Never hand-edit those files.
- `Price`, `Qty`, and `Money` arrive as decimal strings. Convert with `BigInt`, never `Number` or `parseFloat`.
- Pin exact dependency versions (`bun add --exact`). Commit `bun.lock`. Prefer plain `fetch` through the allowlisted HTTP wrapper over provider SDKs; if an SDK is ever added, pin its exact version.
- Strict TS (`strict`, `noUncheckedIndexedAccess`). No `any` except at a validated boundary.
- Every outbound HTTP request goes through `server/src/net/http.ts`, which refuses a URL that is not in the allowlist.

## Wire protocol
- Engine ↔ server: one JSON object per line on stdin/stdout. Engine logs go to stderr only.
- Client ↔ server: JSON messages over WebSocket at `/ws`, typed by `ClientMessage` / `ServerMessage`. The server may send several Events in one `event_batch` message.
- Messages are internally tagged with a snake_case `type` field.
- Protocol v3: order Commands (`PlaceOrder`, `Cancel`, `CancelAll`, `ResetAccount`) and account Events (`OrderAck`, `OrderRejected`, `Fill`, `Position`, `Balance`) carry `account_id` (`guest` or `w_<base58 address>`, 1..=64 chars of `[A-Za-z0-9_]`). `PlaceOrder`, `OrderAck`, `OrderRejected`, `Fill`, and all market data Events (`Candle`, `Trade`, `Book`, `Indicators`, `Ticker24h`) carry a `venue`. Clients authenticate with `ClientMessage::Authenticate { token }` after connect, since browsers can't set WebSocket headers; the server answers `ServerMessage::Session { account_id, address }`. Clients also send `SetProvider` and `SubscribeNews`. REST calls use `Authorization: Bearer <token>`.
- Account events go to the Bun topic `account:<account_id>`; notices go to `notices`.

## Market data endpoints (read-only allowlist)
- Coinbase: public market-data WebSocket and REST (exact endpoints confirmed in Task 7.1).
- Backpack: WebSocket `wss://ws.backpack.exchange`, subscribe with `{"method":"SUBSCRIBE","params":["trade.SOL_USDC","depth.SOL_USDC"]}`, messages arrive as `{"stream": "...", "data": {...}}`. REST under `https://api.backpack.exchange` (markets, depth, klines, trades). Field names and the kline endpoint are verified against https://docs.backpack.exchange/ in Task 7.1.
- Jupiter: `GET https://api.jup.ag/price/v3?ids=<mint,mint,...>` (up to 50 mints). Keyless is limited to 0.5 requests per second; an optional `JUPITER_API_KEY` goes in the `x-api-key` header. Prices only.
- Raydium: `GET https://api-v3.raydium.io/mint/price?mints=<...>` and `GET /pools/info/mint` (pool TVL). No other Raydium host.
- News and LLM hosts (Server only): `https://newsapi.org/v2/`, `https://cryptopanic.com/api/`, `https://api.openai.com`, `https://api.anthropic.com`, the host of `NVIDIA_BASE_URL`, and the host of `OLLAMA_BASE_URL`.
- Internal symbols are `BTC-USD`, `ETH-USD`, `SOL-USD`, `BNB-USD`, `XRP-USD`, `DOGE-USD`, `JUP-USD`, `WIF-USD`, `BONK-USD`, and `PEPE-USD`. Each has its own tick and lot size in the Instrument_Table; `feed/venue.rs` maps them to venue symbols and token mints. `price_decimals + qty_decimals` never exceeds 10 (the Money scale). CEX values that don't fit exactly are dropped and counted, never rounded. DEX prices are rounded to the nearest tick.

## Testing
- Property-based tests for every "FOR ALL" acceptance criterion: proptest in Rust, fast-check in TS. The property table is in `design.md`.
- Keep the engine core and the server's risk/parser modules pure so they can be tested without I/O.
- The Activity_Log is a pure in-memory store with an injectable bound, so its tests need nothing external.
- LLM providers, News_Providers, and the Jupiter and Raydium adapters are tested against mock HTTP servers and recorded response fixtures. No test contacts a real exchange, news host, LLM host, or Solana RPC.
- Auth stores (nonces, tokens, pairings, rate limits) are pure with an injectable clock. Tests use generated keypairs, a fake Wallet Standard wallet, and mock WS/HTTP servers; they never contact Backpack, Coinbase, Jupiter, Raydium, a Solana RPC, or a real wallet.
