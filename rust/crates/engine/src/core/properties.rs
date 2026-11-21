//! Property test P7 from the design's property table (Task 4.5): the engine core is
//! deterministic (Req 6.6).
//!
//! A case is a fixture and a list of `subscribe` / `unsubscribe` Commands for random
//! (symbol, timeframe) keys, each inserted at a random position among the fixture's messages.
//! The fixture is one of:
//! - lines from [`valid_market_msg`] with random `recv` gaps of 0 to 5 s, either keeping the
//!   generated `ts` (any i64, so most trades are late, dropped, or out of range) or with `ts`
//!   set to `recv` (time-ordered, so candles build and live updates flow);
//! - [`synth`] output for a random seed, a duration of 0 to 3 minutes, and 1 to 3 symbols.
//!
//! The property drives [`Engine::on_command`] and [`Engine::on_market`] directly, without the
//! async runtime, and checks:
//! 1. two fresh engines fed the same merged input produce the same Events, excluding
//!    Heartbeat (the core emits none; the runtime adds them from the wall clock);
//! 2. [`ReplaySchedule`] at speed 1 and at speed 50 releases the same lines, over two full
//!    loops and the first line of a third, and the first loop is the fixture itself;
//! 3. the engine fed the speed-1 lines and the engine fed the speed-50 lines, with the same
//!    Commands at the same positions, produce the same Events.
//!
//! The property runs proptest's default 256 cases.
//!
//! This file also holds the chart-and-tape-fix bug condition test for Property 1 (Task 1.1):
//! every live `Indicators` event carries the open time of its candle (bugfix 1.1, 2.1).

use proptest::collection::vec;
use proptest::prelude::*;
use proptest::sample::{Index, select, subsequence};
use protocol::{Command, Event, TimeMs, Timeframe, Venue};

use super::Engine;
use crate::feed::MarketMsg;
use crate::feed::fixture::FixtureLine;
use crate::feed::replay::ReplaySchedule;
use crate::feed::strategies::{known_symbol, valid_market_msg};
use crate::feed::synth::{DEFAULT_START_MS, SynthConfig, SynthSymbol, synth};

const MIN: TimeMs = 60_000;

/// A `subscribe` Command on the replay venue.
fn subscribe_cmd(symbol: &str, timeframe: Timeframe) -> Command {
    Command::Subscribe {
        venue: Venue::Replay,
        symbol: symbol.to_owned(),
        timeframe,
    }
}

/// One engine input, in arrival order.
#[derive(Debug, Clone)]
enum Input {
    Command(Command),
    Market(MarketMsg),
}

fn with_ts(mut msg: MarketMsg, new_ts: TimeMs) -> MarketMsg {
    match &mut msg {
        MarketMsg::Trade { ts, .. }
        | MarketMsg::BookSnapshot { ts, .. }
        | MarketMsg::BookDelta { ts, .. } => *ts = new_ts,
    }
    msg
}

fn generated_fixture() -> impl Strategy<Value = Vec<FixtureLine>> {
    (
        any::<bool>(),
        vec((0..=5_000_i64, valid_market_msg()), 1..80),
    )
        .prop_map(|(ts_is_recv, steps)| {
            let mut recv = DEFAULT_START_MS;
            steps
                .into_iter()
                .map(|(gap, msg)| {
                    recv += gap;
                    let msg = if ts_is_recv { with_ts(msg, recv) } else { msg };
                    FixtureLine { recv, msg }
                })
                .collect()
        })
}

fn synth_fixture() -> impl Strategy<Value = Vec<FixtureLine>> {
    (
        any::<u64>(),
        0..=3 * MIN,
        subsequence(SynthSymbol::ALL.to_vec(), 1..=SynthSymbol::ALL.len()),
    )
        .prop_map(|(seed, duration_ms, symbols)| {
            synth(&SynthConfig {
                seed,
                duration_ms,
                start_ms: DEFAULT_START_MS,
                symbols,
            })
        })
}

fn fixture() -> impl Strategy<Value = Vec<FixtureLine>> {
    prop_oneof![generated_fixture(), synth_fixture()]
}

fn timeframe() -> impl Strategy<Value = Timeframe> + Clone {
    select(Timeframe::ALL.to_vec())
}

fn command() -> impl Strategy<Value = Command> {
    prop_oneof![
        2 => (known_symbol(), timeframe()).prop_map(|(symbol, timeframe)| Command::Subscribe {
            venue: Venue::Replay,
            symbol,
            timeframe,
        }),
        1 => (known_symbol(), timeframe()).prop_map(|(symbol, timeframe)| Command::Unsubscribe {
            venue: Venue::Replay,
            symbol,
            timeframe,
        }),
    ]
}

