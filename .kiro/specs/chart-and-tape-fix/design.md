# Chart and Tape Fix Bugfix Design

## Overview

This fix covers the two defects in `bugfix.md`.

**Bug A (one candle on the chart).** Five things combine:

1. The engine stamps live `Indicators` events with the trade time.
2. The web store keys indicator points by that time, so the chart gets one time-axis slot per trade second.
3. Replay starts with no history.
4. Live mode never loads venue history.
5. The subscribe answer carries only the newest indicator values. Snapshots also leave stale indicator points in the web store, and the web chart reconverts and re-sets whole series on most events.

**Bug B (tape takes over the page).** The web grid puts the Tape in a content-sized row, the body is `min-h-screen`, and panel bodies clip instead of scrolling. Tape rows are keyed by list position, so every row re-renders on each trade.

The fix strategy:

- **Engine (Rust, pure core).** Stamp every `Indicators` event with its candle's open time. Keep a per-candle indicator history per (symbol, timeframe). Answer every snapshot with that history. Add a replay warm-up that fast-forwards all but the last 30 minutes of a fixture with no output. Add a live backfill path: the runtime fetches public klines/candles, and the core merges them through a plain method call, not a protocol Command.
- **Protocol.** Add an optional `indicators: Option<Vec<IndicatorPoint>>` field to the `Candle` event. It is set on snapshots only. Regenerate `shared/protocol/` with `bun run gen:protocol`.
- **Server.** Accept the new field in Zod. Raise the engine-stdout line limit so a 500-bar snapshot with its indicator history fits. Cache the indicator history next to the candle cache for later subscribers.
- **Web.** Align indicator points to candle open times. Have snapshots replace both candles and indicator points. Drive the chart with `series.update` for the forming and appended bars, and use `setData` only for snapshots, view switches, toggles, and older-bar rewrites. Replace the grid with a fixed-height, named-area layout whose panels scroll inside. Give tape rows stable ids.
- **TUI.** Apply the snapshot's indicator history. The TUI already floors indicator times.

Nothing new is persisted. History stays in engine memory (bugfix 3.7). All venue access stays on public, unauthenticated market-data endpoints (trading-safety rule 1). No order path changes (rule 2).

## Glossary

- **Bug_Condition (C)**: The set of inputs that trigger Bug A or Bug B, formalized in `isBugCondition` below.
- **Property (P)**: The behavior the fixed system must show for every input in C (`expectedBehavior`).
- **Preservation**: Behavior for inputs outside C, plus the existing guarantees listed in bugfix §3, that must not change.
- **F / F'**: The unfixed / fixed system.
- **Candle open time**: `bucket_start(ts, tf) = floor(ts / tf_ms) * tf_ms` in UTC epoch ms (`rust/crates/engine/src/candles.rs` `bucket_start`). A bar's `t` is its open time.
- **Forming candle**: The newest bar of a (symbol, timeframe) ring, which live trades still change.
- **Indicator history**: The per-bar list of `IndicatorPoint { t, values }` for one (symbol, timeframe). Each point holds the values the Indicator_Engine computed at that bar's last update.
- **IndicatorPoint**: A new protocol struct `{ t: TimeMs, values: IndicatorValues }`. `t` is a candle open time.
- **Warm-up**: The first-loop prefix of a replay fixture: every line with `recv < last.recv − WARMUP_WINDOW_MS`, where `WARMUP_WINDOW_MS = 1_800_000` (30 min). The engine applies these lines to its state at once and emits no events for them.
- **Backfill**: One public REST request for recent klines (Backpack) or candles (Coinbase) for one (symbol, timeframe), made by the runtime after the core asks for it.
- **Backfill cutoff**: The open time from which live-built bars own the series. Klines at or after the cutoff are discarded.
- **History merge**: `CandleBuilder::merge_history`, which merges backfilled bars older than the cutoff into a ring.
- **Series version**: The web store's per-key counters `{ snapshot, rewrite }`. They tell the chart when an incremental update is not enough.
- **Tape id**: A monotonic integer that the web store assigns to each trade when it enters the tape. It is the React key of the trade's row.
- **`applyCandleEvent` / `applyIndicatorsEvent` / `mergeIndicatorPoint`**: Web store reducers in `web/lib/store.ts`.
- **`planSeriesUpdate`**: The current set-or-update decision in `web/lib/chartData.ts`, replaced by `planChartSync`.
- **`ReplaySchedule`**: The pure replay timing iterator in `rust/crates/engine/src/feed/replay.rs`.

## Bug Details

### Bug Condition

Bug A shows up when the chart or its data source handles indicator times, history at start, history on subscribe, or a new snapshot. Bug B shows up when web panel content grows or a trade enters the tape. The top-level condition is the union of the sub-conditions below. Each one maps to a defect clause in `bugfix.md`.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input, one of:
    WebIndicatorEvent { event: Indicators, timeframe }
    ReplayStart       { fixture_lines, speed }
    LiveSubscribe     { venue, symbol, timeframe, backfilled_this_run: bool }
    SubscribeAnswer   { symbol, timeframe, history_bars: int }
    ClientSnapshot    { key, stored_points_before: list }
    ChartLiveUpdate   { changed_bar, stored_bars }
    WebLayout         { panel_content_heights }
    TapeTrade         { trade, selected_symbol }
  OUTPUT: boolean

  MATCH input
    WebIndicatorEvent e:                                  // 1.1, 1.2
      RETURN e.event.ts != bucket_start(e.event.ts, e.timeframe)
    ReplayStart r:                                        // 1.3
      RETURN span(r.fixture_lines) > WARMUP_WINDOW_MS
    LiveSubscribe l:                                      // 1.4
      RETURN NOT l.backfilled_this_run
    SubscribeAnswer s:                                    // 1.5
      RETURN s.history_bars >= 2
    ClientSnapshot c:                                     // 1.6
      RETURN EXISTS p IN c.stored_points_before
             WHERE p.t NOT IN times(snapshot.indicators)
    ChartLiveUpdate u:                                    // 1.7
      RETURN u.changed_bar.t >= newest(u.stored_bars).t   // forming or appended bar
    WebLayout w:                                          // 1.8, 1.9
      RETURN EXISTS panel WHERE w.panel_content_heights[panel] > panel_height(panel)
    TapeTrade t:                                          // 1.10
      RETURN t.trade.symbol == t.selected_symbol
  END MATCH
END FUNCTION

