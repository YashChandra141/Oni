//! Property P28 (Task 10.4) and unit tests for Paper_Account isolation (Req 14.1, 14.3, 14.5,
//! 14.6, 14.7, 14.8, 14.9).
//!
//! # How P28 is defined
//!
//! Req 14.9 says that each account's OrderAck, OrderRejected, Fill and Position events equal the
//! events of a solo run of that account's Commands against the same market data. Read literally
//! this is false in one case. The matcher walks all open orders of a symbol in acceptance order
//! during one market-driven pass and shares one consumed-quantity overlay across accounts
//! (matcher.rs, Decision A9). When two accounts have resting orders that want the same displayed
//! quantity, the earlier order takes it and the later one gets less, so its fills differ from a
//! solo run. [`contested_liquidity_is_the_documented_boundary`] shows this.
//!
//! The property is therefore stated for the case where accounts do not compete: the generated
//! book is deep. Every level holds at least [`BIG`] lots (the snapshot, and every delta, which
//! only sets quantities in `BIG..=2*BIG`), deltas never cross the book and never remove a level,
//! and the whole sequence places at most 80 orders of at most 1,000 lots each. The overlay can
//! then never exhaust a level, so every fill equals what the order would get alone. Under that
//! condition P28 asserts, for 2 to 5 accounts and a random interleaving of market data, market,
//! limit and stop orders, cancels of own, foreign and unknown order ids, CancelAll and
//! ResetAccount:
//! 1. each account's events in the interleaved run equal the events of a solo engine that got
//!    the same market data and only that account's Commands (a foreign cancel stays in the
//!    requester's list, and is `unknown_order` in both runs);
//! 2. after every Command, every other account's open orders and Paper_Account are unchanged,
//!    and every event the Command returns belongs to the requesting account (so foreign cancels
//!    and ResetAccount never touch or notify another account);
//! 3. at the end, each account's Paper_Account and open orders equal the solo results.
//!
//! Account events are compared; market events (Trade, Candle, Book, ...) do not depend on
//! orders and are not part of the property. The property runs 256 cases.

use std::collections::BTreeMap;

use proptest::collection::vec;
use proptest::prelude::*;
use protocol::{
    AccountId, Command, Event, INSTRUMENTS, Level, OrderId, OrderKind, OrderStatus, Price, Qty,
    Side, TimeMs,
};

use super::Engine;
use crate::account::PaperAccount;
use crate::feed::MarketMsg;
use crate::matcher::Order;

const BTC: &str = "BTC-USD";
const SYMBOLS: [&str; 2] = [BTC, "ETH-USD"];
const NAMES: [&str; 5] = ["guest", "w_a", "w_b", "w_c", "w_d"];
/// Minimum quantity of every book level in the property, in lots.
const BIG: i64 = 1_000_000_000;

fn acct(s: &str) -> AccountId {
    AccountId::new(s).unwrap()
}

fn oid(s: &str) -> OrderId {
    OrderId::new(s).unwrap()
}

fn lv(price: i64, qty: i64) -> Level {
    Level {
        price: Price(price),
        qty: Qty(qty),
    }
}

/// The account an account event belongs to; `None` for market and engine events.
fn account_of(event: &Event) -> Option<&AccountId> {
    match event {
        Event::OrderAck { account_id, .. }
        | Event::OrderRejected { account_id, .. }
        | Event::Fill { account_id, .. }
        | Event::Position { account_id, .. } => Some(account_id),
        _ => None,
    }
}

fn command_account(cmd: &Command) -> Option<&AccountId> {
    match cmd {
        Command::PlaceOrder { account_id, .. }
        | Command::Cancel { account_id, .. }
        | Command::CancelAll { account_id }
        | Command::ResetAccount { account_id } => Some(account_id),
        _ => None,
    }
}

/// A deep book: five bid levels below 100,000 ticks and five ask levels above, `BIG` lots each.
fn deep_snapshot(symbol: &str, ts: TimeMs) -> MarketMsg {
    MarketMsg::BookSnapshot {
        symbol: symbol.into(),
        bids: (0..5).map(|i| lv(99_000 - i * 1_000, BIG)).collect(),
        asks: (0..5).map(|i| lv(101_000 + i * 1_000, BIG)).collect(),
        ts,
    }
}

// ---------------------------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
enum Kind {
    Market,
    Limit(i64),
    Stop(i64),
}