/// The fixture's messages with each Command inserted at its position, in list order.
fn merge(lines: &[FixtureLine], commands: &[(Index, Command)]) -> Vec<Input> {
    let mut inputs: Vec<Input> = lines
        .iter()
        .map(|line| Input::Market(line.msg.clone()))
        .collect();
    for (at, cmd) in commands {
        let index = at.index(inputs.len() + 1);
        inputs.insert(index, Input::Command(cmd.clone()));
    }
    inputs
}

/// Runs a fresh engine over `inputs` and returns every Event except Heartbeat.
fn run(inputs: &[Input]) -> Vec<Event> {
    let mut engine = Engine::new();
    let mut events = Vec::new();
    for input in inputs {
        events.extend(match input.clone() {
            Input::Command(cmd) => engine.on_command(cmd),
            Input::Market(msg) => engine.on_market(msg),
        });
    }
    events.retain(|event| !matches!(event, Event::Heartbeat { .. }));
    events
}

/// The first `n` lines the schedule releases at `speed`.
fn replayed(lines: &[FixtureLine], speed: u32, n: usize) -> Vec<FixtureLine> {
    ReplaySchedule::new(lines.to_vec(), speed)
        .unwrap()
        .take(n)
        .map(|scheduled| scheduled.line)
        .collect()
}

proptest! {
    // Property P7 — validates Req 6.6
    #[test]
    fn p7_same_fixture_and_commands_give_the_same_events(
        lines in fixture(),
        commands in vec((any::<Index>(), command()), 0..16),
    ) {
        let inputs = merge(&lines, &commands);
        let first = run(&inputs);
        let second = run(&inputs);
        prop_assert_eq!(&first, &second);

        let n = 2 * lines.len() + 1;
        let slow = replayed(&lines, 1, n);
        let fast = replayed(&lines, 50, n);
        prop_assert_eq!(&slow, &fast);
        prop_assert_eq!(slow.get(..lines.len()), Some(lines.as_slice()));
        prop_assert_eq!(run(&merge(&slow, &commands)), run(&merge(&fast, &commands)));
    }
}

// ---------------------------------------------------------------------------------------------
// chart-and-tape-fix, Property 1: Bug Condition - Indicator points align to candle open times
// (engine). Written as an exploration test: it fails on the unfixed engine, which stamps live
// Indicators events with the trade time (bugfix 1.1). Task 3.1 makes it pass.
// ---------------------------------------------------------------------------------------------

const DAY: TimeMs = 24 * 60 * MIN;

/// Checks that every `Indicators` event in `events` directly follows a `Candle` event of the
/// same key and has `ts` equal to that candle's `t`. Returns the number of Indicators events.
fn check_indicator_ts(events: &[Event]) -> Result<usize, TestCaseError> {
    let mut count = 0;
    for (i, event) in events.iter().enumerate() {
        let Event::Indicators {
            symbol,
            timeframe,
            ts,
            ..
        } = event
        else {
            continue;
        };
        count += 1;
        let previous = i.checked_sub(1).and_then(|p| events.get(p));
        let Some(Event::Candle {
            symbol: candle_symbol,
            timeframe: candle_tf,
            bars,
            ..
        }) = previous
        else {
            return Err(TestCaseError::fail(format!(
                "Indicators event {event:?} does not follow a Candle event: {previous:?}"
            )));
        };
        prop_assert_eq!(candle_symbol, symbol);
        prop_assert_eq!(candle_tf, timeframe);
        let Some(bar) = bars.last() else {
            return Err(TestCaseError::fail("live Candle event without a bar"));
        };
        prop_assert_eq!(
            *ts,
            bar.t,
            "Indicators ts {} is not the candle open time {} ({:?})",
            ts,
            bar.t,
            timeframe
        );
    }
    Ok(count)
}

/// (price ticks, qty lots, gap ms before the trade).
fn trade_steps() -> impl Strategy<Value = Vec<(i64, i64, TimeMs)>> {
    vec((1..=10_000_000_i64, 1..=1_000_i64, 0..=3 * MIN), 1..60)
}

proptest! {
    // chart-and-tape-fix Property 1: Bug Condition (engine)
    // **Validates: Requirements 2.1** (bugfix.md 1.1, 2.1)
    #[test]
    fn bug_indicators_ts_is_candle_open_time(
        symbol in known_symbol(),
        timeframe in timeframe(),
        start in 0..=30 * DAY,
        steps in trade_steps(),
    ) {
        let mut engine = Engine::new();
        let _ = engine.on_command(subscribe_cmd(&symbol, timeframe));
        let mut ts = start;
        let mut seen = 0;
        for (price, qty, gap) in steps {
            ts += gap;
            let events = engine.on_market(MarketMsg::Trade {
                symbol: symbol.clone(),
                price: protocol::Price(price),
                qty: protocol::Qty(qty),
                side: protocol::Side::Buy,
                ts,
            });
            seen += check_indicator_ts(&events)?;
        }
        // Time-ordered trades on a subscribed key always produce live Indicators events.
        prop_assert!(seen > 0, "no live Indicators event was emitted");
    }
}

