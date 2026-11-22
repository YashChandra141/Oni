//! Raydium_Adapter (Task 6.6, Req 11). Price-only: `GET /mint/price` every 3 s and
//! `GET /pools/info/mint` (pool TVL) once a minute per symbol, both on `api-v3.raydium.io`
//! through the allowlisted [`https_get`]. No transaction host, no swap or quote route is ever
//! called, and a response that carries a `transaction` field is discarded.
//!
//! Parsing is pure: prices become integer ticks by exact string arithmetic (no floats), rounded
//! to the nearest tick as DEX samples are (design Price_Sample rule). Malformed, non-positive,
//! and overflowing values are dropped and counted in [`DropStats`].

#![allow(dead_code)]

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use protocol::{INSTRUMENTS, Price, TimeMs, Venue, instrument};
use serde_json::Value;
use tokio::sync::mpsc::Sender;

use super::allowlist::RAYDIUM_HOST;
use super::http::{HttpError, https_get};
use super::venue::{DropStats, VenueError, dex_mint, to_ticks};

/// Default `/mint/price` poll interval and its floor (`--raydium-poll-ms`).
pub const DEFAULT_POLL_MS: u64 = 3_000;
pub const MIN_POLL_MS: u64 = 1_000;
/// Pool TVL refresh period per symbol.
pub const POOL_PERIOD: Duration = Duration::from_secs(60);
/// 429 backoff bounds.
pub const BACKOFF_MIN: Duration = Duration::from_secs(1);
pub const BACKOFF_MAX: Duration = Duration::from_secs(30);

/// One USD price for one symbol, in ticks. The core turns it into a pair candle and a
/// Synthetic_Book; it is not a trade.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PriceSample {
    pub venue: Venue,
    pub symbol: String,
    pub price: Price,
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

/// What the adapter sends to the runtime.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RaydiumUpdate {
    Price(PriceSample),
    /// Pool TVL of the deepest pool for the symbol's mint, whole USD (fraction truncated).
    PoolTvl {
        symbol: String,
        tvl_usd: i64,
        ts: TimeMs,
    },
}

/// Symbols with a Raydium mint, from the committed map only.
pub fn listed() -> Vec<(&'static str, &'static str)> {
    INSTRUMENTS
        .iter()
        .filter_map(|i| dex_mint(Venue::Raydium, i.symbol).map(|m| (i.symbol, m)))
        .collect()
}

/// Request path for `/mint/price` (mints are comma separated; the committed set is under 50).
pub fn price_path(mints: &[&str]) -> String {
    format!("/mint/price?mints={}", mints.join(","))
}

/// Request path for the deepest pool of one mint.
pub fn pool_path(mint: &str) -> String {
    format!(
        "/pools/info/mint?mint1={mint}&poolType=all&poolSortField=liquidity&sortType=desc&pageSize=1&page=1"
    )
}

/// Converts a decimal price string to ticks, rounding to the nearest tick (half up). Zero is
/// rejected.
pub fn round_to_ticks(text: &str, decimals: u32) -> Result<Price, VenueError> {
    let keep = usize::try_from(decimals).map_err(|_| VenueError::Overflow)?;
    let (int_part, frac) = text.split_once('.').unwrap_or((text, ""));
    let (kept, rest) = if frac.len() > keep {
        frac.split_at(keep)
    } else {
        (frac, "")
    };
    let head = if text.contains('.') {
        format!("{int_part}.{kept}")
    } else {
        int_part.to_owned()
    };
    // A trailing "." (empty kept digits) is malformed for to_ticks; strip it.
    let head = head.strip_suffix('.').unwrap_or(&head);
    let mut ticks = to_ticks(head, decimals)?.0;
    if rest.bytes().next().is_some_and(|d| d >= b'5') {
        if !rest.bytes().all(|b| b.is_ascii_digit()) {
            return Err(VenueError::Malformed);
        }
        ticks = ticks.checked_add(1).ok_or(VenueError::Overflow)?;
    } else if !rest.bytes().all(|b| b.is_ascii_digit()) {
        return Err(VenueError::Malformed);
    }
    if ticks <= 0 {
        return Err(VenueError::Malformed);
    }
    Ok(Price(ticks))
}

