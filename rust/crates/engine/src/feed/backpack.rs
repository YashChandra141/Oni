//! Backpack adapter (Task 7.5, Req 43.1 to 43.8): public WebSocket trade and depth streams, REST
//! depth snapshots with update-id continuity, and REST kline backfill. Public, unauthenticated
//! endpoints only: no API key, no signature, no auth header (trading-safety rule 1).
//!
//! Same shape as the Coinbase adapter: a pure parse module ([`super::backpack_parse`]),
//! [`connect_and_read`] for one connection, and [`run_backpack`] looping it with
//! [`Backoff`](super::coinbase::Backoff), reporting each failure as `Event::Error` with code
//! `feed_disconnected`.
//!
//! - **Subscribe:** one SUBSCRIBE message with `trade.<SYM>` and `depth.<SYM>` for each symbol.
//! - **Snapshots:** right after subscribing, the adapter fetches one REST depth snapshot per
//!   symbol through a [`SnapshotFetcher`]. While a fetch runs, the adapter does not read the
//!   socket, so frames wait in the socket buffer and are checked for continuity afterwards by
//!   [`DepthSync`], which also buffers updates that arrive while a snapshot is missing. A gap in
//!   the update ids queues a fresh snapshot for that symbol. A failed fetch ends the connection
//!   (error event, backoff, reconnect).
//! - **Pacing:** [`HttpFetcher`] spaces requests at least [`REST_PACING`] apart (5 requests/s).
//! - **Keepalive:** the server pings every 60 s; tungstenite answers while the loop reads.
//!   [`IDLE_TIMEOUT`] without any frame (a ping counts) means the connection is dead.
//! - **Reconnect:** 500 ms doubling to 30 s; reset when trade or depth data parses. Every
//!   reconnect resubscribes and resets all [`DepthSync`] states.

// The runtime uses `run_backpack` and `fetch_klines`; some other items only tests use so far.
#![allow(dead_code)]

use std::collections::VecDeque;
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use protocol::{Bar, ErrorCode, Event, Timeframe, Venue};
use tokio::sync::mpsc;
use tokio::time::Instant;
use tokio_tungstenite::connect_async_with_config;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tracing::{debug, info, warn};

use super::MarketMsg;
use super::backpack_parse::{
    DepthSnapshot, DepthSync, ParseError, ParsedBackpack, interval_name, parse_depth_snapshot,
    parse_klines, parse_message, subscribe_message,
};
use super::coinbase::{Backoff, CONNECT_TIMEOUT};
use super::http::{HttpError, https_get, install_crypto_provider};
use super::venue::{DropStats, to_venue_symbol};

/// The public market data WebSocket.
pub const BACKPACK_WS_URL: &str = "wss://ws.backpack.exchange";
/// Host of the public REST API.
pub const BACKPACK_REST_HOST: &str = "api.backpack.exchange";
/// Smallest gap between two REST requests: 5 requests per second.
pub const REST_PACING: Duration = Duration::from_millis(200);
/// No frame for this long means the connection is dead (the server pings every 60 s).
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(150);
/// Largest WebSocket message or frame accepted, in bytes.
pub const MAX_MESSAGE_BYTES: usize = 8 << 20;
/// Most klines requested per call. TODO(Task 7.7): confirm the venue's limit; a 400 for a wide
/// window means "narrow it" (venue notes, open point 6).
pub const MAX_KLINES: i64 = 500;
/// Longest error text put in an Event, in characters.
const MAX_REASON_CHARS: usize = 200;

/// Why one connection ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdapterError {
    /// TCP, TLS, or the WebSocket upgrade failed.
    Connect(String),
    /// Sending the subscribe message failed.
    Subscribe(String),
    /// A REST depth snapshot could not be fetched or read.
    Snapshot(String),
    /// The stream ended without a Close frame.
    Closed,
    /// Reading a frame failed.
    Read(String),
    /// No frame arrived within [`IDLE_TIMEOUT`].
    Idle,
    /// The receiving side of the market channel is gone; the adapter should stop.
    Shutdown,
}

impl fmt::Display for AdapterError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Connect(e) => write!(f, "connect failed: {e}"),
            Self::Subscribe(e) => write!(f, "subscribe failed: {e}"),
            Self::Snapshot(e) => write!(f, "depth snapshot failed: {e}"),
            Self::Closed => f.write_str("connection closed"),
            Self::Read(e) => write!(f, "read failed: {e}"),
            Self::Idle => write!(f, "no data for {} s", IDLE_TIMEOUT.as_secs()),
            Self::Shutdown => f.write_str("shutting down"),
        }
    }
}

