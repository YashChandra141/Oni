//! Property tests P14, P15, P16 for the matcher, driven through `Engine` (Req 11.10, 12.5, 12.6).

use std::collections::BTreeMap;

use proptest::prelude::*;
use proptest::strategy::ValueTree;
use proptest::test_runner::TestRunner;
use protocol::{AccountId, Command, Event, Level, OrderId, OrderKind, Price, Qty, Side, TimeMs};

use crate::core::Engine;
use crate::feed::MarketMsg;

const BTC: &str = "BTC-USD";

/// Order shape before a price is attached.
#[derive(Debug, Clone, Copy)]
enum KindSpec {
    Market,
    Limit(i64),
    Stop(i64),
}

/// One step applied to the engine.
#[derive(Debug, Clone)]
enum Op {
    Snapshot(Vec<(i64, i64)>, Vec<(i64, i64)>),
    Delta(Side, i64, i64),
    Trade(i64, i64, Side),
    Place {
        wallet: bool,
        side: Side,
        qty: i64,
        kind: KindSpec,
    },
    /// Cancel the n-th placed order (modulo the number placed so far) under its own account.
    Cancel(usize),
    CancelAll(bool),
}

fn side_strategy() -> impl Strategy<Value = Side> {
    prop_oneof![Just(Side::Buy), Just(Side::Sell)]
}

fn levels_strategy() -> impl Strategy<Value = Vec<(i64, i64)>> {
    prop::collection::vec((1i64..=60, 1i64..=50), 0..8)
}

fn kind_strategy() -> impl Strategy<Value = KindSpec> {
    prop_oneof![
        6 => (1i64..=60).prop_map(KindSpec::Limit),
        2 => Just(KindSpec::Market),
        1 => (1i64..=60).prop_map(KindSpec::Stop),
    ]
}

fn op_strategy() -> impl Strategy<Value = Op> {
    prop_oneof![
        2 => (levels_strategy(), levels_strategy()).prop_map(|(b, a)| Op::Snapshot(b, a)),
        4 => (side_strategy(), 1i64..=60, 0i64..=50).prop_map(|(s, p, q)| Op::Delta(s, p, q)),
        2 => (1i64..=60, 1i64..=50, side_strategy()).prop_map(|(p, q, s)| Op::Trade(p, q, s)),
        6 => (any::<bool>(), side_strategy(), 1i64..=50, kind_strategy())
            .prop_map(|(wallet, side, qty, kind)| Op::Place { wallet, side, qty, kind }),
        1 => (0usize..16).prop_map(Op::Cancel),
        1 => any::<bool>().prop_map(Op::CancelAll),
    ]
}

fn ops_strategy() -> impl Strategy<Value = Vec<Op>> {
    prop::collection::vec(op_strategy(), 0..60)
}

fn account(wallet: bool) -> AccountId {
    AccountId::new(if wallet { "w_a" } else { "guest" }).unwrap()
}

fn levels(raw: &[(i64, i64)]) -> Vec<Level> {
    raw.iter()
        .map(|&(p, q)| Level {
            price: Price(p),
            qty: Qty(q),
        })
        .collect()
}

/// What a run produced: every event in order, and each placed order's (side, kind, qty).
struct Run {
    events: Vec<Event>,
    orders: BTreeMap<String, (Side, OrderKind, i64)>,
}

