//! Candle_Builder (design §2 "Candle_Builder", Req 8.1, 8.2, 8.3, 8.7). Pure: no I/O and no
//! clock reads. Bucket times come from trade timestamps only.
//!
//! Rules:
//! - **Buckets.** A trade at `ts` belongs to the bar starting at `floor(ts / len) * len` for
//!   each timeframe length `len`, in UTC epoch ms. `div_euclid` floors negative times too, so
//!   `-1` lands in the bucket starting at `-len`. A bucket start that does not fit in an `i64`
//!   (only possible within one interval of `i64::MIN`) drops the trade.
//! - **Rings.** Each (symbol, timeframe) keeps its most recent [`MAX_BARS`] bars in a
//!   `VecDeque`, oldest first, so the current bar is last (Req 8.7).
//! - **Update rule.** A trade updates the 1m bar: a new bar opens at the trade price, and an
//!   existing bar takes `high = max`, `low = min`, `close = price`, `volume += qty` (Req 8.1,
//!   8.2). Every higher timeframe is then updated from the changed 1m bar, not from the trade:
//!   a new higher bar copies the new 1m bar, and an existing one takes `high = max(high,
//!   m1.high)`, `low = min(low, m1.low)`, `close = m1.close`, `volume += qty` (Req 8.3).
//! - **Arrival order.** Open is the first trade applied to a bucket and close the last one.
//!   Replay and the live feed deliver trades in time order, so this is also time order.
//! - **Out-of-order trades.** A trade whose 1m bucket is earlier than the current bar is applied
//!   if its bucket is still inside the 1m ring's range (at or after the oldest kept bar): it
//!   merges into the matching bar, or inserts a new bar in time order if that minute had no
//!   trades yet. A trade older than the oldest kept 1m bar is dropped and counted in
//!   [`Dropped::late`]. Higher timeframes always contain the bucket of an accepted trade,
//!   because each higher ring holds at least the buckets of every kept 1m bar.
//! - **Volume overflow.** Volume uses checked addition. If adding the trade's qty would overflow
//!   any affected bar's volume, the whole trade is dropped, nothing changes, and it is counted in
//!   [`Dropped::overflow`]. Volumes never saturate or wrap.
//! - **Invalid trades.** A trade with `price <= 0` or `qty <= 0` is dropped and counted in
//!   [`Dropped::invalid`]. Fixture and feed validation already refuse these.
//! - **Gaps.** A bucket with no trades has no bar. The builder never adds synthetic empty bars,
//!   so ring times can skip intervals.
//!
//! The builder keeps bars for every symbol that trades, subscribed or not. Subscriptions,
//! snapshots, and live Candle Events (Req 8.7, 8.8) live in [`crate::core::Engine`].

use std::collections::{BTreeMap, VecDeque};

use protocol::{Bar, Price, Qty, TimeMs, Timeframe};

/// Bars kept per (symbol, timeframe), and the most a snapshot carries (Req 8.7).
pub const MAX_BARS: usize = 500;

/// Number of timeframes, the length of [`Timeframe::ALL`].
const TIMEFRAMES: usize = Timeframe::ALL.len();

/// Start of the UTC bucket of `tf` that contains `ts`, or `None` if it does not fit in an i64.
pub fn bucket_start(ts: TimeMs, tf: Timeframe) -> Option<TimeMs> {
    let len = tf.millis();
    ts.div_euclid(len).checked_mul(len)
}

/// Counts of trades the builder refused, by reason.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Dropped {
    /// Older than the oldest kept 1m bar.
    pub late: u64,
    /// Would overflow a bar's volume.
    pub overflow: u64,
    /// Non-positive price or qty, or a bucket start outside the i64 range.
    pub invalid: u64,
}

impl Dropped {
    /// All dropped trades.
    pub fn total(&self) -> u64 {
        self.late
            .saturating_add(self.overflow)
            .saturating_add(self.invalid)
    }
}

