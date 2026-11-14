//! Order_Book (design §2 "Order_Book", Req 9.1–9.6). Pure and deterministic: no I/O, no clock.
//!
//! One [`OrderBook`] holds one symbol, as a `BTreeMap<Price, Qty>` per side. The state is `Eq`,
//! so a test can compare two books directly (properties P8–P10, Task 8.2).
//!
//! Invariants after every operation:
//! - every stored quantity is greater than zero (Req 9.9);
//! - while both sides are non-empty, best bid < best ask (Req 9.10).
//!
//! Crossed-book rule (Req 9.5): after a bid delta with quantity > 0 at price `p`, every ask with
//! price <= `p` is removed. After an ask delta with quantity > 0 at `p`, every bid with
//! price >= `p` is removed. A delta that removes a level (quantity 0) cannot cross the book.
//!
//! A crossed snapshot is repaired the same way, with the bids treated as the newer side: asks at
//! or below the best bid are removed. That is a choice, as a venue snapshot should never cross.

use std::collections::BTreeMap;
use std::fmt;

use protocol::{Level, Price, Qty, Side};

/// Why a delta was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BookError {
    /// The delta carried a negative quantity (Req 9.4).
    NegativeQuantity,
}

impl fmt::Display for BookError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NegativeQuantity => f.write_str("negative quantity in book delta"),
        }
    }
}

impl std::error::Error for BookError {}

/// Bid and ask levels of one symbol.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct OrderBook {
    pub bids: BTreeMap<Price, Qty>,
    pub asks: BTreeMap<Price, Qty>,
}

impl OrderBook {
    pub fn new() -> Self {
        Self::default()
    }

    /// Replaces both sides (Req 9.1). Levels with quantity <= 0 are dropped.
    pub fn apply_snapshot(&mut self, bids: &[Level], asks: &[Level]) {
        self.bids = collect_side(bids);
        self.asks = collect_side(asks);
        if let Some(bid) = self.best_bid() {
            self.remove_asks_through(bid);
        }
    }

    /// Applies one level change (Req 9.2–9.5). On error the book is unchanged.
    pub fn apply_delta(&mut self, side: Side, price: Price, qty: Qty) -> Result<(), BookError> {
        if qty.0 < 0 {
            return Err(BookError::NegativeQuantity);
        }
        let (own, _) = self.sides_mut(side);
        if qty.0 == 0 {
            own.remove(&price);
            return Ok(());
        }
        own.insert(price, qty);
        match side {
            Side::Buy => self.remove_asks_through(price),
            Side::Sell => self.remove_bids_through(price),
        }
        Ok(())
    }

    pub fn best_bid(&self) -> Option<Price> {
        self.bids.keys().next_back().copied()
    }

    pub fn best_ask(&self) -> Option<Price> {
        self.asks.keys().next().copied()
    }

    /// Best ask minus best bid, or `None` while a side is empty or the subtraction overflows.
    pub fn spread(&self) -> Option<Price> {
        let ask = self.best_ask()?;
        let bid = self.best_bid()?;
        ask.0.checked_sub(bid.0).map(Price)
    }

    /// Bid levels (descending price) and ask levels (ascending), at most `n` each.
    pub fn top(&self, n: usize) -> (Vec<Level>, Vec<Level>) {
        (self.top_bids(n).collect(), self.top_asks(n).collect())
    }

