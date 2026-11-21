//! proptest strategies for every protocol type, used by the property tests in
//! `src/properties.rs` (Task 2.4).
//!
//! Two families of strategies exist:
//! - `any_*` strategies cover the full value space of each type: every i64 for the numeric
//!   newtypes and timestamps, every variant of every enum, and free text that includes unicode,
//!   quotes, backslashes, and control characters. They feed the JSON round-trip property.
//! - `valid_command` produces only Commands that pass the codec's range rules: known symbols,
//!   positive quantities and prices, replay speeds 1 to 50, and valid fixture names.

use proptest::collection::vec;
use proptest::option;
use proptest::prelude::*;
use proptest::sample::select;

use crate::client::{
    AiErrorReason, AnalysisResult, ClientMessage, DataMode, InstrumentInfo, NoticeKind,
    OrderPreview, PreviewAction, PreviewError, ProviderInfo, ScanItem, ServerMessage, TradeIdea,
    VenueStatusEntry,
};
use crate::command::Command;
use crate::event::{
    Bar, ErrorCode, Event, IndicatorPoint, IndicatorValues, Level, OrderStatus, WireEvent,
};
use crate::instrument::INSTRUMENTS;
use crate::num::{Money, Price, Qty};
use crate::types::{
    AccountId, AnalysisBias, CopilotAction, NewsItem, OrderId, OrderKind, PairHealth, ProviderId,
    Side, Ticker, TimeMs, Timeframe, TwapStatus, Venue, VenueStatusKind,
};
use crate::{MAX_REPLAY_SPEED, MIN_REPLAY_SPEED};

/// Characters that stress JSON escaping, the single-line guarantee, and error message bounds:
/// line breaks, quotes, backslashes, backticks (serde's quote character), C0 and C1 controls,
/// unicode line separators, a BOM, combining marks, emoji, and unassigned code points.
pub const SPECIAL_CHARS: &[char] = &[
    '\n',
    '\r',
    '\t',
    '"',
    '\\',
    '`',
    '\'',
    '/',
    '\0',
    '\u{1}',
    '\u{1b}',
    '\u{7f}',
    '\u{85}',
    '\u{9f}',
    '\u{a0}',
    '\u{2028}',
    '\u{2029}',
    '\u{feff}',
    '\u{fffd}',
    'é',
    '\u{301}',
    '👻',
    '\u{e0000}',
    '\u{10ffff}',
];

// ---------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------

/// One character: any unicode scalar value, with a bias toward [`SPECIAL_CHARS`].
pub fn text_char() -> impl Strategy<Value = char> + Clone {
    prop_oneof![2 => any::<char>(), 1 => select(SPECIAL_CHARS)]
}

/// Short free text for message, reason, symbol, and id fields.
pub fn free_text() -> impl Strategy<Value = String> + Clone {
    vec(text_char(), 0..32).prop_map(String::from_iter)
}

/// Free text up to a few hundred characters, including long runs of one character, so error
/// messages that echo input values reach their length bounds.
pub fn long_text() -> impl Strategy<Value = String> + Clone {
    prop_oneof![
        free_text(),
        (text_char(), 0..300_usize).prop_map(|(c, n)| c.to_string().repeat(n)),
        vec(text_char(), 0..400).prop_map(String::from_iter),
    ]
}

// ---------------------------------------------------------------------------------------------
// Numbers and small types
// ---------------------------------------------------------------------------------------------

pub fn any_price() -> impl Strategy<Value = Price> + Clone {
    any::<i64>().prop_map(Price)
}

pub fn any_qty() -> impl Strategy<Value = Qty> + Clone {
    any::<i64>().prop_map(Qty)
}

pub fn any_money() -> impl Strategy<Value = Money> + Clone {
    any::<i64>().prop_map(Money)
}

pub fn positive_price() -> impl Strategy<Value = Price> + Clone {
    (1..=i64::MAX).prop_map(Price)
}

pub fn positive_qty() -> impl Strategy<Value = Qty> + Clone {
    (1..=i64::MAX).prop_map(Qty)
}

pub fn any_time() -> impl Strategy<Value = TimeMs> + Clone {
    any::<TimeMs>()
}

