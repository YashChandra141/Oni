# Implementation Plan

Notes for every task:

- Commands such as `bun run gen:protocol`, `bun run check`, `bun run --cwd web build`, `cargo test`, and `bun test` need the user's approval each time they run (tech.md standing rule). State the exact command, directory, and reason, then wait.
- Property numbers refer to the 13 correctness properties in `design.md`. Requirement numbers refer to the clauses in `bugfix.md`.
- No test contacts Backpack, Coinbase, a Solana RPC, or any network service. Backfill tests use a fake fetcher.
- Rust code: no `unwrap()` or `expect()` outside tests, no `unsafe`, no wall-clock reads in the engine core (rust.md).
- Never hand-edit `shared/protocol/*.ts` except the `index.ts` re-export line, and never hand-edit `server/src/generated/`.

- [x] 1. Write bug condition exploration tests (BEFORE implementing any fix)
  - **Property 1: Bug Condition** - Chart history, indicator alignment, layout, and tape keys
  - **CRITICAL**: These tests MUST FAIL on unfixed code. Failure confirms the bug exists.
  - **DO NOT attempt to fix the tests or the code when they fail.**
  - **NOTE**: The tests encode the expected behavior from `design.md` (`expectedBehavior`). They validate the fix when they pass after implementation.
  - **GOAL**: Surface counterexamples for each part of `isBugCondition` and confirm or refute root causes 1 to 10.
  - **Scoped PBT Approach**: For deterministic cases (layout, replay start, line limit), scope the property to the concrete failing case. For indicator times, tapes, and chart plans, generate inputs.
  - APIs that do not exist yet (`warm_up`, `on_history`, `Candle.indicators`, `planChartSync`, `tapeRows`, `layout.ts`) cannot be called on unfixed code. Write those tests against the observable behavior named in each sub-task. Tests for the new APIs themselves are written with the fix tasks.
  - Run each test on UNFIXED code and document the counterexamples.
  - Mark this task complete when the tests are written, run, and the failures are documented.

  - [x] 1.1 Exploration test: engine Indicators `ts` is not the candle open time
    - **Property 1: Bug Condition** - Indicator points align to candle open times (engine)
    - In `rust/crates/engine/src/core.rs` tests (or `core/properties.rs`), add a proptest: random trades and timeframes, subscribed key, assert each live `Indicators` event has `ts` equal to the `t` of the `Candle` event just before it.
    - Concrete case: subscribe BTC-USD 1m, trade at 61 234 ms, assert `ts == 60 000`.
    - Expected on unfixed code: FAIL (`ts` is 61 234). Record the counterexample.
    - _Bug_Condition: isBugCondition(WebIndicatorEvent e) where e.event.ts != bucket_start(e.event.ts, e.timeframe)_
    - _Requirements: 1.1, 2.1_

  - [x] 1.2 Exploration test: web store keeps one point per second
    - **Property 1: Bug Condition** - Indicator points align to candle open times (web store)
    - Create `web/lib/store.indicators.test.ts` (fast-check). Apply Indicators events with random `ts` and timeframe. Assert every stored `t` equals `bucketStartMs(t, tf)`, there is one point per bucket, points are strictly ascending, at most 500 are held, and the last event in a bucket wins.
    - Concrete case: three events inside one minute must give one stored point at the minute start.
    - Add a check that `indicatorLineData` only produces times that are open times of stored candles.
    - Expected on unfixed code: FAIL (three points). Record the counterexample.
    - _Bug_Condition: isBugCondition(WebIndicatorEvent e)_
    - _Requirements: 1.1, 1.2, 2.1, 2.2_

  - [x] 1.3 Exploration test: replay starts with no history
    - **Property 2: Bug Condition** - Replay warm-up history equals normal play (observable behavior)
    - In an engine `runtime.rs` test, use a synthetic 2-hour fixture, start replay at speed 1, subscribe to BTC-USD 1m, and assert that a snapshot with at least 85 bars arrives without waiting for real time.
    - Expected on unfixed code: FAIL (at most one bar). If this passes, the fixture or REPLAY_SPEED assumption is wrong. Re-examine cause 2.
    - _Bug_Condition: isBugCondition(ReplayStart r) where span(r.fixture_lines) > WARMUP_WINDOW_MS_
    - _Requirements: 1.3, 2.3_

  - [x] 1.4 Exploration test: subscribe answer has no indicator history
    - **Property 4: Bug Condition** - Snapshots carry per-candle indicator history (observable behavior)
    - In `core.rs` tests, trade across 30 minutes, subscribe BTC-USD 1m, and assert that the answer carries one indicator point per history bar. On unfixed code the test reads the events and counts the `Indicators` events and the snapshot's indicator data.
    - Expected on unfixed code: FAIL (one `Indicators` event, no history).
    - _Bug_Condition: isBugCondition(SubscribeAnswer s) where s.history_bars >= 2_
    - _Requirements: 1.5, 2.6_

  - [x] 1.5 Exploration test: stale indicator points survive a snapshot
    - **Property 4: Bug Condition** - Snapshots replace indicator points (web store)
    - In `web/lib/store.indicators.test.ts`, store points at t = 0..9 min, apply a candle snapshot with bars from 20 min on, and assert no stored point with `t < 20 min` remains.
    - Expected on unfixed code: FAIL.
    - _Bug_Condition: isBugCondition(ClientSnapshot c)_
    - _Requirements: 1.6, 2.7_

  - [x] 1.6 Exploration test: chart does a full `setData` for each new candle
    - **Property 5: Bug Condition** - Incremental chart updates equal a full setData
    - In `web/lib/chartData.test.ts`, call `planSeriesUpdate` for a stored list that gained one bar and for one whose forming bar changed. Assert the plan is `update` with only the changed bar.
    - Expected on unfixed code: FAIL (`set` on a new candle). If this passes, cause 6 is wrong.
    - _Bug_Condition: isBugCondition(ChartLiveUpdate u) where u.changed_bar.t >= newest(u.stored_bars).t_
    - _Requirements: 1.7, 2.8_

  - [x] 1.7 Exploration test: layout grows with content
    - **Property 6: Bug Condition** - Fixed web layout with no page overflow
    - Create `web/lib/layout.test.ts` as a static check. Assert that the only `auto` row tracks are the status and command bar rows, that `web/app/page.tsx` contains no `row-span-` or `col-span-`, that every grid child has `min-h-0` and `min-w-0`, and that `web/app/layout.tsx` uses `h-dvh overflow-hidden` and not `min-h-screen`.
    - Expected on unfixed code: FAIL (Watchlist `row-span-2`, Tape in an `auto` row, body `min-h-screen`).
    - _Bug_Condition: isBugCondition(WebLayout w)_
    - _Requirements: 1.8, 1.9, 2.9, 2.10_

  - [x] 1.8 Exploration test: tape row keys shift on each trade
    - **Property 7: Bug Condition** - Bounded tape with stable keys
    - In `web/lib/bookView.test.ts` (fast-check), apply random trade sequences. Assert that after one more trade of the selected symbol, the keys of the rows already shown are unchanged and the new row sits at the top. On unfixed code, derive the keys with the current `${ts}-${index}` rule.
    - Expected on unfixed code: FAIL (keys shift by index).
    - _Bug_Condition: isBugCondition(TapeTrade t) where t.trade.symbol == t.selected_symbol_
    - _Requirements: 1.10, 2.11_

  - [x] 1.9 Exploration test: a 500-bar snapshot with indicator history exceeds the engine line limit
    - **Property 4: Bug Condition** - Worst-case snapshot line fits the engine-stdout limit
    - In `server/src/engine/lines.test.ts`, build a worst-case JSON line of 500 bars plus 500 indicator points (extreme i64 and f64 values) and feed it to the `LineSplitter` that `supervisor.ts` uses. Assert the line is delivered.
    - Expected on unfixed code: FAIL (line dropped at 64 KiB). This confirms cause 8.
    - _Bug_Condition: isBugCondition(SubscribeAnswer s) where the snapshot line exceeds 64 KiB_
    - _Requirements: 1.5, 2.6_