/// Result of [`CandleBuilder::merge_history`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct HistoryMerge {
    /// The ring differs after the merge.
    pub changed: bool,
    /// Venue bars prepended to the ring.
    pub added: usize,
    /// Venue bars dropped as misaligned or inconsistent.
    pub invalid: usize,
}

/// A venue bar is usable when it is aligned to `tf`, has `0 < low <= open, close <= high`, and
/// a non-negative volume.
fn is_valid_venue_bar(bar: &Bar, tf: Timeframe) -> bool {
    bucket_start(bar.t, tf) == Some(bar.t)
        && bar.low.0 > 0
        && bar.low <= bar.open
        && bar.open <= bar.high
        && bar.low <= bar.close
        && bar.close <= bar.high
        && bar.volume.0 >= 0
}

/// Builds candles for every symbol and timeframe from trades.
#[derive(Debug, Default)]
pub struct CandleBuilder {
    series: BTreeMap<String, Series>,
    dropped: Dropped,
}

/// The rings of one symbol, indexed like [`Timeframe::ALL`].
#[derive(Debug, Default)]
struct Series {
    rings: [VecDeque<Bar>; TIMEFRAMES],
}

/// Where a trade's bucket lands in a ring.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Slot {
    /// The bar at this index has the bucket.
    Existing(usize),
    /// No bar has the bucket; a new one goes at this index.
    Insert(usize),
    /// The bucket is older than the oldest kept bar.
    TooOld,
}

fn slot(ring: &VecDeque<Bar>, t: TimeMs) -> Slot {
    let (Some(front), Some(back)) = (ring.front(), ring.back()) else {
        return Slot::Insert(0);
    };
    if t < front.t {
        return Slot::TooOld;
    }
    // The common cases first: the current bar, or a new bucket after it.
    if t == back.t {
        return Slot::Existing(ring.len() - 1);
    }
    if t > back.t {
        return Slot::Insert(ring.len());
    }
    match ring.binary_search_by_key(&t, |bar| bar.t) {
        Ok(i) => Slot::Existing(i),
        Err(i) => Slot::Insert(i),
    }
}

/// Inserts `bar` at `index` and drops the oldest bar if the ring is over [`MAX_BARS`].
fn insert_capped(ring: &mut VecDeque<Bar>, index: usize, bar: Bar) {
    ring.insert(index, bar);
    if ring.len() > MAX_BARS {
        ring.pop_front();
    }
}

