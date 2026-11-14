# Venue notes (Task 7.1)

Reference for Tasks 7.2 to 7.7. Public, unauthenticated endpoints only (trading-safety rule 1).

**Verdict: every symbol on both venues fits the fixed internal decimals (2 price, 8 qty). The instrument table needs no change.** See the table in section 3.

Provenance legend: **[V]** verified by a one-off read-only fetch of the public endpoint or an official docs page; **[M]** from an AsyncAPI mirror or recalled docs wording and not re-read from the official page. Confirm every [M] item with a real capture in Task 7.7.

Samples: `rust/crates/engine/tests/data/` (hand-written documented examples, not live captures; see its README).

## 1. Backpack

Docs: https://docs.backpack.exchange/ (reference, script-rendered), https://support.backpack.exchange/exchange/api-and-developer-docs/python-websocket-guide-for-backpack-exchange-api, AsyncAPI mirror https://apis.io/asyncapis/backpack/backpack-asyncapi/

### WebSocket
- URL: `wss://ws.backpack.exchange` [V, support guide]
- Subscribe: `{"method":"SUBSCRIBE","params":["trade.SOL_USDC","depth.SOL_USDC"]}`. Unsubscribe: same with `"UNSUBSCRIBE"`. [V, guide; UNSUBSCRIBE: M]
- Stream names: `<type>.<symbol>`, e.g. `trade.SOL_USDC`, `depth.SOL_USDC`. Symbols: `BTC_USDC`, `ETH_USDC`, `SOL_USDC`.
- Envelope: `{"stream":"depth.SOL_USDC","data":{...}}`. [V, guide]
- Public streams need no signature; only `account.*` streams do (do not use them). [V]
- Timestamps: **microseconds** for all stream times (`E`, `T`), except kline `t`/`T` (ISO 8601) and RFQ `w`/`W` (ms, unused). [M, AsyncAPI mirror; consistent with the RFQ docs page, which says "Event time in microseconds"]. Convert to ms with `/1000` for the fixture time.
- Keepalive: server sends a WS Ping every 60 s; the client must answer with a Pong within 120 s or be closed. A client library that auto-pongs (tungstenite does) is enough; no app-level ping. On server shutdown a Close frame arrives with a 30 s grace; reconnect. [M]

### `trade.<symbol>` (fields [M])
| Field | Type | Meaning |
|---|---|---|
| `e` | string | `"trade"` |
| `E` | integer | event time, µs |
| `s` | string | symbol |
| `p` | string | price |
| `q` | string | quantity (base) |
| `b` | string | buyer order id |
| `a` | string | seller order id |
| `t` | integer | trade id (sequential per symbol) |
| `T` | integer | engine timestamp, µs |
| `m` | bool | `true` if the buyer is the maker, so the aggressor (taker) is the seller; `false` means aggressor is the buyer |

Aggressor mapping: `m == true` → Sell aggressor, `m == false` → Buy aggressor. REST `/api/v1/trades` uses the same idea as `isBuyerMaker` [V].

### `depth.<symbol>` (fields [M])
| Field | Type | Meaning |
|---|---|---|
| `e` | string | `"depth"` |
| `E` | integer | event time, µs |
| `s` | string | symbol |
| `a` | `[[price, qty]]` | asks, absolute quantity at each level |
| `b` | `[[price, qty]]` | bids, absolute quantity |
| `U` | integer | first update id in this event |
| `u` | integer | last update id in this event |
| `T` | integer | engine timestamp, µs |

A level with quantity `"0"` is removed. Aggregated variants `depth.<200ms|600ms|1000ms>.<symbol>` exist; not needed.

### Depth continuity and sync [M, apis.io channel page https://apis.io/channels/backpack/depth-symbol/]
1. Subscribe to `depth.<sym>` and buffer events.
2. Fetch the REST snapshot `GET /api/v1/depth?symbol=<sym>`; read `lastUpdateId`.
3. Drop buffered events with `u <= lastUpdateId`. Apply the first event that covers `lastUpdateId + 1` (`U <= lastUpdateId + 1 <= u`).
4. After that, each event must satisfy `U == previous u + 1`. Any gap (`U > previous u + 1`) means: discard the book, refetch the snapshot, resync. Events with `u <= previous u` are stale; drop them.