- [x] 2. Write preservation property tests (BEFORE implementing any fix)
  - **Property 8, 9, 10, 11: Preservation** - Candles, replay, orders and accounts, and client behavior
  - **IMPORTANT**: Follow the observation-first methodology.
  - Record the unfixed behavior as golden data before changing any code: the non-heartbeat event stream of the engine fed the first 20 minutes of `fixtures/demo.jsonl` (span under 30 minutes, so no warm-up applies), `ReplaySchedule` delays for random short fixtures, and web store states for random message sequences.
  - Keep a reference copy of the unfixed `SymbolIndicators::update` path in the test module for comparison.
  - Run all tests on UNFIXED code. **EXPECTED OUTCOME**: Tests PASS (this confirms the baseline to preserve).
  - Mark this task complete when the tests are written, run, and passing on unfixed code.

  - [x] 2.1 Preservation test: candle math and indicator values
    - **Property 8: Preservation** - Candles and indicator values unchanged
    - Proptest over random trade sequences: bars equal the golden/reference bars, and the `values` of every emitted `Indicators` event equal the reference engine's. Compare events ignoring the `Indicators` `ts` field.
    - Keep the existing P4, P5, P6, P11, P12, P13 proptests running unchanged.
    - _Requirements: 3.1, 3.2, 3.3_

  - [x] 2.2 Preservation test: snapshot contract
    - **Property 8: Preservation** - Snapshot contract (at most 500 bars, oldest first, before live updates)
    - Confirm `snapshot_is_capped_at_500_bars`, `snapshot_carries_history_and_comes_before_live_updates`, and `only_subscribed_keys_get_live_updates` pass. Add a golden check that live `Candle` event JSON has no `indicators` key and that the subscribe answer still ends with one `Indicators` event for the newest bar.
    - _Requirements: 3.2_

  - [x] 2.3 Preservation test: replay timing, validation, and determinism
    - **Property 9: Preservation** - Replay timing, validation, and determinism
    - Proptest: for any fixture with span ≤ 30 minutes and speed 1..=50, record the `ReplaySchedule` lines and delays for loops 0, 1, and 2. Check that loops 1 and 2 keep their delays and market time increases across loops.
    - Confirm the speed range, fixture-name, and parse error tests, and P7 (same Commands, same events), pass.
    - _Requirements: 3.4, 3.5_

  - [x] 2.4 Preservation test: orders, accounts, and venue safety
    - **Property 10: Preservation** - Orders, accounts, and safety
    - Confirm the engine P28 account isolation proptest and the server P18, P19, P34, and P35 suites pass. Add tests for `klines_path` and `candles_path` asserting the host, the path prefix, and no `Authorization`, API-key, or signature header. Add a grep-style test that `feed/backfill.rs` (once it exists) names no host other than `api.backpack.exchange` and `api.coinbase.com`, and that `backfill.rs`, `core.rs`, and `replay.rs` call no file-write API.
    - Write the venue-safety checks so they pass on the existing fetch functions now and cover `backfill.rs` once it is added.
    - _Requirements: 3.6, 3.7, 3.8, 3.9, 3.14_

  - [x] 2.5 Preservation test: web store content, tape content, and interaction helpers
    - **Property 11: Preservation** - Client display and interaction
    - Fast-check over server message sequences without indicator timing: candles, book, positions, orders, watchlist prices, and tape contents (ignoring tape ids) equal the golden values. `lastTrade` matches for any trade sequence.
    - Confirm the `chartRange`, `chartKeys`, and indicator toggle tests pass.
    - _Requirements: 3.11, 3.12, 3.13_

  - [x] 2.6 Preservation test: TUI indicator alignment and redraw limit
    - **Property 11: Preservation** - TUI behavior
    - Confirm the existing `apply_indicators` floor test, the `apply_candles` merge and 500 cap tests, and the 30 redraws per second tests pass. Add golden checks that the TUI merges candles by open time and keeps at most 500.
    - _Requirements: 3.10, 3.11_

