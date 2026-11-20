//! Property tests P4, P5, and P6 from the design's property table (Task 4.5).
//!
//! All three use one trade generator: 1 to 3 symbols, prices from 1 to 10⁹ ticks, and
//! timestamps that mostly move forward (small steps within a few minutes, sometimes jumps of up
//! to 3 days) but sometimes go back. A short step back usually lands in a minute still inside
//! the 1m ring (a late trade that is applied); a long one usually lands before the oldest kept
//! 1m bar (a trade that is dropped). One case in four is a single-symbol run of 800 to 1,000
//! trades, which usually fills the 1m ring past [`MAX_BARS`] and evicts bars, so trades in
//! evicted minutes are dropped too.
//!
//! - **P4 (Req 8.4)** takes any positive qty, up to `i64::MAX`, so volume-overflow drops are
//!   exercised. It checks every bar `on_trade` returns and every kept bar at the end.
//! - **P5 (Req 8.5)** keeps qty at most 10⁶ lots, so no sum can overflow, and checks volumes
//!   against an oracle that reproduces the drop rule on its own (see [`VolumeOracle`]).
//! - **P6 (Req 8.6)** takes any positive qty. Precondition: [`build_direct`] gets only the
//!   trades the builder accepted, in arrival order, and only the last [`MAX_BARS`] direct bars
//!   are compared, because the builder's rings keep at most that many.
//!
//! Each property runs proptest's default 256 cases.

use std::collections::{BTreeMap, BTreeSet};

use proptest::collection::vec;
use proptest::prelude::*;
use protocol::{Bar, Price, Qty, TimeMs, Timeframe};

use super::{CandleBuilder, MAX_BARS, build_direct};

const MIN: TimeMs = 60_000;
const DAY: TimeMs = 24 * 60 * MIN;
/// 2027-01-01T00:00:00Z, a realistic epoch-ms base time.
const START_2027: TimeMs = 1_798_761_600_000;
const SYMBOLS: [&str; 3] = ["BTC-USD", "ETH-USD", "SOL-USD"];

/// One generated trade. `symbol` indexes [`SYMBOLS`].
#[derive(Debug, Clone, Copy)]
struct Trade {
    symbol: usize,
    price: Price,
    qty: Qty,
    ts: TimeMs,
}

/// How a trade's time relates to the latest time so far.
#[derive(Debug, Clone, Copy)]
enum Step {
    /// Moves the latest time forward by this many ms; the trade is at the new latest time.
    Forward(TimeMs),
    /// The trade is this many ms before the latest time, which does not move.
    Back(TimeMs),
}

fn step() -> impl Strategy<Value = Step> + Clone {
    prop_oneof![
        7 => (0..=3 * MIN).prop_map(Step::Forward),
        1 => (3 * MIN..=3 * DAY).prop_map(Step::Forward),
        // Usually a minute still in the 1m ring.
        1 => (1..=10 * MIN).prop_map(Step::Back),
        // Usually before the oldest kept 1m bar.
        1 => (10 * MIN..=1_000 * MIN).prop_map(Step::Back),
    ]
}

fn base_time() -> impl Strategy<Value = TimeMs> + Clone {
    // Around the epoch, so negative times and bucket flooring below zero are covered too.
    prop_oneof![-2 * DAY..=2 * DAY, START_2027 - DAY..=START_2027 + DAY]
}

/// Any positive qty, with `i64::MAX` and very large values drawn often enough to overflow.
fn any_qty() -> BoxedStrategy<i64> {
    prop_oneof![
        3 => 1..=1_000_000_i64,
        1 => 1..=i64::MAX,
        1 => Just(i64::MAX),
    ]
    .boxed()
}

/// Qty small enough that no bar volume can overflow: at most 1,000 trades of 10⁶ lots.
fn small_qty() -> BoxedStrategy<i64> {
    (1..=1_000_000_i64).boxed()
}

fn trades(qty: BoxedStrategy<i64>) -> impl Strategy<Value = Vec<Trade>> {
    let raw = (0..SYMBOLS.len(), 1..=1_000_000_000_i64, qty, step());
    prop_oneof![
        3 => (1..=SYMBOLS.len(), base_time(), vec(raw.clone(), 0..150)),
        1 => (Just(1_usize), base_time(), vec(raw, 800..1_000)),
    ]
    .prop_map(|(symbols, base, raw)| {
        let mut latest = base;
        raw.into_iter()
            .map(|(symbol, price, qty, step)| {
                let ts = match step {
                    Step::Forward(ms) => {
                        latest += ms;
                        latest
                    }
                    Step::Back(ms) => latest - ms,
                };
                Trade {
                    symbol: symbol % symbols,
                    price: Price(price),
                    qty: Qty(qty),
                    ts,
                }
            })
            .collect()
    })
}

