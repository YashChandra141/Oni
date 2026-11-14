//! Engine Events: messages from the engine to the server (Req 1.2).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::num::{Money, Price, Qty};
use crate::types::{AccountId, OrderId, Side, TimeMs, Timeframe};

/// A message written by the engine to stdout, one JSON line each.
///
/// On the wire: `{"type":"heartbeat","ts":1733200000000}`. The account Events (`order_ack`,
/// `order_rejected`, `fill`, `position`) carry the `account_id` of the Paper_Account they belong
/// to, so the server can route them to that account's connections only (Req 1.9, 17.7).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export, export_to = crate::TS_EXPORT_DIR)]
pub enum Event {
    /// Candles for one subscription. `snapshot: true` carries up to 500 history bars and comes
    /// before any live update; live updates carry the single changed bar (Req 8.7, 8.8).
    Candle {
        symbol: String,
        timeframe: Timeframe,
        snapshot: bool,
        bars: Vec<Bar>,
    },
    /// One market trade (Req 9.8). `side` is the aggressor side.
    Trade {
        symbol: String,
        price: Price,
        qty: Qty,
        side: Side,
        #[ts(type = "number")]
        ts: TimeMs,
    },
    /// Top levels of the order book (Req 9.6). Bids are best first (descending price), asks
    /// best first (ascending price). `spread` is `null` while either side is empty.
    /// `imbalance_bps` is in [-10000, 10000].
    Book {
        symbol: String,
        bids: Vec<Level>,
        asks: Vec<Level>,
        spread: Option<Price>,
        imbalance_bps: i32,
        #[ts(type = "number")]
        ts: TimeMs,
    },
    /// Current indicator values for one subscription (Req 10.2).
    Indicators {
        symbol: String,
        timeframe: Timeframe,
        #[ts(type = "number")]
        ts: TimeMs,
        values: IndicatorValues,
    },
    /// The matcher accepted, canceled, or completely filled an order (Req 11.6, 11.7).
    OrderAck {
        account_id: AccountId,
        order_id: OrderId,
        status: OrderStatus,
    },
    /// An order or cancel request was refused (Req 11.9, 19.7).
    OrderRejected {
        account_id: AccountId,
        order_id: OrderId,
        reason: String,
    },
    /// All or part of an order filled (Req 12.4).
    Fill {
        account_id: AccountId,
        order_id: OrderId,
        symbol: String,
        side: Side,
        price: Price,
        qty: Qty,
        fee: Money,
        remaining: Qty,
        #[ts(type = "number")]
        ts: TimeMs,
    },
    /// The paper account's position in one symbol (Req 13.4). `avg_entry` is `null` when flat.
    Position {
        account_id: AccountId,
        symbol: String,
        qty: Qty,
        avg_entry: Option<Price>,
        realized: Money,
        unrealized: Money,
    },
    /// Emitted once per second with wall-clock time (Req 3.4).
    Heartbeat {
        #[ts(type = "number")]
        ts: TimeMs,
    },
    /// Answer to a `ping` command, with the same id (Req 1.6).
    Pong {
        #[ts(type = "number")]
        id: u64,
    },
    /// A problem the engine reports without stopping (Req 2.4, 2.5).
    Error { code: ErrorCode, message: String },
}

/// One candle. `t` is the UTC start of the candle interval.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = crate::TS_EXPORT_DIR)]
pub struct Bar {
    #[ts(type = "number")]
    pub t: TimeMs,
    pub open: Price,
    pub high: Price,
    pub low: Price,
    pub close: Price,
    pub volume: Qty,
}

/// One order book price level.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = crate::TS_EXPORT_DIR)]
pub struct Level {
    pub price: Price,
    pub qty: Qty,
}

/// Indicator values, the only floats in the protocol (Req 1.5). Each is `null` until its
/// window has enough bars.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = crate::TS_EXPORT_DIR)]
pub struct IndicatorValues {
    pub ema: Option<f64>,
    pub sma: Option<f64>,
    pub vwap: Option<f64>,
    pub bb_upper: Option<f64>,
    pub bb_mid: Option<f64>,
    pub bb_lower: Option<f64>,
    pub rsi: Option<f64>,
    pub atr: Option<f64>,
}

/// Order status carried by `order_ack`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = crate::TS_EXPORT_DIR)]
pub enum OrderStatus {
    Accepted,
    Canceled,
    Filled,
}

/// Machine-readable category of an `error` event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = crate::TS_EXPORT_DIR)]
pub enum ErrorCode {
    /// An input line is not valid JSON (Req 2.4).
    InvalidJson,
    /// An input line is JSON but does not match a Command variant (Req 2.4).
    InvalidCommand,
    /// A client message failed validation at the server (Req 17.4).
    InvalidMessage,
    /// A field value is outside its valid range, such as a replay speed above 50 (Req 2.5, 6.4).
    OutOfRange,
    /// A command names a symbol that is not in the instrument table (Req 4.2).
    UnknownSymbol,
    /// A fixture does not exist or cannot be parsed (Req 6.5).
    InvalidFixture,
    /// The live market data connection closed or failed (Req 5.5).
    FeedDisconnected,
    /// An order book delta was discarded, such as one with a negative quantity (Req 9.4).
    InvalidBookDelta,
    /// An unexpected internal failure.
    Internal,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(event: &Event) -> String {
        serde_json::to_string(event).unwrap()
    }

    fn assert_round_trip(event: &Event) {
        let parsed: Event = serde_json::from_str(&json(event)).unwrap();
        assert_eq!(&parsed, event);
    }

    fn order_id() -> OrderId {
        OrderId::new("o-1").unwrap()
    }

    fn guest() -> AccountId {
        AccountId::new("guest").unwrap()
    }

