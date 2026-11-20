# Implementation Plan: Oni Terminal v2

## Overview

This plan extends the finished Haunted Terminal (`.kiro/specs/haunted-terminal/`) and `chart-and-tape-fix` code. It runs in the order below, and each step leaves the repo compiling.

1. Remove the database (in-memory Activity_Log).
2. Protocol changes plus `gen:protocol`.
3. Symbol registry (ten symbols, per-symbol tick and lot), 4h timeframe, 24h stats.
4. Paper balance plus `insufficient_balance`.
5. Multi-venue engine adapters (Jupiter, Raydium, simulated DEX book, staleness, divergence) and the read-only allowlist guard.
6. TWAP in the Router.
7. LLM provider abstraction and the four providers.
8. AI analyst and rate and cost limits.
9. News.
10. Latency (batching, coalescing, bench script).
11. Web shell and pages.
12. TUI panels.
13. Deploy, CI, docs.
14. Final checkpoint.

## Notes

- Commands (`bun run gen:protocol`, `bun run check`, `bun run --cwd web build`, `cargo build -p engine`, `cargo test`, `bun test`) need the user's approval each time (tech.md standing rule). State the exact command, directory, and reason, then wait. The user prefers to finish the code first and test at the end, so run verification only in the checkpoint tasks.
- Property numbers refer to the 51 properties in `design.md`. Requirement numbers refer to `requirements.md` (for example `16.5` is Requirement 16, criterion 5).
- Tasks marked `*` are optional. Each property test is its own sub-task.
- No test contacts a real exchange, news host, LLM host, Jupiter, Raydium, a Solana RPC, or a wallet. Use mock HTTP servers and recorded fixtures.
- Never write an API key value into code, tests, fixtures, docs, or logs. Use env var names and obviously fake placeholders (for example `test-key-not-real`) only in tests.
- Never hand-edit `shared/protocol/*.ts` (generated). Rust code: no `unwrap()` or `expect()` outside tests, no `unsafe`, no wall-clock reads in the engine core (rust.md).
- Every order source goes through `server/src/router.ts` and the Risk_Engine. No new module sends `PlaceOrder`, `Cancel`, `CancelAll`, or `ResetAccount` (trading-safety rule 2).

## Tasks

- [ ] 1. Remove the database
  - [ ] 1.1 Add the in-memory Activity_Log
    - Create `server/src/activity/log.ts`: bounded per-account store (1,000 records per account, 1,000 accounts, injectable bounds), append-order listing with a limit of 1 to 1,000, drop of a whole account when the account bound is exceeded
    - Create `server/src/activity/routes.ts` for `/orders`, `/journal`, and `/positions` scoped to the caller's account (Bearer token or `guest`)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.16, 2.18, 2.19_

  - [ ] 1.2 Rewire the server to the Activity_Log
    - Replace every Journal and Journal_Queue use in `router.ts`, the gateway, and the REST routes with Activity_Log appends
    - Remove the `db` field and Journal_Status from `/health`; report Engine state, each Live_Venue status, and latency p50 and p95 (filled in by task 10.2)
    - Remove Migration retry logic and `503` journal responses
    - _Requirements: 1.1, 1.2, 1.9, 2.6, 2.7_

  - [ ] 1.3 Delete Prisma and journal code
    - Delete `server/src/journal/`, `server/src/generated/`, `server/prisma/`, `server/prisma.config.ts`, and migration files
    - Remove Prisma and driver-adapter dependencies from `server/package.json` and the root `package.json` (exact versions stay pinned, commit the lockfile change when the user runs install)
    - Remove `DATABASE_URL`, `DIRECT_URL`, and `DB_ADAPTER` from `server/src/config.ts` and its Zod schema; make `server/scripts/start.ts` validate config and start the Server only
    - Drop `prisma generate` from the `check` script
    - _Requirements: 1.3, 1.4, 1.5, 1.8_

  - [ ] 1.4 Remove database parts from CI, deploy, and docs
    - Remove the Postgres CI job from `.github/workflows/ci.yml`
    - Remove database env vars and any database service from `render.yaml`
    - Remove database lines from `server/.env.example`, the Dockerfile, and `README.md`; state "orders, fills, and rejections live in memory for the current engine run only"
    - _Requirements: 1.6, 1.7, 36.1, 36.2, 36.7_

  - [ ]* 1.5 Write property test for Activity listing
    - **Property 1: Activity listing is scoped and ordered**
    - Use fast-check in `server/src/activity/log.test.ts`
    - **Validates: Requirements 2.16, 2.18**

  - [ ]* 1.6 Write property test for Activity_Log bounds
    - **Property 2: Activity_Log bounds**
    - **Validates: Requirements 2.4, 2.5, 2.19**

