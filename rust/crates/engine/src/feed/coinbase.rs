//! Coinbase adapter (Task 7.4, Req 5.1, 5.2, 5.4, 5.5): public Advanced Trade WebSocket plus REST
//! candle backfill. Public, unauthenticated endpoints only: no JWT, no keys, no signing
//! (trading-safety rule 1).
//!
//! Shape shared with the Backpack adapter (Task 7.5): a pure `<venue>_parse` module, a
//! `connect_and_read` function that runs one connection until it ends, and a `run_*` supervisor
//! that loops `connect_and_read` with [`Backoff`], reports each failure as an
//! `Event::Error { code: feed_disconnected }` on the errors channel, and exits only when a
//! receiver is dropped. The runtime owns both receivers and treats `MarketMsg` exactly like a
//! replayed message.
//!
//! - **Subscribe:** one text message per channel (`market_trades`, `level2`, `heartbeats`), sent
//!   right after the handshake, well inside Coinbase's 5 s limit.
//! - **Keepalive:** tungstenite answers pings. The `heartbeats` channel sends a message every
//!   second, so [`IDLE_TIMEOUT`] without any frame means the connection is dead.
//! - **Reconnect:** 500 ms doubling to 30 s ([`Backoff`]); reset when a message arrives. Every
//!   reconnect resubscribes, and the new `level2` snapshot replaces the book.
//! - **TLS:** `wss://` goes through tokio-tungstenite's rustls connector (ring provider).

// The runtime uses `run_coinbase`; `fetch_candles` waits for the live Subscribe wiring.
#![allow(dead_code)]

use std::fmt;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use protocol::{Bar, ErrorCode, Event, Timeframe, Venue};
use tokio::sync::mpsc;
use tokio_tungstenite::connect_async_with_config;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tracing::{debug, info, warn};

use super::MarketMsg;
use super::coinbase_parse::{
    ParseError, granularity, parse_candles, parse_message, subscribe_messages,
};
use super::http::{HttpError, https_get, install_crypto_provider};
use super::venue::{DropStats, to_venue_symbol};

/// The public market data WebSocket. `advanced-trade-ws-user` is the authenticated feed and is
/// never used.
pub const COINBASE_WS_URL: &str = "wss://advanced-trade-ws.coinbase.com";
/// Host of the public REST API.
pub const COINBASE_REST_HOST: &str = "api.coinbase.com";
/// Delay before the first reconnect.
pub const INITIAL_BACKOFF: Duration = Duration::from_millis(500);
/// Longest delay between connection attempts.
pub const MAX_BACKOFF: Duration = Duration::from_secs(30);
/// Time allowed for TCP, TLS, and the WebSocket upgrade.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// No frame for this long means the connection is dead (`heartbeats` arrive every second).
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(30);
/// Largest WebSocket message or frame accepted, in bytes. A full `level2` snapshot is far below.
pub const MAX_MESSAGE_BYTES: usize = 8 << 20;
/// Most candles one REST call returns.
pub const MAX_CANDLES: i64 = 350;
/// Longest error text put in an Event, in characters.
const MAX_REASON_CHARS: usize = 200;

/// Reconnect delays: doubling from the initial value up to the cap. Pure; no clock.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Backoff {
    initial: Duration,
    max: Duration,
    next: Duration,
}

impl Backoff {
    /// 500 ms doubling to 30 s.
    pub fn new() -> Self {
        Self::with_bounds(INITIAL_BACKOFF, MAX_BACKOFF)
    }

    /// Custom bounds, for tests.
    pub fn with_bounds(initial: Duration, max: Duration) -> Self {
        Self {
            initial,
            max,
            next: initial.min(max),
        }
    }

    /// The delay to wait now; the following call returns twice as much, up to the cap.
    pub fn next_delay(&mut self) -> Duration {
        let delay = self.next;
        self.next = delay.saturating_mul(2).min(self.max);
        delay
    }

    /// Starts the sequence over at the initial delay.
    pub fn reset(&mut self) {
        self.next = self.initial.min(self.max);
    }
}

impl Default for Backoff {
    fn default() -> Self {
        Self::new()
    }
}

/// Why one connection ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdapterError {
    /// TCP, TLS, or the WebSocket upgrade failed.
    Connect(String),
    /// Sending a subscribe message failed.
    Subscribe(String),
    /// The stream ended without a Close frame.
    Closed,
    /// Reading a frame failed.
    Read(String),
    /// No frame arrived within [`IDLE_TIMEOUT`].
    Idle,
    /// The server sent an error message.
    Server(String),
    /// The receiving side of the market channel is gone; the adapter should stop.
    Shutdown,
}