/// One abstract step. Account indexes are taken modulo the case's account count.
#[derive(Debug, Clone)]
enum Step {
    Trade {
        symbol: usize,
        price: i64,
        qty: i64,
        side: Side,
        gap: i64,
    },
    BidDelta {
        symbol: usize,
        price: i64,
        qty: i64,
        gap: i64,
    },
    AskDelta {
        symbol: usize,
        price: i64,
        qty: i64,
        gap: i64,
    },
    Place {
        acct: usize,
        symbol: usize,
        side: Side,
        qty: i64,
        kind: Kind,
    },
    CancelOwn {
        acct: usize,
        pick: usize,
    },
    CancelForeign {
        acct: usize,
        pick: usize,
    },
    CancelUnknown {
        acct: usize,
    },
    CancelAll {
        acct: usize,
    },
    Reset {
        acct: usize,
    },
}

fn side() -> impl Strategy<Value = Side> {
    any::<bool>().prop_map(|b| if b { Side::Buy } else { Side::Sell })
}

fn kind() -> impl Strategy<Value = Kind> {
    prop_oneof![
        2 => Just(Kind::Market),
        2 => (94_000..=106_000_i64).prop_map(Kind::Limit),
        1 => (94_000..=106_000_i64).prop_map(Kind::Stop),
    ]
}

fn step() -> impl Strategy<Value = Step> {
    prop_oneof![
        3 => (0..2usize, 94_000..=106_000_i64, 1..=100_i64, side(), 1..=300_i64).prop_map(
            |(symbol, price, qty, side, gap)| Step::Trade { symbol, price, qty, side, gap }
        ),
        1 => (0..2usize, 94_000..=99_500_i64, BIG..=2 * BIG, 1..=300_i64).prop_map(
            |(symbol, price, qty, gap)| Step::BidDelta { symbol, price, qty, gap }
        ),
        1 => (0..2usize, 100_500..=106_000_i64, BIG..=2 * BIG, 1..=300_i64).prop_map(
            |(symbol, price, qty, gap)| Step::AskDelta { symbol, price, qty, gap }
        ),
        6 => (0..5usize, 0..2usize, side(), 1..=1_000_i64, kind()).prop_map(
            |(acct, symbol, side, qty, kind)| Step::Place { acct, symbol, side, qty, kind }
        ),
        2 => (0..5usize, any::<usize>()).prop_map(|(acct, pick)| Step::CancelOwn { acct, pick }),
        2 => (0..5usize, any::<usize>())
            .prop_map(|(acct, pick)| Step::CancelForeign { acct, pick }),
        1 => (0..5usize).prop_map(|acct| Step::CancelUnknown { acct }),
        1 => (0..5usize).prop_map(|acct| Step::CancelAll { acct }),
        1 => (0..5usize).prop_map(|acct| Step::Reset { acct }),
    ]
}

/// One engine input, in arrival order.
#[derive(Debug, Clone)]
enum Input {
    Market(MarketMsg),
    Command(Command),
}

