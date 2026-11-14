//! Pure normalization of Coinbase Advanced Trade public messages (Task 7.4, Req 5.1, 5.2, 44.1,
//! 44.4). No I/O and no clock reads.
//!
//! The WebSocket carries two data channels, `market_trades` and `level2` (message channel
//! `l2_data`). Both are turned into [`MarketMsg`] through the venue layer: symbols come from the
//! venue map, prices and quantities from the exact decimal converters. A value that does not fit
//! the fixed decimals is dropped and counted in [`DropStats`], never rounded.
//!
//! Unknown channels, unknown symbols, and the `heartbeats`, `subscriptions` and `ticker` style
//! messages are ignored without error. A server `{"type":"error"}` message is reported as
//! [`ParseError::Server`].
//!
//! No authentication appears here: subscribe messages carry no `jwt` field (trading-safety
//! rule 1).

// The adapter and the later runtime wiring call most of this; some items only tests use so far.
#![allow(dead_code)]

use protocol::{Bar, Level, Price, Qty, Side, TimeMs, Timeframe, Venue};
use serde::Deserialize;
use serde_json::Value;
use std::fmt;

use super::MarketMsg;
use super::venue::{
    DropStats, PRICE_DECIMALS, QTY_DECIMALS, VenueError, from_venue_symbol, to_lots, to_ticks,
};

const VENUE: Venue = Venue::Coinbase;

/// Why a message could not be normalized at all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    /// The text is not JSON of the expected shape.
    Json(String),
    /// The server sent an error message, for example a rejected subscribe.
    Server(String),
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Json(e) => write!(f, "unexpected message shape: {e}"),
            Self::Server(m) => write!(f, "server error: {m}"),
        }
    }
}

impl std::error::Error for ParseError {}

/// Builds the subscribe messages, one JSON text per channel: `market_trades`, `level2`, and
/// `heartbeats` (which keeps the connection open). `product_ids` are Coinbase product ids such as
/// `BTC-USD`. No `jwt` or any other auth field is included.
pub fn subscribe_messages(product_ids: &[&str]) -> Vec<String> {
    ["market_trades", "level2", "heartbeats"]
        .iter()
        .filter_map(|channel| {
            serde_json::to_string(&serde_json::json!({
                "type": "subscribe",
                "channel": channel,
                "product_ids": product_ids,
            }))
            .ok()
        })
        .collect()
}

/// The Coinbase REST `granularity` value of a timeframe.
pub fn granularity(timeframe: Timeframe) -> &'static str {
    match timeframe {
        Timeframe::M1 => "ONE_MINUTE",
        Timeframe::M5 => "FIVE_MINUTE",
        Timeframe::M15 => "FIFTEEN_MINUTE",
        Timeframe::H1 => "ONE_HOUR",
        Timeframe::D1 => "ONE_DAY",
    }
}

#[derive(Debug, Deserialize)]
struct Envelope {
    #[serde(default)]
    channel: String,
    #[serde(default, rename = "type")]
    kind: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    timestamp: String,
    #[serde(default)]
    events: Vec<Value>,
}

#[derive(Debug, Deserialize)]
struct TradesEvent {
    #[serde(default, rename = "type")]
    kind: String,
    #[serde(default)]
    trades: Vec<RawTrade>,
}

#[derive(Debug, Deserialize)]
struct RawTrade {
    product_id: String,
    price: String,
    size: String,
    side: String,
    time: String,
}

#[derive(Debug, Deserialize)]
struct BookEvent {
    #[serde(default, rename = "type")]
    kind: String,
    product_id: String,
    #[serde(default)]
    updates: Vec<RawUpdate>,
}

#[derive(Debug, Deserialize)]
struct RawUpdate {
    side: String,
    #[serde(default)]
    event_time: String,
    price_level: String,
    new_quantity: String,
}

