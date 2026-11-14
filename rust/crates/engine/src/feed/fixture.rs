//! Fixture files: one `{"recv": TimeMs, "msg": MarketMsg}` JSON object per line (design §2
//! "Market feed", Req 7.1, 7.2, 7.3).
//!
//! `recv` is the time the Recorder received the message, in epoch ms. Replay derives its delays
//! from it (Req 6.3). `msg.ts` is the exchange time.
//!
//! Reading validates every line, so replay only ever sees sane market data:
//! - a line, without its `\n` or `\r\n` terminator, is at most [`MAX_LINE_BYTES`] bytes and is
//!   UTF-8 JSON matching [`FixtureLine`];
//! - the symbol is in the instrument table;
//! - a trade has `price > 0` and `qty > 0`;
//! - every book snapshot level has `qty > 0`;
//! - a book delta has `qty >= 0`. A negative delta is rejected when the fixture is read. The
//!   order book's own rule for negative deltas (Req 9.4: drop the delta and emit an error) is
//!   for live data; a fixture that holds one is corrupt, so the whole file is refused instead;
//! - `recv` never decreases from one line to the next.
//!
//! An empty file holds no lines. A blank line is an error. Errors name the 1-based line number.

use std::fmt;
use std::fs::{self, File};
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};

use protocol::{DecodeError, MAX_LINE_BYTES, TimeMs, decode_line, encode_line, instrument};
use serde::{Deserialize, Serialize};

use super::MarketMsg;

/// Most characters of a fixture value (after `{:?}` escaping) that an error message repeats.
const MAX_ECHO_CHARS: usize = 80;

/// One fixture line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FixtureLine {
    /// Receive time in epoch ms.
    pub recv: TimeMs,
    /// The normalized market data message.
    pub msg: MarketMsg,
}

/// Why one fixture line was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LineError {
    /// The line, without its terminator, is longer than [`MAX_LINE_BYTES`].
    TooLong { len: usize },
    /// The line is not UTF-8.
    InvalidUtf8,
    /// The line is not JSON, or is JSON that does not match [`FixtureLine`].
    Decode(DecodeError),
    /// The symbol is not in the instrument table. Holds the symbol, shortened to about 80
    /// characters.
    UnknownSymbol(String),
    /// A price or quantity is outside its valid range.
    OutOfRange {
        field: &'static str,
        value: i64,
        expected: &'static str,
    },
    /// `recv` is earlier than the previous line's `recv`.
    RecvDecreased { recv: TimeMs, previous: TimeMs },
}

impl fmt::Display for LineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooLong { len } => write!(
                f,
                "line is {len} bytes, longer than the limit of {MAX_LINE_BYTES} bytes"
            ),
            Self::InvalidUtf8 => f.write_str("line is not valid UTF-8"),
            Self::Decode(err) => fmt::Display::fmt(err, f),
            Self::UnknownSymbol(symbol) => write!(f, "unknown symbol {symbol:?}"),
            Self::OutOfRange {
                field,
                value,
                expected,
            } => write!(f, "{field} is {value}, expected {expected}"),
            Self::RecvDecreased { recv, previous } => write!(
                f,
                "recv {recv} is earlier than the previous line's recv {previous}"
            ),
        }
    }
}

impl std::error::Error for LineError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Decode(err) => Some(err),
            _ => None,
        }
    }
}

/// A fixture could not be read, decoded, or written.
#[derive(Debug)]
pub enum FixtureError {
    /// Reading or writing the file failed.
    Io {
        action: &'static str,
        path: PathBuf,
        source: io::Error,
    },
    /// A line could not be serialized.
    Encode(String),
    /// A line was refused. `line` is the 1-based line number, when known.
    Line {
        line: Option<usize>,
        reason: LineError,
    },
}

impl FixtureError {
    /// Attaches a 1-based line number to a line error. Other errors are returned unchanged.
    pub fn with_line(self, line: usize) -> Self {
        match self {
            Self::Line { reason, .. } => Self::Line {
                line: Some(line),
                reason,
            },
            other => other,
        }
    }

    /// The 1-based line number of a line error, when known.
    pub fn line(&self) -> Option<usize> {
        match self {
            Self::Line { line, .. } => *line,
            Self::Io { .. } | Self::Encode(_) => None,
        }
    }

    /// Why the line was refused, for a line error.
    // Only tests call this so far.
    #[allow(dead_code)]
    pub fn reason(&self) -> Option<&LineError> {
        match self {
            Self::Line { reason, .. } => Some(reason),
            Self::Io { .. } | Self::Encode(_) => None,
        }
    }
}

