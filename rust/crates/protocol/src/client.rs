//! Client ↔ server messages, sent as JSON over the `/ws` WebSocket.
//!
//! The web UI uses the generated TypeScript types and the TUI uses these Rust types, so both
//! clients speak exactly the same protocol.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::event::{Event, WireEvent};
use crate::instrument::{INSTRUMENTS, Instrument};
use crate::num::{Money, Qty};
use crate::types::{
    AccountId, AnalysisBias, CopilotAction, NewsItem, OrderId, OrderKind, ProviderId, Side, TimeMs,
    Timeframe, TwapStatus, Venue, VenueStatusKind,
};

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
        venue: Venue,
        symbol: String,
        timeframe: Timeframe,
    },
    /// Stop receiving market data for a symbol and timeframe.
    Unsubscribe {
        venue: Venue,
        symbol: String,
        timeframe: Timeframe,
    },
    /// Start receiving the 24-hour ticker of a (venue, symbol) pair.
    SubscribeTicker { symbol: String, venue: Venue },
    /// Stop receiving the 24-hour ticker of a (venue, symbol) pair.
    UnsubscribeTicker { symbol: String, venue: Venue },
    /// Command bar text: `BUY ...` or `? plain English` (Req 31.2). `venue` is the client's
    /// Active_Venue; the server validates it against the `hello` venue list, and `null` or an
    /// absent field means the server's default venue.
    CommandText {
        request_id: String,
        text: String,
        #[serde(default)]
        venue: Option<Venue>,
    },
    /// Cancel the remaining child orders of a TWAP plan (Req 17.7).
    CancelTwap { request_id: String, twap_id: String },
    /// Select the LLM provider for this connection (Req 4.2).
    SetProvider { provider: ProviderId },
    /// A Copilot request. "Place trade" is not an action here: the client sends `command_text`
    /// with a `?` prefix (Req 7.4). The message carries no account id.
    AiRequest {
        request_id: String,
        action: CopilotAction,
        text: String,
        symbol: String,
        timeframe: Timeframe,
        venue: Venue,
    },
    /// Cancel a pending AI request (Req 7.8).
    AiCancel { request_id: String },
    /// Start receiving news (Req 19.10).
    SubscribeNews,
    /// Stop receiving news.
    UnsubscribeNews,
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
    /// First message on every connection. `live_venues` lists the venues the market feed
    /// connects to (empty in replay mode), `venue_status` their current status, and
    /// `default_venue` the venue a client uses until the user picks another.
    Hello {
        protocol_version: u32,
        data_mode: DataMode,
        live_venues: Vec<Venue>,
        venue_status: Vec<VenueStatusEntry>,
        default_venue: Venue,
        starting_balance: Money,
        engine_running: bool,
        instruments: Vec<InstrumentInfo>,
        /// Summary of the LLM providers, without any key, base URL, or credential (Req 4.1).
        providers: Vec<ProviderInfo>,
        news_enabled: bool,
    },
    /// An engine event forwarded to this client (Req 17.6, 17.7).
    Event { event: Event },
    /// Several engine events for this client, in the order the engine emitted them (Req 34.1).
    EventBatch { events: Vec<WireEvent> },
    /// The LLM providers that can be selected, the server default, and this connection's
    /// selection. No key, base URL, or credential appears here (Req 4.1).
    Providers {
        available: Vec<ProviderInfo>,
        default: Option<ProviderId>,
        selected: Option<ProviderId>,
    },
    /// A validated AI analysis, with the preview built from its suggested order (Req 5.9).
    Analysis {
        request_id: String,
        provider: ProviderId,
        model: String,
        analysis: AnalysisResult,
        preview: Option<OrderPreview>,
        preview_error: Option<PreviewError>,
    },
    /// Scan results, ranked by confidence descending (Req 7.5).
    ScanResult {
        request_id: String,
        items: Vec<ScanItem>,
    },
    /// A strategy description. The text starts with "draft, not executed" (Req 7.6).
    StrategyDraft { request_id: String, text: String },
    /// An AI request failed or was canceled.
    AiError {
        request_id: String,
        reason: AiErrorReason,
        message: String,
    },
    /// The news list. `available` is false while no provider answers (Req 19.10, 19.13).
    News {
        available: bool,
        items: Vec<NewsItem>,
        #[ts(type = "number | null")]
        updated_at: Option<TimeMs>,
    },
    /// Progress of a TWAP plan, sent on each change (Req 17.9).
    Twap {
        twap_id: String,
        symbol: String,
        side: Side,
        venue: Venue,
        slices: u32,
        sent: u32,
        status: TwapStatus,
        reason: Option<String>,
    },
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
        venue: Venue,
        side: Side,
        qty: Qty,
        kind: OrderKind,
    },
    /// A TWAP plan: `slices` market orders, `interval_s` seconds apart (Req 17). Confirming the
    /// preview authorizes exactly these child orders.
    Twap {
        symbol: String,
        side: Side,
        venue: Venue,
        total_qty: Qty,
        slices: u32,
        interval_s: u32,
    },
    CancelAll,
    FlattenAll,
}

