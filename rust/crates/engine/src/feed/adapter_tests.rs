//! Integration-style adapter tests (Task 7.6, Req 5.5, 43.3 to 43.7).
//!
//! The unit tests inside `coinbase_parse`, `backpack_parse` (including `DepthSync`), `coinbase`
//! and `backpack` already cover the sample files, the update-id state machine, one reconnect per
//! venue, and the `Backoff` sequence. This module adds what they do not:
//!
//! - table-driven sample variants (other symbols, the other side flag, multi-trade events, drop
//!   counts) and the REST snapshot + WebSocket update pipeline built from the sample files;
//! - extra `DepthSync` sequences (buffered duplicates, id overlap rules, ids next to `u64::MAX`);
//! - a mock WebSocket server for both adapters that records every handshake header name and every
//!   received text frame and can drop a connection, with a full deny-list for auth headers and
//!   auth words in subscribe frames, and a check that the second connection resubscribes;
//! - the backoff reset after a received frame, through the real `connect_and_read`;
//! - a source guard that fails when auth-like strings appear in the public adapter modules.
//!
//! Nothing here touches the network beyond `127.0.0.1`.

use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use protocol::{ErrorCode, Event, Level, Price, Qty, Side, Venue};
use serde_json::Value;
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_tungstenite::accept_hdr_async;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};

use super::MarketMsg;
use super::backpack::{self, FetchError, SnapshotFetcher, SnapshotFuture};
use super::backpack_parse::{
    DepthSnapshot, DepthSync, DepthUpdate, ParsedBackpack, SyncOutput, parse_depth_snapshot,
    parse_message as parse_backpack,
};
use super::coinbase::{self, Backoff};
use super::coinbase_parse::parse_message as parse_coinbase;
use super::venue::DropStats;

/// Upper bound for every wait in this module.
const TEST_TIMEOUT: Duration = Duration::from_secs(10);

/// Header names (lowercase) that must never appear in a handshake, besides the pattern check in
/// [`is_denied_header`].
const DENIED_HEADERS: [&str; 11] = [
    "authorization",
    "proxy-authorization",
    "cookie",
    "x-api-key",
    "api-key",
    "x-signature",
    "x-timestamp",
    "x-window",
    "cb-access-key",
    "cb-access-sign",
    "cb-access-timestamp",
];

/// Words (lowercase) that must never appear in a subscribe frame.
const DENIED_FRAME_WORDS: [&str; 5] = ["jwt", "signature", "apikey", "api_key", "secret"];

/// Case-insensitive deny-list check for a request header name.
fn is_denied_header(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    DENIED_HEADERS.contains(&lower.as_str())
        || lower.contains("auth")
        || lower.contains("signature")
        || lower.contains("api-key")
        || lower.contains("apikey")
}

/// True if a frame text holds a denied word, ignoring case.
fn frame_has_denied_word(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    DENIED_FRAME_WORDS.iter().any(|w| lower.contains(w))
}

// ---------------------------------------------------------------------------------------------
// Mock WebSocket server
// ---------------------------------------------------------------------------------------------

/// What the server does on one connection (the n-th accepted connection uses the n-th script;
/// later connections get an empty script and stay open).
struct Script {
    /// Text frames to read from the client first (the subscribe messages).
    expect_frames: usize,
    /// Text frames to send once the expected frames arrived.
    send: Vec<String>,
    /// Drop the socket without a close handshake after sending, instead of keeping it open.
    then_drop: bool,
}

/// What the server saw on one connection.
#[derive(Debug, Clone, Default)]
struct ConnRecord {
    /// Lowercase handshake request header names.
    header_names: Vec<String>,
    /// Text frames received from the client, in order.
    frames: Vec<String>,
}

type Records = Arc<Mutex<Vec<ConnRecord>>>;

fn new_records() -> Records {
    Arc::new(Mutex::new(Vec::new()))
}

async fn bind() -> (TcpListener, String) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    (listener, url)
}