impl From<LineError> for FixtureError {
    fn from(reason: LineError) -> Self {
        Self::Line { line: None, reason }
    }
}

impl fmt::Display for FixtureError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io {
                action,
                path,
                source,
            } => write!(f, "cannot {action} {}: {source}", path.display()),
            Self::Encode(message) => write!(f, "cannot encode fixture line: {message}"),
            Self::Line {
                line: Some(line),
                reason,
            } => write!(f, "line {line}: {reason}"),
            Self::Line { line: None, reason } => fmt::Display::fmt(reason, f),
        }
    }
}

impl std::error::Error for FixtureError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            Self::Encode(_) => None,
            Self::Line { reason, .. } => Some(reason),
        }
    }
}

/// Serializes one fixture line as compact JSON followed by a single `\n` (Req 7.1).
///
/// The line is not validated; [`decode_fixture_line`] and [`read_fixture`] do that.
pub fn encode_fixture_line(line: &FixtureLine) -> Result<String, FixtureError> {
    encode_line(line).map_err(|err| FixtureError::Encode(err.to_string()))
}

/// Parses and validates one fixture line (Req 7.2). One trailing `\r\n` or `\n` is removed
/// first. Errors carry no line number; add one with [`FixtureError::with_line`].
///
/// The [`MAX_LINE_BYTES`] limit and the `recv` order are checked by [`parse_fixture`].
pub fn decode_fixture_line(text: &str) -> Result<FixtureLine, FixtureError> {
    let text = text
        .strip_suffix("\r\n")
        .or_else(|| text.strip_suffix('\n'))
        .unwrap_or(text);
    let line: FixtureLine = decode_line(text).map_err(LineError::Decode)?;
    validate(&line.msg)?;
    Ok(line)
}

/// Parses and validates the contents of a fixture file. See the module docs for the rules.
pub fn parse_fixture(bytes: &[u8]) -> Result<Vec<FixtureLine>, FixtureError> {
    let mut lines = Vec::new();
    let mut previous: Option<TimeMs> = None;
    for (index, raw) in bytes.split_inclusive(|&b| b == b'\n').enumerate() {
        let line = parse_one(raw, previous).map_err(|err| err.with_line(index + 1))?;
        previous = Some(line.recv);
        lines.push(line);
    }
    Ok(lines)
}

/// Reads, parses, and validates a fixture file.
pub fn read_fixture(path: impl AsRef<Path>) -> Result<Vec<FixtureLine>, FixtureError> {
    let path = path.as_ref();
    let bytes = fs::read(path).map_err(|source| FixtureError::Io {
        action: "read",
        path: path.to_path_buf(),
        source,
    })?;
    parse_fixture(&bytes)
}

/// Writes `lines` to a fixture file, replacing any existing file. The lines are not validated.
pub fn write_fixture(path: impl AsRef<Path>, lines: &[FixtureLine]) -> Result<(), FixtureError> {
    let path = path.as_ref();
    let io_error = |source: io::Error| FixtureError::Io {
        action: "write",
        path: path.to_path_buf(),
        source,
    };
    let mut out = BufWriter::new(File::create(path).map_err(io_error)?);
    for line in lines {
        let text = encode_fixture_line(line)?;
        out.write_all(text.as_bytes()).map_err(io_error)?;
    }
    out.flush().map_err(io_error)
}

fn parse_one(raw: &[u8], previous: Option<TimeMs>) -> Result<FixtureLine, FixtureError> {
    let raw = raw
        .strip_suffix(b"\r\n")
        .or_else(|| raw.strip_suffix(b"\n"))
        .unwrap_or(raw);
    if raw.len() > MAX_LINE_BYTES {
        return Err(LineError::TooLong { len: raw.len() }.into());
    }
    let text = std::str::from_utf8(raw).map_err(|_| LineError::InvalidUtf8)?;
    let line = decode_fixture_line(text)?;
    if let Some(previous) = previous
        && line.recv < previous
    {
        let recv = line.recv;
        return Err(LineError::RecvDecreased { recv, previous }.into());
    }
    Ok(line)
}

fn validate(msg: &MarketMsg) -> Result<(), LineError> {
    let symbol = msg.symbol();
    if instrument(symbol).is_none() {
        return Err(LineError::UnknownSymbol(shorten(symbol)));
    }
    match msg {
        MarketMsg::Trade { price, qty, .. } => {
            positive("trade price", price.0)?;
            positive("trade qty", qty.0)
        }
        MarketMsg::BookSnapshot { bids, asks, .. } => {
            for level in bids {
                positive("bid level qty", level.qty.0)?;
            }
            for level in asks {
                positive("ask level qty", level.qty.0)?;
            }
            Ok(())
        }
        MarketMsg::BookDelta { qty, .. } => {
            if qty.0 >= 0 {
                Ok(())
            } else {
                Err(LineError::OutOfRange {
                    field: "delta qty",
                    value: qty.0,
                    expected: "0 or greater",
                })
            }
        }
    }
}

