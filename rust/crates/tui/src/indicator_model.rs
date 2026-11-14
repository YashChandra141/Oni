//! Pure indicator math for the chart overlays and the RSI/ATR sub-pane (Req 26.1-26.4, 34.2).
//!
//! No ratatui types here. Indicator values are the only floats in the protocol (Req 1.5).
//! Units, from the engine: EMA, SMA, VWAP, Bollinger bands, and ATR are `f64` values in
//! ticks (the same unit as `Price`), RSI is 0 to 100.
//!
//! ## Dot mapping rule
//!
//! A braille cell is 2 dot columns wide and 4 dot rows high. A plot of `rows` cell rows has
//! `4 * rows` dot rows. Dot row 0 is the top of the plot and shows the scale max price; dot
//! row `4 * rows - 1` shows the scale min price. [`value_to_dot_row`] maps a value linearly
//! between those two, then rounds to the nearest dot row (halves round up, away from zero),
//! and clamps into the plot. A value outside `[scale.min, scale.max]`, a non-finite value, and
//! a missing value (`None`) are skipped, never clamped, so a line leaves the plot instead of
//! sticking to its edge. This is the same price scale as the candles (`PriceScale`).
//!
//! The charts draw one bar per column, so each line gets one dot per column, in the left dot
//! column of the cell (dot x = `2 * column`). To keep a line continuous, [`line_dots`] adds,
//! for a bar whose previous bar also has a value, every dot row between the previous bar's
//! row and this bar's row (both included) in this bar's column. A bar without a previous
//! value gets just its own dot.

// Some helpers are used only by tests or by later panels.
#![allow(dead_code)]

use protocol::{Bar, IndicatorValues};

use crate::chart_model::{PRICE_DECIMALS, PriceScale, bar_col, format_fixed};

/// Most points kept per (symbol, timeframe), the same as the candle history.
pub const MAX_POINTS: usize = 500;

/// Smallest chart column height that gets an RSI/ATR sub-pane (Req 26.2).
pub const MIN_SUBPANE_CHART_ROWS: u16 = 20;

/// The five indicators the user can toggle (Req 26.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Indicator {
    Ema,
    Vwap,
    Bollinger,
    Rsi,
    Atr,
}

impl Indicator {
    /// In the order of the toggle strip.
    pub const ALL: [Indicator; 5] = [
        Indicator::Ema,
        Indicator::Vwap,
        Indicator::Bollinger,
        Indicator::Rsi,
        Indicator::Atr,
    ];

    /// Short label for the toggle strip and the legend.
    pub fn label(self) -> &'static str {
        match self {
            Indicator::Ema => "EMA",
            Indicator::Vwap => "VWAP",
            Indicator::Bollinger => "BB",
            Indicator::Rsi => "RSI",
            Indicator::Atr => "ATR",
        }
    }
}

/// Which indicators are shown. Defaults: EMA, VWAP, and RSI on; Bollinger and ATR off.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Toggles {
    pub ema: bool,
    pub vwap: bool,
    pub bollinger: bool,
    pub rsi: bool,
    pub atr: bool,
}

impl Default for Toggles {
    fn default() -> Self {
        Self {
            ema: true,
            vwap: true,
            bollinger: false,
            rsi: true,
            atr: false,
        }
    }
}

impl Toggles {
    pub fn is_on(&self, indicator: Indicator) -> bool {
        match indicator {
            Indicator::Ema => self.ema,
            Indicator::Vwap => self.vwap,
            Indicator::Bollinger => self.bollinger,
            Indicator::Rsi => self.rsi,
            Indicator::Atr => self.atr,
        }
    }

    /// Flips one indicator and returns its new state.
    pub fn toggle(&mut self, indicator: Indicator) -> bool {
        let flag = match indicator {
            Indicator::Ema => &mut self.ema,
            Indicator::Vwap => &mut self.vwap,
            Indicator::Bollinger => &mut self.bollinger,
            Indicator::Rsi => &mut self.rsi,
            Indicator::Atr => &mut self.atr,
        };
        *flag = !*flag;
        *flag
    }