/// Accepts connections one after another and runs the scripts. Never returns.
async fn serve(listener: TcpListener, scripts: Vec<Script>, records: Records) {
    let mut conn = 0_usize;
    loop {
        let (socket, _) = listener.accept().await.unwrap();
        let mut names: Vec<String> = Vec::new();
        let mut ws = accept_hdr_async(
            socket,
            |request: &Request, response: Response| -> Result<Response, ErrorResponse> {
                names.extend(request.headers().keys().map(|k| k.as_str().to_owned()));
                Ok(response)
            },
        )
        .await
        .unwrap();
        let index = conn;
        conn += 1;
        records.lock().unwrap().push(ConnRecord {
            header_names: names,
            frames: Vec::new(),
        });
        let (expect, send, then_drop) = match scripts.get(index) {
            Some(s) => (s.expect_frames, s.send.clone(), s.then_drop),
            None => (0, Vec::new(), false),
        };
        for _ in 0..expect {
            let text = loop {
                match ws.next().await {
                    Some(Ok(Message::Text(t))) => break t.as_str().to_owned(),
                    Some(Ok(_)) => {}
                    other => panic!("client ended before sending its frames: {other:?}"),
                }
            };
            records.lock().unwrap()[index].frames.push(text);
        }
        for frame in send {
            ws.send(Message::text(frame)).await.unwrap();
        }
        if then_drop {
            drop(ws);
        } else {
            while let Some(Ok(_)) = ws.next().await {}
        }
    }
}

/// Runs the adapter future, the mock server, and the test driver together. Only the driver may
/// finish; the whole thing has a 10 s limit.
async fn drive<R, S, D>(run: R, server: S, driver: D)
where
    R: Future<Output = ()>,
    S: Future<Output = ()>,
    D: Future<Output = ()>,
{
    let outcome = tokio::time::timeout(TEST_TIMEOUT, async {
        tokio::select! {
            () = run => {
                panic!("the adapter stopped on its own");
            }
            () = server => {
                panic!("the mock server stopped");
            }
            () = driver => {}
        }
    })
    .await;
    assert!(outcome.is_ok(), "test timed out");
}

/// Next item of a channel, with the module timeout.
async fn recv<T>(rx: &mut mpsc::Receiver<T>) -> T {
    tokio::time::timeout(TEST_TIMEOUT, rx.recv())
        .await
        .expect("timed out waiting for an item")
        .expect("channel closed")
}

fn sample(wrapped: &str) -> String {
    let value: Value = serde_json::from_str(wrapped).unwrap();
    value["sample"].to_string()
}

fn cb_trade() -> String {
    sample(include_str!("../../tests/data/coinbase_trade.json"))
}

fn cb_update() -> String {
    sample(include_str!("../../tests/data/coinbase_level2_update.json"))
}

fn bp_trade() -> String {
    sample(include_str!("../../tests/data/backpack_trade.json"))
}

fn bp_depth() -> String {
    sample(include_str!("../../tests/data/backpack_depth.json"))
}

fn bp_rest_depth() -> String {
    sample(include_str!("../../tests/data/backpack_depth_rest.json"))
}

/// A SOL_USDC depth update with one ask level `75.50 x 1` (`T` is 2000 ms).
fn depth_text(first: u64, last: u64) -> String {
    serde_json::json!({
        "stream": "depth.SOL_USDC",
        "data": {"e":"depth","E":1,"s":"SOL_USDC","a":[["75.50","1"]],"b":[],"U":first,"u":last,"T":2_000_000}
    })
    .to_string()
}

/// Asserts that one recorded connection sent no auth-like header and no auth-like frame word.
fn assert_public_only(record: &ConnRecord) {
    assert!(
        !record.header_names.is_empty(),
        "no handshake headers recorded"
    );
    for name in &record.header_names {
        assert!(
            !is_denied_header(name),
            "denied header {name} in {:?}",
            record.header_names
        );
    }
    for frame in &record.frames {
        assert!(
            !frame_has_denied_word(frame),
            "denied word in frame {frame}"
        );
    }
}

// ---------------------------------------------------------------------------------------------
// Fake snapshot fetcher
// ---------------------------------------------------------------------------------------------

/// Snapshot ids come from `ids` by call index (the last id repeats); every call is recorded.
struct Fetcher {
    calls: Arc<Mutex<Vec<String>>>,
    ids: Vec<u64>,
}