fn positive(field: &'static str, value: i64) -> Result<(), LineError> {
    if value > 0 {
        Ok(())
    } else {
        Err(LineError::OutOfRange {
            field,
            value,
            expected: "greater than 0",
        })
    }
}

/// Shortens a value that a message repeats with `{:?}`, so its escaped form is at most
/// [`MAX_ECHO_CHARS`] characters, appending `…` if it cut.
fn shorten(value: &str) -> String {
    let mut width = 0_usize;
    for (i, c) in value.char_indices() {
        width += c.escape_debug().count();
        if width > MAX_ECHO_CHARS {
            let mut out = value.get(..i).unwrap_or(value).to_owned();
            out.push('…');
            return out;
        }
    }
    value.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::feed::strategies::valid_fixture_line;
    use proptest::prelude::*;
    use protocol::{Level, Price, Qty, Side};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn trade(recv: TimeMs, symbol: &str, price: i64, qty: i64) -> FixtureLine {
        FixtureLine {
            recv,
            msg: MarketMsg::Trade {
                symbol: symbol.into(),
                price: Price(price),
                qty: Qty(qty),
                side: Side::Buy,
                ts: recv - 1,
            },
        }
    }

    fn snapshot(recv: TimeMs, bids: &[(i64, i64)], asks: &[(i64, i64)]) -> FixtureLine {
        let levels = |levels: &[(i64, i64)]| {
            levels
                .iter()
                .map(|&(price, qty)| Level {
                    price: Price(price),
                    qty: Qty(qty),
                })
                .collect()
        };
        FixtureLine {
            recv,
            msg: MarketMsg::BookSnapshot {
                symbol: "ETH-USD".into(),
                bids: levels(bids),
                asks: levels(asks),
                ts: recv,
            },
        }
    }

    fn delta(recv: TimeMs, qty: i64) -> FixtureLine {
        FixtureLine {
            recv,
            msg: MarketMsg::BookDelta {
                symbol: "SOL-USD".into(),
                side: Side::Sell,
                price: Price(101),
                qty: Qty(qty),
                ts: recv,
            },
        }
    }

    fn encode(line: &FixtureLine) -> String {
        encode_fixture_line(line).unwrap()
    }

    /// The file contents for `lines`, each ending with `terminator`.
    fn file(lines: &[FixtureLine], terminator: &str) -> Vec<u8> {
        lines
            .iter()
            .map(|l| format!("{}{terminator}", encode(l).trim_end_matches('\n')))
            .collect::<String>()
            .into_bytes()
    }

    fn reason(err: &FixtureError) -> &LineError {
        err.reason()
            .unwrap_or_else(|| panic!("not a line error: {err}"))
    }

    fn decode_reason(line: &FixtureLine) -> LineError {
        let err = decode_fixture_line(&encode(line)).unwrap_err();
        assert_eq!(err.line(), None);
        reason(&err).clone()
    }

    fn out_of_range(field: &'static str, value: i64, expected: &'static str) -> LineError {
        LineError::OutOfRange {
            field,
            value,
            expected,
        }
    }

    /// A unique path under the temp directory, removed when dropped.
    struct TempFile(PathBuf);

    impl TempFile {
        fn new(tag: &str) -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let n = NEXT.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let pid = std::process::id();
            let name = format!("haunted-fixture-{tag}-{pid}-{nanos}-{n}.jsonl");
            Self(std::env::temp_dir().join(name))
        }
    }

    impl Drop for TempFile {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }

    #[test]
    fn encodes_the_documented_format() {
        let line = trade(5, "BTC-USD", 6_400_000, 1_000);
        let expected = concat!(
            r#"{"recv":5,"msg":{"type":"trade","symbol":"BTC-USD","price":"6400000","#,
            r#""qty":"1000","side":"buy","ts":4}}"#,
            "\n"
        );
        assert_eq!(encode(&line), expected);
    }

    #[test]
    fn decode_trims_one_lf_or_crlf_terminator() {
        let line = delta(7, 3);
        let bare = encode(&line).trim_end_matches('\n').to_owned();
        for text in [bare.clone(), format!("{bare}\n"), format!("{bare}\r\n")] {
            assert_eq!(decode_fixture_line(&text).unwrap(), line, "{text:?}");
        }
    }

    #[test]
    fn unknown_symbols_are_refused_and_named() {
        let err = decode_reason(&trade(1, "DOGE-USD", 1, 1));
        assert_eq!(err, LineError::UnknownSymbol("DOGE-USD".into()));
        assert_eq!(err.to_string(), r#"unknown symbol "DOGE-USD""#);
        let short = decode_reason(&trade(1, "BTC", 1, 1));
        assert_eq!(short, LineError::UnknownSymbol("BTC".into()));

        let long = decode_reason(&trade(1, &"x".repeat(500), 1, 1));
        let kept = format!("{}…", "x".repeat(MAX_ECHO_CHARS));
        assert_eq!(long, LineError::UnknownSymbol(kept));
    }

    #[test]
    fn trades_need_positive_price_and_qty() {
        let gt0 = "greater than 0";
        let cases = [
            (
                trade(1, "BTC-USD", 0, 1),
                out_of_range("trade price", 0, gt0),
            ),
            (
                trade(1, "BTC-USD", -5, 1),
                out_of_range("trade price", -5, gt0),
            ),
            (trade(1, "BTC-USD", 1, 0), out_of_range("trade qty", 0, gt0)),
            (
                trade(1, "BTC-USD", 1, -1),
                out_of_range("trade qty", -1, gt0),
            ),
        ];
        for (line, expected) in cases {
            assert_eq!(decode_reason(&line), expected, "{line:?}");
        }
        let err = decode_reason(&trade(1, "BTC-USD", 1, 0));
        assert_eq!(err.to_string(), "trade qty is 0, expected greater than 0");
        assert!(decode_fixture_line(&encode(&trade(1, "BTC-USD", 1, 1))).is_ok());
    }

    #[test]
    fn snapshot_levels_need_positive_qty() {
        let gt0 = "greater than 0";
        let bad_bid = snapshot(1, &[(100, 1), (99, 0)], &[(101, 1)]);
        let bad_ask = snapshot(1, &[(100, 1)], &[(101, -2)]);
        assert_eq!(
            decode_reason(&bad_bid),
            out_of_range("bid level qty", 0, gt0)
        );
        assert_eq!(
            decode_reason(&bad_ask),
            out_of_range("ask level qty", -2, gt0)
        );
        let empty = snapshot(1, &[], &[]);
        assert_eq!(decode_fixture_line(&encode(&empty)).unwrap(), empty);
    }

    #[test]
    fn deltas_need_non_negative_qty() {
        let expected = out_of_range("delta qty", -1, "0 or greater");
        assert_eq!(decode_reason(&delta(1, -1)), expected);
        for qty in [0, 1, i64::MAX] {
            let line = delta(1, qty);
            assert_eq!(decode_fixture_line(&encode(&line)).unwrap(), line);
        }
    }

    #[test]
    fn malformed_lines_are_decode_errors() {
        for text in [
            "",
            "not json",
            r#"{"recv":1}"#,
            r#"{"recv":"1","msg":{"type":"book_delta","symbol":"SOL-USD","side":"sell","price":"1","qty":"1","ts":1}}"#,
            r#"{"recv":1,"msg":{"type":"candle","symbol":"SOL-USD","ts":1}}"#,
        ] {
            let err = decode_fixture_line(text).unwrap_err();
            assert!(
                matches!(reason(&err), LineError::Decode(_)),
                "{text:?}: {err}"
            );
        }
    }

    #[test]
    fn empty_file_has_no_lines() {
        assert_eq!(parse_fixture(b"").unwrap(), Vec::new());
    }

    #[test]
    fn parses_lf_crlf_and_unterminated_files() {
        let lines = vec![
            trade(1, "BTC-USD", 10, 2),
            snapshot(1, &[(9, 1)], &[(11, 1)]),
            delta(5, 0),
        ];
        for terminator in ["\n", "\r\n"] {
            let bytes = file(&lines, terminator);
            assert_eq!(parse_fixture(&bytes).unwrap(), lines, "{terminator:?}");
        }
        let mut unterminated = file(&lines, "\n");
        unterminated.pop();
        assert_eq!(parse_fixture(&unterminated).unwrap(), lines);
    }

    #[test]
    fn recv_must_not_decrease() {
        let lines = [
            trade(10, "BTC-USD", 1, 1),
            trade(10, "BTC-USD", 1, 1),
            trade(9, "BTC-USD", 1, 1),
        ];
        let err = parse_fixture(&file(&lines, "\n")).unwrap_err();
        assert_eq!(err.line(), Some(3));
        let expected = LineError::RecvDecreased {
            recv: 9,
            previous: 10,
        };
        assert_eq!(reason(&err), &expected);
        assert_eq!(
            err.to_string(),
            "line 3: recv 9 is earlier than the previous line's recv 10"
        );
    }

    #[test]
    fn line_numbers_appear_in_error_messages() {
        let good = file(&[trade(1, "BTC-USD", 1, 1)], "\n");
        let with_second = |second: &[u8]| [good.as_slice(), second, b"\n".as_slice()].concat();

        let too_long = with_second(&vec![b' '; MAX_LINE_BYTES + 1]);
        let unknown = file(
            &[trade(1, "BTC-USD", 1, 1), trade(2, "XRP-USD", 1, 1)],
            "\n",
        );
        let cases: [(Vec<u8>, &str); 6] = [
            (
                too_long,
                "line 2: line is 65537 bytes, longer than the limit of 65536 bytes",
            ),
            (with_second(b"\xff\xfe"), "line 2: line is not valid UTF-8"),
            (with_second(b""), "line 2: invalid JSON: "),
            (with_second(b"{\"recv\":2}"), "line 2: JSON does not match"),
            (unknown, "line 2: unknown symbol \"XRP-USD\""),
            (
                file(&[trade(1, "BTC-USD", 1, 1), delta(2, -4)], "\r\n"),
                "line 2: delta qty is -4, expected 0 or greater",
            ),
        ];
        for (bytes, prefix) in cases {
            let err = parse_fixture(&bytes).unwrap_err();
            assert_eq!(err.line(), Some(2), "{err}");
            assert!(err.to_string().starts_with(prefix), "{err}");
        }
    }

    #[test]
    fn line_limit_excludes_the_terminator() {
        let line = encode(&trade(1, "BTC-USD", 1, 1));
        let json = line.trim_end_matches('\n');
        let padded = format!("{json}{}\r\n", " ".repeat(MAX_LINE_BYTES - json.len()));
        assert_eq!(parse_fixture(padded.as_bytes()).unwrap().len(), 1);
    }

    #[test]
    fn with_line_only_changes_line_errors() {
        let err = FixtureError::from(LineError::InvalidUtf8).with_line(4);
        assert_eq!(err.line(), Some(4));
        assert_eq!(err.to_string(), "line 4: line is not valid UTF-8");
        let encode = FixtureError::Encode("boom".into()).with_line(4);
        assert_eq!(encode.line(), None);
        assert_eq!(encode.to_string(), "cannot encode fixture line: boom");
    }

    #[test]
    fn write_then_read_round_trips_through_a_file() {
        let temp = TempFile::new("round-trip");
        let lines = vec![
            snapshot(100, &[(6_399_900, 5), (6_399_800, 1)], &[(6_400_100, 3)]),
            trade(100, "BTC-USD", 6_400_000, 1_000),
            delta(250, 0),
            trade(250, "SOL-USD", 15_000, 7),
        ];
        write_fixture(&temp.0, &lines).unwrap();
        assert_eq!(read_fixture(&temp.0).unwrap(), lines);
        let text = fs::read_to_string(&temp.0).unwrap();
        assert_eq!(text.lines().count(), lines.len());
        assert!(text.ends_with('\n'));

        write_fixture(&temp.0, &[]).unwrap();
        assert_eq!(read_fixture(&temp.0).unwrap(), Vec::new());

        let path = temp.0.clone();
        drop(temp);
        assert!(!path.exists());
    }

    #[test]
    fn reading_a_missing_file_is_an_io_error() {
        let temp = TempFile::new("missing");
        let err = read_fixture(&temp.0).unwrap_err();
        assert!(
            matches!(err, FixtureError::Io { action: "read", .. }),
            "{err}"
        );
        assert!(err.to_string().starts_with("cannot read "), "{err}");
    }

    // Property P3 — validates Req 7.3
    proptest! {
        #![proptest_config(ProptestConfig::with_cases(512))]

        /// **Validates: Requirements 7.3**
        ///
        /// For all valid fixture lines, encoding gives exactly one `\n`, at the end, and
        /// decoding the encoded text gives back the original line.
        #[test]
        fn p3_fixture_line_encode_decode_is_identity(line in valid_fixture_line()) {
            let encoded = encode_fixture_line(&line)
                .map_err(|e| TestCaseError::fail(e.to_string()))?;
            prop_assert!(encoded.ends_with('\n'), "{:?}", encoded);
            prop_assert_eq!(encoded.matches('\n').count(), 1, "{:?}", encoded);
            let decoded = decode_fixture_line(&encoded)
                .map_err(|e| TestCaseError::fail(e.to_string()))?;
            prop_assert_eq!(decoded, line);
        }
    }
}
