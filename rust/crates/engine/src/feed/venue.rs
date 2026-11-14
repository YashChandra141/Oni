//! Venue layer (Task 7.2, Req 1.11, 44.1, 44.2, 44.4, 44.5; design Decisions A5, A6, A8).
//!
//! Pure helpers shared by the Coinbase and Backpack adapters: the venue symbol map, exact decimal
//! conversion to ticks and lots (no floats, nothing rounded), a drop counter with rate-limited
//! logging, and the startup metadata check. No I/O and no clock reads: callers pass "now".

// The adapters (Tasks 7.4, 7.5) are the callers; until they land, only tests use these items.
#![allow(dead_code)]

use std::collections::HashMap;
use std::fmt;

use protocol::{INSTRUMENTS, Price, Qty, Venue};

/// Fixed internal price decimals (tick 0.01). Design Decision A6.
pub const PRICE_DECIMALS: u32 = 2;
/// Fixed internal quantity decimals (lot 0.00000001). Design Decision A6.
pub const QTY_DECIMALS: u32 = 8;
/// Minimum time between two drop log lines (Req 44.5).
pub const DROP_LOG_INTERVAL_MS: i64 = 10_000;

/// Why a venue decimal could not become ticks or lots.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VenueError {
    /// Non-zero digits remain beyond the fixed decimals. The value is dropped, never rounded.
    Inexact,
    /// Not a plain non-negative decimal: empty, sign, letters, several dots, spaces.
    Malformed,
    /// The scaled value does not fit in an i64.
    Overflow,
}

impl fmt::Display for VenueError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Inexact => f.write_str("value has more precision than the fixed decimals"),
            Self::Malformed => f.write_str("value is not a plain non-negative decimal"),
            Self::Overflow => f.write_str("value does not fit in a 64-bit integer"),
        }
    }
}

impl std::error::Error for VenueError {}

/// Lowercase venue name, as on the wire and in logs.
pub fn venue_name(venue: Venue) -> &'static str {
    match venue {
        Venue::Coinbase => "coinbase",
        Venue::Backpack => "backpack",
    }
}

/// (internal symbol, Coinbase symbol, Backpack symbol). Backpack's USDC pairs stand in for USD
/// (Decision A8).
const SYMBOL_MAP: [(&str, &str, &str); 3] = [
    ("BTC-USD", "BTC-USD", "BTC_USDC"),
    ("ETH-USD", "ETH-USD", "ETH_USDC"),
    ("SOL-USD", "SOL-USD", "SOL_USDC"),
];

fn venue_column(venue: Venue, row: &(&'static str, &'static str, &'static str)) -> &'static str {
    match venue {
        Venue::Coinbase => row.1,
        Venue::Backpack => row.2,
    }
}

/// The venue's symbol for an internal symbol, or `None` if the internal symbol is unknown.
pub fn to_venue_symbol(venue: Venue, internal: &str) -> Option<&'static str> {
    SYMBOL_MAP
        .iter()
        .find(|row| row.0 == internal)
        .map(|row| venue_column(venue, row))
}

/// The internal symbol (from `INSTRUMENTS`) for a venue symbol, or `None` if it is unknown.
pub fn from_venue_symbol(venue: Venue, venue_symbol: &str) -> Option<&'static str> {
    let row = SYMBOL_MAP
        .iter()
        .find(|row| venue_column(venue, row) == venue_symbol)?;
    INSTRUMENTS
        .iter()
        .find(|instrument| instrument.symbol == row.0)
        .map(|instrument| instrument.symbol)
}

/// Parses a plain non-negative decimal into an integer scaled by 10^`decimals`.
///
/// Accepts `digits` or `digits.digits`. Digits beyond `decimals` must all be `0`, otherwise the
/// value is `Inexact`.
fn parse_scaled(text: &str, decimals: u32) -> Result<i64, VenueError> {
    let (int_part, frac_part) = match text.split_once('.') {
        Some((int_part, frac_part)) => (int_part, frac_part),
        None => (text, ""),
    };
    let has_dot = text.contains('.');
    let all_digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    if int_part.is_empty()
        || !all_digits(int_part)
        || !all_digits(frac_part)
        || (has_dot && frac_part.is_empty())
    {
        return Err(VenueError::Malformed);
    }
    let keep = usize::try_from(decimals).map_err(|_| VenueError::Overflow)?;
    let (kept_frac, extra_frac) = if frac_part.len() > keep {
        frac_part.split_at(keep)
    } else {
        (frac_part, "")
    };
    if extra_frac.bytes().any(|b| b != b'0') {
        return Err(VenueError::Inexact);
    }
    let mut acc: i64 = 0;
    let padding = keep - kept_frac.len();
    let digits = int_part
        .bytes()
        .chain(kept_frac.bytes())
        .chain(std::iter::repeat_n(b'0', padding));
    for b in digits {
        acc = acc
            .checked_mul(10)
            .and_then(|v| v.checked_add(i64::from(b - b'0')))
            .ok_or(VenueError::Overflow)?;
    }
    Ok(acc)
}