Ambiguity: the mirror states only "`U` must equal previous `u + 1`" and does not spell out the first-event rule in step 3. Step 3 is the standard rule for this stream style; a lenient implementation (accept first event with `u > lastUpdateId`) is safe because quantities are absolute. Confirm against a real capture.

### REST (base `https://api.backpack.exchange`)
- `GET /api/v1/markets` → array of market objects. `GET /api/v1/market?symbol=BTC_USDC` → one. Used fields [V]: `symbol`, `baseSymbol`, `quoteSymbol`, `marketType` (`SPOT`), `orderBookState`, `filters.price.tickSize`, `filters.price.minPrice`, `filters.quantity.stepSize`, `filters.quantity.minQuantity`. All numbers are strings. Use `/market?symbol=` at startup (the full list is ~178 KB).
- `GET /api/v1/depth?symbol=SOL_USDC` → `{"asks":[[p,q]...],"bids":[[p,q]...],"lastUpdateId":"<string>","timestamp":<µs int>}` [V]. Both sides are sorted **ascending**: best ask is first, best bid is **last**. The full book is large (about 12 KB for SOL); fetch it only for sync.
- `GET /api/v1/klines?symbol=SOL_USDC&interval=1m&startTime=<unix SECONDS>[&endTime=<unix seconds>]` [V]. `startTime` is required. A request with `startTime` far in the past returned HTTP 400 in one probe (value `1767225600` with no `endTime`); a recent start with an `endTime` worked. Treat 400 as "narrow the window". Response: array of `{"start":"YYYY-MM-DD HH:MM:SS","end":"YYYY-MM-DD HH:MM:SS","open","high","low","close","volume","quoteVolume","trades"}`, all strings, UTC, oldest first, no numeric timestamp (parse the string, assume UTC). Intervals used: `1m`, `5m`, `15m`, `1h`, `1d` [interval names: M].
- `GET /api/v1/trades?symbol=SOL_USDC&limit=N` → `[{"id":int,"isBuyerMaker":bool,"price":"..","quantity":"..","quoteQuantity":"..","timestamp":<ms int>}]` [V]. REST trade time is **milliseconds**, unlike WS (µs).
- Rate limits: not found in any fetched public source. Assume a conservative budget (a few requests per second); backfill per symbol/timeframe once on subscribe, never in a loop. Handle HTTP 429 with backoff. Unknown, to confirm.

## 2. Coinbase (Advanced Trade public market data)

Choice: use the **Advanced Trade** public endpoints, which need no JWT for market data (https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-channels and .../guides/websocket). The older Exchange feed (`ws-feed.exchange.coinbase.com`) was not researched; its `level2` channel is documented elsewhere as needing auth, so it is not used.

### WebSocket
- URL: `wss://advanced-trade-ws.coinbase.com` (public). `wss://advanced-trade-ws-user.coinbase.com` is the authenticated user feed: **never use**. [V]
- Subscribe (one message per channel, within 5 s of connect or the server closes): `{"type":"subscribe","channel":"market_trades","product_ids":["BTC-USD","ETH-USD","SOL-USD"]}` and the same with `"channel":"level2"`. The optional `jwt` field must be omitted. [V]
- Public channels: `level2`, `market_trades`, `ticker`, `ticker_batch`, `candles`, `status`, `heartbeats`. Private: `user`, `futures_balance_summary` only. [V]
- Keepalive: channels close after 60 to 90 s without updates; subscribe to `heartbeats` too (server ping each second). [V]
- Envelope (both channels): `{"channel","client_id","timestamp"(RFC 3339),"sequence_num"(int, per connection),"events":[...]}`. A `sequence_num` gap means dropped messages: resubscribe. [V]
- `-USDC` product ids return the same data as `-USD`; use `-USD`. [V]

`market_trades` event: `{"type":"snapshot"|"update","trades":[{"trade_id":str,"product_id":str,"price":str,"size":str,"side":"BUY"|"SELL","time":RFC3339}]}`. `side` is documented as **the maker's side**, so aggressor = opposite. Batched over 250 ms. Ambiguity: some older docs describe `side` as the taker side; verify with a capture. [V schema]

`level2` event (message `channel` = `"l2_data"`): `{"type":"snapshot"|"update","product_id":str,"updates":[{"side":"bid"|"offer","event_time":RFC3339,"price_level":str,"new_quantity":str}]}`. `new_quantity` is absolute; `"0"` removes the level. The first message after subscribe is the snapshot. [V schema]