FUNCTION span(lines) = last(lines).recv - first(lines).recv
```

Notes on the condition:

- `WebIndicatorEvent` covers every live Indicators event from the unfixed engine, because its `ts` is a trade time and rarely falls exactly on a candle boundary.
- `ReplayStart` with `span ≤ 30 min` is outside C on purpose: those fixtures keep today's behavior (bugfix 3.5).
- `ChartLiveUpdate` with `changed_bar.t < newest.t` (a late revision of an older bar) is outside C. A full `setData` stays correct there (bugfix 2.8).

### Examples

- **Indicator times (1.1, 1.2).** On 1m, BTC-USD trades at 00:03:01.2, 00:03:05.7, and 00:03:09.1. The unfixed engine emits Indicators with `ts` 180 120 ms, 185 700 ms, and 189 100 ms. The web store keeps three points, and `indicatorLineData` makes chart times 180, 185, and 189 s. The time axis gets three slots labelled "00:03", and the candle at 180 s is squeezed. Expected: one point at `t = 180 000`, replaced on each update.
- **Replay start (1.3).** The engine starts and the server sends `subscribe BTC-USD 1m` and `start_replay demo.jsonl 1`. The snapshot holds 0 or 1 bars, and a second candle appears after 60 s. Expected: after the warm-up, a fresh snapshot with about 90 one-minute bars.
- **Live start (1.4).** `LIVE_VENUE=backpack`. A client subscribes to BTC-USD 5m ten seconds after the engine starts. The snapshot holds one bar. Expected: up to 500 bars, made of Backpack klines older than the first live bar plus the live bars.
- **Subscribe answer (1.5).** A key has 90 bars. The answer is the 90-bar snapshot plus one Indicators event, so the EMA line has one point. Expected: the snapshot carries about 90 indicator points (minus the warm-up period of each indicator, where values are `null`).
- **Stale points (1.6).** The web holds points up to 10:00. The engine restarts and the new snapshot holds bars from 10:05. The 10:00 points stay, so the line extends left of the candles. Expected: the snapshot replaces the points.
- **Chart cost (1.7).** With 500 bars stored, each trade reconverts 500 bars and every enabled line (up to 7 × 500 points), and calls `setData` on each line whose point count changed.
- **Tape (1.8, 1.10).** After about 30 trades the Tape panel (grid row 4, `auto`) is taller than the chart's `1fr` row can give up. The chart row shrinks to zero and the page scrolls. Each trade changes every row key `${ts}-${index}`, so React rebuilds all 50 rows.
- **Edge: short fixture.** A 20-minute fixture has no line older than `last.recv − 30 min`. The warm-up is empty, no extra snapshot is sent, and the replay is identical to today's.
- **Edge: backfill failure.** Backpack answers HTTP 429. The engine emits `Error { code: feed_disconnected, message: "candle backfill for BTC-USD 5m failed: …" }` and keeps the live bars. The next `Subscribe` Command for that key tries again.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- Candle building from trades: OHLC invariants, volume sums, and 1m aggregation equal to direct building (3.1; existing P4, P5, P6).
- The snapshot contract: at most 500 bars, oldest first, before any live update for that subscription, and a live Candle event on every change (3.2). The answer to `subscribe` still ends with one Indicators event for the newest bar.
- Indicator values: EMA, SMA, VWAP, Bollinger, RSI, and ATR give the same numbers for the same bars (3.3; existing P11, P12, P13). Only the `ts` of live Indicators events moves, from the trade time to the candle open time.
- Replay determinism, speed validation (1 to 50), fixture-name and parse errors, and looping with increasing market time (3.4; existing P7).
- Fixtures of 30 minutes or less: played from line 0 at REPLAY_SPEED with identical delays (3.5).
- Venue access: public, unauthenticated endpoints only, rustls with `ring`, inexact venue values dropped and counted (3.6).
- No persistence of history: no journal or file writes for market data, and no account restore (3.7).
- One order path, previews, confirmation, Kill_Switch, and Risk_Limits (3.8). The warm-up fills no orders.
- Account isolation and account-scoped delivery (3.9; existing P28, P34, P35).
- TUI: at most 30 redraws per second, only when dirty. Indicator points aligned to candle open times, candles merged by time, at most 500 (3.10).
- Chart interaction in both clients: zoom, pan, crosshair, timeframe keys 1 to 5, and indicator toggles. A new snapshot positions the view on the newest candles (3.11).
- Trade forwarding, the tape's UTC time, price, quantity, and side, and the watchlist last price (3.12).
- The same panels in the same arrangement, overlays above the panels, and the chart resizing with the window (3.13).
- On an engine restart: accounts reset, a notice to every client, and subscriptions resent (3.14).

**Scope:**
Inputs outside C must behave exactly as before. This includes:
- Engine handling of Commands other than `Subscribe`: orders, cancels, resets, ping.
- Market messages after the warm-up, in replay and live: same Trade, Candle, Book, OrderAck, Fill, and Position events. Indicators events change only in `ts`.
- Live Candle events: same JSON. The new field is omitted when `None`.
- Late revisions of older bars in the web chart (a full `setData`, as today).
- Web panels whose content fits: same look and position.
- Tape trades for symbols other than the selected one: stored, not rendered.

## Hypothesized Root Cause

Causes 1 to 7 were confirmed in the code during the requirements phase. Causes 8 to 10 came up while designing the fix and must be handled for the fix to work.

1. **Indicator `ts` is the trade time.** `rust/crates/engine/src/core.rs`, `on_market` Trade arm (about lines 286–293), pushes `Event::Indicators { ts, .. }` with the trade's `ts`. The subscribe answer (about lines 399–431) already uses the newest bar's start. `web/lib/store.ts` `applyIndicatorsEvent` (about lines 667–678) keys points by `event.ts`, and `indicatorLineData` (`web/lib/indicatorData.ts`) makes one chart point per second. The TUI floors (`rust/crates/tui/src/app.rs` 216–230), which is why it does not show part 1.2.
2. **Replay has no warm-up.** `ReplaySchedule` starts at line 0 with recorded delays, and REPLAY_SPEED defaults to 1 (`feed/replay.rs`; `runtime.rs` `Replay::on_loaded`).
3. **Live backfill is never wired.** `fetch_klines` (`feed/backpack.rs` about 388–413) and `fetch_candles` (`feed/coinbase.rs` about 313–330) have no callers, and the core has no history input.
4. **No indicator history.** `SymbolIndicators` keeps only committed state and the forming bar. `subscribe` sends only `current()`.
5. **Snapshots keep stale points.** `applyCandleEvent` replaces candles only. `applyIndicatorsEvent` merges into the old list.
6. **Full chart work per event.** `ChartPanel.tsx` runs `barsToCandles`/`barsToVolume` over all bars and `indicatorLineData` over all points on every change. `planSeriesUpdate` returns `set` whenever the count or first time changes, which happens on every new candle and on every new indicator point under cause 1.
7. **Layout.** `web/app/page.tsx` uses `grid-rows-[auto_1fr_12rem_auto]` with Watchlist `row-span-2`, so auto-placement puts the Tape in row 4 (`auto`) and the command bar in an implicit row 5. `web/app/layout.tsx` sets `min-h-screen` on the body. `Panel` bodies use `overflow-hidden`. `TradesTape.tsx` keys rows by `${trade.ts}-${index}`.
8. **Engine stdout line limit.** The server's `LineSplitter` (`server/src/engine/lines.ts`, used by `supervisor.ts`) drops engine lines over 64 KiB. A 500-bar snapshot is already about 55 KB. Adding 500 indicator points (about 250 bytes each) puts it near 180 KB, so the snapshot would be dropped.
9. **Server snapshot cache.** `server/src/state/market.ts` serves cached snapshots to second and later subscribers of a key (`gateway/ws.ts` `#subscribe`). It ignores Indicators events, so later subscribers would get bars with no indicator history.
10. **View positioning.** `ChartPanel` positions the visible range only when the symbol or timeframe changes. A fresh 90-bar snapshot after the warm-up, on the same key, would keep the logical range set for one bar and show the oldest candles.

