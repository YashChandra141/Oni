//! Indicator_Engine (design §2 "Indicator_Engine", Req 10.1, 10.2). Pure: no I/O, no clock.
//!
//! Units: every price-like indicator value (EMA, SMA, VWAP, Bollinger bands, ATR) is in
//! **ticks**, as `f64`, with no division by the tick size. Clients format them with the
//! instrument's price decimals. RSI is a plain 0 to 100 number. Volume enters VWAP as lots.
//! This keeps small integer inputs exact, so tests can compare against a non-incremental
//! reference without rounding noise.
//!
//! Fixed parameters: EMA(20), SMA(20), Bollinger(20, 2σ), RSI(14, Wilder), ATR(14, Wilder),
//! VWAP anchored to the UTC day.
//!
//! Committed state and `peek`: each indicator keeps state for **closed** bars only. `commit`
//! folds a closed bar in. `peek` returns the value the indicator would have if the forming bar
//! were closed now, without touching committed state, so calling it any number of times is safe.
//! [`SymbolIndicators`] bundles all indicators of one (symbol, timeframe) and commits the
//! previous bar when a bar with a later start time arrives.
//!
//! When a value is `None`:
//! - EMA: never after the first close. It is seeded with the first close and then uses the
//!   standard multiplier `2 / (period + 1)`. Each step is a convex combination of the previous
//!   EMA and the close, so the EMA stays between the min and max of the closes seen (P11).
//! - SMA, Bollinger: until `period` closes (committed plus the forming one) exist.
//! - RSI, ATR: until `period + 1` closes exist (`period` changes or true ranges). The first
//!   average is the plain mean of the first `period` gains, losses, or true ranges (Wilder seed);
//!   later ones are `(prev * (period - 1) + x) / period`. The first bar has no previous close,
//!   so it contributes no true range.
//! - VWAP: until the UTC day's volume is above zero. The sums reset when the bar's UTC day
//!   differs from the previous bar's.
//!
//! RSI edge cases: average loss 0 with average gain above 0 gives 100. Both averages 0 (a flat
//! market) gives 50. The value is clamped to [0, 100]. No indicator ever returns NaN or an
//! infinity: a non-finite result becomes `None`.
//!
//! Late bars: [`SymbolIndicators::update`] ignores a bar whose start time is older than the
//! forming bar's (committed state is never rewritten) and returns `None` for it.

use std::collections::VecDeque;
use std::iter;

use protocol::{Bar, IndicatorValues, Price, Qty, TimeMs};

pub const EMA_PERIOD: usize = 20;
pub const SMA_PERIOD: usize = 20;
pub const BOLLINGER_PERIOD: usize = 20;
pub const BOLLINGER_K: f64 = 2.0;
pub const RSI_PERIOD: usize = 14;
pub const ATR_PERIOD: usize = 14;

/// Milliseconds in a UTC day, the VWAP anchor.
const DAY_MS: TimeMs = 86_400_000;

/// A bar as the indicators see it: prices in ticks and volume in lots, as `f64`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Ohlcv {
    pub t: TimeMs,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
}

#[allow(clippy::cast_precision_loss)]
fn price_f64(p: Price) -> f64 {
    p.0 as f64
}

#[allow(clippy::cast_precision_loss)]
fn qty_f64(q: Qty) -> f64 {
    q.0 as f64
}

/// A period as `f64`. Periods are small constants, so the conversion is exact.
fn period_f64(period: usize) -> f64 {
    f64::from(u32::try_from(period).unwrap_or(u32::MAX))
}

fn finite(x: f64) -> Option<f64> {
    x.is_finite().then_some(x)
}

impl From<&Bar> for Ohlcv {
    fn from(bar: &Bar) -> Self {
        Self {
            t: bar.t,
            high: price_f64(bar.high),
            low: price_f64(bar.low),
            close: price_f64(bar.close),
            volume: qty_f64(bar.volume),
        }
    }
}