    #[test]
    fn simple_variants_use_snake_case_tags() {
        let cases = [
            (
                Event::Heartbeat {
                    ts: 1_733_200_000_000,
                },
                r#"{"type":"heartbeat","ts":1733200000000}"#,
            ),
            (Event::Pong { id: 42 }, r#"{"type":"pong","id":42}"#),
            (
                Event::OrderAck {
                    account_id: guest(),
                    order_id: order_id(),
                    status: OrderStatus::Canceled,
                },
                r#"{"type":"order_ack","account_id":"guest","order_id":"o-1","status":"canceled"}"#,
            ),
            (
                Event::OrderRejected {
                    account_id: AccountId::new("w_abc").unwrap(),
                    order_id: order_id(),
                    reason: "kill_switch".into(),
                },
                concat!(
                    r#"{"type":"order_rejected","account_id":"w_abc","order_id":"o-1","#,
                    r#""reason":"kill_switch"}"#
                ),
            ),
            (
                Event::Error {
                    code: ErrorCode::UnknownSymbol,
                    message: "unknown symbol DOGE-USD".into(),
                },
                r#"{"type":"error","code":"unknown_symbol","message":"unknown symbol DOGE-USD"}"#,
            ),
        ];
        for (event, expected) in cases {
            assert_eq!(json(&event), expected);
            assert_round_trip(&event);
        }
    }

    #[test]
    fn book_encodes_levels_and_null_spread() {
        let event = Event::Book {
            symbol: "BTC-USD".into(),
            bids: vec![Level {
                price: Price(100),
                qty: Qty(5),
            }],
            asks: vec![],
            spread: None,
            imbalance_bps: 10_000,
            ts: 1,
        };
        let expected = concat!(
            r#"{"type":"book","symbol":"BTC-USD","bids":[{"price":"100","qty":"5"}],"#,
            r#""asks":[],"spread":null,"imbalance_bps":10000,"ts":1}"#
        );
        assert_eq!(json(&event), expected);
        assert_round_trip(&event);
    }

    #[test]
    fn candle_bars_use_string_prices() {
        let bar = Bar {
            t: 60_000,
            open: Price(1),
            high: Price(3),
            low: Price(1),
            close: Price(2),
            volume: Qty(9),
        };
        let event = Event::Candle {
            symbol: "SOL-USD".into(),
            timeframe: Timeframe::M1,
            snapshot: true,
            bars: vec![bar],
        };
        let expected = concat!(
            r#"{"type":"candle","symbol":"SOL-USD","timeframe":"1m","snapshot":true,"#,
            r#""bars":[{"t":60000,"open":"1","high":"3","low":"1","close":"2","volume":"9"}]}"#
        );
        assert_eq!(json(&event), expected);
        assert_round_trip(&event);
    }

    #[test]
    fn indicators_are_numbers_or_null() {
        let values = IndicatorValues {
            ema: Some(1.5),
            rsi: Some(50.0),
            ..IndicatorValues::default()
        };
        let event = Event::Indicators {
            symbol: "BTC-USD".into(),
            timeframe: Timeframe::H1,
            ts: 5,
            values,
        };
        let expected = concat!(
            r#"{"type":"indicators","symbol":"BTC-USD","timeframe":"1h","ts":5,"values":{"#,
            r#""ema":1.5,"sma":null,"vwap":null,"bb_upper":null,"bb_mid":null,"#,
            r#""bb_lower":null,"rsi":50.0,"atr":null}}"#
        );
        assert_eq!(json(&event), expected);
        assert_round_trip(&event);
    }

    /// Regression for P1 counterexamples: without serde_json's `float_roundtrip` feature these
    /// values parsed back one ULP off.
    #[test]
    fn indicator_floats_round_trip_bit_for_bit() {
        for value in [9_872_895.999_428_557, -8.272_811_228_942_171e-255] {
            let event = Event::Indicators {
                symbol: "BTC-USD".into(),
                timeframe: Timeframe::M1,
                ts: 0,
                values: IndicatorValues {
                    ema: Some(value),
                    ..IndicatorValues::default()
                },
            };
            let parsed: Event = serde_json::from_str(&json(&event)).unwrap();
            let Event::Indicators { values, .. } = parsed else {
                panic!("parsed as another variant: {parsed:?}");
            };
            assert_eq!(values.ema.map(f64::to_bits), Some(value.to_bits()));
        }
    }

    #[test]
    fn fill_and_position_carry_money_as_strings() {
        let fill = Event::Fill {
            account_id: guest(),
            order_id: order_id(),
            symbol: "BTC-USD".into(),
            side: Side::Buy,
            price: Price(6_400_000),
            qty: Qty(10),
            fee: Money(640),
            remaining: Qty(0),
            ts: 2,
        };
        let expected = concat!(
            r#"{"type":"fill","account_id":"guest","order_id":"o-1","symbol":"BTC-USD","#,
            r#""side":"buy","price":"6400000","qty":"10","fee":"640","remaining":"0","ts":2}"#
        );
        assert_eq!(json(&fill), expected);
        assert_round_trip(&fill);

        let position = Event::Position {
            account_id: guest(),
            symbol: "BTC-USD".into(),
            qty: Qty(-10),
            avg_entry: Some(Price(6_400_000)),
            realized: Money(0),
            unrealized: Money(i64::MAX),
        };
        let expected = concat!(
            r#"{"type":"position","account_id":"guest","symbol":"BTC-USD","qty":"-10","#,
            r#""avg_entry":"6400000","realized":"0","unrealized":"9223372036854775807"}"#
        );
        assert_eq!(json(&position), expected);
        assert_round_trip(&position);
    }
}
