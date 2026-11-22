//! Normalized market data (design §2 "Core"). The replay feed and the live Coinbase adapter both
//! produce [`MarketMsg`] values, so the engine core handles a single format (Req 7).

pub mod allowlist;
#[cfg(test)]
mod allowlist_properties;
pub mod backfill;
pub mod backpack;
pub mod backpack_parse;
pub mod coinbase;
pub mod coinbase_parse;
pub mod fixture;
pub mod http;
pub mod jupiter;
pub mod raydium;
pub mod replay;
#[cfg(test)]
mod safety_preservation_tests;
#[cfg(test)]
pub(crate) mod strategies;
pub mod synth;
#[cfg(test)]
pub(crate) mod test_ws;
pub mod venue;

use protocol::{Level, Price, Qty, Side, TimeMs, Venue, VenueStatusKind};
use serde::{Deserialize, Serialize};

/// Serde helper: a `Replay` venue is left out of the JSON, so fixture lines stay unchanged.
fn is_replay(venue: &Venue) -> bool {
    *venue == Venue::Replay
}

/// One market data message for one symbol of one venue.
///
/// Engine-internal: it appears only inside the engine and in fixture files, so it has no
/// TypeScript export. It is internally tagged like the protocol messages, and prices and
/// quantities are decimal strings, e.g.
/// `{"type":"trade","symbol":"BTC-USD","price":"6400000","qty":"1000","side":"buy","ts":1}`.
/// `ts` is the exchange time in epoch ms. `venue` defaults to `replay` when absent, so fixture
/// lines written before multi-venue support still parse, and it is written only when it is not
/// `replay`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MarketMsg {
    /// A trade print. `side` is the aggressor side.
    Trade {
        #[serde(default, skip_serializing_if = "is_replay")]
        venue: Venue,
        symbol: String,
        price: Price,
        qty: Qty,
        side: Side,
        ts: TimeMs,
    },
    /// Every price level of one symbol's book. It replaces the previous levels (Req 9.1).
    BookSnapshot {
        #[serde(default, skip_serializing_if = "is_replay")]
        venue: Venue,
        symbol: String,
        bids: Vec<Level>,
        asks: Vec<Level>,
        ts: TimeMs,
    },
    /// A change to one price level. `buy` is the bid side and `sell` the ask side. A zero `qty`
    /// removes the level (Req 9.2, 9.3).
    BookDelta {
        #[serde(default, skip_serializing_if = "is_replay")]
        venue: Venue,
        symbol: String,
        side: Side,
        price: Price,
        qty: Qty,
        ts: TimeMs,
    },
    /// A DEX price observation (Jupiter or Raydium): a price with no depth. The DEX adapters
    /// send this; turning it into candles and a Synthetic_Book is task 6.9.
    PriceSample {
        #[serde(default, skip_serializing_if = "is_replay")]
        venue: Venue,
        symbol: String,
        price: Price,
        ts: TimeMs,
    },
    /// A venue changed connection state (task 6.2). Never in fixtures.
    Status {
        #[serde(default, skip_serializing_if = "is_replay")]
        venue: Venue,
        status: VenueStatusKind,
        ts: TimeMs,
    },
    /// The runtime's once-a-second wall-clock tick; the core derives staleness from it
    /// (design D6). Never in fixtures.
    Clock { ts: TimeMs },
}

impl MarketMsg {
    /// The venue the message comes from. A `Clock` belongs to no venue and reports `Replay`.
    pub fn venue(&self) -> Venue {
        match self {
            Self::Trade { venue, .. }
            | Self::BookSnapshot { venue, .. }
            | Self::BookDelta { venue, .. }
            | Self::PriceSample { venue, .. }
            | Self::Status { venue, .. } => *venue,
            Self::Clock { .. } => Venue::Replay,
        }
    }

    /// The same message tagged with `venue`.
    pub fn with_venue(mut self, new_venue: Venue) -> Self {
        match &mut self {
            Self::Trade { venue, .. }
            | Self::BookSnapshot { venue, .. }
            | Self::BookDelta { venue, .. }
            | Self::PriceSample { venue, .. }
            | Self::Status { venue, .. } => *venue = new_venue,
            Self::Clock { .. } => {}
        }
        self
    }

    /// The symbol the message is about; empty for `Status` and `Clock`.
    pub fn symbol(&self) -> &str {
        match self {
            Self::Trade { symbol, .. }
            | Self::BookSnapshot { symbol, .. }
            | Self::BookDelta { symbol, .. }
            | Self::PriceSample { symbol, .. } => symbol,
            Self::Status { .. } | Self::Clock { .. } => "",
        }
    }

