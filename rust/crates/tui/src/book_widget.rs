//! The order book panel: price levels with depth bars made of block characters (Req 27.1).
//!
//! Layout of one level row, inside the border: price right-aligned in 10 cells, one space,
//! quantity right-aligned in 13 cells, one space, then the depth bar (left aligned) in the rest
//! of the width. Asks are red, bids are green. The cursor row is reversed.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::widgets::{Block, Widget};

use crate::book_model::{
    BookCursor, BookRow, BookState, depth_bar, format_level, format_spread_row, layout_rows,
};
use crate::hitmap::BookSide;

/// Column where the depth bar starts, relative to the inner area.
pub const BAR_OFFSET: u16 = 25;

pub const ASK_COLOR: Color = Color::Red;
pub const BID_COLOR: Color = Color::Green;
const SPREAD_COLOR: Color = Color::Yellow;
const EMPTY_COLOR: Color = Color::Gray;

pub struct BookWidget<'a> {
    symbol: &'a str,
    book: Option<&'a BookState>,
    cursor: Option<BookCursor>,
}

impl<'a> BookWidget<'a> {
    pub fn new(symbol: &'a str, book: Option<&'a BookState>, cursor: Option<BookCursor>) -> Self {
        Self {
            symbol,
            book,
            cursor,
        }
    }

    /// The area inside the border, where the rows are drawn. `ui.rs` uses it to register the
    /// level rows in the hit map, so the hit rectangles match what is drawn.
    pub fn inner(area: Rect) -> Rect {
        Block::bordered().inner(area)
    }
}

fn side_color(side: BookSide) -> Color {
    match side {
        BookSide::Ask => ASK_COLOR,
        BookSide::Bid => BID_COLOR,
    }
}