fn apply(b: &mut CandleBuilder, t: &Trade) -> Vec<(Timeframe, Bar)> {
    b.on_trade(SYMBOLS[t.symbol], t.price, t.qty, t.ts)
}

fn check_ohlc(symbol: &str, tf: Timeframe, bar: &Bar) -> Result<(), TestCaseError> {
    prop_assert!(
        bar.low <= bar.open && bar.open <= bar.high,
        "{} {}: open outside [low, high]: {:?}",
        symbol,
        tf,
        bar
    );
    prop_assert!(
        bar.low <= bar.close && bar.close <= bar.high,
        "{} {}: close outside [low, high]: {:?}",
        symbol,
        tf,
        bar
    );
    Ok(())
}

/// Start of the `len`-ms bucket that holds `ts`. Written out here rather than calling
/// [`super::bucket_start`], so the oracle does not share the builder's code. Generated times
/// are far from the i64 limits.
fn floor_to(ts: TimeMs, len: TimeMs) -> TimeMs {
    ts.div_euclid(len) * len
}

/// Reference model for P5, for one symbol.
///
/// The drop rule it reproduces: a trade is accepted when the symbol has no 1m bar yet or its
/// 1m bucket is at or after the oldest kept 1m bucket. The kept 1m buckets are the
/// [`MAX_BARS`] most recent buckets of accepted trades. The model does not reproduce the
/// higher-timeframe rings: each one keeps the bucket of every kept 1m bar, so the 1m rule
/// alone decides. If that were not so, the comparison would fail.
#[derive(Debug, Default)]
struct VolumeOracle {
    kept_minutes: BTreeSet<TimeMs>,
    volumes: BTreeMap<(Timeframe, TimeMs), i64>,
    late: u64,
}

impl VolumeOracle {
    fn add(&mut self, qty: i64, ts: TimeMs) {
        let minute = floor_to(ts, MIN);
        if self
            .kept_minutes
            .first()
            .is_some_and(|&oldest| minute < oldest)
        {
            self.late += 1;
            return;
        }
        self.kept_minutes.insert(minute);
        if self.kept_minutes.len() > MAX_BARS {
            self.kept_minutes.pop_first();
        }
        for tf in Timeframe::ALL {
            *self
                .volumes
                .entry((tf, floor_to(ts, tf.millis())))
                .or_default() += qty;
        }
    }
}

