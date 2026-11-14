//! Pure model of the order book panel and the trades tape (Req 27.1, 27.2, 30.1).
//!
//! No ratatui types here. Integer math only: depth bars use `i128`, prices and quantities are
//! formatted with the chart helpers. The widgets in `book_widget.rs` and `tape_widget.rs` turn
//! these results into styled cells.
//!
//! Level indexes are best-first per side: `asks[0]` is the lowest ask and `bids[0]` is the
//! highest bid. That is the same index the hit map's `BookLevel` carries.

// Some helpers are used only by tests or by later panels.
#![allow(dead_code)]

use protocol::{Level, Price, Qty, Side, TimeMs};

use crate::chart_model::{format_price, format_qty};
use crate::hitmap::BookSide;

/// Trades the app keeps.
pub const MAX_TAPE: usize = 200;

/// The last book of one symbol.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BookState {
    /// Best first (descending price).
    pub bids: Vec<Level>,
    /// Best first (ascending price).
    pub asks: Vec<Level>,
    pub spread: Option<Price>,
    pub imbalance_bps: i32,
    pub ts: TimeMs,
}

impl BookState {
    pub fn is_empty(&self) -> bool {
        self.bids.is_empty() && self.asks.is_empty()
    }

    fn side(&self, side: BookSide) -> &[Level] {
        match side {
            BookSide::Bid => &self.bids,
            BookSide::Ask => &self.asks,
        }
    }

    /// The level a cursor points at.
    pub fn level(&self, side: BookSide, index: usize) -> Option<Level> {
        self.side(side).get(index).copied()
    }
}

/// One trade on the tape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TapeEntry {
    pub symbol: String,
    pub price: Price,
    pub qty: Qty,
    /// The aggressor side.
    pub side: Side,
    pub ts: TimeMs,
}

/// The bar length of a level in thousandths of the largest level: `level / max * 1000`, rounded
/// down, 1000 for the largest, 0 for a zero or negative level or a non-positive max.
pub fn depth_permille(level_qty: Qty, max_qty: Qty) -> u16 {
    if max_qty.0 <= 0 || level_qty.0 <= 0 {
        return 0;
    }
    let level = i128::from(level_qty.0).min(i128::from(max_qty.0));
    let permille = level * 1_000 / i128::from(max_qty.0);
    u16::try_from(permille).unwrap_or(1_000)
}

/// The block characters of a depth bar `width` cells wide at `permille` thousandths, left
/// aligned and not padded. A non-zero permille shows at least one eighth.
pub fn depth_bar(permille: u16, width: usize) -> String {
    const PARTIAL: [char; 7] = ['▏', '▎', '▍', '▌', '▋', '▊', '▉'];
    let permille = usize::from(permille.min(1_000));
    if permille == 0 || width == 0 {
        return String::new();
    }
    let eighths = (permille * width * 8 / 1_000).max(1);
    let full = eighths / 8;
    let rest = eighths % 8;
    let mut bar = "█".repeat(full);
    if let Some(c) = rest.checked_sub(1).and_then(|i| PARTIAL.get(i)) {
        bar.push(*c);
    }
    bar
}

/// A selected level: the side and the best-first index on that side.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BookCursor {
    pub side: BookSide,
    pub index: usize,
}

impl BookCursor {
    /// The first cursor position: the best ask, else the best bid. `None` for an empty book.
    pub fn first(book: &BookState) -> Option<Self> {
        if !book.asks.is_empty() {
            Some(Self {
                side: BookSide::Ask,
                index: 0,
            })
        } else if !book.bids.is_empty() {
            Some(Self {
                side: BookSide::Bid,
                index: 0,
            })
        } else {
            None
        }
    }

    /// Moves to the nearest valid level when the book changed. `None` for an empty book.
    pub fn clamp(self, book: &BookState) -> Option<Self> {
        let len = book.side(self.side).len();
        if len > 0 {
            return Some(Self {
                side: self.side,
                index: self.index.min(len - 1),
            });
        }
        Self::first(book)
    }

    /// One row up on screen: toward worse asks, or from the best bid to the best ask.
    pub fn up(self, book: &BookState) -> Self {
        let Some(me) = self.clamp(book) else {
            return self;
        };
        match me.side {
            BookSide::Ask => Self {
                side: BookSide::Ask,
                index: (me.index + 1).min(book.asks.len() - 1),
            },
            BookSide::Bid if me.index > 0 => Self {
                side: BookSide::Bid,
                index: me.index - 1,
            },
            BookSide::Bid if !book.asks.is_empty() => Self {
                side: BookSide::Ask,
                index: 0,
            },
            BookSide::Bid => me,
        }
    }