/// Converts a venue price string to ticks with exact string arithmetic (Req 44.4).
pub fn to_ticks(decimal: &str, price_decimals: u32) -> Result<Price, VenueError> {
    parse_scaled(decimal, price_decimals).map(Price)
}

/// Converts a venue quantity string to lots with exact string arithmetic (Req 44.4).
pub fn to_lots(decimal: &str, qty_decimals: u32) -> Result<Qty, VenueError> {
    parse_scaled(decimal, qty_decimals).map(Qty)
}

/// Drops of one kind, per venue and symbol.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DropCounts {
    pub inexact: u64,
    pub malformed: u64,
    pub overflow: u64,
}

impl DropCounts {
    pub fn total(&self) -> u64 {
        self.inexact + self.malformed + self.overflow
    }
}

/// Counts dropped venue values (Req 44.4) and limits the log rate to one line per 10 s (44.5).
#[derive(Debug, Default)]
pub struct DropStats {
    counts: HashMap<(Venue, String), DropCounts>,
    pending: u64,
    last_log_ms: Option<i64>,
}

impl DropStats {
    pub fn new() -> Self {
        Self::default()
    }

    /// Records one dropped value.
    pub fn record(&mut self, venue: Venue, symbol: &str, error: VenueError) {
        let entry = self.counts.entry((venue, symbol.to_owned())).or_default();
        match error {
            VenueError::Inexact => entry.inexact += 1,
            VenueError::Malformed => entry.malformed += 1,
            VenueError::Overflow => entry.overflow += 1,
        }
        self.pending += 1;
    }

    /// Counts for one venue and symbol.
    pub fn counts(&self, venue: Venue, symbol: &str) -> DropCounts {
        self.counts
            .get(&(venue, symbol.to_owned()))
            .copied()
            .unwrap_or_default()
    }

    /// Total drops over every venue and symbol.
    pub fn total(&self) -> u64 {
        self.counts.values().map(DropCounts::total).sum()
    }

    /// True when a log line is due: there are drops not yet logged and at least 10 s have passed
    /// since the last line. Returning true marks the drops as logged.
    pub fn should_log(&mut self, now_ms: i64) -> bool {
        if self.pending == 0 {
            return false;
        }
        let due = match self.last_log_ms {
            None => true,
            Some(last) => now_ms.saturating_sub(last) >= DROP_LOG_INTERVAL_MS,
        };
        if due {
            self.last_log_ms = Some(now_ms);
            self.pending = 0;
        }
        due
    }

    /// Every counter, sorted by venue name then symbol, for the log line.
    pub fn snapshot(&self) -> Vec<(&'static str, String, DropCounts)> {
        let mut rows: Vec<_> = self
            .counts
            .iter()
            .map(|((venue, symbol), counts)| (venue_name(*venue), symbol.clone(), *counts))
            .collect();
        rows.sort_by(|a, b| (a.0, &a.1).cmp(&(b.0, &b.1)));
        rows
    }
}

/// One symbol's tick and step as the venue reports them (decimal strings).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MetaRow {
    /// Internal symbol, e.g. `BTC-USD`.
    pub symbol: String,
    /// Venue price tick, e.g. `0.1`.
    pub tick: String,
    /// Venue quantity step, e.g. `0.00001`.
    pub step: String,
}

/// Startup check (Req 44.4): one error string per symbol whose tick or step does not fit the
/// fixed decimals, is zero, is malformed, or names a symbol the venue map does not know.
pub fn check_metadata(venue: Venue, rows: &[MetaRow]) -> Vec<String> {
    let mut errors = Vec::new();
    for row in rows {
        let name = venue_name(venue);
        if to_venue_symbol(venue, &row.symbol).is_none() {
            errors.push(format!("{name}: unknown symbol {}", row.symbol));
            continue;
        }
        let checks = [
            ("tick", &row.tick, PRICE_DECIMALS),
            ("step", &row.step, QTY_DECIMALS),
        ];
        for (what, value, decimals) in checks {
            match parse_scaled(value, decimals) {
                Ok(0) => errors.push(format!("{name}: {} {what} {value:?} is zero", row.symbol)),
                Ok(_) => {}
                Err(err) => errors.push(format!(
                    "{name}: {} {what} {value:?} does not fit {decimals} decimals: {err}",
                    row.symbol
                )),
            }
        }
    }
    errors
}

