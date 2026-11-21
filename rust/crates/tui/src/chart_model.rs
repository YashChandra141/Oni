//! Pure chart math for the candle chart (Req 25.1-25.4, 29.1, 29.2, 34.1).
//!
//! No ratatui types here. Everything is integer math: prices are ticks (`i64`), products are
//! computed in `i128`, and nothing uses floats. The widget in `chart_widget.rs` only turns
//! these results into styled cells.
//!
//! Layout contract:
//! - One column per bar. The visible bars are right-aligned in the plot area, so the newest
//!   visible bar is in the last plot column.
//! - A plot of `height` rows has `2 * height` half-rows. The max price of the scale is half-row
//!   0 and the min price is half-row `2 * height - 1`. A row is `half / 2`.

// Some helpers are used only by tests or by later panels.
#![allow(dead_code)]

use protocol::{Bar, Price, Qty, Timeframe};

/// Fewest bars the zoom window shows.
pub const MIN_VISIBLE: usize = 10;
/// Most bars the zoom window shows (the server sends at most 500 history bars, Req 8.7).
pub const MAX_VISIBLE: usize = 500;
/// Bars the app keeps per symbol and timeframe.
pub const MAX_BARS: usize = 500;
/// Price decimals (internal fixed decimals, 2).
pub const PRICE_DECIMALS: u32 = 2;
/// Quantity decimals (internal fixed decimals, 8).
pub const QTY_DECIMALS: u32 = 8;

/// The zoom and pan window over the bar series.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChartView {
    /// How many bars the window is shifted back from the newest bar.
    pub offset_from_right: usize,
    /// How many bars the window wants to show (limited by the width and the data).
    pub visible: usize,
}

impl Default for ChartView {
    fn default() -> Self {
        Self {
            offset_from_right: 0,
            visible: 100,
        }
    }
}

impl ChartView {
    /// Shows fewer, wider-spaced bars: `visible` shrinks by a quarter, never below 10.
    pub fn zoom_in(&mut self) {
        let next = self.visible.saturating_sub(self.visible / 4).max(1);
        let next = if next == self.visible { next - 1 } else { next };
        self.visible = next.clamp(MIN_VISIBLE, MAX_VISIBLE);
    }

    /// Shows more bars: `visible` grows by a third (at least 1), never above 500.
    pub fn zoom_out(&mut self) {
        let grow = (self.visible / 3).max(1);
        self.visible = self
            .visible
            .saturating_add(grow)
            .clamp(MIN_VISIBLE, MAX_VISIBLE);
    }

    fn pan_step(&self) -> usize {
        (self.visible / 4).max(1)
    }

    /// Moves the window toward older bars. `len` is the number of bars; the offset stops at
    /// `len - 1`, so at least the oldest bar stays in the window.
    pub fn pan_back(&mut self, len: usize) {
        let max = len.saturating_sub(1);
        self.offset_from_right = self
            .offset_from_right
            .saturating_add(self.pan_step())
            .min(max);
    }

    /// Moves the window toward the newest bar; the offset stops at 0.
    pub fn pan_forward(&mut self) {
        self.offset_from_right = self.offset_from_right.saturating_sub(self.pan_step());
    }

    /// Moves the window `cols` bars toward older bars (mouse drag); stops at `len - 1`.
    pub fn pan_back_by(&mut self, cols: usize, len: usize) {
        let max = len.saturating_sub(1);
        self.offset_from_right = self.offset_from_right.saturating_add(cols).min(max);
    }

    /// Moves the window `cols` bars toward the newest bar (mouse drag); stops at 0.
    pub fn pan_forward_by(&mut self, cols: usize) {
        self.offset_from_right = self.offset_from_right.saturating_sub(cols);
    }

    /// Clamps the offset after the data got shorter.
    pub fn clamp_to(&mut self, len: usize) {
        self.offset_from_right = self.offset_from_right.min(len.saturating_sub(1));
    }
}

/// The bars in the window: at most `min(view.visible, width)` bars, ending `offset_from_right`
/// bars before the newest. One column per bar.
pub fn visible_bars<'a>(bars: &'a [Bar], width: usize, view: &ChartView) -> &'a [Bar] {
    let end = bars.len().saturating_sub(view.offset_from_right);
    let count = view.visible.min(width);
    let start = end.saturating_sub(count);
    &bars[start..end]
}

/// Plot column of visible bar `index` when `count` bars are right-aligned in `width` columns.
pub fn bar_col(index: usize, count: usize, width: usize) -> usize {
    width.saturating_sub(count) + index
}

