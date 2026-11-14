# Implementation Plan: Haunted Terminal

## Overview

Build Haunted Terminal incrementally: monorepo and CI first, then the Rust protocol crate and engine, the Bun server, market data, the web and TUI clients, paper trading, the risk/router/journal path, order entry, the LLM and MCP order sources, deployment, and the submission. Each task ends with its tests passing and its demo working before the next task starts.

Scope change (approved after 4.3): per-wallet paper accounts plus a shared guest account, wallet sign-in with SIWS in the web UI, TUI pairing, and live data from Coinbase or Backpack. New top-level Tasks 17–21 hold the new work and are listed after Task 16, but the Task Dependency Graph schedules them: Task 17 (protocol v2) runs right after 4.6 and before the clients, the matcher, and the gateway auth work. Task 7 was restructured for both venues (none of its sub-tasks had started). Not-started sub-tasks in Tasks 10, 11, 12, 14, and 15 gained bullets for accounts and auth. Completed tasks are unchanged.

## Tasks

- [ ] 1. Monorepo skeleton, Kiro setup, and CI
  - [x] 1.1 Root workspace files
    - Root `package.json` with Bun workspaces (`server`, `web`, `shared`) and scripts `check`, `check:rust`, `check:ts`, `typecheck`, `test`
    - `tsconfig.base.json`, MIT `LICENSE`, `.gitignore` (does not ignore `.kiro/`), README stub
    - _Requirements: 41.2, 42.1, 42.2, 42.6_
  - [x] 1.2 Placeholder packages
    - `server/`, `web/`, `shared/` each with `package.json`, `tsconfig.json`, and one placeholder `bun test`
    - `rust/Cargo.toml` workspace, `rust/clippy.toml`, and an empty `protocol` crate with one test
    - _Requirements: 41.2_
  - [x] 1.3 Steering docs
    - `.kiro/steering/product.md`, `tech.md`, `rust.md` (fileMatch on `rust/**`), `trading-safety.md`
    - _Requirements: 42.3_
  - [ ] 1.4 Kiro hooks
    - On `.rs` save: `cargo test` + `cargo clippy -- -D warnings`
    - On `.ts`/`.tsx` save: `bun test` + `tsc --noEmit`
    - _Requirements: 42.4, 42.5_
  - [x] 1.5 CI workflow
    - `.github/workflows/ci.yml` matrix on `windows-latest` and `macos-latest`, running `bun run check`
    - _Requirements: 41.1_
  - [-] 1.6 Verify: install dev dependencies, run `bun run check` locally
    - _Requirements: 41.2_

- [x] 2. Protocol crate and engine echo loop
  - [x] 2.1 Numeric newtypes `Price`, `Qty`, `Money` (JSON strings), `Timeframe`, `Side`, `OrderKind`, `OrderId`, and the instrument table with `notional()`
    - _Requirements: 1.4, 1.5, 4.1_
  - [x] 2.2 `Command`, `Event`, `ClientMessage`, `ServerMessage` enums with serde tags and ts-rs exports to `shared/protocol/`; `bun run gen:protocol`
    - _Requirements: 1.1, 1.2, 1.3_
  - [x] 2.3 JSON-lines codec with range validation (`decode_command`) mapping failures to `Error` events
    - _Requirements: 2.1, 2.2, 2.4, 2.5, 4.2_
  - [x] 2.4 Property tests P1 (round-trip) and P2 (no panic on arbitrary input)
    - _Requirements: 2.3, 2.4_
  - [x] 2.5 Engine binary: clap `run`, tokio runtime, stdin reader, stdout writer, Ping → Pong, 1 s Heartbeat, stderr tracing, exit 0 on EOF
    - _Requirements: 1.6, 3.1, 3.2, 3.3, 3.4, 3.5_
  - [x] 2.6 Demo: pipe a ping into the engine; generated TS types exist

- [x] 3. Bun server, engine supervision, and WebSocket gateway
  - [x] 3.1 `config.ts` Zod env schema with secret redaction; `.env.example`
    - Includes `DATABASE_URL` and `DIRECT_URL` (postgres URLs, each redacted in full along with its password; empty placeholders in `.env.example`), `DB_ADAPTER` (`pg` or unset), and `NODE_ENV` (production makes both URLs required, logging each unset name); `redactSecrets()` helper
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5_
  - [x] 3.2 `lines.ts` splitter, `protocol.ts` Zod schemas, `backoff.ts`
    - _Requirements: 15.2, 15.3_
  - [x] 3.3 Property test P25 (backoff) and unit tests for lines and schemas
    - _Requirements: 15.2, 15.3_
  - [x] 3.4 `supervisor.ts`: spawn, stdin writer, stdout/stderr readers, restart, resend subscriptions, `account_reset` notice
    - _Requirements: 15.1, 15.4, 15.6, 15.7, 15.8, 18.4_
  - [x] 3.5 Gateway: origin check, `Hello`, Zod validation of client messages, subscription ref-counting, Bun topics; `/health`
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 17.6, 17.7_
  - [x] 3.6 Integration test: real engine heartbeat reaches a WS client; killing the engine restarts it
    - _Requirements: 15.1, 15.2_

- [x] 4. Replay feed and candle builder
  - [x] 4.1 `MarketMsg`, fixture encode/decode, property test P3
    - _Requirements: 7.2, 7.3_
  - [x] 4.2 `engine synth` seeded fixture generator; commit `fixtures/demo.jsonl` (BTC, ETH, SOL)
    - _Requirements: 6.1, 6.2_
  - [x] 4.3 Replay feed: `StartReplay` with speed 1–50, fixture name validation, looping, errors
    - _Requirements: 6.1, 6.3, 6.4, 6.5_
  - [x] 4.4 Candle_Builder with 500-bar rings, snapshot on subscribe, live updates
    - _Requirements: 8.1, 8.2, 8.3, 8.7, 8.8_
  - [x] 4.5 Property tests P4, P5, P6, P7
    - _Requirements: 6.6, 8.4, 8.5, 8.6_
  - [x] 4.6 Server sends `StartReplay` on engine start; candle cache in `state/market.ts`; demo: WS subscribe streams candles

