//! Client ↔ server messages, sent as JSON over the `/ws` WebSocket.
//!
//! The web UI uses the generated TypeScript types and the TUI uses these Rust types, so both
//! clients speak exactly the same protocol.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::event::Event;
use crate::instrument::{INSTRUMENTS, Instrument};
use crate::num::Qty;
use crate::types::{AccountId, OrderId, OrderKind, Side, TimeMs, Timeframe, Venue};

/// A message from a client to the server.
///
/// Order requests are never sent directly. Typed commands become an [`OrderPreview`] that the
/// client must `confirm` (Req 22.4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export, export_to = crate::TS_EXPORT_DIR)]
pub enum ClientMessage {
    /// Start receiving market data for a symbol and timeframe.
    Subscribe {
        symbol: String,
        timeframe: Timeframe,
    },
    /// Stop receiving market data for a symbol and timeframe.
    Unsubscribe {
        symbol: String,
        timeframe: Timeframe,
    },
    /// Command bar text: `BUY ...` or `? plain English` (Req 31.2).
    CommandText { request_id: String, text: String },
    /// Confirm a preview the server sent earlier (Req 22.2).
    Confirm {
        request_id: String,
        preview_id: String,
    },
    /// Discard a preview; no order request is sent (Req 22.3).
    Discard { preview_id: String },
    /// Cancel one open order (Req 30.3).
    Cancel {
        request_id: String,
        order_id: OrderId,
    },
    /// Cancel every open order. The client confirms first (Req 30.5).
    CancelAll { request_id: String },
    /// Flatten every position. The client confirms first (Req 30.4).
    FlattenAll { request_id: String },
    /// Reset the connection's own paper account only (Req 14.3).
    ResetAccount { request_id: String },
    /// Sign the connection in with a Session_Token, sent after connect because browsers cannot
    /// set WebSocket headers (Req 1.7). The server answers with `session`.
    Authenticate { token: String },
    /// Liveness probe; the server answers with a `pong` carrying the same id.
    Ping {
        #[ts(type = "number")]
        id: u64,
    },
}

/// A message from the server to a client.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export, export_to = crate::TS_EXPORT_DIR)]
pub enum ServerMessage {
    /// First message on every connection. `venue` names the Live_Venue in live mode and is
    /// `null` in replay mode (Req 1.11).
    Hello {
        protocol_version: u32,
        data_mode: DataMode,
        venue: Option<Venue>,
        engine_running: bool,
        instruments: Vec<InstrumentInfo>,
    },
    /// An engine event forwarded to this client (Req 17.6, 17.7).
    Event { event: Event },
    /// A preview of a typed or plain-English order, waiting for confirmation (Req 22.1).
    Preview {
        request_id: String,
        preview: OrderPreview,
    },
    /// Command bar text did not parse. `position` is the offset of the first invalid token
    /// (Req 21.5).
    ParseError {
        request_id: String,
        message: String,
        position: usize,
    },
    /// A status notice, such as an account reset after an engine restart (Req 15.7).
    Notice { kind: NoticeKind, message: String },
    /// The connection's account: `guest` with a `null` address, or a Wallet_Account with its
    /// base58 Wallet_Address. Sent after `hello` and after every account change (Req 1.8).
    Session {
        account_id: AccountId,
        address: Option<String>,
    },
    /// Answer to a client `ping`, with the same id.
    Pong {
        #[ts(type = "number")]
        id: u64,
    },
}

/// A proposed order or order action that the user confirms or discards.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = crate::TS_EXPORT_DIR)]
pub struct OrderPreview {
    pub preview_id: String,
    /// Canonical command bar text for the action, e.g. `BUY BTC-USD 0.1 LMT 64000.00`.
    pub text: String,
    pub action: PreviewAction,
    /// Unix epoch ms after which the server no longer accepts a confirmation.
    #[ts(type = "number")]
    pub expires_at: TimeMs,
}

/// What an [`OrderPreview`] does when confirmed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export, export_to = crate::TS_EXPORT_DIR)]
pub enum PreviewAction {
    Place {
        symbol: String,
        side: Side,
        qty: Qty,
        kind: OrderKind,
    },
    CancelAll,
    FlattenAll,
}

/// Category of a [`ServerMessage::Notice`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = crate::TS_EXPORT_DIR)]
pub enum NoticeKind {
    /// The engine restarted and the paper account is empty again (Req 15.7).
    AccountReset,
    /// The engine stopped; order requests are rejected until it is back (Req 15.5).
    EngineDown,
    /// The engine is running again.
    EngineUp,
    /// Plain-English orders are off because no LLM key is configured (Req 23.7).
    LlmDisabled,
    /// An `authenticate` token was invalid, expired, or signed out; the connection is a guest.
    AuthFailed,
    /// The connection's Session_Token expired; the connection is a guest again.
    SessionExpired,
    /// The wallet signed out; the connection is a guest again.
    SignedOut,
}