## Correctness Properties

Property 1: Bug Condition - Indicator points align to candle open times

_For any_ sequence of trades fed to the engine and any subscribed (symbol, timeframe), every live `Indicators` event SHALL have `ts` equal to the `t` of the `Candle` event that comes just before it. _For any_ sequence of `Indicators` events with arbitrary `ts` and timeframe applied to the web store (and to the TUI `App`), the stored points of each key SHALL have `t = bucket_start(t, timeframe)`, hold at most one point per candle open time, be strictly ascending, hold at most 500 points, and hold for each `t` the values of the last event in that bucket. `indicatorLineData` SHALL produce only times that are open times of stored candles.

**Validates: Requirements 2.1, 2.2**

Property 2: Bug Condition - Replay warm-up history equals normal play

_For any_ valid fixture (one or more symbols) and any set of subscriptions made before the load, with `k` = the number of first-loop lines whose `recv < last.recv − 1_800_000`: running `Engine::warm_up(lines[..k])` SHALL emit no Trade, Book, live Candle, live Indicators, Fill, or OrderAck event while the lines are applied. It SHALL then leave every candle ring, indicator state and indicator history, order book, and last trade price equal to an engine that played `lines[..k]` through `on_market`. The fresh snapshot events it emits for each subscribed key SHALL equal that engine's `subscribe` answer for the key. `k` SHALL depend only on the `recv` values, not on the speed. `k = 0` (span ≤ 30 min) SHALL emit no events at all.

**Validates: Requirements 2.3, 2.4**

Property 3: Bug Condition - Backfill merge keeps the forming candle and never duplicates a time

_For any_ trade-built ring of one key (0 to 500 bars), any known or unknown market time, and any list of venue bars (unsorted, duplicated, overlapping the live range, misaligned, or OHLC-inconsistent), `merge_history` SHALL produce a ring that is strictly ascending by `t` with no duplicate `t` and at most 500 bars (the newest are kept). Every bar with `t ≥ cutoff` SHALL be byte-equal to the live bar before the merge, so the forming candle is unchanged. Every bar with `t < cutoff` SHALL come from a valid, aligned venue bar. Every bar SHALL satisfy `low ≤ open, close ≤ high`. After the merge, the key's indicator state and history SHALL equal those of a fresh `SymbolIndicators` fed the merged ring in order. For any key, at most one `on_history` call per engine run SHALL change state. A second success and any result for a key already marked done SHALL be no-ops.

**Validates: Requirements 2.5**

Property 4: Bug Condition - Snapshots carry per-candle indicator history

_For any_ sequence of trades, warm-ups, and backfills followed by `subscribe(symbol, tf)`, the snapshot's `indicators` SHALL be `Some`, strictly ascending by `t`, with every `t` the `t` of a bar in the same snapshot. For every bar the key held while subscribed, the values SHALL equal the `values` of the last live `Indicators` event emitted for that bar's `t`. _For any_ sequence of engine Candle and Indicators events applied to the server `MarketState`, the cached snapshot SHALL carry the same bars and indicator points that the web store holds after the same events. After any snapshot, the stored indicator points of that key in the web store, the server cache, and the TUI SHALL equal the snapshot's points: no point from before the snapshot remains. _For any_ 500 bars and 500 points with extreme i64 and f64 values, the encoded snapshot line SHALL be at most `MAX_EVENT_LINE_BYTES` (512 KiB).

**Validates: Requirements 2.6, 2.7**

Property 5: Bug Condition - Web merge stays ordered and incremental chart updates equal a full setData

_For any_ sequence of candle snapshots (including unsorted or duplicated bars), live bars (forming, new, or late), and Indicators events applied to the web store, every stored candle list and point list SHALL be strictly ascending and unique by `t` and hold at most 500 items. _For any_ such sequence split into render batches, starting from a model chart series, applying each `planChartSync` result (`setData` or a list of `update` calls) SHALL leave the model series, restricted to times at or after the first stored time, equal to `setData(barsToCandles(stored bars))`. The same SHALL hold for the volume series and each enabled indicator line. When a batch only changes the forming bar or appends newer bars, the plan SHALL be `update` with exactly the changed bars, and SHALL convert no other bar.

**Validates: Requirements 2.8**

Property 6: Bug Condition - Fixed web layout with no page overflow

_For any_ panel in the web layout spec (`web/lib/layout.ts`), the panel SHALL sit in exactly one named grid area, and every named area SHALL hold exactly one element. The only `auto` row tracks SHALL be the status-bar and command-bar rows. Every other row and column track SHALL be a fixed length or `minmax(0, …fr)`. Every grid child SHALL carry `min-h-0` and `min-w-0`. Every content panel body SHALL be `overflow-auto` (the chart and the account panel use `overflow-hidden` with their own inner scroll containers). The page root and `<body>` SHALL be `h-dvh overflow-hidden`. No component in the grid SHALL use `row-span-*` or `col-span-*`.

**Validates: Requirements 2.9, 2.10**

Property 7: Bug Condition - Bounded tape with stable keys

_For any_ sequence of Trade events across symbols applied to the web store, the tape SHALL hold at most `MAX_TAPE` (200) entries, newest first, with unique ids that strictly decrease from the top. An entry's id SHALL never change while the entry is stored. _For any_ selected symbol, `tapeRows(tape, symbol)` SHALL return at most `TAPE_ROWS` (50) entries of that symbol, newest first. After one more trade of the selected symbol, the result SHALL equal `[new, ...previousRows].slice(0, 50)` by id, so every row still shown keeps its key.

**Validates: Requirements 2.11**

Property 8: Preservation - Candles and indicator values unchanged

_For any_ trade sequence (where isBugCondition does not apply to the candle math), the fixed Candle_Builder SHALL produce the same bars as the original, satisfying P4, P5, and P6. The fixed Indicator_Engine SHALL produce the same `values` for every bar update as the original (P11, P12, P13). The sequence of Candle events and of Indicators `values` emitted for subscribed keys SHALL equal the original's, with only the Indicators `ts` field differing.

**Validates: Requirements 3.1, 3.2, 3.3**

Property 9: Preservation - Replay timing, validation, and determinism