/// Concrete case: BTC-USD 1m, one trade at 61 234 ms belongs to the candle opening at 60 000.
/// **Validates: Requirements 2.1** (bugfix.md 1.1, 2.1)
#[test]
fn bug_indicators_ts_concrete_trade_at_61234() {
    let mut engine = Engine::new();
    let _ = engine.on_command(Command::Subscribe {
        venue: Venue::Replay,
        symbol: "BTC-USD".into(),
        timeframe: Timeframe::M1,
    });
    let events = engine.on_market(MarketMsg::Trade {
        symbol: "BTC-USD".into(),
        price: protocol::Price(6_400_000),
        qty: protocol::Qty(1),
        side: protocol::Side::Buy,
        ts: 61_234,
    });
    let ts = events.iter().find_map(|event| match event {
        Event::Indicators { ts, .. } => Some(*ts),
        _ => None,
    });
    assert_eq!(ts, Some(60_000), "events: {events:?}");
}

// ---------------------------------------------------------------------------------------------
// chart-and-tape-fix, Property 4: Bug Condition - Snapshots carry per-candle indicator history
// (observable behavior). Exploration test: fails on the unfixed engine, whose subscribe answer
// is one snapshot plus a single Indicators event (bugfix 1.5). Task 4.2 makes it pass. It reads
// the `indicators` key from the snapshot's JSON so it compiles before and after the field exists.
// ---------------------------------------------------------------------------------------------

/// **Validates: Requirements 2.6** (bugfix.md 1.5, 2.6)
#[test]
fn bug_subscribe_answer_has_indicator_history() {
    let mut engine = Engine::new();
    // One trade per minute for 30 minutes, no subscription yet.
    for minute in 0..30_i64 {
        let _ = engine.on_market(MarketMsg::Trade {
            symbol: "BTC-USD".into(),
            price: protocol::Price(6_400_000 + minute * 100),
            qty: protocol::Qty(1),
            side: protocol::Side::Buy,
            ts: minute * MIN + 1_000,
        });
    }
    let answer = engine.on_command(Command::Subscribe {
        venue: Venue::Replay,
        symbol: "BTC-USD".into(),
        timeframe: Timeframe::M1,
    });

    let mut bar_count = 0;
    let mut snapshot_points = None;
    let mut indicator_events = 0;
    for event in &answer {
        match event {
            Event::Candle {
                snapshot: true,
                bars,
                ..
            } => {
                bar_count = bars.len();
                let json = serde_json::to_value(event).unwrap();
                snapshot_points = json
                    .get("indicators")
                    .and_then(|v| v.as_array())
                    .map(Vec::len);
            }
            Event::Indicators { .. } => indicator_events += 1,
            _ => {}
        }
    }
    let points = snapshot_points.unwrap_or(indicator_events);
    assert_eq!(bar_count, 30, "answer: {answer:?}");
    assert_eq!(
        points, bar_count,
        "bars: {bar_count}, indicator points: {points} (Indicators events: {indicator_events}, snapshot indicators: {snapshot_points:?})"
    );
}

// ---------------------------------------------------------------------------------------------
// chart-and-tape-fix, Property 8: Preservation - Candles and indicator values unchanged.
// Must pass on the unfixed engine and after every fix. It compares the engine's events with a
// test-only reference: candles from `build_direct`, and a frozen copy of the unfixed
// `SymbolIndicators::update` path built from the public indicator components. The `Indicators`
// `ts` field is ignored (task 3.1 changes it). Candle events are matched with `..`.
// ---------------------------------------------------------------------------------------------

mod reference {
    use protocol::{Bar, IndicatorValues, TimeMs};

    use crate::indicators::{
        ATR_PERIOD, Atr, BOLLINGER_K, BOLLINGER_PERIOD, Bollinger, EMA_PERIOD, Ema, Ohlcv,
        RSI_PERIOD, Rsi, SMA_PERIOD, Sma, Vwap,
    };

    /// Frozen copy of the unfixed `SymbolIndicators` (commit, peek, update).
    pub struct RefIndicators {
        ema: Ema,
        sma: Sma,
        bollinger: Bollinger,
        rsi: Rsi,
        atr: Atr,
        vwap: Vwap,
        forming: Option<Ohlcv>,
    }