fn run(ops: &[Op]) -> Run {
    let mut engine = Engine::new();
    let mut events = Vec::new();
    let mut orders = BTreeMap::new();
    // Placed orders in order: (account wallet flag, id).
    let mut placed: Vec<(bool, String)> = Vec::new();
    for (i, op) in ops.iter().enumerate() {
        let ts = (i as TimeMs) + 1_000;
        match op {
            Op::Snapshot(bids, asks) => events.extend(engine.on_market(MarketMsg::BookSnapshot {
                symbol: BTC.into(),
                bids: levels(bids),
                asks: levels(asks),
                ts,
            })),
            Op::Delta(side, price, qty) => events.extend(engine.on_market(MarketMsg::BookDelta {
                symbol: BTC.into(),
                side: *side,
                price: Price(*price),
                qty: Qty(*qty),
                ts,
            })),
            Op::Trade(price, qty, side) => events.extend(engine.on_market(MarketMsg::Trade {
                symbol: BTC.into(),
                price: Price(*price),
                qty: Qty(*qty),
                side: *side,
                ts,
            })),
            Op::Place {
                wallet,
                side,
                qty,
                kind,
            } => {
                let id = format!("o{}", placed.len() + 1);
                let kind = match *kind {
                    KindSpec::Market => OrderKind::Market,
                    KindSpec::Limit(p) => OrderKind::Limit { price: Price(p) },
                    KindSpec::Stop(p) => OrderKind::Stop {
                        stop_price: Price(p),
                    },
                };
                placed.push((*wallet, id.clone()));
                orders.insert(id.clone(), (*side, kind, *qty));
                events.extend(engine.on_command(Command::PlaceOrder {
                    account_id: account(*wallet),
                    order_id: OrderId::new(&id).unwrap(),
                    symbol: BTC.into(),
                    side: *side,
                    qty: Qty(*qty),
                    kind,
                }));
            }
            Op::Cancel(n) => {
                if !placed.is_empty() {
                    let (wallet, id) = &placed[n % placed.len()];
                    events.extend(engine.on_command(Command::Cancel {
                        account_id: account(*wallet),
                        order_id: OrderId::new(id).unwrap(),
                    }));
                }
            }
            Op::CancelAll(wallet) => events.extend(engine.on_command(Command::CancelAll {
                account_id: account(*wallet),
            })),
        }
    }
    Run { events, orders }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    // Property P14 — validates Req 11.10
    #[test]
    fn p14_limit_prices_are_respected(ops in ops_strategy()) {
        let r = run(&ops);
        for ev in &r.events {
            if let Event::Fill { order_id, side, price, .. } = ev {
                let (oside, kind, _) = r.orders.get(order_id.as_str())
                    .ok_or_else(|| TestCaseError::fail("fill for an order that was never placed"))?;
                prop_assert_eq!(side, oside);
                if let OrderKind::Limit { price: limit } = kind {
                    match side {
                        Side::Buy => prop_assert!(price <= limit, "buy fill {:?} above limit {:?}", price, limit),
                        Side::Sell => prop_assert!(price >= limit, "sell fill {:?} below limit {:?}", price, limit),
                    }
                }
            }
        }
    }

    // Property P15 — validates Req 12.5
    #[test]
    fn p15_filled_plus_remaining_equals_original(ops in ops_strategy()) {
        let r = run(&ops);
        // Per order: (cumulative filled, last remaining).
        let mut state: BTreeMap<String, (i64, i64)> = BTreeMap::new();
        for ev in &r.events {
            if let Event::Fill { order_id, qty, remaining, .. } = ev {
                let (_, _, original) = r.orders.get(order_id.as_str())
                    .ok_or_else(|| TestCaseError::fail("fill for an order that was never placed"))?;
                let entry = state.entry(order_id.to_string()).or_insert((0, *original));
                prop_assert!(qty.0 > 0);
                prop_assert!(remaining.0 >= 0, "negative remaining");
                prop_assert!(remaining.0 <= entry.1, "remaining increased");
                entry.0 += qty.0;
                prop_assert_eq!(entry.0 + remaining.0, *original);
                entry.1 = remaining.0;
            }
        }
        for (id, (filled, remaining)) in &state {
            let (_, _, original) = &r.orders[id];
            prop_assert_eq!(filled + remaining, *original);
        }
    }

    // Property P16 — validates Req 12.6
    #[test]
    fn p16_same_inputs_give_identical_events(ops in ops_strategy()) {
        let a = run(&ops);
        let b = run(&ops);
        prop_assert_eq!(a.events, b.events);
    }
}

/// The generators must produce fills, or P14 and P15 would pass vacuously.
#[test]
fn generators_produce_fills() {
    let mut runner = TestRunner::deterministic();
    let strategy = ops_strategy();
    let mut fills = 0usize;
    for _ in 0..100 {
        let ops = strategy.new_tree(&mut runner).unwrap().current();
        fills += run(&ops)
            .events
            .iter()
            .filter(|e| matches!(e, Event::Fill { .. }))
            .count();
    }
    assert!(fills >= 20, "only {fills} fills in 100 generated sequences");
}