/// Normalizes one WebSocket text frame into zero or more market messages.
///
/// Dropped values are counted in `stats`. Trade `snapshot` events (recent history sent on
/// subscribe) are skipped: they are not live prints and would move the last price backwards.
pub fn parse_message(text: &str, stats: &mut DropStats) -> Result<Vec<MarketMsg>, ParseError> {
    let env: Envelope = serde_json::from_str(text).map_err(|e| ParseError::Json(e.to_string()))?;
    if env.kind == "error" {
        return Err(ParseError::Server(env.message));
    }
    let Envelope {
        channel,
        timestamp,
        events,
        ..
    } = env;
    let mut out = Vec::new();
    match channel.as_str() {
        "market_trades" => {
            for value in events {
                let event: TradesEvent =
                    serde_json::from_value(value).map_err(|e| ParseError::Json(e.to_string()))?;
                trades_event(&event, stats, &mut out);
            }
        }
        "l2_data" | "level2" => {
            let envelope_ts = parse_rfc3339_ms(&timestamp);
            for value in events {
                let event: BookEvent =
                    serde_json::from_value(value).map_err(|e| ParseError::Json(e.to_string()))?;
                book_event(&event, envelope_ts, stats, &mut out);
            }
        }
        _ => {}
    }
    Ok(out)
}

/// Converts a price, counting the drop. Zero or negative prices are malformed.
fn price_of(text: &str, symbol: &str, stats: &mut DropStats) -> Option<Price> {
    match to_ticks(text, PRICE_DECIMALS) {
        Ok(price) if price.0 > 0 => Some(price),
        Ok(_) => {
            stats.record(VENUE, symbol, VenueError::Malformed);
            None
        }
        Err(err) => {
            stats.record(VENUE, symbol, err);
            None
        }
    }
}

/// Converts a quantity, counting the drop. `allow_zero` is true for book levels.
fn qty_of(text: &str, symbol: &str, allow_zero: bool, stats: &mut DropStats) -> Option<Qty> {
    match to_lots(text, QTY_DECIMALS) {
        Ok(qty) if qty.0 > 0 || (allow_zero && qty.0 == 0) => Some(qty),
        Ok(_) => {
            stats.record(VENUE, symbol, VenueError::Malformed);
            None
        }
        Err(err) => {
            stats.record(VENUE, symbol, err);
            None
        }
    }
}

fn trades_event(event: &TradesEvent, stats: &mut DropStats, out: &mut Vec<MarketMsg>) {
    if event.kind == "snapshot" {
        return;
    }
    for raw in &event.trades {
        let Some(symbol) = from_venue_symbol(VENUE, &raw.product_id) else {
            continue;
        };
        // `side` is documented as the MAKER's side, so the aggressor (taker) is the opposite
        // side: a maker SELL was lifted by a buyer. Some older docs describe `side` as the taker
        // side instead.
        // TODO(Task 7.7): confirm against a real capture and flip this mapping if needed.
        let side = match raw.side.as_str() {
            "SELL" => Side::Buy,
            "BUY" => Side::Sell,
            _ => {
                stats.record(VENUE, symbol, VenueError::Malformed);
                continue;
            }
        };
        let Some(price) = price_of(&raw.price, symbol, stats) else {
            continue;
        };
        let Some(qty) = qty_of(&raw.size, symbol, false, stats) else {
            continue;
        };
        let Some(ts) = parse_rfc3339_ms(&raw.time) else {
            stats.record(VENUE, symbol, VenueError::Malformed);
            continue;
        };
        out.push(MarketMsg::Trade {
            symbol: symbol.to_owned(),
            price,
            qty,
            side,
            ts,
        });
    }
}