    impl RefIndicators {
        pub fn new() -> Self {
            Self {
                ema: Ema::new(EMA_PERIOD),
                sma: Sma::new(SMA_PERIOD),
                bollinger: Bollinger::new(BOLLINGER_PERIOD, BOLLINGER_K),
                rsi: Rsi::new(RSI_PERIOD),
                atr: Atr::new(ATR_PERIOD),
                vwap: Vwap::new(),
                forming: None,
            }
        }

        fn commit(&mut self, bar: &Ohlcv) {
            self.ema.commit(bar.close);
            self.sma.commit(bar.close);
            self.bollinger.commit(bar.close);
            self.rsi.commit(bar.close);
            self.atr.commit(bar);
            self.vwap.commit(bar);
        }

        fn peek(&self, bar: &Ohlcv) -> IndicatorValues {
            let bands = self.bollinger.peek(bar.close);
            IndicatorValues {
                ema: self.ema.peek(bar.close),
                sma: self.sma.peek(bar.close),
                vwap: self.vwap.peek(bar),
                bb_upper: bands.map(|b| b.upper),
                bb_mid: bands.map(|b| b.mid),
                bb_lower: bands.map(|b| b.lower),
                rsi: self.rsi.peek(bar.close),
                atr: self.atr.peek(bar),
            }
        }

        pub fn update(&mut self, bar: &Bar) -> Option<IndicatorValues> {
            let bar = Ohlcv::from(bar);
            if let Some(forming) = self.forming {
                if bar.t < forming.t {
                    return None;
                }
                if bar.t > forming.t {
                    self.commit(&forming);
                }
            }
            self.forming = Some(bar);
            Some(self.peek(&bar))
        }

        #[allow(dead_code)]
        pub fn forming_t(&self) -> Option<TimeMs> {
            self.forming.map(|f| f.t)
        }
    }
}

// Req 8.1–8.3, 10.1, 10.2 (bugfix.md 3.1, 3.2, 3.3).
proptest! {
    // chart-and-tape-fix Property 8: Preservation
    // **Validates: Requirements 3.1, 3.2, 3.3**
    #[test]
    fn preservation_candles_and_indicator_values_match_reference(
        symbol in known_symbol(),
        start in 0..=30 * DAY,
        steps in trade_steps(),
    ) {
        use crate::candles::{bucket_start, build_direct};
        use std::collections::BTreeMap;

        let mut engine = Engine::new();
        for timeframe in Timeframe::ALL {
            let _ = engine.on_command(subscribe_cmd(&symbol, timeframe));
        }
        let mut refs: BTreeMap<Timeframe, reference::RefIndicators> = Timeframe::ALL
            .into_iter()
            .map(|tf| (tf, reference::RefIndicators::new()))
            .collect();
        let mut trades: Vec<(protocol::Price, protocol::Qty, TimeMs)> = Vec::new();
        let mut ts = start;
        for (price, qty, gap) in steps {
            ts += gap;
            trades.push((protocol::Price(price), protocol::Qty(qty), ts));
            let events = engine.on_market(MarketMsg::Trade {
                symbol: symbol.clone(),
                price: protocol::Price(price),
                qty: protocol::Qty(qty),
                side: protocol::Side::Buy,
                ts,
            });

            // Expected (Candle, Indicators) per timeframe, in Timeframe::ALL order.
            let mut expected = Vec::new();
            for timeframe in Timeframe::ALL {
                let direct = build_direct(&trades, timeframe);
                let open = bucket_start(ts, timeframe).unwrap();
                let bar = *direct.iter().find(|b| b.t == open).unwrap();
                let values = refs.get_mut(&timeframe).unwrap().update(&bar);
                expected.push((timeframe, bar, values));
            }

            let mut candles = Vec::new();
            let mut indicators = Vec::new();
            for event in &events {
                match event {
                    Event::Candle { timeframe, snapshot: false, bars, .. } => {
                        candles.push((*timeframe, bars.clone()));
                    }
                    Event::Indicators { timeframe, values, .. } => {
                        indicators.push((*timeframe, *values));
                    }
                    _ => {}
                }
            }
            let want_candles: Vec<_> = expected
                .iter()
                .map(|(tf, bar, _)| (*tf, vec![*bar]))
                .collect();
            let want_indicators: Vec<_> = expected
                .iter()
                .filter_map(|(tf, _, v)| (*v).map(|v| (*tf, v)))
                .collect();
            prop_assert_eq!(candles, want_candles);
            prop_assert_eq!(indicators, want_indicators);
        }

        // The subscribe answer's bars equal the reference bars for every timeframe.
        for timeframe in Timeframe::ALL {
            let answer = engine.on_command(subscribe_cmd(&symbol, timeframe));
            let bars = answer.iter().find_map(|e| match e {
                Event::Candle { snapshot: true, bars, .. } => Some(bars.clone()),
                _ => None,
            });
            let mut want = build_direct(&trades, timeframe);
            let skip = want.len().saturating_sub(500);
            want.drain(..skip);
            prop_assert_eq!(bars, Some(want));
        }
    }
}