/// A finite f64: normal, subnormal, and zero values of either sign, typical indicator ranges,
/// and the extremes. NaN and infinity are excluded because JSON cannot encode them.
pub fn finite_f64() -> impl Strategy<Value = f64> + Clone {
    use proptest::num::f64 as f;
    prop_oneof![
        3 => f::POSITIVE | f::NEGATIVE | f::NORMAL | f::SUBNORMAL | f::ZERO,
        2 => -1.0e7..1.0e7_f64,
        1 => select(vec![
            0.0,
            -0.0,
            f64::MAX,
            f64::MIN,
            f64::MIN_POSITIVE,
            f64::EPSILON,
            5e-324,
            100.0,
        ]),
    ]
}

/// A valid order id: 1 to 64 characters of `[A-Za-z0-9_-]`.
pub fn order_id() -> impl Strategy<Value = OrderId> + Clone {
    "[A-Za-z0-9_-]{1,64}".prop_map(|id| OrderId::new(id).expect("regex yields valid order ids"))
}

/// A valid account id: `guest`, `w_<base58 address>` as the server builds them, or any 1 to 64
/// characters of `[A-Za-z0-9_]` (the engine treats the id as opaque).
pub fn account_id() -> impl Strategy<Value = AccountId> + Clone {
    prop_oneof![
        1 => Just("guest".to_owned()),
        2 => "w_[1-9A-HJ-NP-Za-km-z]{32,44}",
        2 => "[A-Za-z0-9_]{1,64}",
    ]
    .prop_map(|id| AccountId::new(id).expect("strategy yields valid account ids"))
}

/// Strings that are not valid account ids: empty, too long, or with a character outside
/// `[A-Za-z0-9_]`, such as the `-` an order id allows.
pub fn invalid_account_id() -> impl Strategy<Value = String> + Clone {
    prop_oneof![
        Just(String::new()),
        "[A-Za-z0-9_]{65,80}",
        (
            "[A-Za-z0-9_]{0,30}",
            "[-./: é\\\\\"\n]",
            "[A-Za-z0-9_]{0,30}"
        )
            .prop_map(|(a, bad, b)| format!("{a}{bad}{b}")),
    ]
}

pub fn venue() -> impl Strategy<Value = Venue> + Clone {
    select(Venue::ALL.to_vec())
}

pub fn venue_status_kind() -> impl Strategy<Value = VenueStatusKind> + Clone {
    select(vec![
        VenueStatusKind::Connected,
        VenueStatusKind::Connecting,
        VenueStatusKind::Stale,
        VenueStatusKind::Down,
        VenueStatusKind::Disabled,
    ])
}

pub fn pair_health() -> impl Strategy<Value = PairHealth> + Clone {
    select(vec![PairHealth::Ok, PairHealth::Stale, PairHealth::Suspect])
}

pub fn ticker() -> impl Strategy<Value = Ticker> + Clone {
    (
        (any_price(), any_price(), any_price(), any_price()),
        option::of(any_qty()),
        any::<i32>(),
        any::<bool>(),
    )
        .prop_map(
            |((open, high, low, last), volume, change_bps, partial)| Ticker {
                open,
                high,
                low,
                last,
                volume,
                change_bps,
                partial,
            },
        )
}

pub fn timeframe() -> impl Strategy<Value = Timeframe> + Clone {
    select(Timeframe::ALL.to_vec())
}

pub fn side() -> impl Strategy<Value = Side> + Clone {
    prop_oneof![Just(Side::Buy), Just(Side::Sell)]
}

/// Every [`OrderKind`] variant, with prices drawn from `price`.
pub fn order_kind<S>(price: S) -> impl Strategy<Value = OrderKind> + Clone
where
    S: Strategy<Value = Price> + Clone + 'static,
{
    prop_oneof![
        Just(OrderKind::Market),
        price.clone().prop_map(|price| OrderKind::Limit { price }),
        price.prop_map(|stop_price| OrderKind::Stop { stop_price }),
    ]
}

pub fn bar() -> impl Strategy<Value = Bar> + Clone {
    (
        any_time(),
        any_price(),
        any_price(),
        any_price(),
        any_price(),
        any_qty(),
    )
        .prop_map(|(t, open, high, low, close, volume)| Bar {
            t,
            open,
            high,
            low,
            close,
            volume,
        })
}

pub fn level() -> impl Strategy<Value = Level> + Clone {
    (any_price(), any_qty()).prop_map(|(price, qty)| Level { price, qty })
}