/// The visible bar index under plot column `col`, if any.
pub fn col_to_bar(col: usize, count: usize, width: usize) -> Option<usize> {
    let first = width.saturating_sub(count);
    (col >= first && col < width).then(|| col - first)
}

/// The price range of the plot, in ticks. `max > min` always holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PriceScale {
    pub min: i64,
    pub max: i64,
}

impl PriceScale {
    /// The scale of `bars`: min low and max high, widened by a margin of 2% of the range
    /// (integer division), and at least 1 tick on each side. A flat range (high == low) gets
    /// the 1 tick margin, so the range is never zero. `None` for no bars.
    pub fn from_bars(bars: &[Bar]) -> Option<Self> {
        let low = bars.iter().map(|b| b.low.0).min()?;
        let high = bars.iter().map(|b| b.high.0).max()?;
        let (low, high) = if low <= high {
            (low, high)
        } else {
            (high, low)
        };
        let range = i128::from(high) - i128::from(low);
        let margin = (range / 50).max(1);
        let min = clamp_i64(i128::from(low) - margin);
        let max = clamp_i64(i128::from(high) + margin);
        if max > min {
            Some(Self { min, max })
        } else {
            // Saturated at the i64 edge: fall back to a one tick range.
            Some(Self {
                min: max.saturating_sub(1),
                max,
            })
        }
    }

    fn range(&self) -> i128 {
        i128::from(self.max) - i128::from(self.min)
    }
}

fn clamp_i64(value: i128) -> i64 {
    i64::try_from(value).unwrap_or(if value < 0 { i64::MIN } else { i64::MAX })
}

/// Half-row of `price` in a plot of `height` rows: 0 for the max price, `2 * height - 1` for
/// the min price, rounded down, with out-of-range prices clamped. `height` 0 gives 0.
pub fn price_to_half(price: Price, scale: &PriceScale, height: usize) -> usize {
    let halves = height.saturating_mul(2);
    if halves == 0 {
        return 0;
    }
    let p = i128::from(price.0).clamp(i128::from(scale.min), i128::from(scale.max));
    let below_max = i128::from(scale.max) - p;
    let last = i128::try_from(halves - 1).unwrap_or(0);
    let half = below_max * last / scale.range();
    usize::try_from(half).unwrap_or(0).min(halves - 1)
}

/// Row of `price`: the max price is row 0, the min price is the bottom row `height - 1`.
pub fn price_to_row(price: Price, scale: &PriceScale, height: usize) -> usize {
    price_to_half(price, scale, height) / 2
}

/// The price at the top of row `row`: row 0 is the max price and the bottom row is the min price.
pub fn price_at_row(row: usize, scale: &PriceScale, height: usize) -> Price {
    if height <= 1 {
        return Price(scale.max);
    }
    let row = row.min(height - 1);
    let step =
        i128::try_from(row).unwrap_or(0) * scale.range() / i128::try_from(height - 1).unwrap_or(1);
    Price(clamp_i64(i128::from(scale.max) - step))
}

/// What one cell of a candle column contains.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CandleCell {
    Empty,
    /// Wick over the whole cell: `│`.
    Wick,
    /// Wick over the upper half only: `╿`.
    WickUpper,
    /// Wick over the lower half only: `╽`.
    WickLower,
    /// Body over the whole cell: `█`.
    Body,
    /// Body over the upper half only: `▀`.
    BodyUpper,
    /// Body over the lower half only: `▄`.
    BodyLower,
}

/// The cell of `bar` at plot row `row`.
pub fn candle_cell(bar: &Bar, scale: &PriceScale, height: usize, row: usize) -> CandleCell {
    let body_hi = bar.open.0.max(bar.close.0);
    let body_lo = bar.open.0.min(bar.close.0);
    let body_top = price_to_half(Price(body_hi), scale, height);
    let body_bottom = price_to_half(Price(body_lo), scale, height);
    let wick_top = price_to_half(Price(bar.high.0.max(body_hi)), scale, height);
    let wick_bottom = price_to_half(Price(bar.low.0.min(body_lo)), scale, height);
    let upper = row * 2;
    let lower = upper + 1;
    let in_body = |half: usize| half >= body_top && half <= body_bottom;
    let in_wick = |half: usize| half >= wick_top && half <= wick_bottom;
    match (in_body(upper), in_body(lower)) {
        (true, true) => return CandleCell::Body,
        (true, false) => return CandleCell::BodyUpper,
        (false, true) => return CandleCell::BodyLower,
        (false, false) => {}
    }
    match (in_wick(upper), in_wick(lower)) {
        (true, true) => CandleCell::Wick,
        (true, false) => CandleCell::WickUpper,
        (false, true) => CandleCell::WickLower,
        (false, false) => CandleCell::Empty,
    }
}

