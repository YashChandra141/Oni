//! JSON-lines wire codec (Req 2.1, 2.2) and Command range validation (Req 2.4, 2.5, 4.2).
//!
//! Every message is one UTF-8 JSON object followed by `\n`. [`decode_command`] parses an engine
//! input line and then checks field ranges, so the engine core only ever sees valid Commands.
//! Each failure is a [`DecodeError`] that the engine turns into an `error` event with
//! [`DecodeError::to_event`] before it moves on to the next line.

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::error::Category;
use thiserror::Error;

use crate::command::Command;
use crate::error::ProtocolError;
use crate::event::{ErrorCode, Event};
use crate::instrument::instrument;
use crate::types::OrderKind;

/// Longest Command line [`decode_command`] accepts, in bytes, not counting the line terminator.
///
/// The longest valid Command is far below 1 KiB: order ids have at most 64 characters, and
/// symbols and fixture names are short. 64 KiB leaves plenty of headroom and caps the work spent
/// on one hostile or corrupt line. The check runs before parsing and reports `out_of_range`,
/// because the length of the line is the value outside its valid range. The engine's stdin
/// reader should bound its own buffer as well; this check does not limit how much a reader
/// allocates before it calls [`decode_command`].
pub const MAX_LINE_BYTES: usize = 64 * 1024;

/// Longest Event line the server accepts from the engine's stdout, in bytes. The server's
/// engine-stdout reader uses the same value. A snapshot of 500 bars and 500 indicator points
/// must fit.
pub const MAX_EVENT_LINE_BYTES: usize = 512 * 1024;

/// Slowest replay speed a `start_replay` Command may request (Req 6.3, 6.4).
pub const MIN_REPLAY_SPEED: u32 = 1;

/// Fastest replay speed a `start_replay` Command may request (Req 6.3, 6.4).
pub const MAX_REPLAY_SPEED: u32 = 50;

/// Most characters of a user-supplied value that an error message repeats.
const MAX_ECHO_CHARS: usize = 80;

/// Upper bound on the length of a message built from a serde error, in characters. It backstops
/// [`MAX_ECHO_CHARS`] when a quoted value contains its own closing delimiter.
const MAX_DETAIL_CHARS: usize = 400;

/// Longest `error` event message [`DecodeError::to_event`] produces, in characters, including
/// any `…` it appends (Req 2.4, 2.5).
const MAX_MESSAGE_CHARS: usize = 400;

/// Suffix appended to a value shortened to [`MAX_ECHO_CHARS`].
const ELLIPSIS: char = '…';

/// Why an input line was not accepted. Messages repeat at most about 80 characters of any
/// user-supplied value, counted after escaping, and [`DecodeError::to_event`] caps the whole
/// message at 400 characters, so a hostile line cannot produce an unbounded `error` event.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum DecodeError {
    /// The line is longer than [`MAX_LINE_BYTES`].
    #[error("line is {len} bytes, longer than the limit of {max} bytes", max = MAX_LINE_BYTES)]
    LineTooLong { len: usize },

    /// The line is not valid JSON (Req 2.4). Holds serde's description, with quoted values
    /// shortened.
    #[error("invalid JSON: {0}")]
    InvalidJson(String),

    /// The line is JSON but does not match the expected message type, for example an unknown
    /// `type` tag, a missing or mistyped field, or a malformed order id (Req 2.4).
    #[error("JSON does not match the expected message: {0}")]
    Mismatch(String),

    /// A Command names a symbol that is not in the instrument table (Req 4.2). Holds the symbol,
    /// shortened to about 80 characters.
    #[error("unknown symbol {0:?}")]
    UnknownSymbol(String),

    /// A numeric field is outside its valid range (Req 2.5, 6.4).
    #[error("{field} is {value}, expected {expected}")]
    OutOfRange {
        field: &'static str,
        value: i64,
        expected: &'static str,
    },

    /// A `start_replay` fixture name does not match `^[a-z0-9-]+\.jsonl$` (Req 6.5). Holds the
    /// name, shortened to about 80 characters.
    #[error("invalid fixture name {0:?}: expected a name matching [a-z0-9-]+.jsonl")]
    InvalidFixture(String),
}