_For any_ fixture whose span is at most 30 minutes and any speed from 1 to 50, the fixed `ReplaySchedule` SHALL yield the same lines with the same delays as the original. _For any_ fixture and speed, the lines and delays of loops 1, 2, … SHALL equal the original's loops 1, 2, …. Replaying the same fixture with the same Commands twice SHALL produce identical non-heartbeat event sequences (P7). Speeds outside 1 to 50, invalid names, and unparsable fixtures SHALL keep producing the same Error events.

**Validates: Requirements 3.4, 3.5**

Property 10: Preservation - Orders, accounts, and safety

_For any_ interleaving of order Commands and market data (with a warm-up and backfills mixed in), each account's OrderAck, OrderRejected, Fill, and Position events SHALL equal running that account alone (P28). The warm-up SHALL produce no Fill or OrderAck for orders that were open before it. The Router, Risk_Engine, Kill_Switch, and account routing properties (P18, P19, P34, P35) SHALL keep holding unchanged. Every backfill request SHALL be an HTTPS GET to `api.backpack.exchange` `/api/v1/klines` or `api.coinbase.com` `/api/v3/brokerage/market/products/{id}/candles`, with no credential header. No backfill or warm-up SHALL write to the Journal or to any file.

**Validates: Requirements 3.6, 3.7, 3.8, 3.9, 3.14**

Property 11: Preservation - Client display and interaction

_For any_ sequence of server messages that are not in C, the web store and the TUI `App` SHALL reach the same candles, book, positions, orders, watchlist prices, and tape contents (ignoring the new tape ids) as the original. The TUI SHALL keep redrawing at most 30 times per second and only when dirty. Zoom, pan, crosshair, timeframe keys, and indicator toggles SHALL keep their behavior. Every snapshot SHALL position the view on the newest candles.

**Validates: Requirements 3.10, 3.11, 3.12, 3.13**

## Fix Implementation

### Design Decisions (resolving the open points)

**D1. How the pure core takes backfilled candles: a method call, not a Command.** The core gets `Engine::on_history(symbol, timeframe, bars)` and `Engine::on_history_failed(symbol, timeframe, reason)`, called by the runtime when a backfill task finishes.

The alternative was a `Command::InjectHistory`. It was rejected because Commands arrive on stdin from the server (Req 18.4). An injection Command would let any stdin writer rewrite market history, and it would need Zod schemas and ts-rs output for a message the server must never send.

The core decides when a backfill is needed. In backfill mode (`Engine::with_backfill()`, live only), a `Subscribe` for a key with no backfill state marks it `InFlight` and queues a `HistoryRequest { symbol, timeframe }`. The runtime drains the queue with `take_history_requests()` after each command. The core does no I/O and reads no clock. The runtime picks the request's end time from the wall clock, which is allowed in `runtime.rs`.

Backfill state per key:
- `None` → `InFlight` on `Subscribe`.
- `InFlight` → `Done` on `on_history`.
- `InFlight` → `None` on `on_history_failed`, so the next `Subscribe` retries.
- `Done` keys never request again in this engine run.

The server forwards `Subscribe` to the engine only for the first subscriber of a key (`gateway/ws.ts`) and on every engine restart. So after a failure, a retry happens when the key is subscribed again after its last unsubscribe (for example, a timeframe switch away and back), or after an engine restart. This matches the approved rule ("a later subscribe can retry") and keeps the request rate bounded by user actions.

**D2. Merging venue bars with live bars: live trades own everything from the cutoff on.**
```
cutoff(key) =
  ring.front().t                     if the ring has bars (all trade-built: a key is merged once)
  bucket_start(market_now, tf)       else if any market message has been processed
  max(venue_bars.t)                  else (the newest venue bar is treated as forming)
merged = valid_aligned(venue_bars).filter(t < cutoff).sorted().dedup_by_t(last wins)
         ++ ring
keep the newest 500
```
Venue bars at or after the cutoff are dropped. This includes the venue's forming candle and any kline for a minute the engine already started building, so volume is never counted twice.

The cost is that the first live bar may under-count the trades before the engine connected. That bar is partial either way, and over-counting is worse.

A venue bar is valid when:
- `t == bucket_start(t, tf)`;
- `0 < low ≤ open, close ≤ high`;
- `volume ≥ 0`.

Invalid bars are dropped, counted, and logged at debug. They never panic (rust.md). After a merge that changed the ring, the key's `SymbolIndicators` is rebuilt by feeding the merged ring in order to a fresh instance. This takes 500 bars at most and keeps indicator state consistent with the bars. A late trade older than an injected 1m bar, whose bucket is older than a higher-timeframe ring's oldest bar, is dropped as `late` by the existing rule ("any ring TooOld drops the trade"). This fails safe. P6 is checked only on trade-built rings.

**D3. Protocol shape: an optional field on `Candle`.**
```rust
/// One candle's indicator values; `t` is the candle open time (protocol event.rs, new).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = crate::TS_EXPORT_DIR)]
pub struct IndicatorPoint {
    #[ts(type = "number")]
    pub t: TimeMs,
    pub values: IndicatorValues,
}

Candle {
    symbol: String,
    timeframe: Timeframe,
    snapshot: bool,
    bars: Vec<Bar>,
    /// Snapshot only: one point per history bar that has values, ascending by `t`, each `t`
    /// the `t` of a bar above. `None` (omitted on the wire) on live updates.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    indicators: Option<Vec<IndicatorPoint>>,
}
```
Why this shape:
- **One atomic message.** The snapshot replaces candles and indicator points together, which removes the stale-point bug (1.6) by construction. A separate `IndicatorsSnapshot` event could arrive without its candle snapshot, for example when the server cache answers a later subscriber or around a reconnect. Every consumer would then need to pair two messages.
- **Backward-safe.** Live Candle JSON is byte-identical to today's. Old JSON without the field parses to `None`. Consumers that ignore unknown keys (Zod strips them, serde ignores them) keep working. `protocol_version` stays 2.
- **TS output.** ts-rs gives `indicators?: Array<IndicatorPoint>`. Regenerate with `bun run gen:protocol`. Never hand-edit `shared/protocol/*.ts`. Add `export type { IndicatorPoint } from "./IndicatorPoint";` to the hand-written `shared/protocol/index.ts`.

The `subscribe` answer keeps its trailing `Indicators` event for the newest bar (preservation 3.2). It now equals the last history point.

Line size: a worst-case 500-bar snapshot with 500 points is under 250 KB. The server's engine-stdout limit becomes `MAX_EVENT_LINE_BYTES = 512 KiB` (cause 8). The TUI already accepts 1 MiB WebSocket messages. Engine stdin keeps the 64 KiB `MAX_LINE_BYTES`.