- [x] 5. Next.js web UI with a live candle chart
  - [x] 5.1 Next.js 16 app (App Router, TS, Tailwind, `output: 'export'`), pinned versions, green-screen theme
    - _Requirements: 37.1, 37.2, 37.3_
  - [x] 5.2 `shared/keymap.json` + TS loader with duplicate-key validation; property test P24 (TS)
    - _Requirements: 32.1, 32.3, 32.4_
  - [x] 5.3 `useTerminalSocket` with capped backoff, "waking server" status, resubscribe; zustand store with pure reducers and tests
    - _Requirements: 33.1, 33.2, 33.3_
  - [x] 5.4 `ChartPanel` (Lightweight Charts via `next/dynamic`, ssr false): candles, volume, timeframe buttons and keys 1–5, wheel zoom, drag pan, keyboard zoom/pan, crosshair
    - _Requirements: 25.1, 25.2, 25.3, 25.4, 25.5, 29.1, 29.2_

- [x] 6. TUI with a candle chart and mouse support
  - [x] 6.1 `tui` crate: clap `--server`/`--version`, terminal guard, panic hook, default server URL
    - _Requirements: 36.1, 36.2, 36.3, 36.4_
  - [x] 6.2 `net.rs` WS client with reconnect ≤ 10 s, resubscribe, "waking server" status
    - _Requirements: 33.1, 33.2, 33.3_
  - [x] 6.3 Embedded keymap with validation; property test P24 (Rust)
    - _Requirements: 32.2, 32.4_
  - [x] 6.4 `CandleChart_Widget` (block candles, volume, price axis, zoom/pan window, crosshair) with TestBackend tests
    - _Requirements: 25.1, 25.2, 25.3, 25.4, 29.1, 29.2, 34.1_
  - [x] 6.5 `HitMap` and mouse handling; property test P23
    - _Requirements: 35.1, 35.2, 35.3_
  - [x] 6.6 Event loop with 30 fps cap; manual check on Windows Terminal, PowerShell, Terminal.app, iTerm2
    - _Requirements: 34.3, 34.4_

