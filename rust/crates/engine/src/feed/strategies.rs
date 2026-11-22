//! proptest strategies for market data and fixture lines.
//!
//! These are engine-local: the protocol crate's strategies are compiled only for its own tests.
//! The `valid_*` strategies produce only values that pass fixture validation: known symbols,
//! positive trade prices and quantities, positive snapshot level quantities, and non-negative
//! delta quantities.

use proptest::collection::vec;
use proptest::prelude::*;
use proptest::sample::select;
use protocol::{INSTRUMENTS, Level, Price, Qty, Side, TimeMs};

use super::MarketMsg;
use super::fixture::FixtureLine;

/// A symbol from the instrument table.
pub fn known_symbol() -> impl Strategy<Value = String> + Clone {
    let symbols: Vec<String> = INSTRUMENTS.iter().map(|i| i.symbol.to_owned()).collect();
    select(symbols)
}

pub fn side() -> impl Strategy<Value = Side> + Clone {
    prop_oneof![Just(Side::Buy), Just(Side::Sell)]
}

/// Any i64, with the extremes and zero drawn more often than a uniform draw would.
pub fn any_i64() -> impl Strategy<Value = i64> + Clone {
    prop_oneof![
        4 => any::<i64>(),
        1 => select(vec![i64::MIN, -1, 0, 1, i64::MAX]),
    ]
}

/// An i64 from 1 to `i64::MAX`, with both ends drawn more often.
pub fn positive_i64() -> impl Strategy<Value = i64> + Clone {
    prop_oneof![4 => 1..=i64::MAX, 1 => select(vec![1, i64::MAX])]
}

/// An i64 from 0 to `i64::MAX`, with both ends drawn more often.
pub fn non_negative_i64() -> impl Strategy<Value = i64> + Clone {
    prop_oneof![4 => 0..=i64::MAX, 1 => select(vec![0, i64::MAX])]
}

pub fn any_time() -> impl Strategy<Value = TimeMs> + Clone {
    any_i64()
}

/// A book level with a positive quantity.
pub fn valid_level() -> impl Strategy<Value = Level> + Clone {
    (any_i64(), positive_i64()).prop_map(|(price, qty)| Level {
        price: Price(price),
        qty: Qty(qty),
    })
}

/// Every [`MarketMsg`] variant with field values that pass fixture validation.
pub fn valid_market_msg() -> impl Strategy<Value = MarketMsg> + Clone {
    prop_oneof![
        (
            known_symbol(),
            positive_i64(),
            positive_i64(),
            side(),
            any_time()
        )
            .prop_map(|(symbol, price, qty, side, ts)| MarketMsg::Trade {
                venue: protocol::Venue::Replay,
                symbol,
                price: Price(price),
                qty: Qty(qty),
                side,
                ts,
            }),
        (
            known_symbol(),
            vec(valid_level(), 0..8),
            vec(valid_level(), 0..8),
            any_time()
        )
            .prop_map(|(symbol, bids, asks, ts)| MarketMsg::BookSnapshot {
                venue: protocol::Venue::Replay,
                symbol,
                bids,
                asks,
                ts,
            }),
        (
            known_symbol(),
            side(),
            any_i64(),
            non_negative_i64(),
            any_time()
        )
            .prop_map(|(symbol, side, price, qty, ts)| MarketMsg::BookDelta {
                venue: protocol::Venue::Replay,
                symbol,
                side,
                price: Price(price),
                qty: Qty(qty),
                ts,
            }),
    ]
}

/// A fixture line that passes per-line validation.
pub fn valid_fixture_line() -> impl Strategy<Value = FixtureLine> + Clone {
    (any_time(), valid_market_msg()).prop_map(|(recv, msg)| FixtureLine { recv, msg })
}