- [x] 3. Fix the engine: indicator `ts`, replay warm-up, and history injection

  - [x] 3.1 Align `Indicators` ts to the candle open time and keep an indicator history
    - In `rust/crates/engine/src/core.rs`, `on_market` Trade arm: emit `Event::Indicators { ts: bar.t, .. }` instead of the trade `ts`.
    - In `rust/crates/engine/src/indicators.rs`, add `history: VecDeque<IndicatorPoint>` to `SymbolIndicators`, capped at `MAX_BARS`. In `update`, replace the last point when `bar.t` equals it, push otherwise, and leave the history unchanged for late bars. Add `history()` and `from_bars(&[Bar])`. Do not change `commit`, `peek`, or any indicator.
    - `IndicatorPoint` is defined in the protocol crate in task 4.1. Add the struct to `event.rs` here as part of this step so the engine compiles, and finish its Candle wiring in task 4.
    - _Bug_Condition: isBugCondition(WebIndicatorEvent e), isBugCondition(SubscribeAnswer s)_
    - _Expected_Behavior: Indicators ts == candle open time; indicator history holds the values of each bar's last update_
    - _Preservation: indicator values and Candle events unchanged (Property 8)_
    - _Requirements: 2.1, 2.6, 3.1, 3.3_

  - [x] 3.2 Add the replay warm-up
    - In `rust/crates/engine/src/feed/replay.rs`, add `WARMUP_WINDOW_MS = 30 * 60 * 1000`, `warmup_len(&[FixtureLine]) -> usize` (checked subtraction, counts first-loop lines with `recv < last.recv − WARMUP_WINDOW_MS`), and `ReplaySchedule::take_warmup()` (valid only before the first `next()`; sets `index = k`, `origin = lines[k].recv`, `last_wall_ms = None`; with `k = 0` it returns an empty Vec and changes nothing).
    - In `core.rs`, add `Engine::warm_up(Vec<MarketMsg>) -> Vec<Event>`. It applies `now`, `last_price`, candles, indicators with history, and books (marked dirty). It emits no Trade, Book, live Candle, live Indicators, or Fill events and runs no matcher pass. Invalid deltas are counted and logged at debug with no Error event. With zero messages it returns nothing. Otherwise it returns snapshot events for every subscribed key and then a `Position` refresh for accounts with open positions in symbols whose last price changed.
    - In `runtime.rs`, change `Replay::on_loaded` to take `&mut Engine`. After `ReplaySchedule::new`, call `take_warmup()` then `engine.warm_up(msgs)`, schedule `lines[k]` with zero delay, return the warm-up events, and log `warmup_lines` at info. The speed applies only to `lines[k..]` and to later loops.
    - Leave book `last_emit_ts` alone so the first post-warm-up message of each symbol emits its Book.
    - _Bug_Condition: isBugCondition(ReplayStart r) where span(r.fixture_lines) > WARMUP_WINDOW_MS_
    - _Expected_Behavior: state equals normal play of lines[..k]; no output during warm-up; fresh snapshot per subscribed key after warm-up_
    - _Preservation: fixtures with span ≤ 30 minutes play from line 0 at REPLAY_SPEED with identical delays (Property 9)_
    - _Requirements: 2.3, 2.4, 3.4, 3.5, 3.7, 3.8_

  - [x] 3.3 Add `CandleBuilder::merge_history`
    - In `rust/crates/engine/src/candles.rs`, add `merge_history(&mut self, symbol, tf, bars: &[Bar], market_now: Option<TimeMs>) -> HistoryMerge { changed, added, invalid }`.
    - Valid venue bars: `t == bucket_start(t, tf)`, `0 < low ≤ open, close ≤ high`, `volume ≥ 0`. Drop and count invalid bars, never panic.
    - Cutoff per D2: `ring.front().t` if the ring has bars, else `bucket_start(market_now, tf)` if a market message was seen, else `max(venue_bars.t)`. Keep only valid aligned venue bars with `t < cutoff`, sorted, deduped by `t` (last wins), prepended to the ring, newest 500 kept. Do not touch `on_trade`.
    - _Bug_Condition: isBugCondition(LiveSubscribe l) where NOT l.backfilled_this_run_
    - _Expected_Behavior: merged ring sorted, unique by t, at most 500 bars, forming candle unchanged_
    - _Preservation: P4, P5, P6 on trade-built rings (Property 8)_
    - _Requirements: 2.5, 3.1, 3.6_

  - [x] 3.4 Add backfill bookkeeping to the core
    - In `core.rs`, add `Engine::with_backfill()`, a `backfill: Option<BTreeMap<(String, Timeframe), BackfillState>>` field (`InFlight`, `Done`; absent means none), a `history_requests` queue of `HistoryRequest { symbol, timeframe }`, and `take_history_requests()`.
    - `subscribe` queues a request and marks the key `InFlight` only in backfill mode and only when the key has no state.
    - `on_history(symbol, tf, bars) -> Vec<Event>`: acts only when the key is `InFlight`; calls `merge_history`, marks the key `Done`, rebuilds the key's `SymbolIndicators` with `from_bars` when the ring changed, and returns snapshot events when the key is subscribed and the ring changed. Any other state is a no-op.
    - `on_history_failed(symbol, tf, reason) -> Vec<Event>`: clears the key's state and returns one `Event::Error { code: FeedDisconnected, message }` naming the symbol and timeframe, with the reason cut to 200 characters.
    - Update the module docs for event order on subscribe, warm-up, and backfill. `Engine::new()` (replay) never builds requests.
    - _Bug_Condition: isBugCondition(LiveSubscribe l)_
    - _Expected_Behavior: one backfill request per key per run; success merges and snapshots; failure emits an Error, keeps live bars, and allows a retry_
    - _Preservation: no PlaceOrder, Cancel, CancelAll, or ResetAccount path is added; history never enters through a Command (Property 10)_
    - _Requirements: 2.5, 2.6, 3.6, 3.7, 3.8_

  - [x] 3.5 Add the live backfill fetcher and runtime wiring
    - Create `rust/crates/engine/src/feed/backfill.rs` with the `HistoryFetcher` trait (`fetch(symbol, tf, end_s) -> BoxFuture<Result<Vec<Bar>, String>>`), `BackpackHistory` (calls `fetch_klines`), `CoinbaseHistory` (calls `fetch_candles`), and `run_backfill(requests, results, fetcher)`: one request at a time, at least `REST_PACING` (200 ms) apart, `end_s` from the wall clock. Use the existing `https_get` (rustls, `ring`) and `DropStats`, with no credential headers. Remove the two `TODO(… live Subscribe wiring)` notes in `backpack.rs` and `coinbase.rs`.
    - In `runtime.rs`, live mode builds `Engine::with_backfill()`, `LiveFeed::start` spawns `run_backfill` for the venue, the runtime drains `take_history_requests()` into the request channel after each command (a full channel calls `on_history_failed(…, "backfill queue full")`), and a new `Wake::History(result)` branch calls `on_history` or `on_history_failed`.
    - Register the module in `feed/mod.rs`. Use only public, unauthenticated Backpack and Coinbase market-data endpoints.
    - _Bug_Condition: isBugCondition(LiveSubscribe l)_
    - _Expected_Behavior: expectedBehavior(LiveSubscribe) from design_
    - _Preservation: public endpoints only, rustls with ring, inexact venue values dropped and counted (Property 10)_
    - _Requirements: 2.5, 3.6, 3.7_

  - [x] 3.6 Write property test for the warm-up
    - **Property 2: Bug Condition** - Replay warm-up history equals normal play
    - In `core/properties.rs`, proptest random multi-symbol fixtures with spans from 0 to 3 hours, random pre-load subscriptions, and two speeds. Assert that `warm_up(lines[..k])` emits no Trade, Book, live Candle, live Indicators, Fill, or OrderAck event while applying, that candle rings, indicator state and history, books, and last prices equal an engine that played `lines[..k]` through `on_market`, that the snapshot events equal that engine's `subscribe` answer, that `k` depends only on `recv` values, and that `k = 0` emits nothing.
    - Add unit tests for `warmup_len` at the 30-minute boundary (exactly 30 minutes older is not warm-up, 30 minutes + 1 ms is) and for `take_warmup` origin and first delay of 0.
    - _Requirements: 2.3, 2.4_

  - [x] 3.7 Write property test for the backfill merge
    - **Property 3: Bug Condition** - Backfill merge keeps the forming candle and never duplicates a time
    - In `candles` and `core` tests, proptest random live rings (0 to 500 bars), known or unknown market time, and venue bar lists that are unsorted, duplicated, overlapping, misaligned, or OHLC-inconsistent. Assert strict ascending order with no duplicate `t`, at most 500 bars (newest kept), every bar with `t ≥ cutoff` equal to the live bar before the merge, every bar with `t < cutoff` valid and aligned, OHLC bounds, indicator state and history equal to a fresh `SymbolIndicators::from_bars` of the merged ring, and at most one effective `on_history` per key. Cover the failure path and retry after `on_history_failed`.
    - Add a case that runs `merge_history` and then trades and checks P4 on the merged ring.
    - _Requirements: 2.5_

  - [x] 3.8 Write property test for orders during warm-up and history
    - **Property 10: Preservation** - Orders, accounts, and safety
    - Extend the P28 proptest with warm-up and `on_history` calls mixed into the input. Add a case that places orders before a warm-up and asserts no Fill or OrderAck is produced by the warm-up.
    - _Requirements: 3.8, 3.9_

  - [x] 3.9 Verify the engine exploration tests now pass
    - **Property 1: Expected Behavior** - Indicator ts and replay history (tests 1.1 and 1.3)
    - **IMPORTANT**: Re-run the SAME tests from 1.1 and 1.3. Do NOT write new tests.
    - **EXPECTED OUTCOME**: Tests PASS (confirms the bug is fixed).
    - The unit and proptest runs need approval: `cargo test --manifest-path rust/Cargo.toml -p engine`.
    - _Requirements: 2.1, 2.3_

  - [x] 3.10 Verify engine preservation tests still pass
    - **Property 8: Preservation** - Re-run the tests from tasks 2.1 to 2.4
    - **IMPORTANT**: Re-run the SAME tests. Do NOT write new tests.
    - **EXPECTED OUTCOME**: Tests PASS (no regressions), apart from the `Indicators` `ts` field in the golden comparison.
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9_