pub fn indicator_values() -> impl Strategy<Value = IndicatorValues> + Clone {
    let v = || option::of(finite_f64());
    (v(), v(), v(), v(), v(), v(), v(), v()).prop_map(
        |(ema, sma, vwap, bb_upper, bb_mid, bb_lower, rsi, atr)| IndicatorValues {
            ema,
            sma,
            vwap,
            bb_upper,
            bb_mid,
            bb_lower,
            rsi,
            atr,
        },
    )
}

pub fn order_status() -> impl Strategy<Value = OrderStatus> + Clone {
    select(vec![
        OrderStatus::Accepted,
        OrderStatus::Canceled,
        OrderStatus::Filled,
    ])
}

pub fn error_code() -> impl Strategy<Value = ErrorCode> + Clone {
    select(vec![
        ErrorCode::InvalidJson,
        ErrorCode::InvalidCommand,
        ErrorCode::InvalidMessage,
        ErrorCode::OutOfRange,
        ErrorCode::UnknownSymbol,
        ErrorCode::InvalidFixture,
        ErrorCode::FeedDisconnected,
        ErrorCode::InvalidBookDelta,
        ErrorCode::Internal,
    ])
}

pub fn notice_kind() -> impl Strategy<Value = NoticeKind> + Clone {
    select(vec![
        NoticeKind::AccountReset,
        NoticeKind::EngineDown,
        NoticeKind::EngineUp,
        NoticeKind::AiDisabled,
        NoticeKind::AuthFailed,
        NoticeKind::SessionExpired,
        NoticeKind::SignedOut,
        NoticeKind::SlowClient,
        NoticeKind::ProviderChanged,
    ])
}

pub fn provider_id() -> impl Strategy<Value = ProviderId> + Clone {
    select(vec![
        ProviderId::Openai,
        ProviderId::Anthropic,
        ProviderId::Nvidia,
        ProviderId::Ollama,
    ])
}

pub fn copilot_action() -> impl Strategy<Value = CopilotAction> + Clone {
    select(vec![
        CopilotAction::Analyze,
        CopilotAction::Ask,
        CopilotAction::CreateStrategy,
        CopilotAction::Scan,
    ])
}

pub fn analysis_bias() -> impl Strategy<Value = AnalysisBias> + Clone {
    select(vec![
        AnalysisBias::Long,
        AnalysisBias::Short,
        AnalysisBias::Neutral,
    ])
}

pub fn twap_status() -> impl Strategy<Value = TwapStatus> + Clone {
    select(vec![
        TwapStatus::Active,
        TwapStatus::Done,
        TwapStatus::Canceled,
    ])
}

pub fn ai_error_reason() -> impl Strategy<Value = AiErrorReason> + Clone {
    select(vec![
        AiErrorReason::AiDisabled,
        AiErrorReason::AiRateLimit,
        AiErrorReason::AiDailyCap,
        AiErrorReason::ProviderError,
        AiErrorReason::ValidationError,
        AiErrorReason::Timeout,
        AiErrorReason::Canceled,
    ])
}

pub fn provider_info() -> impl Strategy<Value = ProviderInfo> + Clone {
    (provider_id(), free_text(), option::of(free_text()))
        .prop_map(|(id, model, reason)| ProviderInfo { id, model, reason })
}

pub fn venue_status_entry() -> impl Strategy<Value = VenueStatusEntry> + Clone {
    (venue(), venue_status_kind()).prop_map(|(venue, status)| VenueStatusEntry { venue, status })
}

pub fn trade_idea() -> impl Strategy<Value = TradeIdea> + Clone {
    (side(), any_qty(), order_kind(any_price()))
        .prop_map(|(side, qty, kind)| TradeIdea { side, qty, kind })
}

pub fn analysis_result() -> impl Strategy<Value = AnalysisResult> + Clone {
    (
        free_text(),
        free_text(),
        analysis_bias(),
        any::<u16>(),
        vec(free_text(), 0..4),
        option::of(trade_idea()),
    )
        .prop_map(
            |(symbol, summary, bias, confidence_bps, rationale, suggested_order)| AnalysisResult {
                symbol,
                summary,
                bias,
                confidence_bps,
                rationale,
                suggested_order,
            },
        )
}

pub fn scan_item() -> impl Strategy<Value = ScanItem> + Clone {
    (free_text(), analysis_bias(), any::<u16>(), free_text()).prop_map(
        |(symbol, bias, confidence_bps, summary)| ScanItem {
            symbol,
            bias,
            confidence_bps,
            summary,
        },
    )
}