impl SnapshotFetcher for Fetcher {
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

// ---------------------------------------------------------------------------------------------
// 1. Sample parsing tables
// ---------------------------------------------------------------------------------------------

fn trade(symbol: &str, price: i64, qty: i64, side: Side, ts: i64) -> MarketMsg {
    MarketMsg::Trade {
        symbol: symbol.into(),
        price: Price(price),
        qty: Qty(qty),
        side,
        ts,
    }
}

#[test]
fn coinbase_trade_variants_table() {
    let multi = r#"{"channel":"market_trades","timestamp":"2026-11-14T04:53:10.274Z","events":[
        {"type":"update","trades":[
            {"product_id":"ETH-USD","price":"1899.25","size":"0.5","side":"BUY","time":"2026-11-14T04:53:09.100Z"},
            {"product_id":"DOGE-USD","price":"1","size":"1","side":"BUY","time":"2026-11-14T04:53:09.100Z"},
            {"product_id":"ETH-USD","price":"1899.26","size":"0.25","side":"SELL","time":"2026-11-14T04:53:09.200Z"}
        ]}]}"#;
    let cases: Vec<(&str, String, Vec<MarketMsg>)> = vec![
        (
            "maker BUY means the aggressor sold",
            cb_trade().replace("\"SELL\"", "\"BUY\""),
            vec![trade(
                "BTC-USD",
                6_716_813,
                150_000,
                Side::Sell,
                1_794_631_990_141,
            )],
        ),
        (
            "SOL-USD with a whole-lot size",
            cb_trade()
                .replace("BTC-USD", "SOL-USD")
                .replace("67168.13", "75.46")
                .replace("0.00150000", "2"),
            vec![trade(
                "SOL-USD",
                7_546,
                200_000_000,
                Side::Buy,
                1_794_631_990_141,
            )],
        ),
        (
            "several trades in one event, unknown product skipped",
            multi.to_owned(),
            vec![
                trade(
                    "ETH-USD",
                    189_925,
                    50_000_000,
                    Side::Sell,
                    1_794_631_989_100,
                ),
                trade("ETH-USD", 189_926, 25_000_000, Side::Buy, 1_794_631_989_200),
            ],
        ),
    ];
    for (name, text, expected) in cases {
        let mut stats = DropStats::new();
        assert_eq!(
            parse_coinbase(&text, &mut stats).unwrap(),
            expected,
            "{name}"
        );
        assert_eq!(stats.total(), 0, "{name}");
    }
}

#[test]
fn coinbase_drop_variants_table() {
    // (name, text, messages kept, inexact, malformed) for ETH-USD updates and BTC-USD trades.
    let cases: Vec<(&str, String, &str, usize, u64, u64)> = vec![
        (
            "nine-decimal book quantity",
            cb_update().replace("2.10000000", "2.100000001"),
            "ETH-USD",
            1,
            1,
            0,
        ),
        (
            "zero book price",
            cb_update().replace("1899.26", "0"),
            "ETH-USD",
            1,
            0,
            1,
        ),
        (
            "three-decimal trade price",
            cb_trade().replace("67168.13", "67168.131"),
            "BTC-USD",
            0,
            1,
            0,
        ),
        (
            "unparseable trade time",
            cb_trade().replace("2026-11-14T04:53:10.141234Z", "yesterday"),
            "BTC-USD",
            0,
            0,
            1,
        ),
        (
            "unknown trade side",
            cb_trade().replace("\"SELL\"", "\"HOLD\""),
            "BTC-USD",
            0,
            0,
            1,
        ),
    ];
    for (name, text, symbol, kept, inexact, malformed) in cases {
        let mut stats = DropStats::new();
        let msgs = parse_coinbase(&text, &mut stats).unwrap();
        assert_eq!(msgs.len(), kept, "{name}");
        let counts = stats.counts(Venue::Coinbase, symbol);
        assert_eq!(
            (counts.inexact, counts.malformed),
            (inexact, malformed),
            "{name}"
        );
    }
}

