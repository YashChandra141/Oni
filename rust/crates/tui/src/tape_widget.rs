//! The trades tape: the newest trades of the selected symbol, newest first (Req 27.2).
//!
//! One row per trade: `HH:MM:SS` (UTC), price in 10 cells, quantity in 13 cells, and the
//! aggressor side. Buys are green, sells are red.

use std::collections::VecDeque;

use protocol::Side;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Style};
use ratatui::widgets::Widget;

use crate::book_model::{TapeEntry, format_clock};
use crate::chart_model::{format_price, format_qty};

pub const BUY_COLOR: Color = crate::brand::BUY;
pub const SELL_COLOR: Color = crate::brand::SELL;
const TIME_COLOR: Color = crate::brand::MUTED;

pub struct TapeWidget<'a> {
    symbol: &'a str,
    /// Newest first, all symbols; the widget shows only `symbol`.
    entries: &'a VecDeque<TapeEntry>,
}

impl<'a> TapeWidget<'a> {
    pub fn new(symbol: &'a str, entries: &'a VecDeque<TapeEntry>) -> Self {
        Self { symbol, entries }
    }
}

fn side_label(side: Side) -> &'static str {
    match side {
        Side::Buy => "BUY",
        Side::Sell => "SELL",
    }
}

fn side_color(side: Side) -> Color {
    match side {
        Side::Buy => BUY_COLOR,
        Side::Sell => SELL_COLOR,
    }
}

impl Widget for TapeWidget<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        let block = crate::brand::block().title(" TAPE ");
        let inner = block.inner(area);
        block.render(area, buf);
        if inner.width == 0 || inner.height == 0 {
            return;
        }
        let width = usize::from(inner.width);
        let mut trades = self
            .entries
            .iter()
            .filter(|e| e.symbol == self.symbol)
            .take(usize::from(inner.height))
            .peekable();
        if trades.peek().is_none() {
            buf.set_stringn(
                inner.x,
                inner.y,
                "no data",
                width,
                Style::default().fg(TIME_COLOR),
            );
            return;
        }
        for (i, entry) in trades.enumerate() {
            let Ok(dy) = u16::try_from(i) else { break };
            let y = inner.y + dy;
            buf.set_stringn(
                inner.x,
                y,
                format_clock(entry.ts),
                width,
                Style::default().fg(TIME_COLOR),
            );
            // The time is 8 cells wide, followed by one space.
            let Some(rest_width) = width.checked_sub(9).filter(|w| *w > 0) else {
                continue;
            };
            let price = format_price(entry.price);
            let qty = format_qty(entry.qty);
            let side = side_label(entry.side);
            let text = format!("{price:>10} {qty:>13} {side}");
            buf.set_stringn(
                inner.x + 9,
                y,
                text,
                rest_width,
                Style::default().fg(side_color(entry.side)),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::{Price, Qty};

    fn entry(symbol: &str, price: i64, side: Side, ts: i64) -> TapeEntry {
        TapeEntry {
            symbol: symbol.to_owned(),
            price: Price(price),
            qty: Qty(10_000_000),
            side,
            ts,
        }
    }

    fn render(entries: &VecDeque<TapeEntry>, w: u16, h: u16) -> Buffer {
        let area = Rect::new(0, 0, w, h);
        let mut buf = Buffer::empty(area);
        TapeWidget::new("BTC-USD", entries).render(area, &mut buf);
        buf
    }

    fn row_text(buf: &Buffer, y: u16, w: u16) -> String {
        (0..w).map(|x| buf[(x, y)].symbol().to_owned()).collect()
    }

    fn fg(buf: &Buffer, x: u16, y: u16) -> Option<Color> {
        buf[(x, y)].style().fg
    }

    // Req 27.2
    #[test]
    fn shows_newest_first_with_side_colors() {
        // Newest first, as the app stores it. Another symbol in between is skipped.
        let entries: VecDeque<TapeEntry> = [
            entry("BTC-USD", 6_400_100, Side::Buy, 3_661_000),
            entry("ETH-USD", 300_000, Side::Sell, 3_660_000),
            entry("BTC-USD", 6_400_000, Side::Sell, 60_000),
        ]
        .into_iter()
        .collect();
        let buf = render(&entries, 44, 6);
        assert!(row_text(&buf, 0, 44).contains("TAPE"));
        let first = row_text(&buf, 1, 44);
        assert!(first.contains("01:01:01"), "{first}");
        assert!(first.contains("64001.00"), "{first}");
        assert!(first.contains("0.10000000"), "{first}");
        assert!(first.contains("BUY"), "{first}");
        let second = row_text(&buf, 2, 44);
        assert!(second.contains("00:01:00"), "{second}");
        assert!(second.contains("64000.00"), "{second}");
        assert!(second.contains("SELL"), "{second}");
        assert!(!row_text(&buf, 3, 44).contains("3000.00"));
        // Time is gray; the rest of the row takes the side color.
        assert_eq!(fg(&buf, 1, 1), Some(TIME_COLOR));
        assert_eq!(fg(&buf, 12, 1), Some(BUY_COLOR));
        assert_eq!(fg(&buf, 12, 2), Some(SELL_COLOR));
    }

    #[test]
    fn shows_only_as_many_rows_as_fit() {
        let entries: VecDeque<TapeEntry> = (0..10)
            .map(|i| entry("BTC-USD", 6_400_000 + i, Side::Buy, i * 1_000))
            .collect();
        let buf = render(&entries, 44, 4);
        // Two rows inside the border: the two newest entries in the deque.
        assert!(row_text(&buf, 1, 44).contains("64000.00"));
        assert!(row_text(&buf, 2, 44).contains("64000.01"));
    }

    #[test]
    fn empty_and_tiny_areas() {
        let empty = VecDeque::new();
        let buf = render(&empty, 30, 5);
        assert!(row_text(&buf, 1, 30).contains("no data"));
        let other: VecDeque<TapeEntry> = [entry("ETH-USD", 1, Side::Buy, 0)].into_iter().collect();
        assert!(row_text(&render(&other, 30, 5), 1, 30).contains("no data"));
        let entries: VecDeque<TapeEntry> =
            [entry("BTC-USD", 1, Side::Buy, 0)].into_iter().collect();
        for (w, h) in [
            (0, 0),
            (1, 1),
            (2, 2),
            (3, 3),
            (10, 3),
            (9, 3),
            (11, 3),
            (30, 1),
        ] {
            let _ = render(&entries, w, h);
        }
    }
}
