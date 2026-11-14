//! The candle chart widget (Req 25.1-25.4, 29.1, 29.2, 34.1).
//!
//! Layout of the area, top to bottom: the price plot, the volume strip (about 20% of the
//! rows, at least 2, only when there is room), and a one-row readout (when the area has at
//! least 5 rows). The price axis is a column of `AXIS_WIDTH` cells at the right edge.
//! All math is in `chart_model`; this file only draws.

// `overlay` and `PlotGeometry` are the extension point for the braille indicator lines of
// Task 9.3 and are not called yet.
#![allow(dead_code)]

use protocol::{Bar, Timeframe};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Style};
use ratatui::widgets::Widget;

use crate::chart_model::{
    CandleCell, ChartView, Crosshair, PriceScale, bar_col, candle_cell, col_to_bar,
    crosshair_target, format_price, format_qty, format_time, is_bullish, max_volume, price_at_row,
    visible_bars, volume_cell_eighths, volume_eighths, volume_glyph,
};

/// Width of the price axis column at the right edge, in cells.
pub const AXIS_WIDTH: u16 = 10;

pub const UP_COLOR: Color = Color::Green;
pub const DOWN_COLOR: Color = Color::Red;
/// Dim volume colors (a darker shade of the candle colors).
pub const VOLUME_UP_COLOR: Color = Color::Rgb(0, 90, 0);
pub const VOLUME_DOWN_COLOR: Color = Color::Rgb(110, 0, 0);
const CROSSHAIR_COLOR: Color = Color::DarkGray;
const AXIS_COLOR: Color = Color::Gray;

/// Where the price plot is, handed to the overlay hook.
#[derive(Debug, Clone, Copy)]
pub struct PlotGeometry {
    /// The price plot (candles only, no volume rows or axis).
    pub area: Rect,
    /// The number of visible bars; they are right-aligned in `area`.
    pub count: usize,
    pub scale: PriceScale,
}

/// A hook that draws on top of the candles, for indicator lines (Task 9.3).
pub type OverlayFn = dyn Fn(&mut Buffer, &PlotGeometry);

pub struct CandleChart<'a> {
    bars: &'a [Bar],
    timeframe: Timeframe,
    view: ChartView,
    crosshair: Option<Crosshair>,
    overlay: Option<&'a OverlayFn>,
}

impl<'a> CandleChart<'a> {
    pub fn new(bars: &'a [Bar], timeframe: Timeframe, view: ChartView) -> Self {
        Self {
            bars,
            timeframe,
            view,
            crosshair: None,
            overlay: None,
        }
    }

    /// The crosshair, in cells relative to the plot (price plot plus volume strip).
    pub fn crosshair(mut self, crosshair: Option<Crosshair>) -> Self {
        self.crosshair = crosshair;
        self
    }

    /// Registers a hook that draws after the candles and before the crosshair.
    pub fn overlay(mut self, overlay: &'a OverlayFn) -> Self {
        self.overlay = Some(overlay);
        self
    }
}

/// The sub-areas of the chart area.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Layout {
    plot: Rect,
    volume: Rect,
    readout: Rect,
    axis_x: u16,
}

fn layout(area: Rect) -> Option<Layout> {
    if area.height == 0 || area.width <= AXIS_WIDTH {
        return None;
    }
    let plot_w = area.width - AXIS_WIDTH;
    let readout_h = u16::from(area.height >= 5);
    let body_h = area.height - readout_h;
    let volume_h = if body_h >= 6 { (body_h / 5).max(2) } else { 0 };
    let price_h = body_h - volume_h;
    Some(Layout {
        plot: Rect::new(area.x, area.y, plot_w, price_h),
        volume: Rect::new(area.x, area.y + price_h, plot_w, volume_h),
        readout: Rect::new(area.x, area.y + body_h, area.width, readout_h),
        axis_x: area.x + plot_w,
    })
}

fn to_u16(n: usize) -> u16 {
    u16::try_from(n).unwrap_or(u16::MAX)
}