impl CandleBuilder {
    /// Applies one trade and returns the bar it changed in each timeframe, in
    /// [`Timeframe::ALL`] order. A changed bar is usually the current bar, but an out-of-order
    /// trade changes an older one. Returns an empty Vec when the trade is dropped (see the
    /// module docs); then no state changes.
    pub fn on_trade(
        &mut self,
        symbol: &str,
        price: Price,
        qty: Qty,
        ts: TimeMs,
    ) -> Vec<(Timeframe, Bar)> {
        if price.0 <= 0 || qty.0 <= 0 {
            self.dropped.invalid = self.dropped.invalid.saturating_add(1);
            return Vec::new();
        }
        let mut buckets = [0; TIMEFRAMES];
        for (bucket, tf) in buckets.iter_mut().zip(Timeframe::ALL) {
            let Some(start) = bucket_start(ts, tf) else {
                self.dropped.invalid = self.dropped.invalid.saturating_add(1);
                return Vec::new();
            };
            *bucket = start;
        }
        if !self.series.contains_key(symbol) {
            self.series.insert(symbol.to_owned(), Series::default());
        }
        let Some(series) = self.series.get_mut(symbol) else {
            return Vec::new();
        };

        // Plan every ring before changing any, so a dropped trade changes nothing.
        let mut slots = [Slot::TooOld; TIMEFRAMES];
        for ((slot_out, ring), &bucket) in slots.iter_mut().zip(&series.rings).zip(&buckets) {
            *slot_out = slot(ring, bucket);
        }
        if slots.contains(&Slot::TooOld) {
            self.dropped.late = self.dropped.late.saturating_add(1);
            return Vec::new();
        }
        let overflows = slots.iter().zip(&series.rings).any(|(s, ring)| match s {
            Slot::Existing(i) => ring
                .get(*i)
                .is_none_or(|bar| bar.volume.0.checked_add(qty.0).is_none()),
            Slot::Insert(_) | Slot::TooOld => false,
        });
        if overflows {
            self.dropped.overflow = self.dropped.overflow.saturating_add(1);
            return Vec::new();
        }

        // 1m from the trade (Req 8.1, 8.2). The overflow check above makes the saturating adds
        // exact.
        let [m1_ring, higher_rings @ ..] = &mut series.rings;
        let m1 = match slots[0] {
            Slot::Existing(i) => match m1_ring.get_mut(i) {
                Some(bar) => {
                    bar.high = bar.high.max(price);
                    bar.low = bar.low.min(price);
                    bar.close = price;
                    bar.volume = Qty(bar.volume.0.saturating_add(qty.0));
                    *bar
                }
                None => return Vec::new(),
            },
            // Unreachable: a late trade returned above.
            Slot::TooOld => return Vec::new(),
            Slot::Insert(i) => {
                let bar = Bar {
                    t: buckets[0],
                    open: price,
                    high: price,
                    low: price,
                    close: price,
                    volume: qty,
                };
                insert_capped(m1_ring, i, bar);
                bar
            }
        };

        // Higher timeframes from the 1m change (Req 8.3).
        let mut changed = Vec::with_capacity(TIMEFRAMES);
        changed.push((Timeframe::M1, m1));
        let higher = Timeframe::ALL.iter().zip(&slots).zip(&buckets).skip(1);
        for (ring, ((&tf, &planned), &bucket)) in higher_rings.iter_mut().zip(higher) {
            let bar = match planned {
                Slot::Existing(i) => match ring.get_mut(i) {
                    Some(bar) => {
                        bar.high = bar.high.max(m1.high);
                        bar.low = bar.low.min(m1.low);
                        bar.close = m1.close;
                        bar.volume = Qty(bar.volume.0.saturating_add(qty.0));
                        *bar
                    }
                    None => continue,
                },
                Slot::TooOld => continue,
                Slot::Insert(i) => {
                    // The bucket is new, so the 1m bar is new too and holds only this trade.
                    let bar = Bar {
                        t: bucket,
                        volume: qty,
                        ..m1
                    };
                    insert_capped(ring, i, bar);
                    bar
                }
            };
            changed.push((tf, bar));
        }
        changed
    }

    /// The kept bars of `symbol` and `tf`, oldest first, at most [`MAX_BARS`]. Empty for a
    /// symbol with no trades.
    pub fn bars(&self, symbol: &str, tf: Timeframe) -> Vec<Bar> {
        self.ring(symbol, tf)
            .map(|ring| ring.iter().copied().collect())
            .unwrap_or_default()
    }

    /// The current (latest) bar of `symbol` and `tf`.
    // Only tests call this so far; the Indicator_Engine (Task 9) will.
    #[allow(dead_code)]
    pub fn current(&self, symbol: &str, tf: Timeframe) -> Option<Bar> {
        self.ring(symbol, tf)?.back().copied()
    }

