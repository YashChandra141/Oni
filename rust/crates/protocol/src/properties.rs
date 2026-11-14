//! Property tests P1 and P2 from the design's property table (Task 2.4).
//!
//! - P1: every Command, Event, ClientMessage, and ServerMessage survives a JSON-lines round
//!   trip, and every valid Command passes [`decode_command`] (Req 2.3).
//! - P2: [`decode_command`] never panics on arbitrary input. Every failure becomes a bounded,
//!   single-line `error` event, and every success satisfies the range rules (Req 2.4, 2.5).
//!
//! Each property runs proptest's default 256 cases.

use std::fmt::Debug;

use proptest::collection::{btree_map, vec};
use proptest::option;
use proptest::prelude::*;
use proptest::sample::{Index, select};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

use crate::client::{ClientMessage, DataMode, NoticeKind, ServerMessage};
use crate::codec::{decode_command, decode_line, encode_line};
use crate::command::Command;
use crate::event::{ErrorCode, Event, IndicatorValues};
use crate::strategies::{
    SPECIAL_CHARS, account_id, any_client_message, any_command, any_event, any_server_message,
    finite_f64, fixture_name, free_text, invalid_account_id, known_symbol, long_text, order_id,
    timeframe, valid_command, venue,
};
use crate::types::{AccountId, OrderKind, Venue};

/// Longest `error` event message, in characters (Req 2.4, 2.5).
const MAX_ERROR_MESSAGE_CHARS: usize = 400;

// ---------------------------------------------------------------------------------------------
// Shared checks
// ---------------------------------------------------------------------------------------------

/// Asserts that `line` is one line: it ends with `\n` and contains no other `\n`.
fn assert_single_line(line: &str) -> Result<(), TestCaseError> {
    prop_assert!(line.ends_with('\n'), "line does not end with \\n: {line:?}");
    prop_assert_eq!(line.matches('\n').count(), 1, "line: {:?}", line);
    Ok(())
}

/// Encodes `msg`, checks the single-line guarantee, decodes it, and checks the result equals
/// `msg`. Re-encoding the decoded value must give the same bytes, which also catches float
/// values that are `==` but differ in bits, such as `0.0` and `-0.0`.
fn assert_round_trip<T>(msg: &T) -> Result<(), TestCaseError>
where
    T: Serialize + DeserializeOwned + PartialEq + Debug,
{
    let line = encode_line(msg).unwrap();
    assert_single_line(&line)?;
    let decoded: T = decode_line(&line).unwrap();
    prop_assert_eq!(&decoded, msg, "line: {:?}", line);
    prop_assert_eq!(encode_line(&decoded).unwrap(), line);
    Ok(())
}

/// The bit patterns of every indicator value, for a comparison that does not rely on `f64 ==`.
fn indicator_bits(values: &IndicatorValues) -> [Option<u64>; 8] {
    [
        values.ema,
        values.sma,
        values.vwap,
        values.bb_upper,
        values.bb_mid,
        values.bb_lower,
        values.rsi,
        values.atr,
    ]
    .map(|v| v.map(f64::to_bits))
}

/// Asserts that the indicator values of `original` survive the round trip bit for bit.
fn assert_indicator_bits(original: &Event) -> Result<(), TestCaseError> {
    if let Event::Indicators { values, .. } = original {
        let decoded: Event = decode_line(&encode_line(original).unwrap()).unwrap();
        let Event::Indicators {
            values: decoded_values,
            ..
        } = decoded
        else {
            return Err(TestCaseError::fail("indicators decoded as another variant"));
        };
        prop_assert_eq!(indicator_bits(&decoded_values), indicator_bits(values));
    }
    Ok(())
}