    /// Iterator over the best `n` bid levels, best first.
    pub fn top_bids(&self, n: usize) -> impl Iterator<Item = Level> + '_ {
        self.bids.iter().rev().take(n).map(to_level)
    }

    /// Iterator over the best `n` ask levels, best first.
    pub fn top_asks(&self, n: usize) -> impl Iterator<Item = Level> + '_ {
        self.asks.iter().take(n).map(to_level)
    }

    /// `(bid_qty - ask_qty) * 10000 / (bid_qty + ask_qty)` over the top `n` levels of each
    /// side, in i128, rounded toward zero. 0 when both sides are empty. In [-10000, 10000].
    pub fn imbalance_bps(&self, n: usize) -> i32 {
        let bid: i128 = self.top_bids(n).map(|l| i128::from(l.qty.0)).sum();
        let ask: i128 = self.top_asks(n).map(|l| i128::from(l.qty.0)).sum();
        let total = bid + ask;
        if total == 0 {
            return 0;
        }
        let bps = (bid - ask) * 10_000 / total;
        i32::try_from(bps).unwrap_or(if bps < 0 { -10_000 } else { 10_000 })
    }

    fn sides_mut(
        &mut self,
        side: Side,
    ) -> (&mut BTreeMap<Price, Qty>, &mut BTreeMap<Price, Qty>) {
        match side {
            Side::Buy => (&mut self.bids, &mut self.asks),
            Side::Sell => (&mut self.asks, &mut self.bids),
        }
    }

    /// Removes asks with price <= `price`.
    fn remove_asks_through(&mut self, price: Price) {
        while let Some(best) = self.best_ask() {
            if best > price {
                break;
            }
            self.asks.remove(&best);
        }
    }

    /// Removes bids with price >= `price`.
    fn remove_bids_through(&mut self, price: Price) {
        while let Some(best) = self.best_bid() {
            if best < price {
                break;
            }
            self.bids.remove(&best);
        }
    }
}

fn to_level((price, qty): (&Price, &Qty)) -> Level {
    Level {
        price: *price,
        qty: *qty,
    }
}

