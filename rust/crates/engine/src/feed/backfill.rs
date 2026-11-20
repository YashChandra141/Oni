//! Live candle backfill (chart-and-tape-fix design D1, Req 2.5, 3.6, 3.7).
//!
//! The core queues a [`HistoryRequest`] when a live key is subscribed. [`run_backfill`] serves
//! those requests one at a time, at least [`REST_PACING`] apart, through a [`HistoryFetcher`].
//! The two production fetchers call the existing public REST functions of the venue adapters,
//! which use `https_get` (rustls with `ring`) and send no credentials. Dropped venue values are
//! counted in a [`DropStats`] and logged, never rounded.
//!
//! The wall clock is read here, in the feed layer, to pick `end_s`. The core never reads it.

use std::future::Future;
use std::pin::Pin;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use protocol::{Bar, Timeframe};
use tokio::sync::mpsc;
use tokio::time::Instant;
use tracing::{debug, warn};

use super::backpack::{REST_PACING, fetch_klines};
use super::coinbase::fetch_candles;
use super::venue::DropStats;
use crate::core::HistoryRequest;

/// The future a [`HistoryFetcher`] returns.
pub type HistoryFuture<'a> = Pin<Box<dyn Future<Output = Result<Vec<Bar>, String>> + Send + 'a>>;

/// Fetches recent public candles of one key. One request per call.
pub trait HistoryFetcher: Send + 'static {
    /// Up to one REST page of bars of `symbol` (internal symbol) at `tf` ending at `end_s`
    /// (Unix seconds), oldest first. The error is a short reason for the Error event.
    fn fetch<'a>(&'a self, symbol: &'a str, tf: Timeframe, end_s: i64) -> HistoryFuture<'a>;
}

/// The outcome of one backfill request, sent back to the runtime.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryResult {
    pub symbol: String,
    pub timeframe: Timeframe,
    pub outcome: Result<Vec<Bar>, String>,
}

/// Backpack klines over the public REST API.
#[derive(Debug, Clone, Copy, Default)]
pub struct BackpackHistory;

impl HistoryFetcher for BackpackHistory {
    fn fetch<'a>(&'a self, symbol: &'a str, tf: Timeframe, end_s: i64) -> HistoryFuture<'a> {
        Box::pin(async move {
            let mut stats = DropStats::new();
            let bars = fetch_klines(symbol, tf, end_s, &mut stats)
                .await
                .map_err(|e| e.to_string());
            log_drops(&stats);
            bars
        })
    }
}

/// Coinbase candles over the public REST API.
#[derive(Debug, Clone, Copy, Default)]
pub struct CoinbaseHistory;

impl HistoryFetcher for CoinbaseHistory {
    fn fetch<'a>(&'a self, symbol: &'a str, tf: Timeframe, end_s: i64) -> HistoryFuture<'a> {
        Box::pin(async move {
            let mut stats = DropStats::new();
            let bars = fetch_candles(symbol, tf, end_s, &mut stats)
                .await
                .map_err(|e| e.to_string());
            log_drops(&stats);
            bars
        })
    }
}

fn log_drops(stats: &DropStats) {
    let dropped = stats.total();
    if dropped > 0 {
        warn!(dropped, "dropped inexact or malformed venue candles");
    }
}

/// How long to wait before the next request, given the time since the previous one finished
/// (`None` before the first request). Pure.
pub fn pacing_wait(since_last: Option<Duration>) -> Duration {
    since_last.map_or(Duration::ZERO, |elapsed| {
        REST_PACING.saturating_sub(elapsed)
    })
}

/// Wall-clock Unix seconds. Feed layer only.
fn wall_clock_s() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
}