- [x] 4. Fix the protocol: indicator history on `Candle` snapshots

  - [x] 4.1 Add `IndicatorPoint` and `Candle.indicators`
    - In `rust/crates/protocol/src/event.rs`, define `IndicatorPoint { t: TimeMs, values: IndicatorValues }` with `#[ts(export, export_to = crate::TS_EXPORT_DIR)]` and `#[ts(type = "number")]` on `t`. Add `indicators: Option<Vec<IndicatorPoint>>` to `Candle` with `#[serde(default, skip_serializing_if = "Option::is_none")]` and `#[ts(optional)]`. Re-export `IndicatorPoint` from `lib.rs`. `protocol_version` stays 2.
    - Update `strategies.rs` so the JSON round-trip proptest (P1) generates both `None` and `Some(points)`.
    - Add `pub const MAX_EVENT_LINE_BYTES: usize = 512 * 1024;` in `codec.rs` with a doc comment that the server's engine-stdout reader uses the same value.
    - Add `event.rs` tests: live `Candle` JSON unchanged, snapshot JSON with `indicators`, and old JSON without the field parsing to `None`.
    - Fix every `Event::Candle` pattern in the workspace (engine, tui) so it compiles, using `..` or the new field.
    - _Bug_Condition: isBugCondition(SubscribeAnswer s)_
    - _Expected_Behavior: snapshot carries one indicator point per history bar_
    - _Preservation: live Candle JSON byte-identical to today's (Property 8)_
    - _Requirements: 2.6, 2.7, 3.2_

  - [x] 4.2 Attach indicator history to engine snapshots
    - In `core.rs`, add `fn snapshot_events(&self, symbol, tf) -> Vec<Event>`. It builds `Candle { snapshot: true, bars, indicators: Some(points whose t is in bars) }` using an O(n) merge-join of the indicator history with the bars, followed by the current `Indicators` event when there is one. `subscribe`, `warm_up`, and `on_history` use it.
    - _Expected_Behavior: expectedBehavior(SubscribeAnswer) from design_
    - _Requirements: 2.4, 2.5, 2.6, 3.2_

  - [x] 4.3 Run `bun run gen:protocol` and update the shared exports
    - Run `bun run gen:protocol` from the repository root. This command needs the user's approval. It regenerates `shared/protocol/*.ts` (adds `IndicatorPoint.ts` and `indicators?` on `Event`).
    - Add `export type { IndicatorPoint } from "./IndicatorPoint";` to the hand-written `shared/protocol/index.ts`. Do not edit any other generated file.
    - _Requirements: 2.6_

  - [x] 4.4 Update the server Zod schema and the drift check
    - In `server/src/protocol.ts`, add `IndicatorPointSchema = z.object({ t: TimeMsSchema, values: IndicatorValuesSchema })` and `indicators: z.array(IndicatorPointSchema).optional()` on the candle schema. Add `Assert<Same<typeof IndicatorPointSchema, IndicatorPoint>>` to the drift checks.
    - Add tests: the schema accepts a snapshot with and without `indicators` and rejects a malformed point.
    - _Requirements: 2.6_

  - [x] 4.5 Write property test for snapshot indicator history in the engine
    - **Property 4: Bug Condition** - Snapshots carry per-candle indicator history
    - In `core/properties.rs`, proptest random sequences of trades, warm-ups, and backfills followed by `subscribe`. Assert `indicators` is `Some`, strictly ascending by `t`, every `t` is a bar `t` in the same snapshot, and for every bar the values equal the `values` of the last live `Indicators` event emitted for that `t`.
    - Add a size test: 500 bars and 500 points with extreme i64 and f64 values encode to at most `MAX_EVENT_LINE_BYTES`.
    - _Requirements: 2.6, 2.7_

  - [x] 4.6 Verify the protocol and engine exploration tests now pass
    - **Property 4: Expected Behavior** - Snapshots carry per-candle indicator history (test 1.4)
    - **IMPORTANT**: Re-run the SAME test from 1.4. Do NOT write a new test.
    - **EXPECTED OUTCOME**: Test PASSES.
    - Re-run the protocol round-trip proptest (P1) and confirm it passes.
    - _Requirements: 2.6_