/// True when the candle closed at or above its open (drawn green).
pub fn is_bullish(bar: &Bar) -> bool {
    bar.close.0 >= bar.open.0
}

/// The largest volume among `bars` (at least 0).
pub fn max_volume(bars: &[Bar]) -> i64 {
    bars.iter().map(|b| b.volume.0).max().unwrap_or(0).max(0)
}

/// Bar height in eighths of a row: `volume / max_volume * rows * 8`, rounded down, and at least
/// 1 for a non-zero volume. 0 when `max_volume` is 0 or `rows` is 0.
pub fn volume_eighths(volume: Qty, max_volume: i64, rows: usize) -> usize {
    if max_volume <= 0 || rows == 0 || volume.0 <= 0 {
        return 0;
    }
    let total_rows = i128::try_from(rows).unwrap_or(0);
    let v = i128::from(volume.0).min(i128::from(max_volume));
    let eighths = v * total_rows * 8 / i128::from(max_volume);
    usize::try_from(eighths).unwrap_or(0).max(1)
}

/// Eighths (0 to 8) filled in the volume row that is `row_from_bottom` rows above the bottom,
/// for a bar of `total_eighths`.
pub fn volume_cell_eighths(total_eighths: usize, row_from_bottom: usize) -> u8 {
    let below = row_from_bottom.saturating_mul(8);
    u8::try_from(total_eighths.saturating_sub(below).min(8)).unwrap_or(8)
}

/// Glyph for 1 to 8 eighths: `▁▂▃▄▅▆▇█`; `None` for 0.
pub fn volume_glyph(eighths: u8) -> Option<char> {
    const GLYPHS: [char; 8] = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
    usize::from(eighths)
        .checked_sub(1)
        .and_then(|i| GLYPHS.get(i).copied())
}

/// A crosshair position in plot cells (column and row, plot-relative).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Crosshair {
    pub col: usize,
    pub row: usize,
}

/// What the crosshair points at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CrosshairTarget {
    /// Index into the visible bars.
    pub bar_index: usize,
    /// The price at the crosshair row.
    pub price: Price,
}

/// Resolves a crosshair to a visible bar and a price. `None` when the column has no bar or the
/// row is outside the price area.
pub fn crosshair_target(
    crosshair: Crosshair,
    count: usize,
    plot_width: usize,
    price_height: usize,
    scale: &PriceScale,
) -> Option<CrosshairTarget> {
    if crosshair.row >= price_height {
        return None;
    }
    let bar_index = col_to_bar(crosshair.col, count, plot_width)?;
    Some(CrosshairTarget {
        bar_index,
        price: price_at_row(crosshair.row, scale, price_height),
    })
}

/// Formats `value` with `decimals` decimal places from integer math, e.g. `6400050` with 2 is
/// `64000.50`. Negative values keep the sign.
pub fn format_fixed(value: i64, decimals: u32) -> String {
    let neg = value < 0;
    let abs = i128::from(value).unsigned_abs();
    let unit = 10u128.pow(decimals);
    let whole = abs / unit;
    let frac = abs % unit;
    let sign = if neg { "-" } else { "" };
    if decimals == 0 {
        format!("{sign}{whole}")
    } else {
        format!("{sign}{whole}.{frac:0width$}", width = decimals as usize)
    }
}

pub fn format_price(price: Price) -> String {
    format_fixed(price.0, PRICE_DECIMALS)
}

pub fn format_qty(qty: Qty) -> String {
    format_fixed(qty.0, QTY_DECIMALS)
}

/// Civil date (year, month, day) of a count of days since 1970-01-01 (proleptic Gregorian).
pub fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (
        year,
        u32::try_from(month).unwrap_or(1),
        u32::try_from(day).unwrap_or(1),
    )
}