impl Widget for BookWidget<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        let block = Block::bordered().title(format!(" BOOK {} ", self.symbol));
        let inner = block.inner(area);
        block.render(area, buf);
        if inner.width == 0 || inner.height == 0 {
            return;
        }
        let width = usize::from(inner.width);
        let book = match self.book {
            Some(book) if !book.is_empty() => book,
            _ => {
                buf.set_stringn(
                    inner.x,
                    inner.y,
                    "no data",
                    width,
                    Style::default().fg(EMPTY_COLOR),
                );
                return;
            }
        };

        for (i, row) in layout_rows(book, usize::from(inner.height))
            .iter()
            .enumerate()
        {
            let Ok(dy) = u16::try_from(i) else { break };
            let y = inner.y + dy;
            match *row {
                BookRow::Spread {
                    spread,
                    imbalance_bps,
                } => {
                    let text = format_spread_row(spread, imbalance_bps);
                    let shown = text.chars().count().min(width);
                    let pad = (width - shown) / 2;
                    let x = inner.x + u16::try_from(pad).unwrap_or(0);
                    buf.set_stringn(
                        x,
                        y,
                        text,
                        width - pad,
                        Style::default().fg(SPREAD_COLOR),
                    );
                }
                BookRow::Level {
                    side,
                    index,
                    price,
                    qty,
                    permille,
                } => {
                    let selected =
                        self.cursor.is_some_and(|c| c.side == side && c.index == index);
                    let base = if selected {
                        Style::default().add_modifier(Modifier::REVERSED)
                    } else {
                        Style::default()
                    };
                    let color = side_color(side);
                    if selected {
                        buf.set_style(Rect::new(inner.x, y, inner.width, 1), base);
                    }
                    let (price_text, qty_text) = format_level(price, qty);
                    // 10 + 1 + 13 + 1 = BAR_OFFSET cells.
                    let columns = format!("{price_text:>10} {qty_text:>13} ");
                    buf.set_stringn(inner.x, y, columns, width, base.fg(color));
                    let bar_width = inner.width.saturating_sub(BAR_OFFSET);
                    if bar_width > 0 {
                        let bar = depth_bar(permille, usize::from(bar_width));
                        buf.set_stringn(
                            inner.x + BAR_OFFSET,
                            y,
                            bar,
                            usize::from(bar_width),
                            base.fg(color),
                        );
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::{Level, Price, Qty};

    fn lvl(price: i64, qty: i64) -> Level {
        Level {
            price: Price(price),
            qty: Qty(qty),
        }
    }

    fn sample() -> BookState {
        BookState {
            asks: vec![lvl(6_400_100, 200_000_000), lvl(6_400_200, 100_000_000)],
            bids: vec![lvl(6_400_000, 100_000_000), lvl(6_399_900, 50_000_000)],
            spread: Some(Price(100)),
            imbalance_bps: 250,
            ts: 0,
        }
    }

    fn render(
        book: Option<&BookState>,
        cursor: Option<BookCursor>,
        w: u16,
        h: u16,
    ) -> Buffer {
        let area = Rect::new(0, 0, w, h);
        let mut buf = Buffer::empty(area);
        BookWidget::new("BTC-USD", book, cursor).render(area, &mut buf);
        buf
    }

    fn sym(buf: &Buffer, x: u16, y: u16) -> String {
        buf[(x, y)].symbol().to_owned()
    }

    fn fg(buf: &Buffer, x: u16, y: u16) -> Option<Color> {
        buf[(x, y)].style().fg
    }

    fn reversed(buf: &Buffer, x: u16, y: u16) -> bool {
        buf[(x, y)].style().add_modifier.contains(Modifier::REVERSED)
    }

    fn row_text(buf: &Buffer, y: u16, w: u16) -> String {
        (0..w).map(|x| sym(buf, x, y)).collect()
    }

    // 40x9: inner is x 1..39, y 1..8, 7 rows. avail 6: two asks, spread, two bids -> 5 rows.
    // Row y=1 ask index 1, y=2 ask 0, y=3 spread, y=4 bid 0, y=5 bid 1. Bars start at x=26,
    // 13 cells wide.

    // Req 27.1
    #[test]
    fn depth_bars_are_proportional_and_colored() {
        let book = sample();
        let buf = render(Some(&book), None, 40, 9);
        assert!(row_text(&buf, 0, 40).contains("BOOK BTC-USD"));
        // Largest level: the whole bar width.
        for x in 26..39 {
            assert_eq!(sym(&buf, x, 2), "█", "x={x}");
            assert_eq!(fg(&buf, x, 2), Some(Color::Red));
        }
        // Half of the largest: 6 full cells and a half cell.
        assert_eq!(sym(&buf, 26, 1), "█");
        assert_eq!(sym(&buf, 31, 1), "█");
        assert_eq!(sym(&buf, 32, 1), "▌");
        assert_eq!(sym(&buf, 33, 1), " ");
        assert_eq!(fg(&buf, 32, 1), Some(Color::Red));
        // Bids are green: 100M is half, 50M is a quarter (3 full cells and 2 eighths).
        assert_eq!(sym(&buf, 31, 4), "█");
        assert_eq!(sym(&buf, 32, 4), "▌");
        assert_eq!(fg(&buf, 26, 4), Some(Color::Green));
        assert_eq!(sym(&buf, 28, 5), "█");
        assert_eq!(sym(&buf, 29, 5), "▎");
        assert_eq!(fg(&buf, 29, 5), Some(Color::Green));
    }

    #[test]
    fn rows_show_price_qty_and_spread() {
        let book = sample();
        let buf = render(Some(&book), None, 40, 9);
        let ask_best = row_text(&buf, 2, 40);
        assert!(ask_best.contains("64001.00"), "{ask_best}");
        assert!(ask_best.contains("2.00000000"), "{ask_best}");
        // The worse ask is above the better ask; the bids are below the spread.
        assert!(row_text(&buf, 1, 40).contains("64002.00"));
        assert!(row_text(&buf, 4, 40).contains("64000.00"));
        assert!(row_text(&buf, 5, 40).contains("63999.00"));
        let spread = row_text(&buf, 3, 40);
        assert!(spread.contains("SPR 1.00"), "{spread}");
        assert!(spread.contains("IMB +2.50%"), "{spread}");
        assert_eq!(fg(&buf, 15, 3), Some(Color::Yellow));
    }

    #[test]
    fn the_cursor_row_is_reversed() {
        let book = sample();
        let cursor = BookCursor {
            side: BookSide::Ask,
            index: 0,
        };
        let buf = render(Some(&book), Some(cursor), 40, 9);
        assert!(reversed(&buf, 1, 2));
        assert!(reversed(&buf, 38, 2));
        assert!(!reversed(&buf, 1, 1));
        assert!(!reversed(&buf, 1, 4));
        // The level keeps its color under the highlight.
        assert_eq!(fg(&buf, 26, 2), Some(Color::Red));

        let cursor = BookCursor {
            side: BookSide::Bid,
            index: 1,
        };
        let buf = render(Some(&book), Some(cursor), 40, 9);
        assert!(reversed(&buf, 1, 5));
        assert!(!reversed(&buf, 1, 2));
    }

    #[test]
    fn no_data_and_tiny_areas() {
        let buf = render(None, None, 40, 9);
        assert_eq!(sym(&buf, 1, 1), "n");
        assert!(row_text(&buf, 1, 40).contains("no data"));
        let empty = BookState::default();
        let buf = render(Some(&empty), None, 40, 9);
        assert!(row_text(&buf, 1, 40).contains("no data"));
        // Areas with no inner space, or too narrow for the bar, must not panic.
        let book = sample();
        for (w, h) in [(0, 0), (1, 1), (2, 2), (3, 3), (10, 4), (26, 9), (40, 1)] {
            let _ = render(Some(&book), None, w, h);
            let _ = render(None, None, w, h);
        }
    }

    #[test]
    fn a_narrow_panel_drops_the_bar() {
        let book = sample();
        let buf = render(Some(&book), None, 20, 9);
        assert!(!(0..20).any(|x| sym(&buf, x, 2) == "█"));
    }
}