Timestamps: RFC 3339 strings (microsecond precision on trades). Convert to ms.

### REST (base `https://api.coinbase.com/api/v3/brokerage`, public, no JWT)
- `GET /market/products/{product_id}` → includes `price_increment` (tick), `quote_increment`, `base_increment` (size step), `base_min_size`, `status`, `trading_disabled`. Strings. [V]
- `GET /market/products/{product_id}/candles?start=<unix s>&end=<unix s>&granularity=<G>[&limit=<=350]`: `start` and `end` are required, Unix seconds. Granularity enum: `ONE_MINUTE`, `FIVE_MINUTE`, `FIFTEEN_MINUTE`, `THIRTY_MINUTE`, `ONE_HOUR`, `TWO_HOUR`, `FOUR_HOUR`, `SIX_HOUR`, `ONE_DAY`. Max 350 candles per call. Response `{"candles":[{"start":"<unix s>","low","high","open","close","volume"}]}`, strings, **newest first**. Our timeframes map to `ONE_MINUTE`, `FIVE_MINUTE`, `FIFTEEN_MINUTE`, `ONE_HOUR`, `ONE_DAY`. [V]
- Public REST responses are cached for 1 s (send `cache-control: no-cache` for fresh data). [V]
- Other public routes: `/market/product_book`, `/market/products`, `/market/products/{id}/ticker`, `/time`. [V]

### Rate limits
- WebSocket: connections and unauthenticated messages are each limited to **8 per second per IP**. One connection with 2 subscribes plus heartbeats fits; do not open a connection per symbol in a burst. [V, https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-rate-limits]
- REST public: the Advanced Trade public limit page was not found. The Exchange API documents 10 requests/s per IP (15 burst) for public endpoints (https://docs.cdp.coinbase.com/exchange/rest-api/rate-limits); use 5 req/s or less as a safe budget. Backfill: at most 5 timeframes per subscribed symbol, one call each, up to 350 bars. Unknown for Advanced Trade: confirm.
- HTTP 429 → exponential backoff.

## 3. Tick and step vs internal decimals

Internal: price tick 0.01 (2 decimals), qty lot 0.00000001 (8 decimals). A venue value fits if it is a non-negative whole multiple of the internal unit, i.e. it has at most 2 (price) or 8 (qty) decimals.

| Venue | Symbol | Venue symbol | Tick | Step | Price fits (≤2 dp) | Qty fits (≤8 dp) |
|---|---|---|---|---|---|---|
| Backpack | BTC-USD | BTC_USDC | 0.1 | 0.00001 | yes | yes |
| Backpack | ETH-USD | ETH_USDC | 0.01 | 0.0001 | yes | yes |
| Backpack | SOL-USD | SOL_USDC | 0.01 | 0.01 | yes | yes |
| Coinbase | BTC-USD | BTC-USD | 0.01 | 0.00000001 | yes | yes |
| Coinbase | ETH-USD | ETH-USD | 0.01 | 0.00000001 | yes | yes |
| Coinbase | SOL-USD | SOL-USD | 0.01 | 0.00000001 | yes | yes |

Sources: Backpack `GET /api/v1/market?symbol=<sym>` (`filters.price.tickSize`, `filters.quantity.stepSize`) [V]; Coinbase `GET /api/v3/brokerage/market/products/<id>` (`price_increment`/`quote_increment`, `base_increment`) [V]. Fetched once during Task 7.1; metadata can change, so the startup check in 7.2 stays necessary.

Notes: Backpack BTC trades on a coarser grid (0.1 tick, 0.00001 step) than the internal one, which is fine for conversion. Backpack streams carry prices with trailing zeros stripped (e.g. `"75.5"`), so `to_ticks` must parse variable-length decimals.

## 4. Open points
1. Backpack WS `trade`/`depth` field names are [M] (official page not readable by the tool). Confirm with a capture.
2. Backpack first-event rule after the REST snapshot is not spelled out in the mirror; see section 1.
3. Backpack REST rate limits not found.
4. Coinbase Advanced Trade public REST limit not found (Exchange numbers used as a proxy).
5. Coinbase `market_trades.side` semantics (maker vs taker) differ between sources.
6. A Backpack `klines` request with an old `startTime` and no `endTime` returned 400 in one probe; cause not confirmed.