/// Parses a `/mint/price` body into samples. Unknown mints are ignored; bad values are dropped
/// and counted. A body with `success: false`, a `transaction` field, or the wrong shape yields
/// nothing.
pub fn parse_prices(body: &[u8], ts: TimeMs, drops: &mut DropStats) -> Vec<PriceSample> {
    let Ok(root) = serde_json::from_slice::<Value>(body) else {
        return Vec::new();
    };
    if root.get("transaction").is_some()
        || root.get("success").and_then(Value::as_bool) == Some(false)
    {
        return Vec::new();
    }
    let Some(data) = root.get("data").and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (symbol, mint) in listed() {
        let Some(info) = instrument(symbol) else {
            continue;
        };
        let Some(value) = data.get(mint) else {
            continue;
        };
        // Only decimal strings are accepted; JSON numbers would need floats.
        let Some(text) = value.as_str() else {
            drops.record(Venue::Raydium, symbol, VenueError::Malformed);
            continue;
        };
        match round_to_ticks(text, info.price_decimals) {
            Ok(price) => out.push(PriceSample {
                venue: Venue::Raydium,
                symbol: symbol.to_owned(),
                price,
                ts,
            }),
            Err(e) => drops.record(Venue::Raydium, symbol, e),
        }
    }
    out
}

/// Parses `/pools/info/mint` into the whole-USD TVL of the first pool.
pub fn parse_pool_tvl(body: &[u8]) -> Option<i64> {
    let root = serde_json::from_slice::<Value>(body).ok()?;
    if root.get("transaction").is_some() {
        return None;
    }
    let tvl = root
        .get("data")?
        .get("data")?
        .as_array()?
        .first()?
        .get("tvl")?;
    let text = match tvl {
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        _ => return None,
    };
    let whole = text.split('.').next()?;
    if whole.is_empty() || !whole.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    whole.parse().ok()
}

fn now_ms() -> TimeMs {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(0)
}

/// Next 429 backoff: starts at 1 s, doubles, caps at 30 s.
pub fn next_backoff(current: Option<Duration>) -> Duration {
    match current {
        None => BACKOFF_MIN,
        Some(d) => d.saturating_mul(2).min(BACKOFF_MAX),
    }
}

/// Polls `/mint/price` until the receiver closes.
async fn run_prices(poll_ms: u64, tx: Sender<RaydiumUpdate>) {
    let mints: Vec<&str> = listed().iter().map(|(_, m)| *m).collect();
    if mints.is_empty() {
        return;
    }
    let path = price_path(&mints);
    let period = Duration::from_millis(poll_ms.max(MIN_POLL_MS));
    let mut drops = DropStats::new();
    let mut backoff: Option<Duration> = None;
    loop {
        let wait = match https_get(RAYDIUM_HOST, &path).await {
            Ok(body) => {
                backoff = None;
                for s in parse_prices(&body, now_ms(), &mut drops) {
                    if tx.send(RaydiumUpdate::Price(s)).await.is_err() {
                        return;
                    }
                }
                period
            }
            Err(HttpError::Status(429)) => {
                let b = next_backoff(backoff);
                backoff = Some(b);
                b.max(period)
            }
            Err(e) => {
                tracing::warn!(error = %e, "raydium price poll failed");
                period
            }
        };
        if drops.should_log(now_ms()) {
            tracing::warn!(drops = drops.total(), "raydium values dropped");
        }
        tokio::time::sleep(wait).await;
    }
}

/// Refreshes pool TVL once a minute per symbol, spread evenly across the minute.
async fn run_pools(tx: Sender<RaydiumUpdate>) {
    let symbols = listed();
    let Ok(n) = u32::try_from(symbols.len()) else {
        return;
    };
    if n == 0 {
        return;
    }
    let gap = POOL_PERIOD / n;
    let mut backoff: Option<Duration> = None;
    loop {
        for (symbol, mint) in &symbols {
            match https_get(RAYDIUM_HOST, &pool_path(mint)).await {
                Ok(body) => {
                    backoff = None;
                    if let Some(tvl_usd) = parse_pool_tvl(&body) {
                        let update = RaydiumUpdate::PoolTvl {
                            symbol: (*symbol).to_owned(),
                            tvl_usd,
                            ts: now_ms(),
                        };
                        if tx.send(update).await.is_err() {
                            return;
                        }
                    }
                }
                Err(HttpError::Status(429)) => {
                    let b = next_backoff(backoff);
                    backoff = Some(b);
                    tokio::time::sleep(b).await;
                }
                Err(e) => tracing::warn!(error = %e, "raydium pool poll failed"),
            }
            tokio::time::sleep(gap).await;
        }
    }
}

/// Runs both pollers until the receiver closes. Public market data only.
pub async fn run(poll_ms: u64, tx: Sender<RaydiumUpdate>) {
    tokio::join!(run_prices(poll_ms, tx.clone()), run_pools(tx));
}