- [ ] 2. Protocol changes (protocol v3)
  - [ ] 2.1 Add core types, commands, and events to the protocol crate
    - In `rust/crates/protocol/src/`: `Venue` (coinbase, backpack, jupiter, raydium, replay) with `kind()`, `Timeframe::H4`, `Ticker`, `VenueStatusKind`, `PairHealth`, `WireEvent` (flatten plus `emit_us`), and the other types in the design's Types table
    - Add `venue` to `Subscribe`, `Unsubscribe`, `PlaceOrder`, `Candle`, `Trade`, `Book`, `Indicators`, `OrderAck`, `OrderRejected`, and `Fill`; add `synthetic` to `Book` and `Trade`
    - Add commands `SubscribeTicker` and `UnsubscribeTicker`; events `Ticker24h`, `VenueStatus`, `PairStatus`, `ReferenceVenue`, and `Balance`
    - Update existing engine and server call sites only enough to compile (default venue `replay` or the configured venue); update `strategies.rs` generators
    - _Requirements: 15.1, 15.2, 9.1, 9.8, 16.4, 18.1, 33.2_

  - [ ] 2.2 Add client and server messages
    - `ClientMessage`: `venue` on `Subscribe`, `Unsubscribe`, `CommandText`; add `SubscribeTicker`, `UnsubscribeTicker`, `CancelTwap`, `SetProvider`, `AiRequest`, `AiCancel`, `SubscribeNews`, `UnsubscribeNews`
    - `ServerMessage`: extend `Hello`; add `EventBatch`, `Providers`, `Analysis`, `ScanResult`, `StrategyDraft`, `AiError`, `News`, `Twap`; extend `PreviewAction` with `venue` and `Twap`; extend `NoticeKind`
    - Providers messages carry no key, base URL, or credential
    - _Requirements: 3.9, 4.1, 4.2, 5.9, 7.5, 7.6, 17.7, 17.9, 19.10, 34.1_

  - [ ] 2.3 Export the Instrument_Table and regenerate types
    - Add a protocol-crate test that writes `shared/protocol/instruments.json`
    - Make sure every new type has `#[ts(export, export_to = crate::TS_EXPORT_DIR)]` and update the `index.ts` re-export line
    - Verification (`bun run gen:protocol`) runs in checkpoint 4
    - _Requirements: 8.1, 15.1_

  - [ ] 2.4 Mirror the protocol in the server
    - Update `server/src/protocol.ts` Zod mirrors, each declared `satisfies z.ZodType<Generated>`
    - Make `server/src/instruments.ts` a thin loader of `shared/protocol/instruments.json`
    - Update gateway message validation for the new messages (stubs return a typed `not implemented yet` Notice for AI, news, and TWAP until their tasks)
    - _Requirements: 15.1, 34.1_

  - [ ]* 2.5 Write property test for new message round trips
    - **Property 50: New messages round trip**
    - proptest in `protocol/src/properties.rs` for Rust; fast-check Zod parse of JSON samples for the mirrors; reject invalid venue, provider id, and account id
    - **Validates: Requirements 15.1, 33.2, 34.10**

- [ ] 3. Symbol registry, 4h timeframe, and 24h stats
  - [ ] 3.1 Ten-symbol Instrument_Table
    - In `protocol/src/instrument.rs` add BNB, XRP, DOGE, JUP, WIF, BONK, PEPE with the decimals from the design table; keep BTC, ETH, SOL decimals unchanged
    - Add a table test: tick at most 0.02% of `reference_price`, lot no coarser than the finest listing-venue increment, `price_decimals + qty_decimals <= 10`
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.6, 8.7_

  - [ ] 3.2 Venue_Symbol_Map for ten symbols
    - In `engine/src/feed/venue.rs`: Backpack symbol, Coinbase product (or none), Jupiter and Raydium mint (or none) per symbol, from the committed table only; PEPE and BNB, XRP, DOGE have no DEX mint
    - Add a test that each committed mint string equals the table in `design.md`
    - Mints never come from the Server, a client, LLM output, or news
    - _Requirements: 8.5, 8.8, 14.2_

  - [ ] 3.3 4h candles
    - In `engine/src/candles.rs` aggregate 4h from 1h, aligned to 00, 04, 08, 12, 16, and 20 UTC; keep a 500-bar ring
    - _Requirements: 18.1, 18.2_

  - [ ] 3.4 Ticker24h
    - Create `engine/src/ticker.rs` (pure): 24-bar window over the 1h series, `partial` flag, `change_bps`; wire `SubscribeTicker` and the 1 s emission into `core.rs`
    - _Requirements: 18.3, 18.4, 18.7_

  - [ ] 3.5 Consume ten symbols in the server, web, and TUI
    - Update `server/src/parser` symbol resolution, risk limits tables, MCP tool symbol lists, web symbol lists, and TUI symbol lists to read the generated instrument list
    - Add `4h` to Timeframe selectors, the shared keymap Timeframe keys, and the replay and live backfill paths (build 4h from 1h)
    - _Requirements: 8.1, 8.8, 18.1, 18.5, 18.8_

  - [ ] 3.6 Regenerate the demo fixture for ten symbols
    - Update `engine/src/feed/synth.rs` and regenerate `fixtures/demo.jsonl` so replay shows all ten symbols with plausible reference prices (design table)
    - _Requirements: 8.9_

  - [ ]* 3.7 Write property test for tick and lot round trip
    - **Property 13: Tick and lot round trip**
    - **Validates: Requirements 8.3, 8.8**

  - [ ]* 3.8 Write property test for 4h aggregation
    - **Property 35: 4h candles equal aggregated 1h candles**
    - **Validates: Requirements 18.2, 18.6**

  - [ ]* 3.9 Write property test for Ticker24h
    - **Property 36: Ticker24h matches the window**
    - **Validates: Requirements 18.3, 18.4, 18.7**

- [ ] 4. Checkpoint - protocol and registry compile and pass
  - Ask the user to approve and run, in order: `bun run gen:protocol` (repo root), `cargo build -p engine` (rust/), then `bun run check` (repo root). Fix failures, then ask the user if questions arise.