- [x] 5. Fix the server: line limit and snapshot cache

  - [x] 5.1 Raise the engine-stdout line limit to 512 KiB
    - In `server/src/engine/lines.ts`, export `MAX_EVENT_LINE_BYTES = 512 * 1024`. In `server/src/engine/supervisor.ts`, pass `maxBytes: MAX_EVENT_LINE_BYTES` to the engine-stdout `LineSplitter`. The splitter default stays 64 KiB, and engine stdin keeps its 64 KiB limit.
    - Add tests: the supervisor accepts a 300 KB engine line and drops one over 512 KiB.
    - _Bug_Condition: snapshot line over 64 KiB (cause 8)_
    - _Requirements: 2.6_

  - [x] 5.2 Cache indicator points in `MarketState`
    - In `server/src/state/market.ts`, add an `#indicators` map per candle key. A snapshot sets it from `event.indicators ?? []`, normalized (sorted, deduped, capped at 500). A live `indicators` event merges `{ t: floor(ts, tf), values }` only into a key that already has a cached snapshot. `snapshot()` returns `indicators` with the cached points. `dropCandles` and `clear` drop them.
    - Check `gateway/ws.ts` `#subscribe` so a later subscriber receives the cached bars with their indicator points.
    - _Bug_Condition: cause 9 (cached snapshot without indicator history)_
    - _Expected_Behavior: later subscribers receive bars with indicator history_
    - _Preservation: engine restart handling and `clear()` unchanged (Property 10)_
    - _Requirements: 2.6, 2.7, 3.14_

  - [x] 5.3 Write property test for the server cache
    - **Property 4: Bug Condition** - Server cache and web store agree after the same events
    - In `server/src/state/market.test.ts` (fast-check), apply random sequences of engine `Candle` and `Indicators` events to `MarketState` and to the web store reducers. Assert the cached snapshot carries the same bars and indicator points as the store, that a snapshot replaces all earlier points, and that `clear()` drops the points.
    - _Requirements: 2.6, 2.7_

  - [x] 5.4 Verify the line-limit exploration test now passes
    - **Property 4: Expected Behavior** - Worst-case snapshot line fits (test 1.9)
    - **IMPORTANT**: Re-run the SAME test from 1.9. Do NOT write a new test.
    - **EXPECTED OUTCOME**: Test PASSES.
    - _Requirements: 2.6_