/// Turns abstract steps into concrete inputs for `n` accounts: two deep snapshots first, then
/// the steps with growing market time. Order ids are `<account>-<n>`, unique across accounts.
/// Foreign cancels pick an id issued to another account (it may already be filled or canceled);
/// with no such id they fall back to an unknown id.
fn resolve(steps: &[Step], n: usize) -> Vec<Input> {
    let mut ts: TimeMs = 1_000_000;
    let mut inputs: Vec<Input> = SYMBOLS
        .iter()
        .map(|symbol| Input::Market(deep_snapshot(symbol, ts)))
        .collect();
    let mut issued: Vec<Vec<OrderId>> = vec![Vec::new(); n];
    let mut counter = vec![0_u32; n];
    let mut ghosts = 0_u32;
    for step in steps {
        match step {
            Step::Trade {
                symbol,
                price,
                qty,
                side,
                gap,
            } => {
                ts += gap;
                inputs.push(Input::Market(MarketMsg::Trade {
                    symbol: SYMBOLS[symbol % 2].into(),
                    price: Price(*price),
                    qty: Qty(*qty),
                    side: *side,
                    ts,
                }));
            }
            Step::BidDelta {
                symbol,
                price,
                qty,
                gap,
            }
            | Step::AskDelta {
                symbol,
                price,
                qty,
                gap,
            } => {
                ts += gap;
                let side = if matches!(step, Step::BidDelta { .. }) {
                    Side::Buy
                } else {
                    Side::Sell
                };
                inputs.push(Input::Market(MarketMsg::BookDelta {
                    symbol: SYMBOLS[symbol % 2].into(),
                    side,
                    price: Price(*price),
                    qty: Qty(*qty),
                    ts,
                }));
            }
            Step::Place {
                acct: a,
                symbol,
                side,
                qty,
                kind,
            } => {
                let a = a % n;
                let id = oid(&format!("{}-{}", NAMES[a], counter[a]));
                counter[a] += 1;
                issued[a].push(id.clone());
                let kind = match kind {
                    Kind::Market => OrderKind::Market,
                    Kind::Limit(p) => OrderKind::Limit { price: Price(*p) },
                    Kind::Stop(p) => OrderKind::Stop {
                        stop_price: Price(*p),
                    },
                };
                inputs.push(Input::Command(Command::PlaceOrder {
                    account_id: acct(NAMES[a]),
                    order_id: id,
                    symbol: SYMBOLS[symbol % 2].into(),
                    side: *side,
                    qty: Qty(*qty),
                    kind,
                }));
            }
            Step::CancelOwn { acct: a, pick } => {
                let a = a % n;
                let id = match issued[a].len() {
                    0 => ghost(&mut ghosts),
                    len => issued[a][pick % len].clone(),
                };
                inputs.push(Input::Command(Command::Cancel {
                    account_id: acct(NAMES[a]),
                    order_id: id,
                }));
            }
            Step::CancelForeign { acct: a, pick } => {
                let a = a % n;
                let foreign: Vec<&OrderId> = issued
                    .iter()
                    .enumerate()
                    .filter(|(i, _)| *i != a)
                    .flat_map(|(_, ids)| ids.iter())
                    .collect();
                let id = match foreign.len() {
                    0 => ghost(&mut ghosts),
                    len => foreign[pick % len].clone(),
                };
                inputs.push(Input::Command(Command::Cancel {
                    account_id: acct(NAMES[a]),
                    order_id: id,
                }));
            }
            Step::CancelUnknown { acct: a } => {
                let a = a % n;
                inputs.push(Input::Command(Command::Cancel {
                    account_id: acct(NAMES[a]),
                    order_id: ghost(&mut ghosts),
                }));
            }
            Step::CancelAll { acct: a } => {
                inputs.push(Input::Command(Command::CancelAll {
                    account_id: acct(NAMES[a % n]),
                }));
            }
            Step::Reset { acct: a } => {
                inputs.push(Input::Command(Command::ResetAccount {
                    account_id: acct(NAMES[a % n]),
                }));
            }
        }
    }
    inputs
}

fn ghost(counter: &mut u32) -> OrderId {
    *counter += 1;
    oid(&format!("ghost-{counter}"))
}

// ---------------------------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------------------------

/// Open orders and Paper_Account of every account except `except`.
type OthersState = Vec<(AccountId, Vec<Order>, Option<PaperAccount>)>;

fn others_state(engine: &Engine, ids: &[AccountId], except: &AccountId) -> OthersState {
    ids.iter()
        .filter(|id| *id != except)
        .map(|id| {
            (
                id.clone(),
                engine.matcher.open_orders_for(id).cloned().collect(),
                engine.accounts.get(id).cloned(),
            )
        })
        .collect()
}

/// Open orders of one account without the acceptance sequence number, which differs between an
/// interleaved and a solo run.
fn open_summary(engine: &Engine, id: &AccountId) -> Vec<(String, String, i64, bool)> {
    engine
        .matcher
        .open_orders_for(id)
        .map(|o| {
            (
                o.order_id.as_str().to_owned(),
                o.symbol.clone(),
                o.remaining_qty,
                o.stop_triggered,
            )
        })
        .collect()
}

/// Runs every input through one engine. After each Command it checks claim 2 of the property.
/// Returns the engine and the account events by account.
fn run_interleaved(
    inputs: &[Input],
    ids: &[AccountId],
) -> Result<(Engine, BTreeMap<AccountId, Vec<Event>>), TestCaseError> {
    let mut engine = Engine::new();
    let mut per: BTreeMap<AccountId, Vec<Event>> = BTreeMap::new();
    for input in inputs {
        let events = match input {
            Input::Market(msg) => engine.on_market(msg.clone()),
            Input::Command(cmd) => {
                let who = command_account(cmd).cloned();
                let before = who.as_ref().map(|w| others_state(&engine, ids, w));
                let events = engine.on_command(cmd.clone());
                if let (Some(who), Some(before)) = (who, before) {
                    prop_assert_eq!(
                        &before,
                        &others_state(&engine, ids, &who),
                        "command of {} changed another account: {:?}",
                        who,
                        cmd
                    );
                    for event in &events {
                        prop_assert!(
                            account_of(event).is_none_or(|a| a == &who),
                            "command of {} produced an event of another account: {:?}",
                            who,
                            event
                        );
                    }
                }
                events
            }
        };
        for event in events {
            if let Some(id) = account_of(&event).cloned() {
                per.entry(id).or_default().push(event);
            }
        }
    }
    Ok((engine, per))
}