#[cfg(test)]
mod tests {
    use super::*;

    const VENUES: [Venue; 2] = [Venue::Coinbase, Venue::Backpack];

    #[test]
    fn symbol_map_covers_every_pair_in_both_directions() {
        let table = [
            (Venue::Coinbase, "BTC-USD", "BTC-USD"),
            (Venue::Coinbase, "ETH-USD", "ETH-USD"),
            (Venue::Coinbase, "SOL-USD", "SOL-USD"),
            (Venue::Backpack, "BTC-USD", "BTC_USDC"),
            (Venue::Backpack, "ETH-USD", "ETH_USDC"),
            (Venue::Backpack, "SOL-USD", "SOL_USDC"),
        ];
        for (venue, internal, external) in table {
            assert_eq!(to_venue_symbol(venue, internal), Some(external));
            assert_eq!(from_venue_symbol(venue, external), Some(internal));
        }
        for instrument in INSTRUMENTS {
            for venue in VENUES {
                let external = to_venue_symbol(venue, instrument.symbol).unwrap();
                assert_eq!(from_venue_symbol(venue, external), Some(instrument.symbol));
            }
        }
    }

    #[test]
    fn symbol_map_rejects_unknown_and_foreign_symbols() {
        for venue in VENUES {
            assert_eq!(to_venue_symbol(venue, "DOGE-USD"), None);
            assert_eq!(to_venue_symbol(venue, "BTC"), None);
            assert_eq!(to_venue_symbol(venue, "btc-usd"), None);
            assert_eq!(to_venue_symbol(venue, ""), None);
            assert_eq!(from_venue_symbol(venue, "DOGE_USDC"), None);
            assert_eq!(from_venue_symbol(venue, ""), None);
        }
        assert_eq!(from_venue_symbol(Venue::Coinbase, "BTC_USDC"), None);
        assert_eq!(from_venue_symbol(Venue::Backpack, "BTC-USD"), None);
        assert_eq!(to_venue_symbol(Venue::Backpack, "BTC_USDC"), None);
    }

    #[test]
    fn ticks_and_lots_convert_exactly() {
        assert_eq!(to_ticks("64000.1", 2), Ok(Price(6_400_010)));
        assert_eq!(to_ticks("64000", 2), Ok(Price(6_400_000)));
        assert_eq!(to_ticks("0.01", 2), Ok(Price(1)));
        assert_eq!(to_ticks("0", 2), Ok(Price(0)));
        assert_eq!(to_ticks("0.0", 2), Ok(Price(0)));
        assert_eq!(to_ticks("007.50", 2), Ok(Price(750)));
        assert_eq!(to_ticks("64000.100", 2), Ok(Price(6_400_010)));
        assert_eq!(to_ticks("64000.1000000", 2), Ok(Price(6_400_010)));
        assert_eq!(to_lots("0.00001", 8), Ok(Qty(1_000)));
        assert_eq!(to_lots("1", 8), Ok(Qty(100_000_000)));
        assert_eq!(to_lots("0.12345678", 8), Ok(Qty(12_345_678)));
        assert_eq!(to_lots("0.123456780", 8), Ok(Qty(12_345_678)));
    }

    #[test]
    fn extra_nonzero_digits_are_inexact() {
        assert_eq!(to_ticks("64000.101", 2), Err(VenueError::Inexact));
        assert_eq!(to_ticks("0.001", 2), Err(VenueError::Inexact));
        assert_eq!(to_ticks("1.0100001", 2), Err(VenueError::Inexact));
        assert_eq!(to_lots("0.123456789", 8), Err(VenueError::Inexact));
    }

    #[test]
    fn malformed_text_is_rejected() {
        for text in [
            "", ".", "1.", ".5", "1.2.3", "..", "abc", "1e5", "0x10", "-1", "-0", "+1", " 1", "1 ",
            "1 0", "1,5", "NaN", "inf", "１",
        ] {
            assert_eq!(to_ticks(text, 2), Err(VenueError::Malformed), "{text:?}");
            assert_eq!(to_lots(text, 8), Err(VenueError::Malformed), "{text:?}");
        }
    }

