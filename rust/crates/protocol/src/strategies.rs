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
    ClientMessage, DataMode, InstrumentInfo, NoticeKind, OrderPreview, PreviewAction, ServerMessage,
};
use crate::command::Command;
use crate::event::{Bar, ErrorCode, Event, IndicatorValues, Level, OrderStatus};
use crate::instrument::INSTRUMENTS;
use crate::num::{Money, Price, Qty};
use crate::types::{AccountId, OrderId, OrderKind, Side, TimeMs, Timeframe, Venue};
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
    prop_oneof![Just(Venue::Coinbase), Just(Venue::Backpack)]
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
        NoticeKind::LlmDisabled,
        NoticeKind::AuthFailed,
        NoticeKind::SessionExpired,
        NoticeKind::SignedOut,
    ])
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
        (free_text(), timeframe())
            .prop_map(|(symbol, timeframe)| Command::Subscribe { symbol, timeframe }),
        (free_text(), timeframe())
            .prop_map(|(symbol, timeframe)| Command::Unsubscribe { symbol, timeframe }),
        (
            account_id(),
            order_id(),
            free_text(),
            side(),
            any_qty(),
            order_kind(any_price())
        )
            .prop_map(|(account_id, order_id, symbol, side, qty, kind)| {
                Command::PlaceOrder {
                    account_id,
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
        (known_symbol(), timeframe())
            .prop_map(|(symbol, timeframe)| Command::Subscribe { symbol, timeframe }),
        (known_symbol(), timeframe())
            .prop_map(|(symbol, timeframe)| Command::Unsubscribe { symbol, timeframe }),
        (
            account_id(),
            order_id(),
            known_symbol(),
            side(),
            positive_qty(),
            order_kind(positive_price())
        )
            .prop_map(|(account_id, order_id, symbol, side, qty, kind)| {
                Command::PlaceOrder {
                    account_id,
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
        (free_text(), timeframe(), any::<bool>(), vec(bar(), 0..6)).prop_map(
            |(symbol, timeframe, snapshot, bars)| Event::Candle {
                symbol,
                timeframe,
                snapshot,
                bars,
            }
        ),
        (free_text(), any_price(), any_qty(), side(), any_time()).prop_map(
            |(symbol, price, qty, side, ts)| Event::Trade {
                symbol,
                price,
                qty,
                side,
                ts,
            }
        ),
        (
            free_text(),
            vec(level(), 0..6),
            vec(level(), 0..6),
            option::of(any_price()),
            any::<i32>(),
            any_time(),
        )
            .prop_map(
                |(symbol, bids, asks, spread, imbalance_bps, ts)| Event::Book {
                    symbol,
                    bids,
                    asks,
                    spread,
                    imbalance_bps,
                    ts,
                }
            ),
        (free_text(), timeframe(), any_time(), indicator_values()).prop_map(
            |(symbol, timeframe, ts, values)| Event::Indicators {
                symbol,
                timeframe,
                ts,
                values,
            }
        ),
        (account_id(), order_id(), order_status()).prop_map(|(account_id, order_id, status)| {
            Event::OrderAck {
                account_id,
                order_id,
                status,
            }
        }),
        (account_id(), order_id(), free_text()).prop_map(|(account_id, order_id, reason)| {
            Event::OrderRejected {
                account_id,
                order_id,
                reason,
            }
        }),
        (
            account_id(),
            order_id(),
            free_text(),
            side(),
            any_price(),
            any_qty(),
            any_money(),
            (any_qty(), any_time()),
        )
            .prop_map(
                |(account_id, order_id, symbol, side, price, qty, fee, (remaining, ts))| {
                    Event::Fill {
                        account_id,
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
        any_time().prop_map(|ts| Event::Heartbeat { ts }),
        any::<u64>().prop_map(|id| Event::Pong { id }),
        (error_code(), free_text()).prop_map(|(code, message)| Event::Error { code, message }),
    ]
}

// ---------------------------------------------------------------------------------------------
// Client and server messages
// ---------------------------------------------------------------------------------------------

/// Every ClientMessage variant with any well-typed field values.
pub fn any_client_message() -> impl Strategy<Value = ClientMessage> {
    prop_oneof![
        (free_text(), timeframe())
            .prop_map(|(symbol, timeframe)| ClientMessage::Subscribe { symbol, timeframe }),
        (free_text(), timeframe())
            .prop_map(|(symbol, timeframe)| ClientMessage::Unsubscribe { symbol, timeframe }),
        (free_text(), free_text())
            .prop_map(|(request_id, text)| ClientMessage::CommandText { request_id, text }),
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
        (free_text(), side(), any_qty(), order_kind(any_price())).prop_map(
            |(symbol, side, qty, kind)| PreviewAction::Place {
                symbol,
                side,
                qty,
                kind,
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
    (free_text(), free_text(), any::<u32>(), any::<u32>()).prop_map(
        |(symbol, short, price_decimals, qty_decimals)| InstrumentInfo {
            symbol,
            short,
            price_decimals,
            qty_decimals,
        },
    )
}

/// Every ServerMessage variant with any well-typed field values.
pub fn any_server_message() -> impl Strategy<Value = ServerMessage> {
    prop_oneof![
        (
            any::<u32>(),
            data_mode(),
            option::of(venue()),
            any::<bool>(),
            vec(instrument_info(), 0..4)
        )
            .prop_map(
                |(protocol_version, data_mode, venue, engine_running, instruments)| {
                    ServerMessage::Hello {
                        protocol_version,
                        data_mode,
                        venue,
                        engine_running,
                        instruments,
                    }
                }
            ),
        any_event().prop_map(|event| ServerMessage::Event { event }),
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
