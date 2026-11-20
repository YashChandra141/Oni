//! Drawing of the indicator overlays and the RSI/ATR sub-pane (Req 26.1-26.3, 34.2).
//!
//! The overlays are braille lines drawn through the chart's `overlay` hook over the same price
//! scale as the candles. The sub-pane is a ratatui `Chart` with braille datasets below the
//! price chart. All math is in `indicator_model`.

// Some helpers are used only by tests.
#![allow(dead_code)]

use protocol::Bar;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Style};
use ratatui::symbols::Marker;
use ratatui::widgets::{Axis, Chart, Dataset, GraphType, Widget};

use crate::braille::draw_braille_line;
use crate::chart_model::PriceScale;
use crate::chart_widget::{AXIS_WIDTH, PlotGeometry};
use crate::indicator_model::{
    Indicator, IndicatorSeries, Toggles, format_ticks, line_dots, normalize_to_100, pick_atr,
    pick_bb_lower, pick_bb_mid, pick_bb_upper, pick_ema, pick_rsi, pick_vwap, series_xy,
};

/// Picks one value out of an indicator point.
type Pick = fn(&protocol::IndicatorValues) -> Option<f64>;

pub const EMA_COLOR: Color = crate::brand::AMBER;
pub const VWAP_COLOR: Color = Color::Cyan;
/// Muted red for the three Bollinger lines.
pub const BOLLINGER_COLOR: Color = crate::brand::BOLLINGER;
pub const RSI_COLOR: Color = Color::Magenta;
pub const ATR_COLOR: Color = Color::LightBlue;
const REFERENCE_COLOR: Color = crate::brand::FAINT;
const LABEL_COLOR: Color = crate::brand::MUTED;

/// Draws the enabled overlay lines on top of the candles. `shown` are the visible bars that
/// the chart drew. Braille cells go only on empty cells, so candles stay intact.
pub fn draw_overlays(
    buf: &mut Buffer,
    geometry: &PlotGeometry,
    shown: &[Bar],
    series: &IndicatorSeries,
    toggles: &Toggles,
) {
    let width = usize::from(geometry.area.width);
    let rows = usize::from(geometry.area.height);
    // The chart's own bar count wins: if the caller's window is wider than what the chart
    // drew, the lines would otherwise be shifted against the candles.
    let shown = &shown[shown.len().saturating_sub(geometry.count)..];
    let bands: [Pick; 3] = [pick_bb_upper, pick_bb_mid, pick_bb_lower];
    let vwap: [Pick; 1] = [pick_vwap];
    let ema: [Pick; 1] = [pick_ema];
    let lines: [(bool, Color, &[Pick]); 3] = [
        (toggles.bollinger, BOLLINGER_COLOR, &bands),
        (toggles.vwap, VWAP_COLOR, &vwap),
        (toggles.ema, EMA_COLOR, &ema),
    ];
    for (enabled, color, picks) in lines {
        if !enabled {
            continue;
        }
        for pick in picks {
            let dots = line_dots(series.points(), shown, *pick, &geometry.scale, width, rows);
            draw_braille_line(buf, geometry, color, &dots);
        }
    }
}

/// One braille line dataset in `color`.
fn line_dataset(data: &[(f64, f64)], color: Color) -> Dataset<'_> {
    Dataset::default()
        .marker(Marker::Braille)
        .graph_type(GraphType::Line)
        .style(Style::default().fg(color))
        .data(data)
}

/// The color of an indicator's line, used for its toggle button too.
pub fn indicator_color(indicator: Indicator) -> Color {
    match indicator {
        Indicator::Ema => EMA_COLOR,
        Indicator::Vwap => VWAP_COLOR,
        Indicator::Bollinger => BOLLINGER_COLOR,
        Indicator::Rsi => RSI_COLOR,
        Indicator::Atr => ATR_COLOR,
    }
}

/// The row of `value` (0 to 100) in a pane of `height` rows, top row = 100.
fn percent_row(value: f64, height: u16) -> u16 {
    let last = f64::from(height.saturating_sub(1));
    let row = ((100.0 - value) / 100.0 * last).round();
    (row as u16).min(height.saturating_sub(1))
}