/// The range rules of Req 2.5, 4.2, and 6.4, written independently of the codec.
fn satisfies_range_rules(command: &Command) -> bool {
    let known = |s: &str| ["BTC-USD", "ETH-USD", "SOL-USD"].contains(&s);
    let fixture_ok = |name: &str| {
        name.strip_suffix(".jsonl").is_some_and(|stem| {
            !stem.is_empty()
                && stem
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        })
    };
    match command {
        Command::Subscribe { symbol, .. } | Command::Unsubscribe { symbol, .. } => known(symbol),
        Command::PlaceOrder {
            symbol, qty, kind, ..
        } => {
            let price_ok = match kind {
                OrderKind::Market => true,
                OrderKind::Limit { price } => price.0 > 0,
                OrderKind::Stop { stop_price } => stop_price.0 > 0,
            };
            known(symbol) && qty.0 > 0 && price_ok
        }
        Command::StartReplay { fixture, speed } => (1..=50).contains(speed) && fixture_ok(fixture),
        Command::Cancel { .. }
        | Command::CancelAll { .. }
        | Command::ResetAccount { .. }
        | Command::Ping { .. } => true,
    }
}

/// The account id rule of Req 1.10, written independently of `AccountId`.
fn account_id_ok(id: &str) -> bool {
    (1..=64).contains(&id.chars().count())
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// The account id of an order Command, if it has one.
fn command_account_id(command: &Command) -> Option<&str> {
    match command {
        Command::PlaceOrder { account_id, .. }
        | Command::Cancel { account_id, .. }
        | Command::CancelAll { account_id }
        | Command::ResetAccount { account_id } => Some(account_id.as_str()),
        Command::Subscribe { .. }
        | Command::Unsubscribe { .. }
        | Command::StartReplay { .. }
        | Command::Ping { .. } => None,
    }
}

/// Whether `event` is one of the four account Events that carry an `account_id` (Req 1.9).
fn event_has_account_id(event: &Event) -> bool {
    matches!(
        event,
        Event::OrderAck { .. }
            | Event::OrderRejected { .. }
            | Event::Fill { .. }
            | Event::Position { .. }
    )
}

/// Whether `message` carries an `account_id`: a `session`, or an `event` wrapping an account
/// Event (Req 1.8, 1.9).
fn server_message_has_account_id(message: &ServerMessage) -> bool {
    match message {
        ServerMessage::Session { .. } => true,
        ServerMessage::Event { event } => event_has_account_id(event),
        ServerMessage::Hello { .. }
        | ServerMessage::Preview { .. }
        | ServerMessage::ParseError { .. }
        | ServerMessage::Notice { .. }
        | ServerMessage::Pong { .. } => false,
    }
}

/// Replaces the `account_id` of a JSON message with `replacement`, or removes it when
/// `replacement` is `None`. Looks at the top level and inside the `event` field of a wrapped
/// Server_Message. Returns whether the message had an `account_id`.
fn replace_account_id(value: &mut Value, replacement: Option<&str>) -> bool {
    let Value::Object(object) = value else {
        return false;
    };
    if object.contains_key("account_id") {
        match replacement {
            Some(id) => object.insert("account_id".to_owned(), Value::from(id)),
            None => object.remove("account_id"),
        };
        return true;
    }
    match object.get_mut("event") {
        Some(inner) => replace_account_id(inner, replacement),
        None => false,
    }
}

/// Runs [`decode_command`] on `line` and checks the P2 guarantees for whatever it returns.
fn assert_decode_is_well_behaved(line: &str) -> Result<(), TestCaseError> {
    match decode_command(line) {
        Ok(command) => {
            prop_assert!(
                satisfies_range_rules(&command),
                "accepted {command:?} from {line:?}"
            );
            if let Some(id) = command_account_id(&command) {
                prop_assert!(
                    account_id_ok(id),
                    "accepted account id {id:?} from {line:?}"
                );
            }
            let encoded = encode_line(&command).unwrap();
            prop_assert_eq!(decode_command(&encoded), Ok(command));
        }
        Err(err) => {
            let event = err.to_event();
            let Event::Error { code, message } = &event else {
                return Err(TestCaseError::fail(format!(
                    "not an error event: {event:?}"
                )));
            };
            prop_assert_eq!(*code, err.code());
            let chars = message.chars().count();
            prop_assert!(
                chars <= MAX_ERROR_MESSAGE_CHARS,
                "message has {chars} chars: {message:?} (input {line:?})"
            );
            assert_single_line(&encode_line(&event).unwrap())?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// JSON-shaped fuzz input
// ---------------------------------------------------------------------------------------------

const COMMAND_TAGS: &[&str] = &[
    "subscribe",
    "unsubscribe",
    "place_order",
    "cancel",
    "cancel_all",
    "start_replay",
    "reset_account",
    "ping",
];

const COMMAND_FIELDS: &[&str] = &[
    "type",
    "account_id",
    "symbol",
    "timeframe",
    "order_id",
    "side",
    "qty",
    "kind",
    "fixture",
    "speed",
    "id",
    "price",
    "stop_price",
];

const KIND_TAGS: &[&str] = &["market", "limit", "stop", "Limit", "stop_limit"];

/// Strings longer than the 80-character echo limit, made of characters that need escaping or
/// that close serde's quotes. They stress the bound on `error` event messages.
fn echo_stress() -> impl Strategy<Value = String> + Clone {
    prop_oneof![
        (select(SPECIAL_CHARS), 81..400_usize).prop_map(|(c, n)| c.to_string().repeat(n)),
        vec(select(SPECIAL_CHARS), 81..400).prop_map(String::from_iter),
    ]
}

/// Strings that sit on or near the boundaries of the Command schema and range rules.
fn interesting_string() -> impl Strategy<Value = String> + Clone {
    prop_oneof![
        echo_stress(),
        known_symbol(),
        Just("BTC".to_owned()),
        Just("btc-usd".to_owned()),
        timeframe().prop_map(|tf| tf.as_str().to_owned()),
        select(vec!["buy", "sell", "BUY", ""]).prop_map(|s: &str| s.to_owned()),
        select(COMMAND_TAGS).prop_map(|s: &str| s.to_owned()),
        select(KIND_TAGS).prop_map(|s: &str| s.to_owned()),
        any::<i64>().prop_map(|n| n.to_string()),
        (-3_i64..=3).prop_map(|n| n.to_string()),
        select(vec![
            "9223372036854775808",
            "-9223372036854775809",
            "-0",
            "+1",
            " 1",
            "1.5",
            "1e3",
            "0x10",
        ])
        .prop_map(|s: &str| s.to_owned()),
        order_id().prop_map(|id| id.as_str().to_owned()),
        account_id().prop_map(|id| id.as_str().to_owned()),
        invalid_account_id(),
        fixture_name(),
        Just("../demo.jsonl".to_owned()),
    ]
}

/// A JSON scalar: null, booleans, integers across the i64 and u64 ranges, finite floats,
/// numbers near the replay speed range, free text, and boundary strings.
fn json_leaf() -> impl Strategy<Value = Value> + Clone {
    prop_oneof![
        Just(Value::Null),
        any::<bool>().prop_map(Value::from),
        any::<i64>().prop_map(Value::from),
        any::<u64>().prop_map(Value::from),
        finite_f64().prop_map(Value::from),
        (-3_i64..=60).prop_map(Value::from),
        long_text().prop_map(Value::from),
        interesting_string().prop_map(Value::from),
    ]
}

/// A Command field name or junk.
fn field_name() -> impl Strategy<Value = String> + Clone {
    prop_oneof![
        4 => select(COMMAND_FIELDS).prop_map(|s: &str| s.to_owned()),
        1 => free_text(),
    ]
}

/// Any JSON value, nested up to three levels, with object keys drawn from the Command fields.
fn json_value() -> impl Strategy<Value = Value> + Clone {
    json_leaf().prop_recursive(3, 24, 4, |inner| {
        prop_oneof![
            vec(inner.clone(), 0..4).prop_map(Value::Array),
            btree_map(field_name(), inner, 0..4)
                .prop_map(|fields| Value::Object(fields.into_iter().collect())),
        ]
    })
}

/// An order-kind-shaped object: a real or junk `type` with random `price` and `stop_price`.
fn kind_object() -> impl Strategy<Value = Value> + Clone {
    (
        prop_oneof![
            3 => select(KIND_TAGS).prop_map(Value::from),
            1 => json_leaf(),
        ],
        option::of(json_value()),
        option::of(json_value()),
    )
        .prop_map(|(tag, price, stop_price)| {
            let mut kind = Map::new();
            kind.insert("type".to_owned(), tag);
            if let Some(price) = price {
                kind.insert("price".to_owned(), price);
            }
            if let Some(stop_price) = stop_price {
                kind.insert("stop_price".to_owned(), stop_price);
            }
            Value::Object(kind)
        })
}

fn field_value() -> impl Strategy<Value = Value> + Clone {
    prop_oneof![
        4 => json_value(),
        1 => kind_object(),
        1 => echo_stress().prop_map(Value::from),
    ]
}

/// A JSON object whose `type` is a real Command tag, junk, or missing, with random fields.
fn command_shaped_object() -> impl Strategy<Value = Value> {
    let tag = prop_oneof![
        3 => select(COMMAND_TAGS).prop_map(Value::from),
        1 => free_text().prop_map(Value::from),
        1 => echo_stress().prop_map(Value::from),
        1 => json_value(),
    ];
    (
        option::weighted(0.9, tag),
        btree_map(field_name(), field_value(), 0..8),
    )
        .prop_map(|(tag, fields)| {
            let mut object: Map<String, Value> = fields.into_iter().collect();
            if let Some(tag) = tag {
                object.insert("type".to_owned(), tag);
            }
            Value::Object(object)
        })
}

/// A valid Command as JSON with one change: a field replaced, a field removed, or a field of
/// the nested order kind replaced. Changes like these probe each range rule at its edges.
fn mutated_valid_command() -> impl Strategy<Value = Value> {
    (valid_command(), any::<Index>(), 0_u8..3, field_value()).prop_map(
        |(command, index, op, value)| {
            let mut json = serde_json::to_value(&command).unwrap();
            if let Value::Object(object) = &mut json {
                mutate(object, &index, op, value);
            }
            json
        },
    )
}

/// Applies one change to a Command object. `op` 0 replaces a field, 1 removes a field, and 2
/// replaces a field of the nested order kind (or a top-level field if there is no kind).
fn mutate(object: &mut Map<String, Value>, index: &Index, op: u8, value: Value) {
    if op == 2
        && let Some(Value::Object(kind)) = object.get_mut("kind")
    {
        let keys: Vec<String> = kind.keys().cloned().collect();
        kind.insert(index.get(&keys).clone(), value);
        return;
    }
    let keys: Vec<String> = object.keys().cloned().collect();
    let key = index.get(&keys).clone();
    if op == 1 {
        object.remove(&key);
    } else {
        object.insert(key, value);
    }
}

/// Serializes `value` as one line, then sometimes cuts it short at a char boundary (making it
/// invalid JSON) or appends a `\n` or `\r\n` terminator.
fn as_line(value: Value, cut: Option<Index>, terminator: &'static str) -> String {
    let mut line = serde_json::to_string(&value).unwrap();
    if let Some(cut) = cut {
        let boundaries: Vec<usize> = line.char_indices().map(|(i, _)| i).collect();
        if !boundaries.is_empty() {
            line.truncate(*cut.get(&boundaries));
        }
    }
    line.push_str(terminator);
    line
}

fn line_from<S>(values: S) -> impl Strategy<Value = String>
where
    S: Strategy<Value = Value>,
{
    (
        values,
        option::weighted(0.15, any::<Index>()),
        select(vec!["", "", "\n", "\r\n"]),
    )
        .prop_map(|(value, cut, terminator)| as_line(value, cut, terminator))
}

// ---------------------------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------------------------

proptest! {
    // Property P1 — validates Req 2.3
    #[test]
    fn p1_command_round_trips(command in any_command()) {
        assert_round_trip(&command)?;
    }

    // Property P1 — validates Req 2.3
    #[test]
    fn p1_valid_commands_pass_decode_command(command in valid_command()) {
        let line = encode_line(&command).unwrap();
        assert_single_line(&line)?;
        prop_assert_eq!(decode_command(&line), Ok(command));
    }

    // Property P1 — validates Req 2.3
    #[test]
    fn p1_event_round_trips(event in any_event()) {
        assert_round_trip(&event)?;
        assert_indicator_bits(&event)?;
    }

    // Property P1 — validates Req 2.3
    #[test]
    fn p1_client_message_round_trips(message in any_client_message()) {
        assert_round_trip(&message)?;
    }

    // Property P1 — validates Req 2.3
    #[test]
    fn p1_server_message_round_trips(message in any_server_message()) {
        assert_round_trip(&message)?;
        if let ServerMessage::Event { event } = &message {
            assert_indicator_bits(event)?;
        }
    }

    // Property P2 — validates Req 2.4, 2.5
    #[test]
    fn p2_arbitrary_strings_never_panic(
        line in prop_oneof![any::<String>(), long_text()],
    ) {
        assert_decode_is_well_behaved(&line)?;
    }

    // Property P2 — validates Req 2.4, 2.5
    #[test]
    fn p2_arbitrary_bytes_never_panic(bytes in vec(any::<u8>(), 0..512)) {
        assert_decode_is_well_behaved(&String::from_utf8_lossy(&bytes))?;
    }

    // Property P2 — validates Req 2.4, 2.5
    #[test]
    fn p2_command_shaped_json_never_panics(line in line_from(command_shaped_object())) {
        assert_decode_is_well_behaved(&line)?;
    }

    // Property P2 — validates Req 2.4, 2.5
    #[test]
    fn p2_mutated_valid_commands_never_panic(line in line_from(mutated_valid_command())) {
        assert_decode_is_well_behaved(&line)?;
    }

    // Property P2 — validates Req 1.10, 2.5
    // `AccountId` (constructor and deserializer) accepts a string exactly when it is 1 to 64
    // characters of `[A-Za-z0-9_]`, and an accepted id round-trips as a JSON string.
    #[test]
    fn p2_account_id_accepts_exactly_the_rule(
        id in prop_oneof![
            any::<String>(),
            free_text(),
            invalid_account_id(),
            account_id().prop_map(|id| id.as_str().to_owned()),
            "[A-Za-z0-9_-]{0,70}",
        ],
    ) {
        let expected = account_id_ok(&id);
        let constructed = AccountId::new(id.clone());
        prop_assert_eq!(constructed.is_ok(), expected, "id: {:?}", id);
        let json = serde_json::to_string(&id).unwrap();
        let parsed = serde_json::from_str::<AccountId>(&json);
        prop_assert_eq!(parsed.is_ok(), expected, "id: {:?}", id);
        if let Ok(account) = constructed {
            prop_assert_eq!(account.as_str(), id.as_str());
            assert_round_trip(&account)?;
        }
    }

    // Property P2 — validates Req 1.10, 2.4, 2.5
    // An otherwise valid order Command whose `account_id` is replaced by an invalid id, or
    // removed, is refused with an `invalid_command` error event.
    #[test]
    fn p2_order_commands_with_bad_account_ids_are_rejected(
        command in valid_command().prop_filter("order command", |c| command_account_id(c).is_some()),
        bad in option::of(invalid_account_id()),
    ) {
        let mut json = serde_json::to_value(&command).unwrap();
        let Value::Object(object) = &mut json else {
            return Err(TestCaseError::fail("command is not a JSON object"));
        };
        match &bad {
            Some(id) => object.insert("account_id".to_owned(), Value::from(id.as_str())),
            None => object.remove("account_id"),
        };
        let line = serde_json::to_string(&json).unwrap();
        let result = decode_command(&line);
        let Err(err) = &result else {
            return Err(TestCaseError::fail(format!("accepted {result:?} from {line:?}")));
        };
        prop_assert_eq!(err.code(), ErrorCode::InvalidCommand, "line: {:?}", line);
        assert_decode_is_well_behaved(&line)?;
    }

    // Property P1 — validates Req 1.9, 1.10, 2.3
    // An account Event whose `account_id` is replaced by an invalid id, or removed, no longer
    // decodes.
    #[test]
    fn p1_account_events_with_bad_account_ids_do_not_decode(
        event in any_event().prop_filter("account event", event_has_account_id),
        bad in option::of(invalid_account_id()),
    ) {
        let mut json = serde_json::to_value(&event).unwrap();
        prop_assert!(replace_account_id(&mut json, bad.as_deref()));
        let line = serde_json::to_string(&json).unwrap();
        prop_assert!(decode_line::<Event>(&line).is_err(), "decoded {:?}", line);
    }

    // Property P1 — validates Req 1.8, 1.9, 1.10, 2.3
    // The same holds for a `session` and for an account Event wrapped in a `event` message.
    #[test]
    fn p1_server_messages_with_bad_account_ids_do_not_decode(
        message in any_server_message()
            .prop_filter("account message", server_message_has_account_id),
        bad in option::of(invalid_account_id()),
    ) {
        let mut json = serde_json::to_value(&message).unwrap();
        prop_assert!(replace_account_id(&mut json, bad.as_deref()));
        let line = serde_json::to_string(&json).unwrap();
        prop_assert!(decode_line::<ServerMessage>(&line).is_err(), "decoded {:?}", line);
    }

    // Property P1 — validates Req 1.7, 1.8, 1.11, 2.3
    // The protocol v2 additions round-trip: `authenticate` with any token, `session` with and
    // without a wallet address, and `hello` that names the venue.
    #[test]
    fn p1_v2_additions_round_trip(
        token in long_text(),
        account in account_id(),
        address in option::of(free_text()),
        live_venue in venue(),
    ) {
        assert_round_trip(&ClientMessage::Authenticate { token })?;
        assert_round_trip(&ServerMessage::Session {
            account_id: account,
            address,
        })?;
        assert_round_trip(&ServerMessage::Hello {
            protocol_version: crate::PROTOCOL_VERSION,
            data_mode: DataMode::Live,
            venue: Some(live_venue),
            engine_running: true,
            instruments: Vec::new(),
        })?;
    }
}

/// The wire name of a notice kind, written out per variant so that a new variant breaks the
/// build of this test until it is listed here and in the expectations below.
fn notice_kind_wire_name(kind: NoticeKind) -> &'static str {
    match kind {
        NoticeKind::AccountReset => "account_reset",
        NoticeKind::EngineDown => "engine_down",
        NoticeKind::EngineUp => "engine_up",
        NoticeKind::LlmDisabled => "llm_disabled",
        NoticeKind::AuthFailed => "auth_failed",
        NoticeKind::SessionExpired => "session_expired",
        NoticeKind::SignedOut => "signed_out",
    }
}

fn venue_wire_name(venue: Venue) -> &'static str {
    match venue {
        Venue::Coinbase => "coinbase",
        Venue::Backpack => "backpack",
    }
}

// Property P1 — validates Req 1.7, 1.8, 1.11, 2.3
// Every notice kind and venue, including the ones added in protocol v2, has its snake_case wire
// name and round-trips inside the message that carries it.
#[test]
fn p1_every_notice_kind_and_venue_round_trips() {
    let kinds = [
        NoticeKind::AccountReset,
        NoticeKind::EngineDown,
        NoticeKind::EngineUp,
        NoticeKind::LlmDisabled,
        NoticeKind::AuthFailed,
        NoticeKind::SessionExpired,
        NoticeKind::SignedOut,
    ];
    for kind in kinds {
        let message = ServerMessage::Notice {
            kind,
            message: "m".to_owned(),
        };
        let expected = format!(
            r#"{{"type":"notice","kind":"{}","message":"m"}}"#,
            notice_kind_wire_name(kind)
        );
        assert_eq!(serde_json::to_string(&message).unwrap(), expected);
        assert_round_trip(&message).unwrap();
    }
    for venue in [Venue::Coinbase, Venue::Backpack] {
        let message = ServerMessage::Hello {
            protocol_version: crate::PROTOCOL_VERSION,
            data_mode: DataMode::Live,
            venue: Some(venue),
            engine_running: false,
            instruments: Vec::new(),
        };
        let expected = format!(
            r#"{{"type":"hello","protocol_version":2,"data_mode":"live","venue":"{}","engine_running":false,"instruments":[]}}"#,
            venue_wire_name(venue)
        );
        assert_eq!(serde_json::to_string(&message).unwrap(), expected);
        assert_round_trip(&message).unwrap();
    }
}