- [x] 6. Fix the web store: aligned points, snapshot replacement, stable tape ids

  - [x] 6.1 Align indicator points to candle open times
    - In `web/lib/chartData.ts`, add `bucketStartMs(ts, tf)` (UTC, all five timeframes). In `web/lib/store.ts`, `applyIndicatorsEvent` stores `t: bucketStartMs(event.ts, event.timeframe)`, replaces the point at that time, keeps strictly ascending order, caps at 500, and rejects non-finite or negative `ts`.
    - In `web/lib/indicatorData.ts`, use the generated `IndicatorPoint` type, and make `indicatorLineData` take an optional set of candle times and drop points outside it.
    - _Bug_Condition: isBugCondition(WebIndicatorEvent e)_
    - _Expected_Behavior: expectedBehavior(WebIndicatorEvent) from design_
    - _Preservation: indicator values unchanged (Property 8)_
    - _Requirements: 2.1, 2.2, 3.3_

  - [x] 6.2 Make a candle snapshot replace candles and indicator points
    - In `applyCandleEvent`, a snapshot sorts and dedupes `bars` (last wins), keeps the newest 500, sets `indicators[key]` from `event.indicators ?? []` (aligned, deduped, capped), and increments `seriesVersion[key].snapshot`. A live bar older than the newest stored bar increments `seriesVersion[key].rewrite`.
    - _Bug_Condition: isBugCondition(ClientSnapshot c)_
    - _Expected_Behavior: stored_points(key) == normalize(snapshot.indicators)_
    - _Requirements: 2.7, 2.8, 3.2_

  - [x] 6.3 Give each tape entry a stable id
    - Add `id: number` to `TapeEntry`. The store keeps `nextTapeId` and gives each Trade `id = nextTapeId++`. `MAX_TAPE` stays 200. Trades for other symbols are stored, not rendered.
    - _Bug_Condition: isBugCondition(TapeTrade t)_
    - _Requirements: 2.11, 3.12_

  - [x] 6.4 Write property test for web store alignment and snapshot replacement
    - **Property 1: Bug Condition** - Indicator points align to candle open times (web store)
    - Finish `web/lib/store.indicators.test.ts`: random `ts` and timeframe sequences, one point per bucket, strictly ascending, at most 500, last values win, and `indicatorLineData` times within candle times.
    - _Requirements: 2.1, 2.2_

  - [x] 6.5 Write property test for web store ordering
    - **Property 5: Bug Condition** - Web merge stays ordered
    - Fast-check random sequences of candle snapshots (including unsorted or duplicated bars), live bars (forming, new, or late), and Indicators events. Assert every stored candle list and point list is strictly ascending, unique by `t`, and at most 500 long. Assert `seriesVersion.rewrite` increases on a late revision and `snapshot` increases on each snapshot.
    - _Requirements: 2.7, 2.8_

  - [x] 6.6 Write property test for snapshot replacement across store, cache, and TUI model
    - **Property 4: Bug Condition** - Snapshots replace stored indicator points in the web store
    - Fast-check random event sequences ending in a snapshot. Assert the stored points of that key equal the snapshot's normalized points and no earlier point remains.
    - _Requirements: 2.7_

  - [x] 6.7 Write property test for the bounded tape
    - **Property 7: Bug Condition** - Bounded tape with stable keys
    - Add `tapeRows(tape, symbol)` to `web/lib/bookView.ts` (filter by symbol, first `TAPE_ROWS` = 50). Fast-check random trade sequences across three symbols and random selected symbols. Assert at most 200 entries newest first, unique ids strictly decreasing from the top, ids never change while stored, `tapeRows` returns at most 50 entries of that symbol, and after one more trade of the selected symbol the result equals `[new, ...previousRows].slice(0, 50)` by id.
    - _Requirements: 2.11_

  - [x] 6.8 Verify the web store exploration tests now pass
    - **Property 1: Expected Behavior** - Tests 1.2, 1.5, and 1.8
    - **IMPORTANT**: Re-run the SAME tests from 1.2, 1.5, and 1.8. Do NOT write new tests.
    - **EXPECTED OUTCOME**: Tests PASS.
    - _Requirements: 2.1, 2.7, 2.11_

  - [x] 6.9 Verify web store preservation tests still pass
    - **Property 11: Preservation** - Re-run the tests from task 2.5
    - **IMPORTANT**: Re-run the SAME tests. Do NOT write new tests.
    - **EXPECTED OUTCOME**: Tests PASS (tape content equals the golden tape ignoring ids).
    - _Requirements: 3.11, 3.12_

- [x] 7. Fix the web ChartPanel: incremental updates

  - [x] 7.1 Add `planChartSync` and remove `planSeriesUpdate`
    - In `web/lib/chartData.ts`, add the pure `planChartSync(prev, next)` per D5. It returns `set` when there is no previous state, the view key (symbol, timeframe, decimals) changed, or the snapshot or rewrite counter changed. Otherwise it returns `update` with the bars at or after `prev.lastTime`, and only those bars are converted. Replace `planSeriesUpdate` and `seriesShape`, and move their tests to the new helper.
    - _Bug_Condition: isBugCondition(ChartLiveUpdate u)_
    - _Expected_Behavior: update with exactly the changed bars; full set only on snapshot, view switch, toggle, or older-bar rewrite_
    - _Requirements: 2.8_

  - [x] 7.2 Drive `ChartPanel` with `planChartSync`
    - In `web/components/ChartPanel.tsx`, replace both data effects. On `set`: convert all bars and points, call `setData`, and reposition the view on the newest candles when the snapshot counter or view key changed (every snapshot, including a fresh snapshot on the same key). On `update`: convert only the returned bars and points and call `series.update` on each in ascending order, for the candle series, the volume series, and each enabled indicator line.
    - Toggling a line on creates its series and calls `setData`. Toggling it off removes the series. Indicator points with no stored candle time are dropped so lines never add time-axis slots.
    - Keep zoom, pan, crosshair, timeframe keys, and toggles unchanged.
    - _Bug_Condition: isBugCondition(ChartLiveUpdate u), cause 10_
    - _Expected_Behavior: expectedBehavior(ChartLiveUpdate) from design_
    - _Preservation: chart interaction and resizing unchanged (Property 11)_
    - _Requirements: 2.2, 2.8, 3.11, 3.13_

  - [x] 7.3 Write property test for incremental chart updates
    - **Property 5: Bug Condition** - Incremental chart updates equal a full setData
    - In `web/lib/chartData.test.ts` (fast-check), run random event sequences split into random render batches. Use a model chart series that applies `setData` and `update` as Lightweight Charts does (update replaces an equal time or appends a newer one). After each `planChartSync` result, compare the model series from the first stored time on with `setData(barsToCandles(stored bars))`. Check the volume series and each enabled indicator line the same way. When a batch only changes the forming bar or appends newer bars, assert the plan is `update` with exactly the changed bars and no other bar is converted. A snapshot or rewrite must give `set`.
    - _Requirements: 2.8_

  - [x] 7.4 Verify the chart exploration test now passes
    - **Property 5: Expected Behavior** - Test 1.6
    - **IMPORTANT**: Re-run the SAME test from 1.6. Do NOT write a new test.
    - **EXPECTED OUTCOME**: Test PASSES.
    - _Requirements: 2.8_

  - [x] 7.5 Verify chart interaction preservation tests still pass
    - **Property 11: Preservation** - Re-run the `chartRange`, `chartKeys`, and toggle tests from task 2.5
    - **IMPORTANT**: Re-run the SAME tests. Add a `planChartSync` check that a snapshot repositions and a rewrite does not.
    - **EXPECTED OUTCOME**: Tests PASS.
    - _Requirements: 3.11_

