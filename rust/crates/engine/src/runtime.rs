//! Tokio wiring: one task owns the [`Engine`] and selects over stdin lines, a 1 s heartbeat
//! timer, replay fixture loads, and the replay deadline, writing the resulting Events to stdout
//! (Req 3.1, 3.2, 3.4, 3.5, 6.1, 6.3, 6.5).
//!
//! Replay timing lives here, not in the core: the pure [`ReplaySchedule`] says how long to wait
//! before each message, and the runtime keeps one `tokio::time::Instant` deadline for the next
//! message. Each loop iteration builds a fresh `sleep_until(deadline)` future, so cancelling it
//! in `select!` loses nothing. Released messages go to [`Engine::on_market`].

use std::fmt;
use std::io;
use std::mem;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use protocol::{
    Command, DecodeError, ErrorCode, Event, MAX_LINE_BYTES, MAX_REPLAY_SPEED, MIN_REPLAY_SPEED,
    TimeMs, Venue, decode_command, encode_line, is_valid_fixture_name,
};
use tokio::io::{AsyncBufRead, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio::task::{JoinError, JoinHandle};
use tokio::time::{Instant, MissedTickBehavior};
use tracing::{debug, error, info, warn};

use crate::core::{Engine, HistoryRequest};
use crate::feed::MarketMsg;
use crate::feed::backfill::{
    BackpackHistory, CoinbaseHistory, HistoryFetcher, HistoryResult, run_backfill,
};
use crate::feed::backpack::run_backpack;
use crate::feed::coinbase::run_coinbase;
use crate::feed::fixture::{FixtureError, FixtureLine, read_fixture};
use crate::feed::replay::{
    ReplaySchedule, ScheduleError, Scheduled, align_to_now, error_event, load_error_event,
    schedule_error_event,
};
use crate::lines::{Line, LineReader};

/// Interval between Heartbeat Events (Req 3.4).
pub const HEARTBEAT_PERIOD: Duration = Duration::from_secs(1);

/// Most replay messages released in one wake-up. Messages that share a `recv` are due at the
/// same instant; the cap keeps a large burst from holding up stdin and the heartbeat.
const MAX_RELEASE_BATCH: usize = 256;

/// Settings for [`run`].
#[derive(Debug, Clone)]
pub struct RunConfig {
    /// Interval between Heartbeat Events.
    pub heartbeat: Duration,
    /// Directory that `start_replay` fixture names are resolved in.
    pub fixtures_dir: PathBuf,
    /// Live market data feed to start, or `None` for replay mode (Req 5.1).
    pub live: Option<LiveFeedConfig>,
}

/// Which live feed to start and for which symbols.
#[derive(Debug, Clone)]
pub struct LiveFeedConfig {
    pub venue: Venue,
    /// Internal symbols, e.g. `BTC-USD`.
    pub symbols: Vec<String>,
}

/// Capacity of the channel between a live adapter and the runtime.
const LIVE_CHANNEL_CAPACITY: usize = 1_024;
/// Capacity of the adapter's error channel.
const LIVE_ERROR_CAPACITY: usize = 64;
/// Most live messages handled per wake-up, so stdin and the heartbeat are not held up.
const MAX_LIVE_BATCH: usize = 256;

/// The receiving ends of a live adapter task. Both are `None` in replay mode, when the venue has
/// no adapter yet, and after the adapter stops; the select branches then wait forever.
///
/// Live messages join the same path as replay: [`Engine::on_market`], then stdout.
struct LiveFeed {
    market: Option<mpsc::Receiver<MarketMsg>>,
    errors: Option<mpsc::Receiver<Event>>,
    /// Requests to the backfill task. `None` in replay mode.
    history_requests: Option<mpsc::Sender<HistoryRequest>>,
    /// Finished backfills. `None` in replay mode and after the task stops.
    history: Option<mpsc::Receiver<HistoryResult>>,
}

/// Capacity of the queue of history requests. At most 3 symbols x 5 timeframes exist, so a full
/// queue means the backfill task is stuck; the request then fails and a later subscribe retries.
const HISTORY_REQUEST_CAPACITY: usize = 32;
/// Capacity of the queue of finished backfills.
const HISTORY_RESULT_CAPACITY: usize = 32;

/// Spawns the backfill task with `fetcher` and returns its two channel ends.
fn spawn_backfill<F: HistoryFetcher>(
    fetcher: F,
) -> (mpsc::Sender<HistoryRequest>, mpsc::Receiver<HistoryResult>) {
    let (req_tx, req_rx) = mpsc::channel(HISTORY_REQUEST_CAPACITY);
    let (res_tx, res_rx) = mpsc::channel(HISTORY_RESULT_CAPACITY);
    tokio::spawn(run_backfill(req_rx, res_tx, fetcher));
    (req_tx, res_rx)
}

impl LiveFeed {
    /// Spawns the adapter and the backfill task for `config.venue` on the current runtime.
    fn start(config: Option<LiveFeedConfig>) -> Self {
        let none = Self {
            market: None,
            errors: None,
            history_requests: None,
            history: None,
        };
        let Some(config) = config else {
            return none;
        };
        match config.venue {
            Venue::Coinbase => {
                let (tx, market) = mpsc::channel(LIVE_CHANNEL_CAPACITY);
                let (err_tx, errors) = mpsc::channel(LIVE_ERROR_CAPACITY);
                info!("starting the coinbase live feed");
                tokio::spawn(run_coinbase(tx, err_tx, config.symbols));
                let (history_requests, history) = spawn_backfill(CoinbaseHistory);
                Self {
                    market: Some(market),
                    errors: Some(errors),
                    history_requests: Some(history_requests),
                    history: Some(history),
                }
            }
            Venue::Backpack => {
                // Same channels as the Coinbase arm. The adapter reports connection failures on
                // `err_tx` and fetches REST depth snapshots itself (Task 7.5, Req 43).
                let (tx, market) = mpsc::channel(LIVE_CHANNEL_CAPACITY);
                let (err_tx, errors) = mpsc::channel(LIVE_ERROR_CAPACITY);
                info!("starting the backpack live feed");
                tokio::spawn(run_backpack(tx, err_tx, config.symbols));
                let (history_requests, history) = spawn_backfill(BackpackHistory);
                Self {
                    market: Some(market),
                    errors: Some(errors),
                    history_requests: Some(history_requests),
                    history: Some(history),
                }
            }
        }
    }

    /// Moves the history requests that the last command queued into the backfill task. A request
    /// that cannot be queued fails at once, so the key can retry on a later subscribe. Returns
    /// the Events of those failures.
    fn queue_history(&self, engine: &mut Engine) -> Vec<Event> {
        let mut events = Vec::new();
        for request in engine.take_history_requests() {
            let (request, reason) = match self.history_requests.as_ref() {
                Some(tx) => match tx.try_send(request) {
                    Ok(()) => continue,
                    Err(mpsc::error::TrySendError::Full(request)) => {
                        (request, "backfill queue full")
                    }
                    Err(mpsc::error::TrySendError::Closed(request)) => {
                        (request, "backfill task stopped")
                    }
                },
                None => (request, "backfill unavailable"),
            };
            events.extend(engine.on_history_failed(&request.symbol, request.timeframe, reason));
        }
        events
    }

    /// Sends `first` and then every message already queued, up to [`MAX_LIVE_BATCH`], to the
    /// engine, and returns the Events.
    fn on_market(&mut self, engine: &mut Engine, first: MarketMsg) -> Vec<Event> {
        let mut events = engine.on_market(first);
        if let Some(rx) = self.market.as_mut() {
            for _ in 1..MAX_LIVE_BATCH {
                match rx.try_recv() {
                    Ok(msg) => events.extend(engine.on_market(msg)),
                    Err(_) => break,
                }
            }
        }
        events
    }
}

/// Waits for the next item, or forever if there is no receiver.
async fn recv_opt<T>(rx: &mut Option<mpsc::Receiver<T>>) -> Option<T> {
    match rx {
        Some(rx) => rx.recv().await,
        None => std::future::pending().await,
    }
}

/// Why the runtime stopped before end of input.
#[derive(Debug)]
pub enum RunError {
    /// Reading Commands from the input failed.
    Read(io::Error),
    /// Writing Events to the output failed, for example because the pipe closed.
    Write(io::Error),
}

impl fmt::Display for RunError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Read(e) => write!(f, "reading stdin failed: {e}"),
            Self::Write(e) => write!(f, "writing stdout failed: {e}"),
        }
    }
}

