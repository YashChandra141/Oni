//! Pure normalization of Backpack public messages (Task 7.5, Req 43.1 to 43.8, 44.1, 44.4).
//! No I/O and no clock reads.
//!
//! - **Envelope:** every WebSocket message is `{"stream":"<type>.<SYMBOL>","data":{...}}`.
//!   `trade.<SYM>` becomes a [`MarketMsg::Trade`]. `depth.<SYM>` becomes a [`DepthUpdate`], which
//!   is kept apart from [`MarketMsg`] because update-id continuity must be checked by
//!   [`DepthSync`] before the levels may reach the book. Other streams, other symbols, and
//!   subscribe acknowledgements are ignored.
//! - **Time units:** WebSocket times (`E`, `T`) and the REST depth `timestamp` are MICROseconds;
//!   they are converted to ms by integer division by 1000 (floor; negative values are
//!   malformed). The kline `start` is a UTC string `YYYY-MM-DD HH:MM:SS`, converted to ms. The
//!   kline REQUEST parameters `startTime` and `endTime` are Unix SECONDS (see `backpack.rs`).
//! - **Aggressor:** the trade maker flag `m` is "the buyer is the maker", so `m == true` means
//!   the seller was the aggressor (`Side::Sell`) and `m == false` means `Side::Buy`.
//! - **Drops:** values that do not fit the fixed decimals are dropped and counted in
//!   [`DropStats`], never rounded.
//!
//! No authentication appears here: the subscribe message has no signature or key fields
//! (trading-safety rule 1).

// The adapter uses most of this; some items only tests use so far.
#![allow(dead_code)]

use std::collections::HashMap;
use std::fmt;

use protocol::{Bar, Level, Price, Qty, Side, TimeMs, Timeframe, Venue};
use serde::Deserialize;
use serde_json::Value;

use super::MarketMsg;
use super::coinbase_parse::parse_rfc3339_ms;
use super::venue::{
    DropStats, PRICE_DECIMALS, QTY_DECIMALS, VenueError, from_venue_symbol, to_lots, to_ticks,
};

const VENUE: Venue = Venue::Backpack;

/// Most updates buffered per symbol while waiting for a REST snapshot. The oldest is dropped
/// beyond this; a hole in the buffer is caught by the continuity check and causes a resync.
pub const MAX_BUFFERED_UPDATES: usize = 4_096;

/// Why a REST body could not be read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    /// The text is not JSON of the expected shape.
    Json(String),
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Json(e) => write!(f, "unexpected message shape: {e}"),
        }
    }
}

impl std::error::Error for ParseError {}

// ---------------------------------------------------------------------------------------------
// Wire shapes. TODO(Task 7.7): the short field names below (`p q m T E` for trades, `a b U u T E`
// for depth) come from the docs mirror, not from a capture. Confirm them against a real capture;
// this is the ONLY place they appear.
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct Envelope {
    #[serde(default)]
    stream: String,
    #[serde(default)]
    data: Value,
}

#[derive(Debug, Deserialize)]
struct RawTrade {
    #[serde(rename = "p")]
    price: String,
    #[serde(rename = "q")]
    quantity: String,
    /// True when the buyer is the maker.
    #[serde(rename = "m")]
    buyer_is_maker: bool,
    /// Engine timestamp, microseconds.
    #[serde(rename = "T", default)]
    engine_us: Option<i64>,
    /// Event time, microseconds.
    #[serde(rename = "E", default)]
    event_us: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct RawDepth {
    #[serde(rename = "a", default)]
    asks: Vec<[String; 2]>,
    #[serde(rename = "b", default)]
    bids: Vec<[String; 2]>,
    #[serde(rename = "U")]
    first_id: u64,
    #[serde(rename = "u")]
    last_id: u64,
    #[serde(rename = "T", default)]
    engine_us: Option<i64>,
    #[serde(rename = "E", default)]
    event_us: Option<i64>,
}

/// One `depth.<SYM>` event with absolute quantities, in ticks and lots. A quantity of zero
/// removes the level. Levels are in wire order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DepthUpdate {
    /// Internal symbol, e.g. `SOL-USD`.
    pub symbol: String,
    /// First update id covered by this event (`U`).
    pub first_id: u64,
    /// Last update id covered by this event (`u`).
    pub last_id: u64,
    pub bids: Vec<(Price, Qty)>,
    pub asks: Vec<(Price, Qty)>,
    /// Exchange time, ms.
    pub ts: TimeMs,
}

/// The result of reading one WebSocket text frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParsedBackpack {
    Trade(MarketMsg),
    Depth(DepthUpdate),
    /// Not a message the engine uses, or a value that was dropped and counted.
    Ignored,
    /// The text is not JSON of the envelope shape.
    Unreadable(String),
}