proptest! {
    // Property P4 — validates Req 8.4
    #[test]
    fn p4_every_bar_has_open_and_close_within_low_and_high(trades in trades(any_qty())) {
        let mut b = CandleBuilder::default();
        for t in &trades {
            for (tf, bar) in apply(&mut b, t) {
                check_ohlc(SYMBOLS[t.symbol], tf, &bar)?;
            }
        }
        for symbol in SYMBOLS {
            for tf in Timeframe::ALL {
                for bar in b.bars(symbol, tf) {
                    check_ohlc(symbol, tf, &bar)?;
                }
            }
        }
    }

    // Property P5 — validates Req 8.5
    #[test]
    fn p5_bar_volume_is_the_sum_of_accepted_trade_qty_in_its_bucket(
        trades in trades(small_qty())
    ) {
        let mut b = CandleBuilder::default();
        let mut oracles: [VolumeOracle; 3] = Default::default();
        for t in &trades {
            apply(&mut b, t);
            oracles[t.symbol].add(t.qty.0, t.ts);
        }
        for (symbol, oracle) in SYMBOLS.into_iter().zip(&oracles) {
            for tf in Timeframe::ALL {
                for bar in b.bars(symbol, tf) {
                    let expected = oracle.volumes.get(&(tf, bar.t)).copied();
                    prop_assert_eq!(Some(bar.volume.0), expected, "{} {} bar at {}", symbol, tf, bar.t);
                }
            }
            let minutes: BTreeSet<TimeMs> =
                b.bars(symbol, Timeframe::M1).iter().map(|bar| bar.t).collect();
            prop_assert_eq!(&minutes, &oracle.kept_minutes, "{} kept 1m buckets", symbol);
        }
        let dropped = b.dropped();
        prop_assert_eq!(dropped.late, oracles.iter().map(|o| o.late).sum::<u64>());
        prop_assert_eq!(dropped.overflow, 0);
        prop_assert_eq!(dropped.invalid, 0);
    }

    // Property P6 — validates Req 8.6
    #[test]
    fn p6_aggregated_bars_equal_bars_built_directly(trades in trades(any_qty())) {
        let mut b = CandleBuilder::default();
        let mut accepted: [Vec<(Price, Qty, TimeMs)>; 3] = Default::default();
        for t in &trades {
            if !apply(&mut b, t).is_empty() {
                accepted[t.symbol].push((t.price, t.qty, t.ts));
            }
        }
        for (symbol, accepted) in SYMBOLS.into_iter().zip(&accepted) {
            for &tf in &Timeframe::ALL[1..] {
                let direct = build_direct(accepted, tf);
                let kept = &direct[direct.len().saturating_sub(MAX_BARS)..];
                let bars = b.bars(symbol, tf);
                prop_assert_eq!(bars.as_slice(), kept, "{} {}", symbol, tf);
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// chart-and-tape-fix, Property 3: Bug Condition - Backfill merge keeps the forming candle and
// never duplicates a time (Task 3.7, Req 2.5). The generators below are shared with the core
// test in `core/properties.rs`.
//
// A case is one timeframe, a trade-built live ring of 0 to 520 bars (520 evicts down to the
// 500 cap), a known or unknown market time, and up to ~720 venue bars that are shuffled,
// duplicated, overlapping the live range, sometimes misaligned, and sometimes OHLC-inconsistent
// (high below low, low of 0, low above open, or negative volume).
// ---------------------------------------------------------------------------------------------

use proptest::sample::{Index, select};

/// Aligned base time of every merge case (midnight UTC, so aligned to every timeframe).
pub(crate) const BASE: TimeMs = START_2027;

const SYM: &str = "BTC-USD";

/// One generated backfill case.
#[derive(Debug, Clone)]
pub(crate) struct MergeCase {
    pub tf: Timeframe,
    /// Time-ordered trades, one per bucket of `tf` (each bucket gets one trade).
    pub trades: Vec<(Price, Qty, TimeMs)>,
    pub venue: Vec<Bar>,
    pub market_now: Option<TimeMs>,
}

fn live_trades(tf: Timeframe) -> impl Strategy<Value = Vec<(Price, Qty, TimeMs)>> {
    let len = tf.millis();
    prop_oneof![1 => 0..=3_usize, 4 => 0..=520_usize]
        .prop_flat_map(move |n| vec((1..=2_i64, 0..len, 1..=1_000_000_i64, 1..=1_000_i64), n))
        .prop_map(move |raw| {
            let mut unit = 0;
            raw.into_iter()
                .map(|(step, offset, price, qty)| {
                    unit += step;
                    (Price(price), Qty(qty), BASE + unit * len + offset)
                })
                .collect()
        })
}

fn venue_bar(tf: Timeframe) -> impl Strategy<Value = Bar> {
    let len = tf.millis();
    (
        -700..=1_100_i64,
        prop_oneof![8 => Just(0_i64), 1 => 1..len],
        (1..=1_000_i64, 0..=50_i64, 0..=50_i64, 0..=50_i64),
        0..12_u8,
        prop_oneof![20 => 0..=1_000_i64, 1 => -5..0_i64],
    )
        .prop_map(
            move |(k, offset, (low, d_open, d_close, d_high), flaw, volume)| {
                let (mut low, open, close) = (low, low + d_open, low + d_close);
                let mut high = open.max(close) + d_high;
                match flaw {
                    0 => high = low - 1,
                    1 => low = 0,
                    2 => low = open + 1,
                    _ => {}
                }
                Bar {
                    t: BASE + k * len + offset,
                    open: Price(open),
                    high: Price(high),
                    low: Price(low),
                    close: Price(close),
                    volume: Qty(volume),
                }
            },
        )
}

/// Unsorted venue bars with repeated times (the repeat differs in volume).
fn venue_bars(tf: Timeframe) -> impl Strategy<Value = Vec<Bar>> {
    (
        vec(venue_bar(tf), 0..700),
        vec((any::<Index>(), 1..=50_i64), 0..20),
    )
        .prop_map(|(mut bars, dups)| {
            for (at, bump) in dups {
                let Some(&original) = bars.get(at.index(bars.len().max(1))) else {
                    break;
                };
                let mut copy = original;
                copy.volume = Qty(copy.volume.0.saturating_add(bump));
                bars.push(copy);
            }
            bars
        })
        .prop_shuffle()
}

pub(crate) fn merge_case() -> impl Strategy<Value = MergeCase> {
    select(Timeframe::ALL.to_vec()).prop_flat_map(|tf| {
        let len = tf.millis();
        let market_now = prop_oneof![
            1 => Just(None),
            2 => (-700..=1_100_i64, 0..len).prop_map(move |(k, o)| Some(BASE + k * len + o)),
        ];
        (live_trades(tf), venue_bars(tf), market_now).prop_map(
            move |(trades, venue, market_now)| MergeCase {
                tf,
                trades,
                venue,
                market_now,
            },
        )
    })
}

/// `(k, price, qty)` of trades applied after a merge: at `BASE + k * len + qty`, so they land
/// before, inside, and after the live range.
pub(crate) fn late_trades() -> impl Strategy<Value = Vec<(i64, i64, i64)>> {
    vec((-700..=1_200_i64, 1..=1_000_i64, 1..=100_i64), 0..30)
}

/// Independent copy of the venue-bar validity rule.
fn venue_bar_is_valid(bar: &Bar, len: TimeMs) -> bool {
    bar.t.rem_euclid(len) == 0
        && bar.low.0 > 0
        && bar.low <= bar.open
        && bar.open <= bar.high
        && bar.low <= bar.close
        && bar.close <= bar.high
        && bar.volume.0 >= 0
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    // chart-and-tape-fix Property 3 (candles), then P4 on the merged ring.
    // **Validates: Requirements 2.5**
    #[test]
    fn p3_merge_history_keeps_live_bars_and_unique_times(
        case in merge_case(),
        later in late_trades(),
    ) {
        let MergeCase { tf, trades, venue, market_now } = case;
        let len = tf.millis();
        let mut b = CandleBuilder::default();
        for &(price, qty, ts) in &trades {
            let _ = b.on_trade(SYM, price, qty, ts);
        }
        let before = b.bars(SYM, tf);
        let others_before: Vec<(Timeframe, Vec<Bar>)> = Timeframe::ALL
            .into_iter()
            .filter(|&t| t != tf)
            .map(|t| (t, b.bars(SYM, t)))
            .collect();

        let mut valid: BTreeMap<TimeMs, Bar> = BTreeMap::new();
        let mut invalid = 0;
        for bar in &venue {
            if venue_bar_is_valid(bar, len) {
                valid.insert(bar.t, *bar);
            } else {
                invalid += 1;
            }
        }
        let cutoff = match before.first() {
            Some(front) => Some(front.t),
            None => market_now
                .map(|now| floor_to(now, len))
                .or_else(|| valid.keys().next_back().copied()),
        };

        let result = b.merge_history(SYM, tf, &venue, market_now);
        let after = b.bars(SYM, tf);

        // Strictly ascending, so no duplicate time; at most 500 bars.
        prop_assert!(after.windows(2).all(|w| w[0].t < w[1].t), "order: {:?}", after);
        prop_assert!(after.len() <= MAX_BARS);
        // Bars at or after the cutoff are the live bars, untouched.
        let live_part: Vec<Bar> = after
            .iter()
            .filter(|bar| cutoff.is_some_and(|c| bar.t >= c))
            .copied()
            .collect();
        prop_assert_eq!(&live_part, &before);
        // Bars before the cutoff come from valid, aligned venue bars.
        for bar in after.iter().filter(|bar| cutoff.is_some_and(|c| bar.t < c)) {
            prop_assert_eq!(bar.t.rem_euclid(len), 0);
            prop_assert_eq!(valid.get(&bar.t), Some(bar));
        }
        for bar in &after {
            check_ohlc(SYM, tf, bar)?;
        }
        // Exactly the newest venue bars that fit next to the live ones were added.
        let expected: Vec<Bar> = match cutoff {
            None => before.clone(),
            Some(c) => {
                let older: Vec<Bar> = valid.values().filter(|bar| bar.t < c).copied().collect();
                let room = MAX_BARS.saturating_sub(before.len());
                let skip = older.len().saturating_sub(room);
                older.into_iter().skip(skip).chain(before.iter().copied()).collect()
            }
        };
        prop_assert_eq!(&after, &expected);
        prop_assert_eq!(result.invalid, invalid);
        prop_assert_eq!(result.added, after.len() - before.len());
        prop_assert_eq!(result.changed, after != before);
        // Other timeframes are not touched.
        for (t, ring) in &others_before {
            prop_assert_eq!(&b.bars(SYM, *t), ring);
        }

        // P4 after the merge: trades into and around the merged ring keep every bar valid.
        for (k, price, qty) in later {
            for (t, bar) in b.on_trade(SYM, Price(price), Qty(qty), BASE + k * len + qty) {
                check_ohlc(SYM, t, &bar)?;
            }
        }
        for t in Timeframe::ALL {
            let ring = b.bars(SYM, t);
            prop_assert!(ring.len() <= MAX_BARS);
            prop_assert!(ring.windows(2).all(|w| w[0].t < w[1].t), "{} order", t);
            for bar in &ring {
                check_ohlc(SYM, t, bar)?;
            }
        }
    }
}
