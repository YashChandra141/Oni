//! Engine Commands: messages from the server to the engine (Req 1.1).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::num::Qty;
use crate::types::{AccountId, OrderId, OrderKind, Side, Timeframe, Venue};

/// A message sent to the engine on stdin, one JSON line each.
///
/// On the wire: `{"type":"ping","id":7}`. Range checks (known symbol, positive quantity,
/// replay speed 1 to 50) belong to the codec, not to these types (Req 2.5).
///
/// The order Commands carry the `account_id` of the Paper_Account they act on (Req 1.9). The
/// server's Router sets it from the requesting connection's session, never from client input
/// (Req 18.5).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export, export_to = crate::TS_EXPORT_DIR)]
pub enum Command {
    /// Start streaming candles and indicators for a symbol and timeframe.
    Subscribe {
        venue: Venue,
        symbol: String,
        timeframe: Timeframe,
    },
    /// Stop streaming candles and indicators for a symbol and timeframe.
    Unsubscribe {
        venue: Venue,
        symbol: String,
        timeframe: Timeframe,
    },
    /// Start the 24-hour ticker stream for a (venue, symbol), without a candle subscription.
    SubscribeTicker { symbol: String, venue: Venue },
    /// Stop the 24-hour ticker stream for a (venue, symbol).
    UnsubscribeTicker { symbol: String, venue: Venue },
    /// Place a paper order. Only the server's Router sends this (Req 18.3).
    PlaceOrder {
        account_id: AccountId,
        venue: Venue,
        order_id: OrderId,
        symbol: String,
        side: Side,
        qty: Qty,
        kind: OrderKind,
    },
    /// Cancel one open order of the account (Req 14.6).
    Cancel {
        account_id: AccountId,
        order_id: OrderId,
    },
    /// Cancel every open order of the account (Req 14.7).
    CancelAll { account_id: AccountId },
    /// Replay a fixture from `fixtures/` at `speed` times the recorded pace.
    StartReplay { fixture: String, speed: u32 },
    /// Cancel the account's orders and flatten its positions (Req 14.3). Other accounts are
    /// untouched; there is no command that resets every account.
    ResetAccount { account_id: AccountId },
    /// Liveness probe; the engine answers with a `pong` carrying the same id (Req 1.6).
    Ping {
        #[ts(type = "number")]
        id: u64,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::num::Price;

    fn json(command: &Command) -> String {
        serde_json::to_string(command).unwrap()
    }

    fn assert_round_trip(command: &Command) {
        let parsed: Command = serde_json::from_str(&json(command)).unwrap();
        assert_eq!(&parsed, command);
    }

    fn guest() -> AccountId {
        AccountId::new("guest").unwrap()
    }

    #[test]
    fn simple_variants_use_the_type_tag() {
        let cases = [
            (
                Command::CancelAll {
                    account_id: guest(),
                },
                r#"{"type":"cancel_all","account_id":"guest"}"#,
            ),
            (
                Command::ResetAccount {
                    account_id: AccountId::new("w_abc").unwrap(),
                },
                r#"{"type":"reset_account","account_id":"w_abc"}"#,
            ),
            (
                Command::Cancel {
                    account_id: guest(),
                    order_id: OrderId::new("o-1").unwrap(),
                },
                r#"{"type":"cancel","account_id":"guest","order_id":"o-1"}"#,
            ),
            (Command::Ping { id: 7 }, r#"{"type":"ping","id":7}"#),
            (
                Command::StartReplay {
                    fixture: "demo.jsonl".into(),
                    speed: 10,
                },
                r#"{"type":"start_replay","fixture":"demo.jsonl","speed":10}"#,
            ),
        ];
        for (command, expected) in cases {
            assert_eq!(json(&command), expected);
            assert_round_trip(&command);
        }
    }

    #[test]
    fn subscribe_uses_timeframe_wire_names() {
        let command = Command::Subscribe {
            venue: Venue::Backpack,
            symbol: "BTC-USD".into(),
            timeframe: Timeframe::M15,
        };
        let expected =
            r#"{"type":"subscribe","venue":"backpack","symbol":"BTC-USD","timeframe":"15m"}"#;
        assert_eq!(json(&command), expected);
        assert_round_trip(&command);
    }

    #[test]
    fn ticker_subscriptions_carry_symbol_and_venue() {
        let sub = Command::SubscribeTicker {
            symbol: "SOL-USD".into(),
            venue: Venue::Jupiter,
        };
        let unsub = Command::UnsubscribeTicker {
            symbol: "SOL-USD".into(),
            venue: Venue::Raydium,
        };
        assert_eq!(
            json(&sub),
            r#"{"type":"subscribe_ticker","symbol":"SOL-USD","venue":"jupiter"}"#
        );
        assert_eq!(
            json(&unsub),
            r#"{"type":"unsubscribe_ticker","symbol":"SOL-USD","venue":"raydium"}"#
        );
        assert_round_trip(&sub);
        assert_round_trip(&unsub);
    }

    #[test]
    fn place_order_nests_the_order_kind() {
        let command = Command::PlaceOrder {
            account_id: guest(),
            venue: Venue::Replay,
            order_id: OrderId::new("o-1").unwrap(),
            symbol: "ETH-USD".into(),
            side: Side::Sell,
            qty: Qty(250),
            kind: OrderKind::Limit {
                price: Price(310_000),
            },
        };
        let expected = concat!(
            r#"{"type":"place_order","account_id":"guest","venue":"replay","order_id":"o-1","#,
            r#""symbol":"ETH-USD","#,
            r#""side":"sell","qty":"250","kind":{"type":"limit","price":"310000"}}"#
        );
        assert_eq!(json(&command), expected);
        assert_round_trip(&command);
    }

    #[test]
    fn rejects_unknown_and_pascal_case_tags() {
        for input in [
            r#"{"type":"CancelAll"}"#,
            r#"{"type":"place_paper_order"}"#,
            r#"{"id":1}"#,
            r#"{"type":"ping"}"#,
        ] {
            assert!(serde_json::from_str::<Command>(input).is_err(), "{input}");
        }
    }

    /// Protocol v2: the order Commands need a valid `account_id` (Req 1.9, 1.10).
    #[test]
    fn order_commands_require_a_valid_account_id() {
        for input in [
            r#"{"type":"cancel_all"}"#,
            r#"{"type":"reset_account"}"#,
            r#"{"type":"cancel","order_id":"o-1"}"#,
            r#"{"type":"cancel_all","account_id":""}"#,
            r#"{"type":"cancel_all","account_id":"guest-1"}"#,
            r#"{"type":"reset_account","account_id":null}"#,
            r#"{"type":"cancel","account_id":"a b","order_id":"o-1"}"#,
        ] {
            assert!(serde_json::from_str::<Command>(input).is_err(), "{input}");
        }
    }
}