impl std::error::Error for RunError {}

/// What woke the select loop.
enum Wake {
    Heartbeat,
    Line(Option<Line>),
    Loaded(LoadResult),
    /// A live market message, or `None` when the adapter's channel closed.
    LiveMarket(Option<MarketMsg>),
    /// A live adapter Event (feed disconnects), or `None` when its channel closed.
    LiveError(Option<Event>),
    /// A finished candle backfill, or `None` when the backfill task's channel closed.
    History(Option<HistoryResult>),
    ReplayDue,
}

/// Runs the engine until `input` reaches end of file, then flushes `output` and returns `Ok`
/// (Req 3.5). Returns an error as soon as a read or write fails.
///
/// In replay mode no market data flows until a `start_replay` Command arrives. With a
/// [`LiveFeedConfig`], the venue adapter's messages flow from the start, through the same
/// `Engine::on_market` path as replay (Req 5.1).
pub async fn run<R, W>(input: R, mut output: W, config: RunConfig) -> Result<(), RunError>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
{
    // Only live mode fetches venue history; replay builds its history by warm-up.
    let mut engine = if config.live.is_some() {
        Engine::with_backfill()
    } else {
        Engine::new()
    };
    let mut replay = Replay::new(config.fixtures_dir);
    let mut live = LiveFeed::start(config.live);
    let mut lines = LineReader::new(input, MAX_LINE_BYTES);
    let mut ticker = tokio::time::interval(config.heartbeat);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        let deadline = replay.deadline();
        // Biased: the timer is ready at most once per period, so it cannot starve stdin, and
        // stdin comes before replay so a burst of market data cannot hold up Commands. Every
        // branch is cancel safe: `tick`, `next_line` (documented), polling `&mut JoinHandle`,
        // and a `sleep_until` rebuilt from the stored deadline on every iteration.
        let wake = tokio::select! {
            biased;
            _ = ticker.tick() => Wake::Heartbeat,
            line = lines.next_line() => Wake::Line(line.map_err(RunError::Read)?),
            loaded = wait_load(&mut replay.pending) => Wake::Loaded(loaded),
            error = recv_opt(&mut live.errors) => Wake::LiveError(error),
            result = recv_opt(&mut live.history) => Wake::History(result),
            msg = recv_opt(&mut live.market) => Wake::LiveMarket(msg),
            () = sleep_until_some(deadline) => Wake::ReplayDue,
        };
        let events = match wake {
            Wake::Heartbeat => vec![Event::Heartbeat { ts: now_ms() }],
            Wake::Line(Some(line)) => {
                let mut events = on_line(&mut engine, &mut replay, line);
                events.extend(live.queue_history(&mut engine));
                events
            }
            Wake::Line(None) => {
                info!("stdin reached end of file");
                break;
            }
            Wake::Loaded(loaded) => replay.on_loaded(loaded, &mut engine, Instant::now(), now_ms()),
            Wake::LiveMarket(Some(msg)) => live.on_market(&mut engine, msg),
            Wake::LiveMarket(None) => {
                warn!("live market channel closed");
                live.market = None;
                Vec::new()
            }
            Wake::LiveError(Some(event)) => vec![event],
            Wake::LiveError(None) => {
                live.errors = None;
                Vec::new()
            }
            Wake::History(Some(result)) => match result.outcome {
                Ok(bars) => engine.on_history(&result.symbol, result.timeframe, &bars),
                Err(reason) => engine.on_history_failed(&result.symbol, result.timeframe, &reason),
            },
            Wake::History(None) => {
                warn!("backfill task stopped");
                live.history = None;
                Vec::new()
            }
            Wake::ReplayDue => replay.release(&mut engine, Instant::now()),
        };
        write_events(&mut output, &events)
            .await
            .map_err(RunError::Write)?;
    }
    output.flush().await.map_err(RunError::Write)
}