/// A parse failure of the order text built from an AI suggestion (design: `preview_error`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = crate::TS_EXPORT_DIR)]
pub struct PreviewError {
    pub message: String,
    pub position: usize,
}

/// Status of one venue, as sent in `hello`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = crate::TS_EXPORT_DIR)]
pub struct VenueStatusEntry {
    pub venue: Venue,
    pub status: VenueStatusKind,
}

/// One selectable LLM provider. It holds no key, base URL, or credential (Req 4.1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = crate::TS_EXPORT_DIR)]
pub struct ProviderInfo {
    pub id: ProviderId,
    pub model: String,
    /// Why the provider cannot be used, or `null` when it can.
    pub reason: Option<String>,
}

/// A suggested order inside an [`AnalysisResult`]. It has no account, venue, or wallet field:
/// the server sets those (trading-safety rule 10).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = crate::TS_EXPORT_DIR)]
pub struct TradeIdea {
    pub side: Side,
    pub qty: Qty,
    pub kind: OrderKind,
}

/// The validated result of an AI analysis. `confidence_bps` is 0 to 10,000 (0 to 1), kept an
/// integer because floats are for indicator values only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = crate::TS_EXPORT_DIR)]
pub struct AnalysisResult {
    pub symbol: String,
    pub summary: String,
    pub bias: AnalysisBias,
    pub confidence_bps: u16,
    pub rationale: Vec<String>,
    pub suggested_order: Option<TradeIdea>,
}

/// One ranked result of a scan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = crate::TS_EXPORT_DIR)]
pub struct ScanItem {
    pub symbol: String,
    pub bias: AnalysisBias,
    pub confidence_bps: u16,
    pub summary: String,
}

/// Why an AI request failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = crate::TS_EXPORT_DIR)]
pub enum AiErrorReason {
    AiDisabled,
    AiRateLimit,
    AiDailyCap,
    ProviderError,
    ValidationError,
    Timeout,
    Canceled,
}

/// p50 and p95 of one latency measurement, in microseconds. `null` while there are no samples.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = crate::TS_EXPORT_DIR)]
pub struct LatencySummary {
    #[ts(type = "number")]
    pub count: u64,
    #[ts(type = "number | null")]
    pub p50_us: Option<u64>,
    #[ts(type = "number | null")]
    pub p95_us: Option<u64>,
}

/// The latency measurements of Req 33.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = crate::TS_EXPORT_DIR)]
pub struct HealthLatency {
    /// Engine emit time to the server writing the event to a connection (Req 33.1).
    pub emit_to_write: LatencySummary,
    /// `command_text` to preview or parse error (Req 33.3).
    pub command_to_preview: LatencySummary,
    /// `confirm` to the order ack (Req 33.4).
    pub confirm_to_ack: LatencySummary,
    /// The server's receipt of an engine line to a client write (Req 33.5).
    pub receipt_to_client: LatencySummary,
}