fn book_event(
    event: &BookEvent,
    envelope_ts: Option<TimeMs>,
    stats: &mut DropStats,
    out: &mut Vec<MarketMsg>,
) {
    let Some(symbol) = from_venue_symbol(VENUE, &event.product_id) else {
        return;
    };
    match event.kind.as_str() {
        "snapshot" => {
            // The per-level `event_time` of a snapshot is the epoch placeholder; the envelope
            // time is the snapshot time.
            let Some(ts) = envelope_ts else {
                stats.record(VENUE, symbol, VenueError::Malformed);
                return;
            };
            let mut bids = Vec::new();
            let mut asks = Vec::new();
            for update in &event.updates {
                let Some(side) = book_side(&update.side) else {
                    stats.record(VENUE, symbol, VenueError::Malformed);
                    continue;
                };
                let Some(price) = price_of(&update.price_level, symbol, stats) else {
                    continue;
                };
                let Some(qty) = qty_of(&update.new_quantity, symbol, true, stats) else {
                    continue;
                };
                if qty.0 == 0 {
                    continue;
                }
                let level = Level { price, qty };
                match side {
                    Side::Buy => bids.push(level),
                    Side::Sell => asks.push(level),
                }
            }
            out.push(MarketMsg::BookSnapshot {
                symbol: symbol.to_owned(),
                bids,
                asks,
                ts,
            });
        }
        "update" => {
            for update in &event.updates {
                let Some(side) = book_side(&update.side) else {
                    stats.record(VENUE, symbol, VenueError::Malformed);
                    continue;
                };
                let Some(price) = price_of(&update.price_level, symbol, stats) else {
                    continue;
                };
                let Some(qty) = qty_of(&update.new_quantity, symbol, true, stats) else {
                    continue;
                };
                let event_ts = parse_rfc3339_ms(&update.event_time).filter(|ts| *ts > 0);
                let Some(ts) = event_ts.or(envelope_ts) else {
                    stats.record(VENUE, symbol, VenueError::Malformed);
                    continue;
                };
                out.push(MarketMsg::BookDelta {
                    symbol: symbol.to_owned(),
                    side,
                    price,
                    qty,
                    ts,
                });
            }
        }
        _ => {}
    }
}

/// `bid` is the buy side and `offer` the sell side.
fn book_side(text: &str) -> Option<Side> {
    match text {
        "bid" => Some(Side::Buy),
        "offer" => Some(Side::Sell),
        _ => None,
    }
}

/// Parses `YYYY-MM-DDTHH:MM:SS[.fraction]Z` (also `+00:00` / `-00:00`) into epoch milliseconds.
/// The fraction is truncated to milliseconds. Other offsets are rejected.
pub fn parse_rfc3339_ms(text: &str) -> Option<TimeMs> {
    let bytes = text.as_bytes();
    let sep = |i: usize, c: u8| bytes.get(i) == Some(&c);
    let date_ok = sep(4, b'-') && sep(7, b'-') && (sep(10, b'T') || sep(10, b't'));
    let time_ok = sep(13, b':') && sep(16, b':');
    if !(date_ok && time_ok) {
        return None;
    }
    let num = |from: usize, to: usize| -> Option<i64> {
        let s = text.get(from..to)?;
        if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        s.parse().ok()
    };
    let year = num(0, 4)?;
    let month = num(5, 7)?;
    let day = num(8, 10)?;
    let hour = num(11, 13)?;
    let minute = num(14, 16)?;
    let second = num(17, 19)?;
    if !(1..=12).contains(&month)
        || day < 1
        || day > days_in_month(year, month)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }
    let mut rest = text.get(19..)?;
    let mut millis = 0_i64;
    if let Some(after_dot) = rest.strip_prefix('.') {
        let digits = after_dot.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        let frac = after_dot.get(..digits)?;
        for (i, b) in frac.bytes().take(3).enumerate() {
            let place = [100_i64, 10, 1].get(i).copied()?;
            millis += i64::from(b - b'0') * place;
        }
        rest = after_dot.get(digits..)?;
    }
    if !matches!(rest, "Z" | "z" | "+00:00" | "-00:00") {
        return None;
    }
    let days = days_from_civil(year, month, day);
    let seconds = days
        .checked_mul(86_400)?
        .checked_add(hour * 3_600 + minute * 60 + second)?;
    seconds.checked_mul(1_000)?.checked_add(millis)
}

fn is_leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if is_leap(year) => 29,
        _ => 28,
    }
}

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's algorithm).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// One candle from the REST candles endpoint, in ticks and lots.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RestCandle {
    /// Interval start, Unix seconds.
    pub start_s: i64,
    pub open: Price,
    pub high: Price,
    pub low: Price,
    pub close: Price,
    pub volume: Qty,
}

impl RestCandle {
    /// The protocol bar, or `None` if the start time overflows when converted to ms.
    pub fn into_bar(self) -> Option<Bar> {
        Some(Bar {
            t: self.start_s.checked_mul(1_000)?,
            open: self.open,
            high: self.high,
            low: self.low,
            close: self.close,
            volume: self.volume,
        })
    }
}

#[derive(Debug, Deserialize)]
struct CandlesResponse {
    candles: Vec<RawCandle>,
}