- [x] 8. Fix the web layout: fixed grid, scrolling panels, memoized tape

  - [x] 8.1 Create `web/lib/layout.ts`
    - Export the grid spec as data: columns `12rem minmax(0,1fr) 16rem`, rows `auto minmax(0,1fr) 12rem auto`, and areas `"status status status" / "watch chart side" / "tape account account" / "command command command"`. Export a `PANEL_AREA` map that gives each panel exactly one area.
    - _Requirements: 2.9, 3.13_

  - [x] 8.2 Apply the layout to the page and shell
    - `web/app/page.tsx`: `<main className="grid h-dvh overflow-hidden gap-1 p-1">` with `style` from `layout.ts`. Each grid child gets `style={{ gridArea }}` and `min-h-0 min-w-0`. Remove `row-span-2` and `col-span-2`. The side column is `flex min-h-0 min-w-0 flex-col` with the Order book panel `min-h-0 flex-1`.
    - `web/app/layout.tsx`: body `crt-screen h-dvh overflow-hidden antialiased` (replace `min-h-screen`).
    - `web/components/StatusBar.tsx` and `CommandBar.tsx`: drop `col-span-3`.
    - Keep `PreviewDialog`, `ConfirmDialog`, and `RejectionToast` `fixed` and unchanged. `OrderHotkeys` still renders `null`.
    - _Bug_Condition: isBugCondition(WebLayout w)_
    - _Expected_Behavior: page height equals the viewport and no panel size depends on content_
    - _Preservation: same panels in the same arrangement (Property 11)_
    - _Requirements: 2.9, 3.13_

  - [x] 8.3 Make panel bodies scroll inside the panel
    - `Panel` gains `body: "scroll" | "clip"`, default `scroll`, mapping to `min-h-0 flex-1 overflow-auto` or `overflow-hidden`. The chart uses `clip` so the ResizeObserver never sees scrollbars. The account panel uses `clip` with an inner `flex min-h-0 flex-col`, and each of its three columns is `min-h-0 overflow-auto`. Remove the fixed `h-[calc(100%-1.25rem)]`.
    - _Requirements: 2.9, 2.10_

  - [x] 8.4 Memoize and cap the tape rows
    - In `web/components/TradesTape.tsx`, select rows with `useMemo(() => tapeRows(tape, symbol), [tape, symbol])` and render a `memo` `TapeRow` per entry with `key={entry.id}`. The newest row stays at the top, the panel body scrolls (`overflow-auto`), and at most 50 rows render. Keep the UTC time, price, quantity, and side display, and the watchlist last price.
    - _Bug_Condition: isBugCondition(TapeTrade t)_
    - _Expected_Behavior: new row added without rebuilding existing rows_
    - _Requirements: 2.11, 3.12_

  - [x] 8.5 Write property test for the fixed layout
    - **Property 6: Bug Condition** - Fixed web layout with no page overflow
    - Finish `web/lib/layout.test.ts` with fast-check over the layout spec: for every panel id, the panel sits in exactly one named area, and every named area holds exactly one element. The only `auto` row tracks are the status and command rows, every other track is fixed or `minmax(0, …fr)`, every grid child carries `min-h-0` and `min-w-0`, content panel bodies are `overflow-auto`, the page root and `<body>` are `h-dvh overflow-hidden`, and no grid component uses `row-span-*` or `col-span-*`.
    - Add the arrangement check: status top, command bottom, watchlist left of the chart, side right of the chart, tape below the watchlist, account below the chart. Overlays keep `fixed`.
    - _Requirements: 2.9, 2.10, 3.13_

  - [x] 8.6 Verify the layout exploration test now passes
    - **Property 6: Expected Behavior** - Test 1.7
    - **IMPORTANT**: Re-run the SAME test from 1.7. Do NOT write a new test.
    - **EXPECTED OUTCOME**: Test PASSES.
    - _Requirements: 2.9, 2.10_

- [x] 9. Fix the TUI: use the indicator history from snapshots

  - [x] 9.1 Apply the snapshot's indicator history
    - In `rust/crates/tui/src/app.rs`, in the `Event::Candle` arm of `update`, add `App::apply_indicator_history`. On a snapshot for the selected key, replace that key's `IndicatorSeries` with the snapshot's points (floored to the candle open time, merged, capped at 500). With `indicators: None`, clear it. Live handling is unchanged. Redraw rules (at most 30 per second, only when dirty) are unchanged.
    - _Bug_Condition: isBugCondition(ClientSnapshot c)_
    - _Expected_Behavior: TUI draws indicator lines over the history candles_
    - _Preservation: apply_indicators floor, apply_candles merge, 500 cap, redraw limit (Property 11)_
    - _Requirements: 2.6, 2.7, 3.10_

  - [x] 9.2 Write property test for TUI indicator history
    - **Property 1: Bug Condition** - Indicator points align to candle open times (TUI `App`)
    - In `rust/crates/tui/src/app.rs` tests (proptest), random `Indicators` event `ts` values and snapshots with and without `indicators`. Assert stored points are floored, one per open time, ascending, at most 500, that a snapshot replaces the series, and that `None` clears it.
    - _Requirements: 2.1, 2.7, 3.10_

  - [x] 9.3 Verify TUI preservation tests still pass
    - **Property 11: Preservation** - Re-run the tests from task 2.6
    - **IMPORTANT**: Re-run the SAME tests. Do NOT write new tests.
    - **EXPECTED OUTCOME**: Tests PASS.
    - Add a step to `rust/crates/tui/MANUAL_CHECK.md`: after the warm-up, the CandleChart_Widget shows history candles with indicator lines over them.
    - _Requirements: 3.10, 3.11_