fn put_label(buf: &mut Buffer, x: u16, y: u16, text: &str) {
    let max = usize::from(AXIS_WIDTH).saturating_sub(1);
    let text: String = text.chars().take(max).collect();
    buf.set_string(x, y, text, Style::default().fg(LABEL_COLOR));
}

/// Draws the RSI/ATR sub-pane in `area`: the plot columns line up with the candle columns
/// above, and the right `AXIS_WIDTH` columns carry the axis labels. RSI uses a fixed 0 to 100
/// range with 30 and 70 reference lines. ATR is rescaled to its own min and max (the labels
/// show them) when RSI is off. Nothing is drawn when the area is too small.
pub fn draw_subpane(
    buf: &mut Buffer,
    area: Rect,
    shown: &[Bar],
    series: &IndicatorSeries,
    toggles: &Toggles,
) {
    if area.height == 0 || area.width <= AXIS_WIDTH || !toggles.wants_subpane() {
        return;
    }
    let plot_w = area.width - AXIS_WIDTH;
    let plot = Rect::new(area.x, area.y, plot_w, area.height);
    let width = usize::from(plot_w);
    let x_max = f64::from(plot_w);

    let high = [(0.0, 70.0), (x_max, 70.0)];
    let low = [(0.0, 30.0), (x_max, 30.0)];
    let rsi_xy = series_xy(series.points(), shown, pick_rsi, width);
    let mut atr_xy = series_xy(series.points(), shown, pick_atr, width);
    let atr_range = normalize_to_100(&mut atr_xy);

    let mut datasets = Vec::new();
    if toggles.rsi {
        datasets.push(line_dataset(&high[..], REFERENCE_COLOR));
        datasets.push(line_dataset(&low[..], REFERENCE_COLOR));
        datasets.push(line_dataset(&rsi_xy[..], RSI_COLOR));
    }
    if toggles.atr {
        datasets.push(line_dataset(&atr_xy[..], ATR_COLOR));
    }
    Chart::new(datasets)
        .x_axis(Axis::default().bounds([0.0, x_max]))
        .y_axis(Axis::default().bounds([0.0, 100.0]))
        .render(plot, buf);

    let label_x = area.x + plot_w + 1;
    if toggles.rsi {
        for value in [100.0, 70.0, 30.0, 0.0] {
            let text = format!("{value:.0}");
            put_label(
                buf,
                label_x,
                area.y + percent_row(value, area.height),
                &text,
            );
        }
    } else if let Some((min, max)) = atr_range {
        let top = format_ticks(max).unwrap_or_default();
        let bottom = format_ticks(min).unwrap_or_default();
        put_label(buf, label_x, area.y, &top);
        put_label(buf, label_x, area.y + area.height - 1, &bottom);
    }
}