/// Runs the market data and only `id`'s Commands through a fresh engine.
fn run_solo(inputs: &[Input], id: &AccountId) -> (Vec<Event>, Engine) {
    let mut engine = Engine::new();
    let mut out = Vec::new();
    for input in inputs {
        let events = match input {
            Input::Market(msg) => engine.on_market(msg.clone()),
            Input::Command(cmd) if command_account(cmd) == Some(id) => {
                engine.on_command(cmd.clone())
            }
            Input::Command(_) => continue,
        };
        out.extend(events.into_iter().filter(|e| account_of(e) == Some(id)));
    }
    (out, engine)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    // Property P28 — validates Req 14.1, 14.5, 14.6, 14.7, 14.9
    #[test]
    fn p28_account_events_equal_a_solo_run(
        n in 2..=5usize,
        steps in vec(step(), 1..80),
    ) {
        let ids: Vec<AccountId> = NAMES[..n].iter().map(|s| acct(s)).collect();
        let inputs = resolve(&steps, n);
        let (engine, per) = run_interleaved(&inputs, &ids)?;
        for id in &ids {
            let (solo_events, solo) = run_solo(&inputs, id);
            let got = per.get(id).cloned().unwrap_or_default();
            prop_assert_eq!(&got, &solo_events, "events of {}", id);
            prop_assert_eq!(
                engine.accounts.get(id),
                solo.accounts.get(id),
                "paper account of {}",
                id
            );
            prop_assert_eq!(
                open_summary(&engine, id),
                open_summary(&solo, id),
                "open orders of {}",
                id
            );
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------------------------

fn place(
    engine: &mut Engine,
    account: &str,
    id: &str,
    side: Side,
    qty: i64,
    kind: OrderKind,
) -> Vec<Event> {
    engine.on_command(Command::PlaceOrder {
        account_id: acct(account),
        order_id: oid(id),
        symbol: BTC.into(),
        side,
        qty: Qty(qty),
        kind,
    })
}

/// A buy limit far below the book: it rests and produces only the accepted ack.
fn rest(engine: &mut Engine, account: &str, id: &str) -> Vec<Event> {
    place(
        engine,
        account,
        id,
        Side::Buy,
        2,
        OrderKind::Limit {
            price: Price(50_000),
        },
    )
}

fn market_buy(engine: &mut Engine, account: &str, id: &str, qty: i64) -> Vec<Event> {
    place(engine, account, id, Side::Buy, qty, OrderKind::Market)
}

fn cancel(account: &str, id: &str) -> Command {
    Command::Cancel {
        account_id: acct(account),
        order_id: oid(id),
    }
}

fn ack(account: &str, id: &str, status: OrderStatus) -> Event {
    Event::OrderAck {
        account_id: acct(account),
        order_id: oid(id),
        status,
    }
}

fn rejected(account: &str, id: &str, reason: &str) -> Event {
    Event::OrderRejected {
        account_id: acct(account),
        order_id: oid(id),
        reason: reason.into(),
    }
}

fn fills_of(events: &[Event], account: &str) -> Vec<(i64, i64)> {
    let account = acct(account);
    events
        .iter()
        .filter_map(|e| match e {
            Event::Fill {
                account_id,
                price,
                qty,
                ..
            } if account_id == &account => Some((price.0, qty.0)),
            _ => None,
        })
        .collect()
}

/// Req 14.5: with a cap of 2, the third new account is refused with `account_limit`.
#[test]
fn account_limit_refuses_the_third_new_account() {
    let mut e = Engine::with_account_cap(2);
    e.on_market(deep_snapshot(BTC, 1_000));

    // Cancel and ResetAccount of accounts that do not exist create nothing and use no slot.
    assert_eq!(
        e.on_command(cancel("w_x", "nope-1")),
        [rejected("w_x", "nope-1", "unknown_order")]
    );
    let reset = e.on_command(Command::ResetAccount {
        account_id: acct("w_y"),
    });
    assert_eq!(reset.len(), INSTRUMENTS.len());
    assert_eq!(e.accounts.len(), 0);

    assert_eq!(
        rest(&mut e, "w_a", "a-1"),
        [ack("w_a", "a-1", OrderStatus::Accepted)]
    );
    assert_eq!(
        rest(&mut e, "w_b", "b-1"),
        [ack("w_b", "b-1", OrderStatus::Accepted)]
    );
    assert_eq!(e.accounts.len(), 2);

    // The third new account is refused, is not created, and its order is not placed.
    assert_eq!(
        rest(&mut e, "w_c", "c-1"),
        [rejected("w_c", "c-1", "account_limit")]
    );
    assert_eq!(e.accounts.len(), 2);
    assert!(e.accounts.get(&acct("w_c")).is_none());
    assert_eq!(e.matcher.open_count(), 2);

    // Existing accounts keep trading.
    assert_eq!(
        rest(&mut e, "w_a", "a-2"),
        [ack("w_a", "a-2", OrderStatus::Accepted)]
    );
    assert_eq!(e.matcher.open_count(), 3);
    // The refused account can still cancel (unknown order) without being created.
    assert_eq!(
        e.on_command(cancel("w_c", "c-1")),
        [rejected("w_c", "c-1", "unknown_order")]
    );
    assert_eq!(e.accounts.len(), 2);
}

/// Req 14.3, 14.5, 14.6: ResetAccount of A touches only A, and B's cancel of A's order fails.
#[test]
fn reset_of_one_account_leaves_the_other_unchanged() {
    let mut e = Engine::new();
    e.on_market(deep_snapshot(BTC, 1_000));
    market_buy(&mut e, "w_a", "a-1", 3);
    market_buy(&mut e, "w_b", "b-1", 4);
    rest(&mut e, "w_a", "a-2");
    rest(&mut e, "w_b", "b-2");
    let b = acct("w_b");
    assert_eq!(e.accounts.get(&b).unwrap().position(BTC).qty, 4);

    // B cannot cancel A's order (Req 14.6), and the order stays open.
    assert_eq!(
        e.on_command(cancel("w_b", "a-2")),
        [rejected("w_b", "a-2", "unknown_order")]
    );
    assert_eq!(e.matcher.open_orders_for(&acct("w_a")).count(), 1);

    let b_account = e.accounts.get(&b).cloned();
    let b_orders: Vec<Order> = e.matcher.open_orders_for(&b).cloned().collect();
    let events = e.on_command(Command::ResetAccount {
        account_id: acct("w_a"),
    });

    // Only A's cancel ack and one flat Position per symbol, all for A.
    assert_eq!(events.len(), 1 + INSTRUMENTS.len());
    assert_eq!(events[0], ack("w_a", "a-2", OrderStatus::Canceled));
    let a = acct("w_a");
    for event in &events[1..] {
        assert!(
            matches!(
                event,
                Event::Position { account_id, qty: Qty(0), avg_entry: None, .. }
                    if account_id == &a
            ),
            "{event:?}"
        );
    }
    assert_eq!(e.accounts.get(&a).unwrap().position(BTC).qty, 0);
    assert_eq!(e.matcher.open_orders_for(&a).count(), 0);
    // B: same positions and same open orders.
    assert_eq!(e.accounts.get(&b).cloned(), b_account);
    let b_after: Vec<Order> = e.matcher.open_orders_for(&b).cloned().collect();
    assert_eq!(b_after, b_orders);
    assert_eq!(b_after.len(), 1);
}

/// Req 11.9, 14.6: a Cancel for an unknown order, from an unknown account, is an OrderRejected
/// for the requester and creates no account.
#[test]
fn cancel_from_an_unknown_account_is_rejected() {
    let mut e = Engine::new();
    assert_eq!(
        e.on_command(cancel("w_ghost", "nope-1")),
        [Event::OrderRejected {
            account_id: acct("w_ghost"),
            order_id: oid("nope-1"),
            reason: "unknown_order".into(),
        }]
    );
    assert_eq!(e.accounts.len(), 0);
}

/// Req 14.7: CancelAll of A removes only A's orders.
#[test]
fn cancel_all_removes_only_the_requesters_orders() {
    let mut e = Engine::new();
    e.on_market(deep_snapshot(BTC, 1_000));
    rest(&mut e, "w_a", "a-1");
    rest(&mut e, "w_b", "b-1");
    rest(&mut e, "w_a", "a-2");
    let events = e.on_command(Command::CancelAll {
        account_id: acct("w_a"),
    });
    assert_eq!(
        events,
        [
            ack("w_a", "a-1", OrderStatus::Canceled),
            ack("w_a", "a-2", OrderStatus::Canceled)
        ]
    );
    assert_eq!(e.matcher.open_orders_for(&acct("w_a")).count(), 0);
    assert_eq!(e.matcher.open_orders_for(&acct("w_b")).count(), 1);
    // B's order is still cancelable by B.
    assert_eq!(
        e.on_command(cancel("w_b", "b-1")),
        [ack("w_b", "b-1", OrderStatus::Canceled)]
    );
}

/// Req 14.8: fills settle against accounts only; the market book is unchanged.
#[test]
fn fills_never_change_the_market_book() {
    let mut e = Engine::new();
    e.on_market(deep_snapshot(BTC, 1_000));
    let before = e.books.get(BTC).unwrap().book.clone();

    // Immediate fills from two accounts.
    let a = market_buy(&mut e, "w_a", "a-1", 500_000);
    let b = place(&mut e, "w_b", "b-1", Side::Sell, 700_000, OrderKind::Market);
    assert!(!fills_of(&a, "w_a").is_empty());
    assert!(!fills_of(&b, "w_b").is_empty());
    assert_eq!(e.books.get(BTC).unwrap().book, before);

    // A resting order that fills in a market-driven pass.
    place(
        &mut e,
        "w_a",
        "a-2",
        Side::Buy,
        10,
        OrderKind::Limit {
            price: Price(50_000),
        },
    );
    let events = e.on_market(MarketMsg::Trade {
        symbol: BTC.into(),
        price: Price(100_000),
        qty: Qty(1),
        side: Side::Sell,
        ts: 2_000,
    });
    assert!(events.iter().all(|ev| !matches!(ev, Event::Fill { .. })));
    assert_eq!(e.books.get(BTC).unwrap().book, before);
}

/// The boundary of Req 14.9 (see the module comment). Two accounts have market buys resting
/// against an empty ask side. When asks of 5 lots appear, one pass serves the orders in
/// acceptance order and shares the displayed quantity: the earlier order takes all 5 lots and
/// the later one gets nothing, while a solo run of the later account would get 5. Orders placed
/// one after another each see the full displayed quantity (the overlay lives for one pass), so
/// the effect appears only for orders that rest and are matched together.
#[test]
fn contested_liquidity_is_the_documented_boundary() {
    let empty_asks = || MarketMsg::BookSnapshot {
        symbol: BTC.into(),
        bids: vec![lv(99_000, 10)],
        asks: Vec::new(),
        ts: 1_000,
    };
    let thin_asks = || MarketMsg::BookSnapshot {
        symbol: BTC.into(),
        bids: vec![lv(99_000, 10)],
        asks: vec![lv(100_000, 5)],
        ts: 1_200,
    };

    // Both orders rest, then one pass serves them in order: w_a first.
    let mut both = Engine::new();
    both.on_market(empty_asks());
    assert_eq!(
        market_buy(&mut both, "w_a", "a-1", 5),
        [ack("w_a", "a-1", OrderStatus::Accepted)]
    );
    assert_eq!(
        market_buy(&mut both, "w_b", "b-1", 5),
        [ack("w_b", "b-1", OrderStatus::Accepted)]
    );
    let pass = both.on_market(thin_asks());
    assert_eq!(fills_of(&pass, "w_a"), vec![(100_000_i64, 5_i64)]);
    assert!(fills_of(&pass, "w_b").is_empty());
    assert_eq!(both.matcher.open_orders_for(&acct("w_b")).count(), 1);

    // Solo run of w_b: it gets the 5 lots. So the two runs differ when liquidity is contested.
    let mut solo = Engine::new();
    solo.on_market(empty_asks());
    market_buy(&mut solo, "w_b", "b-1", 5);
    let solo_pass = solo.on_market(thin_asks());
    assert_eq!(fills_of(&solo_pass, "w_b"), vec![(100_000_i64, 5_i64)]);

    // Orders placed one after another do not contest: each place call starts a fresh overlay.
    let mut seq = Engine::new();
    seq.on_market(thin_asks());
    let first = market_buy(&mut seq, "w_a", "a-1", 5);
    let second = market_buy(&mut seq, "w_b", "b-1", 5);
    assert_eq!(fills_of(&first, "w_a"), vec![(100_000_i64, 5_i64)]);
    assert_eq!(fills_of(&second, "w_b"), vec![(100_000_i64, 5_i64)]);
}