- [x] 7. Live feeds (Coinbase and Backpack), venue switch, recorder, and watchlist
  - [x] 7.1 Verify both venues' public endpoints and metadata
    - Coinbase: public WS channels (trades, level2), REST candle endpoint, product tick and size increments
    - Backpack (https://docs.backpack.exchange/): `wss://ws.backpack.exchange` subscribe format, `trade.<sym>` and `depth.<sym>` message fields, depth first/last update id fields and continuity rule, timestamp unit (ms or µs), buyer-is-maker flag, keepalive rules; REST `markets`, `depth`, `klines` (path, parameters, time unit) under `https://api.backpack.exchange`
    - Confirm each venue's tick and step for BTC, ETH, SOL fit the fixed internal decimals (2 price, 8 qty); if one doesn't, stop and ask the user before changing the instrument table (design Decision A6)
    - Save one captured sample of each message type per venue under `rust/crates/engine/tests/data/` for the tests in 7.6
    - _Requirements: 4.1, 5.3, 43.3, 44.3_
  - [x] 7.2 Venue layer
    - `feed/venue.rs`: `Venue` enum, Venue_Symbol_Map (both directions), exact `to_ticks`/`to_lots` decimal conversion returning `Inexact` for extra non-zero digits, drop counter logged at most every 10 s, startup metadata check that logs an error per non-fitting symbol
    - `engine run --venue coinbase|backpack` (clap); server passes `LIVE_VENUE` (config from 18.1) as `--venue` in `supervisor.ts`; gateway fills `Hello.venue` in live mode
    - _Requirements: 1.11, 44.1, 44.2, 44.4, 44.5_
  - [x] 7.3 Property test P33 (venue decimal round-trip and `Inexact`) and Venue_Symbol_Map table test
    - **Property 33: venue decimals**
    - _Requirements: 44.2, 44.5, 44.6_
  - [x] 7.4 Coinbase_Adapter (rustls + ring), normalization to `MarketMsg` through the venue layer, reconnect with backoff, REST backfill
    - _Requirements: 5.1, 5.2, 5.4, 5.5_
  - [x] 7.5 Backpack_Adapter (rustls + ring): subscribe to trade and depth streams for the three `_USDC` symbols, dispatch on `{"stream","data"}`, REST depth snapshot + update-id continuity with resync on a gap, trade normalization (aggressor from the maker flag, timestamp to ms), REST kline backfill on subscribe, reconnect with backoff and an `Error` event; no API key, signature, or auth header anywhere
    - _Requirements: 43.1, 43.2, 43.3, 43.4, 43.5, 43.6, 43.7, 43.8_
  - [x] 7.6 Adapter tests
    - Parse the captured Coinbase and Backpack samples from 7.1 into the expected `MarketMsg` values
    - Backpack: crafted update-id sequences with a gap trigger a resync and a `BookSnapshot`; updates at or before the snapshot id are dropped
    - Both venues: reconnect against a mock WS server emits `Error` and resubscribes; adapters send no auth header (mock server asserts)
    - _Requirements: 5.5, 43.3, 43.4, 43.5, 43.6, 43.7_
  - [x] 7.7 `engine record --venue coinbase|backpack --symbols … --out <fixture>` writing normalized `MarketMsg` fixture lines; test against a mock WS for each venue
    - _Requirements: 7.1_
  - [x] 7.8 Watchlist panel in web and TUI (click, Tab, arrows); status bar shows `REPLAY` or `LIVE · <venue>` (Backpack shown with "(USDC)") from `Hello`
    - _Requirements: 27.3, 27.4, 44.7_

- [x] 8. Order book and trades tape
  - [x] 8.1 Order_Book: snapshot, deltas, negative-delta error, crossed-book rule, top 20, spread, imbalance, 100 ms market-time throttle; Trade events
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8_
  - [x] 8.2 Property tests P8, P9, P10
    - _Requirements: 9.9, 9.10, 9.11_
  - [x] 8.3 Book panel with depth bars and trades tape in both clients; click or arrows+Enter prefills a limit ticket
    - _Requirements: 27.1, 27.2, 30.1_

- [x] 9. Indicators
  - [x] 9.1 EMA, SMA, VWAP, Bollinger, RSI, ATR with committed state + `peek`; Indicators events
    - _Requirements: 10.1, 10.2_
  - [x] 9.2 Property tests P11, P12, P13 and golden tests
    - _Requirements: 10.3, 10.4, 10.5_
  - [x] 9.3 Overlays and RSI/ATR pane in web (line series) and TUI (braille canvas + Chart sub-pane); toggles by hotkey and click
    - _Requirements: 26.1, 26.2, 26.3, 26.4, 34.2_

- [x] 10. Paper matcher and P&L
  - [x] 10.1 Matcher: market, limit, stop; level walking; partial fills; fees; OrderAck/Fill events; cancel and cancel-all; unknown cancel → OrderRejected
    - Uses the protocol v2 Commands from Task 17: each open order stores its `AccountId`; events carry it; `Cancel` of an order open under another account → `OrderRejected`, order stays open; `CancelAll` removes only that account's orders; fills never change the market book; matching passes run in order-id insertion order across accounts (design Decision A9)
    - _Requirements: 11.1–11.9, 12.1, 12.2, 12.3, 12.4, 12.7, 14.6, 14.7, 14.8_
  - [x] 10.2 Paper_Account: cost basis, realized/unrealized P&L, Position events, ResetAccount
    - `Accounts` as `BTreeMap<AccountId, PaperAccount>`: lazy creation on first `PlaceOrder`, cap of 1,000 with `OrderRejected account_limit` (cap injectable for tests), `ResetAccount { account_id }` resets only that account, unrealized updates emit `Position` per account with a non-zero position, in `AccountId` order
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 14.1, 14.3, 14.4, 14.5_
  - [x] 10.3 Property tests P14, P15, P16, P17
    - _Requirements: 11.10, 12.5, 12.6, 13.5_
  - [x] 10.4 Property test P28 (account isolation) and account unit tests
    - **Property 28: account isolation** — interleave market data with Commands for 2–5 accounts (including cancels of other accounts' order ids, CancelAll, ResetAccount); compare each account's events with a solo run
    - Unit tests: `account_limit` with a small cap; ResetAccount of A leaves B unchanged; unknown-account Cancel → OrderRejected
    - _Requirements: 14.1, 14.3, 14.5, 14.6, 14.7, 14.8, 14.9_

- [x] 11. Risk engine, order router, and journal
  - [x] 11.1 `risk.ts` pure check with default limits and kill switch; property tests P18, P19
    - `positions` and `openOrderCount` come from the order's account; the rate window stays keyed by connection id; P18's generator covers several accounts and two connections on one wallet
    - _Requirements: 19.1–19.9_
  - [x] 11.2 `router.ts` as the only sender of order commands; `engine_unavailable`; test that no other module imports the sender
    - `submit(order, origin)` with `origin = { connectionId, session, source }`; every Command's `account_id` comes from `origin.session` (guest without a session); expired wallet session → `OrderRejected session_expired` and the gateway's downgrade hook (from 19.1); `flattenAll`, cancel, cancel-all, and reset act on the requester's account only
    - _Requirements: 15.5, 18.1, 18.2, 18.3, 18.5, 46.5_
  - [x] 11.3 `state/account.ts` position and open-order cache
    - Keyed by `AccountId`; cleared for every account on engine restart
    - _Requirements: 14.1, 14.2, 15.7_
  - [x] 11.4 Journal on Neon Postgres via Prisma ORM 7, with write queue, Prisma Migrate, sessions, and an in-memory fake; REST endpoints
    - Before coding, check the Prisma 7 docs: newest 7.x version on npm (by explicit version, never the `latest` tag, which points at a Prisma 8 prerelease), generated client entry file, `PrismaNeon`/`PrismaPg` constructor and pool option names, whether the Neon driver needs Bun's global `WebSocket`, and which Prisma error codes the driver adapters raise for Postgres data/constraint errors
    - Packages in `server/package.json` `dependencies`, all exact-pinned to the same 7.x version: `prisma`, `@prisma/client`, `@prisma/adapter-neon`, `@prisma/adapter-pg` (`prisma` is a runtime dependency because the Start_Script runs `prisma migrate deploy` in the image)
    - Scripts: server `"db:generate": "prisma generate"`; root `"db:generate": "bun run --cwd server db:generate"`; root `check:ts` becomes `bun run db:generate && bun run typecheck && bun test`; `server/tsconfig.json` includes `prisma.config.ts`; the generated client in `server/src/generated/` stays gitignored and is never hand-edited
    - `server/prisma.config.ts`: `defineConfig` with `schema: "prisma/schema.prisma"`, `migrations.path: "prisma/migrations"`, `datasource.url: process.env.DIRECT_URL ?? ""` (no throw, so `prisma generate` works without a database)
    - `server/prisma/schema.prisma`: generator `prisma-client` with `output = "../src/generated/prisma"`; datasource `postgresql` with no URL; models `orders`, `fills`, `rejections` with `seq BigInt @default(dbgenerated("nextval('journal_seq')"))`, `record_id String @unique @db.Uuid`, `session_id`, `ts BigInt`, and every Price, Qty, and Money field as `BigInt`; indexes on `(session_id, ts, seq)`
    - First Migration `server/prisma/migrations/<timestamp>_init/migration.sql` plus `migration_lock.toml`: create with `bunx prisma migrate dev --create-only --name init` against a development database (user approves the command) or write by hand, then edit so `CREATE SEQUENCE journal_seq;` comes before the `CREATE TABLE` statements; confirm with `prisma migrate diff` that the schema and the Migration agree
    - `journal/store.ts`: `JournalStore` interface (`insertBatch`, `listOrders({ session, limit })`, `listJournal({ session, limit })`, `ping`, `close`), record and row types, pure `mergeJournal()` that merges the per-table results into the most recent `limit` records sorted by `(ts, seq)`
    - `journal/adapter.ts`: pure `pickAdapter(databaseUrl, dbAdapter)`: `DB_ADAPTER=pg` → `"pg"`, host ending in `.neon.tech` → `"neon"`, otherwise `"pg"`
    - `journal/prisma.ts`: `createPrismaJournalStore(config)` builds `PrismaNeon` or `PrismaPg` (`max: 4`, 60 s idle timeout, 5 s connect timeout) and `new PrismaClient({ adapter, log })` with `warn`/`error` events only, each passed through `redactSecrets()`; `PrismaJournalStore.insertBatch` issues one `createMany({ data, skipDuplicates: true })` per run of same-kind records, in queue order, inside one batch `$transaction([...])`; `ping()` is a `$queryRaw` tagged template `SELECT 1`; no `$queryRawUnsafe`/`$executeRawUnsafe`
    - Pure `classifyPrismaError(err)` → `poison` (P2000, P2002, P2006, P2007, P2011, P2020, `PrismaClientValidationError`, adjusted to the codes found above) or `unreachable` (everything else)
    - `journal/memory.ts`: `MemoryJournalStore` with one `seq` counter, `record_id` dedupe, and a fault-injection hook (fail the next n calls, or commit and then throw); used when `DATABASE_URL` is unset outside production, with a warning
    - `journal/queue.ts`: bounded Journal_Queue (10,000, drop oldest, dropped count logged at most every 10 s), Journal_Writer (batches ≤ 500, retry with `backoff.ts`, probe with `ping()` only while down, poison records retried one at a time and dropped with a redacted log line), Journal_Status, `setMigrated()` gate that holds records until Migrations succeed, SIGTERM `flush(5_000)`
    - `journal/deploy.ts` and `server/scripts/start.ts` (Start_Script): validate config, run `prisma migrate deploy` with `Bun.spawn` and `DIRECT_URL` as the connection string, pass every output line through `redactSecrets()`; on success call `setMigrated(true)` and start the server; on failure log the redacted error, start the server with Journal_Status `down`, and retry the deploy in the background on `backoff.ts` delays
    - Router and fill handler call `journal.enqueue()` and never await the database
    - Session_Id from `crypto.randomUUID()` on each engine start (supervisor hook)
    - `/orders` and `/journal` with Zod-validated query params: `session` (`all` or omitted, 400 otherwise) and `limit` (integer 1–5000, default 500, 400 otherwise); 503 `journal_unavailable` while down or on a failed or slow (> 5 s) query; results are the most recent `limit` records sorted by `(ts, seq)`; BigInt fields as decimal strings
    - `/health` gains `db: "up" | "down"` from memory, with no database query
    - REST `/positions`, `/quote/:symbol`, `/candles/:symbol`
    - Accounts: every model has `account_id String`, and the indexes are `(account_id, session_id, ts, seq)` and `(account_id, ts, seq)`, all in the `init` Migration; records are stamped with the origin's account (Router) or the event's `account_id` (fills, engine rejections); `JournalStore.listOrders`/`listJournal` take `account`
    - `/positions`, `/orders`, `/journal` resolve the caller with `auth/bearer.ts` (from 18.6): no header → guest, valid Bearer → wallet account, bad/expired/denylisted token → 401 before query-param validation; results scoped to that account
    - _Requirements: 16.1, 16.4, 16.6, 17.5, 17.8, 20.1–20.31_
  - [x] 11.5 Journal tests and order-path integration test
    - P26 (fast-check, `numRuns: 100`) against `MemoryJournalStore` with fault injection and a small queue bound
    - P27 contract property against `MemoryJournalStore`, and against `PrismaJournalStore` (through `@prisma/adapter-pg`) inside `describe.skipIf(!process.env.TEST_DATABASE_URL)`; the Postgres suite expects the Migrations already applied with `prisma migrate deploy`; generated records span several accounts and sessions, and each listing is checked for account scoping
    - Bearer tests: `/positions`, `/orders`, `/journal` with no header (guest), a valid token (wallet), and invalid, expired, and denylisted tokens (401)
    - Postgres-only tests (same `skipIf`): i64 min/max round-trip for every BIGINT field; `skipDuplicates` dedupe on a retried batch; `seq` follows enqueue order across the three tables; tables cleared with a `$executeRaw` tagged template between cases; refuse to run if `TEST_DATABASE_URL` equals `DATABASE_URL` or `DIRECT_URL`
    - Unit tests: `pickAdapter` cases; `classifyPrismaError` cases; Start_Script with a failing then succeeding deploy (status `down`, records held, then `up`); deploy output redaction; `/health` never calls the store; `/orders` and `/journal` return 200, 400 (bad `session`, bad `limit`), and 503 as specified, and honour the default and maximum `limit`; redaction keeps `DATABASE_URL`, `DIRECT_URL`, and their passwords out of logs and responses
    - Integration: order → fill → journal record (memory store, and Postgres when `TEST_DATABASE_URL` is set); oversized order rejected with reason; orders still fill while the store is failing
    - _Requirements: 16.4, 17.8, 19.7, 20.1, 20.2, 20.3, 20.9, 20.12, 20.13, 20.14, 20.15, 20.16, 20.17, 20.21, 20.22, 20.23, 20.24, 20.25, 20.26, 20.28, 20.29, 20.30, 20.31, 41.7_
  - [x] 11.6 Property test P35 (router account derivation)
    - **Property 35: router account derivation** — generate Connection_Sessions and Client_Message JSON (some with extra `account_id`/`accountId` keys), parse with the Zod schemas, submit through the Router with a fake engine sender, and check every sent Command's `account_id` equals the session's
    - _Requirements: 18.5, 18.6_

- [x] 12. Command bar, order entry, and account panels
  - [x] 12.1 Command_Parser and Command_Formatter; previews with expiry; confirm/discard handling
    - `%` amounts resolve against the requester's account position; each preview stores the connection id and account id; the gateway's account-change hook (19.1) discards that connection's pending previews; a confirm whose preview account differs from the current session is rejected
    - _Requirements: 4.3, 4.4, 21.1–21.6, 22.4, 46.4_
  - [x] 12.2 Property tests P20, P21, P22 and parser unit tests
    - _Requirements: 21.7, 21.8, 21.9_
  - [x] 12.3 Web: CommandBar with history, PreviewDialog, ConfirmDialog, Buy/Sell buttons, B/S/F/X, Positions, OpenOrders (✕), PnL, rejection display
    - _Requirements: 22.1, 22.2, 22.3, 28.1, 28.2, 28.3, 30.2–30.6, 31.1–31.4_
  - [x] 12.4 TUI: the same panels and dialogs with keyboard and mouse; TestBackend tests
    - _Requirements: 22.1, 22.2, 22.3, 28.1, 28.2, 28.3, 30.2–30.6, 31.1–31.4_

- [x] 13. Plain-English orders (LLM)
  - [x] 13.1 `LLM_Provider` interface, OpenAI structured-output implementation with 15 s timeout, model name verified
    - _Requirements: 23.1, 23.5_
  - [x] 13.2 `LLM_Order_Parser`: Zod intent schema → formatter → parser → preview; disabled without key
    - _Requirements: 23.2, 23.3, 23.4, 23.6, 23.7_
  - [x] 13.3 Tests with a mock provider and prompt fixtures
    - _Requirements: 23.4, 23.5_

- [x] 14. MCP server
  - [x] 14.1 `server/src/mcp/main.ts` with the five tools, Zod argument validation, orders over the WS protocol
    - _Requirements: 24.1–24.7_
  - [x] 14.2 Register in `.kiro/settings/mcp.json`; tests against a mock server
    - _Requirements: 24.8_
  - [x] 14.3 `TERMINAL_TOKEN` support
    - Read `TERMINAL_TOKEN` from the environment with Zod (optional, never logged); when set, send `Authenticate` after each WS connect and `Authorization: Bearer` on REST calls; when unset, guest; a rejected token gives a tool error without the token value
    - Check whether Kiro's `mcp.json` `env` block can reference a variable from the user's environment; never write a token value into `.kiro/settings/mcp.json`
    - Tests against the mock server: Authenticate and Bearer sent with the token, nothing sent without it, captured logs and tool results never contain the token
    - _Requirements: 24.4, 24.9, 24.10, 24.11_

- [x] 15. Release binaries and Render deploy
  - [x] 15.1 `Dockerfile` (rust:1.94-bookworm → oven/bun:1.4.4-debian, non-root)
    - Runtime stage installs production server dependencies, which include the pinned `prisma` CLI
    - Copies `server/` with `prisma.config.ts`, `prisma/schema.prisma`, `prisma/migrations/`, and `scripts/start.ts`; runs `bun run db:generate` during the build, before switching to the non-root user
    - Checks that the Prisma CLI's migration engine runs on the Debian runtime image (for example, that OpenSSL is present)
    - Sets `ENV NODE_ENV=production`; `CMD` runs the Start_Script (`bun server/scripts/start.ts`), which applies Migrations with `prisma migrate deploy` before starting the server
    - _Requirements: 16.5, 20.15, 39.1, 39.2, 39.3_
  - [x] 15.2 `render.yaml` as agreed
    - `oni-server`: no `JOURNAL_PATH`; `DATABASE_URL` (Neon pooled URL) and `DIRECT_URL` (Neon direct URL, used only by Prisma Migrate) both with `sync: false`, values set only in the Render dashboard; `DB_ADAPTER` left unset so the Neon adapter is chosen from the host; no `preDeployCommand` (migrations run in the Start_Script); `buildFilter` includes `server/prisma/**`
    - `SESSION_SECRET` with `generateValue: true` (design Decision A12); `LIVE_VENUE: backpack`; `DATA_MODE: replay`; `WEB_URL` set to the static site URL, which is also listed in `ALLOWED_ORIGINS`
    - _Requirements: 16.1, 16.7, 16.9, 20.16, 38.1, 38.2, 38.4, 38.5_
  - [x] 15.3 CI: Docker smoke test, Postgres journal job, and render.yaml schema validation
    - New `journal-pg` job on `ubuntu-latest` with a `postgres:17` service container (health check `pg_isready`): `bun install`, `bun run db:generate`, then `bunx prisma migrate deploy` in `server/` with `DIRECT_URL=postgres://postgres:postgres@localhost:5432/postgres`, then the journal contract tests with `TEST_DATABASE_URL` set to the same URL and `DB_ADAPTER=pg` (`bun test server`)
    - `docker-smoke` job gets the same `postgres:17` service; run the image with `--network host` and that URL as both `DATABASE_URL` and `DIRECT_URL`; `smoke.ts` waits for `/health` `db: "up"` (Migrations applied by the Start_Script), places an order, receives a Fill, and polls `/journal` for the order and fill rows
    - These throwaway container URLs are not secrets
    - _Requirements: 38.3, 41.3, 41.4, 41.5, 41.6_
  - [x] 15.4 `release.yml`: Windows MSVC zip, macOS universal tar.gz via lipo, SHA-256, smoke checks
    - _Requirements: 40.1, 40.2, 40.3_
  - [x] 15.5 README: Render setup, free-plan limits (sleeps after 15 min idle, about 1 min to wake; the journal persists in Neon while the paper account resets), downloads, Gatekeeper/SmartScreen, build from source
    - _Requirements: 40.4, 42.6_
  - [x] 15.6 README: Neon setup
    - Create a Neon Free project; copy the pooled connection string (`-pooler` host) as `DATABASE_URL` and the direct connection string as `DIRECT_URL`, keeping `sslmode=require` in both; paste both into a local `.env` and into the Render dashboard; never commit either
    - Explain that the Start_Script applies Migrations with `prisma migrate deploy` over `DIRECT_URL` at container start, and that `bunx prisma migrate dev` is for creating new Migrations on a development database only
    - Optional: a Neon dev branch's direct URL as `TEST_DATABASE_URL` for local Postgres tests (apply the Migrations to that branch first)
    - Neon free-plan notes: scale to zero after 5 min idle, first query wakes it in a few hundred ms
    - _Requirements: 42.6, 42.8_
  - [ ] 15.7 README: accounts, wallet sign-in, pairing, venues
    - Guest mode (shared account, no wallet needed) vs. wallet accounts; every account resets on engine restart
    - Sign in with Phantom or Backpack: the wallet signs one SIWS message and never a transaction; tokens last 24 h; sign-out is best effort because the denylist is lost on a server restart
    - TUI pairing: press `P`, open the URL, sign in, confirm the code; token file location per OS; `--guest` and `--logout`
    - MCP: `TERMINAL_TOKEN` for a wallet account, guest otherwise; never commit it
    - Live data: `DATA_MODE=live` with `LIVE_VENUE=backpack` (default, USDC treated as USD) or `coinbase`; replay stays the default; `engine record --venue`
    - Local `.env`: `SESSION_SECRET` (32+ bytes), `WEB_URL`
    - _Requirements: 42.9_

- [ ] 16. Polish and submission
  - [ ] 16.1 CRT polish in both clients
  - [ ] 16.2 Kiro write-up (specs, steering, hooks, PBT in Rust and TS, MCP) and final README
    - _Requirements: 42.7_
  - [ ] 16.3 Demo video under 3 minutes; Devpost submission drafted by Dec 3
    - _Requirements: 42.7_

- [x] 17. Protocol v2: accounts, Authenticate, Session, venue (scheduled right after 4.6, alongside 5.1–5.3 and 6.1–6.3, before Tasks 10 and 19)
  - [x] 17.1 Protocol crate changes and regenerated TS types
    - `AccountId` newtype (1..=64 chars of `[A-Za-z0-9_]`, serde as a string, ts-rs `string`); `Venue` enum (`coinbase`, `backpack`)
    - `account_id` on `PlaceOrder`, `Cancel`, `CancelAll`, `ResetAccount` (the last two become struct variants) and on `OrderAck`, `OrderRejected`, `Fill`, `Position`
    - `ClientMessage::Authenticate { token }`; `ServerMessage::Session { account_id, address: Option<String> }`; `Hello.venue: Option<Venue>`; `NoticeKind` gains `auth_failed`, `session_expired`, `signed_out`; `protocol_version` → 2
    - `decode_command` rejects a bad `AccountId` with an `Error` event; update the engine's existing command handling so it still compiles and passes (accounts are used for real in Task 10)
    - Regenerate `shared/protocol/` with `bun run gen:protocol` (user approves the command); never hand-edit the generated files
    - _Requirements: 1.3, 1.7, 1.8, 1.9, 1.10, 1.11, 2.5_
  - [x] 17.2 Server schemas and call sites
    - `server/src/protocol.ts` Zod schemas for every changed Command, Event, Client_Message, and Server_Message, plus `AccountIdSchema`; existing gateway, supervisor, and tests compile against the new shapes, with every connection treated as `guest` until Task 19
    - Gateway sends `Session { account_id: "guest", address: null }` after `Hello`, and `Hello.venue` is `null` until Task 7.2
    - _Requirements: 1.7, 1.8, 17.3, 46.1_
  - [x] 17.3 Tests for the new shapes
    - Extend the P1 and P2 proptest strategies with `AccountId` (valid and invalid), `Authenticate`, `Session`, `Venue`, and the new notice kinds; regression file kept
    - TS: schema unit tests for each new or changed message, including the wire shape `{"type":"cancel_all","account_id":"guest"}`; the server-side protocol property test covers the new variants
    - _Requirements: 1.10, 2.3, 2.4, 2.5_

- [x] 18. Server Auth_Service: SIWS, sessions, pairing, rate limits
  - [x] 18.1 Config: `SESSION_SECRET`, `LIVE_VENUE`, `WEB_URL`
    - Zod: `SESSION_SECRET` at least 32 bytes, required when `NODE_ENV=production` (name logged, exit 1), random per-process secret with a warning otherwise; `LIVE_VENUE` `coinbase | backpack`, default `backpack`; `WEB_URL` defaults to the first `ALLOWED_ORIGINS` entry and must be listed there (exit 1 otherwise)
    - `SESSION_SECRET` joins the redacted set in `toJSON`, `inspect`, and `redactSecrets()`; `.env.example` gets empty placeholders; config tests for each rule
    - _Requirements: 16.1, 16.2, 16.4, 16.7, 16.8, 16.9_
  - [x] 18.2 SIWS and Ed25519
    - `shared/siws.ts`: `parseSiws`, `formatSiws` (dependency-free, also used by the web UI); `server/src/auth/siws.ts`: re-export plus pure `checkSiws(fields, ctx)` with the checks in design "Auth_Service"; the fixed Sign_In_Statement constant
    - `auth/ed25519.ts`: `verifyEd25519` on WebCrypto, proven on Bun 1.4.4 with RFC 8032 TEST 1–3; if Bun rejects Ed25519, switch to exact-pinned `@noble/curves` behind the same signature and record the choice in a code comment (design Decision A11); base58 through exact-pinned `@scure/base` (user approves each `bun add --exact`)
    - Length checks: public key 32 bytes, signature 64 bytes
    - _Requirements: 45.4, 45.5, 45.8, 45.9, 49.3_
  - [x] 18.3 Property tests P30 and P31, plus SIWS examples
    - **Property 30: SIWS round-trip**; **Property 31: SIWS tamper and nonce consumption** (keys generated in the test; `fetch` stubbed to throw so no RPC is possible)
    - Example messages in the shapes Phantom and Backpack produce through `solana:signIn` (with and without optional fields), and malformed texts that must fail to parse
    - _Requirements: 45.4, 45.5, 45.6, 45.8, 45.9, 45.10, 45.11, 49.3_
  - [x] 18.4 Token, nonce, pairing, and rate-limit stores
    - `auth/token.ts`: `v1.<payload>.<mac>` HMAC-SHA256 tokens (24 h, jti), constant-time verify before parsing, Token_Denylist `Map<jti, exp>` with pruning
    - `auth/nonces.ts`: 16-byte base58 nonces, bound to address and origin, 5 min expiry, single use
    - `auth/pairing.ts`: 8-character codes from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` by rejection sampling, SHA-256 verifier compared in constant time, confirm binds an address, poll returns pending / token once / not found, 5 min expiry, 1,000-entry cap
    - `auth/ratelimit.ts`: fixed-window per `(route, ip)` with the limits in the design; `auth/clientip.ts`
    - All take an injectable clock
    - _Requirements: 45.1, 45.6, 45.12, 45.14, 45.15, 48.2, 48.6, 48.7, 48.8, 48.9_
  - [x] 18.5 Property tests P29 and P32, plus store unit tests
    - **Property 29: Session_Token accepted iff issued by this secret, unmodified, unexpired, not denylisted**; **Property 32: pairing issues a token at most once, only with the secret, only after confirm, only before expiry**
    - Unit tests: nonce expiry and reuse, code alphabet and length, rate-limit window rollover
    - _Requirements: 45.13, 45.14, 45.15, 48.10_
  - [x] 18.6 Auth routes and Bearer helper
    - `auth/routes.ts`: `/auth/nonce`, `/auth/verify`, `/auth/logout`, `/auth/pair`, `/auth/pair/confirm`, `/auth/pair/poll` with Zod bodies, Origin check (403) on nonce and verify, status codes per the design table, `Retry-After` on 429; mounted in `http.ts` with Hono `cors` restricted to `ALLOWED_ORIGINS`
    - `auth/bearer.ts`: `Authorization` header → `AccountId` or 401, for 11.4 and the auth routes
    - Request logging drops the `Authorization` header and `/auth/*` bodies; route logs carry only outcome, account id, and jti
    - A logout hook that the gateway subscribes to in 19.1
    - Confirm how Render's proxy sets `X-Forwarded-For` and adjust `clientip.ts` if needed
    - _Requirements: 16.4, 20.28, 20.29, 45.1, 45.2, 45.3, 45.5, 45.7, 45.14, 45.15, 48.2, 48.4, 48.6, 48.8, 48.9_
  - [x] 18.7 Route tests
    - Full sign-in with a generated keypair against the real routes and a fake clock; each 400/401/403/404/429 case; logout then verify fails; pair → confirm → poll → token, second poll 404, wrong secret 404; captured logs contain no token, secret, Pairing_Secret, or `SESSION_SECRET`
    - _Requirements: 16.4, 45.2, 45.3, 45.5, 45.7, 45.14, 45.15, 48.6, 48.8, 48.9_

- [x] 19. Gateway authentication and per-account topics
  - [x] 19.1 Connection_Session and account routing
    - `ws.data` session `{ accountId, address, jti, exp }`; on open subscribe `account:guest` and `notices`, send `Hello` then `Session`
    - `Authenticate` → verify via the Auth_Service; accepted: switch topics to `account:w_<address>`, index `jti → connections`, send `Session`; rejected: guest, `Session`, `Notice auth_failed`; an account-change hook that previews (12.1) and the Router (11.2) use
    - Replace the global `account` topic from Task 3.5: OrderAck, Fill, Position publish to `account:<account_id>`; Notice to `notices`; engine `OrderRejected` to the requester, else `account:<account_id>`; pure `routeAccountEvent`
    - Logout hook from 18.6: every connection on the jti → guest with `Session` and `Notice signed_out`; a downgrade function the Router calls on `session_expired`
    - _Requirements: 17.7, 17.9, 17.10, 46.1, 46.2, 46.3, 46.4, 46.5, 46.6_
  - [x] 19.2 Property test P34 and gateway tests
    - **Property 34: account event routing** — sessions with switches between events, checked through `routeAccountEvent` and the FakeSocket publisher
    - Examples with FakeSocket: `Session` after `Hello`; valid, invalid, and expired tokens; logout downgrades two tabs on the same jti; notices reach guest and wallet connections
    - _Requirements: 17.7, 17.9, 17.10, 17.11, 46.1, 46.2, 46.3, 46.6_

- [x] 20. Web wallet sign-in and the /pair page
  - [x] 20.1 Wallet discovery and sign-in flow
    - Exact-pin `@wallet-standard/app`, `@wallet-standard/features`, and `@solana/wallet-standard-features` at the newest release of each, chosen by explicit version (design Decision A14; user approves each `bun add --exact`)
    - `lib/wallets.ts` (Phantom and Backpack with `standard:connect` and `solana:signIn` or `solana:signMessage`, live register/unregister); `lib/auth.ts` (nonce → `solana:signIn`, or `formatSiws` + `solana:signMessage` → verify → store `{ token, address, exp }` in `localStorage`, delete when expired)
    - `useTerminalSocket` sends `Authenticate` after `Hello` on every (re)connect when a token is stored; the store applies `Session` and the auth notices, deleting the stored token on `auth_failed`, `session_expired`, or `signed_out`
    - _Requirements: 33.4, 47.1, 47.2, 47.3, 47.6, 49.1, 49.2_
  - [x] 20.2 `WalletMenu` UI
    - "Sign in with Phantom" / "Sign in with Backpack" buttons per detected wallet; shortened address `AbCd…WxYz` and "Sign out" (logout, delete token, `standard:disconnect`); "No Phantom or Backpack wallet found. Trading as guest."; `GUEST` label on the account panels; "Sign-in cancelled" when the wallet rejects
    - _Requirements: 47.4, 47.5, 47.7, 47.8_
  - [x] 20.3 `/pair` page
    - `app/pair/page.tsx` client component with `useSearchParams` inside `Suspense` (static export); shows the code, the warning "Only confirm a code shown in your own terminal", sign-in if needed, and a Confirm button that calls `/auth/pair/confirm`; nothing is sent before the click
    - _Requirements: 48.4, 48.5_
  - [x] 20.4 Web auth tests
    - Fake Wallet Standard wallet that records the features called: sign-in with `signIn`, fallback with `signMessage`, rejection; only the four allowed features are ever called
    - Grep test: no file under `web/` names `signTransaction`, `signAndSendTransaction`, or `signAndSendAllTransactions`
    - Reducer tests for `Session` and the auth notices; address shortening; `/pair` sends nothing until Confirm
    - _Requirements: 47.2, 47.3, 47.4, 47.6, 47.7, 48.5, 49.1, 49.2_

- [x] 21. TUI pairing and token storage
  - [x] 21.1 Token_Store and flags
    - `auth.rs`: `dirs::config_dir()/haunted-terminal/session.json` `{ server, token, address, exp }`, atomic write, mode `0600` on Unix; token used only for its own server
    - clap `--guest` (skip the token, leave the file) and `--logout` (POST `/auth/logout`, delete the file, exit 0 before entering the full-screen UI)
    - `net.rs` sends `Authenticate` after each connect when an unexpired token is loaded; `App` applies `Session` and the auth notices
    - HTTP client: `reqwest` with default features off and rustls/ring (confirm feature names for the pinned version; user approves the dependency change)
    - _Requirements: 33.4, 48.11, 48.12, 48.13, 48.14_
  - [x] 21.2 Pairing dialog
    - `P` (`auth.pair`, added to `shared/keymap.json` global context and to the TS loader's TUI-only list) opens the dialog: Pairing_Secret from `getrandom`, POST `/auth/pair` with the verifier, show `XXXX-XXXX` and the pair URL, poll every `interval` s; `ok` → save token, `Authenticate`, close; 404 or expiry → "Pairing expired, press P to retry"; Esc cancels
    - Status bar shows `GUEST` or the shortened address
    - _Requirements: 32.1, 32.4, 47.8, 48.1, 48.3, 48.11_
  - [x] 21.3 TUI auth tests
    - Token_Store round-trip in a temp dir, `0600` on Unix; `--guest` leaves the file; `--logout` against a mock server deletes it
    - Pairing state machine against a mock HTTP server (pending → ok, 404, expiry); TestBackend snapshot of the pairing dialog; keymap P24 still passes with `P` added
    - _Requirements: 32.4, 48.1, 48.3, 48.11, 48.12, 48.13, 48.14_

## Notes

- Standing rule: every shell or terminal command (cargo, bun, rustup, docker, npm, etc.) needs the user's prior approval. State the exact command, the working directory, and the reason, then wait for approval.
- The user handles git. Never run git commands.
- Property-based tests map to the P1–P35 property table in `design.md` (proptest in Rust, fast-check in TS). P28–P35 and the account extensions of P18 and P27 come from the scope change.
- Auth and venue tests never contact Backpack, Coinbase, a Solana RPC, or a real wallet. They use captured samples, mock WS/HTTP servers, generated keypairs, and a fake Wallet Standard wallet.
- Journal tests use `MemoryJournalStore` by default. Postgres tests run only when `TEST_DATABASE_URL` is set, so `bun run check` needs no database. Never commit `DATABASE_URL`, `DIRECT_URL`, or a Neon `TEST_DATABASE_URL`.
- Task dependencies:
  - 1.4 (Kiro hooks) blocks nothing; it is waiting on a user decision. It sits in the wave just before task 16 so that no other task waits on it.
  - Task 2 depends only on 1.1 and 1.2.
  - Sub-tasks inside a parent run in order.
  - 3 depends on 2. 4 on 2, 3. 5 on 3, 4. 6 on 2, 4. 7, 8, and 9 each on 4, 5, 6. 10 on 8. 11 on 3, 10. 12 on 5, 6, 11. 13 on 12. 14 on 12. 15 on 11, 12. 16 on all other tasks.
  - Scope change: 17 depends on 4 (it starts after 4.6, so 4.4–4.6 are not blocked) and runs in the same waves as 5.1–5.3 and 6.1–6.3, which then build against protocol v2. 18 depends on 17 (18.1 also feeds `LIVE_VENUE` to 7.2). 7.2 depends on 17.1 and 18.1. 19 depends on 17 and 18. 10 depends on 8 and 17. 11 depends on 10 and 19. 20 depends on 5, 18, 19. 21 depends on 6, 18, 19. 12 depends on 19, 20, 21 as well (it is placed after them). 14.3 depends on 19. 15.2 and 15.7 depend on 18.
  - Same-file conflicts kept apart by wave: `server/src/config.ts` (18.1 only), `server/src/gateway/ws.ts` (17.2, 7.2, 19.1 in different waves), `server/src/http.ts` (18.6, 11.4), web store and socket (5.3, 7.8, 20.1), `shared/keymap.json` (5.2, 21.2), README (15.5, 15.6, 15.7).
- Completed sub-tasks (1.1, 1.2, 1.3, 1.5, 1.6) are not listed in the dependency graph. Completed sub-tasks 2.1–4.3 keep their original waves.
- Task 7 was renumbered for the scope change before any of its sub-tasks started: old 7.1 (verify) → 7.1, old 7.2 (Coinbase adapter) → 7.4, old 7.3 (recorder) → 7.7, old 7.4 (Coinbase tests) → 7.6, old 7.5 (watchlist) → 7.8. New: 7.2, 7.3, 7.5.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["2.1"] },
    { "id": 1, "tasks": ["2.2"] },
    { "id": 2, "tasks": ["2.3"] },
    { "id": 3, "tasks": ["2.4"] },
    { "id": 4, "tasks": ["2.5"] },
    { "id": 5, "tasks": ["2.6"] },
    { "id": 6, "tasks": ["3.1"] },
    { "id": 7, "tasks": ["3.2"] },
    { "id": 8, "tasks": ["3.3"] },
    { "id": 9, "tasks": ["3.4"] },
    { "id": 10, "tasks": ["3.5"] },
    { "id": 11, "tasks": ["3.6"] },
    { "id": 12, "tasks": ["4.1"] },
    { "id": 13, "tasks": ["4.2"] },
    { "id": 14, "tasks": ["4.3"] },
    { "id": 15, "tasks": ["4.4"] },
    { "id": 16, "tasks": ["4.5"] },
    { "id": 17, "tasks": ["4.6"] },
    { "id": 18, "tasks": ["5.1", "6.1", "17.1"] },
    { "id": 19, "tasks": ["5.2", "6.2", "17.2"] },
    { "id": 20, "tasks": ["5.3", "6.3", "17.3", "18.1"] },
    { "id": 21, "tasks": ["5.4", "6.4", "18.2"] },
    { "id": 22, "tasks": ["6.5", "18.3"] },
    { "id": 23, "tasks": ["6.6", "18.4"] },
    { "id": 24, "tasks": ["7.1", "8.1", "18.5"] },
    { "id": 25, "tasks": ["7.2", "8.2", "9.1"] },
    { "id": 26, "tasks": ["7.3", "8.3", "9.2", "18.6"] },
    { "id": 27, "tasks": ["7.4", "9.3", "10.1", "18.7"] },
    { "id": 28, "tasks": ["7.5", "10.2", "19.1"] },
    { "id": 29, "tasks": ["7.6", "10.3", "19.2"] },
    { "id": 30, "tasks": ["7.7", "10.4"] },
    { "id": 31, "tasks": ["7.8", "11.1"] },
    { "id": 32, "tasks": ["11.2", "20.1"] },
    { "id": 33, "tasks": ["11.3", "20.2"] },
    { "id": 34, "tasks": ["11.4", "20.3", "21.1"] },
    { "id": 35, "tasks": ["11.5", "20.4", "21.2"] },
    { "id": 36, "tasks": ["11.6", "21.3"] },
    { "id": 37, "tasks": ["12.1"] },
    { "id": 38, "tasks": ["12.2"] },
    { "id": 39, "tasks": ["12.3"] },
    { "id": 40, "tasks": ["12.4"] },
    { "id": 41, "tasks": ["13.1", "14.1", "15.1"] },
    { "id": 42, "tasks": ["13.2", "14.2", "15.2"] },
    { "id": 43, "tasks": ["13.3", "14.3", "15.3"] },
    { "id": 44, "tasks": ["15.4"] },
    { "id": 45, "tasks": ["15.5"] },
    { "id": 46, "tasks": ["15.6"] },
    { "id": 47, "tasks": ["1.4", "15.7"] },
    { "id": 48, "tasks": ["16.1"] },
    { "id": 49, "tasks": ["16.2"] },
    { "id": 50, "tasks": ["16.3"] }
  ]
}
```