/// Turns one input line into Events: decode failures become an `error` Event, `start_replay`
/// goes to the replay feed, and other valid Commands go to the engine (Req 2.4, 2.5).
pub fn on_line(engine: &mut Engine, replay: &mut Replay, line: Line) -> Vec<Event> {
    let bytes = match line {
        Line::Complete(bytes) => bytes,
        Line::TooLong { len } => return rejected(&DecodeError::LineTooLong { len }),
    };
    let Ok(text) = std::str::from_utf8(&bytes) else {
        debug!("rejected input line: not UTF-8");
        return vec![Event::Error {
            code: ErrorCode::InvalidJson,
            message: "invalid JSON: line is not valid UTF-8".into(),
        }];
    };
    match decode_command(text) {
        Ok(Command::StartReplay { fixture, speed }) => replay.start(fixture, speed),
        Ok(cmd) => engine.on_command(cmd),
        Err(err) => rejected(&err),
    }
}

fn rejected(err: &DecodeError) -> Vec<Event> {
    debug!(code = ?err.code(), "rejected input line");
    vec![err.to_event()]
}

/// Result of a fixture read on the blocking pool.
type LoadResult = Result<Result<Vec<FixtureLine>, FixtureError>, JoinError>;

/// A fixture read in progress.
struct PendingLoad {
    fixture: String,
    speed: u32,
    handle: JoinHandle<Result<Vec<FixtureLine>, FixtureError>>,
}

/// The replay that is releasing messages.
struct ActiveReplay {
    fixture: String,
    schedule: ReplaySchedule,
    /// The message due at `deadline`.
    next: Scheduled,
    deadline: Instant,
}

/// Replay feed state: at most one fixture load in flight and at most one running replay.
///
/// A load that fails leaves the running replay untouched (Req 6.5). A load that succeeds
/// replaces it, so `start_replay` with the same fixture restarts it from line 0.
pub struct Replay {
    fixtures_dir: PathBuf,
    pending: Option<PendingLoad>,
    active: Option<ActiveReplay>,
}

impl Replay {
    pub fn new(fixtures_dir: PathBuf) -> Self {
        Self {
            fixtures_dir,
            pending: None,
            active: None,
        }
    }

    /// When the next replay message is due, if a replay is running.
    fn deadline(&self) -> Option<Instant> {
        self.active.as_ref().map(|active| active.deadline)
    }