fn candle_glyph(cell: CandleCell) -> Option<char> {
    match cell {
        CandleCell::Empty => None,
        CandleCell::Wick => Some('│'),
        CandleCell::WickUpper => Some('╿'),
        CandleCell::WickLower => Some('╽'),
        CandleCell::Body => Some('█'),
        CandleCell::BodyUpper => Some('▀'),
        CandleCell::BodyLower => Some('▄'),
    }
}

impl Widget for CandleChart<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        let Some(l) = layout(area) else {
            return;
        };
        let width = usize::from(l.plot.width);
        let shown = visible_bars(self.bars, width, &self.view);
        let Some(scale) = PriceScale::from_bars(shown) else {
            draw_no_data(area, buf);
            return;
        };
        let count = shown.len();
        let price_h = usize::from(l.plot.height);
        let volume_h = usize::from(l.volume.height);

        // Candles.
        for (i, bar) in shown.iter().enumerate() {
            let x = l.plot.x + to_u16(bar_col(i, count, width));
            let color = if is_bullish(bar) {
                UP_COLOR
            } else {
                DOWN_COLOR
            };
            for row in 0..price_h {
                if let Some(ch) = candle_glyph(candle_cell(bar, &scale, price_h, row)) {
                    let cell = &mut buf[(x, l.plot.y + to_u16(row))];
                    cell.set_char(ch);
                    cell.set_fg(color);
                }
            }
        }

        // Volume strip.
        if volume_h > 0 {
            let max_vol = max_volume(shown);
            for (i, bar) in shown.iter().enumerate() {
                let x = l.volume.x + to_u16(bar_col(i, count, width));
                let color = if is_bullish(bar) {
                    VOLUME_UP_COLOR
                } else {
                    VOLUME_DOWN_COLOR
                };
                let total = volume_eighths(bar.volume, max_vol, volume_h);
                for from_bottom in 0..volume_h {
                    let eighths = volume_cell_eighths(total, from_bottom);
                    if let Some(ch) = volume_glyph(eighths) {
                        let y = l.volume.y + to_u16(volume_h - 1 - from_bottom);
                        let cell = &mut buf[(x, y)];
                        cell.set_char(ch);
                        cell.set_fg(color);
                    }
                }
            }
        }

        draw_axis(buf, &l, &scale);

        if let Some(overlay) = self.overlay {
            overlay(
                buf,
                &PlotGeometry {
                    area: l.plot,
                    count,
                    scale,
                },
            );
        }

        draw_crosshair(buf, &l, self.crosshair);
        draw_readout(buf, &l, shown, &scale, self.crosshair, self.timeframe);
    }
}

fn draw_no_data(area: Rect, buf: &mut Buffer) {
    let text = "no data";
    let len = to_u16(text.len());
    let x = area.x + area.width.saturating_sub(len) / 2;
    let y = area.y + area.height / 2;
    let shown: String = text.chars().take(usize::from(area.width)).collect();
    buf.set_string(x, y, shown, Style::default().fg(AXIS_COLOR));
}

/// Price labels at the right: the scale max on the top row, the scale min on the bottom row,
/// and one label every 4 rows between them (the last one only when there are 2 rows to spare).
fn draw_axis(buf: &mut Buffer, l: &Layout, scale: &PriceScale) {
    let price_h = usize::from(l.plot.height);
    if price_h == 0 {
        return;
    }
    let mut rows: Vec<usize> = (0..price_h).step_by(4).collect();
    let last = price_h - 1;
    let last_label = rows.last().copied().unwrap_or(0);
    if last_label != last && last - last_label >= 2 {
        rows.push(last);
    }
    let max_chars = usize::from(AXIS_WIDTH) - 1;
    for row in rows {
        let label = format_price(price_at_row(row, scale, price_h));
        let label: String = label.chars().take(max_chars).collect();
        buf.set_string(
            l.axis_x + 1,
            l.plot.y + to_u16(row),
            label,
            Style::default().fg(AXIS_COLOR),
        );
    }
}