**D4. Warm-up determinism and `StartReplay` speed.** The warm-up boundary is a pure function of the fixture's `recv` values: `k = count(first-loop lines with recv < last.recv − 1_800_000)`. It does not depend on speed or wall time. On a successful load, the runtime does three things in one synchronous step:
1. It takes `lines[..k]` from the schedule (`ReplaySchedule::take_warmup`).
2. It calls `engine.warm_up(msgs)`, which returns only the end-of-warm-up events.
3. It schedules `lines[k]` with zero delay.

No stdin Command can interleave with the warm-up. The same fixture and the same Commands, in the same order relative to market messages, give the same events as before (Req 6.6).

The speed applies only to what follows:
- `lines[k..]` of loop 0 play at `recorded_delay / speed`, with wall offsets measured from `lines[k].recv`.
- Loops 1, 2, … play the whole fixture shifted by `k·period`, with the same `period = span + LOOP_GAP_MS` as today.

Market time keeps increasing, because loop 1 starts at `lines[0].recv + period > last.recv`. A fixture with span ≤ 30 min has `k = 0`, so the warm-up returns no events and the schedule is identical to today's.

A later `StartReplay` (same or different fixture) runs its own warm-up against the current engine state. Overlapping market times then merge into existing bars, which is the same behavior as today's restart from line 0, now applied at once. The server sends `StartReplay` once per engine start, so this does not occur in normal operation. It is listed as a known limitation, and this fix does not change it.

Warm-up cost: the demo fixture's warm-up covers about 75 % of its lines. These are processed in one call. The release-build budget is under 1 s, measured in the integration test. The heartbeat may skip one tick, and `MissedTickBehavior::Skip` already handles that.

**D5. Web chart sync: series versions plus tail updates.** The store keeps `seriesVersion[key] = { snapshot, rewrite }`:
- `snapshot` increments on every snapshot for the key.
- `rewrite` increments when a live bar changes a bar older than the newest stored bar (a late revision).

`ChartPanel` remembers `{ viewKey, snapshot, rewrite, lastTime }` per series. The pure helper `planChartSync(prev, next)` returns:
- `set`, when there is no previous state, or the view key (symbol, timeframe, decimals) changed, or the snapshot or rewrite counter changed. A changed snapshot counter also repositions the view on the newest candles (cause 10).
- otherwise `update(bars with t ≥ prev.lastTime)`. The chart calls `series.update` on each changed bar in ascending order. Only those bars are converted.

When the store drops its oldest bar at the 500 cap, the chart series keeps that bar until the next `setData`. It is real data, off-screen to the left, and it avoids a full `setData` per new candle. Property 5 compares series from the first stored time on for this reason.

Indicator lines use the same versions. A line toggled on gets a new series and a `setData`. Indicator points whose time has no stored candle are dropped, so line series never add time-axis slots.

### Changes Required

**File**: `rust/crates/protocol/src/event.rs`, `lib.rs`, `strategies.rs`, `codec.rs`

1. Add `IndicatorPoint` and `Candle.indicators` as in D3. Re-export `IndicatorPoint` from `lib.rs`.
2. Update the proptest strategies so P1 (JSON round trip) generates both `None` and `Some(points)`.
3. Add `pub const MAX_EVENT_LINE_BYTES: usize = 512 * 1024;` with a doc comment saying the server's engine-stdout reader uses the same value.
4. Add event.rs tests: live Candle JSON unchanged, snapshot JSON with `indicators`, and old JSON without the field parsing to `None`.

**File**: `rust/crates/engine/src/indicators.rs`

**Struct**: `SymbolIndicators`

1. **History ring.** Add a `history: VecDeque<IndicatorPoint>` field, capped at `MAX_BARS`. In `update`, after computing `peek`, replace the last point when `bar.t` equals it, and push otherwise. Late bars (`None` result) leave the history unchanged.
2. **Accessors.** Add `pub fn history(&self) -> impl Iterator<Item = &IndicatorPoint>`.
3. **Rebuild.** Add `pub fn from_bars(bars: &[Bar]) -> Self`, which feeds every bar through `update`.
4. **No value change.** `commit`, `peek`, and every indicator stay as they are (Property 8).

**File**: `rust/crates/engine/src/candles.rs`

**Function**: new `CandleBuilder::merge_history(&mut self, symbol, tf, bars: &[Bar], market_now: Option<TimeMs>) -> HistoryMerge`

1. Validate, align-check, sort, and dedupe the venue bars. Compute the cutoff as in D2. Prepend the bars before the cutoff to the ring and keep the newest `MAX_BARS`.
2. Return `HistoryMerge { changed: bool, added: usize, invalid: u64 }`. `on_trade` is not touched.

**File**: `rust/crates/engine/src/core.rs`

**Struct/Functions**: `Engine`, `on_market`, `subscribe`, new `warm_up`, `with_backfill`, `take_history_requests`, `on_history`, `on_history_failed`

1. **Indicator ts fix.** In the Trade arm, emit `Event::Indicators { ts: bar.t, .. }` instead of the trade `ts`.
2. **Snapshot builder.** Add `fn snapshot_events(&self, symbol, tf) -> Vec<Event>`. It builds `Candle { snapshot: true, bars, indicators: Some(points whose t is in bars) }`, where the points come from a merge-join of the indicator history with the bars (O(n)), followed by the current `Indicators` event when there is one. `subscribe` uses it.
3. **Warm-up.** Add `pub fn warm_up(&mut self, msgs: Vec<MarketMsg>) -> Vec<Event>`. For each message it applies the same state changes as `on_market`: `now`, `last_price`, candles, indicators (with history), and books (marked dirty). It emits no events and runs no matcher pass. Invalid deltas are counted and logged at debug, with no Error event. With zero messages it returns nothing. Otherwise it returns:
   - `snapshot_events` for every subscribed key, in `subscriptions` order (symbol, then `Timeframe::ALL`);
   - then a `Position` refresh for every account with an open position in a symbol whose last price changed, in `AccountId` order, so unrealized P&L is not stale.

   Book `last_emit_ts` is left alone, so the first post-warm-up message of each symbol emits its Book.
4. **Backfill bookkeeping.** Add a `backfill: Option<BTreeMap<(String, Timeframe), BackfillState>>` field. It is `None` unless the engine was built with `with_backfill()`. Also add a `history_requests: Vec<HistoryRequest>` queue. `subscribe` queues a request per D1.
5. **`on_history`.** Only acts when the key is `InFlight`. It calls `merge_history`, marks the key `Done`, and rebuilds the key's `SymbolIndicators` with `from_bars` when the ring changed. If the key is subscribed and the ring changed, it returns `snapshot_events`. Otherwise it returns nothing.
6. **`on_history_failed`.** Clears the key's state. It returns one `Event::Error { code: FeedDisconnected, message }` that names the symbol and timeframe, with the reason cut to 200 characters. The existing code is reused so the `ErrorCode` set does not change.
7. Update the module docs: event order on subscribe, warm-up, and backfill.

**File**: `rust/crates/engine/src/feed/replay.rs`

**Struct**: `ReplaySchedule`