#[test]
fn backpack_variants_table() {
    let level = |price, qty| (Price(price), Qty(qty));
    let cases: Vec<(&str, String, ParsedBackpack)> = vec![
        (
            "ETH_USDC trade, seller aggressor",
            bp_trade()
                .replace("SOL_USDC", "ETH_USDC")
                .replace("\"75.41\"", "\"3000.5\"")
                .replace("\"0.02\"", "\"1.5\""),
            ParsedBackpack::Trade(trade(
                "ETH-USD",
                300_050,
                150_000_000,
                Side::Sell,
                1_794_633_085_618,
            )),
        ),
        (
            "BTC_USDC trade, buyer aggressor",
            bp_trade()
                .replace("SOL_USDC", "BTC_USDC")
                .replace("\"m\":true", "\"m\":false")
                .replace("\"75.41\"", "\"67168.13\""),
            ParsedBackpack::Trade(trade(
                "BTC-USD",
                6_716_813,
                2_000_000,
                Side::Buy,
                1_794_633_085_618,
            )),
        ),
        (
            "zero quantity bid removes the level",
            bp_depth().replace("[\"75.46\",\"304.72\"]", "[\"75.46\",\"0\"]"),
            ParsedBackpack::Depth(DepthUpdate {
                symbol: "SOL-USD".into(),
                first_id: 4_686_272_931,
                last_id: 4_686_272_933,
                bids: vec![level(7_546, 0)],
                asks: vec![level(7_547, 19_850_000_000), level(7_562, 0)],
                ts: 1_794_633_182_149,
            }),
        ),
        (
            "inexact ask quantity is dropped, the rest stays",
            bp_depth().replace("\"198.5\"", "\"198.123456789\""),
            ParsedBackpack::Depth(DepthUpdate {
                symbol: "SOL-USD".into(),
                first_id: 4_686_272_931,
                last_id: 4_686_272_933,
                bids: vec![level(7_546, 30_472_000_000)],
                asks: vec![level(7_562, 0)],
                ts: 1_794_633_182_149,
            }),
        ),
    ];
    for (name, text, expected) in cases {
        let mut stats = DropStats::new();
        assert_eq!(parse_backpack(&text, &mut stats), expected, "{name}");
    }
    // The inexact row counted exactly one drop.
    let mut stats = DropStats::new();
    parse_backpack(
        &bp_depth().replace("\"198.5\"", "\"198.123456789\""),
        &mut stats,
    );
    assert_eq!(stats.counts(Venue::Backpack, "SOL-USD").inexact, 1);
    assert_eq!(stats.total(), 1);
}

#[test]
fn backpack_rest_snapshot_then_ws_update_pipeline() {
    let mut stats = DropStats::new();
    let ParsedBackpack::Depth(update) = parse_backpack(&bp_depth(), &mut stats) else {
        panic!("expected a depth update");
    };
    let snapshot = parse_depth_snapshot(&bp_rest_depth(), "SOL-USD", &mut stats).unwrap();
    assert_eq!(
        snapshot.last_update_id + 1,
        update.first_id,
        "the sample ids line up"
    );

    let mut sync = DepthSync::new();
    assert_eq!(sync.on_update(update), SyncOutput::default());
    let out = sync.on_snapshot(snapshot);
    assert!(!out.need_resync);
    let lvl = |price, qty| Level {
        price: Price(price),
        qty: Qty(qty),
    };
    let delta = |side, price, qty| MarketMsg::BookDelta {
        symbol: "SOL-USD".into(),
        side,
        price: Price(price),
        qty: Qty(qty),
        ts: 1_794_633_182_149,
    };
    assert_eq!(
        out.msgs,
        vec![
            MarketMsg::BookSnapshot {
                symbol: "SOL-USD".into(),
                bids: vec![
                    lvl(7_546, 30_472_000_000),
                    lvl(7_545, 26_109_000_000),
                    lvl(7_544, 30_741_000_000)
                ],
                asks: vec![
                    lvl(7_547, 20_280_000_000),
                    lvl(7_548, 26_631_000_000),
                    lvl(7_549, 31_260_000_000)
                ],
                ts: 1_794_633_182_147,
            },
            delta(Side::Buy, 7_546, 30_472_000_000),
            delta(Side::Sell, 7_547, 19_850_000_000),
            delta(Side::Sell, 7_562, 0),
        ]
    );
    assert_eq!(stats.total(), 0);
}

// ---------------------------------------------------------------------------------------------
// 2. Extra DepthSync sequences
// ---------------------------------------------------------------------------------------------

const SYM: &str = "SOL-USD";

fn upd(first_id: u64, last_id: u64) -> DepthUpdate {
    DepthUpdate {
        symbol: SYM.into(),
        first_id,
        last_id,
        // The bid quantity carries the first id so tests can tell updates apart.
        bids: vec![(Price(100), Qty(i64::try_from(first_id).unwrap_or(i64::MAX)))],
        asks: Vec::new(),
        ts: 10,
    }
}

fn snap(id: u64) -> DepthSnapshot {
    DepthSnapshot {
        symbol: SYM.into(),
        last_update_id: id,
        bids: vec![(Price(99), Qty(5))],
        asks: vec![(Price(102), Qty(7))],
        ts: 5,
    }
}