- [x] 10. Checkpoint - Ensure all tests pass
  - Run `bun run check` from the repository root. It runs cargo fmt check, clippy `-D warnings`, cargo test, tsc, and bun test. The user approves it at run time.
  - Run `bun run --cwd web build` to confirm the static export builds. The user approves it at run time.
  - Add the replay integration test `server/src/integration/replay.integration.test.ts` if it is not yet present: real engine with `fixtures/demo.jsonl` at speed 1, subscribe BTC-USD 1m, expect a snapshot with 85 to 95 bars and matching indicator points, live `Indicators` `ts` equal to the `Candle` `t`, a cached snapshot with points for a second subscriber, and a warm-up wall time under 1 s in a release build.
  - Manual browser check (record the result in the PR): start the server in replay mode and open the web UI at 1280×720 and 1920×1080. Confirm each item:
    - The chart opens with about 90 candles of normal width and distinct time-axis labels.
    - The EMA and VWAP lines align with the candles and cover the history.
    - Run the replay at speed 50 for 2 minutes. The page never scrolls, the chart keeps its size, and the tape stays in its panel (the book and account panels scroll inside themselves).
    - Switch to 5m and back, then restart the server. No stale line segments remain and the view sits on the newest candles.
    - Resize the window and confirm the chart follows its panel.
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Replay shows today's real time
  - Scope addition. The checkpoint re-run of Task 10 (`bun run check`, `bun run --cwd web build`) covers this task.

  - [x] 11.1 Shift replay timestamps to the current minute at load
    - In `rust/crates/engine/src/feed/replay.rs`, add the pure helpers `align_offset` / `checked_align_offset` (minute floors, checked arithmetic, 0 on overflow), `shift_lines` (moves `recv` and the message `ts`, all or nothing), and `align_to_now(lines, now_ms)`.
    - In `rust/crates/engine/src/runtime.rs`, `Replay::on_loaded` takes the wall-clock `wall_ms` (read with `now_ms()` in the run loop). It calls `align_to_now` before `ReplaySchedule::new`, `take_warmup`, and `warm_up`, logs the offset at info, and warns on overflow. `core.rs` is unchanged.
    - Update `start_and_load` (fixed `TEST_WALL_MS`) and `run_replays_trades_in_order_and_loops` (relative times, first trade on the load minute). Check that `server/src/integration/replay.integration.test.ts` assumes no absolute fixture time.
    - _Bug_Condition: replay shows the Fixture's recorded timestamps_
    - _Expected_Behavior: D6 Replay time alignment_
    - _Preservation: delays, `k`, and 1m candle shapes unchanged; live mode unchanged (3.15)_
    - _Requirements: 1.11, 2.12, 3.15_

  - [x] 11.2 Write property test for replay time alignment
    - **Property 12: Expected Behavior** - Replay time alignment
    - In `feed/replay.rs` tests (proptest, 64 cases), random fixtures and an injected `now`: the first live line is in now's minute, all deltas of `recv` and `ts` are preserved, the shift is a multiple of 60 000, and `warmup_len` is unchanged. Add unit tests for `align_offset` (minute multiple, now's minute, overflow gives 0).
    - _Requirements: 2.12, 3.15_

- [x] 12. Show times in the viewer's local time zone
  - Scope addition (bugfix 1.12, 2.13, 3.16; design D7). Display-only, web only: times stay UTC epoch ms everywhere else. The TUI is out of scope for this task and is unchanged.
  - The next `bun run check && bun run --cwd web build` (the checkpoint of Task 10) covers this task. The user approves each run.

  - [x] 12.1 Local-time formatters and chart localization
    - Create `web/lib/timeFormat.ts` with `formatClock(ms, opts?)`, `formatChartTime(sec, opts?)`, and `tickMarkLabel(sec, tickType, opts?)`. `opts` is `{ timeZone?: string; locale?: string }`. Use `Intl.DateTimeFormat` with no fixed zone by default, cache the instances per kind, zone, and locale, and give a placeholder dash for invalid input.
    - Remove `formatTimeUtc` (`bookView.ts`) and the UTC `formatChartTime` (`chartData.ts`) and update every caller and test.
    - In `web/components/ChartPanel.tsx`, set `localization.timeFormatter` (crosshair) and `timeScale.tickMarkFormatter` (axis). Keep the series times as UTC seconds and do not shift any data.
    - _Bug_Condition: the Web_UI shows UTC times_
    - _Expected_Behavior: D7 Local time display_
    - _Preservation: candle buckets, wire data, and the journal stay UTC (3.16)_
    - _Requirements: 1.12, 2.13, 3.16_

  - [x] 12.2 Use them in the tape, orders/fills, status bar, and notices
    - `web/components/TradesTape.tsx` uses `formatClock`. Fills, orders, positions, the status bar, notices, and the rejection toast show no clock time today (checked by grep for `ts`, `time`, and the old helpers), so they need no change. Any time shown there later uses the same formatters.
    - _Requirements: 2.13, 3.12_

  - [x] 12.3 Write property test for local time display
    - **Property 13: Expected Behavior** - Local time display
    - In `web/lib/timeFormat.test.ts` (fast-check), random epoch ms including DST-transition dates, in `"UTC"`, `"Asia/Kolkata"`, and `"America/New_York"`: the formatted text equals `Intl.DateTimeFormat` in that zone, and the candle data is unchanged. Unit tests: the same instant renders differently in Kolkata and New York, a 1d open at 00:00 UTC shows as 05:30 in Kolkata, and invalid input gives the placeholder.
    - Tests that asserted UTC strings pass an explicit `timeZone: "UTC"`.
    - _Requirements: 2.13, 3.16_