1. Add `pub const WARMUP_WINDOW_MS: TimeMs = 30 * 60 * 1000;` and `pub fn warmup_len(lines: &[FixtureLine]) -> usize`, which counts the first-loop lines with `recv < last.recv − WARMUP_WINDOW_MS`, using checked subtraction.
2. Add `pub fn take_warmup(&mut self) -> Vec<MarketMsg>`. It is only valid before the first `next()`. It returns the `k` warm-up messages unshifted (loop 0), sets `index = k`, `origin = lines[k].recv`, and `last_wall_ms = None`. With `k = 0` it returns an empty Vec and changes nothing. `k` is always below `lines.len()`, because the last line is never older than itself.

**File**: `rust/crates/engine/src/feed/backfill.rs` (new)

1. A `HistoryFetcher` trait: `fetch(symbol, tf, end_s) -> BoxFuture<Result<Vec<Bar>, String>>`. Implementations: `BackpackHistory` calls `fetch_klines`, and `CoinbaseHistory` calls `fetch_candles`. Both use the existing `https_get` (rustls, `ring`) and the existing `DropStats`, with no headers beyond the existing ones. Remove the two `TODO(… live Subscribe wiring)` notes.
2. `run_backfill(requests: mpsc::Receiver<HistoryRequest>, results: mpsc::Sender<HistoryResult>, fetcher)`: one request at a time, at least `REST_PACING` (200 ms) between requests, and `end_s` from the wall clock. Tests use a fake fetcher and never touch the network (tech.md).

**File**: `rust/crates/engine/src/runtime.rs`

1. **Live wiring.** Live mode builds `Engine::with_backfill()`. `LiveFeed::start` also spawns `run_backfill` with the fetcher for the venue. After each `engine.on_command`, the runtime drains `take_history_requests()` into the request channel. If the channel is full, it calls `on_history_failed(…, "backfill queue full")`. A new `Wake::History(result)` branch calls `on_history` or `on_history_failed`.
2. **Warm-up wiring.** `Replay::on_loaded` takes `&mut Engine`. After `ReplaySchedule::new`, it calls `take_warmup()` and then `engine.warm_up(msgs)`, then schedules the first remaining line with zero delay. It returns the warm-up events and logs `warmup_lines` at info.
3. Replay mode never builds requests (`Engine::new()`).

**File**: `rust/crates/tui/src/app.rs`

**Function**: the `Event::Candle` arm of `update`, plus a new `App::apply_indicator_history`

1. On a snapshot for the selected key, replace that key's `IndicatorSeries` with the snapshot's points (floored, merged, capped at 500). With `None`, clear it.
2. Match patterns on `Event::Candle` gain `..` or the new field. Live handling is unchanged.

**File**: `server/src/protocol.ts`, `server/src/engine/lines.ts`, `server/src/engine/supervisor.ts`

1. Add `IndicatorPointSchema = z.object({ t: TimeMsSchema, values: IndicatorValuesSchema })` and `indicators: z.array(IndicatorPointSchema).optional()` on the candle schema. Add `Assert<Same<typeof IndicatorPointSchema, IndicatorPoint>>` to the drift checks.
2. Export `MAX_EVENT_LINE_BYTES = 512 * 1024` from `lines.ts` and pass `maxBytes: MAX_EVENT_LINE_BYTES` to the engine-stdout `LineSplitter` in `supervisor.ts`. The splitter default stays 64 KiB.

**File**: `server/src/state/market.ts`

**Class**: `MarketState`

1. Add an `#indicators` map per candle key. A snapshot sets it from `event.indicators ?? []`, normalized (sorted, deduped, capped at 500). A live `indicators` event merges `{ t: floor(ts, tf), values }` only into a key that already has a cached snapshot, matching the rule for live bars.
2. `snapshot()` returns `indicators` with the cached points. `dropCandles` and `clear` drop them too.

**File**: `web/lib/store.ts`, `web/lib/indicatorData.ts`, `web/lib/chartData.ts`

1. **Alignment.** Add `bucketStartMs(ts, tf)` to `chartData.ts`. `applyIndicatorsEvent` stores `t: bucketStartMs(event.ts, event.timeframe)` and rejects non-finite or negative `ts`.
2. **Snapshots replace both.** In `applyCandleEvent`, a snapshot sorts and dedupes `bars` (last wins), keeps the newest 500, sets `indicators[key]` from `event.indicators ?? []` (aligned, deduped, capped), and increments `seriesVersion[key].snapshot`. A live bar older than the newest stored bar increments `seriesVersion[key].rewrite`.
3. **Types.** `IndicatorPoint` in `indicatorData.ts` becomes the generated protocol type (same shape).
4. **Chart helpers.** `indicatorLineData` takes an optional set of candle times and drops points outside it. Add `planChartSync` (D5), which replaces `planSeriesUpdate` and `seriesShape`. Their tests move to the new helper.
5. **Tape ids.** `TapeEntry` gains `id: number`. The store keeps `nextTapeId`, and each Trade gets `id = nextTapeId++`. `MAX_TAPE` stays 200.

**File**: `web/components/ChartPanel.tsx`

1. Replace both data effects with `planChartSync`. On `set`: convert all bars and points, call `setData`, and position the view when the snapshot counter or view key changed. On `update`: convert only the returned bars and points, and call `update` on each in ascending order.
2. Toggling a line on still creates its series and calls `setData`. Toggling it off still removes the series.

**File**: `web/lib/layout.ts` (new), `web/app/page.tsx`, `web/app/layout.tsx`, `web/components/StatusBar.tsx`, `web/components/CommandBar.tsx`

1. `layout.ts` exports the grid spec as data. Columns `12rem minmax(0,1fr) 16rem`, rows `auto minmax(0,1fr) 12rem auto`, areas:
   ```
   "status  status  status"
   "watch   chart   side"
   "tape    account account"
   "command command command"
   ```
   It also exports a `PANEL_AREA` map. This keeps today's arrangement: status on top, watchlist on the left, chart in the middle, book and ticket on the right, the account panels at the bottom middle and right, the tape at the bottom left under the watchlist, and the command bar at the bottom (3.13). The watchlist now spans one row. It holds three symbols.
2. `page.tsx`: `<main className="grid h-dvh overflow-hidden gap-1 p-1">` with `style={{ gridTemplateColumns, gridTemplateRows, gridTemplateAreas }}` taken from `layout.ts`. Each grid child gets `style={{ gridArea }}` and `min-h-0 min-w-0`. Remove `row-span-2` and `col-span-2`. The side column `div` is `flex min-h-0 min-w-0 flex-col`, with the Order book panel `min-h-0 flex-1`.
3. `Panel` gains `body: "scroll" | "clip"`, default `scroll`, which maps to `min-h-0 flex-1 overflow-auto` or `overflow-hidden`. The chart uses `clip`, so the ResizeObserver never sees scrollbars. The account panel uses `clip` with an inner `flex min-h-0 flex-col`, and each of its three columns is `min-h-0 overflow-auto`. The fixed `h-[calc(100%-1.25rem)]` is removed.
4. `layout.tsx`: body `crt-screen h-dvh overflow-hidden antialiased` (replacing `min-h-screen`).
5. `StatusBar` and `CommandBar` drop `col-span-3`. The page places them by area. Overlays (`PreviewDialog`, `ConfirmDialog`, `RejectionToast`) stay `fixed` and are unchanged. `OrderHotkeys` renders `null`.