impl fmt::Display for AdapterError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Connect(e) => write!(f, "connect failed: {e}"),
            Self::Subscribe(e) => write!(f, "subscribe failed: {e}"),
            Self::Closed => f.write_str("connection closed"),
            Self::Read(e) => write!(f, "read failed: {e}"),
            Self::Idle => write!(f, "no data for {} s", IDLE_TIMEOUT.as_secs()),
            Self::Server(m) => write!(f, "server error: {m}"),
            Self::Shutdown => f.write_str("shutting down"),
        }
    }
}

impl std::error::Error for AdapterError {}

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

/// Runs the Coinbase feed until `tx` or `errors` is dropped. `symbols` are internal symbols
/// (`BTC-USD`); unknown ones are ignored. Every connection failure is reported as an
/// `Event::Error` with code `feed_disconnected` before the reconnect delay (Req 5.5).
pub async fn run_coinbase(
    tx: mpsc::Sender<MarketMsg>,
    errors: mpsc::Sender<Event>,
    symbols: Vec<String>,
) {
    let products: Vec<&str> = symbols
        .iter()
        .filter_map(|s| to_venue_symbol(Venue::Coinbase, s))
        .collect();
    if products.is_empty() {
        warn!("coinbase adapter has no known symbols; idling");
        std::future::pending::<()>().await;
    }
    run_with_url(COINBASE_WS_URL, &products, &tx, &errors, Backoff::new()).await;
}

/// The reconnect loop. `url` is a parameter so tests can use a local `ws://` server; production
/// callers go through [`run_coinbase`], which always passes [`COINBASE_WS_URL`].
pub(crate) async fn run_with_url(
    url: &str,
    product_ids: &[&str],
    tx: &mpsc::Sender<MarketMsg>,
    errors: &mpsc::Sender<Event>,
    mut backoff: Backoff,
) {
    let mut stats = DropStats::new();
    loop {
        info!(url, "connecting to the coinbase feed");
        let outcome = connect_and_read(url, product_ids, tx, &mut stats, &mut backoff).await;
        let reason = match outcome {
            Err(AdapterError::Shutdown) => return,
            Ok(()) => "connection closed by the server".to_owned(),
            Err(err) => err.to_string(),
        };
        warn!(%reason, "coinbase feed disconnected");
        let event = Event::Error {
            code: ErrorCode::FeedDisconnected,
            message: shorten(&format!("coinbase feed disconnected: {reason}")),
        };
        if errors.send(event).await.is_err() {
            return;
        }
        tokio::time::sleep(backoff.next_delay()).await;
    }
}

/// Opens one connection, subscribes, and forwards normalized messages until the connection ends.
///
/// Returns `Ok(())` when the server sends a Close frame and `Err` for every other ending. Resets
/// `backoff` whenever a frame parses, so a connection that delivers data restarts the delays.
pub async fn connect_and_read(
    url: &str,
    product_ids: &[&str],
    tx: &mpsc::Sender<MarketMsg>,
    stats: &mut DropStats,
    backoff: &mut Backoff,
) -> Result<(), AdapterError> {
    install_crypto_provider();
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_MESSAGE_BYTES))
        .max_frame_size(Some(MAX_MESSAGE_BYTES));
    let connect = connect_async_with_config(url, Some(config), true);
    let (mut ws, _response) = tokio::time::timeout(CONNECT_TIMEOUT, connect)
        .await
        .map_err(|_| AdapterError::Connect("timed out".to_owned()))?
        .map_err(|e| AdapterError::Connect(e.to_string()))?;

    for text in subscribe_messages(product_ids) {
        ws.send(Message::text(text))
            .await
            .map_err(|e| AdapterError::Subscribe(e.to_string()))?;
    }
    debug!("subscribed to market_trades, level2, heartbeats");

    loop {
        let frame = tokio::time::timeout(IDLE_TIMEOUT, ws.next())
            .await
            .map_err(|_| AdapterError::Idle)?;
        match frame {
            None => return Err(AdapterError::Closed),
            Some(Err(e)) => return Err(AdapterError::Read(e.to_string())),
            Some(Ok(Message::Close(_))) => return Ok(()),
            Some(Ok(Message::Text(text))) => {
                match parse_message(text.as_str(), stats) {
                    Ok(msgs) => {
                        backoff.reset();
                        for msg in msgs {
                            tx.send(msg).await.map_err(|_| AdapterError::Shutdown)?;
                        }
                    }
                    Err(ParseError::Server(message)) => {
                        return Err(AdapterError::Server(message));
                    }
                    Err(ParseError::Json(err)) => {
                        warn!(%err, "skipped an unreadable coinbase frame");
                    }
                }
                log_drops(stats);
            }
            // Pings are answered by tungstenite; pongs and binary frames carry nothing.
            Some(Ok(_)) => {}
        }
    }
}

/// Why a candle backfill failed.
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
            Self::Http(e) => write!(f, "candle request failed: {e}"),
            Self::Parse(e) => write!(f, "candle response unreadable: {e}"),
        }
    }
}