/// The JSON body of `GET /health`. It has no `db` field (Req 1.9).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = crate::TS_EXPORT_DIR)]
pub struct HealthBody {
    pub engine_running: bool,
    /// The status of each live venue.
    pub venue_status: Vec<VenueStatusEntry>,
    pub latency: HealthLatency,
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
    /// AI features are off because no provider is available (Req 23.7). Replaces `llm_disabled`.
    AiDisabled,
    /// The client's outgoing queue overflowed and events were dropped (Req 34).
    SlowClient,
    /// The connection's LLM provider selection changed (Req 4.2).
    ProviderChanged,
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
    /// A typical price as a decimal string.
    pub reference_price: String,
    /// The live venues that list the symbol.
    pub venues: Vec<Venue>,
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
            reference_price: instrument.reference_price.to_owned(),
            venues: instrument.venues.to_vec(),
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
                    venue: Some(Venue::Backpack),
                },
                r#"{"type":"command_text","request_id":"r1","text":"BUY BTC 0.1","venue":"backpack"}"#,
            ),
            (
                ClientMessage::SubscribeTicker {
                    symbol: "SOL-USD".into(),
                    venue: Venue::Jupiter,
                },
                r#"{"type":"subscribe_ticker","symbol":"SOL-USD","venue":"jupiter"}"#,
            ),
            (
                ClientMessage::CancelTwap {
                    request_id: "r4".into(),
                    twap_id: "7".into(),
                },
                r#"{"type":"cancel_twap","request_id":"r4","twap_id":"7"}"#,
            ),
            (
                ClientMessage::SetProvider {
                    provider: ProviderId::Ollama,
                },
                r#"{"type":"set_provider","provider":"ollama"}"#,
            ),
            (
                ClientMessage::AiRequest {
                    request_id: "r5".into(),
                    action: CopilotAction::Scan,
                    text: String::new(),
                    symbol: "BTC-USD".into(),
                    timeframe: Timeframe::H1,
                    venue: Venue::Coinbase,
                },
                r#"{"type":"ai_request","request_id":"r5","action":"scan","text":"","symbol":"BTC-USD","timeframe":"1h","venue":"coinbase"}"#,
            ),
            (
                ClientMessage::AiCancel {
                    request_id: "r5".into(),
                },
                r#"{"type":"ai_cancel","request_id":"r5"}"#,
            ),
            (ClientMessage::SubscribeNews, r#"{"type":"subscribe_news"}"#),
            (
                ClientMessage::UnsubscribeNews,
                r#"{"type":"unsubscribe_news"}"#,
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
                    venue: Venue::Replay,
                    symbol: "ETH-USD".into(),
                    timeframe: Timeframe::D1,
                },
                r#"{"type":"subscribe","venue":"replay","symbol":"ETH-USD","timeframe":"1d"}"#,
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
        // The venue of a subscription is required; an unknown venue or provider is rejected.
        let no_venue = r#"{"type":"subscribe","symbol":"BTC-USD","timeframe":"1m"}"#;
        assert!(serde_json::from_str::<ClientMessage>(no_venue).is_err());
        let bad_provider = r#"{"type":"set_provider","provider":"gemini"}"#;
        assert!(serde_json::from_str::<ClientMessage>(bad_provider).is_err());
        // `venue` of command_text is optional.
        let bare = r#"{"type":"command_text","request_id":"r","text":"FLAT"}"#;
        assert!(matches!(
            serde_json::from_str::<ClientMessage>(bare),
            Ok(ClientMessage::CommandText { venue: None, .. })
        ));
    }

    fn hello(
        mode: DataMode,
        venues: Vec<Venue>,
        instruments: Vec<InstrumentInfo>,
    ) -> ServerMessage {
        ServerMessage::Hello {
            protocol_version: crate::PROTOCOL_VERSION,
            data_mode: mode,
            live_venues: venues,
            venue_status: Vec::new(),
            default_venue: Venue::Replay,
            starting_balance: Money(1_000_000_000_000_000),
            engine_running: true,
            instruments,
            providers: Vec::new(),
            news_enabled: false,
        }
    }

    #[test]
    fn hello_golden_line_and_new_server_messages() {
        let mut message = hello(DataMode::Live, vec![Venue::Backpack], Vec::new());
        if let ServerMessage::Hello {
            venue_status,
            providers,
            news_enabled,
            ..
        } = &mut message
        {
            venue_status.push(VenueStatusEntry {
                venue: Venue::Backpack,
                status: VenueStatusKind::Connected,
            });
            providers.push(ProviderInfo {
                id: ProviderId::Openai,
                model: "gpt".into(),
                reason: None,
            });
            *news_enabled = true;
        }
        let expected = concat!(
            r#"{"type":"hello","protocol_version":3,"data_mode":"live","live_venues":["backpack"],"#,
            r#""venue_status":[{"venue":"backpack","status":"connected"}],"default_venue":"replay","#,
            r#""starting_balance":"1000000000000000","engine_running":true,"instruments":[],"#,
            r#""providers":[{"id":"openai","model":"gpt","reason":null}],"news_enabled":true}"#
        );
        assert_eq!(json(&message), expected);
        assert_round_trip(&message);

        let batch = ServerMessage::EventBatch {
            events: vec![WireEvent {
                event: Event::Pong { id: 1 },
                emit_us: Some(5),
            }],
        };
        let expected = r#"{"type":"event_batch","events":[{"type":"pong","id":1,"emit_us":5}]}"#;
        assert_eq!(json(&batch), expected);
        assert_round_trip(&batch);

        let providers = ServerMessage::Providers {
            available: vec![ProviderInfo {
                id: ProviderId::Nvidia,
                model: "m".into(),
                reason: Some("no key".into()),
            }],
            default: Some(ProviderId::Nvidia),
            selected: None,
        };
        let expected = r#"{"type":"providers","available":[{"id":"nvidia","model":"m","reason":"no key"}],"default":"nvidia","selected":null}"#;
        assert_eq!(json(&providers), expected);
        assert_round_trip(&providers);

        let error = ServerMessage::AiError {
            request_id: "r".into(),
            reason: AiErrorReason::AiDailyCap,
            message: "cap".into(),
        };
        assert_eq!(
            json(&error),
            r#"{"type":"ai_error","request_id":"r","reason":"ai_daily_cap","message":"cap"}"#
        );
        assert_round_trip(&error);

        let twap = ServerMessage::Twap {
            twap_id: "1".into(),
            symbol: "SOL-USD".into(),
            side: Side::Sell,
            venue: Venue::Coinbase,
            slices: 4,
            sent: 1,
            status: TwapStatus::Active,
            reason: None,
        };
        let expected = r#"{"type":"twap","twap_id":"1","symbol":"SOL-USD","side":"sell","venue":"coinbase","slices":4,"sent":1,"status":"active","reason":null}"#;
        assert_eq!(json(&twap), expected);
        assert_round_trip(&twap);

        let analysis = ServerMessage::Analysis {
            request_id: "r".into(),
            provider: ProviderId::Anthropic,
            model: "m".into(),
            analysis: AnalysisResult {
                symbol: "BTC-USD".into(),
                summary: "s".into(),
                bias: AnalysisBias::Long,
                confidence_bps: 7500,
                rationale: vec!["a".into()],
                suggested_order: Some(TradeIdea {
                    side: Side::Buy,
                    qty: Qty(1),
                    kind: OrderKind::Market,
                }),
            },
            preview: None,
            preview_error: Some(PreviewError {
                message: "bad".into(),
                position: 2,
            }),
        };
        assert_round_trip(&analysis);
        let text = json(&analysis);
        assert!(text.contains(r#""confidence_bps":7500"#), "{text}");
        assert!(!text.contains("account"), "{text}");

        let news = ServerMessage::News {
            available: true,
            items: Vec::new(),
            updated_at: None,
        };
        assert_eq!(
            json(&news),
            r#"{"type":"news","available":true,"items":[],"updated_at":null}"#
        );
        assert_round_trip(&news);
        for message in [
            ServerMessage::ScanResult {
                request_id: "r".into(),
                items: vec![ScanItem {
                    symbol: "ETH-USD".into(),
                    bias: AnalysisBias::Neutral,
                    confidence_bps: 1,
                    summary: "x".into(),
                }],
            },
            ServerMessage::StrategyDraft {
                request_id: "r".into(),
                text: "draft, not executed".into(),
            },
        ] {
            assert_round_trip(&message);
        }
    }

    #[test]
    fn twap_preview_and_new_notice_kinds() {
        let action = PreviewAction::Twap {
            symbol: "BTC-USD".into(),
            side: Side::Buy,
            venue: Venue::Backpack,
            total_qty: Qty(10),
            slices: 5,
            interval_s: 60,
        };
        let expected = r#"{"type":"twap","symbol":"BTC-USD","side":"buy","venue":"backpack","total_qty":"10","slices":5,"interval_s":60}"#;
        assert_eq!(json(&action), expected);
        assert_round_trip(&action);
        for (kind, expected) in [
            (NoticeKind::SlowClient, r#""slow_client""#),
            (NoticeKind::AiDisabled, r#""ai_disabled""#),
            (NoticeKind::ProviderChanged, r#""provider_changed""#),
        ] {
            assert_eq!(json(&kind), expected);
        }
    }

    /// Writes `shared/protocol/instruments.json` from the instrument table (Req 8.1, 15.1).
    /// The name starts with `export_bindings` so `bun run gen:protocol` runs it with the
    /// ts-rs export tests. The output directory is resolved like ts-rs does: the manifest
    /// directory joined with `TS_EXPORT_DIR`.
    #[test]
    fn export_bindings_instruments_json() {
        let mut text = serde_json::to_string_pretty(&InstrumentInfo::all()).unwrap();
        text.push('\n');
        let dir = std::path::Path::new(crate::TS_EXPORT_DIR);
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("instruments.json"), text).unwrap();
    }

    #[test]
    fn hello_lists_the_instrument_table() {
        let message = hello(DataMode::Replay, Vec::new(), InstrumentInfo::all());
        let text = json(&message);
        let prefix = concat!(
            r#"{"type":"hello","protocol_version":3,"data_mode":"replay","live_venues":[],"#,
            r#""venue_status":[],"default_venue":"replay","#,
            r#""starting_balance":"1000000000000000","engine_running":true,"#,
            r#""instruments":[{"symbol":"BTC-USD","short":"BTC","#,
            r#""price_decimals":2,"qty_decimals":8,"reference_price":"59400","#,
            r#""venues":["coinbase","backpack","jupiter","raydium"]},"#
        );
        assert!(text.starts_with(prefix), "{text}");
        assert_round_trip(&message);

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
                venue: crate::Venue::Replay,
                order_id: OrderId::new("o-9").unwrap(),
                status: OrderStatus::Filled,
            },
        };
        let expected = concat!(
            r#"{"type":"event","event":{"type":"order_ack","account_id":"guest","#,
            r#""venue":"replay","order_id":"o-9","status":"filled"}}"#
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
                    venue: Venue::Replay,
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
            r#""symbol":"BTC-USD","venue":"replay","side":"buy","qty":"10000000","#,
            r#""kind":{"type":"limit","price":"6400000"}},"expires_at":1733200030000}}"#
        );
        assert_eq!(json(&preview), expected);
        assert_round_trip(&preview);
    }

    #[test]
    fn notices_parse_errors_and_unit_actions() {
        let notice = ServerMessage::Notice {
            kind: NoticeKind::AiDisabled,
            message: "plain-English orders are disabled".into(),
        };
        let expected = r#"{"type":"notice","kind":"ai_disabled","message":"plain-English orders are disabled"}"#;
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