**File**: `web/components/TradesTape.tsx`, `web/lib/bookView.ts`

1. Add a pure `tapeRows(tape, symbol): readonly TapeEntry[]` to `bookView.ts` (filter by symbol, first `TAPE_ROWS`).
2. The component selects with `useMemo(() => tapeRows(tape, symbol), [tape, symbol])` and renders a `memo` `TapeRow` per entry with `key={entry.id}`, so existing rows do not re-render. The newest row stays at the top. The panel body scrolls (`overflow-auto`) if 50 rows do not fit.

## Testing Strategy

### Validation Approach

Testing runs in two phases. First, exploratory tests on the unfixed code produce counterexamples for each part of C and confirm or refute causes 1 to 10. Then fix-checking and preservation tests run against the fixed code. Rust tests use proptest, and TS tests use fast-check under `bun test`. No test contacts Backpack, Coinbase, or any network service (tech.md). Commands such as `bun run check` and `cargo test` need the user's approval before each run (tech.md standing rule).

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix. Confirm or refute the root cause analysis. If we refute, we will need to re-hypothesize.

**Test Plan**: Add tests that drive the engine core, the replay schedule, the web store, the chart helpers, and the layout files, and assert the expected behavior. Run them on the UNFIXED code and record the failures.

**Test Cases**:
1. **Engine indicator ts** (`core.rs`): subscribe BTC-USD 1m and trade at 61 234 ms. Assert that the Indicators `ts` is 60 000 (will fail: it is 61 234).
2. **Web point per second** (`store.indicators.test.ts`): apply three Indicators events within one minute. Assert one stored point at the minute start (will fail: three points).
3. **Replay history** (`runtime.rs` test with a 2 h synthetic fixture): start at speed 1 and subscribe. Assert that a snapshot with at least 85 bars arrives within the first release (will fail: at most one bar).
4. **Subscribe indicator history** (`core.rs`): trade across 30 minutes, then subscribe. Assert that the snapshot carries 30 indicator points (will fail: the field does not exist, and only one Indicators event is sent).
5. **Stale points** (`store.indicators.test.ts`): points at t = 0..9 min, then a snapshot with bars from 20 min on. Assert that no point with t < 20 min remains (will fail).
6. **Full set per new candle** (`chartData.test.ts`): `planSeriesUpdate` for a list that gained one bar. Assert `update` (will fail: `set`).
7. **Layout** (`layout.test.ts`, static): assert that every grid row other than the status and command rows is fixed or `minmax(0,…)`, and that `page.tsx` has no `row-span-`/`col-span-` (will fail: Watchlist `row-span-2`, Tape in an auto row, body `min-h-screen`).
8. **Tape keys** (`bookView.test.ts`): after a new trade, assert that the keys of the previous rows are unchanged (will fail: keys shift by index).
9. **Line limit** (`lines.test.ts` / protocol test): encode a worst-case 500-bar snapshot with 500 points. Assert that it fits the engine-stdout limit (will fail at 64 KiB, confirming cause 8).

**Expected Counterexamples**:
- Indicators `ts` values that are not multiples of the timeframe length, and several stored points in one bucket.
- One-bar snapshots at replay start, and snapshots without indicator history.
- `set` plans on every new candle, rows whose keys shift, and an `auto` row holding a growing panel.
- If case 3 passes on unfixed code, the fixture or `REPLAY_SPEED` assumption is wrong and cause 2 must be re-examined. If case 6 passes, cause 6 is wrong.

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed system produces the expected behavior.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  result := F'(input)
  ASSERT expectedBehavior(input, result)
END FOR