- [ ] 5. Paper balance and `insufficient_balance`
  - [ ] 5.1 Engine balance model
    - Create `engine/src/balance.rs` (pure): `required_funds`, `free_balance = paper_balance - 2 * short_basis - reserved`, `equity`
    - Extend `account.rs` with `paper_balance`, short basis, and reserved funds; add `--starting-balance` and `--balance-slippage-bps` to `main.rs`
    - _Requirements: 16.1, 16.2, 16.3, 16.5, 16.7, 16.10_

  - [ ] 5.2 Engine rejection and Balance events
    - Reject in the matcher path with `insufficient_balance` when `free_balance - required_funds < 0`, before any state change; allow closing sells that fit the fee
    - Emit `Balance` events on fill, reset, and when Equity moves at least 0.01 USD; `ResetAccount` restores the starting balance
    - Position unrealized P&L uses the Mark_Price (reference pair)
    - _Requirements: 16.4, 16.6, 16.9, 16.11, 16.13_

  - [ ] 5.3 Server balance math and golden vectors
    - Add a Rust test that writes `shared/balance-vectors.json`
    - Create `server/src/risk/balance.ts` with `requiredFunds`, `freeBalance`, `equity` using BigInt only
    - _Requirements: 16.5, 16.7, 16.10_

  - [ ] 5.4 Risk_Engine balance check
    - In `server/src/risk/` add the balance check after the HT checks; reject with `insufficient_balance`; keep the cached Balance per account from engine events; add `starting_balance` to Hello
    - Clients show Free_Balance from `Balance` events (used by the ticket in task 11.6)
    - _Requirements: 16.5, 16.8, 16.12_

  - [ ]* 5.5 Write property test for insufficient balance
    - **Property 26: Insufficient balance is rejected exactly when funds are short**
    - proptest (Rust) and fast-check (TS) over the same state generator
    - **Validates: Requirements 16.5, 16.6, 16.7, 16.9**

  - [ ]* 5.6 Write property test for the equity identity
    - **Property 27: Equity identity**
    - **Validates: Requirements 16.10**

  - [ ]* 5.7 Write property test for the balance round trip
    - **Property 28: Balance round trip**
    - **Validates: Requirements 16.3, 16.11**

  - [ ]* 5.8 Write property test for approved orders
    - **Property 29: Approved orders keep Free_Balance non-negative**
    - **Validates: Requirements 16.12**

  - [ ]* 5.9 Write property test for closing a long
    - **Property 30: A long position can always be closed**
    - **Validates: Requirements 16.13**

  - [ ]* 5.10 Write property test for TS and Rust agreement
    - **Property 31: TypeScript and Rust balance math agree**
    - Reads `shared/balance-vectors.json` in `bun test`
    - **Validates: Requirements 16.5, 16.7, 16.10**

- [ ] 6. Multi-venue engine adapters and the read-only guard
  - [ ] 6.1 Per-(venue, symbol) state in the core
    - Create `engine/src/pair.rs` (`PairState`: book, last price and time, candles, health, subscriptions); key the core by `(Venue, symbol)`
    - Add `MarketMsg` variants `PriceSample`, `Status`, `Clock`; every market variant carries a venue
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.8_

  - [ ] 6.2 Venue statuses and Reference_Venue
    - Create `engine/src/venues.rs` (pure): status table, `reference_venue(symbol, statuses)` in the order backpack, coinbase, raydium, jupiter, replay, "N of M connected"
    - Emit `VenueStatus` and `ReferenceVenue` on change; Mark_Price comes from the reference pair
    - _Requirements: 9.6, 9.9, 9.11, 15.7_

  - [ ] 6.3 Staleness and divergence in the core
    - Handle `Clock { ts }`: pair is stale after 15 s (CEX) or 20 s (DEX); replay never goes stale; emit `PairStatus`
    - Mark a DEX pair `suspect` when it differs from the CEX Mark_Price by more than `--dex-max-deviation-pct`
    - _Requirements: 9.7, 14.6, 14.7, 14.8_

  - [ ] 6.4 Engine allowlist and HTTP wrapper
    - Create `engine/src/feed/allowlist.rs` (exact scheme, host, port, path, method) and `feed/http.rs` (refuses non-allowlisted URLs, marks key headers sensitive)
    - Allowed: Coinbase and Backpack public market routes, `GET api.jup.ag/price/v3`, `GET api-v3.raydium.io/mint/price` and `/pools/info/mint`; no `transaction-v1.raydium.io`, no `/transaction` path, no swap, order, or execute route
    - Discard any response that carries a `transaction` field
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.9_

  - [ ] 6.5 Jupiter_Adapter
    - Create `feed/jupiter.rs` and `feed/jupiter_parse.rs`: one `GET /price/v3?ids=` per cycle for listed mints, keyless interval at least 2000 ms, `JUPITER_POLL_MS` with a key (minimum 500), `x-api-key` from the environment only, `x-ratelimit-*` and `Retry-After` handling, 429 backoff 500 ms to 30 s
    - Drop and count invalid prices; round to nearest tick
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7_

  - [ ] 6.6 Raydium_Adapter
    - Create `feed/raydium.rs` and `feed/raydium_parse.rs`: `GET /mint/price` every 3 s, `GET /pools/info/mint` pool TVL once a minute per symbol, 429 backoff 1 s to 30 s, same drop and count rules
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7_

  - [ ] 6.7 Synthetic_Book and sample candles
    - Create `engine/src/dex.rs` (pure `build_synthetic_book`): levels, spread, step, and level notional from the `--dex-*` flags; deterministic; every level at least one tick
    - Build sample candles with volume zero and no Trade events; mark DEX books and tickers `synthetic`
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.10, 12.11, 13.1, 13.8_

  - [ ] 6.8 Venue-aware matcher
    - Key open orders by `(venue, symbol)`; fill against the order's venue book; re-check open orders and stops when a DEX sample rebuilds the book; never fill a venue that is down or disabled
    - _Requirements: 12.6, 12.7, 12.8, 15.3, 15.4, 15.5, 15.10_

  - [ ] 6.9 Live feed wiring and CLI
    - Create `feed/live.rs` (one task per venue in `--venues`, own backoff, statuses); update Coinbase and Backpack adapters for ten symbols; update `main.rs` flags (`--venues`, `--jupiter-poll-ms`, `--raydium-poll-ms`, `--dex-*`); REST backfill per venue where available, DEX history from samples only
    - Keep replay as the default and serve all ten symbols with no key
    - _Requirements: 9.5, 9.6, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7_

  - [ ] 6.10 Server allowlist, HTTP wrapper, and market guards
    - Create `server/src/net/allowlist.ts`, `net/http.ts` (`guardedFetch`), `net/redact.ts`; every outbound request goes through `guardedFetch`
    - Create `server/src/risk/guards.ts`: `venue_unavailable`, then `stale_market_data`, then `price_deviation`, in that order, before the HT and balance checks; add the new reasons to the reason list
    - Pass `LIVE_VENUES`, `JUPITER_API_KEY`, and the new flags to the engine through `Bun.spawn` environment and args (key never as an argument)
    - _Requirements: 14.3, 14.6, 14.7, 14.8, 14.10, 15.8, 15.9_

  - [ ] 6.11 Venue-aware subscriptions and account events in the server
    - Route market events by `(venue, symbol)` subscription; track `venue_status` for `Hello`; send `account:<id>` events only to matching sessions; the order's venue comes from the confirmed preview and is validated against Hello venues
    - _Requirements: 9.10, 9.12, 15.6, 15.8_

  - [ ]* 6.12 Write property test for staleness
    - **Property 14: Staleness follows the clock**
    - **Validates: Requirements 9.7**

  - [ ]* 6.13 Write property test for subscription filtering
    - **Property 15: Subscriptions filter by venue and symbol**
    - **Validates: Requirements 9.10**

  - [ ]* 6.14 Write property test for Reference_Venue selection
    - **Property 16: Reference_Venue selection**
    - **Validates: Requirements 9.11, 15.7**

  - [ ]* 6.15 Write property test for price sample conversion
    - **Property 17: Price samples convert to valid ticks**
    - Use recorded payload fixtures under `engine/tests/data/` for Jupiter and Raydium plus generated bad payloads
    - **Validates: Requirements 10.6, 11.6**

  - [ ]* 6.16 Write property test for DEX rounding
    - **Property 18: DEX rounding is to the nearest tick**
    - **Validates: Requirements 12.9**

  - [ ]* 6.17 Write property test for Synthetic_Book invariants
    - **Property 19: Synthetic_Book invariants**
    - **Validates: Requirements 12.1, 12.2, 12.3, 12.4, 12.5, 12.10**

  - [ ]* 6.18 Write property test for Synthetic_Book determinism
    - **Property 20: Synthetic_Book determinism**
    - **Validates: Requirements 12.11**

  - [ ]* 6.19 Write property test for slippage direction
    - **Property 21: Slippage has the right sign**
    - **Validates: Requirements 12.12**

  - [ ]* 6.20 Write property test for sample candles
    - **Property 22: Sample candles are well formed**
    - **Validates: Requirements 13.1, 13.8**

  - [ ]* 6.21 Write property test for market guard order
    - **Property 23: Market guards reject in the stated order**
    - **Validates: Requirements 14.6, 14.7, 14.8, 15.9**

  - [ ] 6.22 Write the allowlist guard test (required, read-only safety)
    - **Property 24: The allowlist permits exactly its rules**
    - fast-check for `guardedFetch` and proptest for the engine wrapper over generated URLs: lookalike hosts, upgraded schemes, embedded credentials, paths outside a rule, non-`GET` methods, any `transaction-v1.raydium.io` or `/transaction` path, and Jupiter swap, order, or execute paths must all be refused
    - Add a source-scan test that fails if code outside the wrappers calls `fetch(` or builds a `reqwest` request, and if any source file mentions `signTransaction`, `signAndSendTransaction`, or a Solana RPC URL
    - **Validates: Requirements 14.3, 14.9, 14.10**

  - [ ]* 6.23 Write property test for venue routing of fills
    - **Property 25: Fills carry their venue**
    - **Validates: Requirements 15.3, 15.4, 15.10**

  - [ ]* 6.24 Write property test for account-scoped delivery
    - **Property 51: Account-scoped events reach only their account**
    - **Validates: Requirements 15.6, 17.9, 2.18**