/// First ids of the deltas in `msgs`.
fn applied(msgs: &[MarketMsg]) -> Vec<i64> {
    msgs.iter()
        .filter_map(|m| match m {
            MarketMsg::BookDelta { qty, .. } => Some(qty.0),
            _ => None,
        })
        .collect()
}

#[test]
fn buffered_duplicates_and_stale_updates_before_a_snapshot_are_dropped() {
    let mut sync = DepthSync::new();
    for (f, l) in [(95, 98), (101, 102), (101, 102), (100, 100), (103, 103)] {
        assert_eq!(sync.on_update(upd(f, l)), SyncOutput::default());
    }
    let out = sync.on_snapshot(snap(100));
    assert!(!out.need_resync);
    assert!(matches!(
        out.msgs.first(),
        Some(MarketMsg::BookSnapshot { .. })
    ));
    assert_eq!(applied(&out.msgs), [101, 103]);
}

#[test]
fn resync_after_a_gap_applies_only_updates_after_the_new_snapshot() {
    let mut sync = DepthSync::new();
    sync.on_snapshot(snap(100));
    assert_eq!(applied(&sync.on_update(upd(101, 101)).msgs), [101]);
    // Gap: ids 102..=109 are missing.
    assert!(sync.on_update(upd(110, 110)).need_resync);
    // While the new snapshot is in flight: one update the snapshot will contain, two it will not.
    for (f, l) in [(140, 149), (150, 150), (151, 151)] {
        assert_eq!(sync.on_update(upd(f, l)), SyncOutput::default());
    }
    let out = sync.on_snapshot(snap(149));
    assert!(!out.need_resync);
    assert!(
        matches!(out.msgs.first(), Some(MarketMsg::BookSnapshot { bids, .. }) if bids.len() == 1)
    );
    assert_eq!(applied(&out.msgs), [150, 151]);
    assert_eq!(applied(&sync.on_update(upd(152, 152)).msgs), [152]);
}

#[test]
fn first_update_overlap_boundaries() {
    // (snapshot id, update ids, expected outcome): Some(applied) or None for resync.
    let cases: [(u64, (u64, u64), Option<usize>); 5] = [
        (100, (101, 101), Some(1)),
        (100, (100, 101), Some(1)),
        (100, (1, 101), Some(1)),
        (100, (102, 102), None),
        (100, (100, 100), Some(0)),
    ];
    for (id, (f, l), expected) in cases {
        let mut sync = DepthSync::new();
        sync.on_snapshot(snap(id));
        let out = sync.on_update(upd(f, l));
        match expected {
            Some(n) => {
                assert!(!out.need_resync, "{id} {f}..{l}");
                assert_eq!(out.msgs.len(), n, "{id} {f}..{l}");
            }
            None => assert!(out.need_resync, "{id} {f}..{l}"),
        }
    }
}

#[test]
fn ids_next_to_u64_max_follow_the_same_rules() {
    let mut sync = DepthSync::new();
    sync.on_snapshot(snap(u64::MAX - 2));
    // Starts above the allowed next id (MAX - 1): a gap, not a wrap.
    assert!(sync.on_update(upd(u64::MAX, u64::MAX)).need_resync);

    let mut sync = DepthSync::new();
    sync.on_snapshot(snap(u64::MAX - 2));
    assert_eq!(sync.on_update(upd(u64::MAX - 1, u64::MAX)).msgs.len(), 1);
    // Nothing follows u64::MAX.
    assert_eq!(
        sync.on_update(upd(u64::MAX, u64::MAX)),
        SyncOutput::default()
    );

    // Buffered ids at the top of the range are applied after the snapshot.
    let mut sync = DepthSync::new();
    sync.on_update(upd(u64::MAX - 1, u64::MAX - 1));
    sync.on_update(upd(u64::MAX, u64::MAX));
    let out = sync.on_snapshot(snap(u64::MAX - 2));
    assert!(!out.need_resync);
    assert_eq!(out.msgs.len(), 1 + 2);
}

// ---------------------------------------------------------------------------------------------
// 3. Mock WebSocket server, both venues
// ---------------------------------------------------------------------------------------------