pub fn news_item() -> impl Strategy<Value = NewsItem> + Clone {
    (
        free_text(),
        free_text(),
        free_text(),
        free_text(),
        any_time(),
        vec(free_text(), 0..4),
    )
        .prop_map(
            |(id, title, source, url, published_at, symbols)| NewsItem {
                id,
                title,
                source,
                url,
                published_at,
                symbols,
            },
        )
}

pub fn data_mode() -> impl Strategy<Value = DataMode> + Clone {
    prop_oneof![Just(DataMode::Replay), Just(DataMode::Live)]
}

/// A symbol from the instrument table.
pub fn known_symbol() -> impl Strategy<Value = String> + Clone {
    select(
        INSTRUMENTS
            .iter()
            .map(|i| i.symbol.to_owned())
            .collect::<Vec<_>>(),
    )
}

/// A fixture name matching `^[a-z0-9-]+\.jsonl$`.
pub fn fixture_name() -> impl Strategy<Value = String> + Clone {
    "[a-z0-9-]{1,40}\\.jsonl"
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

/// Every Command variant with any well-typed field values, including out-of-range ones such as
/// unknown symbols, non-positive quantities, and any replay speed.
pub fn any_command() -> impl Strategy<Value = Command> {
    prop_oneof![
        (venue(), free_text(), timeframe()).prop_map(|(venue, symbol, timeframe)| {
            Command::Subscribe {
                venue,
                symbol,
                timeframe,
            }
        }),
        (venue(), free_text(), timeframe()).prop_map(|(venue, symbol, timeframe)| {
            Command::Unsubscribe {
                venue,
                symbol,
                timeframe,
            }
        }),
        (free_text(), venue())
            .prop_map(|(symbol, venue)| Command::SubscribeTicker { symbol, venue }),
        (free_text(), venue())
            .prop_map(|(symbol, venue)| Command::UnsubscribeTicker { symbol, venue }),
        (
            account_id(),
            venue(),
            order_id(),
            free_text(),
            side(),
            any_qty(),
            order_kind(any_price())
        )
            .prop_map(|(account_id, venue, order_id, symbol, side, qty, kind)| {
                Command::PlaceOrder {
                    account_id,
                    venue,
                    order_id,
                    symbol,
                    side,
                    qty,
                    kind,
                }
            }),
        (account_id(), order_id()).prop_map(|(account_id, order_id)| Command::Cancel {
            account_id,
            order_id
        }),
        account_id().prop_map(|account_id| Command::CancelAll { account_id }),
        (free_text(), any::<u32>())
            .prop_map(|(fixture, speed)| Command::StartReplay { fixture, speed }),
        account_id().prop_map(|account_id| Command::ResetAccount { account_id }),
        any::<u64>().prop_map(|id| Command::Ping { id }),
    ]
}

/// Every Command variant with field values that pass the codec's range rules.
pub fn valid_command() -> impl Strategy<Value = Command> {
    prop_oneof![
        (venue(), known_symbol(), timeframe()).prop_map(|(venue, symbol, timeframe)| {
            Command::Subscribe {
                venue,
                symbol,
                timeframe,
            }
        }),
        (venue(), known_symbol(), timeframe()).prop_map(|(venue, symbol, timeframe)| {
            Command::Unsubscribe {
                venue,
                symbol,
                timeframe,
            }
        }),
        (known_symbol(), venue())
            .prop_map(|(symbol, venue)| Command::SubscribeTicker { symbol, venue }),
        (known_symbol(), venue())
            .prop_map(|(symbol, venue)| Command::UnsubscribeTicker { symbol, venue }),
        (
            account_id(),
            venue(),
            order_id(),
            known_symbol(),
            side(),
            positive_qty(),
            order_kind(positive_price())
        )
            .prop_map(|(account_id, venue, order_id, symbol, side, qty, kind)| {
                Command::PlaceOrder {
                    account_id,
                    venue,
                    order_id,
                    symbol,
                    side,
                    qty,
                    kind,
                }
            }),
        (account_id(), order_id()).prop_map(|(account_id, order_id)| Command::Cancel {
            account_id,
            order_id
        }),
        account_id().prop_map(|account_id| Command::CancelAll { account_id }),
        (fixture_name(), MIN_REPLAY_SPEED..=MAX_REPLAY_SPEED)
            .prop_map(|(fixture, speed)| Command::StartReplay { fixture, speed }),
        account_id().prop_map(|account_id| Command::ResetAccount { account_id }),
        any::<u64>().prop_map(|id| Command::Ping { id }),
    ]
}

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------

/// Every Event variant with any well-typed field values.
pub fn any_event() -> impl Strategy<Value = Event> + Clone {
    prop_oneof![
        (
            venue(),
            free_text(),
            timeframe(),
            any::<bool>(),
            vec(bar(), 0..6),
            option::of(vec(
                (any_time(), indicator_values())
                    .prop_map(|(t, values)| IndicatorPoint { t, values }),
                0..6
            ))
        )
            .prop_map(|(venue, symbol, timeframe, snapshot, bars, indicators)| {
                Event::Candle {
                    venue,
                    symbol,
                    timeframe,
                    snapshot,
                    bars,
                    indicators,
                }
            }),
        (
            venue(),
            free_text(),
            any_price(),
            any_qty(),
            side(),
            any::<bool>(),
            any_time()
        )
            .prop_map(|(venue, symbol, price, qty, side, synthetic, ts)| {
                Event::Trade {
                    venue,
                    symbol,
                    price,
                    qty,
                    side,
                    synthetic,
                    ts,
                }
            }),
        (
            (venue(), free_text()),
            vec(level(), 0..6),
            vec(level(), 0..6),
            option::of(any_price()),
            any::<i32>(),
            any::<bool>(),
            any_time(),
        )
            .prop_map(
                |((venue, symbol), bids, asks, spread, imbalance_bps, synthetic, ts)| {
                    Event::Book {
                        venue,
                        symbol,
                        bids,
                        asks,
                        spread,
                        imbalance_bps,
                        synthetic,
                        ts,
                    }
                }
            ),
        (
            venue(),
            free_text(),
            timeframe(),
            any_time(),
            indicator_values()
        )
            .prop_map(|(venue, symbol, timeframe, ts, values)| Event::Indicators {
                venue,
                symbol,
                timeframe,
                ts,
                values,
            }),
        (account_id(), venue(), order_id(), order_status()).prop_map(
            |(account_id, venue, order_id, status)| Event::OrderAck {
                account_id,
                venue,
                order_id,
                status,
            }
        ),
        (account_id(), venue(), order_id(), free_text()).prop_map(
            |(account_id, venue, order_id, reason)| Event::OrderRejected {
                account_id,
                venue,
                order_id,
                reason,
            }
        ),
        (
            (account_id(), venue()),
            order_id(),
            free_text(),
            side(),
            any_price(),
            any_qty(),
            any_money(),
            (any_qty(), any_time()),
        )
            .prop_map(
                |((account_id, venue), order_id, symbol, side, price, qty, fee, (remaining, ts))| {
                    Event::Fill {
                        account_id,
                        venue,
                        order_id,
                        symbol,
                        side,
                        price,
                        qty,
                        fee,
                        remaining,
                        ts,
                    }
                }
            ),
        (
            account_id(),
            free_text(),
            any_qty(),
            option::of(any_price()),
            any_money(),
            any_money(),
        )
            .prop_map(
                |(account_id, symbol, qty, avg_entry, realized, unrealized)| Event::Position {
                    account_id,
                    symbol,
                    qty,
                    avg_entry,
                    realized,
                    unrealized,
                }
            ),
        (
            free_text(),
            venue(),
            ticker(),
            any::<bool>(),
            any_time()
        )
            .prop_map(|(symbol, venue, ticker, synthetic, ts)| Event::Ticker24h {
                symbol,
                venue,
                ticker,
                synthetic,
                ts,
            }),
        (venue(), venue_status_kind(), any_time())
            .prop_map(|(venue, status, ts)| Event::VenueStatus { venue, status, ts }),
        (venue(), free_text(), pair_health(), any_time()).prop_map(
            |(venue, symbol, health, ts)| Event::PairStatus {
                venue,
                symbol,
                health,
                ts,
            }
        ),
        (free_text(), option::of(venue()))
            .prop_map(|(symbol, venue)| Event::ReferenceVenue { symbol, venue }),
        (
            account_id(),
            any_money(),
            any_money(),
            any_money(),
            any_time()
        )
            .prop_map(
                |(account_id, paper_balance, free_balance, equity, ts)| Event::Balance {
                    account_id,
                    paper_balance,
                    free_balance,
                    equity,
                    ts,
                }
            ),
        any_time().prop_map(|ts| Event::Heartbeat { ts }),
        any::<u64>().prop_map(|id| Event::Pong { id }),
        (error_code(), free_text()).prop_map(|(code, message)| Event::Error { code, message }),
    ]
}

/// A [`WireEvent`]: any Event with or without an `emit_us`.
pub fn wire_event() -> impl Strategy<Value = WireEvent> + Clone {
    (any_event(), option::of(any::<u64>()))
        .prop_map(|(event, emit_us)| WireEvent { event, emit_us })
}

// ---------------------------------------------------------------------------------------------
// Client and server messages
// ---------------------------------------------------------------------------------------------

/// Every ClientMessage variant with any well-typed field values.
pub fn any_client_message() -> impl Strategy<Value = ClientMessage> {
    prop_oneof![
        (venue(), free_text(), timeframe()).prop_map(|(venue, symbol, timeframe)| {
            ClientMessage::Subscribe {
                venue,
                symbol,
                timeframe,
            }
        }),
        (venue(), free_text(), timeframe()).prop_map(|(venue, symbol, timeframe)| {
            ClientMessage::Unsubscribe {
                venue,
                symbol,
                timeframe,
            }
        }),
        (free_text(), venue())
            .prop_map(|(symbol, venue)| ClientMessage::SubscribeTicker { symbol, venue }),
        (free_text(), venue())
            .prop_map(|(symbol, venue)| ClientMessage::UnsubscribeTicker { symbol, venue }),
        (free_text(), free_text(), option::of(venue())).prop_map(|(request_id, text, venue)| {
            ClientMessage::CommandText {
                request_id,
                text,
                venue,
            }
        }),
        (free_text(), free_text())
            .prop_map(|(request_id, twap_id)| ClientMessage::CancelTwap { request_id, twap_id }),
        provider_id().prop_map(|provider| ClientMessage::SetProvider { provider }),
        (
            free_text(),
            copilot_action(),
            long_text(),
            free_text(),
            timeframe(),
            venue()
        )
            .prop_map(
                |(request_id, action, text, symbol, timeframe, venue)| ClientMessage::AiRequest {
                    request_id,
                    action,
                    text,
                    symbol,
                    timeframe,
                    venue,
                }
            ),
        free_text().prop_map(|request_id| ClientMessage::AiCancel { request_id }),
        Just(ClientMessage::SubscribeNews),
        Just(ClientMessage::UnsubscribeNews),
        (free_text(), free_text()).prop_map(|(request_id, preview_id)| ClientMessage::Confirm {
            request_id,
            preview_id,
        }),
        free_text().prop_map(|preview_id| ClientMessage::Discard { preview_id }),
        (free_text(), order_id()).prop_map(|(request_id, order_id)| ClientMessage::Cancel {
            request_id,
            order_id
        }),
        free_text().prop_map(|request_id| ClientMessage::CancelAll { request_id }),
        free_text().prop_map(|request_id| ClientMessage::FlattenAll { request_id }),
        free_text().prop_map(|request_id| ClientMessage::ResetAccount { request_id }),
        long_text().prop_map(|token| ClientMessage::Authenticate { token }),
        any::<u64>().prop_map(|id| ClientMessage::Ping { id }),
    ]
}

/// Every PreviewAction variant.
pub fn preview_action() -> impl Strategy<Value = PreviewAction> + Clone {
    prop_oneof![
        (
            free_text(),
            venue(),
            side(),
            any_qty(),
            order_kind(any_price())
        )
            .prop_map(|(symbol, venue, side, qty, kind)| PreviewAction::Place {
                symbol,
                venue,
                side,
                qty,
                kind,
            }),
        (
            free_text(),
            side(),
            venue(),
            any_qty(),
            any::<u32>(),
            any::<u32>()
        )
            .prop_map(
                |(symbol, side, venue, total_qty, slices, interval_s)| PreviewAction::Twap {
                    symbol,
                    side,
                    venue,
                    total_qty,
                    slices,
                    interval_s,
                }
            ),
        Just(PreviewAction::CancelAll),
        Just(PreviewAction::FlattenAll),
    ]
}

pub fn order_preview() -> impl Strategy<Value = OrderPreview> + Clone {
    (free_text(), free_text(), preview_action(), any_time()).prop_map(
        |(preview_id, text, action, expires_at)| OrderPreview {
            preview_id,
            text,
            action,
            expires_at,
        },
    )
}

pub fn instrument_info() -> impl Strategy<Value = InstrumentInfo> + Clone {
    (
        free_text(),
        free_text(),
        any::<u32>(),
        any::<u32>(),
        free_text(),
        vec(venue(), 0..5),
    )
        .prop_map(
            |(symbol, short, price_decimals, qty_decimals, reference_price, venues)| {
                InstrumentInfo {
                    symbol,
                    short,
                    price_decimals,
                    qty_decimals,
                    reference_price,
                    venues,
                }
            },
        )
}

/// Every ServerMessage variant with any well-typed field values.
pub fn any_server_message() -> impl Strategy<Value = ServerMessage> {
    prop_oneof![
        (
            (any::<u32>(), data_mode(), vec(venue(), 0..5)),
            vec(venue_status_entry(), 0..5),
            (venue(), any_money(), any::<bool>()),
            vec(instrument_info(), 0..4),
            (vec(provider_info(), 0..4), any::<bool>()),
        )
            .prop_map(
                |(
                    (protocol_version, data_mode, live_venues),
                    venue_status,
                    (default_venue, starting_balance, engine_running),
                    instruments,
                    (providers, news_enabled),
                )| {
                    ServerMessage::Hello {
                        protocol_version,
                        data_mode,
                        live_venues,
                        venue_status,
                        default_venue,
                        starting_balance,
                        engine_running,
                        instruments,
                        providers,
                        news_enabled,
                    }
                }
            ),
        any_event().prop_map(|event| ServerMessage::Event { event }),
        vec(wire_event(), 0..4).prop_map(|events| ServerMessage::EventBatch { events }),
        (
            vec(provider_info(), 0..4),
            option::of(provider_id()),
            option::of(provider_id())
        )
            .prop_map(
                |(available, default, selected)| ServerMessage::Providers {
                    available,
                    default,
                    selected,
                }
            ),
        (
            (free_text(), provider_id(), free_text()),
            analysis_result(),
            option::of(order_preview()),
            option::of(
                (free_text(), any::<usize>())
                    .prop_map(|(message, position)| PreviewError { message, position })
            ),
        )
            .prop_map(
                |((request_id, provider, model), analysis, preview, preview_error)| {
                    ServerMessage::Analysis {
                        request_id,
                        provider,
                        model,
                        analysis,
                        preview,
                        preview_error,
                    }
                }
            ),
        (free_text(), vec(scan_item(), 0..4))
            .prop_map(|(request_id, items)| ServerMessage::ScanResult { request_id, items }),
        (free_text(), long_text())
            .prop_map(|(request_id, text)| ServerMessage::StrategyDraft { request_id, text }),
        (free_text(), ai_error_reason(), free_text()).prop_map(|(request_id, reason, message)| {
            ServerMessage::AiError {
                request_id,
                reason,
                message,
            }
        }),
        (
            any::<bool>(),
            vec(news_item(), 0..4),
            option::of(any_time())
        )
            .prop_map(
                |(available, items, updated_at)| ServerMessage::News {
                    available,
                    items,
                    updated_at,
                }
            ),
        (
            (free_text(), free_text(), side(), venue()),
            (any::<u32>(), any::<u32>(), twap_status()),
            option::of(free_text()),
        )
            .prop_map(
                |((twap_id, symbol, side, venue), (slices, sent, status), reason)| {
                    ServerMessage::Twap {
                        twap_id,
                        symbol,
                        side,
                        venue,
                        slices,
                        sent,
                        status,
                        reason,
                    }
                }
            ),
        (free_text(), order_preview()).prop_map(|(request_id, preview)| ServerMessage::Preview {
            request_id,
            preview
        }),
        (free_text(), free_text(), any::<usize>()).prop_map(|(request_id, message, position)| {
            ServerMessage::ParseError {
                request_id,
                message,
                position,
            }
        }),
        (notice_kind(), free_text())
            .prop_map(|(kind, message)| ServerMessage::Notice { kind, message }),
        (account_id(), option::of(free_text())).prop_map(|(account_id, address)| {
            ServerMessage::Session {
                account_id,
                address,
            }
        }),
        any::<u64>().prop_map(|id| ServerMessage::Pong { id }),
    ]
}