/// The last `period` committed closes, oldest first. Shared by SMA and Bollinger, and exposed so
/// tests can compute a non-incremental reference from the same window.
#[derive(Debug, Clone)]
pub struct Window {
    period: usize,
    closes: VecDeque<f64>,
}

impl Window {
    fn new(period: usize) -> Self {
        Self {
            period: period.max(1),
            closes: VecDeque::with_capacity(period.max(1)),
        }
    }

    fn push(&mut self, close: f64) {
        if self.closes.len() == self.period {
            self.closes.pop_front();
        }
        self.closes.push_back(close);
    }

    /// The last `period` closes if `close` were appended, oldest first. `None` until that many
    /// closes exist.
    fn tail_with(&self, close: f64) -> Option<impl Iterator<Item = f64> + '_> {
        if self.closes.len() + 1 < self.period {
            return None;
        }
        let skip = (self.closes.len() + 1).saturating_sub(self.period);
        Some(
            self.closes
                .iter()
                .copied()
                .skip(skip)
                .chain(iter::once(close)),
        )
    }

    /// Mean and population standard deviation of the window with `close` appended.
    fn stats_with(&self, close: f64) -> Option<(f64, f64)> {
        let n = period_f64(self.period);
        let mean = self.tail_with(close)?.sum::<f64>() / n;
        let var = self
            .tail_with(close)?
            .map(|x| (x - mean) * (x - mean))
            .sum::<f64>()
            / n;
        Some((finite(mean)?, finite(var.max(0.0).sqrt())?))
    }

    /// The committed closes, oldest first.
    // Used by tests (Task 9.2 reference computations).
    #[allow(dead_code)]
    pub fn closes(&self) -> &VecDeque<f64> {
        &self.closes
    }
}

/// Exponential moving average, seeded with the first close.
#[derive(Debug, Clone)]
pub struct Ema {
    alpha: f64,
    committed: Option<f64>,
}

impl Ema {
    pub fn new(period: usize) -> Self {
        Self {
            alpha: 2.0 / (period_f64(period.max(1)) + 1.0),
            committed: None,
        }
    }

    fn next(&self, close: f64) -> f64 {
        match self.committed {
            None => close,
            Some(prev) => prev + self.alpha * (close - prev),
        }
    }

    pub fn commit(&mut self, close: f64) {
        self.committed = finite(self.next(close));
    }

    pub fn peek(&self, close: f64) -> Option<f64> {
        finite(self.next(close))
    }
}

/// Simple moving average of the last `period` closes.
#[derive(Debug, Clone)]
pub struct Sma {
    window: Window,
}

impl Sma {
    pub fn new(period: usize) -> Self {
        Self {
            window: Window::new(period),
        }
    }

    pub fn commit(&mut self, close: f64) {
        self.window.push(close);
    }

    pub fn peek(&self, close: f64) -> Option<f64> {
        self.window.stats_with(close).map(|(mean, _)| mean)
    }

    /// The committed window, for reference computations in tests.
    #[allow(dead_code)]
    pub fn window(&self) -> &Window {
        &self.window
    }
}

/// Bollinger bands: SMA ± k × population standard deviation over the window.
#[derive(Debug, Clone)]
pub struct Bollinger {
    window: Window,
    k: f64,
}

/// Upper, middle, and lower band, in ticks.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Bands {
    pub upper: f64,
    pub mid: f64,
    pub lower: f64,
}

impl Bollinger {
    pub fn new(period: usize, k: f64) -> Self {
        Self {
            window: Window::new(period),
            k,
        }
    }

    pub fn commit(&mut self, close: f64) {
        self.window.push(close);
    }

    pub fn peek(&self, close: f64) -> Option<Bands> {
        let (mean, std) = self.window.stats_with(close)?;
        Some(Bands {
            upper: finite(mean + self.k * std)?,
            mid: mean,
            lower: finite(mean - self.k * std)?,
        })
    }

