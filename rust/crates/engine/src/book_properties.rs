//! Property tests P8, P9, P10 for the Order_Book (Req 9.9, 9.10, 9.11).

use std::collections::BTreeMap;

use proptest::prelude::*;
use proptest::strategy::ValueTree;
use proptest::test_runner::{TestCaseError, TestRunner};
use protocol::{Level, Price, Qty, Side};

use crate::book::OrderBook;

/// One step applied to a book.
#[derive(Debug, Clone)]
enum Op {
    Snapshot(Vec<(i64, i64)>, Vec<(i64, i64)>),
    Delta(bool, i64, i64),
}

fn levels_strategy() -> impl Strategy<Value = Vec<(i64, i64)>> {
    // Small price range so duplicates and crossings are frequent; qty includes <= 0.
    prop::collection::vec((1i64..=40, -2i64..=5), 0..12)
}

fn snapshot_strategy() -> impl Strategy<Value = Op> {
    (levels_strategy(), levels_strategy()).prop_map(|(b, a)| Op::Snapshot(b, a))
}

fn delta_strategy() -> impl Strategy<Value = Op> {
    // Quantity is weighted: mostly positive, some zero, some negative.
    let qty = prop_oneof![
        6 => 1i64..=6,
        2 => Just(0i64),
        1 => -3i64..=-1,
    ];
    (any::<bool>(), 1i64..=40, qty).prop_map(|(buy, p, q)| Op::Delta(buy, p, q))
}

fn op_strategy() -> impl Strategy<Value = Op> {
    prop_oneof![
        1 => snapshot_strategy(),
        6 => delta_strategy(),
    ]
}

fn ops_strategy() -> impl Strategy<Value = Vec<Op>> {
    prop::collection::vec(op_strategy(), 0..60)
}

fn to_levels(raw: &[(i64, i64)]) -> Vec<Level> {
    raw.iter()
        .map(|&(p, q)| Level {
            price: Price(p),
            qty: Qty(q),
        })
        .collect()
}

fn side_of(buy: bool) -> Side {
    if buy { Side::Buy } else { Side::Sell }
}

/// Applies one op. Returns whether a delta was rejected.
fn apply(book: &mut OrderBook, op: &Op) -> bool {
    match op {
        Op::Snapshot(b, a) => {
            book.apply_snapshot(&to_levels(b), &to_levels(a));
            false
        }
        Op::Delta(buy, p, q) => book
            .apply_delta(side_of(*buy), Price(*p), Qty(*q))
            .is_err(),
    }
}

fn check_positive(book: &OrderBook) -> Result<(), TestCaseError> {
    for l in book.top_bids(usize::MAX).chain(book.top_asks(usize::MAX)) {
        prop_assert!(l.qty.0 > 0, "non-positive level {:?}", l);
    }
    for q in book.bids.values().chain(book.asks.values()) {
        prop_assert!(q.0 > 0);
    }
    Ok(())
}

fn check_uncrossed(book: &OrderBook) -> Result<(), TestCaseError> {
    if let (Some(bid), Some(ask)) = (book.best_bid(), book.best_ask()) {
        prop_assert!(bid < ask, "crossed book: bid {:?} ask {:?}", bid, ask);
    }
    Ok(())
}

// Reference model: BTreeMap per side, same documented rules.
#[derive(Default, Clone)]
struct Model {
    bids: BTreeMap<i64, i64>,
    asks: BTreeMap<i64, i64>,
}

fn model_side(raw: &[(i64, i64)]) -> BTreeMap<i64, i64> {
    let mut m = BTreeMap::new();
    for &(p, q) in raw {
        if q > 0 {
            m.insert(p, q);
        } else {
            m.remove(&p);
        }
    }
    m
}