/// Builds the single SUBSCRIBE text for `trade.<SYM>` and `depth.<SYM>` of each Backpack symbol
/// (`SOL_USDC`). No signature, key, or any other auth field is included.
pub fn subscribe_message(symbols: &[&str]) -> String {
    let params: Vec<String> = symbols
        .iter()
        .flat_map(|s| [format!("trade.{s}"), format!("depth.{s}")])
        .collect();
    serde_json::json!({ "method": "SUBSCRIBE", "params": params }).to_string()
}

/// Microseconds to ms, floored. Negative times are rejected.
fn micros_to_ms(us: i64) -> Option<TimeMs> {
    if us >= 0 { Some(us / 1_000) } else { None }
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

/// Converts raw `[price, qty]` pairs; a pair with a bad value is dropped and counted.
fn convert_levels(
    raw: &[[String; 2]],
    symbol: &str,
    stats: &mut DropStats,
) -> Vec<(Price, Qty)> {
    raw.iter()
        .filter_map(|[price, qty]| {
            let price = price_of(price, symbol, stats)?;
            let qty = qty_of(qty, symbol, true, stats)?;
            Some((price, qty))
        })
        .collect()
}

/// Normalizes one WebSocket text frame.
pub fn parse_message(text: &str, stats: &mut DropStats) -> ParsedBackpack {
    let env: Envelope = match serde_json::from_str(text) {
        Ok(env) => env,
        Err(err) => return ParsedBackpack::Unreadable(err.to_string()),
    };
    let Some((kind, venue_symbol)) = env.stream.split_once('.') else {
        return ParsedBackpack::Ignored;
    };
    // Aggregated streams such as `depth.200ms.SOL_USDC` leave `200ms.SOL_USDC` here, which is
    // not a known symbol, so they are ignored.
    let Some(symbol) = from_venue_symbol(VENUE, venue_symbol) else {
        return ParsedBackpack::Ignored;
    };
    match kind {
        "trade" => parse_trade(env.data, symbol, stats),
        "depth" => parse_depth(env.data, symbol, stats),
        _ => ParsedBackpack::Ignored,
    }
}

fn parse_trade(data: Value, symbol: &str, stats: &mut DropStats) -> ParsedBackpack {
    let Ok(raw) = serde_json::from_value::<RawTrade>(data) else {
        stats.record(VENUE, symbol, VenueError::Malformed);
        return ParsedBackpack::Ignored;
    };
    let Some(price) = price_of(&raw.price, symbol, stats) else {
        return ParsedBackpack::Ignored;
    };
    let Some(qty) = qty_of(&raw.quantity, symbol, false, stats) else {
        return ParsedBackpack::Ignored;
    };
    let Some(ts) = raw.engine_us.or(raw.event_us).and_then(micros_to_ms) else {
        stats.record(VENUE, symbol, VenueError::Malformed);
        return ParsedBackpack::Ignored;
    };
    // Buyer is the maker, so the seller took liquidity.
    let side = if raw.buyer_is_maker {
        Side::Sell
    } else {
        Side::Buy
    };
    ParsedBackpack::Trade(MarketMsg::Trade {
        symbol: symbol.to_owned(),
        price,
        qty,
        side,
        ts,
    })
}

fn parse_depth(data: Value, symbol: &str, stats: &mut DropStats) -> ParsedBackpack {
    let Ok(raw) = serde_json::from_value::<RawDepth>(data) else {
        stats.record(VENUE, symbol, VenueError::Malformed);
        return ParsedBackpack::Ignored;
    };
    let Some(ts) = raw.engine_us.or(raw.event_us).and_then(micros_to_ms) else {
        stats.record(VENUE, symbol, VenueError::Malformed);
        return ParsedBackpack::Ignored;
    };
    ParsedBackpack::Depth(DepthUpdate {
        symbol: symbol.to_owned(),
        first_id: raw.first_id,
        last_id: raw.last_id,
        bids: convert_levels(&raw.bids, symbol, stats),
        asks: convert_levels(&raw.asks, symbol, stats),
        ts,
    })
}

// ---------------------------------------------------------------------------------------------
// REST depth snapshot
// ---------------------------------------------------------------------------------------------

/// A REST depth snapshot in ticks and lots. Bids are best (highest) first and asks best
/// (lowest) first; zero-quantity levels are removed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DepthSnapshot {
    /// Internal symbol.
    pub symbol: String,
    pub last_update_id: u64,
    pub bids: Vec<(Price, Qty)>,
    pub asks: Vec<(Price, Qty)>,
    /// Snapshot time, ms.
    pub ts: TimeMs,
}

#[derive(Debug, Deserialize)]
struct RawSnapshot {
    asks: Vec<[String; 2]>,
    bids: Vec<[String; 2]>,
    /// A string on the wire; a number is accepted too.
    #[serde(rename = "lastUpdateId")]
    last_update_id: Value,
    /// Microseconds.
    timestamp: i64,
}