#[test]
fn deny_list_is_case_insensitive_and_does_not_flag_normal_headers() {
    for bad in [
        "Authorization",
        "COOKIE",
        "X-Api-Key",
        "x-signature",
        "X-Window",
        "X-Timestamp",
    ] {
        assert!(is_denied_header(bad), "{bad}");
    }
    for ok in [
        "host",
        "upgrade",
        "connection",
        "sec-websocket-key",
        "sec-websocket-version",
    ] {
        assert!(!is_denied_header(ok), "{ok}");
    }
    assert!(frame_has_denied_word("{\"JWT\":\"x\"}"));
    assert!(frame_has_denied_word("{\"apiKey\":1}"));
    assert!(!frame_has_denied_word(
        "{\"type\":\"subscribe\",\"channel\":\"level2\"}"
    ));
}

// Req 5.1, 5.5: no auth header or word, feed_disconnected after a drop, resubscribe.
#[tokio::test]
async fn coinbase_mock_server_handshake_drop_and_resubscribe() {
    let (listener, url) = bind().await;
    let records = new_records();
    let scripts = vec![
        Script {
            expect_frames: 3,
            send: vec![cb_trade()],
            then_drop: true,
        },
        Script {
            expect_frames: 3,
            send: vec![cb_trade()],
            then_drop: false,
        },
    ];
    let (tx, mut market) = mpsc::channel::<MarketMsg>(16);
    let (err_tx, mut errors) = mpsc::channel::<Event>(16);
    let backoff = Backoff::with_bounds(Duration::from_millis(10), Duration::from_millis(40));
    let products = ["BTC-USD", "ETH-USD"];
    let seen = Arc::clone(&records);

    let driver = async {
        let first = recv(&mut market).await;
        assert!(
            matches!(
                first,
                MarketMsg::Trade {
                    side: Side::Buy,
                    ..
                }
            ),
            "{first:?}"
        );
        let Event::Error { code, message } = recv(&mut errors).await else {
            panic!("expected an error event");
        };
        assert_eq!(code, ErrorCode::FeedDisconnected);
        assert!(
            message.starts_with("coinbase feed disconnected"),
            "{message}"
        );
        let again = recv(&mut market).await;
        assert!(matches!(again, MarketMsg::Trade { .. }), "{again:?}");

        let records = seen.lock().unwrap().clone();
        assert_eq!(records.len(), 2, "exactly one reconnect");
        for record in &records {
            assert_public_only(record);
            assert_eq!(record.frames.len(), 3);
            let channels: Vec<String> = record
                .frames
                .iter()
                .map(|f| {
                    let v: Value = serde_json::from_str(f).unwrap();
                    assert_eq!(v["type"], "subscribe");
                    assert_eq!(v["product_ids"], serde_json::json!(["BTC-USD", "ETH-USD"]));
                    v["channel"].as_str().unwrap().to_owned()
                })
                .collect();
            assert_eq!(channels, ["market_trades", "level2", "heartbeats"]);
        }
        assert_eq!(
            records[0].frames, records[1].frames,
            "same subscribe frames again"
        );
    };
    drive(
        async { coinbase::run_with_url(&url, &products, &tx, &err_tx, backoff).await },
        serve(listener, scripts, records),
        driver,
    )
    .await;
}