impl std::error::Error for FetchError {}

/// `(start, end)` in Unix seconds for the most recent [`MAX_CANDLES`] candles ending at `end_s`.
pub fn candle_window(end_s: i64, timeframe: Timeframe) -> (i64, i64) {
    let span = MAX_CANDLES.saturating_mul(timeframe.millis() / 1_000);
    (end_s.saturating_sub(span).max(0), end_s)
}

/// The REST path and query for one candle request.
pub fn candles_path(product_id: &str, start_s: i64, end_s: i64, timeframe: Timeframe) -> String {
    format!(
        "/api/v3/brokerage/market/products/{product_id}/candles?start={start_s}&end={end_s}&granularity={}&limit={MAX_CANDLES}",
        granularity(timeframe)
    )
}

/// Fetches up to 350 recent candles of `symbol` (internal symbol) ending at `end_s` (Unix
/// seconds, supplied by the caller), oldest first (Req 5.2). One request; the caller decides
/// when to backfill and must not call this in a loop (public rate limits).
///
/// TODO(Task 8.x / live Subscribe wiring): feed these bars into the candle builder when a client
/// subscribes in live mode. The core has no history-injection API yet.
pub async fn fetch_candles(
    symbol: &str,
    timeframe: Timeframe,
    end_s: i64,
    stats: &mut DropStats,
) -> Result<Vec<Bar>, FetchError> {
    let product = to_venue_symbol(Venue::Coinbase, symbol)
        .ok_or_else(|| FetchError::UnknownSymbol(symbol.to_owned()))?;
    let (start_s, end_s) = candle_window(end_s, timeframe);
    let path = candles_path(product, start_s, end_s, timeframe);
    let body = https_get(COINBASE_REST_HOST, &path)
        .await
        .map_err(FetchError::Http)?;
    let text = std::str::from_utf8(&body)
        .map_err(|_| FetchError::Parse(ParseError::Json("body is not UTF-8".to_owned())))?;
    let candles = parse_candles(text, symbol, stats).map_err(FetchError::Parse)?;
    Ok(candles.into_iter().filter_map(|c| c.into_bar()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    use protocol::{Level, Price, Qty, Side};
    use serde_json::Value;
    use tokio::net::{TcpListener, TcpStream};
    use tokio_tungstenite::{WebSocketStream, accept_hdr_async};

    use crate::feed::test_ws::HeaderNames;

    #[test]
    fn backoff_doubles_to_the_cap_and_resets() {
        let mut backoff = Backoff::new();
        let delays: Vec<u64> = (0..9)
            .map(|_| u64::try_from(backoff.next_delay().as_millis()).unwrap())
            .collect();
        assert_eq!(
            delays,
            [
                500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000
            ]
        );
        backoff.reset();
        assert_eq!(backoff.next_delay(), Duration::from_millis(500));
        assert_eq!(backoff.next_delay(), Duration::from_millis(1_000));
        assert_eq!(Backoff::default(), Backoff::new());
    }

    #[test]
    fn candle_window_and_path() {
        assert_eq!(
            candle_window(1_794_632_280, Timeframe::M1),
            (1_794_611_280, 1_794_632_280)
        );
        assert_eq!(candle_window(100, Timeframe::D1), (0, 100));
        let path = candles_path("BTC-USD", 10, 20, Timeframe::M15);
        assert_eq!(
            path,
            "/api/v3/brokerage/market/products/BTC-USD/candles?start=10&end=20&granularity=FIFTEEN_MINUTE&limit=350"
        );
    }

    #[tokio::test]
    async fn unknown_symbol_fails_before_any_request() {
        let mut stats = DropStats::new();
        let result = fetch_candles("DOGE-USD", Timeframe::M1, 1_000, &mut stats).await;
        assert_eq!(result, Err(FetchError::UnknownSymbol("DOGE-USD".into())));
    }

    fn sample(wrapped: &str) -> String {
        let value: Value = serde_json::from_str(wrapped).unwrap();
        value["sample"].to_string()
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

    /// Accepts one connection, returns it with the lowercase request header names.
    async fn accept(listener: &TcpListener) -> (WebSocketStream<TcpStream>, Vec<String>) {
        let (socket, _) = listener.accept().await.unwrap();
        let mut names = Vec::new();
        let ws = accept_hdr_async(socket, HeaderNames(&mut names))
            .await
            .unwrap();
        (ws, names)
    }

    /// Reads the three subscribe messages and checks them: right channels, no auth fields.
    async fn expect_subscribes(ws: &mut WebSocketStream<TcpStream>) {
        let mut channels = Vec::new();
        for _ in 0..3 {
            let text = next_text(ws).await;
            let v: Value = serde_json::from_str(&text).unwrap();
            assert_eq!(v["type"], "subscribe");
            assert_eq!(v["product_ids"], serde_json::json!(["BTC-USD", "ETH-USD"]));
            assert!(v.get("jwt").is_none(), "{text}");
            assert_eq!(v.as_object().unwrap().len(), 3, "{text}");
            channels.push(v["channel"].as_str().unwrap().to_owned());
        }
        assert_eq!(channels, ["market_trades", "level2", "heartbeats"]);
    }

    // Req 5.1, 5.5: subscribes without credentials, forwards normalized data, and after a
    // dropped connection reports feed_disconnected, reconnects, and resubscribes.
    #[tokio::test]
    async fn subscribes_forwards_and_reconnects_after_a_drop() {
        let snapshot = sample(include_str!(
            "../../tests/data/coinbase_level2_snapshot.json"
        ))
        .replace("ETH-USD", "BTC-USD");
        let trade = sample(include_str!("../../tests/data/coinbase_trade.json"));

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let (tx, mut market) = mpsc::channel::<MarketMsg>(16);
        let (err_tx, mut errors) = mpsc::channel::<Event>(16);
        let backoff = Backoff::with_bounds(Duration::from_millis(10), Duration::from_millis(40));
        let products = ["BTC-USD", "ETH-USD"];

        let driver = async {
            // First connection.
            let (mut ws, header_names) = accept(&listener).await;
            for forbidden in ["authorization", "cookie", "cb-access-key", "x-api-key"] {
                assert!(
                    !header_names.iter().any(|n| n == forbidden),
                    "{header_names:?}"
                );
            }
            expect_subscribes(&mut ws).await;
            ws.send(Message::text(snapshot.clone())).await.unwrap();
            ws.send(Message::text(trade.clone())).await.unwrap();
            let first = market.recv().await.unwrap();
            let level = |price, qty| Level {
                price: Price(price),
                qty: Qty(qty),
            };
            assert_eq!(
                first,
                MarketMsg::BookSnapshot {
                    symbol: "BTC-USD".into(),
                    bids: vec![level(189_925, 350_000_000), level(189_920, 1_225_000_000)],
                    asks: vec![level(189_926, 175_000_000), level(189_930, 800_000_000)],
                    ts: 1_794_631_989_100,
                }
            );
            let second = market.recv().await.unwrap();
            assert!(
                matches!(
                    second,
                    MarketMsg::Trade {
                        side: Side::Buy,
                        ..
                    }
                ),
                "{second:?}"
            );

            // Drop the connection without a close handshake.
            drop(ws);
            let event = errors.recv().await.unwrap();
            let Event::Error { code, message } = event else {
                panic!("expected an error event, got {event:?}");
            };
            assert_eq!(code, ErrorCode::FeedDisconnected);
            assert!(
                message.starts_with("coinbase feed disconnected"),
                "{message}"
            );

            // Second connection: resubscribed, data flows again.
            let (mut ws, header_names) = accept(&listener).await;
            assert!(!header_names.iter().any(|n| n == "authorization"));
            expect_subscribes(&mut ws).await;
            ws.send(Message::text(trade.clone())).await.unwrap();
            let again = market.recv().await.unwrap();
            assert!(matches!(again, MarketMsg::Trade { .. }), "{again:?}");
        };

        let outcome = tokio::time::timeout(Duration::from_secs(10), async {
            tokio::select! {
                () = run_with_url(&url, &products, &tx, &err_tx, backoff) => {
                    panic!("the adapter stopped on its own");
                }
                () = driver => {}
            }
        })
        .await;
        assert!(outcome.is_ok(), "test timed out");
    }

    #[tokio::test]
    async fn adapter_stops_when_the_market_receiver_is_gone() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let (tx, market) = mpsc::channel::<MarketMsg>(1);
        let (err_tx, _errors) = mpsc::channel::<Event>(1);
        drop(market);
        let trade = sample(include_str!("../../tests/data/coinbase_trade.json"));
        let server = async {
            let (mut ws, _) = accept(&listener).await;
            expect_subscribes_any(&mut ws).await;
            ws.send(Message::text(trade)).await.unwrap();
            // Keep the socket open until the adapter returns.
            std::future::pending::<()>().await;
        };
        let backoff = Backoff::with_bounds(Duration::from_millis(10), Duration::from_millis(40));
        let run = run_with_url(&url, &["BTC-USD"], &tx, &err_tx, backoff);
        let done = tokio::time::timeout(Duration::from_secs(10), async {
            tokio::select! {
                () = run => true,
                () = server => false,
            }
        })
        .await;
        assert!(matches!(done, Ok(true)), "adapter did not stop: {done:?}");
    }

    async fn expect_subscribes_any(ws: &mut WebSocketStream<TcpStream>) {
        for _ in 0..3 {
            next_text(ws).await;
        }
    }
}