- [ ] 7. Checkpoint - engine, venues, and balance
  - Ask the user to approve and run `cargo build -p engine`, then `bun run check` (repo root). Fix failures, then ask the user if questions arise.

- [ ] 8. TWAP in the Router
  - [ ] 8.1 TWAP command parsing and formatting
    - Extend the Command_Parser and Command_Formatter with the TWAP command form from Requirement 17 (side, symbol, total quantity, slices, interval) and the `Twap` preview action
    - _Requirements: 17.1, 17.2, 17.12_

  - [ ] 8.2 TWAP slicing
    - Create `server/src/router/twap.ts` slicing function: whole-lot slices, each at least one lot, remainder in the last slice
    - _Requirements: 17.11, 17.13_

  - [ ] 8.3 TWAP scheduler
    - Same file: scheduler with an injectable clock; children are ordinary market orders sent only by the Router, each through the Risk_Engine at its scheduled time; at most 3 active plans per account
    - Cancel remaining children on disconnect, account change, engine restart, a rejected child, kill switch, or user cancel
    - _Requirements: 17.3, 17.4, 17.5, 17.6, 17.8, 17.10_

  - [ ] 8.4 Router, gateway, and message integration
    - Accept a TWAP only after the client confirms its preview on the same account; handle `CancelTwap`; emit `Twap` status messages on `account:<id>`; log children to the Activity_Log
    - _Requirements: 17.2, 17.7, 17.9_

  - [ ]* 8.5 Write property test for TWAP command round trip
    - **Property 32: TWAP command round trip**
    - **Validates: Requirements 17.1, 17.12**

  - [ ]* 8.6 Write property test for slice conservation
    - **Property 33: TWAP slices conserve the quantity**
    - **Validates: Requirements 17.11, 17.13**

  - [ ]* 8.7 Write property test for the scheduler
    - **Property 34: TWAP stops when it must**
    - **Validates: Requirements 17.3, 17.4, 17.5, 17.6, 17.7, 17.8, 17.10**