impl std::error::Error for AdapterError {}

/// Why a REST fetch failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchError {
    /// The symbol is not in the venue map.
    UnknownSymbol(String),
    Http(HttpError),
    Parse(ParseError),
}

impl fmt::Display for FetchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownSymbol(s) => write!(f, "unknown symbol {s}"),
            Self::Http(e) => write!(f, "request failed: {e}"),
            Self::Parse(e) => write!(f, "response unreadable: {e}"),
        }
    }
}

impl std::error::Error for FetchError {}

fn shorten(text: &str) -> String {
    if text.chars().count() <= MAX_REASON_CHARS {
        return text.to_owned();
    }
    let mut cut: String = text.chars().take(MAX_REASON_CHARS).collect();
    cut.push('…');
    cut
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

fn log_drops(stats: &mut DropStats) {
    if !stats.should_log(now_ms()) {
        return;
    }
    for (venue, symbol, counts) in stats.snapshot() {
        warn!(
            venue,
            symbol = %symbol,
            inexact = counts.inexact,
            malformed = counts.malformed,
            overflow = counts.overflow,
            "dropped venue values that do not fit the fixed decimals"
        );
    }
}

/// The future a [`SnapshotFetcher`] returns.
pub type SnapshotFuture<'a> =
    Pin<Box<dyn Future<Output = Result<DepthSnapshot, FetchError>> + Send + 'a>>;

/// Fetches the REST depth snapshot of one symbol. The adapter takes this as a parameter so tests
/// can substitute a fake; production uses [`HttpFetcher`].
pub trait SnapshotFetcher: Send {
    /// `symbol` is the internal symbol (`SOL-USD`). The result carries the same internal symbol.
    fn fetch<'a>(&'a mut self, symbol: &'a str) -> SnapshotFuture<'a>;
}

/// The REST path and query of a depth request, for a Backpack symbol (`SOL_USDC`).
pub fn depth_path(venue_symbol: &str) -> String {
    format!("/api/v1/depth?symbol={venue_symbol}")
}

/// Production [`SnapshotFetcher`]: HTTPS GET to the public depth endpoint, at most one request
/// per [`REST_PACING`]. Sends no credentials of any kind.
pub struct HttpFetcher {
    host: String,
    stats: DropStats,
    last_request: Option<Instant>,
}

impl HttpFetcher {
    /// `host` is a bare host name, normally [`BACKPACK_REST_HOST`].
    pub fn new(host: &str) -> Self {
        Self {
            host: host.to_owned(),
            stats: DropStats::new(),
            last_request: None,
        }
    }
}

impl SnapshotFetcher for HttpFetcher {
    fn fetch<'a>(&'a mut self, symbol: &'a str) -> SnapshotFuture<'a> {
        Box::pin(async move {
            let venue_symbol = to_venue_symbol(Venue::Backpack, symbol)
                .ok_or_else(|| FetchError::UnknownSymbol(symbol.to_owned()))?;
            if let Some(last) = self.last_request {
                let elapsed = last.elapsed();
                if elapsed < REST_PACING {
                    tokio::time::sleep(REST_PACING - elapsed).await;
                }
            }
            self.last_request = Some(Instant::now());
            let body = https_get(&self.host, &depth_path(venue_symbol))
                .await
                .map_err(FetchError::Http)?;
            let text = std::str::from_utf8(&body)
                .map_err(|_| FetchError::Parse(ParseError::Json("body is not UTF-8".to_owned())))?;
            parse_depth_snapshot(text, symbol, &mut self.stats).map_err(FetchError::Parse)
        })
    }
}

/// Runs the Backpack feed until `tx` or `errors` is dropped. `symbols` are internal symbols
/// (`BTC-USD`); unknown ones are ignored. Every connection failure is reported as an
/// `Event::Error` with code `feed_disconnected` before the reconnect delay (Req 43.5).
pub async fn run_backpack(
    tx: mpsc::Sender<MarketMsg>,
    errors: mpsc::Sender<Event>,
    symbols: Vec<String>,
) {
    let known: Vec<String> = symbols
        .into_iter()
        .filter(|s| to_venue_symbol(Venue::Backpack, s).is_some())
        .collect();
    if known.is_empty() {
        warn!("backpack adapter has no known symbols; idling");
        std::future::pending::<()>().await;
    }
    let mut fetcher = HttpFetcher::new(BACKPACK_REST_HOST);
    run_with_url(
        BACKPACK_WS_URL,
        &known,
        &tx,
        &errors,
        Backoff::new(),
        &mut fetcher,
    )
    .await;
}

/// The reconnect loop. `url` is a parameter so tests can use a local `ws://` server; production
/// callers go through [`run_backpack`], which always passes [`BACKPACK_WS_URL`].
pub(crate) async fn run_with_url<F: SnapshotFetcher>(
    url: &str,
    symbols: &[String],
    tx: &mpsc::Sender<MarketMsg>,
    errors: &mpsc::Sender<Event>,
    mut backoff: Backoff,
    fetcher: &mut F,
) {
    let mut stats = DropStats::new();
    let mut sync = DepthSync::new();
    loop {
        info!(url, "connecting to the backpack feed");
        let outcome = connect_and_read(
            url,
            symbols,
            tx,
            &mut stats,
            &mut backoff,
            fetcher,
            &mut sync,
        )
        .await;
        let reason = match outcome {
            Err(AdapterError::Shutdown) => return,
            Ok(()) => "connection closed by the server".to_owned(),
            Err(err) => err.to_string(),
        };
        warn!(%reason, "backpack feed disconnected");
        let event = Event::Error {
            code: ErrorCode::FeedDisconnected,
            message: shorten(&format!("backpack feed disconnected: {reason}")),
        };
        if errors.send(event).await.is_err() {
            return;
        }
        tokio::time::sleep(backoff.next_delay()).await;
    }
}

async fn send_all(tx: &mpsc::Sender<MarketMsg>, msgs: Vec<MarketMsg>) -> Result<(), AdapterError> {
    for msg in msgs {
        tx.send(msg).await.map_err(|_| AdapterError::Shutdown)?;
    }
    Ok(())
}

/// Opens one connection, subscribes, syncs every symbol's book, and forwards normalized
/// messages until the connection ends. `symbols` are internal symbols.
///
/// Returns `Ok(())` when the server sends a Close frame and `Err` for every other ending. Resets
/// `sync` first (a new connection starts with no books) and resets `backoff` whenever trade or
/// depth data parses.
pub async fn connect_and_read<F: SnapshotFetcher>(
    url: &str,
    symbols: &[String],
    tx: &mpsc::Sender<MarketMsg>,
    stats: &mut DropStats,
    backoff: &mut Backoff,
    fetcher: &mut F,
    sync: &mut DepthSync,
) -> Result<(), AdapterError> {
    install_crypto_provider();
    sync.reset();
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_MESSAGE_BYTES))
        .max_frame_size(Some(MAX_MESSAGE_BYTES));
    let connect = connect_async_with_config(url, Some(config), true);
    let (mut ws, _response) = tokio::time::timeout(CONNECT_TIMEOUT, connect)
        .await
        .map_err(|_| AdapterError::Connect("timed out".to_owned()))?
        .map_err(|e| AdapterError::Connect(e.to_string()))?;

    let venue_symbols: Vec<&str> = symbols
        .iter()
        .filter_map(|s| to_venue_symbol(Venue::Backpack, s))
        .collect();
    ws.send(Message::text(subscribe_message(&venue_symbols)))
        .await
        .map_err(|e| AdapterError::Subscribe(e.to_string()))?;
    debug!("subscribed to trade and depth streams");

    // Symbols that still need a REST snapshot, in order. Everything starts here.
    let mut pending: VecDeque<String> = symbols.iter().cloned().collect();

    loop {
        if let Some(symbol) = pending.pop_front() {
            let snapshot = fetcher
                .fetch(&symbol)
                .await
                .map_err(|e| AdapterError::Snapshot(format!("{symbol}: {e}")))?;
            let out = sync.on_snapshot(snapshot);
            if out.need_resync {
                pending.push_back(symbol);
            }
            send_all(tx, out.msgs).await?;
            continue;
        }

        let frame = tokio::time::timeout(IDLE_TIMEOUT, ws.next())
            .await
            .map_err(|_| AdapterError::Idle)?;
        match frame {
            None => return Err(AdapterError::Closed),
            Some(Err(e)) => return Err(AdapterError::Read(e.to_string())),
            Some(Ok(Message::Close(_))) => return Ok(()),
            Some(Ok(Message::Text(text))) => {
                match parse_message(text.as_str(), stats) {
                    ParsedBackpack::Trade(msg) => {
                        backoff.reset();
                        tx.send(msg).await.map_err(|_| AdapterError::Shutdown)?;
                    }
                    ParsedBackpack::Depth(update) => {
                        backoff.reset();
                        let symbol = update.symbol.clone();
                        let out = sync.on_update(update);
                        if out.need_resync {
                            debug!(%symbol, "depth update ids have a gap; refetching the snapshot");
                            pending.push_back(symbol);
                        }
                        send_all(tx, out.msgs).await?;
                    }
                    ParsedBackpack::Ignored => {}
                    ParsedBackpack::Unreadable(err) => {
                        warn!(%err, "skipped an unreadable backpack frame");
                    }
                }
                log_drops(stats);
            }
            // Pings are answered by tungstenite; pongs and binary frames carry nothing.
            Some(Ok(_)) => {}
        }
    }
}