/// Parses the REST depth response for `symbol` (internal). The response lists both sides in
/// ascending price order (best bid last); the result is sorted by price so the order of the
/// response does not matter.
pub fn parse_depth_snapshot(
    json: &str,
    symbol: &str,
    stats: &mut DropStats,
) -> Result<DepthSnapshot, ParseError> {
    let raw: RawSnapshot =
        serde_json::from_str(json).map_err(|e| ParseError::Json(e.to_string()))?;
    let last_update_id = match &raw.last_update_id {
        Value::String(s) => s.parse::<u64>().ok(),
        Value::Number(n) => n.as_u64(),
        _ => None,
    }
    .ok_or_else(|| ParseError::Json("lastUpdateId is not an unsigned integer".to_owned()))?;
    let ts = micros_to_ms(raw.timestamp)
        .ok_or_else(|| ParseError::Json("timestamp is negative".to_owned()))?;
    let mut bids = convert_levels(&raw.bids, symbol, stats);
    let mut asks = convert_levels(&raw.asks, symbol, stats);
    bids.retain(|(_, qty)| qty.0 > 0);
    asks.retain(|(_, qty)| qty.0 > 0);
    bids.sort_by(|a, b| b.0.0.cmp(&a.0.0));
    asks.sort_by(|a, b| a.0.0.cmp(&b.0.0));
    Ok(DepthSnapshot {
        symbol: symbol.to_owned(),
        last_update_id,
        bids,
        asks,
        ts,
    })
}

// ---------------------------------------------------------------------------------------------
// REST klines
// ---------------------------------------------------------------------------------------------

/// The Backpack `interval` value of a timeframe. TODO(Task 7.7): confirm the names.
pub fn interval_name(timeframe: Timeframe) -> &'static str {
    match timeframe {
        Timeframe::M1 => "1m",
        Timeframe::M5 => "5m",
        Timeframe::M15 => "15m",
        Timeframe::H1 => "1h",
        Timeframe::D1 => "1d",
    }
}

/// One kline in ticks and lots.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RestBar {
    /// Interval start, epoch ms (parsed from the UTC `start` string).
    pub start_ms: TimeMs,
    pub open: Price,
    pub high: Price,
    pub low: Price,
    pub close: Price,
    pub volume: Qty,
}

impl RestBar {
    pub fn into_bar(self) -> Bar {
        Bar {
            t: self.start_ms,
            open: self.open,
            high: self.high,
            low: self.low,
            close: self.close,
            volume: self.volume,
        }
    }
}

#[derive(Debug, Deserialize)]
struct RawKline {
    start: String,
    open: String,
    high: String,
    low: String,
    close: String,
    volume: String,
}

/// `YYYY-MM-DD HH:MM:SS` (UTC) to epoch ms.
fn parse_utc_ms(text: &str) -> Option<TimeMs> {
    let (date, time) = text.split_once(' ')?;
    parse_rfc3339_ms(&format!("{date}T{time}Z"))
}