fn draw_crosshair(buf: &mut Buffer, l: &Layout, crosshair: Option<Crosshair>) {
    let Some(ch) = crosshair else {
        return;
    };
    let total_h = usize::from(l.plot.height) + usize::from(l.volume.height);
    if total_h == 0 || l.plot.width == 0 {
        return;
    }
    let col = ch.col.min(usize::from(l.plot.width) - 1);
    let row = ch.row.min(total_h - 1);
    let x = l.plot.x + to_u16(col);
    // Vertical line over the price plot and the volume strip.
    for r in 0..total_h {
        mark(buf, x, l.plot.y + to_u16(r), '┆');
    }
    // Horizontal line only over the price plot.
    if row < usize::from(l.plot.height) {
        let y = l.plot.y + to_u16(row);
        for c in 0..l.plot.width {
            mark(buf, l.plot.x + c, y, '┄');
        }
    }
}

/// Draws a crosshair character on an empty cell, or dims the background of a filled one.
fn mark(buf: &mut Buffer, x: u16, y: u16, glyph: char) {
    let cell = &mut buf[(x, y)];
    if cell.symbol() == " " {
        cell.set_char(glyph);
        cell.set_fg(CROSSHAIR_COLOR);
    } else if cell.symbol() != "┆" && cell.symbol() != "┄" {
        cell.set_bg(CROSSHAIR_COLOR);
    }
}