    /// Starts loading `fixture` from the fixtures directory on the blocking pool. Returns error
    /// Events for a bad speed or name; otherwise none, and [`Replay::on_loaded`] reports the
    /// outcome. A newer `start_replay` supersedes a load that has not finished.
    fn start(&mut self, fixture: String, speed: u32) -> Vec<Event> {
        // `decode_command` already refuses both of these (Req 6.4, 6.5); checked again so the
        // replay feed never relies on its caller.
        if !(MIN_REPLAY_SPEED..=MAX_REPLAY_SPEED).contains(&speed) {
            return vec![schedule_error_event(
                &fixture,
                &ScheduleError::SpeedOutOfRange(speed),
            )];
        }
        // Path traversal: a valid name matches `^[a-z0-9-]+\.jsonl$`, so it has no separator,
        // no `..`, no drive prefix, and is not absolute. Joining it to the fixtures directory
        // therefore names a file directly inside that directory.
        if !is_valid_fixture_name(&fixture) {
            return vec![DecodeError::InvalidFixture(fixture).to_event()];
        }
        let path = self.fixtures_dir.join(&fixture);
        debug_assert_eq!(
            path.file_name(),
            Some(std::ffi::OsStr::new(&fixture)),
            "a valid fixture name is a single path component"
        );
        info!(fixture = %fixture, speed, "loading replay fixture");
        // `read_fixture` blocks (about 6 MB for the demo fixture), so it runs on the blocking
        // pool and the heartbeat keeps ticking meanwhile.
        let handle = tokio::task::spawn_blocking(move || read_fixture(path));
        let superseded = self.pending.replace(PendingLoad {
            fixture,
            speed,
            handle,
        });
        if let Some(old) = superseded {
            // The read cannot be interrupted; its result is dropped when it finishes.
            debug!(fixture = %old.fixture, "superseded a pending fixture load");
        }
        Vec::new()
    }

    /// Handles a finished fixture load: replaces the running replay on success, or returns an
    /// error Event and keeps the running replay on failure (Req 6.5).
    ///
    /// For a fixture longer than the warm-up window, the old prefix is applied to `engine` at
    /// once (Req 2.3) and the returned Events are its fresh snapshots (Req 2.4). Nothing can
    /// interleave: this runs in one synchronous step. The speed applies from `lines[k]` on.
    ///
    /// `wall_ms` is the wall-clock time (Unix epoch ms) at load, read by the caller with
    /// [`now_ms`]. Every fixture time is shifted by one minute-multiple offset so the first line
    /// after the warm-up falls in that minute (chart-and-tape-fix Req 2.12). `now` is the
    /// monotonic instant that the replay deadlines count from.
    fn on_loaded(
        &mut self,
        loaded: LoadResult,
        engine: &mut Engine,
        now: Instant,
        wall_ms: TimeMs,
    ) -> Vec<Event> {
        let Some(PendingLoad { fixture, speed, .. }) = self.pending.take() else {
            return Vec::new();
        };
        let lines = match loaded {
            Ok(Ok(lines)) => lines,
            Ok(Err(err)) => {
                warn!(fixture = %fixture, line = ?err.line(), %err, "fixture rejected; current replay unchanged");
                return vec![load_error_event(&fixture, &err)];
            }
            Err(err) => {
                error!(fixture = %fixture, %err, "fixture load task failed");
                let message = format!("loading fixture {fixture:?} failed");
                return vec![error_event(ErrorCode::Internal, message)];
            }
        };
        // Before take_warmup / warm_up: the core only ever sees shifted times.
        let aligned = align_to_now(lines, wall_ms);
        if aligned.overflowed {
            warn!(fixture = %fixture, "replay time alignment overflowed; using the recorded times");
        }
        info!(fixture = %fixture, offset_ms = aligned.offset, "replay time offset applied");
        let mut schedule = match ReplaySchedule::new(aligned.lines, speed) {
            Ok(schedule) => schedule,
            Err(err) => {
                warn!(fixture = %fixture, %err, "fixture cannot be replayed; current replay unchanged");
                return vec![schedule_error_event(&fixture, &err)];
            }
        };
        let warmup = schedule.take_warmup();
        let warmup_lines = warmup.len();
        // A new schedule always yields its first line (line `k` after a warm-up); this guards
        // the impossible case. Checked before the engine is touched.
        let Some(first) = schedule.next() else {
            return vec![schedule_error_event(&fixture, &ScheduleError::SpanTooLarge)];
        };
        let events = engine.warm_up(warmup);
        info!(
            fixture = %fixture,
            speed,
            warmup_lines,
            lines = schedule.lines_per_loop(),
            loop_period_ms = schedule.period(),
            replaced = self.active.is_some(),
            "replay started"
        );
        self.active = Some(ActiveReplay {
            fixture,
            deadline: now.checked_add(first.delay).unwrap_or(now),
            next: first,
            schedule,
        });
        events
    }