impl DecodeError {
    /// The `error` event code for this failure.
    pub fn code(&self) -> ErrorCode {
        match self {
            Self::LineTooLong { .. } | Self::OutOfRange { .. } => ErrorCode::OutOfRange,
            Self::InvalidJson(_) => ErrorCode::InvalidJson,
            Self::Mismatch(_) => ErrorCode::InvalidCommand,
            Self::UnknownSymbol(_) => ErrorCode::UnknownSymbol,
            Self::InvalidFixture(_) => ErrorCode::InvalidFixture,
        }
    }

    /// The `error` event the engine emits for this failure (Req 2.4, 2.5). The message is at
    /// most 400 characters; a longer one is cut and ends with `…`.
    pub fn to_event(&self) -> Event {
        Event::Error {
            code: self.code(),
            message: truncate_chars(&self.to_string(), MAX_MESSAGE_CHARS - 1),
        }
    }

    /// Classifies a serde error from a single parse: syntax and end-of-input errors mean the
    /// line is not JSON; data errors mean it is JSON of the wrong shape.
    fn from_serde(err: &serde_json::Error) -> Self {
        let detail = bound_serde_message(&err.to_string());
        match err.classify() {
            Category::Data => Self::Mismatch(detail),
            Category::Syntax | Category::Eof | Category::Io => Self::InvalidJson(detail),
        }
    }
}

/// Serializes `msg` as one line of JSON followed by a single `\n` (Req 2.1).
///
/// Compact `serde_json` output escapes newlines inside strings, so the returned text contains
/// exactly one `\n`, at the end.
pub fn encode_line<T: Serialize>(msg: &T) -> Result<String, ProtocolError> {
    let mut line = serde_json::to_string(msg).map_err(|e| ProtocolError::Encode(e.to_string()))?;
    line.push('\n');
    Ok(line)
}

/// Parses one JSON line into any message type (Req 2.2). One trailing `\r\n` or `\n` is removed
/// first. No length limit or range check is applied; Commands go through [`decode_command`].
pub fn decode_line<T: DeserializeOwned>(line: &str) -> Result<T, DecodeError> {
    serde_json::from_str(trim_terminator(line)).map_err(|e| DecodeError::from_serde(&e))
}

/// Parses and validates one engine input line (Req 2.2, 2.4, 2.5, 4.2).
///
/// Checks, in order:
/// - the line, without its terminator, is at most [`MAX_LINE_BYTES`] long (`out_of_range`);
/// - it is JSON (`invalid_json`) that matches a Command variant (`invalid_command`);
/// - `subscribe`, `unsubscribe`, and `place_order` name a symbol in the instrument table
///   (`unknown_symbol`);
/// - `place_order` has `qty > 0`, a limit `price > 0`, or a stop `stop_price > 0`
///   (`out_of_range`);
/// - `start_replay` has a speed from 1 to 50 (`out_of_range`) and a fixture name matching
///   `^[a-z0-9-]+\.jsonl$` (`invalid_fixture`).
///
/// A speed that is negative or does not fit in `u32` fails the Command schema and reports
/// `invalid_command`. So does a missing `account_id` on an order Command, or one that is not
/// 1 to 64 characters of `[A-Za-z0-9_]` (Req 1.10, 2.5): [`AccountId`] validates while parsing,
/// as [`OrderId`] does, so no Command with a bad account id ever reaches the engine core.
///
/// [`AccountId`]: crate::AccountId
/// [`OrderId`]: crate::OrderId
pub fn decode_command(line: &str) -> Result<Command, DecodeError> {
    let line = trim_terminator(line);
    if line.len() > MAX_LINE_BYTES {
        return Err(DecodeError::LineTooLong { len: line.len() });
    }
    let command: Command = decode_line(line)?;
    validate(&command)?;
    Ok(command)
}