    /// The committed window, for reference computations in tests.
    #[allow(dead_code)]
    pub fn window(&self) -> &Window {
        &self.window
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct RsiState {
    prev: Option<f64>,
    /// Wilder averages (gain, loss) once seeded.
    avg: Option<(f64, f64)>,
    seed_gain: f64,
    seed_loss: f64,
    seed_n: usize,
}

/// Relative strength index with Wilder smoothing.
#[derive(Debug, Clone)]
pub struct Rsi {
    period: usize,
    state: RsiState,
}

impl Rsi {
    pub fn new(period: usize) -> Self {
        Self {
            period: period.max(1),
            state: RsiState::default(),
        }
    }

    fn step(&self, close: f64) -> RsiState {
        let mut s = self.state;
        let p = period_f64(self.period);
        if let Some(prev) = self.state.prev {
            let change = close - prev;
            let gain = change.max(0.0);
            let loss = (-change).max(0.0);
            match self.state.avg {
                Some((ag, al)) => {
                    s.avg = Some(((ag * (p - 1.0) + gain) / p, (al * (p - 1.0) + loss) / p));
                }
                None => {
                    s.seed_gain += gain;
                    s.seed_loss += loss;
                    s.seed_n += 1;
                    if s.seed_n >= self.period {
                        s.avg = Some((s.seed_gain / p, s.seed_loss / p));
                    }
                }
            }
        }
        s.prev = Some(close);
        s
    }

    fn value(state: &RsiState) -> Option<f64> {
        let (gain, loss) = state.avg?;
        let rsi = if gain == 0.0 && loss == 0.0 {
            50.0
        } else if loss == 0.0 {
            100.0
        } else {
            100.0 - 100.0 / (1.0 + gain / loss)
        };
        finite(rsi).map(|r| r.clamp(0.0, 100.0))
    }

    pub fn commit(&mut self, close: f64) {
        self.state = self.step(close);
    }

    pub fn peek(&self, close: f64) -> Option<f64> {
        Self::value(&self.step(close))
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct AtrState {
    prev_close: Option<f64>,
    avg: Option<f64>,
    seed_sum: f64,
    seed_n: usize,
}

/// Average true range with Wilder smoothing.
#[derive(Debug, Clone)]
pub struct Atr {
    period: usize,
    state: AtrState,
}

impl Atr {
    pub fn new(period: usize) -> Self {
        Self {
            period: period.max(1),
            state: AtrState::default(),
        }
    }

    fn step(&self, bar: &Ohlcv) -> AtrState {
        let mut s = self.state;
        let p = period_f64(self.period);
        if let Some(pc) = self.state.prev_close {
            let tr = (bar.high - bar.low)
                .max((bar.high - pc).abs())
                .max((bar.low - pc).abs());
            match self.state.avg {
                Some(avg) => s.avg = Some((avg * (p - 1.0) + tr) / p),
                None => {
                    s.seed_sum += tr;
                    s.seed_n += 1;
                    if s.seed_n >= self.period {
                        s.avg = Some(s.seed_sum / p);
                    }
                }
            }
        }
        s.prev_close = Some(bar.close);
        s
    }

    pub fn commit(&mut self, bar: &Ohlcv) {
        self.state = self.step(bar);
    }

    pub fn peek(&self, bar: &Ohlcv) -> Option<f64> {
        self.step(bar).avg.and_then(finite)
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct VwapState {
    day: Option<TimeMs>,
    sum_pv: f64,
    sum_v: f64,
}

/// Volume-weighted average price, anchored to the UTC day of the bar start time.
#[derive(Debug, Clone, Default)]
pub struct Vwap {
    state: VwapState,
}

impl Vwap {
    pub fn new() -> Self {
        Self::default()
    }

    fn step(&self, bar: &Ohlcv) -> VwapState {
        let day = bar.t.div_euclid(DAY_MS);
        let mut s = if self.state.day == Some(day) {
            self.state
        } else {
            VwapState::default()
        };
        let typical = (bar.high + bar.low + bar.close) / 3.0;
        s.day = Some(day);
        s.sum_pv += typical * bar.volume;
        s.sum_v += bar.volume;
        s
    }

    fn value(state: &VwapState) -> Option<f64> {
        if state.sum_v > 0.0 {
            finite(state.sum_pv / state.sum_v)
        } else {
            None
        }
    }

    pub fn commit(&mut self, bar: &Ohlcv) {
        self.state = self.step(bar);
    }

    pub fn peek(&self, bar: &Ohlcv) -> Option<f64> {
        Self::value(&self.step(bar))
    }
}

/// All indicators of one (symbol, timeframe).
#[derive(Debug, Clone)]
pub struct SymbolIndicators {
    ema: Ema,
    sma: Sma,
    bollinger: Bollinger,
    rsi: Rsi,
    atr: Atr,
    vwap: Vwap,
    /// The newest bar seen. It is not committed until a later bar arrives.
    forming: Option<Ohlcv>,
}

impl Default for SymbolIndicators {
    fn default() -> Self {
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
}

impl SymbolIndicators {
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

    /// Takes the latest state of a bar and returns the values with that bar as the forming one.
    ///
    /// A bar with a later start time than the forming bar closes the forming bar first. A bar
    /// with the same start time replaces the forming bar. A bar with an earlier start time is
    /// late: nothing changes and the result is `None`.
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

    /// The start time of the forming bar and the current values, or `None` before any bar.
    pub fn current(&self) -> Option<(TimeMs, IndicatorValues)> {
        let forming = self.forming?;
        Some((forming.t, self.peek(&forming)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ohlcv(t: TimeMs, high: f64, low: f64, close: f64, volume: f64) -> Ohlcv {
        Ohlcv {
            t,
            high,
            low,
            close,
            volume,
        }
    }

    fn bar(t: TimeMs, high: i64, low: i64, close: i64, volume: i64) -> Bar {
        Bar {
            t,
            open: Price(close),
            high: Price(high),
            low: Price(low),
            close: Price(close),
            volume: Qty(volume),
        }
    }

    fn approx(a: Option<f64>, b: f64) {
        match a {
            Some(a) => assert!((a - b).abs() < 1e-9, "{a} vs {b}"),
            None => panic!("expected {b}, got None"),
        }
    }

    #[test]
    fn sma_needs_a_full_window_and_slides() {
        let mut sma = Sma::new(3);
        assert_eq!(sma.peek(1.0), None);
        sma.commit(1.0);
        assert_eq!(sma.peek(2.0), None);
        sma.commit(2.0);
        approx(sma.peek(3.0), 2.0);
        sma.commit(3.0);
        approx(sma.peek(4.0), 3.0);
        sma.commit(4.0);
        assert_eq!(
            sma.window().closes().iter().copied().collect::<Vec<_>>(),
            [2.0, 3.0, 4.0]
        );
        approx(sma.peek(5.0), 4.0);
    }

    #[test]
    fn peek_does_not_change_committed_state() {
        let mut sma = Sma::new(3);
        sma.commit(1.0);
        sma.commit(2.0);
        let first = sma.peek(9.0);
        assert_eq!(sma.peek(9.0), first);
        sma.commit(3.0);
        approx(sma.peek(4.0), 3.0);

        let mut ema = Ema::new(3);
        ema.commit(10.0);
        assert_eq!(ema.peek(20.0), ema.peek(20.0));
        approx(ema.peek(20.0), 15.0);
        ema.commit(20.0);
        approx(ema.peek(30.0), 22.5);
    }

    #[test]
    fn ema_period_3_uses_multiplier_one_half() {
        let mut ema = Ema::new(3);
        approx(ema.peek(10.0), 10.0);
        ema.commit(10.0);
        ema.commit(20.0);
        approx(ema.peek(20.0), 17.5);
        ema.commit(30.0);
        approx(ema.peek(30.0), 26.25);
    }

    #[test]
    fn bollinger_on_constant_prices_has_zero_width() {
        let mut bb = Bollinger::new(3, 2.0);
        assert_eq!(bb.peek(5.0), None);
        bb.commit(5.0);
        bb.commit(5.0);
        let bands = bb.peek(5.0).expect("window is full");
        assert_eq!((bands.upper, bands.mid, bands.lower), (5.0, 5.0, 5.0));
    }

    #[test]
    fn bollinger_uses_population_standard_deviation() {
        let mut bb = Bollinger::new(3, 2.0);
        bb.commit(1.0);
        bb.commit(2.0);
        let bands = bb.peek(3.0).expect("window is full");
        let std = (2.0_f64 / 3.0).sqrt();
        approx(Some(bands.mid), 2.0);
        approx(Some(bands.upper), 2.0 + 2.0 * std);
        approx(Some(bands.lower), 2.0 - 2.0 * std);
    }

    #[test]
    fn rsi_rising_is_100_falling_is_0_flat_is_50() {
        for (closes, expected) in [
            ([1.0, 2.0, 3.0, 4.0, 5.0], 100.0),
            ([5.0, 4.0, 3.0, 2.0, 1.0], 0.0),
            ([3.0, 3.0, 3.0, 3.0, 3.0], 50.0),
        ] {
            let mut rsi = Rsi::new(3);
            // Needs period + 1 closes: 3 committed plus the peeked one.
            rsi.commit(closes[0]);
            rsi.commit(closes[1]);
            assert_eq!(rsi.peek(closes[2]), None);
            rsi.commit(closes[2]);
            approx(rsi.peek(closes[3]), expected);
            rsi.commit(closes[3]);
            approx(rsi.peek(closes[4]), expected);
        }
    }

    #[test]
    fn rsi_uses_wilder_smoothing_after_the_seed() {
        let mut rsi = Rsi::new(2);
        rsi.commit(10.0);
        rsi.commit(12.0); // gain 2
        // Seed with the peeked change: gains (2 + 0) / 2 = 1, losses (0 + 1) / 2 = 0.5.
        approx(rsi.peek(11.0), 100.0 - 100.0 / (1.0 + 1.0 / 0.5));
        rsi.commit(11.0);
        // Wilder: gain (1 * 1 + 3) / 2 = 2, loss (0.5 * 1 + 0) / 2 = 0.25.
        approx(rsi.peek(14.0), 100.0 - 100.0 / (1.0 + 2.0 / 0.25));
    }

    #[test]
    fn atr_on_a_constant_range_equals_the_range() {
        let mut atr = Atr::new(2);
        let b1 = ohlcv(0, 10.0, 8.0, 9.0, 1.0);
        let b2 = ohlcv(1, 11.0, 9.0, 10.0, 1.0);
        let b3 = ohlcv(2, 12.0, 10.0, 11.0, 1.0);
        assert_eq!(atr.peek(&b1), None);
        atr.commit(&b1);
        assert_eq!(atr.peek(&b2), None);
        atr.commit(&b2);
        approx(atr.peek(&b3), 2.0);
        atr.commit(&b3);
        // True range from the previous close: max(2, |15 - 11|, |13 - 11|) = 4.
        let b4 = ohlcv(3, 15.0, 13.0, 14.0, 1.0);
        approx(atr.peek(&b4), 3.0);
        assert_eq!(atr.peek(&b4), atr.peek(&b4));
    }

    #[test]
    fn vwap_weights_typical_price_and_resets_at_the_utc_day() {
        let mut vwap = Vwap::new();
        let b1 = ohlcv(0, 3.0, 3.0, 3.0, 2.0);
        let b2 = ohlcv(60_000, 6.0, 6.0, 6.0, 2.0);
        let next_day = ohlcv(DAY_MS, 10.0, 10.0, 10.0, 1.0);
        assert_eq!(vwap.peek(&ohlcv(0, 3.0, 3.0, 3.0, 0.0)), None);
        approx(vwap.peek(&b1), 3.0);
        vwap.commit(&b1);
        approx(vwap.peek(&b2), 4.5);
        vwap.commit(&b2);
        approx(vwap.peek(&next_day), 10.0);
        vwap.commit(&next_day);
        approx(
            vwap.peek(&ohlcv(DAY_MS + 60_000, 20.0, 20.0, 20.0, 1.0)),
            15.0,
        );
        // Typical price is (h + l + c) / 3.
        approx(Vwap::new().peek(&ohlcv(0, 6.0, 3.0, 3.0, 1.0)), 4.0);
    }

    #[test]
    fn indicators_stay_finite_and_rsi_in_range_on_extreme_inputs() {
        let mut ind = SymbolIndicators::default();
        for i in 0..40_i64 {
            let price = if i % 2 == 0 { 1 } else { i64::MAX };
            let values = ind
                .update(&bar(i * 60_000, price, 1, price, i64::MAX))
                .unwrap();
            for v in [
                values.ema,
                values.sma,
                values.vwap,
                values.bb_upper,
                values.bb_mid,
                values.bb_lower,
                values.rsi,
                values.atr,
            ]
            .into_iter()
            .flatten()
            {
                assert!(v.is_finite());
            }
            if let Some(rsi) = values.rsi {
                assert!((0.0..=100.0).contains(&rsi));
            }
        }
    }

    #[test]
    fn symbol_indicators_are_none_until_enough_bars() {
        let mut ind = SymbolIndicators::default();
        assert_eq!(ind.current(), None);
        let mut last = IndicatorValues::default();
        for i in 0..14_i64 {
            last = ind.update(&bar(i * 60_000, 110, 90, 100 + i, 5)).unwrap();
        }
        // 14 bars: EMA and VWAP exist, SMA/Bollinger (20) and RSI/ATR (15 closes) do not.
        assert!(last.ema.is_some() && last.vwap.is_some());
        assert_eq!(
            (last.sma, last.bb_upper, last.rsi, last.atr),
            (None, None, None, None)
        );
        last = ind.update(&bar(14 * 60_000, 110, 90, 114, 5)).unwrap();
        assert!(last.rsi.is_some() && last.atr.is_some() && last.sma.is_none());
        for i in 15..20_i64 {
            last = ind.update(&bar(i * 60_000, 110, 90, 100 + i, 5)).unwrap();
        }
        assert!(last.sma.is_some() && last.bb_mid.is_some());
    }

    #[test]
    fn same_start_time_replaces_the_forming_bar_without_committing() {
        let mut ind = SymbolIndicators::default();
        ind.update(&bar(0, 10, 10, 10, 1)).unwrap();
        ind.update(&bar(0, 12, 8, 12, 3)).unwrap();
        let (t, values) = ind.current().unwrap();
        assert_eq!(t, 0);
        approx(values.ema, 12.0);
        // The next bar commits only the final state of the first one.
        let next = ind.update(&bar(60_000, 12, 12, 14, 1)).unwrap();
        // EMA(20): alpha = 2 / 21 applied to 12 -> 14.
        approx(next.ema, 12.0 + (2.0 / 21.0) * 2.0);
        // First bar: typical (12 + 8 + 12) / 3 over volume 3. Second: (12 + 12 + 14) / 3 over 1.
        approx(next.vwap, (32.0 + 38.0 / 3.0) / 4.0);
    }

    #[test]
    fn late_bars_are_ignored() {
        let mut ind = SymbolIndicators::default();
        ind.update(&bar(0, 10, 10, 10, 1)).unwrap();
        ind.update(&bar(60_000, 20, 20, 20, 1)).unwrap();
        let before = ind.current();
        assert_eq!(ind.update(&bar(0, 99, 1, 50, 9)), None);
        assert_eq!(ind.current(), before);
    }

    #[test]
    fn same_inputs_give_the_same_values() {
        let run = || {
            let mut ind = SymbolIndicators::default();
            (0..30_i64)
                .map(|i| ind.update(&bar(i * 60_000, 120 + i, 80, 100 + (i * 7) % 13, 1 + i)))
                .collect::<Vec<_>>()
        };
        assert_eq!(run(), run());
    }
}

#[cfg(test)]
#[path = "indicators_properties.rs"]
mod properties;