    /// Releases every replay message due at or before `now`, up to [`MAX_RELEASE_BATCH`], to
    /// the engine and returns the Events it produced. Deadlines advance from the previous
    /// deadline, not from `now`, so timing does not drift.
    fn release(&mut self, engine: &mut Engine, now: Instant) -> Vec<Event> {
        let mut events = Vec::new();
        for _ in 0..MAX_RELEASE_BATCH {
            let Some(active) = self.active.as_mut() else {
                break;
            };
            if active.deadline > now {
                break;
            }
            let following = active.schedule.next();
            let deadline = following
                .as_ref()
                .and_then(|f| active.deadline.checked_add(f.delay));
            match (following, deadline) {
                (Some(following), Some(deadline)) => {
                    active.deadline = deadline;
                    let current = mem::replace(&mut active.next, following);
                    events.extend(engine.on_market(current.line.msg));
                }
                _ => {
                    if let Some(ended) = self.active.take() {
                        warn!(fixture = %ended.fixture, "replay ended: market time overflow");
                        events.extend(engine.on_market(ended.next.line.msg));
                    }
                }
            }
        }
        events
    }
}

/// Waits for the pending fixture load, or forever if there is none.
async fn wait_load(pending: &mut Option<PendingLoad>) -> LoadResult {
    match pending {
        Some(load) => (&mut load.handle).await,
        None => std::future::pending().await,
    }
}