/// Builds one side from snapshot levels. A repeated price keeps the last quantity.
fn collect_side(levels: &[Level]) -> BTreeMap<Price, Qty> {
    let mut side = BTreeMap::new();
    for level in levels {
        if level.qty.0 > 0 {
            side.insert(level.price, level.qty);
        } else {
            side.remove(&level.price);
        }
    }
    side
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lv(price: i64, qty: i64) -> Level {
        Level {
            price: Price(price),
            qty: Qty(qty),
        }
    }

    fn book(bids: &[(i64, i64)], asks: &[(i64, i64)]) -> OrderBook {
        let mut b = OrderBook::new();
        let bids: Vec<Level> = bids.iter().map(|&(p, q)| lv(p, q)).collect();
        let asks: Vec<Level> = asks.iter().map(|&(p, q)| lv(p, q)).collect();
        b.apply_snapshot(&bids, &asks);
        b
    }

    fn prices(levels: &[Level]) -> Vec<i64> {
        levels.iter().map(|l| l.price.0).collect()
    }

    #[test]
    fn snapshot_replaces_everything_and_drops_empty_levels() {
        let mut b = book(&[(99, 1), (98, 2)], &[(101, 3)]);
        b.apply_snapshot(&[lv(50, 4), lv(49, 0), lv(48, -1)], &[lv(60, 5)]);
        assert_eq!(b, book(&[(50, 4)], &[(60, 5)]));
        b.apply_snapshot(&[], &[]);
        assert_eq!(b, OrderBook::new());
    }

    #[test]
    fn crossed_snapshot_removes_asks_at_or_below_best_bid() {
        let b = book(&[(100, 1), (99, 1)], &[(99, 1), (100, 1), (101, 2)]);
        assert_eq!(b.best_bid(), Some(Price(100)));
        assert_eq!(b.best_ask(), Some(Price(101)));
        assert_eq!(b.bids.len(), 2);
    }

    #[test]
    fn delta_sets_updates_and_removes() {
        let mut b = book(&[(99, 1)], &[(101, 1)]);
        b.apply_delta(Side::Buy, Price(98), Qty(5)).unwrap();
        assert_eq!(b.bids.get(&Price(98)), Some(&Qty(5)));
        b.apply_delta(Side::Buy, Price(98), Qty(7)).unwrap();
        assert_eq!(b.bids.get(&Price(98)), Some(&Qty(7)));
        b.apply_delta(Side::Buy, Price(98), Qty(0)).unwrap();
        assert_eq!(b, book(&[(99, 1)], &[(101, 1)]));
        // Removing a level that is not there changes nothing.
        b.apply_delta(Side::Sell, Price(500), Qty(0)).unwrap();
        assert_eq!(b, book(&[(99, 1)], &[(101, 1)]));
    }

    #[test]
    fn negative_delta_is_an_error_and_leaves_the_book_unchanged() {
        let mut b = book(&[(99, 1)], &[(101, 1)]);
        let before = b.clone();
        assert_eq!(
            b.apply_delta(Side::Buy, Price(99), Qty(-1)),
            Err(BookError::NegativeQuantity)
        );
        assert_eq!(
            b.apply_delta(Side::Sell, Price(300), Qty(-5)),
            Err(BookError::NegativeQuantity)
        );
        assert_eq!(b, before);
        assert!(!BookError::NegativeQuantity.to_string().is_empty());
    }

    #[test]
    fn bid_delta_removes_crossed_asks_including_equal_price() {
        let mut b = book(&[(99, 1)], &[(100, 1), (101, 1), (102, 1), (103, 1)]);
        b.apply_delta(Side::Buy, Price(102), Qty(4)).unwrap();
        assert_eq!(b, book(&[(102, 4), (99, 1)], &[(103, 1)]));
        assert!(b.best_bid() < b.best_ask());
    }

    #[test]
    fn ask_delta_removes_crossed_bids_including_equal_price() {
        let mut b = book(&[(100, 1), (99, 1), (98, 1), (97, 1)], &[(105, 1)]);
        b.apply_delta(Side::Sell, Price(98), Qty(4)).unwrap();
        assert_eq!(b, book(&[(97, 1)], &[(98, 4), (105, 1)]));
    }

    #[test]
    fn removal_delta_never_touches_the_other_side() {
        let mut b = book(&[(99, 1)], &[(101, 1)]);
        b.apply_delta(Side::Buy, Price(200), Qty(0)).unwrap();
        assert_eq!(b, book(&[(99, 1)], &[(101, 1)]));
    }

    #[test]
    fn top_orders_and_truncates() {
        let b = book(&[(1, 1), (3, 3), (2, 2)], &[(6, 6), (4, 4), (5, 5)]);
        let (bids, asks) = b.top(2);
        assert_eq!(prices(&bids), [3, 2]);
        assert_eq!(prices(&asks), [4, 5]);
        let (bids, asks) = b.top(20);
        assert_eq!(prices(&bids), [3, 2, 1]);
        assert_eq!(prices(&asks), [4, 5, 6]);
        assert_eq!(b.top(0), (Vec::new(), Vec::new()));
    }

    #[test]
    fn spread_needs_both_sides() {
        assert_eq!(book(&[(99, 1)], &[(101, 1)]).spread(), Some(Price(2)));
        assert_eq!(book(&[(99, 1)], &[]).spread(), None);
        assert_eq!(book(&[], &[(101, 1)]).spread(), None);
        assert_eq!(OrderBook::new().spread(), None);
        let wide = book(&[(i64::MIN, 1)], &[(i64::MAX, 1)]);
        assert_eq!(wide.spread(), None);
    }

    #[test]
    fn imbalance_cases_and_bounds() {
        assert_eq!(OrderBook::new().imbalance_bps(20), 0);
        assert_eq!(book(&[(99, 5)], &[(101, 5)]).imbalance_bps(20), 0);
        assert_eq!(book(&[(99, 5)], &[]).imbalance_bps(20), 10_000);
        assert_eq!(book(&[], &[(101, 5)]).imbalance_bps(20), -10_000);
        assert_eq!(book(&[(99, 3)], &[(101, 1)]).imbalance_bps(20), 5_000);
        // Only the top n levels count: 1 vs 1 at n = 1.
        let b = book(&[(99, 1), (98, 100)], &[(101, 1), (102, 1)]);
        assert_eq!(b.imbalance_bps(1), 0);
        let huge = book(&[(99, i64::MAX)], &[(101, 1)]);
        let v = huge.imbalance_bps(20);
        assert!((-10_000..=10_000).contains(&v));
    }
}

#[cfg(test)]
#[path = "book_properties.rs"]
mod properties;