    /// True when the RSI/ATR sub-pane has something to show.
    pub fn wants_subpane(&self) -> bool {
        self.rsi || self.atr
    }
}

/// The indicator values of the bar that starts at `t` (ms since the epoch).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct IndicatorPoint {
    pub t: i64,
    pub values: IndicatorValues,
}

/// The points of one (symbol, timeframe), oldest first, at most [`MAX_POINTS`].
#[derive(Debug, Clone, Default, PartialEq)]
pub struct IndicatorSeries {
    points: Vec<IndicatorPoint>,
}

impl IndicatorSeries {
    pub fn points(&self) -> &[IndicatorPoint] {
        &self.points
    }

    pub fn is_empty(&self) -> bool {
        self.points.is_empty()
    }

    /// Merges a point: the same `t` replaces the stored point, any other `t` is inserted in
    /// time order. The series keeps the newest [`MAX_POINTS`] points.
    pub fn merge(&mut self, point: IndicatorPoint) {
        match self.points.binary_search_by_key(&point.t, |p| p.t) {
            Ok(i) => self.points[i] = point,
            Err(i) => self.points.insert(i, point),
        }
        if self.points.len() > MAX_POINTS {
            let excess = self.points.len() - MAX_POINTS;
            self.points.drain(..excess);
        }
    }

    /// The newest `Some` value that `pick` finds.
    pub fn latest(&self, pick: fn(&IndicatorValues) -> Option<f64>) -> Option<f64> {
        self.points.iter().rev().find_map(|p| pick(&p.values))
    }
}

pub fn pick_ema(v: &IndicatorValues) -> Option<f64> {
    v.ema
}
pub fn pick_vwap(v: &IndicatorValues) -> Option<f64> {
    v.vwap
}
pub fn pick_bb_upper(v: &IndicatorValues) -> Option<f64> {
    v.bb_upper
}
pub fn pick_bb_mid(v: &IndicatorValues) -> Option<f64> {
    v.bb_mid
}
pub fn pick_bb_lower(v: &IndicatorValues) -> Option<f64> {
    v.bb_lower
}
pub fn pick_rsi(v: &IndicatorValues) -> Option<f64> {
    v.rsi
}
pub fn pick_atr(v: &IndicatorValues) -> Option<f64> {
    v.atr
}

/// One dot in the plot's dot grid: `x` in `0..2 * width`, `y` in `0..4 * rows`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Dot {
    pub x: usize,
    pub y: usize,
}

/// Dot row of `value` in a plot of `rows` cell rows, by the rule in the module header.
/// `None` for a non-finite value, a value outside the scale, or `rows == 0`.
pub fn value_to_dot_row(value: f64, scale: &PriceScale, rows: usize) -> Option<usize> {
    let dot_rows = rows.checked_mul(4)?;
    if dot_rows == 0 || !value.is_finite() {
        return None;
    }
    let (min, max) = (scale.min as f64, scale.max as f64);
    if value < min || value > max || max <= min {
        return None;
    }
    let last = dot_rows - 1;
    let ratio = (max - value) / (max - min);
    let row = (ratio * last as f64).round();
    // `row` is finite and within 0..=last here; the cast saturates at worst.
    Some((row as usize).min(last))
}

/// The point of the bar that starts at `t`.
fn point_at(points: &[IndicatorPoint], t: i64) -> Option<&IndicatorPoint> {
    points
        .binary_search_by_key(&t, |p| p.t)
        .ok()
        .and_then(|i| points.get(i))
}

/// The dots of one line over the visible `bars` (right-aligned in `width` columns), with the
/// continuity fill described in the module header.
pub fn line_dots(
    points: &[IndicatorPoint],
    bars: &[Bar],
    pick: fn(&IndicatorValues) -> Option<f64>,
    scale: &PriceScale,
    width: usize,
    rows: usize,
) -> Vec<Dot> {
    let count = bars.len();
    let mut dots = Vec::new();
    let mut previous: Option<usize> = None;
    for (i, bar) in bars.iter().enumerate() {
        let row = point_at(points, bar.t)
            .and_then(|p| pick(&p.values))
            .and_then(|v| value_to_dot_row(v, scale, rows));
        if let Some(row) = row {
            let x = bar_col(i, count, width) * 2;
            let (lo, hi) = match previous {
                Some(p) => (p.min(row), p.max(row)),
                None => (row, row),
            };
            dots.extend((lo..=hi).map(|y| Dot { x, y }));
        }
        previous = row;
    }
    dots
}