    /// One row down on screen: toward the spread, across it, then toward worse bids.
    pub fn down(self, book: &BookState) -> Self {
        let Some(me) = self.clamp(book) else {
            return self;
        };
        match me.side {
            BookSide::Ask if me.index > 0 => Self {
                side: BookSide::Ask,
                index: me.index - 1,
            },
            BookSide::Ask if !book.bids.is_empty() => Self {
                side: BookSide::Bid,
                index: 0,
            },
            BookSide::Ask => me,
            BookSide::Bid => Self {
                side: BookSide::Bid,
                index: (me.index + 1).min(book.bids.len() - 1),
            },
        }
    }
}

/// One displayed row of the book, top to bottom.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BookRow {
    Level {
        side: BookSide,
        /// Best-first index on its side.
        index: usize,
        price: Price,
        qty: Qty,
        permille: u16,
    },
    Spread {
        spread: Option<Price>,
        imbalance_bps: i32,
    },
}

/// The rows for at most `max_rows` rows: worst shown ask down to the best ask, the spread row,
/// then bids best first. The best levels are kept when rows run out. Depth bars scale to the
/// largest displayed level. With room for at least one row, the spread row is always present.
pub fn layout_rows(book: &BookState, max_rows: usize) -> Vec<BookRow> {
    if max_rows == 0 {
        return Vec::new();
    }
    let avail = max_rows - 1;
    let bid_share = avail / 2;
    let mut bids_n = book.bids.len().min(bid_share);
    let asks_n = book.asks.len().min(avail - bids_n);
    bids_n = book.bids.len().min(avail - asks_n);

    let shown_max = book
        .asks
        .iter()
        .take(asks_n)
        .chain(book.bids.iter().take(bids_n))
        .map(|l| l.qty.0)
        .max()
        .unwrap_or(0);
    let max_qty = Qty(shown_max);
    let level_row = |side: BookSide, index: usize, level: &Level| BookRow::Level {
        side,
        index,
        price: level.price,
        qty: level.qty,
        permille: depth_permille(level.qty, max_qty),
    };

    let mut rows = Vec::with_capacity(asks_n + 1 + bids_n);
    for (index, level) in book.asks.iter().enumerate().take(asks_n).rev() {
        rows.push(level_row(BookSide::Ask, index, level));
    }
    rows.push(BookRow::Spread {
        spread: book.spread,
        imbalance_bps: book.imbalance_bps,
    });
    for (index, level) in book.bids.iter().enumerate().take(bids_n) {
        rows.push(level_row(BookSide::Bid, index, level));
    }
    rows
}

/// Imbalance in basis points as a signed percentage with two decimals: `1234` is `+12.34%`.
pub fn format_imbalance(bps: i32) -> String {
    let sign = if bps < 0 { "-" } else { "+" };
    let abs = i64::from(bps).unsigned_abs();
    format!("{sign}{}.{:02}%", abs / 100, abs % 100)
}

/// The text of the middle row: `SPR 0.50  IMB +12.34%`.
pub fn format_spread_row(spread: Option<Price>, imbalance_bps: i32) -> String {
    let spread = spread.map_or_else(|| "-".to_owned(), format_price);
    format!("SPR {spread}  IMB {}", format_imbalance(imbalance_bps))
}

/// UTC time of day of `ms` since the epoch: `HH:MM:SS`.
pub fn format_clock(ms: TimeMs) -> String {
    let in_day = ms.div_euclid(1_000).rem_euclid(86_400);
    format!(
        "{:02}:{:02}:{:02}",
        in_day / 3_600,
        in_day % 3_600 / 60,
        in_day % 60
    )
}

/// The ticket line text: `TICKET: LMT 64000.50` or `TICKET: -` when nothing is prefilled.
pub fn format_ticket(price: Option<Price>) -> String {
    match price {
        Some(p) => format!("TICKET: LMT {}", format_price(p)),
        None => "TICKET: -".to_owned(),
    }
}