    /// Merges venue history `bars` older than the cutoff into the ring of `symbol` and `tf`
    /// (design D2). Live trades own every bar at or after the cutoff, so the forming candle is
    /// never touched.
    ///
    /// The cutoff is the oldest ring bar if the ring has bars, else the bucket of `market_now`
    /// (the latest market time, if a market message was seen), else the newest valid venue bar.
    /// Invalid or misaligned venue bars are dropped and counted. Later duplicates of a time
    /// replace earlier ones. The newest [`MAX_BARS`] bars are kept.
    pub fn merge_history(
        &mut self,
        symbol: &str,
        tf: Timeframe,
        bars: &[Bar],
        market_now: Option<TimeMs>,
    ) -> HistoryMerge {
        let mut result = HistoryMerge::default();
        let Some(index) = Timeframe::ALL.iter().position(|&t| t == tf) else {
            return result;
        };
        // Sorted and unique by time; a later bar with the same time wins.
        let mut valid: BTreeMap<TimeMs, Bar> = BTreeMap::new();
        for &venue_bar in bars {
            if is_valid_venue_bar(&venue_bar, tf) {
                valid.insert(venue_bar.t, venue_bar);
            } else {
                result.invalid = result.invalid.saturating_add(1);
            }
        }
        let existing = self.series.get(symbol).and_then(|s| s.rings.get(index));
        let cutoff = match existing.and_then(|ring| ring.front()) {
            Some(front) => Some(front.t),
            None => market_now
                .and_then(|now| bucket_start(now, tf))
                .or_else(|| valid.keys().next_back().copied()),
        };
        let Some(cutoff) = cutoff else {
            return result;
        };
        let live_len = existing.map_or(0, VecDeque::len);
        let older: Vec<Bar> = valid.into_values().filter(|b| b.t < cutoff).collect();
        // Keep only the newest bars that fit next to the live ones.
        let skip = older
            .len()
            .saturating_sub(MAX_BARS.saturating_sub(live_len));
        let kept: Vec<Bar> = older.into_iter().skip(skip).collect();
        if kept.is_empty() {
            return result;
        }
        let ring = &mut self.series.entry(symbol.to_owned()).or_default().rings[index];
        for &kept_bar in kept.iter().rev() {
            ring.push_front(kept_bar);
        }
        result.changed = true;
        result.added = kept.len();
        result
    }

    /// Counts of dropped trades.
    pub fn dropped(&self) -> Dropped {
        self.dropped
    }

    fn ring(&self, symbol: &str, tf: Timeframe) -> Option<&VecDeque<Bar>> {
        let index = Timeframe::ALL.iter().position(|&t| t == tf)?;
        self.series.get(symbol)?.rings.get(index)
    }
}

/// Test reference for P6 (Task 4.5): builds every bar of `tf` straight from `trades` of one
/// symbol, in arrival order, without the 1m step and without the [`MAX_BARS`] cap. Returns the
/// bars sorted by time.
///
/// Pass only trades that [`CandleBuilder::on_trade`] accepted (a non-empty result), and compare
/// the last [`MAX_BARS`] bars with [`CandleBuilder::bars`]. Panics on a bucket start outside
/// the i64 range and on volume overflow, which accepted trades never have.
#[cfg(test)]
pub fn build_direct(trades: &[(Price, Qty, TimeMs)], tf: Timeframe) -> Vec<Bar> {
    let mut bars: BTreeMap<TimeMs, Bar> = BTreeMap::new();
    for &(price, qty, ts) in trades {
        let Some(t) = bucket_start(ts, tf) else {
            panic!("bucket of {ts} for {tf} does not fit in an i64");
        };
        bars.entry(t)
            .and_modify(|bar| match bar.volume.0.checked_add(qty.0) {
                Some(volume) => {
                    bar.high = bar.high.max(price);
                    bar.low = bar.low.min(price);
                    bar.close = price;
                    bar.volume = Qty(volume);
                }
                None => panic!("volume overflow in the {tf} bar at {t}"),
            })
            .or_insert(Bar {
                t,
                open: price,
                high: price,
                low: price,
                close: price,
                volume: qty,
            });
    }
    bars.into_values().collect()
}