/// Whether `name` matches `^[a-z0-9-]+\.jsonl$`: a bare fixture file name, never a path.
pub fn is_valid_fixture_name(name: &str) -> bool {
    let allowed = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-';
    name.strip_suffix(".jsonl")
        .is_some_and(|stem| !stem.is_empty() && stem.bytes().all(allowed))
}

fn trim_terminator(line: &str) -> &str {
    line.strip_suffix("\r\n")
        .or_else(|| line.strip_suffix('\n'))
        .unwrap_or(line)
}

fn validate(command: &Command) -> Result<(), DecodeError> {
    match command {
        Command::Subscribe { symbol, .. }
        | Command::Unsubscribe { symbol, .. }
        | Command::SubscribeTicker { symbol, .. }
        | Command::UnsubscribeTicker { symbol, .. } => known_symbol(symbol),
        Command::PlaceOrder {
            symbol, qty, kind, ..
        } => {
            known_symbol(symbol)?;
            positive("qty", qty.0)?;
            match kind {
                OrderKind::Market => Ok(()),
                OrderKind::Limit { price } => positive("price", price.0),
                OrderKind::Stop { stop_price } => positive("stop_price", stop_price.0),
            }
        }
        Command::StartReplay { fixture, speed } => {
            if !(MIN_REPLAY_SPEED..=MAX_REPLAY_SPEED).contains(speed) {
                return Err(DecodeError::OutOfRange {
                    field: "speed",
                    value: i64::from(*speed),
                    expected: "1 to 50",
                });
            }
            if !is_valid_fixture_name(fixture) {
                return Err(DecodeError::InvalidFixture(shorten(fixture)));
            }
            Ok(())
        }
        // The account id was validated while parsing (`AccountId` refuses bad ids).
        Command::Cancel { .. }
        | Command::CancelAll { .. }
        | Command::ResetAccount { .. }
        | Command::Ping { .. } => Ok(()),
    }
}

fn known_symbol(symbol: &str) -> Result<(), DecodeError> {
    if instrument(symbol).is_some() {
        Ok(())
    } else {
        Err(DecodeError::UnknownSymbol(shorten(symbol)))
    }
}

fn positive(field: &'static str, value: i64) -> Result<(), DecodeError> {
    if value > 0 {
        Ok(())
    } else {
        Err(DecodeError::OutOfRange {
            field,
            value,
            expected: "greater than 0",
        })
    }
}

/// Cuts `s` to at most `max_chars` characters on a char boundary, appending `…` if it cut.
fn truncate_chars(s: &str, max_chars: usize) -> String {
    match s.char_indices().nth(max_chars) {
        Some((cut, _)) => {
            let mut out = s.get(..cut).unwrap_or(s).to_owned();
            out.push(ELLIPSIS);
            out
        }
        None => s.to_owned(),
    }
}

/// Shortens a value that a message repeats with `{:?}`, so that its escaped form is at most
/// [`MAX_ECHO_CHARS`] characters, appending `…` if it cut. Escapes such as `\u{1b}` count at
/// their full length; `char::escape_debug` is an upper bound on what `str`'s `Debug` writes.
fn shorten(value: &str) -> String {
    let mut width = 0_usize;
    for (i, c) in value.char_indices() {
        width += c.escape_debug().count();
        if width > MAX_ECHO_CHARS {
            let mut out = value.get(..i).unwrap_or(value).to_owned();
            out.push(ELLIPSIS);
            return out;
        }
    }
    value.to_owned()
}