impl Model {
    fn apply(&mut self, op: &Op) {
        match op {
            Op::Snapshot(b, a) => {
                self.bids = model_side(b);
                self.asks = model_side(a);
                if let Some(&bid) = self.bids.keys().next_back() {
                    self.asks.retain(|&p, _| p > bid);
                }
            }
            Op::Delta(buy, p, q) => {
                if *q < 0 {
                    return;
                }
                let own = if *buy { &mut self.bids } else { &mut self.asks };
                if *q == 0 {
                    own.remove(p);
                    return;
                }
                own.insert(*p, *q);
                if *buy {
                    self.asks.retain(|&ap, _| ap > *p);
                } else {
                    self.bids.retain(|&bp, _| bp < *p);
                }
            }
        }
    }

    fn snapshot_levels(&self) -> (Vec<Level>, Vec<Level>) {
        let b: Vec<(i64, i64)> = self.bids.iter().map(|(&p, &q)| (p, q)).collect();
        let a: Vec<(i64, i64)> = self.asks.iter().map(|(&p, &q)| (p, q)).collect();
        (to_levels(&b), to_levels(&a))
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    // Property P8 — validates Req 9.9
    #[test]
    fn p8_every_level_quantity_is_positive(ops in ops_strategy()) {
        let mut book = OrderBook::new();
        for op in &ops {
            let before = book.clone();
            let rejected = apply(&mut book, op);
            check_positive(&book)?;
            if rejected {
                prop_assert_eq!(&book, &before);
                prop_assert!(matches!(op, Op::Delta(_, _, q) if *q < 0));
            }
        }
    }

    // Property P9 — validates Req 9.10
    #[test]
    fn p9_best_bid_below_best_ask(ops in ops_strategy()) {
        let mut book = OrderBook::new();
        for op in &ops {
            apply(&mut book, op);
            check_uncrossed(&book)?;
        }
    }

    // Property P10 — validates Req 9.11
    #[test]
    fn p10_snapshot_plus_deltas_equals_final_snapshot(
        (b, a) in (levels_strategy(), levels_strategy()),
        deltas in prop::collection::vec(delta_strategy(), 0..40),
        prior in ops_strategy(),
    ) {
        let first = Op::Snapshot(b, a);
        let mut book_a = OrderBook::new();
        let mut model = Model::default();
        apply(&mut book_a, &first);
        model.apply(&first);
        for d in &deltas {
            apply(&mut book_a, d);
            model.apply(d);
        }
        let (fb, fa) = model.snapshot_levels();
        let mut book_b = OrderBook::new();
        book_b.apply_snapshot(&fb, &fa);
        prop_assert_eq!(&book_a, &book_b);

        // A snapshot fully replaces unrelated prior state.
        let mut book_c = OrderBook::new();
        for op in &prior {
            apply(&mut book_c, op);
        }
        book_c.apply_snapshot(&fb, &fa);
        prop_assert_eq!(&book_c, &book_b);
    }

    // Determinism: the same inputs twice give equal books.
    #[test]
    fn same_inputs_give_equal_books(ops in ops_strategy()) {
        let mut x = OrderBook::new();
        let mut y = OrderBook::new();
        for op in &ops {
            apply(&mut x, op);
        }
        for op in &ops {
            apply(&mut y, op);
        }
        prop_assert_eq!(x, y);
    }
}

/// The generator must produce deltas that cross the book often enough to exercise Req 9.5.
#[test]
fn generator_produces_crossing_deltas() {
    let mut runner = TestRunner::deterministic();
    let strategy = ops_strategy();
    let mut crossing = 0usize;
    for _ in 0..200 {
        let ops = strategy.new_tree(&mut runner).unwrap().current();
        let mut book = OrderBook::new();
        for op in &ops {
            let (bids, asks) = (book.bids.len(), book.asks.len());
            apply(&mut book, op);
            // A positive-quantity delta that shrinks the opposite side crossed the book.
            if let Op::Delta(buy, _, q) = op {
                let removed = if *buy {
                    book.asks.len() < asks
                } else {
                    book.bids.len() < bids
                };
                if *q > 0 && removed {
                    crossing += 1;
                }
            }
        }
    }
    assert!(crossing >= 100, "only {crossing} crossing deltas generated");
}