/// Property tests P4, P5, P6 (Task 4.5).
#[cfg(test)]
pub(crate) mod properties;

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: TimeMs = 60_000;
    const BTC: &str = "BTC-USD";

    fn bar(t: TimeMs, ohlc: [i64; 4], volume: i64) -> Bar {
        Bar {
            t,
            open: Price(ohlc[0]),
            high: Price(ohlc[1]),
            low: Price(ohlc[2]),
            close: Price(ohlc[3]),
            volume: Qty(volume),
        }
    }

    fn trade(b: &mut CandleBuilder, price: i64, qty: i64, ts: TimeMs) -> Vec<(Timeframe, Bar)> {
        b.on_trade(BTC, Price(price), Qty(qty), ts)
    }

    fn all_bars(b: &CandleBuilder) -> Vec<Vec<Bar>> {
        Timeframe::ALL.iter().map(|&tf| b.bars(BTC, tf)).collect()
    }

    #[test]
    fn buckets_align_to_utc_boundaries_including_negative_times() {
        for tf in Timeframe::ALL {
            let len = tf.millis();
            let cases = [
                (0, 0),
                (1, 0),
                (len - 1, 0),
                (len, len),
                (3 * len + 7, 3 * len),
                (-1, -len),
                (-len, -len),
                (-len - 1, -2 * len),
            ];
            for (ts, start) in cases {
                assert_eq!(bucket_start(ts, tf), Some(start), "{tf} {ts}");
            }
            let max = bucket_start(TimeMs::MAX, tf).unwrap();
            assert!(TimeMs::MAX - max < len, "{tf}");
            assert_eq!(max % len, 0, "{tf}");
        }
        // 2027-01-01T00:00:00Z plus 1h 23m 45.678s.
        let ts = 1_798_761_600_000 + 5_025_678;
        assert_eq!(bucket_start(ts, Timeframe::M1), Some(1_798_766_580_000));
        assert_eq!(bucket_start(ts, Timeframe::M5), Some(1_798_766_400_000));
        assert_eq!(bucket_start(ts, Timeframe::M15), Some(1_798_766_100_000));
        assert_eq!(bucket_start(ts, Timeframe::H1), Some(1_798_765_200_000));
        assert_eq!(bucket_start(ts, Timeframe::D1), Some(1_798_761_600_000));
        // floor(i64::MIN / len) * len is below i64::MIN.
        assert_eq!(bucket_start(TimeMs::MIN, Timeframe::M1), None);
    }

    #[test]
    fn ohlcv_across_bucket_boundaries() {
        let mut b = CandleBuilder::default();
        trade(&mut b, 100, 1, 0);
        trade(&mut b, 105, 2, 10_000);
        trade(&mut b, 95, 3, 30_000);
        trade(&mut b, 98, 4, MIN - 1);
        trade(&mut b, 110, 5, MIN);
        // 2:00 to 3:00 has no trades: no bar for it.
        trade(&mut b, 90, 6, 3 * MIN + 500);
        trade(&mut b, 91, 7, 5 * MIN);

        assert_eq!(
            b.bars(BTC, Timeframe::M1),
            [
                bar(0, [100, 105, 95, 98], 10),
                bar(MIN, [110, 110, 110, 110], 5),
                bar(3 * MIN, [90, 90, 90, 90], 6),
                bar(5 * MIN, [91, 91, 91, 91], 7),
            ]
        );
        assert_eq!(
            b.bars(BTC, Timeframe::M5),
            [
                bar(0, [100, 110, 90, 90], 21),
                bar(5 * MIN, [91, 91, 91, 91], 7)
            ]
        );
        for tf in [Timeframe::M15, Timeframe::H1, Timeframe::D1] {
            assert_eq!(b.bars(BTC, tf), [bar(0, [100, 110, 90, 91], 28)], "{tf}");
        }
        assert_eq!(b.dropped(), Dropped::default());
        assert!(b.bars("ETH-USD", Timeframe::M1).is_empty());
        assert_eq!(b.current("ETH-USD", Timeframe::M1), None);
    }

    #[test]
    fn on_trade_returns_one_changed_bar_per_timeframe_in_order() {
        let mut b = CandleBuilder::default();
        trade(&mut b, 100, 1, 0);
        let changed = trade(&mut b, 120, 2, 2 * MIN);
        let timeframes: Vec<Timeframe> = changed.iter().map(|(tf, _)| *tf).collect();
        assert_eq!(timeframes, Timeframe::ALL);
        assert_eq!(changed[0].1, bar(2 * MIN, [120, 120, 120, 120], 2));
        for (tf, changed_bar) in &changed[1..] {
            assert_eq!(*changed_bar, bar(0, [100, 120, 100, 120], 3), "{tf}");
            assert_eq!(b.current(BTC, *tf), Some(*changed_bar));
        }
    }

    #[test]
    fn higher_timeframes_merge_the_1m_change() {
        let mut b = CandleBuilder::default();
        let hour = 3_600_000;
        // Four minutes in the first 5m bucket, one in the second, one in the next hour.
        for (price, qty, ts) in [
            (200, 1, 0),
            (210, 1, 20_000),
            (190, 2, MIN + 1),
            (205, 3, 2 * MIN),
            (220, 1, 2 * MIN + 59_999),
            (185, 4, 4 * MIN),
            (230, 5, 7 * MIN),
            (240, 6, hour + 1),
        ] {
            assert_eq!(trade(&mut b, price, qty, ts).len(), TIMEFRAMES);
        }
        assert_eq!(
            b.bars(BTC, Timeframe::M5),
            [
                bar(0, [200, 220, 185, 185], 12),
                bar(5 * MIN, [230, 230, 230, 230], 5),
                bar(hour, [240, 240, 240, 240], 6),
            ]
        );
        assert_eq!(
            b.bars(BTC, Timeframe::M15),
            [
                bar(0, [200, 230, 185, 230], 17),
                bar(hour, [240, 240, 240, 240], 6)
            ]
        );
        assert_eq!(
            b.bars(BTC, Timeframe::H1),
            [
                bar(0, [200, 230, 185, 230], 17),
                bar(hour, [240, 240, 240, 240], 6)
            ]
        );
        assert_eq!(
            b.bars(BTC, Timeframe::D1),
            [bar(0, [200, 240, 185, 240], 23)]
        );
    }

    #[test]
    fn rings_keep_the_most_recent_500_bars() {
        let mut b = CandleBuilder::default();
        for i in 0..600 {
            trade(&mut b, 100 + i, 1, i * MIN);
        }
        let m1 = b.bars(BTC, Timeframe::M1);
        assert_eq!(m1.len(), MAX_BARS);
        assert_eq!(m1.first().map(|bar| bar.t), Some(100 * MIN));
        assert_eq!(m1.last().map(|bar| bar.t), Some(599 * MIN));
        assert_eq!(b.current(BTC, Timeframe::M1), m1.last().copied());
        assert_eq!(b.bars(BTC, Timeframe::M5).len(), 120);
        assert_eq!(b.bars(BTC, Timeframe::H1).len(), 10);

        // The evicted minutes are gone for good: a trade in one is late.
        assert!(trade(&mut b, 1, 1, 99 * MIN).is_empty());
        assert_eq!(b.dropped().late, 1);
        assert_eq!(b.bars(BTC, Timeframe::M1), m1);
    }

    #[test]
    fn out_of_order_trades_inside_the_ring_are_applied() {
        let mut b = CandleBuilder::default();
        trade(&mut b, 100, 1, 0);
        trade(&mut b, 100, 1, 2 * MIN);
        trade(&mut b, 100, 1, 4 * MIN);

        // Late into an existing bar: merges; the current bar is unchanged.
        let changed = trade(&mut b, 150, 2, MIN - 1);
        assert_eq!(changed[0], (Timeframe::M1, bar(0, [100, 150, 100, 150], 3)));
        assert_eq!(changed[1], (Timeframe::M5, bar(0, [100, 150, 100, 150], 5)));
        // Late into a gap minute: a new bar in time order.
        let changed = trade(&mut b, 50, 4, 3 * MIN);
        assert_eq!(
            changed[0],
            (Timeframe::M1, bar(3 * MIN, [50, 50, 50, 50], 4))
        );
        assert_eq!(changed[1], (Timeframe::M5, bar(0, [100, 150, 50, 50], 9)));

        let times: Vec<TimeMs> = b.bars(BTC, Timeframe::M1).iter().map(|x| x.t).collect();
        assert_eq!(times, [0, 2 * MIN, 3 * MIN, 4 * MIN]);
        assert_eq!(
            b.current(BTC, Timeframe::M1),
            Some(bar(4 * MIN, [100, 100, 100, 100], 1))
        );

        // Older than the oldest kept bar: dropped, nothing changes.
        let before = all_bars(&b);
        assert!(trade(&mut b, 100, 1, -1).is_empty());
        assert_eq!(all_bars(&b), before);
        assert_eq!(
            b.dropped(),
            Dropped {
                late: 1,
                ..Dropped::default()
            }
        );
    }

    #[test]
    fn volume_overflow_drops_the_whole_trade() {
        let mut b = CandleBuilder::default();
        trade(&mut b, 100, i64::MAX - 1, 0);
        // A new minute: the 1m bar would be fine, but the 5m to 1d bars would overflow.
        let before = all_bars(&b);
        assert!(trade(&mut b, 101, 2, MIN).is_empty());
        assert_eq!(all_bars(&b), before);
        assert_eq!(b.dropped().overflow, 1);
        // Exactly i64::MAX still fits.
        assert_eq!(trade(&mut b, 102, 1, MIN).len(), TIMEFRAMES);
        assert_eq!(
            b.current(BTC, Timeframe::D1).map(|x| x.volume),
            Some(Qty(i64::MAX))
        );
        assert_eq!(b.dropped().total(), 1);
    }

    #[test]
    fn invalid_trades_are_dropped() {
        let mut b = CandleBuilder::default();
        assert!(trade(&mut b, 0, 1, 0).is_empty());
        assert!(trade(&mut b, -5, 1, 0).is_empty());
        assert!(trade(&mut b, 100, 0, 0).is_empty());
        assert!(trade(&mut b, 100, 1, TimeMs::MIN).is_empty());
        assert_eq!(b.dropped().invalid, 4);
        assert!(b.bars(BTC, Timeframe::M1).is_empty());
    }

    #[test]
    fn symbols_are_independent() {
        let mut b = CandleBuilder::default();
        trade(&mut b, 100, 1, 0);
        b.on_trade("ETH-USD", Price(7), Qty(3), 0);
        assert_eq!(b.bars(BTC, Timeframe::M1), [bar(0, [100; 4], 1)]);
        assert_eq!(b.bars("ETH-USD", Timeframe::M1), [bar(0, [7; 4], 3)]);
    }

    #[test]
    fn build_direct_matches_the_builder_on_a_simple_sequence() {
        let trades: Vec<(Price, Qty, TimeMs)> = (0..50)
            .map(|i| (Price(1_000 + (i * 37) % 23), Qty(1 + i % 4), i * 47_000))
            .collect();
        let mut b = CandleBuilder::default();
        for &(price, qty, ts) in &trades {
            assert!(!b.on_trade(BTC, price, qty, ts).is_empty());
        }
        for tf in Timeframe::ALL {
            assert_eq!(build_direct(&trades, tf), b.bars(BTC, tf), "{tf}");
        }
    }

    fn flat(t: TimeMs, p: i64) -> Bar {
        bar(t, [p; 4], 1)
    }

    fn times(b: &CandleBuilder) -> Vec<TimeMs> {
        b.bars(BTC, Timeframe::M1).iter().map(|x| x.t).collect()
    }

    #[test]
    fn merge_history_empty_ring_uses_market_now_cutoff() {
        let mut b = CandleBuilder::default();
        let venue = [
            flat(0, 10),
            flat(MIN, 11),
            flat(2 * MIN, 12),
            flat(3 * MIN, 13),
        ];
        let r = b.merge_history(BTC, Timeframe::M1, &venue, Some(2 * MIN + 5));
        assert_eq!(
            r,
            HistoryMerge {
                changed: true,
                added: 2,
                invalid: 0
            }
        );
        assert_eq!(times(&b), [0, MIN]);
    }

    #[test]
    fn merge_history_with_bars_adds_only_older_and_keeps_live() {
        let mut b = CandleBuilder::default();
        trade(&mut b, 100, 5, 5 * MIN);
        trade(&mut b, 101, 5, 6 * MIN);
        let live = b.bars(BTC, Timeframe::M1);
        let venue = [
            flat(3 * MIN, 1),
            flat(4 * MIN, 2),
            flat(5 * MIN, 3),
            flat(7 * MIN, 4),
        ];
        let r = b.merge_history(BTC, Timeframe::M1, &venue, Some(6 * MIN));
        assert_eq!(r.added, 2);
        assert!(r.changed);
        assert_eq!(times(&b), [3 * MIN, 4 * MIN, 5 * MIN, 6 * MIN]);
        assert_eq!(&b.bars(BTC, Timeframe::M1)[2..], &live[..]);
        // Nothing older left: no change.
        let again = b.merge_history(BTC, Timeframe::M1, &venue[..1], None);
        assert_eq!(again, HistoryMerge::default());
    }

    #[test]
    fn merge_history_unknown_market_time_treats_newest_as_forming() {
        let mut b = CandleBuilder::default();
        let venue = [flat(2 * MIN, 12), flat(0, 10), flat(MIN, 11)];
        let r = b.merge_history(BTC, Timeframe::M1, &venue, None);
        assert_eq!(r.added, 2);
        assert_eq!(times(&b), [0, MIN]);
    }

    #[test]
    fn merge_history_counts_invalid_and_misaligned_bars() {
        let mut b = CandleBuilder::default();
        let venue = [
            flat(0, 10),
            flat(1, 10),                    // misaligned
            bar(MIN, [10, 9, 8, 9], 1),     // open above high
            bar(2 * MIN, [5, 6, 0, 5], 1),  // low not positive
            bar(3 * MIN, [5, 6, 4, 5], -1), // negative volume
            flat(4 * MIN, 7),
        ];
        let r = b.merge_history(BTC, Timeframe::M1, &venue, Some(10 * MIN));
        assert_eq!(r.invalid, 4);
        assert_eq!(r.added, 2);
        assert_eq!(times(&b), [0, 4 * MIN]);
    }

    #[test]
    fn merge_history_duplicate_times_last_wins() {
        let mut b = CandleBuilder::default();
        let venue = [flat(0, 10), flat(0, 20), flat(MIN, 30)];
        let r = b.merge_history(BTC, Timeframe::M1, &venue, Some(5 * MIN));
        assert_eq!(r.added, 2);
        assert_eq!(b.bars(BTC, Timeframe::M1), [flat(0, 20), flat(MIN, 30)]);
    }

    #[test]
    fn merge_history_cap_keeps_the_newest_500() {
        let mut b = CandleBuilder::default();
        trade(&mut b, 100, 1, 600 * MIN);
        let venue: Vec<Bar> = (0..600).map(|i| flat(i * MIN, 10)).collect();
        let r = b.merge_history(BTC, Timeframe::M1, &venue, Some(600 * MIN));
        assert_eq!(r.added, MAX_BARS - 1);
        let got = times(&b);
        assert_eq!(got.len(), MAX_BARS);
        assert_eq!(got.first(), Some(&(101 * MIN)));
        assert_eq!(got.last(), Some(&(600 * MIN)));
        assert!(got.windows(2).all(|w| w[0] < w[1]));
    }
}