FUNCTION expectedBehavior(input, result)
  MATCH input
    WebIndicatorEvent e:
      RETURN stored_point(e).t == bucket_start(e.event.ts, e.timeframe)
             AND count(points with that t) == 1
             AND chart_times(lines) ⊆ chart_times(candles)
    ReplayStart r:
      k := warmup_len(r.fixture_lines)
      RETURN no Trade/Book/live Candle/live Indicators/Fill during warm-up
             AND state(F') == state(play_normally(lines[..k]))
             AND fresh snapshot per subscribed key after warm-up
             AND remaining lines play at r.speed, then whole-fixture loops
    LiveSubscribe l:
      RETURN (one backfill request for the key this run)
             AND (success  ⇒ merged ring sorted, unique, forming bar unchanged,
                             snapshot with indicator history if subscribed)
             AND (failure  ⇒ Error event, live bars kept, state cleared for retry)
    SubscribeAnswer s:
      RETURN snapshot.indicators = per-bar points, t ⊆ bar times, values = last update
    ClientSnapshot c:
      RETURN stored_points(key) == normalize(snapshot.indicators)
    ChartLiveUpdate u:
      RETURN plan == update(changed bars only) AND model_series == setData(store)
    WebLayout w:
      RETURN page height == viewport AND no panel size depends on content
             AND overflowing panel scrolls inside itself
    TapeTrade t:
      RETURN rows ≤ 50, newest first, new row added, existing row keys unchanged
  END MATCH
END FUNCTION
```

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed system produces the same result as the original.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT F(input) = F'(input)        // modulo Indicators.ts and the new tape id
END FOR
```

**Testing Approach**: Property-based testing is the main tool for preservation, because:
- it generates many trade, book, order, and message sequences automatically;
- it finds edge cases (gaps, late trades, loop boundaries, cap overflow) that hand-written cases miss;
- it gives strong evidence that inputs outside C behave the same.

**Test Plan**: Before changing any code, record the unfixed behavior as golden data:
- the full non-heartbeat event stream of the engine fed the first 20 minutes of `fixtures/demo.jsonl` (a span under 30 min, so no warm-up applies);
- the `ReplaySchedule` delays for random short fixtures;
- web store states for random message sequences.

Then write property tests that compare the fixed code against that data or against kept reference functions.

**Test Cases** (from bugfix §3):
1. **3.1 Candle math**: the existing P4, P5, and P6 proptests keep passing unchanged. Add one case that runs `merge_history` and then trades, and checks P4 on the merged ring.
2. **3.2 Snapshot contract**: the existing `snapshot_is_capped_at_500_bars`, `snapshot_carries_history_and_comes_before_live_updates`, and `only_subscribed_keys_get_live_updates` keep passing, with `indicators` added to the expected events.
3. **3.3 Indicator values**: proptest over trade sequences. The `values` of every emitted Indicators event equal those of a reference engine built from the unfixed `SymbolIndicators::update` path (kept in the test module), and the existing P11, P12, and P13 pass.
4. **3.4 Determinism and validation**: P7 runs with a warm-up fixture (span > 30 min) at two speeds and compares event streams. The existing speed, name, and parse error tests pass. A loop-boundary test checks that market time increases.
5. **3.5 Short fixtures**: proptest that for any fixture with span ≤ 30 min and speed 1..=50, the fixed schedule yields exactly the unfixed lines and delays (the original `ReplaySchedule::new` path with `take_warmup` returning empty).
6. **3.6 Venue safety**: unit tests on `klines_path`/`candles_path` and the fetchers with a fake transport, asserting the host, path prefix, and no `Authorization`, API-key, or signature headers. A grep test asserts that `feed/backfill.rs` mentions no other host.
7. **3.7 No persistence**: a test asserts that `backfill.rs`, `core.rs`, and `replay.rs` call no file-write API. The server journal tests stay unchanged.
8. **3.8 and 3.9 Orders and accounts**: P28 runs with a warm-up and `on_history` calls mixed into the input. A new case places orders before a warm-up and asserts no Fill or OrderAck during it. The server P18, P19, P34, and P35 run unchanged.
9. **3.10 TUI**: the existing `apply_indicators` floor and `apply_candles` merge tests pass, and so do the redraw-limit tests. Add a test that a snapshot replaces the indicator series.
10. **3.11 Interaction**: `chartRange`, `chartKeys`, and toggle tests pass. A `planChartSync` test checks that a snapshot repositions and a rewrite does not.
11. **3.12 Tape and watchlist content**: proptest that the fixed store's `tape` without `id` equals the unfixed store's `tape`, and that `lastTrade` matches, for any trade sequence.
12. **3.13 Arrangement**: the static layout test asserts the area order above (status top, command bottom, watchlist left of chart, side right of chart, tape below watchlist, account below chart). Overlays keep `fixed`. Resizing is checked manually.
13. **3.14 Engine restart**: the server supervisor and gateway restart tests pass unchanged. Add a case that the cache drops indicator points on `clear()`.

### Unit Tests

- Engine: Indicators `ts == bar.t` for live updates. `snapshot_events` aligns points to bars, including a late-inserted bar with no point. `warm_up` with zero messages returns nothing, and with messages returns snapshots for subscribed keys only. `on_history` for each cutoff case (ring present, empty ring with known market time, no market time), invalid and misaligned venue bars dropped, `Done` keys ignored, and failure clearing the state with an Error message naming the symbol and timeframe.
- Replay: `warmup_len` at the 30-minute boundary (exactly 30 min older is not warm-up, 30 min + 1 ms is), `take_warmup` origin and first delay of 0, loop 1 shift unchanged.
- Protocol: JSON shapes for live and snapshot Candle, old JSON parsing to `None`, and the worst-case line size under `MAX_EVENT_LINE_BYTES`.
- Server: Zod accepts a snapshot with and without `indicators` and rejects a malformed point. `MarketState` caches and merges points, ignores points for uncached keys, and its `snapshot()` carries the points. The supervisor accepts a 300 KB engine line and drops one over 512 KiB.
- Web: `bucketStartMs` for every timeframe and day boundaries. Snapshot normalization (unsorted, duplicates). `planChartSync` for each `set` trigger and for `update`. `tapeRows` limits and order. Layout constants and the grep checks on `page.tsx`, `layout.tsx`, `StatusBar.tsx`, and `CommandBar.tsx`.
- TUI: snapshot with `indicators` replaces the series, and `None` clears it.

### Property-Based Tests

- **Property 1** (proptest `core`, fast-check `store.indicators`, proptest `tui app`): random trade sequences and timeframes, and random `ts` values for Indicators events; check alignment, one point per bucket, last values win, and line times within candle times.
- **Property 2** (proptest `core::properties`): random multi-symbol fixtures with spans from 0 to 3 h, random pre-load subscriptions, and two speeds; compare warm-up state and snapshots against normal play.
- **Property 3** (proptest `candles` + `core`): random live rings, market times, and venue bar lists, including duplicates, overlaps, misalignment, and bad OHLC; check ordering, uniqueness, the cap, the unchanged forming bar, the cutoff, P4, indicator rebuild equality, and at most one effective merge.
- **Property 4** (proptest `core`; fast-check `server/state/market`, `web/store`): snapshot points equal the last live values per bar. Server cache and web store agree after the same event sequence. Snapshots replace points everywhere. Worst-case encoded size stays under the limit.
- **Property 5** (fast-check `web/lib/chartData` + store): random event sequences and render batching. A model series applies `setData`/`update` the way Lightweight Charts does (update replaces an equal time or appends a newer one) and is compared with `setData` of the store data from the first stored time on. Plans for forming or appended changes are `update` with exactly the changed bars.
- **Property 6** (fast-check over the layout spec): for every panel id and every area, the area and track checks above. Content heights are not generated, because the check is static.
- **Property 7** (fast-check `web/store` + `bookView`): random trade sequences across three symbols and random selected symbols; check bounds, id order and stability, and the one-row-added relation.
- **Properties 8 to 11**: the preservation cases listed above, using the existing P1, P4 to P7, P11 to P13, P18, P19, P28, P34, and P35 suites plus the new golden comparisons.

### Integration Tests

- **Replay end to end** (`server/src/integration/replay.integration.test.ts`): start the real engine with `fixtures/demo.jsonl` at speed 1 and subscribe BTC-USD 1m through the server WebSocket. Expect a snapshot with 85 to 95 bars and as many indicator points (minus each indicator's warm-up `null`s) within a few seconds of `start_replay`, then live updates whose Indicators `ts` equals the Candle `t`. Record the warm-up wall time and keep it under 1 s in release builds.
- **Later subscriber**: a second client subscribing to the same key gets the cached snapshot with indicator points from the server cache.
- **Live backfill with a fake venue**: run the engine runtime with `with_backfill()` and a fake `HistoryFetcher` returning klines that overlap live trades. Check that one request goes out per key, the snapshot is merged and carries history, a failure gives an Error event, and a resubscribe after unsubscribe retries.
- **Web layout (manual, recorded in the PR)**: in Chrome and Firefox at 1280×720 and 1920×1080, run the replay at speed 50 for 2 minutes. The page never scrolls, the chart keeps its size, and the tape, book, and account panels scroll inside. Resize the window and check that the chart follows.
- **Web chart (manual)**: on 1m after the warm-up, the chart shows about 90 candles of normal width, with distinct time labels and EMA and VWAP over the history. Switch to 5m and back, then reconnect by restarting the server: no stale line segments remain, and the view sits on the newest candles.
- **TUI (manual, `MANUAL_CHECK.md`)**: after the warm-up, the CandleChart_Widget shows history candles with indicator lines over them.