// Req 43.1, 43.5, 43.6: no auth header or word, feed_disconnected after a drop, resubscribe, and
// a fresh REST snapshot because the DepthSync was reset.
#[tokio::test]
async fn backpack_mock_server_handshake_drop_resubscribe_and_resync() {
    let (listener, url) = bind().await;
    let records = new_records();
    let scripts = vec![
        Script {
            expect_frames: 1,
            send: vec![depth_text(101, 101), bp_trade()],
            then_drop: true,
        },
        Script {
            expect_frames: 1,
            send: vec![depth_text(501, 501), bp_trade()],
            then_drop: false,
        },
    ];
    let (tx, mut market) = mpsc::channel::<MarketMsg>(64);
    let (err_tx, mut errors) = mpsc::channel::<Event>(16);
    let calls = Arc::new(Mutex::new(Vec::new()));
    let mut fetcher = Fetcher {
        calls: Arc::clone(&calls),
        ids: vec![100, 500],
    };
    let backoff = Backoff::with_bounds(Duration::from_millis(10), Duration::from_millis(40));
    let syms = vec!["SOL-USD".to_owned()];
    let seen = Arc::clone(&records);
    let seen_calls = Arc::clone(&calls);

    let driver = async {
        // Connection 1: snapshot (id 100), delta from update 101, trade.
        assert!(matches!(
            recv(&mut market).await,
            MarketMsg::BookSnapshot { .. }
        ));
        assert!(matches!(
            recv(&mut market).await,
            MarketMsg::BookDelta { .. }
        ));
        assert!(matches!(recv(&mut market).await, MarketMsg::Trade { .. }));
        let Event::Error { code, message } = recv(&mut errors).await else {
            panic!("expected an error event");
        };
        assert_eq!(code, ErrorCode::FeedDisconnected);
        assert!(
            message.starts_with("backpack feed disconnected"),
            "{message}"
        );
        // Connection 2: a new snapshot (id 500) and update 501 applies to it.
        assert!(matches!(
            recv(&mut market).await,
            MarketMsg::BookSnapshot { .. }
        ));
        assert!(matches!(
            recv(&mut market).await,
            MarketMsg::BookDelta { .. }
        ));
        assert!(matches!(recv(&mut market).await, MarketMsg::Trade { .. }));

        assert_eq!(*seen_calls.lock().unwrap(), ["SOL-USD", "SOL-USD"]);
        let records = seen.lock().unwrap().clone();
        assert_eq!(records.len(), 2, "exactly one reconnect");
        for record in &records {
            assert_public_only(record);
            assert_eq!(record.frames.len(), 1);
            let v: Value = serde_json::from_str(&record.frames[0]).unwrap();
            assert_eq!(v["method"], "SUBSCRIBE");
            assert_eq!(
                v["params"],
                serde_json::json!(["trade.SOL_USDC", "depth.SOL_USDC"])
            );
        }
        assert_eq!(
            records[0].frames, records[1].frames,
            "same subscribe frame again"
        );
    };
    drive(
        async { backpack::run_with_url(&url, &syms, &tx, &err_tx, backoff, &mut fetcher).await },
        serve(listener, scripts, records),
        driver,
    )
    .await;
}

// ---------------------------------------------------------------------------------------------
// 4. Backoff
// ---------------------------------------------------------------------------------------------

/// A backoff that has already handed out 500, 1000, and 2000 ms; its next delay is 4000 ms.
fn advanced_backoff() -> Backoff {
    let mut backoff = Backoff::new();
    for expected in [500, 1_000, 2_000] {
        assert_eq!(backoff.next_delay(), Duration::from_millis(expected));
    }
    backoff
}

/// Runs the real Coinbase `connect_and_read` against a server that sends `frames` and drops.
async fn coinbase_backoff_after(frames: Vec<String>) -> Backoff {
    let (listener, url) = bind().await;
    let scripts = vec![Script {
        expect_frames: 3,
        send: frames,
        then_drop: true,
    }];
    let (tx, _market) = mpsc::channel::<MarketMsg>(16);
    let mut stats = DropStats::new();
    let mut backoff = advanced_backoff();
    let result = tokio::time::timeout(TEST_TIMEOUT, async {
        tokio::select! {
            r = coinbase::connect_and_read(&url, &["BTC-USD"], &tx, &mut stats, &mut backoff) => r,
            () = serve(listener, scripts, new_records()) => {
                panic!("the mock server stopped");
            }
        }
    })
    .await
    .expect("timed out");
    assert!(
        result.is_err(),
        "a dropped connection is an error: {result:?}"
    );
    backoff
}

/// Same for Backpack, with one symbol and a fake fetcher.
async fn backpack_backoff_after(frames: Vec<String>) -> Backoff {
    let (listener, url) = bind().await;
    let scripts = vec![Script {
        expect_frames: 1,
        send: frames,
        then_drop: true,
    }];
    let (tx, _market) = mpsc::channel::<MarketMsg>(16);
    let mut stats = DropStats::new();
    let mut backoff = advanced_backoff();
    let mut fetcher = Fetcher {
        calls: Arc::new(Mutex::new(Vec::new())),
        ids: vec![100],
    };
    let mut sync = DepthSync::new();
    let syms = vec!["SOL-USD".to_owned()];
    let result = tokio::time::timeout(TEST_TIMEOUT, async {
        tokio::select! {
            r = backpack::connect_and_read(&url, &syms, &tx, &mut stats, &mut backoff, &mut fetcher, &mut sync) => r,
            () = serve(listener, scripts, new_records()) => {
                panic!("the mock server stopped");
            }
        }
    })
    .await
    .expect("timed out");
    assert!(
        result.is_err(),
        "a dropped connection is an error: {result:?}"
    );
    backoff
}