/// Serves `requests` one at a time until the request channel closes or `results` is dropped.
/// Each fetch starts at least [`REST_PACING`] after the previous one ended, with `end_s` taken
/// from the wall clock at that moment.
pub async fn run_backfill<F: HistoryFetcher>(
    mut requests: mpsc::Receiver<HistoryRequest>,
    results: mpsc::Sender<HistoryResult>,
    fetcher: F,
) {
    let mut last_end: Option<Instant> = None;
    while let Some(request) = requests.recv().await {
        let wait = pacing_wait(last_end.map(|t| t.elapsed()));
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
        debug!(symbol = %request.symbol, timeframe = %request.timeframe, "backfill request");
        let outcome = fetcher
            .fetch(&request.symbol, request.timeframe, wall_clock_s())
            .await;
        last_end = Some(Instant::now());
        let result = HistoryResult {
            symbol: request.symbol,
            timeframe: request.timeframe,
            outcome,
        };
        if results.send(result).await.is_err() {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::{Arc, Mutex};

    use protocol::{Price, Qty};

    type Calls = Arc<Mutex<Vec<(String, Timeframe, i64, std::time::Instant)>>>;

    /// Records each call and fails for the symbol `fail_symbol`.
    struct Fake {
        calls: Calls,
        fail_symbol: &'static str,
    }

    impl HistoryFetcher for Fake {
        fn fetch<'a>(&'a self, symbol: &'a str, tf: Timeframe, end_s: i64) -> HistoryFuture<'a> {
            Box::pin(async move {
                self.calls.lock().unwrap().push((
                    symbol.to_owned(),
                    tf,
                    end_s,
                    std::time::Instant::now(),
                ));
                if symbol == self.fail_symbol {
                    return Err("boom".to_owned());
                }
                Ok(vec![Bar {
                    t: 0,
                    open: Price(1),
                    high: Price(1),
                    low: Price(1),
                    close: Price(1),
                    volume: Qty(0),
                }])
            })
        }
    }

    fn request(symbol: &str, timeframe: Timeframe) -> HistoryRequest {
        HistoryRequest {
            symbol: symbol.into(),
            timeframe,
        }
    }

    async fn run_all(
        requests: Vec<HistoryRequest>,
        fail_symbol: &'static str,
    ) -> (Vec<HistoryResult>, Calls) {
        let calls: Calls = Arc::default();
        let (req_tx, req_rx) = mpsc::channel(16);
        let (res_tx, mut res_rx) = mpsc::channel(16);
        for r in requests {
            req_tx.send(r).await.unwrap();
        }
        drop(req_tx);
        let fake = Fake {
            calls: Arc::clone(&calls),
            fail_symbol,
        };
        run_backfill(req_rx, res_tx, fake).await;
        let mut out = Vec::new();
        while let Some(r) = res_rx.recv().await {
            out.push(r);
        }
        (out, calls)
    }

    #[tokio::test]
    async fn serves_requests_in_order_one_at_a_time() {
        let (results, calls) = run_all(
            vec![
                request("BTC-USD", Timeframe::M1),
                request("ETH-USD", Timeframe::H1),
            ],
            "",
        )
        .await;
        let keys: Vec<_> = results
            .iter()
            .map(|r| (r.symbol.as_str(), r.timeframe))
            .collect();
        assert_eq!(
            keys,
            [("BTC-USD", Timeframe::M1), ("ETH-USD", Timeframe::H1)]
        );
        assert!(results.iter().all(|r| r.outcome.is_ok()));
        let calls = calls.lock().unwrap();
        assert_eq!(calls.len(), 2);
        // The end time comes from the wall clock: after 2023.
        assert!(calls.iter().all(|c| c.2 > 1_700_000_000));
    }

    #[tokio::test]
    async fn a_fetch_error_becomes_a_failure_result_for_that_key() {
        let (results, _) = run_all(
            vec![
                request("SOL-USD", Timeframe::M5),
                request("BTC-USD", Timeframe::M5),
            ],
            "SOL-USD",
        )
        .await;
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].symbol, "SOL-USD");
        assert_eq!(results[0].timeframe, Timeframe::M5);
        assert_eq!(results[0].outcome, Err("boom".to_owned()));
        // The failure does not stop later requests.
        assert!(results[1].outcome.is_ok());
    }

    #[tokio::test]
    async fn consecutive_fetches_start_at_least_rest_pacing_apart() {
        let (_, calls) = run_all(
            vec![
                request("BTC-USD", Timeframe::M1),
                request("BTC-USD", Timeframe::M5),
            ],
            "",
        )
        .await;
        let calls = calls.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert!(calls[1].3.duration_since(calls[0].3) >= REST_PACING);
    }

    #[test]
    fn pacing_wait_is_the_unspent_part_of_the_gap() {
        assert_eq!(pacing_wait(None), Duration::ZERO);
        assert_eq!(pacing_wait(Some(Duration::ZERO)), REST_PACING);
        assert_eq!(
            pacing_wait(Some(Duration::from_millis(50))),
            Duration::from_millis(150)
        );
        assert_eq!(pacing_wait(Some(REST_PACING)), Duration::ZERO);
        assert_eq!(pacing_wait(Some(Duration::from_secs(5))), Duration::ZERO);
    }
}