    /// The exchange time of the message, in epoch ms.
    // Only tests call this so far; the candle builder and order book (Tasks 4.4, 8.1) will.
    #[allow(dead_code)]
    pub fn ts(&self) -> TimeMs {
        match self {
            Self::Trade { ts, .. }
            | Self::BookSnapshot { ts, .. }
            | Self::BookDelta { ts, .. }
            | Self::PriceSample { ts, .. }
            | Self::Status { ts, .. }
            | Self::Clock { ts } => *ts,
        }
    }

    /// The same message with `ts` moved by `offset` ms, or `None` if that overflows. Replay
    /// uses it to shift each loop of a fixture forward in market time.
    pub fn shifted(mut self, offset: TimeMs) -> Option<Self> {
        match &mut self {
            Self::Trade { ts, .. }
            | Self::BookSnapshot { ts, .. }
            | Self::BookDelta { ts, .. }
            | Self::PriceSample { ts, .. }
            | Self::Status { ts, .. }
            | Self::Clock { ts } => {
                *ts = ts.checked_add(offset)?;
            }
        }
        Some(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trade() -> MarketMsg {
        MarketMsg::Trade {
            venue: protocol::Venue::Replay,
            symbol: "BTC-USD".into(),
            price: Price(6_400_000),
            qty: Qty(1_000),
            side: Side::Buy,
            ts: 1,
        }
    }

    fn snapshot() -> MarketMsg {
        MarketMsg::BookSnapshot {
            venue: protocol::Venue::Replay,
            symbol: "ETH-USD".into(),
            bids: vec![Level {
                price: Price(99),
                qty: Qty(5),
            }],
            asks: Vec::new(),
            ts: 2,
        }
    }

    fn delta() -> MarketMsg {
        MarketMsg::BookDelta {
            venue: protocol::Venue::Replay,
            symbol: "SOL-USD".into(),
            side: Side::Sell,
            price: Price(101),
            qty: Qty(0),
            ts: 3,
        }
    }

    #[test]
    fn wire_format_is_internally_tagged_snake_case() {
        let cases = [
            (
                trade(),
                r#"{"type":"trade","symbol":"BTC-USD","price":"6400000","qty":"1000","side":"buy","ts":1}"#,
            ),
            (
                snapshot(),
                r#"{"type":"book_snapshot","symbol":"ETH-USD","bids":[{"price":"99","qty":"5"}],"asks":[],"ts":2}"#,
            ),
            (
                delta(),
                r#"{"type":"book_delta","symbol":"SOL-USD","side":"sell","price":"101","qty":"0","ts":3}"#,
            ),
        ];
        for (msg, json) in cases {
            assert_eq!(serde_json::to_string(&msg).unwrap(), json);
            assert_eq!(serde_json::from_str::<MarketMsg>(json).unwrap(), msg);
        }
    }

    #[test]
    fn rejects_unknown_tags_and_numeric_prices() {
        for json in [
            r#"{"type":"Trade","symbol":"BTC-USD","price":"1","qty":"1","side":"buy","ts":1}"#,
            r#"{"type":"trade","symbol":"BTC-USD","price":1,"qty":"1","side":"buy","ts":1}"#,
            r#"{"type":"book_delta","symbol":"BTC-USD","side":"bid","price":"1","qty":"1","ts":1}"#,
        ] {
            assert!(serde_json::from_str::<MarketMsg>(json).is_err(), "{json}");
        }
    }

    #[test]
    fn accessors_return_symbol_and_ts() {
        let expected = [("BTC-USD", 1), ("ETH-USD", 2), ("SOL-USD", 3)];
        for (msg, (symbol, ts)) in [trade(), snapshot(), delta()].iter().zip(expected) {
            assert_eq!(msg.symbol(), symbol);
            assert_eq!(msg.ts(), ts);
        }
    }

    #[test]
    fn shifted_moves_only_ts_and_refuses_overflow() {
        for msg in [trade(), snapshot(), delta()] {
            let moved = msg.clone().shifted(1_000).unwrap();
            assert_eq!(moved.ts(), msg.ts() + 1_000);
            assert_eq!(moved.symbol(), msg.symbol());
            assert_eq!(moved.shifted(-1_000), Some(msg.clone()));
            assert_eq!(msg.shifted(TimeMs::MAX), None);
        }
    }
}

#[cfg(test)]
mod adapter_tests;