/// Sleeps until `deadline`, or forever if there is none.
async fn sleep_until_some(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

/// Writes `events` as JSON lines and flushes once for the whole batch.
async fn write_events<W: AsyncWrite + Unpin>(output: &mut W, events: &[Event]) -> io::Result<()> {
    if events.is_empty() {
        return Ok(());
    }
    let mut batch = String::new();
    for event in events {
        match encode_line(event) {
            Ok(line) => batch.push_str(&line),
            Err(err) => error!(%err, "dropped an event that failed to encode"),
        }
    }
    output.write_all(batch.as_bytes()).await?;
    output.flush().await
}

/// Wall-clock time in milliseconds since the Unix epoch, for Heartbeat Events and for aligning
/// a loaded replay fixture to the current minute.
fn now_ms() -> TimeMs {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| {
        TimeMs::try_from(d.as_millis()).unwrap_or(TimeMs::MAX)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::pin::Pin;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::task::{Context, Poll};

    use protocol::{Price, Qty, Side, decode_line};
    use tokio::io::{AsyncBufReadExt, BufReader};

    use crate::feed::MarketMsg;
    use crate::feed::fixture::encode_fixture_line;

    fn line(s: &str) -> Line {
        Line::Complete(s.as_bytes().to_vec())
    }

    fn config() -> RunConfig {
        RunConfig {
            heartbeat: HEARTBEAT_PERIOD,
            fixtures_dir: std::env::temp_dir(),
            live: None,
        }
    }

    fn replay() -> Replay {
        Replay::new(std::env::temp_dir())
    }

    fn error_code(events: &[Event]) -> ErrorCode {
        match events {
            [Event::Error { code, .. }] => *code,
            other => panic!("expected one error event, got {other:?}"),
        }
    }

    fn error_message(events: &[Event]) -> &str {
        match events {
            [Event::Error { message, .. }] => message,
            other => panic!("expected one error event, got {other:?}"),
        }
    }

    #[test]
    fn ping_line_gives_pong() {
        let mut engine = Engine::new();
        let mut replay = replay();
        let events = on_line(&mut engine, &mut replay, line(r#"{"type":"ping","id":9}"#));
        assert_eq!(events, vec![Event::Pong { id: 9 }]);
    }

    #[test]
    fn invalid_lines_give_error_events() {
        let mut engine = Engine::new();
        let mut replay = replay();
        let cases = [
            (line("not json"), ErrorCode::InvalidJson),
            (line(r#"{"type":"nope"}"#), ErrorCode::InvalidCommand),
            (
                Line::Complete(vec![b'"', 0xff, b'"']),
                ErrorCode::InvalidJson,
            ),
            (
                Line::TooLong {
                    len: MAX_LINE_BYTES + 1,
                },
                ErrorCode::OutOfRange,
            ),
            (
                line(r#"{"type":"start_replay","fixture":"demo.jsonl","speed":51}"#),
                ErrorCode::OutOfRange,
            ),
            (
                line(r#"{"type":"start_replay","fixture":"../demo.jsonl","speed":5}"#),
                ErrorCode::InvalidFixture,
            ),
        ];
        for (input, code) in cases {
            assert_eq!(error_code(&on_line(&mut engine, &mut replay, input)), code);
        }
        assert!(replay.pending.is_none() && replay.active.is_none());
        // The engine keeps working after bad input (Req 2.4).
        let events = on_line(&mut engine, &mut replay, line(r#"{"type":"ping","id":1}"#));
        assert_eq!(events, vec![Event::Pong { id: 1 }]);
    }

    #[test]
    fn subscribe_line_gives_a_snapshot_and_unsubscribe_gives_nothing() {
        let mut engine = Engine::new();
        let mut replay = replay();
        let subscribe = r#"{"type":"subscribe","symbol":"BTC-USD","timeframe":"1m"}"#;
        assert_eq!(
            on_line(&mut engine, &mut replay, line(subscribe)),
            vec![Event::Candle {
                symbol: "BTC-USD".into(),
                timeframe: protocol::Timeframe::M1,
                snapshot: true,
                bars: Vec::new(),
                indicators: Some(Vec::new()),
            }]
        );
        let unsubscribe = r#"{"type":"unsubscribe","symbol":"BTC-USD","timeframe":"1m"}"#;
        assert_eq!(
            on_line(&mut engine, &mut replay, line(unsubscribe)),
            Vec::new()
        );
    }

    #[test]
    fn start_guards_speed_and_name_without_loading() {
        let mut replay = replay();
        for speed in [0, 51] {
            let events = replay.start("demo.jsonl".into(), speed);
            assert_eq!(error_code(&events), ErrorCode::OutOfRange, "{speed}");
        }
        for name in ["../demo.jsonl", "a/b.jsonl", "C:demo.jsonl", "demo.json"] {
            let events = replay.start(name.into(), 10);
            assert_eq!(error_code(&events), ErrorCode::InvalidFixture, "{name}");
        }
        assert!(replay.pending.is_none() && replay.active.is_none());
    }

    /// A fixture file with a unique valid name in the temp directory, removed when dropped.
    struct TempFixture {
        name: String,
        path: PathBuf,
    }

    impl TempFixture {
        fn new(tag: &str, contents: &[u8]) -> Self {
            let name = unique_name(tag);
            let path = std::env::temp_dir().join(&name);
            fs::write(&path, contents).unwrap();
            Self { name, path }
        }

        fn with_trades(tag: &str, trades: &[(TimeMs, i64)]) -> Self {
            let text: String = trades
                .iter()
                .map(|&(recv, price)| encode_fixture_line(&trade(recv, price)).unwrap())
                .collect();
            Self::new(tag, text.as_bytes())
        }
    }

    impl Drop for TempFixture {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.path);
        }
    }

    fn unique_name(tag: &str) -> String {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let pid = std::process::id();
        let name = format!("haunted-replay-{tag}-{pid}-{nanos}-{n}.jsonl");
        assert!(is_valid_fixture_name(&name), "{name}");
        name
    }

    fn trade(recv: TimeMs, price: i64) -> FixtureLine {
        FixtureLine {
            recv,
            msg: MarketMsg::Trade {
                symbol: "BTC-USD".into(),
                price: Price(price),
                qty: Qty(1),
                side: Side::Buy,
                ts: recv,
            },
        }
    }

    fn prices(events: &[Event]) -> Vec<i64> {
        events
            .iter()
            .map(|e| match e {
                Event::Trade { price, .. } => price.0,
                other => panic!("not a trade: {other:?}"),
            })
            .collect()
    }

    /// Injected wall clock for `start_and_load`: 2026-12-03 12:00:00 UTC.
    const TEST_WALL_MS: TimeMs = 1_796_299_200_000;

    /// Starts `fixture`, waits for the load, and returns the Events of the outcome.
    async fn start_and_load(replay: &mut Replay, fixture: &str, now: Instant) -> Vec<Event> {
        assert_eq!(replay.start(fixture.into(), 1), Vec::new());
        let loaded = wait_load(&mut replay.pending).await;
        // These fixtures are short, so the warm-up is empty. The wall clock is fixed so the
        // offset is deterministic; tests here assert prices and order, not absolute times.
        replay.on_loaded(loaded, &mut Engine::new(), now, TEST_WALL_MS)
    }

    fn active_fixture(replay: &Replay) -> Option<&str> {
        replay.active.as_ref().map(|a| a.fixture.as_str())
    }

    #[tokio::test]
    async fn missing_fixture_is_named_and_keeps_the_running_replay() {
        let fixture = TempFixture::with_trades("keep", &[(0, 1), (0, 2), (5_000, 3)]);
        let mut engine = Engine::new();
        let mut replay = replay();
        let now = Instant::now();
        assert_eq!(replay.deadline(), None, "nothing runs before start_replay");
        let events = start_and_load(&mut replay, &fixture.name, now).await;
        assert!(events.is_empty(), "{events:?}");
        assert_eq!(prices(&replay.release(&mut engine, now)), [1, 2]);

        let missing = unique_name("missing");
        let events = start_and_load(&mut replay, &missing, now).await;
        assert_eq!(error_code(&events), ErrorCode::InvalidFixture);
        assert_eq!(
            error_message(&events),
            format!("fixture {missing:?} does not exist")
        );

        // The running replay is untouched: same fixture, same position.
        assert_eq!(active_fixture(&replay), Some(fixture.name.as_str()));
        assert!(replay.release(&mut engine, now).is_empty());
        let later = now + Duration::from_millis(5_000);
        assert_eq!(prices(&replay.release(&mut engine, later)), [3]);
    }

    #[tokio::test]
    async fn parse_error_names_the_fixture_and_line() {
        let good = encode_fixture_line(&trade(0, 1)).unwrap();
        let fixture = TempFixture::new("bad", format!("{good}{good}{{bad\n").as_bytes());
        let mut replay = replay();
        let now = Instant::now();
        let events = start_and_load(&mut replay, &fixture.name, now).await;
        assert_eq!(error_code(&events), ErrorCode::InvalidFixture);
        let message = error_message(&events);
        let prefix = format!("fixture {:?} cannot be parsed: line 3: ", fixture.name);
        assert!(message.starts_with(&prefix), "{message}");
        assert!(replay.active.is_none());

        let empty = TempFixture::new("empty", b"");
        let events = start_and_load(&mut replay, &empty.name, now).await;
        assert_eq!(error_code(&events), ErrorCode::InvalidFixture);
        assert!(error_message(&events).ends_with("has no lines"));
    }

    #[tokio::test]
    async fn start_replay_replaces_or_restarts_the_running_replay() {
        let a = TempFixture::with_trades("a", &[(0, 1), (0, 2), (5_000, 3)]);
        let b = TempFixture::with_trades("b", &[(0, 10), (5_000, 11)]);
        let mut engine = Engine::new();
        let mut replay = replay();
        let now = Instant::now();

        let events = start_and_load(&mut replay, &a.name, now).await;
        assert!(events.is_empty(), "{events:?}");
        assert_eq!(prices(&replay.release(&mut engine, now)), [1, 2]);
        // Same fixture again: starts over from line 0.
        let events = start_and_load(&mut replay, &a.name, now).await;
        assert!(events.is_empty(), "{events:?}");
        assert_eq!(prices(&replay.release(&mut engine, now)), [1, 2]);
        // Another fixture replaces it.
        let events = start_and_load(&mut replay, &b.name, now).await;
        assert!(events.is_empty(), "{events:?}");
        assert_eq!(active_fixture(&replay), Some(b.name.as_str()));
        assert_eq!(prices(&replay.release(&mut engine, now)), [10]);
    }

    /// Decodes every output line as an Event and drops the Heartbeats.
    fn non_heartbeat_events(output: &[u8]) -> Vec<Event> {
        let text = std::str::from_utf8(output).unwrap();
        assert!(text.is_empty() || text.ends_with('\n'), "{text:?}");
        text.lines()
            .map(|l| decode_line::<Event>(l).unwrap())
            .filter(|e| !matches!(e, Event::Heartbeat { .. }))
            .collect()
    }

    #[tokio::test]
    async fn run_answers_until_eof_and_survives_an_over_long_line() {
        let ping = |id: u64| format!(r#"{{"type":"ping","id":{id}}}"#);
        let pad = "x".repeat(MAX_LINE_BYTES);
        let long = format!(r#"{{"type":"ping","id":5,"pad":"{pad}"}}"#);
        let input = format!("{}\r\n{long}\r\n{}\n{}", ping(1), ping(2), ping(3));
        let mut output = Vec::new();
        run(input.as_bytes(), &mut output, config()).await.unwrap();

        // No trades: replay does not start without `start_replay`.
        let events = non_heartbeat_events(&output);
        assert_eq!(events.len(), 4, "{events:?}");
        assert_eq!(events[0], Event::Pong { id: 1 });
        assert_eq!(error_code(&events[1..2]), ErrorCode::OutOfRange);
        assert_eq!(events[2], Event::Pong { id: 2 });
        assert_eq!(events[3], Event::Pong { id: 3 });
    }

    #[tokio::test]
    async fn run_emits_a_heartbeat_with_wall_clock_time() {
        // Keep stdin open briefly: the first tick fires within a millisecond, not on the first
        // poll, so an input that is already at EOF would stop the run before any heartbeat.
        let (stdin_writer, stdin_reader) = tokio::io::duplex(64);
        let close_stdin = async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            drop(stdin_writer);
        };
        let mut output = Vec::new();
        let engine = run(BufReader::new(stdin_reader), &mut output, config());
        let (result, ()) = tokio::join!(engine, close_stdin);
        result.unwrap();
        let text = std::str::from_utf8(&output).unwrap();
        let first = text.lines().next().unwrap();
        let Event::Heartbeat { ts } = decode_line::<Event>(first).unwrap() else {
            panic!("not a heartbeat: {first}");
        };
        // After 2023-11-14 and before 2100: a real epoch-millisecond time.
        assert!((1_700_000_000_000..4_102_444_800_000).contains(&ts), "{ts}");
    }

    /// End to end with real time: `start_replay` at 50× releases the fixture's trades in order,
    /// then loops with market time shifted by duration + gap.
    #[tokio::test]
    async fn run_replays_trades_in_order_and_loops() {
        const BASE: TimeMs = 1_798_761_600_000;
        let lines = [(BASE, 1), (BASE + 20, 2), (BASE + 40, 3)];
        let fixture = TempFixture::with_trades("run", &lines);
        let before = now_ms();
        let (mut stdin_writer, stdin_reader) = tokio::io::duplex(1024);
        let (stdout_writer, stdout_reader) = tokio::io::duplex(64 * 1024);
        let engine = run(BufReader::new(stdin_reader), stdout_writer, config());
        let start = Command::StartReplay {
            fixture: fixture.name.clone(),
            speed: 50,
        };
        let client = async move {
            let line = encode_line(&start).unwrap();
            stdin_writer.write_all(line.as_bytes()).await.unwrap();
            let mut out = BufReader::new(stdout_reader).lines();
            let mut trades = Vec::new();
            while trades.len() < 7 {
                let text = out.next_line().await.unwrap().expect("engine stopped");
                match decode_line::<Event>(&text).unwrap() {
                    Event::Trade { price, ts, .. } => trades.push((price.0, ts)),
                    Event::Heartbeat { .. } => {}
                    other => panic!("unexpected event: {other:?}"),
                }
            }
            // Close stdin so the engine exits, and drain its output until it does.
            drop(stdin_writer);
            while out.next_line().await.unwrap().is_some() {}
            trades
        };
        let both = async { tokio::join!(engine, client) };
        let (result, trades) = tokio::time::timeout(Duration::from_secs(5), both)
            .await
            .expect("replay did not produce 7 trades within 5 s");
        result.unwrap();

        // Replay time is aligned to the wall clock: the first trade (BASE is a minute boundary)
        // sits exactly on the minute of the load, and the rest keep the recorded offsets.
        let first_ts = trades[0].1;
        assert_eq!(first_ts % 60_000, 0, "{first_ts}");
        let (lo, hi) = (before - before % 60_000, now_ms());
        assert!(
            (lo..=hi).contains(&first_ts),
            "{first_ts} not in {lo}..={hi}"
        );

        let period = 40 + crate::feed::replay::LOOP_GAP_MS;
        let expected: Vec<(i64, TimeMs)> = [(1, 0), (2, 20), (3, 40)]
            .iter()
            .cycle()
            .take(7)
            .enumerate()
            .map(|(i, &(price, dt))| {
                let k = TimeMs::try_from(i / 3).unwrap();
                (price, first_ts + dt + k * period)
            })
            .collect();
        assert_eq!(trades, expected);
    }

    /// Bug condition exploration (chart-and-tape-fix Task 1.3, Property 2; Req 1.3, 2.3): a
    /// fixture that spans more than 30 minutes must give the chart warm-up history at once.
    /// Two hours of one-trade-per-minute data, replayed at speed 1, subscribed to BTC-USD 1m:
    /// a snapshot with at least 85 bars must arrive within a few real seconds. On unfixed code
    /// replay starts at line 0 in real time, so only one bar exists.
    #[tokio::test]
    async fn replay_of_a_two_hour_fixture_warms_up_history_without_waiting() {
        // A minute boundary, so each trade opens its own 1m bar.
        const BASE: TimeMs = 28_333_333 * 60_000;
        let trades: Vec<(TimeMs, i64)> = (0..=120)
            .map(|i| (BASE + i * 60_000, 6_000_000 + i))
            .collect();
        let fixture = TempFixture::with_trades("warmup", &trades);
        let (mut stdin_writer, stdin_reader) = tokio::io::duplex(4096);
        let (stdout_writer, stdout_reader) = tokio::io::duplex(1024 * 1024);
        let engine = tokio::spawn(run(BufReader::new(stdin_reader), stdout_writer, config()));

        let subscribe = Command::Subscribe {
            symbol: "BTC-USD".into(),
            timeframe: protocol::Timeframe::M1,
        };
        let start = Command::StartReplay {
            fixture: fixture.name.clone(),
            speed: 1,
        };
        for cmd in [&subscribe, &start] {
            let text = encode_line(cmd).unwrap();
            stdin_writer.write_all(text.as_bytes()).await.unwrap();
        }

        let mut out = BufReader::new(stdout_reader).lines();
        let mut best_snapshot = 0usize;
        let mut bar_times = std::collections::BTreeSet::new();
        let watch = async {
            while best_snapshot < 85 {
                let Ok(Some(text)) = out.next_line().await else {
                    break;
                };
                if let Event::Candle { snapshot, bars, .. } = decode_line::<Event>(&text).unwrap() {
                    bar_times.extend(bars.iter().map(|b| b.t));
                    if snapshot {
                        best_snapshot = best_snapshot.max(bars.len());
                    }
                }
            }
        };
        // Short timeout: the unfixed engine never sends a big snapshot, so this must not hang.
        let _ = tokio::time::timeout(Duration::from_secs(3), watch).await;
        drop(stdin_writer);
        engine.abort();
        assert!(
            best_snapshot >= 85,
            "replay warm-up history missing: largest snapshot had {best_snapshot} bars \
             ({} distinct 1m bars seen in total)",
            bar_times.len()
        );
    }

    /// A writer whose pipe is closed.
    struct ClosedPipe;

    impl AsyncWrite for ClosedPipe {
        fn poll_write(
            self: Pin<&mut Self>,
            _: &mut Context<'_>,
            _: &[u8],
        ) -> Poll<io::Result<usize>> {
            Poll::Ready(Err(io::ErrorKind::BrokenPipe.into()))
        }
        fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }
        fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn run_stops_when_stdout_is_closed() {
        let input = b"{\"type\":\"ping\",\"id\":1}\n".repeat(3);
        let result = run(&input[..], ClosedPipe, config()).await;
        let Err(RunError::Write(err)) = result else {
            panic!("expected a write error, got {result:?}");
        };
        assert_eq!(err.kind(), io::ErrorKind::BrokenPipe);
    }
}
