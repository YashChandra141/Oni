//! The watchlist panel: one row per symbol with its last trade price (Req 27.3).
//!
//! Inside the border, each row has the symbol on the left and the price right-aligned. The
//! price is green after an up move, red after a down move, and gray before the first move. The
//! selected symbol's row is reversed and bold. Before the first trade of a symbol the price is
//! `—`. Rows that don't fit are not drawn.

use std::collections::HashMap;

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::widgets::{Block, Widget};

use crate::watchlist_model::{Direction, WatchQuote, price_text};

pub const UP_COLOR: Color = Color::Green;
pub const DOWN_COLOR: Color = Color::Red;
pub const FLAT_COLOR: Color = Color::Gray;

/// The price color of a direction.
pub fn direction_color(direction: Direction) -> Color {
    match direction {
        Direction::Up => UP_COLOR,
        Direction::Down => DOWN_COLOR,
        Direction::Flat => FLAT_COLOR,
    }
}

/// The style of the selected row or strip segment, added on top of the price color.
pub fn selected_style() -> Style {
    Style::new().add_modifier(Modifier::REVERSED | Modifier::BOLD)
}

pub struct WatchlistWidget<'a> {
    symbols: &'a [String],
    quotes: &'a HashMap<String, WatchQuote>,
    selected: &'a str,
}

impl<'a> WatchlistWidget<'a> {
    pub fn new(
        symbols: &'a [String],
        quotes: &'a HashMap<String, WatchQuote>,
        selected: &'a str,
    ) -> Self {
        Self {
            symbols,
            quotes,
            selected,
        }
    }

    /// The area inside the border. Row `i` of the inner area is `symbols[i]`; `ui.rs` uses it
    /// to register each row in the hit map.
    pub fn inner(area: Rect) -> Rect {
        Block::bordered().inner(area)
    }

    /// The height that shows every symbol: one row each plus the border.
    pub fn height_for(symbols: usize) -> u16 {
        u16::try_from(symbols).unwrap_or(u16::MAX).saturating_add(2)
    }
}

impl Widget for WatchlistWidget<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        let block = Block::bordered().title(" WATCHLIST ");
        let inner = block.inner(area);
        block.render(area, buf);
        if inner.width == 0 || inner.height == 0 {
            return;
        }
        let width = usize::from(inner.width);
        for (i, symbol) in self
            .symbols
            .iter()
            .take(usize::from(inner.height))
            .enumerate()
        {
            let Ok(dy) = u16::try_from(i) else { break };
            let y = inner.y + dy;
            let quote = self.quotes.get(symbol);
            let selected = symbol == self.selected;
            let symbol_style = if selected {
                Style::new().add_modifier(Modifier::BOLD)
            } else {
                Style::new()
            };
            buf.set_stringn(inner.x, y, symbol, width, symbol_style);

            // The price goes right-aligned when it fits after the symbol and one space.
            let price = price_text(quote);
            let price_width = price.chars().count();
            let symbol_width = symbol.chars().count();
            if symbol_width + 1 + price_width <= width {
                let offset = u16::try_from(width - price_width).unwrap_or(0);
                let color = direction_color(quote.map_or(Direction::Flat, WatchQuote::direction));
                buf.set_stringn(
                    inner.x + offset,
                    y,
                    price,
                    price_width,
                    Style::new().fg(color),
                );
            }
            if selected {
                buf.set_style(Rect::new(inner.x, y, inner.width, 1), selected_style());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::Price;

    fn symbols() -> Vec<String> {
        crate::watchlist_model::default_watchlist()
    }

    fn quotes() -> HashMap<String, WatchQuote> {
        let mut btc = WatchQuote::new(Price(6_399_900));
        btc.update(Price(6_400_000));
        let mut eth = WatchQuote::new(Price(320_100));
        eth.update(Price(320_000));
        HashMap::from([("BTC-USD".to_owned(), btc), ("ETH-USD".to_owned(), eth)])
    }

    fn render(selected: &str, w: u16, h: u16) -> Buffer {
        let area = Rect::new(0, 0, w, h);
        let mut buf = Buffer::empty(area);
        let symbols = symbols();
        let quotes = quotes();
        WatchlistWidget::new(&symbols, &quotes, selected).render(area, &mut buf);
        buf
    }

    fn row_text(buf: &Buffer, y: u16, w: u16) -> String {
        (0..w).map(|x| buf[(x, y)].symbol().to_owned()).collect()
    }

    // Req 27.3
    #[test]
    fn rows_show_symbols_and_last_prices_colored_by_direction() {
        let buf = render("ETH-USD", 30, 5);
        assert!(row_text(&buf, 0, 30).contains("WATCHLIST"));
        let btc = row_text(&buf, 1, 30);
        assert!(btc.starts_with("│BTC-USD"), "{btc}");
        // The price ends at the right border (inner columns 1..29).
        assert!(btc.ends_with("64000.00│"), "{btc}");
        assert!(row_text(&buf, 2, 30).contains("3200.00"));
        // No trade yet: a dash.
        let sol = row_text(&buf, 3, 30);
        assert!(sol.contains("SOL-USD") && sol.ends_with("—│"), "{sol}");
        // Up is green, down is red, no move is gray.
        assert_eq!(buf[(28, 1)].style().fg, Some(UP_COLOR));
        assert_eq!(buf[(28, 2)].style().fg, Some(DOWN_COLOR));
        assert_eq!(buf[(28, 3)].style().fg, Some(FLAT_COLOR));
    }

    #[test]
    fn the_selected_row_is_reversed() {
        let buf = render("ETH-USD", 30, 5);
        let reversed = |x: u16, y: u16| {
            let style = buf[(x, y)].style();
            style.add_modifier.contains(Modifier::REVERSED)
        };
        assert!(reversed(1, 2) && reversed(15, 2) && reversed(28, 2));
        assert!(!reversed(1, 1) && !reversed(1, 3));
        // The price keeps its color on the selected row.
        assert_eq!(buf[(28, 2)].style().fg, Some(DOWN_COLOR));
    }

    #[test]
    fn narrow_and_tiny_areas() {
        // Too narrow for the price: the symbol only.
        let buf = render("BTC-USD", 12, 5);
        let row = row_text(&buf, 1, 12);
        assert!(row.contains("BTC-USD") && !row.contains("6400"), "{row}");
        // Only the rows that fit.
        let buf = render("BTC-USD", 30, 3);
        assert!(row_text(&buf, 1, 30).contains("BTC-USD"));
        for (w, h) in [(0, 0), (1, 1), (2, 2), (3, 3), (2, 10), (30, 1), (30, 2)] {
            let _ = render("BTC-USD", w, h);
        }
        assert_eq!(WatchlistWidget::height_for(3), 5);
    }
}
