//! Jupiter_Adapter (Task 6.5, Req 10; design "Jupiter_Adapter").
//!
//! Polls `GET https://api.jup.ag/price/v3?ids=<mint,...>` through the allowlisted
//! [`https_get`](super::http::https_get), for the mints of `venue::dex_mint(Venue::Jupiter, ..)`
//! only. Price-only: no swap, order, or execute endpoint is built or called, and no transaction
//! field is read. The optional `JUPITER_API_KEY` is added by `https_get` itself (header
//! `x-api-key`, Jupiter host only); this module never reads or logs it except to learn whether
//! one is set.
//!
//! Prices are parsed from the raw JSON number text, never through `f64`, and rounded to the
//! nearest tick with integer arithmetic. Invalid entries are dropped and counted in
//! [`DropStats`]. The samples are sent on a channel as [`PriceSample`]; the engine core turns
//! them into candles and a Synthetic_Book (a later task).
//!
//! Limits: keyless at least 2000 ms between requests (0.5 RPS); with a key the interval is
//! `JUPITER_POLL_MS` (default 1000, minimum 500). `https_get` does not expose response headers,
//! so `x-ratelimit-*` and `Retry-After` are not read; a 429 (or any error) backs off 500 ms
//! doubling to 30 s.

// The live wiring (task 6.9) is the caller; until it lands only tests use these items.
#![allow(dead_code)]

use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use protocol::{INSTRUMENTS, Price, TimeMs, Venue};
use serde::Deserialize;
use serde_json::value::RawValue;
use tokio::sync::mpsc;

use super::allowlist::JUPITER_HOST;
use super::http::{HttpError, https_get};
use super::venue::{DropStats, PRICE_DECIMALS, VenueError, dex_mint};

/// Keyless minimum interval between requests (0.5 requests per second).
pub const KEYLESS_INTERVAL_MS: u64 = 2_000;
/// Default interval with a key.
pub const KEYED_DEFAULT_INTERVAL_MS: u64 = 1_000;
/// Smallest interval with a key.
pub const KEYED_MIN_INTERVAL_MS: u64 = 500;
/// First backoff after an error or a 429.
pub const BACKOFF_START_MS: u64 = 500;
/// Largest backoff.
pub const BACKOFF_MAX_MS: u64 = 30_000;

/// One DEX price observation for one internal symbol.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PriceSample {
    pub venue: Venue,
    pub symbol: String,
    /// USD price rounded to the nearest tick, at least one tick.
    pub price: Price,
    /// 24h change in basis points from `priceChange24h`, when present and valid.
    pub change24h_bps: Option<i64>,
    /// Local receive time in epoch ms (set by the adapter, never by the core).
    pub ts: TimeMs,
}

impl From<PriceSample> for super::MarketMsg {
    fn from(sample: PriceSample) -> Self {
        Self::PriceSample {
            venue: sample.venue,
            symbol: sample.symbol,
            price: sample.price,
            ts: sample.ts,
        }
    }
}

#[derive(Deserialize)]
struct Entry {
    #[serde(rename = "usdPrice", default)]
    usd_price: Option<Box<RawValue>>,
    #[serde(rename = "priceChange24h", default)]
    price_change_24h: Option<Box<RawValue>>,
}

/// The poll interval: keyless is fixed at 2000 ms; with a key it is `poll_ms` (default 1000)
/// clamped to at least 500.
pub fn poll_interval_ms(has_key: bool, poll_ms: Option<u64>) -> u64 {
    if has_key {
        poll_ms
            .unwrap_or(KEYED_DEFAULT_INTERVAL_MS)
            .max(KEYED_MIN_INTERVAL_MS)
    } else {
        KEYLESS_INTERVAL_MS
    }
}

/// The mints of every Jupiter-listed internal symbol, in `INSTRUMENTS` order.
fn listed() -> Vec<(&'static str, &'static str)> {
    INSTRUMENTS
        .iter()
        .filter_map(|i| dex_mint(Venue::Jupiter, i.symbol).map(|m| (i.symbol, m)))
        .collect()
}

/// The request path: `/price/v3?ids=<mint,mint,...>` over the committed mints only.
pub fn request_path() -> String {
    let ids: Vec<&str> = listed().iter().map(|&(_, m)| m).collect();
    format!("/price/v3?ids={}", ids.join(","))
}