/// `(start, end)` in Unix seconds for the most recent [`MAX_KLINES`] bars ending at `end_s`.
pub fn kline_window(end_s: i64, timeframe: Timeframe) -> (i64, i64) {
    let span = MAX_KLINES.saturating_mul(timeframe.millis() / 1_000);
    (end_s.saturating_sub(span).max(0), end_s)
}

/// The REST path and query of one kline request. `startTime` and `endTime` are Unix SECONDS.
pub fn klines_path(venue_symbol: &str, timeframe: Timeframe, start_s: i64, end_s: i64) -> String {
    format!(
        "/api/v1/klines?symbol={venue_symbol}&interval={}&startTime={start_s}&endTime={end_s}",
        interval_name(timeframe)
    )
}

/// Fetches up to [`MAX_KLINES`] recent bars of `symbol` (internal symbol) ending at `end_s` (Unix
/// seconds, supplied by the caller), oldest first (Req 43.4). One request; the caller decides
/// when to backfill and must not call this in a loop (rate limits unknown). The runtime calls it
/// through `feed::backfill::BackpackHistory`, paced by [`REST_PACING`].
pub async fn fetch_klines(
    symbol: &str,
    timeframe: Timeframe,
    end_s: i64,
    stats: &mut DropStats,
) -> Result<Vec<Bar>, FetchError> {
    let venue_symbol = to_venue_symbol(Venue::Backpack, symbol)
        .ok_or_else(|| FetchError::UnknownSymbol(symbol.to_owned()))?;
    let (start_s, end_s) = kline_window(end_s, timeframe);
    let path = klines_path(venue_symbol, timeframe, start_s, end_s);
    let body = https_get(BACKPACK_REST_HOST, &path)
        .await
        .map_err(FetchError::Http)?;
    let text = std::str::from_utf8(&body)
        .map_err(|_| FetchError::Parse(ParseError::Json("body is not UTF-8".to_owned())))?;
    let bars = parse_klines(text, symbol, stats).map_err(FetchError::Parse)?;
    Ok(bars.into_iter().map(|b| b.into_bar()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::{Arc, Mutex};

    use protocol::{Level, Price, Qty, Side};
    use serde_json::Value;
    use tokio::net::{TcpListener, TcpStream};
    use tokio_tungstenite::{WebSocketStream, accept_hdr_async};

    use crate::feed::test_ws::HeaderNames;

    const SOL_FIRST_ID: u64 = 4_686_272_930;

    /// Returns snapshots whose id is picked by call index (the last id repeats) and records the
    /// symbol of every call.
    struct FakeFetcher {
        calls: Arc<Mutex<Vec<String>>>,
        ids: Vec<u64>,
    }

    impl SnapshotFetcher for FakeFetcher {
        fn fetch<'a>(&'a mut self, symbol: &'a str) -> SnapshotFuture<'a> {
            let index = {
                let mut calls = self.calls.lock().unwrap();
                calls.push(symbol.to_owned());
                calls.len() - 1
            };
            let id = self
                .ids
                .get(index)
                .or(self.ids.last())
                .copied()
                .unwrap_or(0);
            let snapshot = DepthSnapshot {
                symbol: symbol.to_owned(),
                last_update_id: id,
                bids: vec![(Price(7_546), Qty(1))],
                asks: vec![(Price(7_547), Qty(2))],
                ts: 5,
            };
            Box::pin(async move { Ok::<_, FetchError>(snapshot) })
        }
    }

    fn symbols() -> Vec<String> {
        ["BTC-USD", "ETH-USD", "SOL-USD"]
            .iter()
            .map(|s| (*s).to_owned())
            .collect()
    }

    fn sample(wrapped: &str) -> String {
        let value: Value = serde_json::from_str(wrapped).unwrap();
        value["sample"].to_string()
    }

    fn depth_text(first: u64, last: u64) -> String {
        serde_json::json!({
            "stream": "depth.SOL_USDC",
            "data": {"e":"depth","E":1,"s":"SOL_USDC","a":[["75.50","1"]],"b":[],"U":first,"u":last,"T":2_000_000}
        })
        .to_string()
    }

    async fn next_text(ws: &mut WebSocketStream<TcpStream>) -> String {
        loop {
            match ws.next().await {
                Some(Ok(Message::Text(text))) => return text.as_str().to_owned(),
                Some(Ok(_)) => {}
                other => panic!("client connection ended: {other:?}"),
            }
        }
    }

    async fn accept(listener: &TcpListener) -> (WebSocketStream<TcpStream>, Vec<String>) {
        let (socket, _) = listener.accept().await.unwrap();
        let mut names = Vec::new();
        let ws = accept_hdr_async(socket, HeaderNames(&mut names))
            .await
            .unwrap();
        (ws, names)
    }

    fn assert_no_auth_headers(names: &[String]) {
        for forbidden in [
            "authorization",
            "cookie",
            "x-api-key",
            "x-signature",
            "x-timestamp",
            "x-window",
        ] {
            assert!(!names.iter().any(|n| n == forbidden), "{names:?}");
        }
    }

    /// Reads the SUBSCRIBE and checks it: six streams, no auth fields.
    async fn expect_subscribe(ws: &mut WebSocketStream<TcpStream>) {
        let text = next_text(ws).await;
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
        assert_eq!(v.as_object().unwrap().len(), 2, "{text}");
    }

    fn snapshot_symbol(msg: &MarketMsg) -> &str {
        assert!(matches!(msg, MarketMsg::BookSnapshot { .. }), "{msg:?}");
        msg.symbol()
    }

    #[test]
    fn paths_and_windows() {
        assert_eq!(depth_path("SOL_USDC"), "/api/v1/depth?symbol=SOL_USDC");
        assert_eq!(
            klines_path("BTC_USDC", Timeframe::M15, 10, 20),
            "/api/v1/klines?symbol=BTC_USDC&interval=15m&startTime=10&endTime=20"
        );
        assert_eq!(
            kline_window(1_794_632_280, Timeframe::M1),
            (1_794_602_280, 1_794_632_280)
        );
        assert_eq!(kline_window(100, Timeframe::D1), (0, 100));
    }

    #[tokio::test]
    async fn unknown_symbol_fails_before_any_request() {
        let mut stats = DropStats::new();
        let result = fetch_klines("NOPE-USD", Timeframe::M1, 1_000, &mut stats).await;
        assert_eq!(result, Err(FetchError::UnknownSymbol("NOPE-USD".into())));
        let mut fetcher = HttpFetcher::new("127.0.0.1");
        assert_eq!(
            fetcher.fetch("NOPE-USD").await,
            Err(FetchError::UnknownSymbol("NOPE-USD".into()))
        );
    }

    // Req 43.1, 43.2, 43.3: subscribes with no credentials; snapshot, then deltas, then trades.
    #[tokio::test]
    async fn subscribes_syncs_and_forwards_in_order() {
        let depth = sample(include_str!("../../tests/data/backpack_depth.json"));
        let trade = sample(include_str!("../../tests/data/backpack_trade.json"));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let (tx, mut market) = mpsc::channel::<MarketMsg>(64);
        let (err_tx, _errors) = mpsc::channel::<Event>(16);
        let calls = Arc::new(Mutex::new(Vec::new()));
        let mut fetcher = FakeFetcher {
            calls: Arc::clone(&calls),
            ids: vec![SOL_FIRST_ID],
        };
        let backoff = Backoff::with_bounds(Duration::from_millis(10), Duration::from_millis(40));
        let syms = symbols();

        let driver = async {
            let (mut ws, names) = accept(&listener).await;
            assert_no_auth_headers(&names);
            expect_subscribe(&mut ws).await;
            let mut snapshots = Vec::new();
            for _ in 0..3 {
                let msg = market.recv().await.unwrap();
                snapshots.push(snapshot_symbol(&msg).to_owned());
            }
            assert_eq!(snapshots, ["BTC-USD", "ETH-USD", "SOL-USD"]);

            ws.send(Message::text(depth)).await.unwrap();
            ws.send(Message::text(trade)).await.unwrap();
            let level = |price, qty| (Price(price), Qty(qty));
            let mut deltas = Vec::new();
            for _ in 0..3 {
                let MarketMsg::BookDelta {
                    side, price, qty, ..
                } = market.recv().await.unwrap()
                else {
                    panic!("expected a delta");
                };
                deltas.push((side, level(price.0, qty.0)));
            }
            assert_eq!(
                deltas,
                [
                    (Side::Buy, level(7_546, 30_472_000_000)),
                    (Side::Sell, level(7_547, 19_850_000_000)),
                    (Side::Sell, level(7_562, 0)),
                ]
            );
            let trade = market.recv().await.unwrap();
            assert!(
                matches!(
                    trade,
                    MarketMsg::Trade {
                        side: Side::Sell,
                        ..
                    }
                ),
                "{trade:?}"
            );
        };

        let outcome = tokio::time::timeout(Duration::from_secs(10), async {
            tokio::select! {
                () = run_with_url(&url, &syms, &tx, &err_tx, backoff, &mut fetcher) => {
                    panic!("the adapter stopped on its own");
                }
                () = driver => {}
            }
        })
        .await;
        assert!(outcome.is_ok(), "test timed out");
        assert_eq!(
            *calls.lock().unwrap(),
            ["BTC-USD", "ETH-USD", "SOL-USD"],
            "one snapshot per symbol, no extra fetches"
        );
    }

    // Req 43.3: a gap in the update ids triggers another snapshot fetch and a new BookSnapshot.
    #[tokio::test]
    async fn a_gap_refetches_the_snapshot() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let (tx, mut market) = mpsc::channel::<MarketMsg>(64);
        let (err_tx, _errors) = mpsc::channel::<Event>(16);
        let calls = Arc::new(Mutex::new(Vec::new()));
        let mut fetcher = FakeFetcher {
            calls: Arc::clone(&calls),
            ids: vec![100, 100, 100, 200],
        };
        let backoff = Backoff::with_bounds(Duration::from_millis(10), Duration::from_millis(40));
        let syms = symbols();

        let driver = async {
            let (mut ws, _names) = accept(&listener).await;
            expect_subscribe(&mut ws).await;
            for _ in 0..3 {
                market.recv().await.unwrap();
            }
            // Continuous update, then a gap (111..112 after 101), then silence.
            ws.send(Message::text(depth_text(101, 101))).await.unwrap();
            assert!(matches!(
                market.recv().await.unwrap(),
                MarketMsg::BookDelta { .. }
            ));
            ws.send(Message::text(depth_text(111, 112))).await.unwrap();
            // The refetch yields a new snapshot at id 200 for SOL-USD.
            let msg = market.recv().await.unwrap();
            assert_eq!(snapshot_symbol(&msg), "SOL-USD");
            // The next update continues from 200.
            ws.send(Message::text(depth_text(201, 201))).await.unwrap();
            assert!(matches!(
                market.recv().await.unwrap(),
                MarketMsg::BookDelta { .. }
            ));
            // A stale update after the resync produces nothing; the following one flows.
            ws.send(Message::text(depth_text(150, 160))).await.unwrap();
            ws.send(Message::text(depth_text(202, 202))).await.unwrap();
            let MarketMsg::BookDelta { ts, .. } = market.recv().await.unwrap() else {
                panic!("expected a delta");
            };
            assert_eq!(ts, 2_000);
        };

        let outcome = tokio::time::timeout(Duration::from_secs(10), async {
            tokio::select! {
                () = run_with_url(&url, &syms, &tx, &err_tx, backoff, &mut fetcher) => {
                    panic!("the adapter stopped on its own");
                }
                () = driver => {}
            }
        })
        .await;
        assert!(outcome.is_ok(), "test timed out");
        assert_eq!(
            *calls.lock().unwrap(),
            ["BTC-USD", "ETH-USD", "SOL-USD", "SOL-USD"]
        );
    }

    // Req 43.5: a dropped connection yields feed_disconnected, a reconnect with a fresh
    // SUBSCRIBE, and fresh snapshots (the sync state was reset).
    #[tokio::test]
    async fn reconnects_with_a_fresh_subscribe_and_sync() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let (tx, mut market) = mpsc::channel::<MarketMsg>(64);
        let (err_tx, mut errors) = mpsc::channel::<Event>(16);
        let calls = Arc::new(Mutex::new(Vec::new()));
        let mut fetcher = FakeFetcher {
            calls: Arc::clone(&calls),
            ids: vec![100, 100, 100, 500],
        };
        let backoff = Backoff::with_bounds(Duration::from_millis(10), Duration::from_millis(40));
        let syms = symbols();

        let driver = async {
            let (mut ws, names) = accept(&listener).await;
            assert_no_auth_headers(&names);
            expect_subscribe(&mut ws).await;
            for _ in 0..3 {
                market.recv().await.unwrap();
            }
            ws.send(Message::text(depth_text(101, 101))).await.unwrap();
            assert!(matches!(
                market.recv().await.unwrap(),
                MarketMsg::BookDelta { .. }
            ));
            drop(ws);

            let event = errors.recv().await.unwrap();
            let Event::Error { code, message } = event else {
                panic!("expected an error event, got {event:?}");
            };
            assert_eq!(code, ErrorCode::FeedDisconnected);
            assert!(
                message.starts_with("backpack feed disconnected"),
                "{message}"
            );

            let (mut ws, names) = accept(&listener).await;
            assert_no_auth_headers(&names);
            expect_subscribe(&mut ws).await;
            let mut snapshots = Vec::new();
            for _ in 0..3 {
                let msg = market.recv().await.unwrap();
                snapshots.push(snapshot_symbol(&msg).to_owned());
            }
            assert_eq!(snapshots, ["BTC-USD", "ETH-USD", "SOL-USD"]);
            // Update 501 continues from the new snapshot id 500 (the old state was reset).
            ws.send(Message::text(depth_text(501, 501))).await.unwrap();
            assert!(matches!(
                market.recv().await.unwrap(),
                MarketMsg::BookDelta { .. }
            ));
            let _keep = ws;
        };

        let outcome = tokio::time::timeout(Duration::from_secs(10), async {
            tokio::select! {
                () = run_with_url(&url, &syms, &tx, &err_tx, backoff, &mut fetcher) => {
                    panic!("the adapter stopped on its own");
                }
                () = driver => {}
            }
        })
        .await;
        assert!(outcome.is_ok(), "test timed out");
        assert_eq!(calls.lock().unwrap().len(), 6);
    }

    #[tokio::test]
    async fn adapter_stops_when_the_market_receiver_is_gone() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let (tx, market) = mpsc::channel::<MarketMsg>(1);
        let (err_tx, _errors) = mpsc::channel::<Event>(1);
        drop(market);
        let mut fetcher = FakeFetcher {
            calls: Arc::new(Mutex::new(Vec::new())),
            ids: vec![1],
        };
        let server = async {
            let (_ws, _) = accept(&listener).await;
            std::future::pending::<()>().await;
        };
        let backoff = Backoff::with_bounds(Duration::from_millis(10), Duration::from_millis(40));
        let syms = symbols();
        let run = run_with_url(&url, &syms, &tx, &err_tx, backoff, &mut fetcher);
        let done = tokio::time::timeout(Duration::from_secs(10), async {
            tokio::select! {
                () = run => true,
                () = server => false,
            }
        })
        .await;
        assert!(matches!(done, Ok(true)), "adapter did not stop: {done:?}");
    }

    /// Keeps the unused import list honest: `Level` is part of the snapshot message shape.
    #[test]
    fn snapshot_message_shape() {
        let msg = MarketMsg::BookSnapshot {
            venue: protocol::Venue::Replay,
            symbol: "SOL-USD".into(),
            bids: vec![Level {
                price: Price(1),
                qty: Qty(1),
            }],
            asks: Vec::new(),
            ts: 0,
        };
        assert_eq!(snapshot_symbol(&msg), "SOL-USD");
    }
}