/// The scale the overlay hook uses is the chart's own; this helper only exists so tests can
/// build a geometry for a known scale.
pub fn geometry(area: Rect, count: usize, scale: PriceScale) -> PlotGeometry {
    PlotGeometry { area, count, scale }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::indicator_model::IndicatorPoint;
    use protocol::{IndicatorValues, Price, Qty};

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

    fn series_with(f: impl Fn(i64) -> IndicatorValues, ts: &[i64]) -> IndicatorSeries {
        let mut s = IndicatorSeries::default();
        for &t in ts {
            s.merge(IndicatorPoint { t, values: f(t) });
        }
        s
    }

    fn is_braille(sym: &str) -> bool {
        sym.chars()
            .next()
            .is_some_and(|c| ('\u{2800}'..='\u{28FF}').contains(&c))
    }

    const SCALE: PriceScale = PriceScale { min: 0, max: 1_000 };

    #[test]
    fn ema_overlay_is_yellow_and_keeps_candle_cells() {
        let area = Rect::new(0, 0, 10, 5);
        let g = geometry(area, 2, SCALE);
        let mut buf = Buffer::empty(Rect::new(0, 0, 10, 5));
        // Bars are in columns 8 and 9; EMA at the scale max is dot row 0, cell row 0.
        buf[(8, 0)].set_char('█');
        let s = series_with(
            |_| IndicatorValues {
                ema: Some(1_000.0),
                ..IndicatorValues::default()
            },
            &[0, 60],
        );
        let toggles = Toggles {
            vwap: false,
            ..Toggles::default()
        };
        draw_overlays(&mut buf, &g, &[bar(0), bar(60)], &s, &toggles);
        assert_eq!(buf[(8, 0)].symbol(), "█");
        assert!(is_braille(buf[(9, 0)].symbol()));
        assert_eq!(buf[(9, 0)].style().fg, Some(EMA_COLOR));
    }

    #[test]
    fn disabled_lines_are_not_drawn_and_bollinger_has_three_lines() {
        let area = Rect::new(0, 0, 10, 5);
        let g = geometry(area, 1, SCALE);
        let s = series_with(
            |_| IndicatorValues {
                ema: Some(1_000.0),
                vwap: Some(500.0),
                bb_upper: Some(900.0),
                bb_mid: Some(500.0),
                bb_lower: Some(100.0),
                ..IndicatorValues::default()
            },
            &[0],
        );
        let off = Toggles {
            ema: false,
            vwap: false,
            bollinger: false,
            rsi: false,
            atr: false,
        };
        let mut buf = Buffer::empty(Rect::new(0, 0, 10, 5));
        draw_overlays(&mut buf, &g, &[bar(0)], &s, &off);
        assert!((0..5).all(|y| (0..10).all(|x| buf[(x, y)].symbol() == " ")));

        let bb = Toggles {
            bollinger: true,
            ..off
        };
        draw_overlays(&mut buf, &g, &[bar(0)], &s, &bb);
        let drawn = (0..5).filter(|y| is_braille(buf[(9, *y)].symbol())).count();
        assert_eq!(drawn, 3);
        assert_eq!(
            (0..5)
                .find(|y| is_braille(buf[(9, *y)].symbol()))
                .map(|y| buf[(9, y)].style().fg),
            Some(Some(BOLLINGER_COLOR))
        );
    }

    #[test]
    fn the_subpane_draws_rsi_with_labels() {
        let area = Rect::new(0, 0, 30, 6);
        let mut buf = Buffer::empty(area);
        let ts: Vec<i64> = (0..10).map(|i| i * 60).collect();
        let bars: Vec<Bar> = ts.iter().map(|t| bar(*t)).collect();
        let s = series_with(
            |t| IndicatorValues {
                rsi: Some(20.0 + t as f64 / 10.0),
                ..IndicatorValues::default()
            },
            &ts,
        );
        draw_subpane(&mut buf, area, &bars, &s, &Toggles::default());
        let first_row: String = (0..30).map(|x| buf[(x, 0)].symbol().to_owned()).collect();
        assert!(first_row.trim_end().ends_with("100"), "{first_row:?}");
        let any_rsi = (0..6).any(|y| (0..20).any(|x| buf[(x, y)].style().fg == Some(RSI_COLOR)));
        assert!(any_rsi);
        // Labels for the reference lines.
        let text: String = (0..6)
            .flat_map(|y| (20..30).map(move |x| (x, y)))
            .map(|(x, y)| buf[(x, y)].symbol().to_owned())
            .collect();
        assert!(text.contains("70") && text.contains("30"), "{text:?}");
    }

    #[test]
    fn the_subpane_needs_a_toggle_and_room() {
        let s = IndicatorSeries::default();
        let off = Toggles {
            rsi: false,
            atr: false,
            ..Toggles::default()
        };
        let area = Rect::new(0, 0, 30, 6);
        let mut buf = Buffer::empty(area);
        draw_subpane(&mut buf, area, &[], &s, &off);
        assert!((0..6).all(|y| (0..30).all(|x| buf[(x, y)].symbol() == " ")));
        // Too narrow or zero height: no panic, nothing drawn.
        let mut narrow = Buffer::empty(Rect::new(0, 0, 8, 6));
        draw_subpane(
            &mut narrow,
            Rect::new(0, 0, 8, 6),
            &[],
            &s,
            &Toggles::default(),
        );
        draw_subpane(
            &mut buf,
            Rect::new(0, 0, 30, 0),
            &[],
            &s,
            &Toggles::default(),
        );
        assert!((0..6).all(|y| (0..8).all(|x| narrow[(x, y)].symbol() == " ")));
    }

    #[test]
    fn percent_rows_run_from_the_top() {
        assert_eq!(percent_row(100.0, 6), 0);
        assert_eq!(percent_row(0.0, 6), 5);
        assert_eq!(percent_row(70.0, 11), 3);
        assert_eq!(percent_row(50.0, 0), 0);
    }
}
