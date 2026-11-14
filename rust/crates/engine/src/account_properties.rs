//! Property test P17 for Paper_Account round trips (Req 13.5). The oracle is computed
//! independently in i128 from `notional`.

use proptest::prelude::*;
use protocol::{AccountId, Money, OrderId, Price, Qty, Side, instrument, notional};

use crate::account::PaperAccount;
use crate::matcher::FillRecord;

const SYMBOLS: [&str; 3] = ["BTC-USD", "ETH-USD", "SOL-USD"];

fn symbol_strategy() -> impl Strategy<Value = &'static str> {
    prop::sample::select(SYMBOLS.to_vec())
}

fn apply(a: &mut PaperAccount, sym: &str, side: Side, price: i64, qty: i64, fee: i64) {
    a.apply_fill(&FillRecord {
        account_id: AccountId::new("guest").unwrap(),
        order_id: OrderId::new("o1").unwrap(),
        symbol: sym.into(),
        side,
        price: Price(price),
        qty: Qty(qty),
        fee: Money(fee),
        ts: 0,
    })
    .unwrap();
}

/// Notional of `qty` lots at `price` in i128, from the protocol function.
fn n(sym: &str, price: i64, qty: i64) -> i128 {
    let inst = instrument(sym).unwrap();
    i128::from(notional(inst, Price(price), Qty(qty)).unwrap().0)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    // Property P17 — validates Req 13.5
    #[test]
    fn p17_long_round_trip(
        sym in symbol_strategy(),
        q in 1i64..=1_000_000,
        b in 1i64..=1_000_000,
        s in 1i64..=1_000_000,
        f1 in 0i64..=10_000,
        f2 in 0i64..=10_000,
    ) {
        let mut a = PaperAccount::default();
        apply(&mut a, sym, Side::Buy, b, q, f1);
        apply(&mut a, sym, Side::Sell, s, q, f2);
        let p = a.position(sym);
        prop_assert_eq!(p.qty, 0);
        prop_assert_eq!(p.cost_basis, 0);
        prop_assert_eq!(p.realized, n(sym, s, q) - n(sym, b, q) - i128::from(f1) - i128::from(f2));
    }

    // Property P17 (short) — validates Req 13.5
    #[test]
    fn p17_short_round_trip(
        sym in symbol_strategy(),
        q in 1i64..=1_000_000,
        b in 1i64..=1_000_000,
        s in 1i64..=1_000_000,
        f1 in 0i64..=10_000,
        f2 in 0i64..=10_000,
    ) {
        let mut a = PaperAccount::default();
        apply(&mut a, sym, Side::Sell, s, q, f1);
        apply(&mut a, sym, Side::Buy, b, q, f2);
        let p = a.position(sym);
        prop_assert_eq!(p.qty, 0);
        prop_assert_eq!(p.cost_basis, 0);
        prop_assert_eq!(p.realized, n(sym, s, q) - n(sym, b, q) - i128::from(f1) - i128::from(f2));
    }

    // Property P17 (partial sequence) — validates Req 13.5
    #[test]
    fn p17_two_buys_then_one_sell(
        sym in symbol_strategy(),
        q1 in 1i64..=500_000,
        q2 in 1i64..=500_000,
        b1 in 1i64..=1_000_000,
        b2 in 1i64..=1_000_000,
        s in 1i64..=1_000_000,
        f1 in 0i64..=10_000,
        f2 in 0i64..=10_000,
        f3 in 0i64..=10_000,
    ) {
        let mut a = PaperAccount::default();
        apply(&mut a, sym, Side::Buy, b1, q1, f1);
        apply(&mut a, sym, Side::Buy, b2, q2, f2);
        apply(&mut a, sym, Side::Sell, s, q1 + q2, f3);
        let p = a.position(sym);
        prop_assert_eq!(p.qty, 0);
        prop_assert_eq!(p.cost_basis, 0);
        let expected = n(sym, s, q1 + q2) - n(sym, b1, q1) - n(sym, b2, q2)
            - i128::from(f1) - i128::from(f2) - i128::from(f3);
        prop_assert_eq!(p.realized, expected);
    }

    // Property P17 (flip) — validates Req 13.5
    #[test]
    fn p17_flip_charges_all_fees_to_realized(
        sym in symbol_strategy(),
        q in 1i64..=500_000,
        b in 1i64..=1_000_000,
        s in 1i64..=1_000_000,
        f1 in 0i64..=10_000,
        f2 in 0i64..=10_000,
    ) {
        let mut a = PaperAccount::default();
        apply(&mut a, sym, Side::Buy, b, q, f1);
        apply(&mut a, sym, Side::Sell, s, 2 * q, f2);
        let p = a.position(sym);
        prop_assert_eq!(p.qty, -q);
        prop_assert_eq!(p.cost_basis, -n(sym, s, q));
        prop_assert_eq!(p.realized, n(sym, s, q) - n(sym, b, q) - i128::from(f1) - i128::from(f2));
    }
}