/// Parses the REST klines response for `symbol` (internal). The result is oldest first. Klines
/// with a value that does not fit the fixed decimals are dropped and counted.
pub fn parse_klines(
    json: &str,
    symbol: &str,
    stats: &mut DropStats,
) -> Result<Vec<RestBar>, ParseError> {
    let rows: Vec<RawKline> =
        serde_json::from_str(json).map_err(|e| ParseError::Json(e.to_string()))?;
    let mut out = Vec::with_capacity(rows.len());
    for raw in &rows {
        let Some(start_ms) = parse_utc_ms(&raw.start) else {
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
        out.push(RestBar {
            start_ms,
            open,
            high,
            low,
            close,
            volume,
        });
    }
    out.sort_by_key(|b| b.start_ms);
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// Depth continuity
// ---------------------------------------------------------------------------------------------

/// What [`DepthSync`] decided.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncOutput {
    /// Messages to forward, in order.
    pub msgs: Vec<MarketMsg>,
    /// True when the symbol lost continuity (or its snapshot did not line up) and the caller
    /// must fetch a fresh REST snapshot.
    pub need_resync: bool,
}

impl SyncOutput {
    fn resync() -> Self {
        Self {
            msgs: Vec::new(),
            need_resync: true,
        }
    }
}

#[derive(Debug)]
enum SymState {
    /// No usable snapshot yet; updates are buffered.
    Awaiting(Vec<DepthUpdate>),
    /// The book follows the stream up to `last_id`. `fresh` is true until the first update after
    /// the snapshot has been applied (that one may overlap the snapshot id).
    Synced { last_id: u64, fresh: bool },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Verdict {
    Apply,
    Stale,
    Gap,
}

/// Judges `update` against the last applied id `prev`.
///
/// - `last_id <= prev` (or an update whose first id is above its last id) is stale: dropped.
/// - the first update after a snapshot must satisfy `first_id <= prev + 1 <= last_id`;
/// - every later update must satisfy `first_id == prev + 1`.
///
/// Anything else is a gap.
fn judge(prev: u64, fresh: bool, update: &DepthUpdate) -> Verdict {
    if update.first_id > update.last_id || update.last_id <= prev {
        return Verdict::Stale;
    }
    let Some(next) = prev.checked_add(1) else {
        return Verdict::Stale;
    };
    let continuous = if fresh {
        update.first_id <= next
    } else {
        update.first_id == next
    };
    if continuous {
        Verdict::Apply
    } else {
        Verdict::Gap
    }
}

fn levels_of(pairs: &[(Price, Qty)]) -> Vec<Level> {
    pairs
        .iter()
        .map(|&(price, qty)| Level { price, qty })
        .collect()
}

/// One BookDelta per level, bids first. Quantity zero removes the level.
fn deltas_of(update: &DepthUpdate) -> Vec<MarketMsg> {
    let bids = update.bids.iter().map(|&(price, qty)| (Side::Buy, price, qty));
    let asks = update.asks.iter().map(|&(price, qty)| (Side::Sell, price, qty));
    bids.chain(asks)
        .map(|(side, price, qty)| MarketMsg::BookDelta {
            symbol: update.symbol.clone(),
            side,
            price,
            qty,
            ts: update.ts,
        })
        .collect()
}

/// Per-symbol depth synchronization: a pure state machine. A symbol that has not been seen is in
/// the awaiting state.
#[derive(Debug, Default)]
pub struct DepthSync {
    states: HashMap<String, SymState>,
}

impl DepthSync {
    pub fn new() -> Self {
        Self::default()
    }

    /// Forgets every symbol; all return to awaiting a snapshot. Call on every reconnect.
    pub fn reset(&mut self) {
        self.states.clear();
    }

    /// Feeds one depth update.
    ///
    /// Awaiting: buffered (capped), nothing emitted. Synced: applied if continuous, dropped if
    /// stale, and a gap returns [`SyncOutput::need_resync`] and goes back to awaiting with an
    /// empty buffer.
    pub fn on_update(&mut self, update: DepthUpdate) -> SyncOutput {
        let key = update.symbol.clone();
        let state = self
            .states
            .entry(key)
            .or_insert_with(|| SymState::Awaiting(Vec::new()));
        let verdict = match &mut *state {
            SymState::Awaiting(buffer) => {
                if buffer.len() >= MAX_BUFFERED_UPDATES {
                    buffer.remove(0);
                }
                buffer.push(update);
                return SyncOutput::default();
            }
            SymState::Synced { last_id, fresh } => {
                let verdict = judge(*last_id, *fresh, &update);
                if verdict == Verdict::Apply {
                    *last_id = update.last_id;
                    *fresh = false;
                    return SyncOutput {
                        msgs: deltas_of(&update),
                        need_resync: false,
                    };
                }
                verdict
            }
        };
        if verdict == Verdict::Gap {
            *state = SymState::Awaiting(Vec::new());
            return SyncOutput::resync();
        }
        SyncOutput::default()
    }

    /// Feeds a REST snapshot. Emits the BookSnapshot, drops buffered updates that the snapshot
    /// already contains, then applies the rest in order. If a buffered update does not line up
    /// (the first must satisfy `first_id <= last_update_id + 1 <= last_id`), nothing is emitted,
    /// the buffer is cleared, and `need_resync` is set.
    pub fn on_snapshot(&mut self, snapshot: DepthSnapshot) -> SyncOutput {
        let buffered = match self.states.remove(&snapshot.symbol) {
            Some(SymState::Awaiting(buffer)) => buffer,
            _ => Vec::new(),
        };
        let mut msgs = vec![MarketMsg::BookSnapshot {
            symbol: snapshot.symbol.clone(),
            bids: levels_of(&snapshot.bids),
            asks: levels_of(&snapshot.asks),
            ts: snapshot.ts,
        }];
        let mut last_id = snapshot.last_update_id;
        let mut fresh = true;
        for update in buffered {
            match judge(last_id, fresh, &update) {
                Verdict::Stale => {}
                Verdict::Apply => {
                    msgs.extend(deltas_of(&update));
                    last_id = update.last_id;
                    fresh = false;
                }
                Verdict::Gap => return SyncOutput::resync(),
            }
        }
        self.states
            .insert(snapshot.symbol, SymState::Synced { last_id, fresh });
        SyncOutput {
            msgs,
            need_resync: false,
        }
    }

    /// True if `symbol` is synced (test and diagnostics helper).
    pub fn is_synced(&self, symbol: &str) -> bool {
        matches!(self.states.get(symbol), Some(SymState::Synced { .. }))
    }
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
        sample(include_str!("../../tests/data/backpack_trade.json"))
    }

    fn depth_sample() -> String {
        sample(include_str!("../../tests/data/backpack_depth.json"))
    }

    fn rest_depth_sample() -> String {
        sample(include_str!("../../tests/data/backpack_depth_rest.json"))
    }

    fn klines_sample() -> String {
        sample(include_str!("../../tests/data/backpack_klines.json"))
    }

    #[test]
    fn subscribe_message_has_trade_and_depth_for_each_symbol_and_no_auth() {
        let text = subscribe_message(&["BTC_USDC", "ETH_USDC", "SOL_USDC"]);
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["method"], "SUBSCRIBE");
        assert_eq!(
            v["params"],
            serde_json::json!([
                "trade.BTC_USDC",
                "depth.BTC_USDC",
                "trade.ETH_USDC",
                "depth.ETH_USDC",
                "trade.SOL_USDC",
                "depth.SOL_USDC"
            ])
        );
        assert_eq!(v.as_object().unwrap().len(), 2, "only method and params: {text}");
        let lower = text.to_ascii_lowercase();
        for forbidden in ["signature", "key", "auth", "account"] {
            assert!(!lower.contains(forbidden), "{forbidden}");
        }
    }

    #[test]
    fn trade_sample_normalizes_with_seller_aggressor() {
        let mut stats = DropStats::new();
        let parsed = parse_message(&trade_sample(), &mut stats);
        // m = true: the buyer is the maker, so the seller is the aggressor. T = 1794633085618112 us
        // floors to 1794633085618 ms.
        assert_eq!(
            parsed,
            ParsedBackpack::Trade(MarketMsg::Trade {
                symbol: "SOL-USD".into(),
                price: Price(7_541),
                qty: Qty(2_000_000),
                side: Side::Sell,
                ts: 1_794_633_085_618,
            })
        );
        assert_eq!(stats.total(), 0);
    }

    #[test]
    fn maker_flag_false_means_buy_aggressor() {
        let text = trade_sample().replace("\"m\":true", "\"m\":false");
        let mut stats = DropStats::new();
        let ParsedBackpack::Trade(MarketMsg::Trade { side, .. }) = parse_message(&text, &mut stats)
        else {
            panic!("expected a trade");
        };
        assert_eq!(side, Side::Buy);
    }

    #[test]
    fn trade_falls_back_to_event_time_and_rejects_bad_times() {
        let mut stats = DropStats::new();
        let text = trade_sample().replace("\"T\":1794633085618112,", "");
        let ParsedBackpack::Trade(msg) = parse_message(&text, &mut stats) else {
            panic!("expected a trade");
        };
        assert_eq!(msg.ts(), 1_794_633_085_618);
        // No time at all, and a negative time, are malformed.
        let none = text.replace("\"E\":1794633085618437,", "");
        assert_eq!(parse_message(&none, &mut stats), ParsedBackpack::Ignored);
        let negative = text.replace("1794633085618437", "-5");
        assert_eq!(parse_message(&negative, &mut stats), ParsedBackpack::Ignored);
        assert_eq!(stats.counts(Venue::Backpack, "SOL-USD").malformed, 2);
    }

    #[test]
    fn micros_floor_to_ms() {
        assert_eq!(micros_to_ms(0), Some(0));
        assert_eq!(micros_to_ms(999), Some(0));
        assert_eq!(micros_to_ms(1_999), Some(1));
        assert_eq!(micros_to_ms(-1), None);
    }

    #[test]
    fn depth_sample_normalizes() {
        let mut stats = DropStats::new();
        let parsed = parse_message(&depth_sample(), &mut stats);
        assert_eq!(
            parsed,
            ParsedBackpack::Depth(DepthUpdate {
                symbol: "SOL-USD".into(),
                first_id: 4_686_272_931,
                last_id: 4_686_272_933,
                bids: vec![(Price(7_546), Qty(30_472_000_000))],
                asks: vec![(Price(7_547), Qty(19_850_000_000)), (Price(7_562), Qty(0))],
                ts: 1_794_633_182_149,
            })
        );
        assert_eq!(stats.total(), 0);
    }

    #[test]
    fn inexact_and_malformed_values_are_dropped_and_counted() {
        let mut stats = DropStats::new();
        // Inexact price on a trade.
        let text = trade_sample().replace("\"p\":\"75.41\"", "\"p\":\"75.411\"");
        assert_eq!(parse_message(&text, &mut stats), ParsedBackpack::Ignored);
        // Zero quantity on a trade is malformed.
        let text = trade_sample().replace("\"q\":\"0.02\"", "\"q\":\"0\"");
        assert_eq!(parse_message(&text, &mut stats), ParsedBackpack::Ignored);
        // Missing maker flag: the whole trade is malformed.
        let text = trade_sample().replace("\"m\":true", "\"x\":1");
        assert_eq!(parse_message(&text, &mut stats), ParsedBackpack::Ignored);
        let counts = stats.counts(Venue::Backpack, "SOL-USD");
        assert_eq!((counts.inexact, counts.malformed), (1, 2));
        // One inexact depth level is dropped; the update is still returned.
        let text = depth_sample().replace("\"75.47\"", "\"75.471\"");
        let ParsedBackpack::Depth(update) = parse_message(&text, &mut stats) else {
            panic!("expected a depth update");
        };
        assert_eq!(update.asks, vec![(Price(7_562), Qty(0))]);
        assert_eq!(stats.counts(Venue::Backpack, "SOL-USD").inexact, 2);
        // Depth without update ids is dropped whole.
        let text = depth_sample().replace("\"U\":4686272931,", "");
        assert_eq!(parse_message(&text, &mut stats), ParsedBackpack::Ignored);
        assert_eq!(stats.counts(Venue::Backpack, "SOL-USD").malformed, 3);
    }

    #[test]
    fn unknown_streams_symbols_and_acks_are_ignored() {
        let mut stats = DropStats::new();
        let text = trade_sample().replace("SOL_USDC", "DOGE_USDC");
        assert_eq!(parse_message(&text, &mut stats), ParsedBackpack::Ignored);
        let text = depth_sample().replace("depth.SOL_USDC", "depth.200ms.SOL_USDC");
        assert_eq!(parse_message(&text, &mut stats), ParsedBackpack::Ignored);
        for text in [
            r#"{"result":null,"id":1}"#,
            r#"{"stream":"ticker.SOL_USDC","data":{}}"#,
            r#"{"stream":"nodot","data":{}}"#,
            "{}",
        ] {
            assert_eq!(parse_message(text, &mut stats), ParsedBackpack::Ignored, "{text}");
        }
        assert_eq!(stats.total(), 0);
        assert!(matches!(
            parse_message("not json", &mut stats),
            ParsedBackpack::Unreadable(_)
        ));
    }

    #[test]
    fn rest_snapshot_is_sorted_best_first() {
        let mut stats = DropStats::new();
        let snap = parse_depth_snapshot(&rest_depth_sample(), "SOL-USD", &mut stats).unwrap();
        assert_eq!(snap.last_update_id, 4_686_272_930);
        assert_eq!(snap.ts, 1_794_633_182_147);
        assert_eq!(
            snap.bids,
            vec![
                (Price(7_546), Qty(30_472_000_000)),
                (Price(7_545), Qty(26_109_000_000)),
                (Price(7_544), Qty(30_741_000_000)),
            ]
        );
        assert_eq!(
            snap.asks,
            vec![
                (Price(7_547), Qty(20_280_000_000)),
                (Price(7_548), Qty(26_631_000_000)),
                (Price(7_549), Qty(31_260_000_000)),
            ]
        );
        assert_eq!(stats.total(), 0);
    }

    #[test]
    fn rest_snapshot_sorts_regardless_of_response_order_and_drops_zero_levels() {
        let json = r#"{"asks":[["10.02","1"],["10.01","0"],["10.00","2"]],
            "bids":[["9.00","1"],["9.99","3"]],"lastUpdateId":7,"timestamp":2000}"#;
        let mut stats = DropStats::new();
        let snap = parse_depth_snapshot(json, "BTC-USD", &mut stats).unwrap();
        assert_eq!(snap.last_update_id, 7, "a numeric id is accepted");
        assert_eq!(snap.ts, 2);
        assert_eq!(snap.asks, vec![(Price(1_000), Qty(200_000_000)), (Price(1_002), Qty(100_000_000))]);
        assert_eq!(snap.bids, vec![(Price(999), Qty(300_000_000)), (Price(900), Qty(100_000_000))]);
    }

    #[test]
    fn rest_snapshot_errors() {
        let mut stats = DropStats::new();
        for json in [
            "{}",
            "[]",
            r#"{"asks":[],"bids":[],"lastUpdateId":"abc","timestamp":1}"#,
            r#"{"asks":[],"bids":[],"lastUpdateId":"-1","timestamp":1}"#,
            r#"{"asks":[],"bids":[],"lastUpdateId":null,"timestamp":1}"#,
            r#"{"asks":[],"bids":[],"lastUpdateId":"1","timestamp":-1}"#,
        ] {
            assert!(
                matches!(parse_depth_snapshot(json, "BTC-USD", &mut stats), Err(ParseError::Json(_))),
                "{json}"
            );
        }
    }

    #[test]
    fn klines_sample_normalizes_oldest_first() {
        let mut stats = DropStats::new();
        let bars = parse_klines(&klines_sample(), "SOL-USD", &mut stats).unwrap();
        assert_eq!(bars.len(), 2);
        assert_eq!(
            bars[0],
            RestBar {
                start_ms: 1_794_631_980_000,
                open: Price(7_546),
                high: Price(7_546),
                low: Price(7_546),
                close: Price(7_546),
                volume: Qty(2_000_000),
            }
        );
        assert_eq!(bars[1].start_ms, 1_794_632_040_000);
        assert_eq!(bars[1].close, Price(7_560));
        assert_eq!(bars[1].into_bar().t, 1_794_632_040_000);
        assert_eq!(stats.total(), 0);
    }

    #[test]
    fn klines_with_bad_values_are_dropped_and_sorted() {
        let json = r#"[
            {"start":"2026-11-14 04:55:00","open":"1","high":"1","low":"1","close":"1","volume":"1"},
            {"start":"2026-11-14 04:54:00","open":"1.001","high":"1","low":"1","close":"1","volume":"1"},
            {"start":"garbage","open":"1","high":"1","low":"1","close":"1","volume":"1"},
            {"start":"2026-11-14 04:53:00","open":"1","high":"1","low":"1","close":"1","volume":"1"}
        ]"#;
        let mut stats = DropStats::new();
        let bars = parse_klines(json, "BTC-USD", &mut stats).unwrap();
        assert_eq!(
            bars.iter().map(|b| b.start_ms).collect::<Vec<_>>(),
            [1_794_631_980_000, 1_794_632_100_000]
        );
        let counts = stats.counts(Venue::Backpack, "BTC-USD");
        assert_eq!((counts.inexact, counts.malformed), (1, 1));
        assert!(parse_klines("{}", "BTC-USD", &mut stats).is_err());
    }

    #[test]
    fn interval_names() {
        let names: Vec<&str> = Timeframe::ALL.iter().map(|t| interval_name(*t)).collect();
        assert_eq!(names, ["1m", "5m", "15m", "1h", "1d"]);
    }

    // ----- DepthSync -----

    const SYM: &str = "SOL-USD";

    fn upd(first_id: u64, last_id: u64) -> DepthUpdate {
        DepthUpdate {
            symbol: SYM.into(),
            first_id,
            last_id,
            bids: vec![(Price(100), Qty(first_id.try_into().unwrap()))],
            asks: vec![(Price(101), Qty(0))],
            ts: 10,
        }
    }

    fn snap(symbol: &str, id: u64) -> DepthSnapshot {
        DepthSnapshot {
            symbol: symbol.into(),
            last_update_id: id,
            bids: vec![(Price(99), Qty(5)), (Price(98), Qty(6))],
            asks: vec![(Price(102), Qty(7))],
            ts: 5,
        }
    }

    /// Update ids covered by the BookDelta messages (each update gives two deltas whose bid
    /// quantity is its first id).
    fn bid_qtys(msgs: &[MarketMsg]) -> Vec<i64> {
        msgs.iter()
            .filter_map(|m| match m {
                MarketMsg::BookDelta {
                    side: Side::Buy,
                    qty,
                    ..
                } => Some(qty.0),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn normal_flow_with_buffered_updates_around_the_snapshot() {
        let mut sync = DepthSync::new();
        for (f, l) in [(90, 100), (101, 102), (103, 103)] {
            assert_eq!(sync.on_update(upd(f, l)), SyncOutput::default());
        }
        assert!(!sync.is_synced(SYM));
        let out = sync.on_snapshot(snap(SYM, 100));
        assert!(!out.need_resync);
        // The snapshot first, then both applied updates (the stale 90..100 is dropped).
        assert!(matches!(
            out.msgs.first(),
            Some(MarketMsg::BookSnapshot { bids, asks, ts: 5, .. })
                if bids.len() == 2 && asks.len() == 1 && bids[0].price == Price(99)
        ));
        assert_eq!(bid_qtys(&out.msgs), [101, 103]);
        assert_eq!(out.msgs.len(), 1 + 4);
        assert!(sync.is_synced(SYM));
        let out = sync.on_update(upd(104, 105));
        assert_eq!(bid_qtys(&out.msgs), [104]);
        assert!(!out.need_resync);
    }

    #[test]
    fn zero_quantity_delta_removes_a_level() {
        let mut sync = DepthSync::new();
        sync.on_snapshot(snap(SYM, 10));
        let out = sync.on_update(upd(11, 11));
        assert!(out.msgs.contains(&MarketMsg::BookDelta {
            symbol: SYM.into(),
            side: Side::Sell,
            price: Price(101),
            qty: Qty(0),
            ts: 10,
        }));
    }

    #[test]
    fn stale_and_duplicate_updates_are_dropped_silently() {
        let mut sync = DepthSync::new();
        sync.on_snapshot(snap(SYM, 100));
        assert_eq!(sync.on_update(upd(101, 106)).msgs.len(), 2);
        for (f, l) in [(101, 106), (90, 100), (106, 106), (104, 105), (50, 40)] {
            assert_eq!(sync.on_update(upd(f, l)), SyncOutput::default(), "{f}..{l}");
        }
        assert!(sync.is_synced(SYM));
        assert_eq!(bid_qtys(&sync.on_update(upd(107, 107)).msgs), [107]);
    }

    #[test]
    fn a_gap_triggers_a_resync_and_a_fresh_snapshot() {
        let mut sync = DepthSync::new();
        sync.on_snapshot(snap(SYM, 100));
        sync.on_update(upd(101, 105));
        let gap = sync.on_update(upd(107, 108));
        assert_eq!(gap, SyncOutput { msgs: Vec::new(), need_resync: true });
        assert!(!sync.is_synced(SYM));
        // Updates while the snapshot is in flight are buffered, not forwarded.
        assert_eq!(sync.on_update(upd(109, 109)), SyncOutput::default());
        let out = sync.on_snapshot(snap(SYM, 108));
        assert!(matches!(out.msgs.first(), Some(MarketMsg::BookSnapshot { .. })));
        assert_eq!(bid_qtys(&out.msgs), [109]);
        assert!(sync.is_synced(SYM));
    }

    #[test]
    fn overlap_after_the_first_update_is_a_gap() {
        let mut sync = DepthSync::new();
        sync.on_snapshot(snap(SYM, 100));
        sync.on_update(upd(101, 106));
        assert!(sync.on_update(upd(106, 108)).need_resync);
    }

    #[test]
    fn first_update_may_overlap_the_snapshot_id() {
        let mut sync = DepthSync::new();
        sync.on_snapshot(snap(SYM, 100));
        let out = sync.on_update(upd(99, 101));
        assert_eq!(bid_qtys(&out.msgs), [99]);
        // Strict from here on.
        assert!(sync.on_update(upd(103, 103)).need_resync);
    }

    #[test]
    fn a_first_buffered_update_that_does_not_line_up_forces_a_resync() {
        let mut sync = DepthSync::new();
        sync.on_update(upd(120, 121));
        let out = sync.on_snapshot(snap(SYM, 100));
        assert_eq!(out, SyncOutput { msgs: Vec::new(), need_resync: true });
        assert!(!sync.is_synced(SYM));
        // The buffer was cleared: a later snapshot starts clean.
        let out = sync.on_snapshot(snap(SYM, 121));
        assert!(!out.need_resync);
        assert_eq!(out.msgs.len(), 1);
    }

    #[test]
    fn a_hole_inside_the_buffer_forces_a_resync() {
        let mut sync = DepthSync::new();
        sync.on_update(upd(101, 102));
        sync.on_update(upd(105, 106));
        let out = sync.on_snapshot(snap(SYM, 100));
        assert_eq!(out, SyncOutput { msgs: Vec::new(), need_resync: true });
    }

    #[test]
    fn ids_near_u64_max_do_not_overflow() {
        let mut sync = DepthSync::new();
        sync.on_snapshot(snap(SYM, u64::MAX - 1));
        let out = sync.on_update(upd(u64::MAX, u64::MAX));
        assert_eq!(out.msgs.len(), 2);
        // Nothing can follow u64::MAX: everything is stale, never a panic or a wrap.
        for (f, l) in [(0, 0), (u64::MAX, u64::MAX), (1, u64::MAX)] {
            assert_eq!(sync.on_update(upd(f, l)), SyncOutput::default());
        }
        let mut sync = DepthSync::new();
        sync.on_snapshot(snap(SYM, u64::MAX));
        assert_eq!(sync.on_update(upd(u64::MAX, u64::MAX)), SyncOutput::default());
    }

    #[test]
    fn symbols_are_independent_and_reset_forgets_all() {
        let mut sync = DepthSync::new();
        sync.on_snapshot(snap("BTC-USD", 10));
        sync.on_snapshot(snap(SYM, 500));
        let mut btc = upd(11, 11);
        btc.symbol = "BTC-USD".into();
        assert_eq!(sync.on_update(btc).msgs.len(), 2);
        assert_eq!(sync.on_update(upd(501, 501)).msgs.len(), 2);
        sync.reset();
        assert!(!sync.is_synced("BTC-USD") && !sync.is_synced(SYM));
        assert_eq!(sync.on_update(upd(502, 502)), SyncOutput::default());
    }

    #[test]
    fn the_buffer_is_capped_and_a_resulting_hole_resyncs() {
        let mut sync = DepthSync::new();
        let total = u64::try_from(MAX_BUFFERED_UPDATES).unwrap() + 5;
        for id in 1..=total {
            sync.on_update(upd(id, id));
        }
        // Updates 1..=5 were dropped from the front, so a snapshot at 0 sees a hole.
        assert!(sync.on_snapshot(snap(SYM, 0)).need_resync);
        for id in 1..=total {
            sync.on_update(upd(id, id));
        }
        // A snapshot at 5 lines up with the retained updates.
        let out = sync.on_snapshot(snap(SYM, 5));
        assert!(!out.need_resync);
    }
}