- [ ] 9. LLM provider abstraction and four providers
  - [ ] 9.1 Generic provider interface, schema, config, and registry
    - In `server/src/llm/`: `provider.ts` (`LlmProvider.completeJson`), `schema.ts`, `registry.ts`, `limits.ts` skeleton; config for `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `NVIDIA_API_KEY`, `NVIDIA_BASE_URL`, `OLLAMA_BASE_URL`, model names, and provider timeouts (15 s parser, 30 s analyst)
    - Reject base URLs with embedded credentials, log only their host; secrets come only from env
    - Handle `SetProvider` and send `Providers` (no key or URL)
    - _Requirements: 3.1, 3.2, 3.9, 3.10, 3.11, 3.12, 3.13, 3.14, 4.1, 4.2, 4.3_

  - [ ] 9.2 OpenAI provider
    - Responses API with structured output, through `guardedFetch`; keep the existing parser behaviour
    - _Requirements: 3.3_

  - [ ] 9.3 Anthropic provider
    - Messages API with `output_config.format` (no forced `tool_choice`)
    - _Requirements: 3.4_

  - [ ] 9.4 NVIDIA NIM provider
    - Chat completions with `nvext.guided_json` plus `response_format: json_object`; one same-provider retry without `nvext`
    - _Requirements: 3.5_

  - [ ] 9.5 Ollama provider
    - `/api/chat` with a JSON schema in `format`; list models through `/api/tags`; no key
    - _Requirements: 3.6, 3.7_

  - [ ] 9.6 Plain-English parser on any provider
    - Refactor `llm/parser.ts` to use the selected provider, Zod-validate the intent, build command text, and parse with the Command_Parser to produce a preview only
    - _Requirements: 6.1, 6.2, 6.3_

  - [ ] 9.7 Mock-server tests for all four providers
    - Bun test with a local mock HTTP server per provider and recorded response fixtures: success, malformed JSON, schema violation, timeout, HTTP 4xx and 5xx; assert no secret or request text in logs or client errors
    - _Requirements: 3.3, 3.4, 3.5, 3.6, 3.13, 6.3_

  - [ ]* 9.8 Write property test for secret redaction
    - **Property 3: Secrets never reach logs or responses**
    - **Validates: Requirements 3.13, 10.7, 19.7**

  - [ ]* 9.9 Write property test for provider isolation
    - **Property 5: Provider isolation**
    - **Validates: Requirements 4.10**

  - [ ]* 9.10 Write property test for provider independence
    - **Property 11: Provider independence**
    - **Validates: Requirements 6.4**

- [ ] 10. AI analyst and rate and cost limits
  - [ ] 10.1 Market_Snapshot builder
    - Create `server/src/ai/snapshot.ts`: at most 100 candles, 10 book levels per side, 10 news items; no account id, address, token, or position data
    - _Requirements: 5.1, 5.2_

  - [ ] 10.2 Prompt builder and Analysis schema
    - Create `ai/prompt.ts` and `ai/analysis.ts`: delimited blocks for untrusted news and user text; strict Zod `Analysis` (bias, confidence, rationale, suggested order)
    - _Requirements: 5.3, 5.8_

  - [ ] 10.3 AI_Analyst
    - Create `ai/analyst.ts`: call the selected provider, validate, turn the suggested order into command text, parse with the Command_Parser, set venue and account from the server; return `preview_error` when parsing fails; no engine sender is passed in
    - _Requirements: 5.4, 5.5, 5.6, 5.7, 5.9, 5.10, 5.11, 5.12_

  - [ ] 10.4 AI limits
    - Complete `llm/limits.ts`: sliding 60 s `AI_RATE_PER_MIN` per connection, UTC-day `AI_DAILY_CAP` for non-Ollama providers; reasons `ai_rate_limit` and `ai_daily_cap`; a scan counts once for rate and N for the daily cap
    - _Requirements: 4.8, 4.9, 7.10_

  - [ ] 10.5 Scan and strategy draft
    - Create `ai/scan.ts` (per-symbol analyses ranked by confidence descending, errors last) and strategy draft output that starts with "draft, not executed"
    - _Requirements: 7.2, 7.3, 7.5, 7.6_

  - [ ] 10.6 Gateway wiring for Copilot actions
    - Handle `AiRequest` (`analyze`, `ask`, `create_strategy`, `scan`) and `AiCancel`; send `Analysis`, `ScanResult`, `StrategyDraft`, `AiError`; `Place trade` uses `CommandText` with `?`; disabled state when no provider
    - _Requirements: 5.9, 7.1, 7.4, 7.7, 7.8, 7.9_

  - [ ]* 10.7 Write property test for AI limits
    - **Property 4: AI limits hold**
    - **Validates: Requirements 4.8, 4.9, 7.10**

  - [ ]* 10.8 Write property test for the Market_Snapshot
    - **Property 6: Market_Snapshot holds no account data**
    - **Validates: Requirements 5.1, 5.2**

  - [ ]* 10.9 Write property test for prompt delimiting
    - **Property 7: External text stays delimited**
    - **Validates: Requirements 5.8**

  - [ ]* 10.10 Write property test for Analysis validity
    - **Property 8: Analyst returns a valid Analysis or an error**
    - **Validates: Requirements 5.3, 5.4, 5.12**

  - [ ]* 10.11 Write property test for preview venue and account
    - **Property 9: Preview venue and account come from the server**
    - **Validates: Requirements 5.5, 5.6, 5.10**

  - [ ]* 10.12 Write property test that AI never trades
    - **Property 10: AI components never trade**
    - Uses a spy engine sender that must record zero order Commands
    - **Validates: Requirements 5.7, 5.11, 6.2**

  - [ ]* 10.13 Write property test for scan ranking
    - **Property 12: Scan results are ranked**
    - **Validates: Requirements 7.5**

- [ ] 11. News
  - [ ] 11.1 News provider interface, symbol matching, and config
    - Create `server/src/news/provider.ts`, `symbols.ts`; config for `NEWS_PROVIDER` (`newsapi`, `cryptopanic`, `none`), `NEWS_API_KEY`, `CRYPTOPANIC_API_KEY` from env only; strict `NewsItem` Zod schema
    - _Requirements: 19.1, 19.2, 19.7, 19.11_

  - [ ] 11.2 NewsAPI provider
    - Create `news/newsapi.ts` through `guardedFetch`; local development only; never log the full URL
    - _Requirements: 19.3, 20.1_

  - [ ] 11.3 CryptoPanic provider
    - Create `news/cryptopanic.ts`; `auth_token` stays out of logs and errors; hosted default
    - _Requirements: 19.4, 20.2, 20.3_

  - [ ] 11.4 Cache and gateway subscription
    - Create `news/cache.ts` (server-memory cache, refresh interval, at most 30 sanitized items sorted by time descending with unique URLs); handle `SubscribeNews`/`UnsubscribeNews`; send `News` with `available` flag; feed up to 10 items into the Market_Snapshot
    - _Requirements: 19.5, 19.6, 19.8, 19.9, 19.10, 19.12, 19.13, 19.14_

  - [ ] 11.5 Mock-server tests for both news providers
    - Bun tests with mock HTTP servers and recorded fixtures: success, malformed payload, HTTP errors, rate limit; assert keys never appear in logs
    - _Requirements: 19.3, 19.4, 19.7_

  - [ ]* 11.6 Write property test for news sanitization
    - **Property 37: News output is sanitized**
    - **Validates: Requirements 19.11, 19.15**

- [ ] 12. Checkpoint - server features complete
  - Ask the user to approve and run `bun run check` (repo root). Fix failures, then ask the user if questions arise.

- [ ] 13. Latency batching, coalescing, and bench script
  - [ ] 13.1 Engine emit time and book throttle
    - In `runtime.rs` wrap every event as `WireEvent` with `emit_us`; in the core, throttle Book events to at most one per venue and symbol per 50 ms of market time, emitting the latest state on the next message after the interval
    - _Requirements: 33.1, 33.2, 33.8_

  - [ ] 13.2 Latency histogram and health
    - Create `server/src/metrics/histogram.ts` (2,048-sample ring, p50 and p95); record engine-to-send and ping round-trip samples; fill the `/health` p50 and p95 fields
    - _Requirements: 1.9, 33.3, 33.12_

  - [ ] 13.3 Batcher and coalescer
    - Create `server/src/gateway/coalesce.ts` and `batcher.ts`: 10 ms Flush_Window, per-key coalescing (Candle by bar start time, Book, Ticker24h, Indicators, Trade tape limits), urgent events (OrderAck, OrderRejected, Fill, Position, Balance, Notice) flush at once, at most 200 events and 256 KB per batch, snapshots never coalesced with updates
    - _Requirements: 34.1, 34.2, 34.3, 34.4, 34.5, 34.6_

  - [ ] 13.4 Gateway integration and slow clients
    - Send `EventBatch` per connection through the batcher; detect slow clients by socket backpressure, drop coalescible data first, send a `slow_client` Notice
    - _Requirements: 34.7, 34.8, 34.9, 34.10, 34.11_

  - [ ] 13.5 Latency bench script
    - Create `server/scripts/bench-latency.ts` and the root `bench:latency` script: start server and engine in replay mode, drive loopback clients, print p50 and p95 for each target
    - _Requirements: 33.4, 33.5, 33.6, 33.7_

  - [ ]* 13.6 Write property test for book throttling
    - **Property 43: Book events are throttled**
    - **Validates: Requirements 33.8**

  - [ ]* 13.7 Write property test for histogram bounds
    - **Property 49: Histogram percentiles are bounded**
    - **Validates: Requirements 1.9, 33.12**

  - [ ]* 13.8 Write property test for coalescing equivalence
    - **Property 44: Coalescing is equivalent**
    - **Validates: Requirements 34.3, 34.4, 34.11**

  - [ ]* 13.9 Write property test for non-coalescible events
    - **Property 45: Non-coalescible events keep their order and count**
    - **Validates: Requirements 34.4, 34.5, 34.12**

  - [ ]* 13.10 Write property test for urgent delivery
    - **Property 46: Urgent events leave on time**
    - **Validates: Requirements 34.2, 34.13**

  - [ ]* 13.11 Write property test for batch bounds
    - **Property 47: Batches stay within bounds**
    - **Validates: Requirements 34.6**

- [ ] 14. Web shell and pages
  - [ ] 14.1 App shell, routes, and navigation
    - In `web/app/`: root layout with top nav and sidebar, one route folder per page (`trade`, `dashboard`, `markets`, `strategies`, `copilot`, `backtest`, `portfolio`, `logs`, `settings`, `pair`), client-side navigation that keeps the WebSocket connection, direct URLs work with `output: 'export'`
    - _Requirements: 21.1, 21.2, 21.3, 21.4, 21.5, 21.10_

  - [ ] 14.2 Store updates and batch handling
    - Update `web/lib/store.ts` for venues, `venue_status`, Balance, Ticker24h, news, AI state, TWAP, providers; apply `EventBatch` in one store update; per-venue keys for books, candles, and trades
    - _Requirements: 35.1, 35.2, 35.8, 35.9, 35.10_

  - [ ] 14.3 Exchange chips and symbol header
    - Chips All, CEX, DEX and per-venue chips (Binance and Bybit as disabled); symbol header with last, 24h change, high, low, volume ("n/a" when absent); "simulated depth" label on DEX
    - _Requirements: 9.12, 22.1, 22.2, 22.3, 22.4, 22.5, 22.6, 22.7, 22.8, 22.9_

  - [ ] 14.4 Chart types and timeframes
    - Candles, Heikin-Ashi, line, and area chart types; Timeframes including 4h; persist chart type, symbol, Timeframe, and Active_Venue in local storage
    - _Requirements: 23.1, 23.2, 23.3, 23.4, 23.9, 18.5_

  - [ ]* 14.5 Chart drawing tools (lowest priority)
    - Horizontal line, trend line, and clear-all tools drawn over the chart with mouse input only, kept in local state
    - _Requirements: 23.5, 23.6, 23.7, 23.8_

  - [ ] 14.6 Order ticket
    - Buy and Sell tabs, Market, Limit, Stop, and TWAP types, percentage slider limited by Free_Balance, position, and max order value, total, command text built for the Command_Parser, preview and confirm flow
    - _Requirements: 24.1, 24.2, 24.3, 24.4, 24.5, 24.6, 24.7, 24.8, 24.9, 24.10_

  - [ ] 14.7 Order book, trades, and bottom tabs
    - Order book with spread and depth bars, trades tape, tabs for Positions, Orders, Fills, Balances, and Activity; update on Position, OrderAck, Fill, and Balance events
    - _Requirements: 25.1, 25.2, 25.3, 25.4, 25.5, 25.6, 25.7, 25.8, 25.9, 25.10_

  - [ ] 14.8 Watchlist, portfolio, and news column
    - Watchlist with 24h changes for ten symbols, portfolio summary, News panel that shows only News_Items
    - _Requirements: 26.1, 26.2, 26.3, 26.4, 26.5, 26.6, 26.7_

  - [ ] 14.9 AI Copilot panel and page
    - Provider picker, action buttons (Analyze, Ask, Create strategy, Scan), analysis cards with a confirmable preview, error display, prompt text kept after an error, disabled state when no provider
    - _Requirements: 27.1, 27.2, 27.3, 27.4, 27.5, 27.6, 27.7, 27.8_

  - [ ] 14.10 Simple and placeholder pages
    - Dashboard, Markets, Strategies, Backtest, Portfolio, Logs (Activity_Log), Settings, Pair pages that either work or say clearly they are not ready; all data comes through the Server
    - _Requirements: 28.1, 28.2, 28.3, 28.4, 28.5, 28.6, 28.7_

  - [ ] 14.11 Header status and latency readout
    - Live status dot, "N of M connected" venues, ping median of the last 10 round trips in milliseconds
    - _Requirements: 29.1, 29.2, 29.3, 29.4, 29.5, 29.6_

  - [ ] 14.12 Keymap with per-client key lists
    - Update `shared/keymap.json` with a `clients` field and the new actions; add the TypeScript loader that rejects duplicates per client and context
    - _Requirements: 18.5, 30.4_

  - [ ]* 14.13 Write property test for Heikin-Ashi
    - **Property 38: Heikin-Ashi bars are well formed**
    - **Validates: Requirements 23.3**

  - [ ]* 14.14 Write property test for the slider
    - **Property 39: The slider never over-sizes an order**
    - **Validates: Requirements 24.2**

  - [ ]* 14.15 Write property test for the ticket round trip
    - **Property 40: Ticket round trip**
    - **Validates: Requirements 24.10**

  - [ ]* 14.16 Write property test for the latency readout
    - **Property 41: Latency readout is the median**
    - **Validates: Requirements 29.6**

  - [ ]* 14.17 Write property test for the keymap loader (TypeScript)
    - **Property 42: Keymap has no duplicates per client**
    - **Validates: Requirements 18.5, 30.4**

  - [ ]* 14.18 Write property test for batched store updates (web)
    - **Property 48: A batched store update equals sequential updates**
    - **Validates: Requirements 35.1, 35.8, 35.10**

- [ ] 15. Checkpoint - web UI builds
  - Ask the user to approve and run `bun run --cwd web build` and `bun run check` (repo root). Fix failures, then ask the user if questions arise.

- [ ] 16. TUI panels
  - [ ] 16.1 Panel layout, menu, and Hit_Map
    - In `rust/crates/tui/src/`: panels [1] to [8] (chart, book, trades, ticket, positions and orders, watchlist, news, Copilot), menu, mouse and keyboard input only, Hit_Map updates
    - _Requirements: 30.1, 30.2, 30.3, 30.5, 30.6, 30.7, 30.8, 30.9, 30.10_

  - [ ] 16.2 TUI header
    - Live status, exchange count, latency readout, memory use
    - _Requirements: 32.1, 32.2, 32.3, 32.4, 32.5_

  - [ ] 16.3 Venue and provider pickers
    - Venue chips and a provider picker that sends `SetProvider`; 4h timeframe; ten symbols
    - _Requirements: 30.11, 31.5_

  - [ ] 16.4 News and AI Copilot panels
    - News list from `News` messages; Copilot actions through `AiRequest`; analysis with preview and confirm; disabled messages "AI features are disabled" and "News unavailable"
    - _Requirements: 31.1, 31.2, 31.3, 31.4, 31.6, 31.7_

  - [ ] 16.5 Batch application
    - Handle `EventBatch`, per-venue keys, `Balance`, `Ticker24h`, `Twap`, redraw once per batch
    - _Requirements: 35.5, 35.6, 35.7, 35.8_

  - [ ] 16.6 Rust keymap loader
    - Update the TUI keymap loader for `clients` filtering and duplicate detection
    - _Requirements: 30.4_

  - [ ]* 16.7 Write property test for the keymap loader (Rust)
    - **Property 42: Keymap has no duplicates per client**
    - Rust twin of task 14.17
    - **Validates: Requirements 18.5, 30.4**

  - [ ]* 16.8 Write property test for batched application (TUI)
    - **Property 48: A batched store update equals sequential updates**
    - TUI state reducer twin of task 14.18
    - **Validates: Requirements 35.1, 35.8, 35.10**

- [ ] 17. Deploy, CI, and docs
  - [ ] 17.1 Dockerfile and Render Blueprint
    - Dockerfile `rust:1.94-bookworm` to `oven/bun:1.4.4-debian`, no Prisma files, command is `bun` running the server entry; `render.yaml` with the web service and static site, secrets as `sync: false`, `SESSION_SECRET` generated, no database service
    - _Requirements: 36.1, 36.2, 36.3, 36.7_

  - [ ] 17.2 CI workflow
    - Update `.github/workflows/ci.yml`: no Postgres, new checks, and a `latency` job that runs `bun run bench:latency` and fails above target times `CI_LATENCY_FACTOR`; update `release.yml` only if build inputs changed
    - _Requirements: 33.7, 36.4, 36.5, 36.6_

  - [ ] 17.3 Steering and MCP updates
    - Update `.kiro/steering/product.md`, `tech.md`, and `trading-safety.md` for the Oni v2 stack; update MCP tools for ten symbols and venues
    - _Requirements: 37.1, 37.2_

  - [ ] 17.4 README and env example
    - README: every variable with default and secret flag, the allowlist, guest account, replay mode, Ollama setup (`ollama pull gemma4`, `OLLAMA_BASE_URL`, hosted server cannot reach local Ollama), NewsAPI and CryptoPanic notes, in-memory activity; update `server/.env.example` with names only and no values
    - _Requirements: 20.4, 37.3, 37.4, 37.5_

- [ ] 18. Final checkpoint - full verification
  - Ask the user to approve and run, in order: `bun run gen:protocol`, `bun run check`, `bun run --cwd web build`, `cargo build -p engine` (all from the repo root, `cargo` in `rust/`), and optionally `bun run bench:latency`. Fix failures, then ask the user if questions arise.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["1.3", "1.4"] },
    { "id": 3, "tasks": ["1.5", "1.6"] },
    { "id": 4, "tasks": ["2.1"] },
    { "id": 5, "tasks": ["2.2"] },
    { "id": 6, "tasks": ["2.3"] },
    { "id": 7, "tasks": ["2.4"] },
    { "id": 8, "tasks": ["2.5"] },
    { "id": 9, "tasks": ["3.1"] },
    { "id": 10, "tasks": ["3.2", "3.3"] },
    { "id": 11, "tasks": ["3.4", "3.6"] },
    { "id": 12, "tasks": ["3.5"] },
    { "id": 13, "tasks": ["3.7", "3.8", "3.9"] },
    { "id": 14, "tasks": ["4"] },
    { "id": 15, "tasks": ["5.1"] },
    { "id": 16, "tasks": ["5.2"] },
    { "id": 17, "tasks": ["5.3"] },
    { "id": 18, "tasks": ["5.4"] },
    { "id": 19, "tasks": ["5.5", "5.6", "5.7", "5.8", "5.9", "5.10"] },
    { "id": 20, "tasks": ["6.1"] },
    { "id": 21, "tasks": ["6.2", "6.4"] },
    { "id": 22, "tasks": ["6.3", "6.7"] },
    { "id": 23, "tasks": ["6.5", "6.6", "6.10"] },
    { "id": 24, "tasks": ["6.8"] },
    { "id": 25, "tasks": ["6.9"] },
    { "id": 26, "tasks": ["6.11"] },
    { "id": 27, "tasks": ["6.12", "6.13", "6.14", "6.15", "6.16", "6.17", "6.18", "6.19", "6.20", "6.21", "6.22", "6.23", "6.24"] },
    { "id": 28, "tasks": ["7"] },
    { "id": 29, "tasks": ["8.1"] },
    { "id": 30, "tasks": ["8.2"] },
    { "id": 31, "tasks": ["8.3"] },
    { "id": 32, "tasks": ["8.4"] },
    { "id": 33, "tasks": ["8.5", "8.6", "8.7"] },
    { "id": 34, "tasks": ["9.1"] },
    { "id": 35, "tasks": ["9.2", "9.3", "9.4", "9.5"] },
    { "id": 36, "tasks": ["9.6"] },
    { "id": 37, "tasks": ["9.7"] },
    { "id": 38, "tasks": ["9.8", "9.9", "9.10"] },
    { "id": 39, "tasks": ["10.1", "10.2"] },
    { "id": 40, "tasks": ["10.3", "10.4"] },
    { "id": 41, "tasks": ["10.5"] },
    { "id": 42, "tasks": ["10.6"] },
    { "id": 43, "tasks": ["10.7", "10.8", "10.9", "10.10", "10.11", "10.12", "10.13"] },
    { "id": 44, "tasks": ["11.1"] },
    { "id": 45, "tasks": ["11.2", "11.3"] },
    { "id": 46, "tasks": ["11.4"] },
    { "id": 47, "tasks": ["11.5", "11.6"] },
    { "id": 48, "tasks": ["12"] },
    { "id": 49, "tasks": ["13.1", "13.2"] },
    { "id": 50, "tasks": ["13.3"] },
    { "id": 51, "tasks": ["13.4"] },
    { "id": 52, "tasks": ["13.5", "13.6", "13.7"] },
    { "id": 53, "tasks": ["13.8", "13.9", "13.10", "13.11"] },
    { "id": 54, "tasks": ["14.1"] },
    { "id": 55, "tasks": ["14.2"] },
    { "id": 56, "tasks": ["14.3", "14.4", "14.6", "14.7", "14.8", "14.9", "14.10", "14.11", "14.12"] },
    { "id": 57, "tasks": ["14.5"] },
    { "id": 58, "tasks": ["14.13", "14.14", "14.15", "14.16", "14.17", "14.18"] },
    { "id": 59, "tasks": ["15"] },
    { "id": 60, "tasks": ["16.1"] },
    { "id": 61, "tasks": ["16.2", "16.3", "16.4", "16.5", "16.6"] },
    { "id": 62, "tasks": ["16.7", "16.8"] },
    { "id": 63, "tasks": ["17.1", "17.2", "17.3", "17.4"] },
    { "id": 64, "tasks": ["18"] }
  ]
}
```