/// `(x, y)` pairs for the sub-pane chart: x is the plot column of the bar plus 0.5 (so the
/// point sits in the middle of the candle column), y is the raw value. Bars without a finite
/// value are skipped.
pub fn series_xy(
    points: &[IndicatorPoint],
    bars: &[Bar],
    pick: fn(&IndicatorValues) -> Option<f64>,
    width: usize,
) -> Vec<(f64, f64)> {
    let count = bars.len();
    bars.iter()
        .enumerate()
        .filter_map(|(i, bar)| {
            let v = point_at(points, bar.t).and_then(|p| pick(&p.values))?;
            v.is_finite()
                .then(|| (bar_col(i, count, width) as f64 + 0.5, v))
        })
        .collect()
}

/// Rescales the y values of `xy` into `0.0..=100.0` by their own min and max, so ATR can share
/// the RSI axis. Returns the original `(min, max)`. A flat series maps to 50. `None` when
/// `xy` is empty.
pub fn normalize_to_100(xy: &mut [(f64, f64)]) -> Option<(f64, f64)> {
    let min = xy.iter().map(|p| p.1).fold(f64::INFINITY, f64::min);
    let max = xy.iter().map(|p| p.1).fold(f64::NEG_INFINITY, f64::max);
    if !min.is_finite() || !max.is_finite() {
        return None;
    }
    for p in xy.iter_mut() {
        p.1 = if max > min {
            (p.1 - min) / (max - min) * 100.0
        } else {
            50.0
        };
    }
    Some((min, max))
}

/// Rows of the RSI/ATR sub-pane inside a chart column of `chart_rows` rows: a quarter of the
/// rows (rounded down) from [`MIN_SUBPANE_CHART_ROWS`] rows up, otherwise 0.
pub fn subpane_rows(chart_rows: u16) -> u16 {
    if chart_rows >= MIN_SUBPANE_CHART_ROWS {
        chart_rows / 4
    } else {
        0
    }
}

/// Ticks as price text with the price decimals, e.g. `6400050.0` is `64000.50`. `None` for a
/// non-finite or out-of-range value.
pub fn format_ticks(value: f64) -> Option<String> {
    if !value.is_finite() || value.abs() >= 9.0e18 {
        return None;
    }
    Some(format_fixed(value.round() as i64, PRICE_DECIMALS))
}