/// The price and quantity text of a level.
pub fn format_level(price: Price, qty: Qty) -> (String, String) {
    (format_price(price), format_qty(qty))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lvl(price: i64, qty: i64) -> Level {
        Level {
            price: Price(price),
            qty: Qty(qty),
        }
    }

    fn book(asks: &[(i64, i64)], bids: &[(i64, i64)]) -> BookState {
        BookState {
            asks: asks.iter().map(|&(p, q)| lvl(p, q)).collect(),
            bids: bids.iter().map(|&(p, q)| lvl(p, q)).collect(),
            spread: Some(Price(50)),
            imbalance_bps: -1_234,
            ts: 0,
        }
    }

    #[test]
    fn permille_bounds() {
        assert_eq!(depth_permille(Qty(10), Qty(10)), 1_000);
        assert_eq!(depth_permille(Qty(0), Qty(10)), 0);
        assert_eq!(depth_permille(Qty(-5), Qty(10)), 0);
        assert_eq!(depth_permille(Qty(5), Qty(10)), 500);
        assert_eq!(depth_permille(Qty(1), Qty(3)), 333);
        assert_eq!(depth_permille(Qty(5), Qty(0)), 0);
        // A level above the max is capped.
        assert_eq!(depth_permille(Qty(50), Qty(10)), 1_000);
    }

    #[test]
    fn permille_does_not_overflow() {
        assert_eq!(depth_permille(Qty(i64::MAX), Qty(i64::MAX)), 1_000);
        assert_eq!(depth_permille(Qty(i64::MAX / 2), Qty(i64::MAX)), 499);
        assert_eq!(depth_permille(Qty(1), Qty(i64::MAX)), 0);
        assert_eq!(depth_permille(Qty(i64::MIN), Qty(i64::MAX)), 0);
    }

    #[test]
    fn depth_bar_uses_eighth_blocks() {
        assert_eq!(depth_bar(0, 10), "");
        assert_eq!(depth_bar(1_000, 4), "████");
        assert_eq!(depth_bar(500, 4), "██");
        // 125 permille of 4 cells = 4 eighths.
        assert_eq!(depth_bar(125, 4), "▌");
        // A tiny level still shows one eighth.
        assert_eq!(depth_bar(1, 4), "▏");
        // 7 eighths.
        assert_eq!(depth_bar(875, 1), "▉");
        assert_eq!(depth_bar(500, 0), "");
        assert_eq!(depth_bar(5_000, 2), "██");
    }

    #[test]
    fn cursor_first_prefers_the_best_ask() {
        assert_eq!(BookCursor::first(&BookState::default()), None);
        let b = book(&[(101, 1)], &[(100, 1)]);
        assert_eq!(
            BookCursor::first(&b),
            Some(BookCursor {
                side: BookSide::Ask,
                index: 0
            })
        );
        let b = book(&[], &[(100, 1)]);
        assert_eq!(BookCursor::first(&b).map(|c| c.side), Some(BookSide::Bid));
    }

    #[test]
    fn cursor_moves_across_the_ask_bid_boundary_and_clamps() {
        let b = book(&[(101, 1), (102, 1)], &[(100, 1), (99, 1)]);
        let at = |side, index| BookCursor { side, index };
        // Down from the worst ask to the best ask, across the spread, to the worst bid.
        let mut c = at(BookSide::Ask, 1);
        c = c.down(&b);
        assert_eq!(c, at(BookSide::Ask, 0));
        c = c.down(&b);
        assert_eq!(c, at(BookSide::Bid, 0));
        c = c.down(&b);
        assert_eq!(c, at(BookSide::Bid, 1));
        c = c.down(&b);
        assert_eq!(c, at(BookSide::Bid, 1));
        // Back up.
        c = c.up(&b);
        assert_eq!(c, at(BookSide::Bid, 0));
        c = c.up(&b);
        assert_eq!(c, at(BookSide::Ask, 0));
        c = c.up(&b);
        assert_eq!(c, at(BookSide::Ask, 1));
        c = c.up(&b);
        assert_eq!(c, at(BookSide::Ask, 1));
    }

    #[test]
    fn cursor_handles_one_sided_and_shrunk_books() {
        let bids_only = book(&[], &[(100, 1), (99, 1)]);
        let top = BookCursor {
            side: BookSide::Bid,
            index: 0,
        };
        assert_eq!(top.up(&bids_only), top);
        let asks_only = book(&[(101, 1), (102, 1)], &[]);
        let best_ask = BookCursor {
            side: BookSide::Ask,
            index: 0,
        };
        assert_eq!(best_ask.down(&asks_only), best_ask);
        // A cursor past the end clamps; a cursor on an emptied side jumps to the other.
        let far = BookCursor {
            side: BookSide::Bid,
            index: 9,
        };
        assert_eq!(far.clamp(&bids_only).map(|c| c.index), Some(1));
        assert_eq!(
            far.clamp(&asks_only),
            Some(BookCursor {
                side: BookSide::Ask,
                index: 0
            })
        );
        assert_eq!(far.clamp(&BookState::default()), None);
    }

    #[test]
    fn layout_orders_asks_reversed_then_spread_then_bids() {
        let b = book(&[(101, 4), (102, 2), (103, 1)], &[(100, 2), (99, 1)]);
        let rows = layout_rows(&b, 20);
        assert_eq!(rows.len(), 6);
        let prices: Vec<Option<i64>> = rows
            .iter()
            .map(|r| match r {
                BookRow::Level { price, .. } => Some(price.0),
                BookRow::Spread { .. } => None,
            })
            .collect();
        assert_eq!(
            prices,
            [Some(103), Some(102), Some(101), None, Some(100), Some(99)]
        );
        assert_eq!(
            rows[2],
            BookRow::Level {
                side: BookSide::Ask,
                index: 0,
                price: Price(101),
                qty: Qty(4),
                permille: 1_000
            }
        );
        assert_eq!(
            rows[0],
            BookRow::Level {
                side: BookSide::Ask,
                index: 2,
                price: Price(103),
                qty: Qty(1),
                permille: 250
            }
        );
        assert_eq!(
            rows[3],
            BookRow::Spread {
                spread: Some(Price(50)),
                imbalance_bps: -1_234
            }
        );
    }

    #[test]
    fn layout_truncates_keeping_the_best_levels() {
        let b = book(
            &[(101, 1), (102, 1), (103, 1), (104, 1)],
            &[(100, 1), (99, 1), (98, 1), (97, 1)],
        );
        assert!(layout_rows(&b, 0).is_empty());
        let one = layout_rows(&b, 1);
        assert_eq!(one.len(), 1);
        assert!(matches!(one[0], BookRow::Spread { .. }));
        let five = layout_rows(&b, 5);
        assert_eq!(five.len(), 5);
        let indexes: Vec<(BookSide, usize)> = five
            .iter()
            .filter_map(|r| match r {
                BookRow::Level { side, index, .. } => Some((*side, *index)),
                BookRow::Spread { .. } => None,
            })
            .collect();
        assert_eq!(
            indexes,
            [
                (BookSide::Ask, 1),
                (BookSide::Ask, 0),
                (BookSide::Bid, 0),
                (BookSide::Bid, 1)
            ]
        );
        // One side short gives its rows to the other side.
        let lopsided = book(&[(101, 1)], &[(100, 1), (99, 1), (98, 1), (97, 1)]);
        assert_eq!(layout_rows(&lopsided, 6).len(), 6);
        // Everything fits: no padding.
        assert_eq!(layout_rows(&lopsided, 50).len(), 6);
        // An empty book still has the spread row.
        assert_eq!(layout_rows(&BookState::default(), 5).len(), 1);
    }

    #[test]
    fn formatting() {
        assert_eq!(format_imbalance(1_234), "+12.34%");
        assert_eq!(format_imbalance(-5), "-0.05%");
        assert_eq!(format_imbalance(0), "+0.00%");
        assert_eq!(format_imbalance(i32::MIN), "-21474836.48%");
        assert_eq!(
            format_spread_row(Some(Price(50)), 1_000),
            "SPR 0.50  IMB +10.00%"
        );
        assert_eq!(format_spread_row(None, 0), "SPR -  IMB +0.00%");
        assert_eq!(
            format_level(Price(6_400_050), Qty(10_000_000)),
            ("64000.50".to_owned(), "0.10000000".to_owned())
        );
        assert_eq!(format_ticket(Some(Price(6_400_050))), "TICKET: LMT 64000.50");
        assert_eq!(format_ticket(None), "TICKET: -");
    }

    #[test]
    fn clock_is_utc_with_seconds() {
        assert_eq!(format_clock(0), "00:00:00");
        assert_eq!(format_clock(13 * 3_600_000 + 7 * 60_000 + 9_999), "13:07:09");
        assert_eq!(format_clock(-1_000), "23:59:59");
        assert_eq!(format_clock(86_400_000 + 1_000), "00:00:01");
    }
}