/// Shortens every quoted value in a serde error message to [`MAX_ECHO_CHARS`] characters, then
/// caps the whole message at [`MAX_DETAIL_CHARS`].
///
/// serde quotes input values either in backticks (`` unknown variant `x` ``) or as Rust string
/// literals (`invalid value: string "x"`), where `\"` does not end the literal.
fn bound_serde_message(msg: &str) -> String {
    let mut out = String::with_capacity(msg.len().min(MAX_DETAIL_CHARS));
    // The delimiter that closes the quoted value being copied, if any.
    let mut open: Option<char> = None;
    let mut quoted_chars = 0_usize;
    let mut escaped = false;
    for c in msg.chars() {
        let Some(close) = open else {
            out.push(c);
            if c == '`' || c == '"' {
                open = Some(c);
                quoted_chars = 0;
                escaped = false;
            }
            continue;
        };
        if c == close && !escaped {
            if quoted_chars > MAX_ECHO_CHARS {
                out.push(ELLIPSIS);
            }
            out.push(c);
            open = None;
            continue;
        }
        escaped = close == '"' && !escaped && c == '\\';
        quoted_chars += 1;
        if quoted_chars <= MAX_ECHO_CHARS {
            out.push(c);
        }
    }
    if open.is_some() && quoted_chars > MAX_ECHO_CHARS {
        out.push(ELLIPSIS);
    }
    truncate_chars(&out, MAX_DETAIL_CHARS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::num::{Price, Qty};
    use crate::types::{AccountId, OrderId, Side, Timeframe, Venue};

    fn err(line: &str) -> DecodeError {
        decode_command(line).unwrap_err()
    }

    fn code(line: &str) -> ErrorCode {
        err(line).code()
    }

    fn guest() -> AccountId {
        AccountId::new("guest").unwrap()
    }

    fn place_order(symbol: &str, qty: &str, kind: &str) -> String {
        let head = concat!(
            r#""type":"place_order","account_id":"guest","venue":"replay","#,
            r#""order_id":"o-1","side":"buy""#
        );
        format!(r#"{{{head},"symbol":"{symbol}","qty":"{qty}","kind":{kind}}}"#)
    }

    fn subscription(kind: &str, symbol: &str) -> String {
        format!(r#"{{"type":"{kind}","venue":"replay","symbol":"{symbol}","timeframe":"1m"}}"#)
    }

    fn replay(fixture: &str, speed: i64) -> String {
        format!(r#"{{"type":"start_replay","fixture":"{fixture}","speed":{speed}}}"#)
    }

    #[test]
    fn decodes_every_command_variant() {
        let cases = [
            (
                r#"{"type":"subscribe","venue":"replay","symbol":"BTC-USD","timeframe":"1m"}"#,
                Command::Subscribe {
                    venue: Venue::Replay,
                    symbol: "BTC-USD".into(),
                    timeframe: Timeframe::M1,
                },
            ),
            (
                r#"{"type":"unsubscribe","venue":"backpack","symbol":"SOL-USD","timeframe":"1d"}"#,
                Command::Unsubscribe {
                    venue: Venue::Backpack,
                    symbol: "SOL-USD".into(),
                    timeframe: Timeframe::D1,
                },
            ),
            (
                r#"{"type":"cancel","account_id":"guest","order_id":"o-1"}"#,
                Command::Cancel {
                    account_id: guest(),
                    order_id: OrderId::new("o-1").unwrap(),
                },
            ),
            (
                r#"{"type":"cancel_all","account_id":"guest"}"#,
                Command::CancelAll {
                    account_id: guest(),
                },
            ),
            (
                r#"{"type":"start_replay","fixture":"btc-2026-12-01.jsonl","speed":1}"#,
                Command::StartReplay {
                    fixture: "btc-2026-12-01.jsonl".into(),
                    speed: 1,
                },
            ),
            (
                r#"{"type":"start_replay","fixture":"demo.jsonl","speed":50}"#,
                Command::StartReplay {
                    fixture: "demo.jsonl".into(),
                    speed: 50,
                },
            ),
            (
                r#"{"type":"reset_account","account_id":"w_9WzDXwBbmkg8ZTbNMqUxvQRAyrZz"}"#,
                Command::ResetAccount {
                    account_id: AccountId::new("w_9WzDXwBbmkg8ZTbNMqUxvQRAyrZz").unwrap(),
                },
            ),
            (r#"{"type":"ping","id":7}"#, Command::Ping { id: 7 }),
        ];
        for (line, expected) in cases {
            assert_eq!(decode_command(line), Ok(expected.clone()), "{line}");
            let encoded = encode_line(&expected).unwrap();
            assert_eq!(decode_command(&encoded), Ok(expected), "{encoded}");
        }

        let kinds = [
            (r#"{"type":"market"}"#, OrderKind::Market),
            (
                r#"{"type":"limit","price":"6400000"}"#,
                OrderKind::Limit {
                    price: Price(6_400_000),
                },
            ),
            (
                r#"{"type":"stop","stop_price":"1"}"#,
                OrderKind::Stop {
                    stop_price: Price(1),
                },
            ),
        ];
        for (kind_json, kind) in kinds {
            let line = place_order("ETH-USD", "10", kind_json);
            let expected = Command::PlaceOrder {
                account_id: guest(),
                venue: Venue::Replay,
                order_id: OrderId::new("o-1").unwrap(),
                symbol: "ETH-USD".into(),
                side: Side::Buy,
                qty: Qty(10),
                kind,
            };
            assert_eq!(decode_command(&line), Ok(expected), "{line}");
        }
    }

    #[test]
    fn malformed_json_is_invalid_json() {
        for line in [
            "",
            "not json",
            r#"{"type":"ping","id":7"#,
            r#"{"type":"ping","id":}"#,
            r#"{"type":"ping","id":7} trailing"#,
        ] {
            assert_eq!(code(line), ErrorCode::InvalidJson, "{line:?}");
            assert!(err(line).to_string().starts_with("invalid JSON: "));
        }
    }

    #[test]
    fn json_matching_no_command_is_invalid_command() {
        for line in [
            "42",
            "[]",
            r#"{"id":1}"#,
            r#"{"type":"CancelAll"}"#,
            r#"{"type":"place_paper_order"}"#,
            r#"{"type":"ping"}"#,
            r#"{"type":"ping","id":"7"}"#,
            r#"{"type":"cancel","account_id":"guest","order_id":"a b"}"#,
            r#"{"type":"cancel","account_id":"guest","order_id":""}"#,
            r#"{"type":"subscribe","venue":"replay","symbol":"BTC-USD","timeframe":"2m"}"#,
            r#"{"type":"subscribe","venue":"binance","symbol":"BTC-USD","timeframe":"1m"}"#,
            r#"{"type":"subscribe","symbol":"BTC-USD","timeframe":"1m"}"#,
        ] {
            assert_eq!(code(line), ErrorCode::InvalidCommand, "{line}");
        }
        let built = [
            place_order("BTC-USD", "1.5", r#"{"type":"market"}"#),
            place_order("BTC-USD", "10", r#"{"type":"limit","price":5}"#),
            replay("demo.jsonl", -1),
        ];
        for line in &built {
            assert_eq!(code(line), ErrorCode::InvalidCommand, "{line}");
        }
    }

    /// Regression for Req 1.10 and 2.5: an order Command with a missing or malformed
    /// `account_id` becomes an `invalid_command` error event, and the engine moves on.
    #[test]
    fn bad_account_ids_are_invalid_command() {
        let too_long = "a".repeat(AccountId::MAX_LEN + 1);
        for id in ["", "guest-1", "a b", "é", "../x", too_long.as_str()] {
            let lines = [
                format!(r#"{{"type":"cancel_all","account_id":"{id}"}}"#),
                format!(r#"{{"type":"reset_account","account_id":"{id}"}}"#),
                format!(r#"{{"type":"cancel","account_id":"{id}","order_id":"o-1"}}"#),
                place_order("BTC-USD", "1", r#"{"type":"market"}"#).replace("guest", id),
            ];
            for line in &lines {
                let e = err(line);
                assert_eq!(e.code(), ErrorCode::InvalidCommand, "{line}");
                let Event::Error { code, message } = e.to_event() else {
                    panic!("not an error event");
                };
                assert_eq!(code, ErrorCode::InvalidCommand);
                assert!(message.contains("invalid account id"), "{message}");
            }
        }
        for line in [
            r#"{"type":"cancel_all"}"#,
            r#"{"type":"reset_account"}"#,
            r#"{"type":"cancel","order_id":"o-1"}"#,
            r#"{"type":"cancel_all","account_id":null}"#,
            r#"{"type":"cancel_all","account_id":7}"#,
        ] {
            assert_eq!(code(line), ErrorCode::InvalidCommand, "{line}");
        }
        let max = "Z".repeat(AccountId::MAX_LEN);
        let line = format!(r#"{{"type":"cancel_all","account_id":"{max}"}}"#);
        let expected = Command::CancelAll {
            account_id: AccountId::new(max).unwrap(),
        };
        assert_eq!(decode_command(&line), Ok(expected));
    }

    #[test]
    fn unknown_symbols_are_named() {
        for line in [
            subscription("subscribe", "DOGE-USD"),
            subscription("unsubscribe", "DOGE-USD"),
            place_order("DOGE-USD", "10", r#"{"type":"market"}"#),
        ] {
            let e = err(&line);
            assert_eq!(e, DecodeError::UnknownSymbol("DOGE-USD".into()));
            assert_eq!(e.code(), ErrorCode::UnknownSymbol);
            assert_eq!(e.to_string(), r#"unknown symbol "DOGE-USD""#);
        }
        // Short symbols are resolved by the command parser, not accepted by the engine.
        let short = subscription("subscribe", "BTC");
        assert_eq!(code(&short), ErrorCode::UnknownSymbol);
    }

    #[test]
    fn non_positive_order_values_are_out_of_range() {
        let cases = [
            ("0", r#"{"type":"market"}"#, "qty", 0),
            ("-1", r#"{"type":"limit","price":"5"}"#, "qty", -1),
            ("1", r#"{"type":"limit","price":"-5"}"#, "price", -5),
            ("1", r#"{"type":"stop","stop_price":"0"}"#, "stop_price", 0),
        ];
        for (qty, kind, field, value) in cases {
            let e = err(&place_order("BTC-USD", qty, kind));
            let expected = DecodeError::OutOfRange {
                field,
                value,
                expected: "greater than 0",
            };
            assert_eq!(e, expected);
            assert_eq!(e.code(), ErrorCode::OutOfRange);
        }
        let e = err(&place_order("BTC-USD", "0", r#"{"type":"market"}"#));
        assert_eq!(e.to_string(), "qty is 0, expected greater than 0");
    }

    #[test]
    fn replay_speed_outside_1_to_50_is_out_of_range() {
        for speed in [0, 51, i64::from(u32::MAX)] {
            let e = err(&replay("demo.jsonl", speed));
            assert_eq!(e.code(), ErrorCode::OutOfRange, "{speed}");
            let expected = format!("speed is {speed}, expected 1 to 50");
            assert_eq!(e.to_string(), expected);
        }
    }

    #[test]
    fn bad_fixture_names_are_invalid_fixture() {
        for name in [
            "",
            ".jsonl",
            "demo.json",
            "demo.JSONL",
            "Demo.jsonl",
            "../demo.jsonl",
            "a/b.jsonl",
            "a\\\\b.jsonl",
            "a b.jsonl",
            "a_b.jsonl",
            "a.jsonl.jsonl",
            "demo.jsonl.bak",
            "démo.jsonl",
        ] {
            let line = replay(name, 10);
            assert_eq!(code(&line), ErrorCode::InvalidFixture, "{name}");
        }
        assert!(is_valid_fixture_name("btc-usd-2026-12-01.jsonl"));
        assert!(is_valid_fixture_name("0.jsonl"));
        assert!(!is_valid_fixture_name("a\\b.jsonl"));
    }

    #[test]
    fn encode_line_ends_with_exactly_one_newline() {
        let command = Command::Subscribe {
            venue: Venue::Replay,
            symbol: "a\nb\r\nc".into(),
            timeframe: Timeframe::M1,
        };
        let event = Event::Error {
            code: ErrorCode::Internal,
            message: "line one\nline two".into(),
        };
        let lines = [encode_line(&command).unwrap(), encode_line(&event).unwrap()];
        for line in &lines {
            assert!(line.ends_with('\n'), "{line:?}");
            assert_eq!(line.matches('\n').count(), 1, "{line:?}");
            assert!(!line.contains('\r'), "{line:?}");
        }
        let cancel_all = Command::CancelAll {
            account_id: guest(),
        };
        assert_eq!(
            encode_line(&cancel_all).unwrap(),
            "{\"type\":\"cancel_all\",\"account_id\":\"guest\"}\n"
        );
        let event_line = encode_line(&event).unwrap();
        assert_eq!(decode_line::<Event>(&event_line), Ok(event));
    }

    #[test]
    fn trims_one_crlf_or_lf_terminator() {
        let ping = r#"{"type":"ping","id":3}"#;
        for line in [ping.to_owned(), format!("{ping}\n"), format!("{ping}\r\n")] {
            assert_eq!(decode_command(&line), Ok(Command::Ping { id: 3 }));
            assert_eq!(trim_terminator(&line), ping);
        }
        assert_eq!(trim_terminator("x\n\n"), "x\n");
        assert_eq!(trim_terminator("x\r\n\r\n"), "x\r\n");
        assert_eq!(trim_terminator("x\r"), "x\r");
    }

    #[test]
    fn lines_over_64_kib_are_out_of_range() {
        let ping = r#"{"type":"ping","id":1}"#;
        let padded = |len: usize| format!("{ping}{}", " ".repeat(len - ping.len()));

        let at_limit = padded(MAX_LINE_BYTES);
        assert_eq!(decode_command(&at_limit), Ok(Command::Ping { id: 1 }));
        // The terminator does not count toward the limit.
        let terminated = format!("{at_limit}\r\n");
        assert_eq!(decode_command(&terminated), Ok(Command::Ping { id: 1 }));

        let too_long = MAX_LINE_BYTES + 1;
        let e = err(&padded(too_long));
        assert_eq!(e, DecodeError::LineTooLong { len: too_long });
        assert_eq!(e.code(), ErrorCode::OutOfRange);
        let expected = "line is 65537 bytes, longer than the limit of 65536 bytes";
        assert_eq!(e.to_string(), expected);
    }

    #[test]
    fn long_unknown_symbol_is_truncated_on_a_char_boundary() {
        let symbol = "é".repeat(5_000);
        let e = err(&subscription("subscribe", &symbol));
        let shortened = format!("{}…", "é".repeat(MAX_ECHO_CHARS));
        assert_eq!(e, DecodeError::UnknownSymbol(shortened.clone()));
        let expected = format!("unknown symbol \"{shortened}\"");
        assert_eq!(e.to_string(), expected);

        let fixture = format!("{}.jsonl", "X".repeat(5_000));
        let message = err(&replay(&fixture, 1)).to_string();
        assert!(message.chars().count() < 200, "{message}");
        let kept = format!("{}…", "X".repeat(MAX_ECHO_CHARS));
        assert!(message.contains(&kept), "{message}");
    }

    #[test]
    fn serde_messages_do_not_echo_long_values() {
        let long = "z".repeat(10_000);
        let lines = [
            format!(r#"{{"type":"{long}"}}"#),
            format!(r#"{{"type":"cancel","account_id":"guest","order_id":"{long}"}}"#),
            format!(r#"{{"type":"cancel_all","account_id":"{long}"}}"#),
            format!(
                r#"{{"type":"subscribe","venue":"replay","symbol":"BTC-USD","timeframe":"{long}"}}"#
            ),
        ];
        let kept = format!("{}…", "z".repeat(MAX_ECHO_CHARS));
        let too_much = "z".repeat(MAX_ECHO_CHARS + 1);
        for line in &lines {
            let e = err(line);
            assert_eq!(e.code(), ErrorCode::InvalidCommand);
            let message = e.to_string();
            assert!(message.chars().count() <= 500, "{message}");
            assert!(message.contains(&kept), "{message}");
            assert!(!message.contains(&too_much), "{message}");
        }
        // Short values and serde's list of expected variants survive intact.
        let message = err(r#"{"type":"nope"}"#).to_string();
        assert!(message.contains("`nope`"), "{message}");
        assert!(message.contains("`place_order`"), "{message}");
    }

    #[test]
    fn bound_serde_message_respects_escaped_quotes() {
        let long = "q".repeat(100);
        let msg = format!(r#"invalid value: string "a\"{long}" at line 1"#);
        let bounded = bound_serde_message(&msg);
        let kept = format!(r#""a\"{}…" at line 1"#, "q".repeat(MAX_ECHO_CHARS - 3));
        assert!(bounded.ends_with(&kept), "{bounded}");
        let short = "unknown variant `ab`";
        assert_eq!(bound_serde_message(short), short);
    }

    /// Regression for a P2 counterexample: a symbol of control characters passed the 80-char
    /// echo limit, but `{:?}` escapes each one as `\n` or `\u{1b}`, so the message grew past
    /// 400 characters. The echo limit now counts escaped characters.
    #[test]
    fn escaped_echoes_stay_short() {
        let symbol = "\\u001b".repeat(100);
        let e = err(&subscription("subscribe", &symbol));
        let expected = format!("unknown symbol \"{}…\"", "\\u{1b}".repeat(13));
        assert_eq!(e.to_string(), expected);
        assert_eq!(
            e.to_event(),
            Event::Error {
                code: ErrorCode::UnknownSymbol,
                message: expected,
            }
        );

        let fixture = format!("{}.jsonl", "\\n".repeat(200));
        let message = err(&replay(&fixture, 1)).to_string();
        let kept = format!("\"{}…\"", "\\n".repeat(MAX_ECHO_CHARS / 2));
        assert!(message.contains(&kept), "{message}");
        assert!(message.chars().count() < 200, "{message}");
    }

    /// Regression for a P2 counterexample: a backtick inside an unknown `type` closes serde's
    /// quote early, so the rest of the value is copied unshortened. The 400-character cap on
    /// the detail plus the 42-character prefix gave a 442-character message. `to_event` now
    /// caps the whole message at 400 characters.
    #[test]
    fn to_event_caps_messages_at_400_chars() {
        let line = format!(r#"{{"type":"`{}"}}"#, "a".repeat(1_000));
        let e = err(&line);
        assert_eq!(e.code(), ErrorCode::InvalidCommand);
        assert!(e.to_string().chars().count() > MAX_MESSAGE_CHARS);
        let Event::Error { message, .. } = e.to_event() else {
            panic!("not an error event");
        };
        assert_eq!(message.chars().count(), MAX_MESSAGE_CHARS);
        assert!(message.ends_with(ELLIPSIS), "{message}");
        assert!(message.starts_with("JSON does not match the expected message: "));
    }

    #[test]
    fn to_event_wraps_code_and_message() {
        let e = DecodeError::UnknownSymbol("DOGE-USD".into());
        let expected = Event::Error {
            code: ErrorCode::UnknownSymbol,
            message: "unknown symbol \"DOGE-USD\"".into(),
        };
        assert_eq!(e.to_event(), expected);
        let line = encode_line(&err("{").to_event()).unwrap();
        let prefix = r#"{"type":"error","code":"invalid_json","message":"#;
        assert!(line.starts_with(prefix), "{line}");
    }
}