/// The legend line (Req 26.4): the latest value of each enabled indicator, e.g.
/// `EMA 64000.50  VWAP 63990.00  RSI 55.3`. Empty when nothing has a value.
pub fn legend_text(series: &IndicatorSeries, toggles: &Toggles) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut price = |label: &str, pick: fn(&IndicatorValues) -> Option<f64>| {
        if let Some(text) = series.latest(pick).and_then(format_ticks) {
            parts.push(format!("{label} {text}"));
        }
    };
    if toggles.ema {
        price("EMA", pick_ema);
    }
    if toggles.vwap {
        price("VWAP", pick_vwap);
    }
    if toggles.bollinger {
        let bands = [pick_bb_upper, pick_bb_mid, pick_bb_lower]
            .map(|pick| series.latest(pick).and_then(format_ticks));
        if let [Some(u), Some(m), Some(l)] = bands {
            parts.push(format!("BB {u} {m} {l}"));
        }
    }
    if toggles.rsi
        && let Some(v) = series.latest(pick_rsi).filter(|v| v.is_finite())
    {
        parts.push(format!("RSI {v:.1}"));
    }
    if toggles.atr
        && let Some(text) = series.latest(pick_atr).and_then(format_ticks)
    {
        parts.push(format!("ATR {text}"));
    }
    parts.join("  ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::{Price, Qty};

    fn values(ema: Option<f64>) -> IndicatorValues {
        IndicatorValues {
            ema,
            ..IndicatorValues::default()
        }
    }

    fn point(t: i64, ema: Option<f64>) -> IndicatorPoint {
        IndicatorPoint {
            t,
            values: values(ema),
        }
    }

    fn bar(t: i64) -> Bar {
        Bar {
            t,
            open: Price(1),
            high: Price(1),
            low: Price(1),
            close: Price(1),
            volume: Qty(1),
        }
    }

    const SCALE: PriceScale = PriceScale { min: 0, max: 1_000 };

    #[test]
    fn toggles_default_and_flip() {
        let mut t = Toggles::default();
        assert!(t.ema && t.vwap && t.rsi && !t.bollinger && !t.atr);
        assert!(t.wants_subpane());
        assert!(t.toggle(Indicator::Bollinger));
        assert!(t.is_on(Indicator::Bollinger));
        assert!(!t.toggle(Indicator::Ema));
        assert!(!t.toggle(Indicator::Rsi));
        assert!(!t.wants_subpane());
        assert!(t.toggle(Indicator::Atr));
        assert!(t.wants_subpane());
        assert!(!t.toggle(Indicator::Atr));
        assert_eq!(Indicator::ALL.map(Indicator::label), ["EMA", "VWAP", "BB", "RSI", "ATR"]);
    }

    #[test]
    fn merge_replaces_same_t_and_inserts_in_order() {
        let mut s = IndicatorSeries::default();
        s.merge(point(60, Some(1.0)));
        s.merge(point(180, Some(3.0)));
        s.merge(point(120, Some(2.0)));
        s.merge(point(120, Some(9.0)));
        let ts: Vec<i64> = s.points().iter().map(|p| p.t).collect();
        assert_eq!(ts, [60, 120, 180]);
        assert_eq!(s.points()[1].values.ema, Some(9.0));
    }

    #[test]
    fn merge_caps_at_500_keeping_the_newest() {
        let mut s = IndicatorSeries::default();
        for t in 0..510 {
            s.merge(point(t, Some(1.0)));
        }
        assert_eq!(s.points().len(), MAX_POINTS);
        assert_eq!(s.points()[0].t, 10);
    }

    #[test]
    fn latest_skips_missing_values() {
        let mut s = IndicatorSeries::default();
        s.merge(point(0, Some(5.0)));
        s.merge(point(1, None));
        assert_eq!(s.latest(pick_ema), Some(5.0));
        assert_eq!(s.latest(pick_rsi), None);
    }

    #[test]
    fn dot_rows_map_top_and_bottom_of_the_scale() {
        // 10 rows: 40 dot rows, last = 39.
        assert_eq!(value_to_dot_row(1_000.0, &SCALE, 10), Some(0));
        assert_eq!(value_to_dot_row(0.0, &SCALE, 10), Some(39));
        // 19.5 rounds up to 20.
        assert_eq!(value_to_dot_row(500.0, &SCALE, 10), Some(20));
        assert_eq!(value_to_dot_row(0.0, &SCALE, 1), Some(3));
    }

    #[test]
    fn dot_rows_skip_outside_missing_and_degenerate() {
        assert_eq!(value_to_dot_row(1_000.5, &SCALE, 10), None);
        assert_eq!(value_to_dot_row(-0.5, &SCALE, 10), None);
        assert_eq!(value_to_dot_row(f64::NAN, &SCALE, 10), None);
        assert_eq!(value_to_dot_row(f64::INFINITY, &SCALE, 10), None);
        assert_eq!(value_to_dot_row(5.0, &SCALE, 0), None);
    }

    #[test]
    fn line_dots_are_one_per_column_with_none_skipped() {
        // 3 bars right-aligned in 10 columns: columns 7, 8, 9.
        let bars = [bar(0), bar(60), bar(120)];
        let points = [point(0, Some(1_000.0)), point(60, None), point(120, Some(1_000.0))];
        let dots = line_dots(&points, &bars, pick_ema, &SCALE, 10, 10);
        assert_eq!(dots, [Dot { x: 14, y: 0 }, Dot { x: 18, y: 0 }]);
        // A bar with no point at all is skipped too.
        let dots = line_dots(&points[..1], &bars, pick_ema, &SCALE, 10, 10);
        assert_eq!(dots, [Dot { x: 14, y: 0 }]);
    }

    #[test]
    fn line_dots_fill_between_adjacent_columns() {
        let bars = [bar(0), bar(60)];
        // Rows 0 and 39 of 40: the second column gets every row from 0 to 39.
        let points = [point(0, Some(1_000.0)), point(60, Some(0.0))];
        let dots = line_dots(&points, &bars, pick_ema, &SCALE, 2, 10);
        assert_eq!(dots.len(), 1 + 40);
        assert_eq!(dots[0], Dot { x: 0, y: 0 });
        assert!(dots[1..].iter().all(|d| d.x == 2));
        assert_eq!(dots[1], Dot { x: 2, y: 0 });
        assert_eq!(dots[40], Dot { x: 2, y: 39 });
        // The fill also runs upward.
        let points = [point(0, Some(0.0)), point(60, Some(1_000.0))];
        let dots = line_dots(&points, &bars, pick_ema, &SCALE, 2, 10);
        assert_eq!(dots.len(), 41);
        assert_eq!(dots[1], Dot { x: 2, y: 0 });
    }

    #[test]
    fn a_gap_breaks_the_fill() {
        let bars = [bar(0), bar(60), bar(120)];
        let points = [point(0, Some(1_000.0)), point(60, None), point(120, Some(0.0))];
        let dots = line_dots(&points, &bars, pick_ema, &SCALE, 3, 10);
        assert_eq!(dots, [Dot { x: 0, y: 0 }, Dot { x: 4, y: 39 }]);
    }

    #[test]
    fn xy_points_sit_mid_column_and_normalize() {
        let bars = [bar(0), bar(60)];
        let points = [point(0, Some(10.0)), point(60, Some(30.0))];
        let mut xy = series_xy(&points, &bars, pick_ema, 5);
        assert_eq!(xy, [(3.5, 10.0), (4.5, 30.0)]);
        assert_eq!(normalize_to_100(&mut xy), Some((10.0, 30.0)));
        assert_eq!(xy, [(3.5, 0.0), (4.5, 100.0)]);
        let mut flat = vec![(0.5, 7.0), (1.5, 7.0)];
        assert_eq!(normalize_to_100(&mut flat), Some((7.0, 7.0)));
        assert_eq!(flat[0].1, 50.0);
        assert_eq!(normalize_to_100(&mut []), None);
    }

    #[test]
    fn the_subpane_needs_20_rows() {
        assert_eq!(subpane_rows(19), 0);
        assert_eq!(subpane_rows(20), 5);
        assert_eq!(subpane_rows(27), 6);
        assert_eq!(subpane_rows(0), 0);
    }

    #[test]
    fn legend_shows_the_latest_enabled_values() {
        let mut s = IndicatorSeries::default();
        s.merge(IndicatorPoint {
            t: 0,
            values: IndicatorValues {
                ema: Some(6_400_050.4),
                vwap: Some(6_399_000.0),
                bb_upper: Some(6_410_000.0),
                bb_mid: Some(6_400_000.0),
                bb_lower: Some(6_390_000.0),
                rsi: Some(55.26),
                atr: Some(1_234.0),
                ..IndicatorValues::default()
            },
        });
        let mut t = Toggles::default();
        assert_eq!(
            legend_text(&s, &t),
            "EMA 64000.50  VWAP 63990.00  RSI 55.3"
        );
        t.bollinger = true;
        t.atr = true;
        t.ema = false;
        t.vwap = false;
        t.rsi = false;
        assert_eq!(
            legend_text(&s, &t),
            "BB 64100.00 64000.00 63900.00  ATR 12.34"
        );
        assert_eq!(legend_text(&IndicatorSeries::default(), &Toggles::default()), "");
        assert_eq!(format_ticks(f64::NAN), None);
        assert_eq!(format_ticks(1e30), None);
    }
}