#[derive(Debug, Deserialize)]
struct RawCandle {
    start: String,
    low: String,
    high: String,
    open: String,
    close: String,
    volume: String,
}

/// Parses the REST candles response for `symbol` (internal symbol, used for drop counts).
/// Coinbase returns newest first; the result is oldest first. Candles with a value that does
/// not fit the fixed decimals are dropped and counted.
pub fn parse_candles(
    json: &str,
    symbol: &str,
    stats: &mut DropStats,
) -> Result<Vec<RestCandle>, ParseError> {
    let response: CandlesResponse =
        serde_json::from_str(json).map_err(|e| ParseError::Json(e.to_string()))?;
    let mut out = Vec::with_capacity(response.candles.len());
    for raw in &response.candles {
        let Ok(start_s) = raw.start.parse::<i64>() else {
            stats.record(VENUE, symbol, VenueError::Malformed);
            continue;
        };
        let (Some(open), Some(high), Some(low), Some(close)) = (
            price_of(&raw.open, symbol, stats),
            price_of(&raw.high, symbol, stats),
            price_of(&raw.low, symbol, stats),
            price_of(&raw.close, symbol, stats),
        ) else {
            continue;
        };
        let Some(volume) = qty_of(&raw.volume, symbol, true, stats) else {
            continue;
        };
        out.push(RestCandle {
            start_s,
            open,
            high,
            low,
            close,
            volume,
        });
    }
    out.sort_by_key(|c| c.start_s);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The `sample` field of a wrapped sample file, as JSON text.
    fn sample(wrapped: &str) -> String {
        let value: Value = serde_json::from_str(wrapped).unwrap();
        value["sample"].to_string()
    }

    fn trade_sample() -> String {
        sample(include_str!("../../tests/data/coinbase_trade.json"))
    }

    fn snapshot_sample() -> String {
        sample(include_str!(
            "../../tests/data/coinbase_level2_snapshot.json"
        ))
    }

    fn update_sample() -> String {
        sample(include_str!("../../tests/data/coinbase_level2_update.json"))
    }

    fn candles_sample() -> String {
        sample(include_str!("../../tests/data/coinbase_candles.json"))
    }

    #[test]
    fn rfc3339_known_values() {
        assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            parse_rfc3339_ms("2027-01-01T00:00:00Z"),
            Some(1_798_761_600_000)
        );
        assert_eq!(
            parse_rfc3339_ms("2000-02-29T12:00:00Z"),
            Some(951_825_600_000)
        );
        assert_eq!(
            parse_rfc3339_ms("2026-11-14T04:53:10.141234Z"),
            Some(1_794_631_990_141)
        );
        assert_eq!(
            parse_rfc3339_ms("2026-11-14T04:53:09.1Z"),
            Some(1_794_631_989_100)
        );
        assert_eq!(
            parse_rfc3339_ms("2026-11-14T04:53:09.100+00:00"),
            Some(1_794_631_989_100)
        );
    }

    #[test]
    fn rfc3339_rejects_bad_text() {
        for text in [
            "",
            "2026-11-14",
            "2026-13-14T00:00:00Z",
            "2026-02-29T00:00:00Z",
            "2026-11-31T00:00:00Z",
            "2026-11-14T24:00:00Z",
            "2026-11-14T00:60:00Z",
            "2026-11-14T00:00:60Z",
            "2026-11-14T00:00:00",
            "2026-11-14T00:00:00.Z",
            "2026-11-14T00:00:00+01:00",
            "2026-11-14T00:00:00Zjunk",
            "2026-11-14 00:00:00Z",
            "20x6-11-14T00:00:00Z",
            "２０２６-11-14T00:00:00Z",
        ] {
            assert_eq!(parse_rfc3339_ms(text), None, "{text:?}");
        }
    }

    #[test]
    fn trade_sample_normalizes_with_documented_side() {
        let mut stats = DropStats::new();
        let msgs = parse_message(&trade_sample(), &mut stats).unwrap();
        // Maker side SELL means the aggressor bought.
        assert_eq!(
            msgs,
            vec![MarketMsg::Trade {
                symbol: "BTC-USD".into(),
                price: Price(6_716_813),
                qty: Qty(150_000),
                side: Side::Buy,
                ts: 1_794_631_990_141,
            }]
        );
        assert_eq!(stats.total(), 0);
    }

    #[test]
    fn trade_snapshot_events_are_skipped() {
        let text = trade_sample().replace("\"update\"", "\"snapshot\"");
        let mut stats = DropStats::new();
        assert_eq!(parse_message(&text, &mut stats).unwrap(), Vec::new());
    }

    #[test]
    fn level2_snapshot_sample_normalizes() {
        let mut stats = DropStats::new();
        let msgs = parse_message(&snapshot_sample(), &mut stats).unwrap();
        let level = |price, qty| Level {
            price: Price(price),
            qty: Qty(qty),
        };
        assert_eq!(
            msgs,
            vec![MarketMsg::BookSnapshot {
                symbol: "ETH-USD".into(),
                bids: vec![level(189_925, 350_000_000), level(189_920, 1_225_000_000)],
                asks: vec![level(189_926, 175_000_000), level(189_930, 800_000_000)],
                ts: 1_794_631_989_100,
            }]
        );
        assert_eq!(stats.total(), 0);
    }

    #[test]
    fn snapshot_skips_zero_quantity_levels() {
        let text = snapshot_sample().replace("\"3.50000000\"", "\"0\"");
        let mut stats = DropStats::new();
        let msgs = parse_message(&text, &mut stats).unwrap();
        let [MarketMsg::BookSnapshot { bids, .. }] = msgs.as_slice() else {
            panic!("expected one snapshot, got {msgs:?}");
        };
        assert_eq!(bids.len(), 1);
        assert_eq!(stats.total(), 0);
    }

    #[test]
    fn level2_update_sample_gives_deltas_and_zero_removes() {
        let mut stats = DropStats::new();
        let msgs = parse_message(&update_sample(), &mut stats).unwrap();
        assert_eq!(
            msgs,
            vec![
                MarketMsg::BookDelta {
                    symbol: "ETH-USD".into(),
                    side: Side::Buy,
                    price: Price(189_925),
                    qty: Qty(0),
                    ts: 1_794_631_989_341,
                },
                MarketMsg::BookDelta {
                    symbol: "ETH-USD".into(),
                    side: Side::Sell,
                    price: Price(189_926),
                    qty: Qty(210_000_000),
                    ts: 1_794_631_989_341,
                },
            ]
        );
    }

    #[test]
    fn inexact_and_malformed_values_are_dropped_and_counted() {
        let mut stats = DropStats::new();
        // Price with three decimals: inexact.
        let text = update_sample().replace("1899.26", "1899.261");
        let msgs = parse_message(&text, &mut stats).unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(stats.counts(Venue::Coinbase, "ETH-USD").inexact, 1);
        // Quantity that is not a decimal: malformed.
        let text = update_sample().replace("2.10000000", "abc");
        let msgs = parse_message(&text, &mut stats).unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(stats.counts(Venue::Coinbase, "ETH-USD").malformed, 1);
        // Unknown side name: malformed.
        let text = update_sample().replace("\"offer\"", "\"ask\"");
        let msgs = parse_message(&text, &mut stats).unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(stats.counts(Venue::Coinbase, "ETH-USD").malformed, 2);
        // Trade with a nine-decimal size: inexact. Zero size: malformed.
        let text = trade_sample().replace("0.00150000", "0.001500001");
        assert!(parse_message(&text, &mut stats).unwrap().is_empty());
        let text = trade_sample().replace("0.00150000", "0");
        assert!(parse_message(&text, &mut stats).unwrap().is_empty());
        let counts = stats.counts(Venue::Coinbase, "BTC-USD");
        assert_eq!((counts.inexact, counts.malformed), (1, 1));
    }

    #[test]
    fn unknown_symbols_and_channels_are_ignored() {
        let mut stats = DropStats::new();
        let text = trade_sample().replace("BTC-USD", "DOGE-USD");
        assert!(parse_message(&text, &mut stats).unwrap().is_empty());
        let text = update_sample().replace("ETH-USD", "DOGE-USD");
        assert!(parse_message(&text, &mut stats).unwrap().is_empty());
        for text in [
            r#"{"channel":"heartbeats","timestamp":"2026-11-14T04:53:09Z","events":[{"current_time":"x","heartbeat_counter":1}]}"#,
            r#"{"channel":"subscriptions","events":[{"subscriptions":{}}]}"#,
            r#"{"channel":"ticker","events":[]}"#,
            r#"{}"#,
        ] {
            assert!(
                parse_message(text, &mut stats).unwrap().is_empty(),
                "{text}"
            );
        }
        assert_eq!(stats.total(), 0);
    }

    #[test]
    fn bad_json_and_server_errors_are_reported() {
        let mut stats = DropStats::new();
        assert!(matches!(
            parse_message("not json", &mut stats),
            Err(ParseError::Json(_))
        ));
        assert_eq!(
            parse_message(r#"{"type":"error","message":"auth failure"}"#, &mut stats),
            Err(ParseError::Server("auth failure".into()))
        );
    }

    #[test]
    fn update_without_event_time_uses_envelope_time() {
        let text = update_sample().replace("2026-11-14T04:53:09.341Z", "1970-01-01T00:00:00Z");
        let mut stats = DropStats::new();
        let msgs = parse_message(&text, &mut stats).unwrap();
        assert_eq!(msgs.len(), 2);
        assert!(msgs.iter().all(|m| m.ts() == 1_794_631_989_350));
    }

    #[test]
    fn subscribe_messages_cover_three_channels_without_auth() {
        let msgs = subscribe_messages(&["BTC-USD", "ETH-USD"]);
        assert_eq!(msgs.len(), 3);
        let channels: Vec<String> = msgs
            .iter()
            .map(|m| {
                let v: Value = serde_json::from_str(m).unwrap();
                assert_eq!(v["type"], "subscribe");
                assert_eq!(v["product_ids"], serde_json::json!(["BTC-USD", "ETH-USD"]));
                assert!(v.get("jwt").is_none());
                assert_eq!(v.as_object().unwrap().len(), 3, "only type, channel, ids");
                v["channel"].as_str().unwrap().to_owned()
            })
            .collect();
        assert_eq!(channels, ["market_trades", "level2", "heartbeats"]);
    }

    #[test]
    fn granularity_names() {
        let names: Vec<&str> = Timeframe::ALL.iter().map(|t| granularity(*t)).collect();
        assert_eq!(
            names,
            [
                "ONE_MINUTE",
                "FIVE_MINUTE",
                "FIFTEEN_MINUTE",
                "ONE_HOUR",
                "ONE_DAY"
            ]
        );
    }

    #[test]
    fn candles_sample_is_reversed_to_oldest_first() {
        let mut stats = DropStats::new();
        let candles = parse_candles(&candles_sample(), "SOL-USD", &mut stats).unwrap();
        assert_eq!(candles.len(), 3);
        assert_eq!(
            candles.iter().map(|c| c.start_s).collect::<Vec<_>>(),
            [1_794_632_160, 1_794_632_220, 1_794_632_280]
        );
        assert_eq!(
            candles[0],
            RestCandle {
                start_s: 1_794_632_160,
                open: Price(7_552),
                high: Price(7_555),
                low: Price(7_550),
                close: Price(7_554),
                volume: Qty(15_888_661_853),
            }
        );
        assert_eq!(candles[2].close, Price(7_546));
        assert_eq!(candles[2].volume, Qty(44_412_863_447));
        let bar = candles[2].into_bar().unwrap();
        assert_eq!(bar.t, 1_794_632_280_000);
        assert_eq!(stats.total(), 0);
    }

    #[test]
    fn candles_with_bad_values_are_dropped_and_counted() {
        let text = candles_sample().replace("\"75.46\"", "\"75.461\"");
        let mut stats = DropStats::new();
        let candles = parse_candles(&text, "SOL-USD", &mut stats).unwrap();
        // The newest candle has low 75.46 and close 75.46; the second has none of it. Both
        // low and close are inexact now, so only the first one that fails is counted.
        assert_eq!(candles.len(), 2);
        assert!(stats.counts(Venue::Coinbase, "SOL-USD").inexact >= 1);
        assert!(matches!(
            parse_candles("{}", "SOL-USD", &mut stats),
            Err(ParseError::Json(_))
        ));
    }
}