// ---------------------------------------------------------------------------------------------
// chart-and-tape-fix, Property 2: Bug Condition - Replay warm-up history equals normal play.
// Fixtures are 1 to 200 random lines over 1 to 3 symbols with `ts = recv` and a span of 0 to
// about 3 hours; random keys are subscribed before the load. This module reads Engine fields
// directly (it is a child of `core`), so no extra accessors were added.
// ---------------------------------------------------------------------------------------------

const WARMUP_SYMBOLS: [&str; 3] = ["BTC-USD", "ETH-USD", "SOL-USD"];

/// Time-ordered lines with `ts = recv`, gaps up to `max_gap` ms.
fn warmup_fixture() -> impl Strategy<Value = Vec<FixtureLine>> {
    (
        0..=108_000_i64,
        vec((0..=1_000_000_i64, valid_market_msg()), 1..200),
    )
        .prop_map(|(max_gap, steps)| {
            let mut recv = DEFAULT_START_MS;
            steps
                .into_iter()
                .map(|(gap_seed, msg)| {
                    recv += gap_seed % (max_gap + 1);
                    FixtureLine {
                        recv,
                        msg: with_ts(msg, recv),
                    }
                })
                .collect()
        })
}

fn engine_with(keys: &[(String, Timeframe)]) -> Engine {
    let mut engine = Engine::new();
    for (symbol, timeframe) in keys {
        let _ = engine.on_command(Command::Subscribe {
            venue: Venue::Replay,
            symbol: symbol.clone(),
            timeframe: *timeframe,
        });
    }
    engine
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    // chart-and-tape-fix Property 2: Bug Condition (warm-up equals normal play)
    // **Validates: Requirements 2.3, 2.4**
    #[test]
    fn warm_up_equals_normal_play(
        lines in warmup_fixture(),
        keys in vec((known_symbol(), timeframe()), 0..6),
        slow in 1..=50_u32,
        fast in 1..=50_u32,
    ) {
        use crate::feed::replay::warmup_len;

        let k = warmup_len(&lines);
        // `k` depends only on `recv`: the schedule hands out the same prefix at any speed.
        for speed in [slow, fast] {
            let mut schedule = ReplaySchedule::new(lines.clone(), speed).unwrap();
            let taken = schedule.take_warmup();
            prop_assert_eq!(taken.len(), k);
        }
        let msgs: Vec<MarketMsg> = lines.iter().take(k).map(|l| l.msg.clone()).collect();

        let mut warmed = engine_with(&keys);
        let mut played = engine_with(&keys);
        let events = warmed.warm_up(msgs.clone());
        for msg in msgs {
            let _ = played.on_market(msg);
        }

        if k == 0 {
            prop_assert!(events.is_empty(), "k = 0 emitted {events:?}");
        }

        // No Trade, Book, live Candle, live Indicators, Fill, or OrderAck; an Indicators event
        // is allowed only as the tail of a snapshot.
        for (i, event) in events.iter().enumerate() {
            match event {
                Event::Candle { snapshot: true, .. } | Event::Position { .. } => {}
                Event::Indicators { .. } => {
                    let prev = i.checked_sub(1).and_then(|p| events.get(p));
                    prop_assert!(
                        matches!(prev, Some(Event::Candle { snapshot: true, .. })),
                        "live Indicators event at {i}: {events:?}"
                    );
                }
                other => prop_assert!(false, "unexpected warm-up event {other:?}"),
            }
        }

        // State equality with the engine that played the same lines.
        for symbol in WARMUP_SYMBOLS {
            for tf in Timeframe::ALL {
                prop_assert_eq!(warmed.candles.bars(symbol, tf), played.candles.bars(symbol, tf));
                let key = (symbol.to_owned(), tf);
                let history = |e: &Engine| {
                    e.indicators
                        .get(&key)
                        .map(|i| i.history().iter().copied().collect::<Vec<_>>())
                };
                prop_assert_eq!(history(&warmed), history(&played));
            }
            prop_assert_eq!(
                warmed.books.get(symbol).map(|s| &s.book),
                played.books.get(symbol).map(|s| &s.book)
            );
        }
        // Full indicator state (Debug covers every field, f64 included).
        prop_assert_eq!(format!("{:?}", warmed.indicators), format!("{:?}", played.indicators));
        prop_assert_eq!(&warmed.last_price, &played.last_price);
        prop_assert_eq!(warmed.now, played.now);

        // Snapshot events equal the played engine's subscribe answers, in key order.
        if k > 0 {
            let mut expected = Vec::new();
            for (symbol, timeframes) in &played.subscriptions.clone() {
                for &tf in timeframes {
                    expected.extend(played.on_command(Command::Subscribe {
                        venue: Venue::Replay,
                        symbol: symbol.clone(),
                        timeframe: tf,
                    }));
                }
            }
            prop_assert_eq!(events, expected);
        }
    }
}