/// Where the engine's market data comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = crate::TS_EXPORT_DIR)]
pub enum DataMode {
    /// Recorded fixtures (the default, Req 6.1).
    Replay,
    /// The public feed of the Live_Venue, Coinbase or Backpack (Req 5.1, 43).
    Live,
}

/// Instrument definition sent to clients in `hello`, so they format ticks and lots without
/// their own copy of the table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = crate::TS_EXPORT_DIR)]
pub struct InstrumentInfo {
    /// Full symbol, e.g. `BTC-USD`.
    pub symbol: String,
    /// Short symbol, e.g. `BTC`.
    pub short: String,
    /// Tick size is 10^-price_decimals USD.
    pub price_decimals: u32,
    /// Lot size is 10^-qty_decimals units of the base asset.
    pub qty_decimals: u32,
}

impl InstrumentInfo {
    /// Every instrument in the instrument table, in table order.
    pub fn all() -> Vec<InstrumentInfo> {
        INSTRUMENTS.iter().map(InstrumentInfo::from).collect()
    }
}

impl From<&Instrument> for InstrumentInfo {
    fn from(instrument: &Instrument) -> Self {
        Self {
            symbol: instrument.symbol.to_owned(),
            short: instrument.short.to_owned(),
            price_decimals: instrument.price_decimals,
            qty_decimals: instrument.qty_decimals,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::OrderStatus;
    use crate::num::Price;

    fn json<T: Serialize>(value: &T) -> String {
        serde_json::to_string(value).unwrap()
    }

    fn assert_round_trip<T>(value: &T)
    where
        T: Serialize + for<'de> Deserialize<'de> + PartialEq + std::fmt::Debug,
    {
        let parsed: T = serde_json::from_str(&json(value)).unwrap();
        assert_eq!(&parsed, value);
    }

    #[test]
    fn client_messages_use_snake_case_tags() {
        let cases = [
            (
                ClientMessage::CommandText {
                    request_id: "r1".into(),
                    text: "BUY BTC 0.1".into(),
                },
                r#"{"type":"command_text","request_id":"r1","text":"BUY BTC 0.1"}"#,
            ),
            (
                ClientMessage::Confirm {
                    request_id: "r2".into(),
                    preview_id: "p1".into(),
                },
                r#"{"type":"confirm","request_id":"r2","preview_id":"p1"}"#,
            ),
            (
                ClientMessage::FlattenAll {
                    request_id: "r3".into(),
                },
                r#"{"type":"flatten_all","request_id":"r3"}"#,
            ),
            (
                ClientMessage::Subscribe {
                    symbol: "ETH-USD".into(),
                    timeframe: Timeframe::D1,
                },
                r#"{"type":"subscribe","symbol":"ETH-USD","timeframe":"1d"}"#,
            ),
            (
                ClientMessage::Authenticate {
                    token: "v1.payload.mac".into(),
                },
                r#"{"type":"authenticate","token":"v1.payload.mac"}"#,
            ),
            (ClientMessage::Ping { id: 3 }, r#"{"type":"ping","id":3}"#),
        ];
        for (message, expected) in cases {
            assert_eq!(json(&message), expected);
            assert_round_trip(&message);
        }
        let unknown = r#"{"type":"place_order","request_id":"r"}"#;
        assert!(serde_json::from_str::<ClientMessage>(unknown).is_err());
    }

    #[test]
    fn hello_lists_the_instrument_table() {
        let message = ServerMessage::Hello {
            protocol_version: crate::PROTOCOL_VERSION,
            data_mode: DataMode::Replay,
            venue: None,
            engine_running: true,
            instruments: InstrumentInfo::all(),
        };
        let text = json(&message);
        let prefix = r#"{"type":"hello","protocol_version":2,"data_mode":"replay","venue":null,"engine_running":true,"instruments":[{"symbol":"BTC-USD","short":"BTC","price_decimals":2,"qty_decimals":8},"#;
        assert!(text.starts_with(prefix), "{text}");
        assert_round_trip(&message);

        // Req 1.11: in live mode, hello names the venue.
        let live = ServerMessage::Hello {
            protocol_version: crate::PROTOCOL_VERSION,
            data_mode: DataMode::Live,
            venue: Some(Venue::Backpack),
            engine_running: false,
            instruments: Vec::new(),
        };
        let expected = concat!(
            r#"{"type":"hello","protocol_version":2,"data_mode":"live","venue":"backpack","#,
            r#""engine_running":false,"instruments":[]}"#
        );
        assert_eq!(json(&live), expected);
        assert_round_trip(&live);

        let symbols: Vec<String> = InstrumentInfo::all()
            .into_iter()
            .map(|i| i.symbol)
            .collect();
        assert_eq!(symbols, ["BTC-USD", "ETH-USD", "SOL-USD"]);
    }

    #[test]
    fn server_wraps_engine_events_and_previews() {
        let event = ServerMessage::Event {
            event: Event::OrderAck {
                account_id: AccountId::new("guest").unwrap(),
                order_id: OrderId::new("o-9").unwrap(),
                status: OrderStatus::Filled,
            },
        };
        let expected = concat!(
            r#"{"type":"event","event":{"type":"order_ack","account_id":"guest","#,
            r#""order_id":"o-9","status":"filled"}}"#
        );
        assert_eq!(json(&event), expected);
        assert_round_trip(&event);

        let preview = ServerMessage::Preview {
            request_id: "r1".into(),
            preview: OrderPreview {
                preview_id: "p1".into(),
                text: "BUY BTC-USD 0.1 LMT 64000.00".into(),
                action: PreviewAction::Place {
                    symbol: "BTC-USD".into(),
                    side: Side::Buy,
                    qty: Qty(10_000_000),
                    kind: OrderKind::Limit {
                        price: Price(6_400_000),
                    },
                },
                expires_at: 1_733_200_030_000,
            },
        };
        let expected = concat!(
            r#"{"type":"preview","request_id":"r1","preview":{"preview_id":"p1","#,
            r#""text":"BUY BTC-USD 0.1 LMT 64000.00","action":{"type":"place","#,
            r#""symbol":"BTC-USD","side":"buy","qty":"10000000","#,
            r#""kind":{"type":"limit","price":"6400000"}},"expires_at":1733200030000}}"#
        );
        assert_eq!(json(&preview), expected);
        assert_round_trip(&preview);
    }

    #[test]
    fn notices_parse_errors_and_unit_actions() {
        let notice = ServerMessage::Notice {
            kind: NoticeKind::LlmDisabled,
            message: "plain-English orders are disabled".into(),
        };
        let expected = r#"{"type":"notice","kind":"llm_disabled","message":"plain-English orders are disabled"}"#;
        assert_eq!(json(&notice), expected);
        assert_round_trip(&notice);

        let parse_error = ServerMessage::ParseError {
            request_id: "r1".into(),
            message: "unknown symbol".into(),
            position: 4,
        };
        let expected =
            r#"{"type":"parse_error","request_id":"r1","message":"unknown symbol","position":4}"#;
        assert_eq!(json(&parse_error), expected);
        assert_round_trip(&parse_error);

        assert_eq!(json(&PreviewAction::CancelAll), r#"{"type":"cancel_all"}"#);
        assert_eq!(
            json(&PreviewAction::FlattenAll),
            r#"{"type":"flatten_all"}"#
        );
        assert_eq!(json(&DataMode::Live), r#""live""#);
        let kinds = [
            (NoticeKind::AccountReset, r#""account_reset""#),
            (NoticeKind::AuthFailed, r#""auth_failed""#),
            (NoticeKind::SessionExpired, r#""session_expired""#),
            (NoticeKind::SignedOut, r#""signed_out""#),
        ];
        for (kind, expected) in kinds {
            assert_eq!(json(&kind), expected);
            assert_round_trip(&kind);
        }
    }

    /// Req 1.8: `session` carries the account id and the wallet address, or `null` for guest.
    #[test]
    fn session_carries_account_and_address() {
        let guest = ServerMessage::Session {
            account_id: AccountId::new("guest").unwrap(),
            address: None,
        };
        let expected = r#"{"type":"session","account_id":"guest","address":null}"#;
        assert_eq!(json(&guest), expected);
        assert_round_trip(&guest);

        let address = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
        let wallet = ServerMessage::Session {
            account_id: AccountId::new(format!("w_{address}")).unwrap(),
            address: Some(address.into()),
        };
        let expected =
            format!(r#"{{"type":"session","account_id":"w_{address}","address":"{address}"}}"#);
        assert_eq!(json(&wallet), expected);
        assert_round_trip(&wallet);

        let bad = r#"{"type":"session","account_id":"guest-1","address":null}"#;
        assert!(serde_json::from_str::<ServerMessage>(bad).is_err());
    }
}