/// Parses a plain (optionally negative) decimal into an integer scaled by 10^`decimals`,
/// rounding half away from zero on the first dropped digit. Exponents, `+`, spaces, and quotes
/// are `Malformed`.
fn round_scaled(text: &str, decimals: u32) -> Result<i64, VenueError> {
    let (negative, body) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text),
    };
    let (int_part, frac_part) = body.split_once('.').unwrap_or((body, ""));
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    if int_part.is_empty()
        || !digits(int_part)
        || !digits(frac_part)
        || (body.contains('.') && frac_part.is_empty())
    {
        return Err(VenueError::Malformed);
    }
    let keep = usize::try_from(decimals).map_err(|_| VenueError::Overflow)?;
    let kept = frac_part.get(..keep).unwrap_or(frac_part);
    let round_up = frac_part.as_bytes().get(keep).is_some_and(|d| *d >= b'5');
    let mut acc: i64 = 0;
    let padding = keep.saturating_sub(kept.len());
    for b in int_part
        .bytes()
        .chain(kept.bytes())
        .chain(std::iter::repeat_n(b'0', padding))
    {
        acc = acc
            .checked_mul(10)
            .and_then(|v| v.checked_add(i64::from(b - b'0')))
            .ok_or(VenueError::Overflow)?;
    }
    if round_up {
        acc = acc.checked_add(1).ok_or(VenueError::Overflow)?;
    }
    if negative {
        acc = acc.checked_neg().ok_or(VenueError::Overflow)?;
    }
    Ok(acc)
}

/// Parses a response body into samples. Mints that are missing, unknown, or have an invalid
/// price produce no sample; invalid prices are counted in `stats`. A body that is not a JSON
/// object of the expected shape is an error and produces nothing.
pub fn parse_prices(
    body: &[u8],
    ts: TimeMs,
    stats: &mut DropStats,
) -> Result<Vec<PriceSample>, serde_json::Error> {
    let map: HashMap<String, Option<Entry>> = serde_json::from_slice(body)?;
    let mut out = Vec::new();
    for (symbol, mint) in listed() {
        let Some(Some(entry)) = map.get(mint) else {
            continue;
        };
        let Some(raw) = entry.usd_price.as_ref() else {
            stats.record(Venue::Jupiter, symbol, VenueError::Malformed);
            continue;
        };
        let ticks = match round_scaled(raw.get(), PRICE_DECIMALS) {
            Ok(t) if t >= 1 => t,
            Ok(_) => {
                stats.record(Venue::Jupiter, symbol, VenueError::Malformed);
                continue;
            }
            Err(e) => {
                stats.record(Venue::Jupiter, symbol, e);
                continue;
            }
        };
        // priceChange24h is a percent; basis points are percent x 100.
        let change24h_bps = entry
            .price_change_24h
            .as_ref()
            .and_then(|r| round_scaled(r.get(), 2).ok());
        out.push(PriceSample {
            venue: Venue::Jupiter,
            symbol: symbol.to_owned(),
            price: Price(ticks),
            change24h_bps,
            ts,
        });
    }
    Ok(out)
}

fn now_ms() -> TimeMs {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| TimeMs::try_from(d.as_millis()).ok())
        .unwrap_or(0)
}

/// Polls Jupiter until the receiver is dropped. `has_key` is whether `JUPITER_API_KEY` is set
/// (the key itself is attached inside `https_get`); `poll_ms` is `JUPITER_POLL_MS`.
pub async fn run(has_key: bool, poll_ms: Option<u64>, tx: mpsc::Sender<PriceSample>) {
    let interval = Duration::from_millis(poll_interval_ms(has_key, poll_ms));
    let path = request_path();
    let mut stats = DropStats::new();
    let mut backoff = BACKOFF_START_MS;
    loop {
        match https_get(JUPITER_HOST, &path).await {
            Ok(body) => {
                backoff = BACKOFF_START_MS;
                let ts = now_ms();
                match parse_prices(&body, ts, &mut stats) {
                    Ok(samples) => {
                        for sample in samples {
                            if tx.send(sample).await.is_err() {
                                return;
                            }
                        }
                    }
                    Err(e) => tracing::warn!("jupiter: unreadable price response: {e}"),
                }
                if stats.should_log(ts) {
                    for (venue, symbol, counts) in stats.snapshot() {
                        tracing::warn!(
                            "dropped {venue} {symbol} prices: inexact={} malformed={} overflow={}",
                            counts.inexact,
                            counts.malformed,
                            counts.overflow
                        );
                    }
                }
                tokio::time::sleep(interval).await;
            }
            Err(e) => {
                if let HttpError::Status(429) = e {
                    tracing::warn!("jupiter: rate limited, backing off {backoff} ms");
                } else {
                    tracing::warn!("jupiter: request failed: {e}");
                }
                tokio::time::sleep(Duration::from_millis(backoff).max(interval)).await;
                backoff = backoff.saturating_mul(2).min(BACKOFF_MAX_MS);
            }
        }
    }
}