// ---------------------------------------------------------------------------------------------
// chart-and-tape-fix, Property 3 (core): `on_history` merges once per key, rebuilds the key's
// indicators from the merged ring, and a failure allows exactly one retry (Task 3.7, Req 2.5).
// Reads Engine fields directly (child module). Cases come from `candles::properties`.
// ---------------------------------------------------------------------------------------------

mod backfill_merge {
    use proptest::prelude::*;
    use protocol::{Bar, Command, Event, Price, Qty, Side, Venue};

    use crate::candles::properties::{BASE, MergeCase, late_trades, merge_case};
    use crate::candles::{CandleBuilder, MAX_BARS};
    use crate::core::{Engine, HistoryRequest};
    use crate::feed::MarketMsg;
    use crate::indicators::SymbolIndicators;

    const SYM: &str = "BTC-USD";

    fn subscribe(timeframe: protocol::Timeframe) -> Command {
        Command::Subscribe {
            venue: Venue::Replay,
            symbol: SYM.into(),
            timeframe,
        }
    }

    fn ohlc_ok(bar: &Bar) -> bool {
        bar.low <= bar.open && bar.open <= bar.high && bar.low <= bar.close && bar.close <= bar.high
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]

        // chart-and-tape-fix Property 3: Bug Condition (core)
        // **Validates: Requirements 2.5**
        #[test]
        fn p3_on_history_is_effective_once_and_rebuilds_indicators(
            case in merge_case(),
            fail_first in any::<bool>(),
            later in late_trades(),
        ) {
            let MergeCase { tf, trades, venue, market_now } = case;
            let len = tf.millis();
            let key = (SYM.to_owned(), tf);
            let request = HistoryRequest { symbol: SYM.into(), timeframe: tf };

            let mut engine = Engine::with_backfill();
            let _ = engine.on_command(subscribe(tf));
            prop_assert_eq!(engine.take_history_requests(), vec![request.clone()]);
            // A second subscribe of the same key queues nothing.
            let _ = engine.on_command(subscribe(tf));
            prop_assert!(engine.take_history_requests().is_empty());

            let mut reference = CandleBuilder::default();
            for &(price, qty, ts) in &trades {
                let _ = engine.on_market(MarketMsg::Trade {
                    symbol: SYM.into(),
                    price,
                    qty,
                    side: Side::Buy,
                    ts,
                });
                let _ = reference.on_trade(SYM, price, qty, ts);
            }
            // A known market time with no trades: the core's own market time (0 means unknown).
            if trades.is_empty()
                && let Some(now) = market_now
            {
                engine.now = now;
            }
            let known_now = (engine.now != 0).then_some(engine.now);

            let before_ring = engine.candles.bars(SYM, tf);
            let history_of = |e: &Engine| {
                e.indicators
                    .get(&key)
                    .map(|i| i.history().iter().copied().collect::<Vec<_>>())
            };
            let before_history = history_of(&engine);

            // Failure path: an Error, nothing else changes, and one retry is allowed.
            if fail_first {
                let events = engine.on_history_failed(SYM, tf, "boom");
                prop_assert!(matches!(events.as_slice(), [Event::Error { .. }]), "{events:?}");
                prop_assert_eq!(&engine.candles.bars(SYM, tf), &before_ring);
                prop_assert_eq!(history_of(&engine), before_history);
                prop_assert!(engine.take_history_requests().is_empty());
                let _ = engine.on_command(subscribe(tf));
                prop_assert_eq!(engine.take_history_requests(), vec![request.clone()]);
            }

            let events = engine.on_history(SYM, tf, &venue);
            let _ = reference.merge_history(SYM, tf, &venue, known_now);
            let ring = engine.candles.bars(SYM, tf);

            prop_assert_eq!(&ring, &reference.bars(SYM, tf));
            prop_assert!(ring.len() <= MAX_BARS);
            prop_assert!(ring.windows(2).all(|w| w[0].t < w[1].t));
            prop_assert!(ring.ends_with(&before_ring), "live bars changed");
            prop_assert!(ring.iter().all(ohlc_ok));

            if ring == before_ring {
                prop_assert!(events.is_empty(), "no change but events: {events:?}");
            } else {
                // Indicator state and history equal a fresh build from the merged ring.
                let fresh = SymbolIndicators::from_bars(&ring);
                prop_assert_eq!(
                    history_of(&engine),
                    Some(fresh.history().iter().copied().collect::<Vec<_>>())
                );
                prop_assert_eq!(
                    format!("{:?}", engine.indicators.get(&key)),
                    format!("{:?}", Some(&fresh))
                );
                // The subscribed key gets the merged ring as a snapshot.
                prop_assert!(
                    events.iter().any(
                        |e| matches!(e, Event::Candle { snapshot: true, bars, .. } if *bars == ring)
                    ),
                    "no snapshot of the merged ring: {events:?}"
                );
            }

            // At most one effective on_history: a second call, and a later failure, change nothing.
            let indicators_after = format!("{:?}", engine.indicators.get(&key));
            let again = engine.on_history(SYM, tf, &venue);
            prop_assert!(again.is_empty());
            prop_assert_eq!(&engine.candles.bars(SYM, tf), &ring);
            prop_assert_eq!(format!("{:?}", engine.indicators.get(&key)), indicators_after);
            let events = engine.on_history_failed(SYM, tf, "late failure");
            prop_assert!(
                matches!(events.as_slice(), [Event::Error { .. }]),
                "expected exactly one Error event, got {:?}",
                events
            );
            let _ = engine.on_command(subscribe(tf));
            prop_assert!(engine.take_history_requests().is_empty(), "a Done key requested again");

            // P4 after the merge: trades around the merged ring keep every bar valid.
            for (k, price, qty) in later {
                let events = engine.on_market(MarketMsg::Trade {
                    symbol: SYM.into(),
                    price: Price(price),
                    qty: Qty(qty),
                    side: Side::Sell,
                    ts: BASE + k * len + qty,
                });
                for event in &events {
                    if let Event::Candle { bars, .. } = event {
                        prop_assert!(bars.iter().all(ohlc_ok), "{event:?}");
                    }
                }
            }
            for t in protocol::Timeframe::ALL {
                let ring = engine.candles.bars(SYM, t);
                prop_assert!(ring.len() <= MAX_BARS);
                prop_assert!(ring.windows(2).all(|w| w[0].t < w[1].t));
                prop_assert!(ring.iter().all(ohlc_ok));
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// chart-and-tape-fix, Property 4 (engine): snapshots carry per-candle indicator history
// (Task 4.5, Req 2.6, 2.7). Reads Engine fields directly (child module).
// ---------------------------------------------------------------------------------------------

mod snapshot_history {
    use std::collections::{BTreeMap, BTreeSet};

    use proptest::collection::vec;
    use proptest::prelude::*;
    use protocol::{
        Bar, Command, Event, IndicatorPoint, IndicatorValues, MAX_EVENT_LINE_BYTES, Price, Qty,
        Side, TimeMs, Timeframe, Venue, encode_line,
    };

    use crate::candles::properties::{BASE, MergeCase, merge_case};
    use crate::core::Engine;
    use crate::feed::MarketMsg;

    const SYM: &str = "BTC-USD";

    /// One step of a case after the initial live trades.
    #[derive(Debug, Clone)]
    enum Op {
        /// Live trades through `on_market`, with live Indicators events recorded.
        Trades(Vec<(i64, i64, TimeMs)>),
        /// The same kind of trades through `warm_up`: no live events.
        WarmUp(Vec<(i64, i64, TimeMs)>),
        /// Backfill with the case's venue bars.
        History,
    }

    fn steps(len: TimeMs) -> impl Strategy<Value = Vec<(i64, i64, TimeMs)>> {
        vec((1..=10_000_000_i64, 1..=1_000_i64, 0..=2 * len), 1..8)
    }

    fn op(len: TimeMs) -> impl Strategy<Value = Op> {
        prop_oneof![
            3 => steps(len).prop_map(Op::Trades),
            2 => steps(len).prop_map(Op::WarmUp),
            1 => Just(Op::History),
        ]
    }

    fn trade(price: i64, qty: i64, ts: TimeMs) -> MarketMsg {
        MarketMsg::Trade {
            symbol: SYM.into(),
            price: Price(price),
            qty: Qty(qty),
            side: Side::Buy,
            ts,
        }
    }

    /// Records the values of every live Indicators event of the key, by candle open time.
    fn record(events: &[Event], tf: Timeframe, live: &mut BTreeMap<TimeMs, IndicatorValues>) {
        for event in events {
            if let Event::Indicators {
                timeframe,
                ts,
                values,
                ..
            } = event
                && *timeframe == tf
            {
                live.insert(*ts, *values);
            }
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]

        // chart-and-tape-fix Property 4: Bug Condition (engine snapshot history)
        // **Validates: Requirements 2.6**
        //
        // Comparison source: a bar built from live trades since the last warm-up or effective
        // backfill is compared with the last live Indicators event for its `t`. Warm-up and
        // backfill rebuild or skip live events, so every other bar is compared with the
        // engine's own `SymbolIndicators::history()` (not `from_bars`: the history of a ring
        // that outgrew 500 bars is legitimately not a fresh build).
        #[test]
        fn p4_snapshot_carries_indicator_history(
            (case, ops) in merge_case().prop_flat_map(|case| {
                let len = case.tf.millis();
                (Just(case), vec(op(len), 0..6))
            }),
        ) {
            let MergeCase { tf, trades, venue, .. } = case;
            let len = tf.millis();
            let key = (SYM.to_owned(), tf);
            let subscribe = Command::Subscribe {
                venue: Venue::Replay,
                symbol: SYM.into(),
                timeframe: tf,
            };

            let mut engine = Engine::with_backfill();
            let _ = engine.on_command(subscribe.clone());
            let mut live: BTreeMap<TimeMs, IndicatorValues> = BTreeMap::new();
            let mut ts = BASE;
            for &(price, qty, trade_ts) in &trades {
                ts = ts.max(trade_ts);
                record(&engine.on_market(trade(price.0, qty.0, trade_ts)), tf, &mut live);
            }
            for op in ops {
                match op {
                    Op::Trades(list) => {
                        for (price, qty, gap) in list {
                            ts += gap;
                            record(&engine.on_market(trade(price, qty, ts)), tf, &mut live);
                        }
                    }
                    Op::WarmUp(list) => {
                        let mut msgs = Vec::new();
                        for (price, qty, gap) in list {
                            ts += gap;
                            msgs.push(trade(price, qty, ts));
                        }
                        let _ = engine.warm_up(msgs);
                        live.clear();
                    }
                    Op::History => {
                        if !engine.on_history(SYM, tf, &venue).is_empty() {
                            live.clear();
                        }
                    }
                }
            }
            prop_assert!(len > 0);

            let answer = engine.on_command(subscribe);
            let Some((bars, points)) = answer.iter().find_map(|e| match e {
                Event::Candle { snapshot: true, bars, indicators, .. } => {
                    Some((bars, indicators))
                }
                _ => None,
            }) else {
                return Err(TestCaseError::fail(format!("no snapshot: {answer:?}")));
            };
            let Some(points) = points else {
                return Err(TestCaseError::fail("snapshot indicators is None"));
            };

            prop_assert!(points.windows(2).all(|w| w[0].t < w[1].t), "not ascending");
            let bar_times: BTreeSet<TimeMs> = bars.iter().map(|b: &Bar| b.t).collect();
            let history: BTreeMap<TimeMs, IndicatorValues> = engine
                .indicators
                .get(&key)
                .map(|i| i.history().iter().map(|p| (p.t, p.values)).collect())
                .unwrap_or_default();
            for point in points {
                prop_assert!(bar_times.contains(&point.t), "point {} has no bar", point.t);
                match live.get(&point.t) {
                    Some(values) => prop_assert_eq!(&point.values, values, "live t={}", point.t),
                    None => prop_assert_eq!(
                        Some(&point.values),
                        history.get(&point.t),
                        "history t={}",
                        point.t
                    ),
                }
            }
        }
    }

    /// A 500-bar, 500-point snapshot with extreme values fits one stdout line (Req 2.7).
    /// **Validates: Requirements 2.7**
    #[test]
    fn extreme_snapshot_fits_max_event_line_bytes() {
        let extreme = Some(-1.797_693_134_862_315_7e308_f64);
        let values = IndicatorValues {
            ema: extreme,
            sma: extreme,
            vwap: extreme,
            bb_upper: extreme,
            bb_mid: extreme,
            bb_lower: extreme,
            rsi: extreme,
            atr: extreme,
        };
        let bars: Vec<Bar> = (0..500_i64)
            .map(|i| Bar {
                t: i64::MIN + i,
                open: Price(i64::MIN),
                high: Price(i64::MAX),
                low: Price(i64::MIN),
                close: Price(i64::MIN),
                volume: Qty(i64::MAX),
            })
            .collect();
        let indicators: Vec<IndicatorPoint> = bars
            .iter()
            .map(|b| IndicatorPoint { t: b.t, values })
            .collect();
        let event = Event::Candle {
            venue: Venue::Replay,
            symbol: "BTC-USD".into(),
            timeframe: Timeframe::M1,
            snapshot: true,
            bars,
            indicators: Some(indicators),
        };
        let line = encode_line(&event).unwrap();
        assert!(
            line.len() <= MAX_EVENT_LINE_BYTES,
            "{} > {MAX_EVENT_LINE_BYTES}",
            line.len()
        );
    }
}