fn draw_readout(
    buf: &mut Buffer,
    l: &Layout,
    shown: &[Bar],
    scale: &PriceScale,
    crosshair: Option<Crosshair>,
    timeframe: Timeframe,
) {
    let Some(ch) = crosshair else {
        return;
    };
    if l.readout.height == 0 {
        return;
    }
    let plot_w = usize::from(l.plot.width);
    let price_h = usize::from(l.plot.height);
    let Some(index) = col_to_bar(ch.col, shown.len(), plot_w) else {
        return;
    };
    let Some(bar) = shown.get(index) else {
        return;
    };
    let mut text = format_time(bar.t, timeframe);
    if let Some(target) = crosshair_target(ch, shown.len(), plot_w, price_h, scale) {
        text.push_str("  ");
        text.push_str(&format_price(target.price));
    }
    text.push_str(&format!(
        "  O {} H {} L {} C {} V {}",
        format_price(bar.open),
        format_price(bar.high),
        format_price(bar.low),
        format_price(bar.close),
        format_qty(bar.volume),
    ));
    let text: String = text.chars().take(usize::from(l.readout.width)).collect();
    buf.set_string(
        l.readout.x,
        l.readout.y,
        text,
        Style::default().fg(Color::White),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::{Price, Qty};

    const T0: i64 = 1_798_761_600_000; // 2027-01-01 00:00 UTC

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

    /// An up candle and a down candle. Scale: 79..=121 (margin 1), so with 9 price rows
    /// (18 half-rows) the up candle has wick halves 0..=12 and body halves 4..=8, and the
    /// down candle has wick halves 2..=16 and body halves 4..=14.
    fn two_bars() -> Vec<Bar> {
        vec![
            bar(T0, 100, 120, 90, 110, 10),
            bar(T0 + 60_000, 110, 115, 80, 85, 20),
        ]
    }

    fn render(bars: &[Bar], tf: Timeframe, ch: Option<Crosshair>, w: u16, h: u16) -> Buffer {
        let area = Rect::new(0, 0, w, h);
        let mut buf = Buffer::empty(area);
        CandleChart::new(bars, tf, ChartView::default())
            .crosshair(ch)
            .render(area, &mut buf);
        buf
    }

    fn sym(buf: &Buffer, x: u16, y: u16) -> String {
        buf[(x, y)].symbol().to_owned()
    }

    fn fg(buf: &Buffer, x: u16, y: u16) -> Option<Color> {
        buf[(x, y)].style().fg
    }

    fn row_text(buf: &Buffer, y: u16, x0: u16, x1: u16) -> String {
        (x0..x1).map(|x| sym(buf, x, y)).collect::<String>()
    }

    fn all_blank(buf: &Buffer) -> bool {
        let a = buf.area;
        (0..a.height).all(|y| (0..a.width).all(|x| sym(buf, x, y) == " "))
    }

    #[test]
    fn layout_splits_plot_volume_and_readout() {
        let l = layout(Rect::new(0, 0, 40, 12)).unwrap();
        assert_eq!(l.plot, Rect::new(0, 0, 30, 9));
        assert_eq!(l.volume, Rect::new(0, 9, 30, 2));
        assert_eq!(l.readout, Rect::new(0, 11, 40, 1));
        assert_eq!(l.axis_x, 30);
        // Short area: no readout and no volume.
        let l = layout(Rect::new(0, 0, 40, 4)).unwrap();
        assert_eq!(
            (l.plot.height, l.volume.height, l.readout.height),
            (4, 0, 0)
        );
        assert_eq!(layout(Rect::new(0, 0, AXIS_WIDTH, 12)), None);
        assert_eq!(layout(Rect::new(0, 0, 40, 0)), None);
    }

    #[test]
    fn up_candle_has_a_green_body_and_wicks_above_and_below() {
        let buf = render(&two_bars(), Timeframe::M1, None, 40, 12);
        // Up candle is in column 28.
        assert_eq!(sym(&buf, 28, 0), "│");
        assert_eq!(sym(&buf, 28, 1), "│");
        assert_eq!(sym(&buf, 28, 2), "█");
        assert_eq!(fg(&buf, 28, 2), Some(Color::Green));
        assert_eq!(sym(&buf, 28, 3), "█");
        assert_eq!(sym(&buf, 28, 4), "▀");
        assert_eq!(sym(&buf, 28, 5), "│");
        assert_eq!(sym(&buf, 28, 6), "╿");
        assert_eq!(fg(&buf, 28, 6), Some(Color::Green));
        assert_eq!(sym(&buf, 28, 7), " ");
    }

    #[test]
    fn down_candle_is_red() {
        let buf = render(&two_bars(), Timeframe::M1, None, 40, 12);
        assert_eq!(sym(&buf, 29, 0), " ");
        assert_eq!(sym(&buf, 29, 1), "│");
        assert_eq!(fg(&buf, 29, 1), Some(Color::Red));
        assert_eq!(sym(&buf, 29, 2), "█");
        assert_eq!(fg(&buf, 29, 2), Some(Color::Red));
        assert_eq!(sym(&buf, 29, 7), "▀");
        assert_eq!(sym(&buf, 29, 8), "╿");
    }

    #[test]
    fn volume_uses_block_characters_in_dim_colors() {
        let buf = render(&two_bars(), Timeframe::M1, None, 40, 12);
        // Volume rows are 9 and 10. The up bar has half the volume of the down bar.
        assert_eq!(sym(&buf, 28, 10), "█");
        assert_eq!(sym(&buf, 28, 9), " ");
        assert_eq!(sym(&buf, 29, 9), "█");
        assert_eq!(sym(&buf, 29, 10), "█");
        assert_eq!(fg(&buf, 28, 10), Some(VOLUME_UP_COLOR));
        assert_eq!(fg(&buf, 29, 10), Some(VOLUME_DOWN_COLOR));
        // A partial row uses a partial block.
        let partial = vec![bar(T0, 100, 110, 90, 105, 3), bar(T0, 100, 110, 90, 105, 8)];
        let buf = render(&partial, Timeframe::M1, None, 40, 12);
        // 3/8 of 2 rows = 6 eighths: bottom row only, `▆`.
        assert_eq!(sym(&buf, 28, 10), "▆");
        assert_eq!(sym(&buf, 28, 9), " ");
    }

    #[test]
    fn axis_labels_show_the_scale_high_and_low() {
        let buf = render(&two_bars(), Timeframe::M1, None, 40, 12);
        let top = row_text(&buf, 0, 31, 40);
        let bottom = row_text(&buf, 8, 31, 40);
        assert_eq!(top.trim(), format_price(Price(121)));
        assert_eq!(bottom.trim(), format_price(Price(79)));
        assert_eq!(row_text(&buf, 4, 31, 40).trim(), "1.00");
    }

    #[test]
    fn empty_data_says_no_data_centered() {
        let buf = render(&[], Timeframe::M1, None, 40, 12);
        let line = row_text(&buf, 6, 0, 40);
        assert!(line.contains("no data"), "{line:?}");
        let start = line.find("no data").unwrap();
        assert_eq!(start, 16);
    }

    #[test]
    fn flat_range_does_not_divide_by_zero() {
        let flat = vec![bar(T0, 500, 500, 500, 500, 1)];
        let buf = render(&flat, Timeframe::M1, None, 40, 12);
        assert_eq!(sym(&buf, 29, 4), "▀");
        assert_eq!(fg(&buf, 29, 4), Some(Color::Green));
        assert_eq!(row_text(&buf, 0, 31, 40).trim(), "5.01");
        assert_eq!(row_text(&buf, 8, 31, 40).trim(), "4.99");
    }

    #[test]
    fn degenerate_areas_do_not_panic() {
        // Narrower than the axis: nothing drawn.
        let buf = render(&two_bars(), Timeframe::M1, None, 8, 12);
        assert!(all_blank(&buf));
        let buf = render(&two_bars(), Timeframe::M1, None, AXIS_WIDTH, 12);
        assert!(all_blank(&buf));
        // Zero height.
        let area = Rect::new(0, 0, 40, 0);
        let mut buf = Buffer::empty(area);
        CandleChart::new(&two_bars(), Timeframe::M1, ChartView::default()).render(area, &mut buf);
        // One plot column, tiny heights, and a crosshair outside the area.
        for h in 1..=6 {
            let ch = Some(Crosshair { col: 99, row: 99 });
            let _ = render(&two_bars(), Timeframe::M1, ch, 11, h);
            let _ = render(&two_bars(), Timeframe::H1, ch, 40, h);
        }
        // One plot column shows only the newest bar.
        let buf = render(&two_bars(), Timeframe::M1, None, 11, 12);
        assert_eq!(sym(&buf, 0, 0), "│");
        assert_eq!(fg(&buf, 0, 0), Some(Color::Red));
    }

    #[test]
    fn crosshair_draws_lines_and_a_readout() {
        let ch = Some(Crosshair { col: 28, row: 3 });
        let buf = render(&two_bars(), Timeframe::M1, ch, 40, 12);
        assert_eq!(sym(&buf, 0, 3), "┄");
        assert_eq!(sym(&buf, 28, 7), "┆");
        // The candle keeps its glyph.
        assert_eq!(sym(&buf, 28, 3), "█");
        let readout = row_text(&buf, 11, 0, 40);
        // Row 3 of 9 over the 79..=121 scale is 106; the bar is the up candle at 00:00.
        assert!(readout.starts_with("00:00  1.06"), "{readout:?}");

        let buf = render(&two_bars(), Timeframe::H1, ch, 40, 12);
        let readout = row_text(&buf, 11, 0, 40);
        assert!(readout.starts_with("01-01 00:00  1.06"), "{readout:?}");
    }

    #[test]
    fn crosshair_in_the_volume_strip_shows_time_only() {
        let ch = Some(Crosshair { col: 29, row: 10 });
        let buf = render(&two_bars(), Timeframe::M1, ch, 40, 12);
        let readout = row_text(&buf, 11, 0, 40);
        assert!(readout.starts_with("00:01  O "), "{readout:?}");
    }

    #[test]
    fn overlay_hook_runs_with_the_plot_geometry() {
        let hook = |buf: &mut Buffer, g: &PlotGeometry| {
            buf[(g.area.x, g.area.y)].set_char('X');
        };
        let area = Rect::new(0, 0, 40, 12);
        let mut buf = Buffer::empty(area);
        let bars = two_bars();
        CandleChart::new(&bars, Timeframe::M1, ChartView::default())
            .overlay(&hook)
            .render(area, &mut buf);
        assert_eq!(sym(&buf, 0, 0), "X");
    }
}