#[test]
fn backoff_sequence_is_500ms_doubling_to_30s_for_both_adapters() {
    assert_eq!(coinbase::INITIAL_BACKOFF, Duration::from_millis(500));
    assert_eq!(coinbase::MAX_BACKOFF, Duration::from_secs(30));
    let mut backoff = Backoff::new();
    let millis: Vec<u128> = (0..8).map(|_| backoff.next_delay().as_millis()).collect();
    assert_eq!(
        millis,
        [500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]
    );
    // An initial delay above the cap is clamped.
    let mut clamped = Backoff::with_bounds(Duration::from_secs(60), Duration::from_secs(30));
    assert_eq!(clamped.next_delay(), Duration::from_secs(30));
    clamped.reset();
    assert_eq!(clamped.next_delay(), Duration::from_secs(30));
    // The Backpack adapter shares this type and builds it with `Backoff::new()`.
    assert!(include_str!("backpack.rs").contains("use super::coinbase::{Backoff"));
    assert!(include_str!("backpack.rs").contains("Backoff::new()"));
    assert!(include_str!("coinbase.rs").contains("Backoff::new()"));
}

#[tokio::test]
async fn coinbase_backoff_resets_after_a_parsed_frame_only() {
    let mut reset = coinbase_backoff_after(vec![cb_trade()]).await;
    assert_eq!(reset.next_delay(), Duration::from_millis(500));
    let mut kept = coinbase_backoff_after(vec!["not json".to_owned()]).await;
    assert_eq!(kept.next_delay(), Duration::from_millis(4_000));
}

#[tokio::test]
async fn backpack_backoff_resets_after_trade_or_depth_data_only() {
    let mut reset = backpack_backoff_after(vec![bp_trade()]).await;
    assert_eq!(reset.next_delay(), Duration::from_millis(500));
    let mut reset = backpack_backoff_after(vec![depth_text(101, 101)]).await;
    assert_eq!(reset.next_delay(), Duration::from_millis(500));
    let mut kept = backpack_backoff_after(vec![r#"{"result":null,"id":1}"#.to_owned()]).await;
    assert_eq!(kept.next_delay(), Duration::from_millis(4_000));
}

// ---------------------------------------------------------------------------------------------
// 5. Source guard
// ---------------------------------------------------------------------------------------------

/// Lowercase substrings that must not appear in the public adapter sources. Matching ignores case.
const FORBIDDEN_IN_SOURCE: [&str; 7] = [
    "authorization",
    "bearer",
    "api_key",
    "apikey",
    "x-api",
    "hmac",
    "ed25519",
];

/// The production part of a source file (everything before its `#[cfg(test)]` module), with
/// comment-only lines removed.
fn code_lines(source: &str) -> Vec<&str> {
    let production = source.split("#[cfg(test)]").next().unwrap_or(source);
    production
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect()
}

/// `(line, forbidden word)` pairs found in the code lines of `source`.
fn forbidden_hits(source: &str) -> Vec<(String, &'static str)> {
    let mut hits = Vec::new();
    for line in code_lines(source) {
        let lower = line.to_ascii_lowercase();
        for word in FORBIDDEN_IN_SOURCE {
            if lower.contains(word) {
                hits.push((line.trim().to_owned(), word));
            }
        }
    }
    hits
}

#[test]
fn guard_detects_forbidden_words_in_code_but_not_in_comments_or_tests() {
    assert!(!forbidden_hits("let h = \"Authorization\";").is_empty());
    assert!(!forbidden_hits("sign(hmac_key);").is_empty());
    assert!(forbidden_hits("// Authorization is never sent\n/// no api_key").is_empty());
    assert!(forbidden_hits("let x = 1;\n#[cfg(test)]\nmod t { \"Bearer\" }").is_empty());
}

#[test]
fn public_adapter_sources_contain_no_auth_strings() {
    let sources = [
        ("coinbase.rs", include_str!("coinbase.rs")),
        ("backpack.rs", include_str!("backpack.rs")),
        ("http.rs", include_str!("http.rs")),
        ("coinbase_parse.rs", include_str!("coinbase_parse.rs")),
        ("backpack_parse.rs", include_str!("backpack_parse.rs")),
    ];
    for (name, source) in sources {
        let hits = forbidden_hits(source);
        assert!(
            hits.is_empty(),
            "{name} contains auth-like strings: {hits:?}"
        );
    }
}