    #[test]
    fn values_beyond_i64_overflow() {
        assert_eq!(to_ticks("9223372036854775807", 0), Ok(Price(i64::MAX)));
        assert_eq!(
            to_ticks("9223372036854775808", 0),
            Err(VenueError::Overflow)
        );
        assert_eq!(to_ticks("92233720368547758.07", 2), Ok(Price(i64::MAX)));
        assert_eq!(
            to_ticks("92233720368547758.08", 2),
            Err(VenueError::Overflow)
        );
        assert_eq!(
            to_lots("92233720368.54775808", 8),
            Err(VenueError::Overflow)
        );
        assert_eq!(
            to_lots("99999999999999999999999999", 8),
            Err(VenueError::Overflow)
        );
    }

    #[test]
    fn drop_stats_count_per_venue_and_symbol() {
        let mut stats = DropStats::new();
        stats.record(Venue::Backpack, "BTC-USD", VenueError::Inexact);
        stats.record(Venue::Backpack, "BTC-USD", VenueError::Inexact);
        stats.record(Venue::Backpack, "BTC-USD", VenueError::Malformed);
        stats.record(Venue::Coinbase, "BTC-USD", VenueError::Overflow);
        let counts = stats.counts(Venue::Backpack, "BTC-USD");
        assert_eq!(
            (counts.inexact, counts.malformed, counts.overflow),
            (2, 1, 0)
        );
        assert_eq!(stats.counts(Venue::Coinbase, "BTC-USD").overflow, 1);
        assert_eq!(
            stats.counts(Venue::Backpack, "ETH-USD"),
            DropCounts::default()
        );
        assert_eq!(stats.total(), 4);
        let snap = stats.snapshot();
        assert_eq!(snap.len(), 2);
        assert_eq!(snap[0].0, "backpack");
        assert_eq!(snap[1].0, "coinbase");
    }

    #[test]
    fn should_log_allows_one_line_per_ten_seconds() {
        let mut stats = DropStats::new();
        assert!(!stats.should_log(0), "nothing dropped yet");
        stats.record(Venue::Backpack, "SOL-USD", VenueError::Inexact);
        assert!(stats.should_log(1_000));
        stats.record(Venue::Backpack, "SOL-USD", VenueError::Inexact);
        assert!(!stats.should_log(1_000));
        assert!(!stats.should_log(10_999));
        assert!(stats.should_log(11_000));
        assert!(
            !stats.should_log(30_000),
            "no new drops since the last line"
        );
        stats.record(Venue::Backpack, "SOL-USD", VenueError::Malformed);
        assert!(stats.should_log(30_000));
        assert_eq!(stats.total(), 3, "logging does not reset the counters");
    }

    fn row(symbol: &str, tick: &str, step: &str) -> MetaRow {
        MetaRow {
            symbol: symbol.into(),
            tick: tick.into(),
            step: step.into(),
        }
    }

    #[test]
    fn verified_metadata_table_fits() {
        let backpack = [
            row("BTC-USD", "0.1", "0.00001"),
            row("ETH-USD", "0.01", "0.0001"),
            row("SOL-USD", "0.01", "0.01"),
        ];
        assert!(check_metadata(Venue::Backpack, &backpack).is_empty());
        let coinbase = [
            row("BTC-USD", "0.01", "0.00000001"),
            row("ETH-USD", "0.01", "0.00000001"),
            row("SOL-USD", "0.01", "0.00000001"),
        ];
        assert!(check_metadata(Venue::Coinbase, &coinbase).is_empty());
    }

    #[test]
    fn non_fitting_metadata_gives_one_error_per_problem() {
        let rows = [
            row("BTC-USD", "0.001", "0.00001"),
            row("ETH-USD", "0.01", "0.000000001"),
            row("SOL-USD", "0.01", "0.01"),
        ];
        let errors = check_metadata(Venue::Backpack, &rows);
        assert_eq!(errors.len(), 2, "{errors:?}");
        assert!(errors[0].contains("BTC-USD") && errors[0].contains("tick"));
        assert!(errors[1].contains("ETH-USD") && errors[1].contains("step"));
    }

    #[test]
    fn metadata_rejects_zero_malformed_and_unknown_rows() {
        let rows = [
            row("BTC-USD", "0", "0.01"),
            row("ETH-USD", "abc", "0.01"),
            row("DOGE-USD", "0.01", "0.01"),
        ];
        let errors = check_metadata(Venue::Coinbase, &rows);
        assert_eq!(errors.len(), 3, "{errors:?}");
        assert!(errors[2].contains("unknown symbol"));
    }

    #[test]
    fn venue_error_displays() {
        for err in [
            VenueError::Inexact,
            VenueError::Malformed,
            VenueError::Overflow,
        ] {
            assert!(!err.to_string().is_empty());
        }
    }
}

#[cfg(test)]
#[path = "venue_properties.rs"]
mod properties;