/// UTC time of `ms` since the epoch: `HH:MM` for 1m, 5m, and 15m, `MM-DD HH:MM` for 1h and 1d.
pub fn format_time(ms: i64, timeframe: Timeframe) -> String {
    let secs = ms.div_euclid(1_000);
    let days = secs.div_euclid(86_400);
    let in_day = secs.rem_euclid(86_400);
    let (hour, minute) = (in_day / 3_600, in_day % 3_600 / 60);
    match timeframe {
        Timeframe::M1 | Timeframe::M5 | Timeframe::M15 => format!("{hour:02}:{minute:02}"),
        Timeframe::H1 | Timeframe::H4 | Timeframe::D1 => {
            let (_, month, day) = civil_from_days(days);
            format!("{month:02}-{day:02} {hour:02}:{minute:02}")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bar(t: i64, open: i64, high: i64, low: i64, close: i64, volume: i64) -> Bar {
        Bar {
            t,
            open: Price(open),
            high: Price(high),
            low: Price(low),
            close: Price(close),
            volume: Qty(volume),
        }
    }

    fn series(n: usize) -> Vec<Bar> {
        (0..n)
            .map(|i| {
                let p = 1_000 + i64::try_from(i).unwrap();
                bar(i64::try_from(i).unwrap(), p, p + 5, p - 5, p + 1, 1)
            })
            .collect()
    }

    #[test]
    fn zoom_is_clamped_to_10_and_500() {
        let mut view = ChartView::default();
        for _ in 0..100 {
            view.zoom_in();
        }
        assert_eq!(view.visible, MIN_VISIBLE);
        for _ in 0..100 {
            view.zoom_out();
        }
        assert_eq!(view.visible, MAX_VISIBLE);
        let mut view = ChartView::default();
        let before = view.visible;
        view.zoom_in();
        assert!(view.visible < before);
        view.zoom_out();
        view.zoom_out();
        assert!(view.visible > before);
    }

    #[test]
    fn pan_is_clamped_to_the_data() {
        let mut view = ChartView::default();
        view.pan_forward();
        assert_eq!(view.offset_from_right, 0);
        for _ in 0..100 {
            view.pan_back(30);
        }
        assert_eq!(view.offset_from_right, 29);
        view.clamp_to(5);
        assert_eq!(view.offset_from_right, 4);
        view.pan_back(0);
        assert_eq!(view.offset_from_right, 0);
        view.pan_back(30);
        assert_eq!(view.offset_from_right, 25);
        for _ in 0..100 {
            view.pan_forward();
        }
        assert_eq!(view.offset_from_right, 0);
    }

    #[test]
    fn visible_bars_takes_the_newest_that_fit() {
        let bars = series(50);
        let view = ChartView {
            offset_from_right: 0,
            visible: 20,
        };
        let shown = visible_bars(&bars, 100, &view);
        assert_eq!(shown.len(), 20);
        assert_eq!(shown[19].t, 49);
        // Width limits it.
        assert_eq!(visible_bars(&bars, 8, &view).len(), 8);
        // Panned back by 10.
        let panned = ChartView {
            offset_from_right: 10,
            visible: 20,
        };
        let shown = visible_bars(&bars, 100, &panned);
        assert_eq!(shown.len(), 20);
        assert_eq!(shown[19].t, 39);
    }

    #[test]
    fn visible_bars_with_fewer_bars_than_columns() {
        let bars = series(3);
        let view = ChartView::default();
        assert_eq!(visible_bars(&bars, 80, &view).len(), 3);
        assert_eq!(visible_bars(&[], 80, &view).len(), 0);
        assert_eq!(visible_bars(&bars, 0, &view).len(), 0);
        // Right-aligned columns.
        assert_eq!(bar_col(0, 3, 80), 77);
        assert_eq!(col_to_bar(79, 3, 80), Some(2));
        assert_eq!(col_to_bar(76, 3, 80), None);
        assert_eq!(col_to_bar(80, 3, 80), None);
    }

    #[test]
    fn scale_has_a_margin_and_never_a_zero_range() {
        let bars = [bar(0, 1_000, 2_000, 0, 1_500, 1)];
        let scale = PriceScale::from_bars(&bars).unwrap();
        assert_eq!(
            scale,
            PriceScale {
                min: -40,
                max: 2_040
            }
        );
        let flat = [bar(0, 500, 500, 500, 500, 1)];
        let scale = PriceScale::from_bars(&flat).unwrap();
        assert_eq!(scale, PriceScale { min: 499, max: 501 });
        assert_eq!(PriceScale::from_bars(&[]), None);
    }

    #[test]
    fn rows_map_linearly_with_max_at_the_top() {
        let scale = PriceScale { min: 0, max: 1_000 };
        assert_eq!(price_to_row(Price(1_000), &scale, 10), 0);
        assert_eq!(price_to_row(Price(0), &scale, 10), 9);
        assert_eq!(price_to_row(Price(500), &scale, 10), 4);
        // Clamped outside the range.
        assert_eq!(price_to_row(Price(5_000), &scale, 10), 0);
        assert_eq!(price_to_row(Price(-5_000), &scale, 10), 9);
        assert_eq!(price_to_row(Price(500), &scale, 0), 0);
        assert_eq!(price_to_row(Price(0), &scale, 1), 0);
        assert_eq!(price_to_half(Price(0), &scale, 10), 19);
        assert_eq!(price_at_row(0, &scale, 10), Price(1_000));
        assert_eq!(price_at_row(9, &scale, 10), Price(0));
        assert_eq!(price_at_row(3, &scale, 1), Price(1_000));
    }

    #[test]
    fn candle_cells_cover_body_and_wicks() {
        let scale = PriceScale { min: 0, max: 1_000 };
        // 10 rows, 20 half-rows. Body from 800 (half 3) to 400 (half 11); wick 1000 to 0.
        let b = bar(0, 400, 1_000, 0, 800, 1);
        let cells: Vec<CandleCell> = (0..10).map(|r| candle_cell(&b, &scale, 10, r)).collect();
        assert_eq!(cells[0], CandleCell::Wick);
        assert_eq!(cells[1], CandleCell::BodyLower);
        assert_eq!(cells[2], CandleCell::Body);
        assert_eq!(cells[5], CandleCell::Body);
        assert_eq!(cells[6], CandleCell::Wick);
        assert_eq!(cells[7], CandleCell::Wick);
        assert_eq!(cells[9], CandleCell::Wick);
        assert!(is_bullish(&b));
        assert!(!is_bullish(&bar(0, 800, 800, 800, 799, 1)));
    }

    #[test]
    fn volume_scale_is_in_eighths() {
        assert_eq!(volume_eighths(Qty(100), 100, 2), 16);
        assert_eq!(volume_eighths(Qty(50), 100, 2), 8);
        assert_eq!(volume_eighths(Qty(1), 100_000, 2), 1);
        assert_eq!(volume_eighths(Qty(0), 100, 2), 0);
        assert_eq!(volume_eighths(Qty(5), 0, 2), 0);
        assert_eq!(volume_cell_eighths(11, 0), 8);
        assert_eq!(volume_cell_eighths(11, 1), 3);
        assert_eq!(volume_cell_eighths(11, 2), 0);
        assert_eq!(volume_glyph(0), None);
        assert_eq!(volume_glyph(1), Some('▁'));
        assert_eq!(volume_glyph(8), Some('█'));
        assert_eq!(max_volume(&series(4)), 1);
    }

    #[test]
    fn crosshair_resolves_bar_and_price() {
        let scale = PriceScale { min: 0, max: 1_000 };
        let at = |col, row| crosshair_target(Crosshair { col, row }, 3, 10, 10, &scale);
        let hit = at(9, 0).unwrap();
        assert_eq!((hit.bar_index, hit.price), (2, Price(1_000)));
        let hit = at(7, 9).unwrap();
        assert_eq!((hit.bar_index, hit.price), (0, Price(0)));
        assert_eq!(at(6, 0), None);
        assert_eq!(at(9, 10), None);
    }

    #[test]
    fn fixed_point_formatting() {
        assert_eq!(format_price(Price(6_400_050)), "64000.50");
        assert_eq!(format_price(Price(5)), "0.05");
        assert_eq!(format_price(Price(-150)), "-1.50");
        assert_eq!(format_price(Price(i64::MIN)), "-92233720368547758.08");
        assert_eq!(format_qty(Qty(10_000_000)), "0.10000000");
        assert_eq!(format_fixed(42, 0), "42");
    }

    #[test]
    fn time_formatting_is_utc() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(20_819), (2027, 1, 1));
        assert_eq!(civil_from_days(19_782), (2024, 2, 29));
        assert_eq!(format_time(1_798_761_600_000, Timeframe::H1), "01-01 00:00");
        assert_eq!(format_time(1_798_761_600_000, Timeframe::D1), "01-01 00:00");
        assert_eq!(format_time(1_798_761_600_000, Timeframe::M1), "00:00");
        assert_eq!(
            format_time(
                1_798_761_600_000 + 13 * 3_600_000 + 7 * 60_000,
                Timeframe::M5
            ),
            "13:07"
        );
        assert_eq!(format_time(-60_000, Timeframe::H1), "12-31 23:59");
    }
}
