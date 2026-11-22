//! `engine record` (Task 7.7, Req 7.1 to 7.3): captures the public feed of one venue into a
//! fixture file. Each line is `{"recv": TimeMs, "msg": MarketMsg}` (see `feed::fixture`).
//!
//! The Recorder runs the same venue adapters as live mode, so a recorded message is the
//! normalized [`MarketMsg`] that the engine core would have seen live. Replay later goes through
//! identical code (design §2 "Market feed").
//!
//! Layers, from pure to impure:
//! - [`Recorder`]: pure. Takes a [`MarketMsg`] and a receive time, filters by symbol, keeps `recv`
//!   non-decreasing (a clock that steps back is clamped to the last value), refuses lines that
//!   fixture validation would refuse, and counts.
//! - [`FixtureWriter`]: buffered file writer with the overwrite and `.partial` rules below.
//! - [`record_stream`]: reads any `mpsc::Receiver<MarketMsg>` until a limit is hit. Tests feed it
//!   canned messages or a real adapter pointed at a local server.
//! - [`run_record`] / [`run_command`]: start the production adapter and the wall clock.
//!
//! # Output file rules
//! - Lines go to `<out>.partial`. On a clean finish (a limit was reached or the feed ended) the
//!   file is flushed and renamed to `<out>`, so the final name never holds a half-written
//!   fixture.
//! - Without `--force`, the run refuses to start if `<out>` exists, and also refuses if a
//!   `<out>.partial` is left over from an interrupted run (the partial is created with
//!   `create_new`). The final rename re-checks `<out>`; if it appeared meanwhile, the partial is
//!   kept and the run fails. With `--force`, both are replaced.
//! - Parent directories are created.
//! - The writer flushes at least once per [`FLUSH_INTERVAL`]. If the process is killed, the
//!   partial file keeps everything flushed so far; its last line can be cut short and then needs
//!   trimming before use.
//! - Ctrl-C is not handled: the engine's tokio build does not enable the `signal` feature, so a
//!   run ends only through `--duration`, `--max-messages`, or a failure.
//!
//! Logs go to stderr through `tracing`. Nothing is written to stdout.

use std::collections::BTreeMap;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use protocol::{Event, INSTRUMENTS, MAX_LINE_BYTES, TimeMs, Venue, instrument};
use tokio::sync::mpsc;
use tracing::{error, info, warn};

use crate::feed::MarketMsg;
use crate::feed::backpack::run_backpack;
use crate::feed::coinbase::run_coinbase;
use crate::feed::fixture::{
    FixtureError, FixtureLine, decode_fixture_line, encode_fixture_line, read_fixture,
};
use crate::feed::venue::venue_name;

/// Default `--duration` in seconds.
pub const DEFAULT_DURATION_SECS: u64 = 300;
/// Longest `--duration` in seconds (one day).
pub const MAX_DURATION_SECS: u64 = 86_400;
/// The writer flushes after a write when this long has passed since the last flush.
pub const FLUSH_INTERVAL: Duration = Duration::from_secs(1);
/// Capacity of the market data channel between the adapter and the recorder.
const MARKET_CAPACITY: usize = 4_096;
/// Capacity of the adapter error channel.
const ERROR_CAPACITY: usize = 64;

/// What to record.
#[derive(Debug, Clone)]
pub struct RecordConfig {
    pub venue: Venue,
    /// Internal symbols, e.g. `BTC-USD`.
    pub symbols: Vec<String>,
    /// Final fixture path. Lines are written to `<out>.partial` first.
    pub out: PathBuf,
    /// Stop after this long. `None` means no time limit.
    pub duration: Option<Duration>,
    /// Stop after this many fixture lines. `None` means no count limit.
    pub max_messages: Option<u64>,
    /// Replace an existing output file and a leftover partial file.
    pub force: bool,
}

/// Limits for [`record_stream`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RecordLimits {
    pub duration: Option<Duration>,
    pub max_messages: Option<u64>,
}

/// Why [`record_stream`] or [`run_record`] stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    /// The duration limit passed.
    Duration,
    /// The message limit was reached.
    MaxMessages,
    /// The sending side of the channel is gone.
    ChannelClosed,
    /// The venue adapter returned (it only does when a channel closes).
    AdapterStopped,
}

impl fmt::Display for StopReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Duration => "duration reached",
            Self::MaxMessages => "message limit reached",
            Self::ChannelClosed => "feed channel closed",
            Self::AdapterStopped => "adapter stopped",
        })
    }
}

/// Why a recording failed.
#[derive(Debug)]
pub enum RecordError {
    /// A file operation failed.
    Io {
        action: &'static str,
        path: PathBuf,
        source: io::Error,
    },
    /// The output (or a leftover partial file) exists and `--force` was not given.
    Exists(PathBuf),
    /// A fixture line could not be encoded, or the finished file could not be read back.
    Fixture(FixtureError),
    /// The finished file does not hold what was written.
    Verify(String),
    /// The configuration is unusable.
    Config(String),
}

impl fmt::Display for RecordError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io {
                action,
                path,
                source,
            } => write!(f, "cannot {action} {}: {source}", path.display()),
            Self::Exists(path) => write!(
                f,
                "{} already exists; remove it or pass --force to replace it",
                path.display()
            ),
            Self::Fixture(err) => write!(f, "fixture error: {err}"),
            Self::Verify(message) => write!(f, "verification failed: {message}"),
            Self::Config(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for RecordError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            Self::Fixture(err) => Some(err),
            Self::Exists(_) | Self::Verify(_) | Self::Config(_) => None,
        }
    }
}

impl From<FixtureError> for RecordError {
    fn from(err: FixtureError) -> Self {
        Self::Fixture(err)
    }
}

// ---------------------------------------------------------------------------------------------
// Pure recorder
// ---------------------------------------------------------------------------------------------

/// What a finished recording holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordSummary {
    /// Fixture lines produced.
    pub lines: u64,
    /// Lines per internal symbol.
    pub per_symbol: BTreeMap<String, u64>,
    /// `recv` of the first and last line, or `None` when there are no lines.
    pub first_recv: Option<TimeMs>,
    pub last_recv: Option<TimeMs>,
    /// Messages skipped because their symbol was not requested.
    pub filtered: u64,
    /// Messages skipped because fixture validation would refuse the line.
    pub invalid: u64,
}

impl fmt::Display for RecordSummary {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} lines", self.lines)?;
        for (symbol, count) in &self.per_symbol {
            write!(f, ", {symbol} {count}")?;
        }
        if let (Some(first), Some(last)) = (self.first_recv, self.last_recv) {
            write!(f, ", recv {first}..{last}")?;
        }
        write!(f, ", {} filtered, {} invalid", self.filtered, self.invalid)
    }
}

/// Turns messages plus receive times into fixture lines. No I/O and no clock.
#[derive(Debug)]
pub struct Recorder {
    symbols: Vec<String>,
    first_recv: Option<TimeMs>,
    last_recv: Option<TimeMs>,
    lines: u64,
    per_symbol: BTreeMap<String, u64>,
    filtered: u64,
    invalid: u64,
}

impl Recorder {
    /// Records only the given internal symbols.
    pub fn new(symbols: &[String]) -> Self {
        Self {
            symbols: symbols.to_vec(),
            first_recv: None,
            last_recv: None,
            lines: 0,
            per_symbol: BTreeMap::new(),
            filtered: 0,
            invalid: 0,
        }
    }

    /// Fixture lines produced so far.
    pub fn lines(&self) -> u64 {
        self.lines
    }

    /// The fixture line for `msg` received at `now` (epoch ms), or `None` when the symbol was
    /// not requested or the line would fail fixture validation (Req 7.2).
    ///
    /// `recv` is `now`, raised to the previous line's `recv` when `now` is earlier, so the file
    /// satisfies the reader's non-decreasing rule.
    pub fn record(&mut self, msg: MarketMsg, now: TimeMs) -> Option<FixtureLine> {
        if !self.symbols.iter().any(|s| s == msg.symbol()) {
            self.filtered += 1;
            return None;
        }
        let recv = match self.last_recv {
            Some(last) if now < last => last,
            _ => now,
        };
        let line = FixtureLine { recv, msg };
        if !is_valid(&line) {
            self.invalid += 1;
            return None;
        }
        self.first_recv.get_or_insert(recv);
        self.last_recv = Some(recv);
        self.lines += 1;
        *self
            .per_symbol
            .entry(line.msg.symbol().to_owned())
            .or_insert(0) += 1;
        Some(line)
    }

    /// The totals of this recording.
    pub fn finish(self) -> RecordSummary {
        RecordSummary {
            lines: self.lines,
            per_symbol: self.per_symbol,
            first_recv: self.first_recv,
            last_recv: self.last_recv,
            filtered: self.filtered,
            invalid: self.invalid,
        }
    }
}

/// True when the reader would accept the line: it encodes, fits the line limit, and decodes.
fn is_valid(line: &FixtureLine) -> bool {
    let Ok(text) = encode_fixture_line(line) else {
        return false;
    };
    text.trim_end_matches('\n').len() <= MAX_LINE_BYTES && decode_fixture_line(&text).is_ok()
}

// ---------------------------------------------------------------------------------------------
// Output file
// ---------------------------------------------------------------------------------------------

/// Where [`record_stream`] puts fixture lines.
pub trait Sink {
    fn write_line(&mut self, line: &FixtureLine) -> Result<(), RecordError>;
    fn flush(&mut self) -> Result<(), RecordError>;
}

/// `<out>.partial`.
pub fn partial_path(out: &Path) -> PathBuf {
    let mut name = out.as_os_str().to_owned();
    name.push(".partial");
    PathBuf::from(name)
}

/// Buffered writer for a fixture file. See the module docs for the overwrite and partial rules.
#[derive(Debug)]
pub struct FixtureWriter {
    out: PathBuf,
    partial: PathBuf,
    force: bool,
    file: BufWriter<File>,
    last_flush: Instant,
    flush_interval: Duration,
}

impl FixtureWriter {
    /// Prepares `<out>.partial`. Creates missing parent directories.
    ///
    /// Without `force`, fails with [`RecordError::Exists`] when `<out>` or `<out>.partial`
    /// already exists.
    pub fn create(out: &Path, force: bool) -> Result<Self, RecordError> {
        let io_error = |action: &'static str, path: &Path| {
            let path = path.to_path_buf();
            move |source: io::Error| RecordError::Io {
                action,
                path,
                source,
            }
        };
        if !force && out.try_exists().map_err(io_error("check", out))? {
            return Err(RecordError::Exists(out.to_path_buf()));
        }
        if let Some(parent) = out.parent()
            && !parent.as_os_str().is_empty()
        {
            fs::create_dir_all(parent).map_err(io_error("create directory", parent))?;
        }
        let partial = partial_path(out);
        let mut options = OpenOptions::new();
        options.write(true);
        if force {
            options.create(true).truncate(true);
        } else {
            options.create_new(true);
        }
        let file = options.open(&partial).map_err(|source| {
            if source.kind() == io::ErrorKind::AlreadyExists {
                RecordError::Exists(partial.clone())
            } else {
                RecordError::Io {
                    action: "create",
                    path: partial.clone(),
                    source,
                }
            }
        })?;
        Ok(Self {
            out: out.to_path_buf(),
            partial,
            force,
            file: BufWriter::new(file),
            last_flush: Instant::now(),
            flush_interval: FLUSH_INTERVAL,
        })
    }

    /// Changes how often [`Sink::write_line`] flushes. Zero flushes after every line.
    #[cfg(test)]
    pub fn with_flush_interval(mut self, interval: Duration) -> Self {
        self.flush_interval = interval;
        self
    }

    /// Flushes, closes, and renames `<out>.partial` to `<out>`. Returns `<out>`.
    ///
    /// Without `force`, fails with [`RecordError::Exists`] if `<out>` appeared since
    /// [`FixtureWriter::create`]; the partial file is kept then.
    pub fn commit(self) -> Result<PathBuf, RecordError> {
        let Self {
            out,
            partial,
            force,
            mut file,
            ..
        } = self;
        file.flush().map_err(|source| RecordError::Io {
            action: "write",
            path: partial.clone(),
            source,
        })?;
        drop(file);
        let exists = out.try_exists().map_err(|source| RecordError::Io {
            action: "check",
            path: out.clone(),
            source,
        })?;
        if exists && !force {
            return Err(RecordError::Exists(out));
        }
        fs::rename(&partial, &out).map_err(|source| RecordError::Io {
            action: "rename to the final name",
            path: partial,
            source,
        })?;
        Ok(out)
    }

    fn write_error(&self, source: io::Error) -> RecordError {
        RecordError::Io {
            action: "write",
            path: self.partial.clone(),
            source,
        }
    }
}

impl Sink for FixtureWriter {
    fn write_line(&mut self, line: &FixtureLine) -> Result<(), RecordError> {
        let text = encode_fixture_line(line)?;
        if let Err(source) = self.file.write_all(text.as_bytes()) {
            return Err(self.write_error(source));
        }
        if self.last_flush.elapsed() >= self.flush_interval {
            self.flush()?;
        }
        Ok(())
    }

    fn flush(&mut self) -> Result<(), RecordError> {
        if let Err(source) = self.file.flush() {
            return Err(self.write_error(source));
        }
        self.last_flush = Instant::now();
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------------
// Stream loop
// ---------------------------------------------------------------------------------------------

/// Reads `rx` and writes fixture lines to `sink` until a limit is hit or `rx` closes, then
/// flushes the sink. `clock` returns the receive time in epoch ms.
pub async fn record_stream<S: Sink>(
    rx: &mut mpsc::Receiver<MarketMsg>,
    recorder: &mut Recorder,
    sink: &mut S,
    clock: &mut dyn FnMut() -> TimeMs,
    limits: RecordLimits,
) -> Result<StopReason, RecordError> {
    let deadline = limits
        .duration
        .map(|duration| tokio::time::Instant::now() + duration);
    let reason = loop {
        if limits
            .max_messages
            .is_some_and(|max| recorder.lines() >= max)
        {
            break StopReason::MaxMessages;
        }
        let next = match deadline {
            Some(deadline) => match tokio::time::timeout_at(deadline, rx.recv()).await {
                Ok(next) => next,
                Err(_elapsed) => break StopReason::Duration,
            },
            None => rx.recv().await,
        };
        let Some(msg) = next else {
            break StopReason::ChannelClosed;
        };
        if let Some(line) = recorder.record(msg, clock()) {
            sink.write_line(&line)?;
        }
    };
    sink.flush()?;
    Ok(reason)
}

// ---------------------------------------------------------------------------------------------
// Production entry points
// ---------------------------------------------------------------------------------------------

/// Parses one `--symbols` item: `BTC-USD`, or the short form `BTC`, in any case. Used by clap.
pub fn parse_symbol_arg(raw: &str) -> Result<String, String> {
    let upper = raw.trim().to_ascii_uppercase();
    let full = if instrument(&upper).is_some() {
        upper
    } else {
        format!("{upper}-USD")
    };
    if instrument(&full).is_some() {
        return Ok(full);
    }
    let known: Vec<&str> = INSTRUMENTS.iter().map(|i| i.symbol).collect();
    Err(format!(
        "unknown symbol {raw:?}; expected one of {}",
        known.join(", ")
    ))
}

/// Checks the symbols against the instrument table and removes duplicates, keeping the order.
fn normalize_symbols(symbols: &[String]) -> Result<Vec<String>, RecordError> {
    let mut out: Vec<String> = Vec::new();
    for symbol in symbols {
        if instrument(symbol).is_none() {
            return Err(RecordError::Config(format!("unknown symbol {symbol:?}")));
        }
        if !out.contains(symbol) {
            out.push(symbol.clone());
        }
    }
    if out.is_empty() {
        return Err(RecordError::Config("no symbols to record".to_owned()));
    }
    Ok(out)
}

/// The wall clock in epoch ms. Only the real entry point calls this.
fn wall_clock_ms() -> TimeMs {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| {
        TimeMs::try_from(d.as_millis()).unwrap_or(TimeMs::MAX)
    })
}

/// Runs the production adapter of `venue` until its channels close.
async fn run_adapter(
    venue: Venue,
    tx: mpsc::Sender<MarketMsg>,
    errors: mpsc::Sender<Event>,
    symbols: Vec<String>,
) {
    match venue {
        Venue::Coinbase => run_coinbase(tx, errors, symbols).await,
        Venue::Backpack => run_backpack(tx, errors, symbols).await,
        // No recorder for the DEX price feeds or for replay yet; the CLI only offers CEX venues.
        Venue::Jupiter | Venue::Raydium | Venue::Replay => {
            warn!(
                venue = venue_name(venue),
                "no recorder adapter for this venue"
            );
        }
    }
}

/// Logs adapter error events to stderr. They are not recorded. Never completes.
async fn log_adapter_errors(mut errors: mpsc::Receiver<Event>) {
    while let Some(event) = errors.recv().await {
        match event {
            Event::Error { code, message } => {
                warn!(?code, %message, "feed error (not recorded)");
            }
            other => warn!(?other, "feed event (not recorded)"),
        }
    }
    std::future::pending::<()>().await;
}

/// Records the public feed of `config.venue` into `config.out`, renames the finished file into
/// place, and reads it back through fixture validation to check the line count.
pub async fn run_record(config: &RecordConfig) -> Result<RecordSummary, RecordError> {
    let symbols = normalize_symbols(&config.symbols)?;
    let mut writer = FixtureWriter::create(&config.out, config.force)?;
    let mut recorder = Recorder::new(&symbols);
    let (tx, mut rx) = mpsc::channel(MARKET_CAPACITY);
    let (err_tx, err_rx) = mpsc::channel(ERROR_CAPACITY);
    let limits = RecordLimits {
        duration: config.duration,
        max_messages: config.max_messages,
    };
    let mut clock = wall_clock_ms;
    let stop = tokio::select! {
        result = record_stream(&mut rx, &mut recorder, &mut writer, &mut clock, limits) => result?,
        () = log_adapter_errors(err_rx) => StopReason::AdapterStopped,
        () = run_adapter(config.venue, tx, err_tx, symbols.clone()) => StopReason::AdapterStopped,
    };
    info!(reason = %stop, "recording stopped");
    let summary = recorder.finish();
    let path = writer.commit()?;
    let read = read_fixture(&path)?;
    if u64::try_from(read.len()).ok() != Some(summary.lines) {
        return Err(RecordError::Verify(format!(
            "wrote {} lines but read back {}",
            summary.lines,
            read.len()
        )));
    }
    if summary.lines == 0 {
        warn!("the fixture is empty; replay cannot use it");
    }
    Ok(summary)
}

/// `engine record`: runs [`run_record`] on a new runtime and logs the outcome to stderr.
pub fn run_command(config: &RecordConfig) -> ExitCode {
    info!(
        venue = venue_name(config.venue),
        symbols = ?config.symbols,
        out = %config.out.display(),
        duration_s = config.duration.map(|d| d.as_secs()),
        max_messages = config.max_messages,
        force = config.force,
        "recording the public feed"
    );
    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(err) => {
            error!(%err, "failed to start the tokio runtime");
            return ExitCode::FAILURE;
        }
    };
    match rt.block_on(run_record(config)) {
        Ok(summary) => {
            info!(out = %config.out.display(), %summary, "fixture written and verified");
            ExitCode::SUCCESS
        }
        Err(err) => {
            error!(%err, "engine record failed");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::atomic::{AtomicUsize, Ordering};

    use futures_util::{SinkExt, StreamExt};
    use proptest::prelude::*;
    use protocol::{Level, Price, Qty, Side};
    use serde_json::Value;
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::Message;

    use crate::core::Engine;
    use crate::feed::backpack::{self, FetchError, SnapshotFetcher, SnapshotFuture};
    use crate::feed::backpack_parse::DepthSnapshot;
    use crate::feed::coinbase::{self, Backoff};
    use crate::feed::fixture::parse_fixture;
    use crate::feed::replay::ReplaySchedule;
    use crate::feed::strategies::valid_fixture_line;

    const TEST_TIMEOUT: Duration = Duration::from_secs(10);

    /// A unique directory under the temp directory, removed when dropped.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let n = NEXT.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let pid = std::process::id();
            Self(std::env::temp_dir().join(format!("haunted-record-{tag}-{pid}-{nanos}-{n}")))
        }

        /// `<dir>/sub/<name>`: the `sub` directory does not exist yet.
        fn out(&self, name: &str) -> PathBuf {
            self.0.join("sub").join(name)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    impl Sink for Vec<FixtureLine> {
        fn write_line(&mut self, line: &FixtureLine) -> Result<(), RecordError> {
            self.push(line.clone());
            Ok(())
        }

        fn flush(&mut self) -> Result<(), RecordError> {
            Ok(())
        }
    }

    fn all_symbols() -> Vec<String> {
        INSTRUMENTS.iter().map(|i| i.symbol.to_owned()).collect()
    }

    fn trade(symbol: &str, price: i64, ts: TimeMs) -> MarketMsg {
        MarketMsg::Trade {
            venue: protocol::Venue::Replay,
            symbol: symbol.into(),
            price: Price(price),
            qty: Qty(1_000),
            side: Side::Buy,
            ts,
        }
    }

    fn snapshot(symbol: &str, ts: TimeMs) -> MarketMsg {
        MarketMsg::BookSnapshot {
            venue: protocol::Venue::Replay,
            symbol: symbol.into(),
            bids: vec![Level {
                price: Price(99),
                qty: Qty(5),
            }],
            asks: vec![Level {
                price: Price(101),
                qty: Qty(7),
            }],
            ts,
        }
    }

    fn delta(symbol: &str, qty: i64, ts: TimeMs) -> MarketMsg {
        MarketMsg::BookDelta {
            venue: protocol::Venue::Replay,
            symbol: symbol.into(),
            side: Side::Sell,
            price: Price(101),
            qty: Qty(qty),
            ts,
        }
    }

    // --- Recorder ---------------------------------------------------------------------------

    #[test]
    fn recorder_keeps_requested_symbols_and_counts() {
        let mut recorder = Recorder::new(&["BTC-USD".to_owned(), "SOL-USD".to_owned()]);
        assert!(recorder.record(trade("BTC-USD", 10, 1), 100).is_some());
        assert!(recorder.record(trade("ETH-USD", 10, 2), 101).is_none());
        assert!(recorder.record(trade("SOL-USD", 10, 3), 102).is_some());
        assert!(recorder.record(snapshot("BTC-USD", 4), 103).is_some());
        assert!(recorder.record(trade("NOPE-USD", 10, 5), 104).is_none());
        assert_eq!(recorder.lines(), 3);

        let summary = recorder.finish();
        assert_eq!(summary.lines, 3);
        assert_eq!(summary.filtered, 2);
        assert_eq!(summary.invalid, 0);
        let counts: Vec<(&str, u64)> = summary
            .per_symbol
            .iter()
            .map(|(s, n)| (s.as_str(), *n))
            .collect();
        assert_eq!(counts, [("BTC-USD", 2), ("SOL-USD", 1)]);
        assert_eq!(
            (summary.first_recv, summary.last_recv),
            (Some(100), Some(103))
        );
        assert_eq!(
            summary.to_string(),
            "3 lines, BTC-USD 2, SOL-USD 1, recv 100..103, 2 filtered, 0 invalid"
        );
    }

    #[test]
    fn recorder_uses_the_receive_time_not_the_exchange_time() {
        let mut recorder = Recorder::new(&all_symbols());
        let msg = trade("BTC-USD", 10, 5);
        let line = recorder.record(msg.clone(), 1_000).unwrap();
        assert_eq!(line, FixtureLine { recv: 1_000, msg });
    }

    #[test]
    fn recorder_clamps_a_clock_that_steps_back() {
        let mut recorder = Recorder::new(&all_symbols());
        let recv: Vec<TimeMs> = [100, 90, 90, 150, 120, 150]
            .into_iter()
            .map(|now| recorder.record(trade("BTC-USD", 10, 1), now).unwrap().recv)
            .collect();
        assert_eq!(recv, [100, 100, 100, 150, 150, 150]);
        let summary = recorder.finish();
        assert_eq!(
            (summary.first_recv, summary.last_recv),
            (Some(100), Some(150))
        );
    }

    #[test]
    fn a_filtered_message_does_not_move_the_clamp() {
        let mut recorder = Recorder::new(&["BTC-USD".to_owned()]);
        assert!(recorder.record(trade("ETH-USD", 10, 1), 500).is_none());
        assert_eq!(
            recorder.record(trade("BTC-USD", 10, 1), 100).unwrap().recv,
            100
        );
    }

    #[test]
    fn recorder_skips_lines_that_fixture_validation_refuses() {
        let mut recorder = Recorder::new(&all_symbols());
        assert!(recorder.record(delta("BTC-USD", -1, 1), 10).is_none());
        assert!(recorder.record(trade("BTC-USD", 0, 1), 11).is_none());
        let huge = MarketMsg::BookSnapshot {
            venue: protocol::Venue::Replay,
            symbol: "BTC-USD".into(),
            bids: (1..=4_000)
                .map(|p| Level {
                    price: Price(p),
                    qty: Qty(1),
                })
                .collect(),
            asks: Vec::new(),
            ts: 1,
        };
        assert!(recorder.record(huge, 12).is_none());
        assert!(recorder.record(delta("BTC-USD", 0, 1), 13).is_some());
        let summary = recorder.finish();
        assert_eq!((summary.lines, summary.invalid), (1, 3));
        assert_eq!(summary.first_recv, Some(13));
    }

    #[test]
    fn an_empty_recording_has_no_times() {
        let summary = Recorder::new(&all_symbols()).finish();
        assert_eq!(summary.lines, 0);
        assert_eq!((summary.first_recv, summary.last_recv), (None, None));
        assert!(summary.per_symbol.is_empty());
    }

    // Property P3 at recorder level — validates Req 7.3
    proptest! {
        #![proptest_config(ProptestConfig::with_cases(128))]

        /// **Validates: Requirements 7.1, 7.2, 7.3**
        ///
        /// For all valid lines with non-decreasing `recv`, recording each message at its `recv`
        /// returns the same lines, and the encoded file parses back to them.
        #[test]
        fn recorded_lines_parse_back_unchanged(
            mut lines in prop::collection::vec(valid_fixture_line(), 0..20)
        ) {
            lines.sort_by_key(|line| line.recv);
            let mut recorder = Recorder::new(&all_symbols());
            let recorded: Vec<FixtureLine> = lines
                .iter()
                .filter_map(|line| recorder.record(line.msg.clone(), line.recv))
                .collect();
            prop_assert_eq!(&recorded, &lines);
            let mut text = String::new();
            for line in &recorded {
                text.push_str(
                    &encode_fixture_line(line).map_err(|e| TestCaseError::fail(e.to_string()))?,
                );
            }
            let parsed = parse_fixture(text.as_bytes())
                .map_err(|e| TestCaseError::fail(e.to_string()))?;
            prop_assert_eq!(parsed, recorded);
        }
    }

    // --- Symbol arguments -------------------------------------------------------------------

    #[test]
    fn symbol_arguments_accept_full_and_short_names() {
        assert_eq!(parse_symbol_arg("BTC-USD").unwrap(), "BTC-USD");
        assert_eq!(parse_symbol_arg("eth").unwrap(), "ETH-USD");
        assert_eq!(parse_symbol_arg(" sol-usd ").unwrap(), "SOL-USD");
        let err = parse_symbol_arg("NOPE").unwrap_err();
        assert!(err.contains("unknown symbol \"NOPE\""), "{err}");
        assert!(err.contains("BTC-USD, ETH-USD, SOL-USD"), "{err}");
        assert!(parse_symbol_arg("").is_err());
    }

    #[test]
    fn normalize_symbols_dedupes_and_rejects_unknown_or_empty() {
        let list = |items: &[&str]| items.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
        assert_eq!(
            normalize_symbols(&list(&["SOL-USD", "BTC-USD", "SOL-USD"])).unwrap(),
            ["SOL-USD", "BTC-USD"]
        );
        assert!(matches!(
            normalize_symbols(&list(&["NOPE-USD"])),
            Err(RecordError::Config(_))
        ));
        assert!(matches!(
            normalize_symbols(&[]),
            Err(RecordError::Config(_))
        ));
    }

    // --- Writer -----------------------------------------------------------------------------

    #[test]
    fn partial_path_appends_to_the_file_name() {
        assert_eq!(
            partial_path(Path::new("fixtures/x.jsonl")),
            PathBuf::from("fixtures/x.jsonl.partial")
        );
    }

    #[test]
    fn writer_creates_directories_and_renames_on_commit() {
        let dir = TempDir::new("commit");
        let out = dir.out("a.jsonl");
        let partial = partial_path(&out);
        let lines = vec![
            FixtureLine {
                recv: 1,
                msg: trade("BTC-USD", 10, 1),
            },
            FixtureLine {
                recv: 1,
                msg: snapshot("ETH-USD", 2),
            },
            FixtureLine {
                recv: 7,
                msg: delta("SOL-USD", 0, 3),
            },
        ];
        let mut writer = FixtureWriter::create(&out, false).unwrap();
        assert!(partial.exists());
        assert!(!out.exists(), "the final name stays free until the commit");
        for line in &lines {
            writer.write_line(line).unwrap();
        }
        let path = writer.commit().unwrap();
        assert_eq!(path, out);
        assert!(!partial.exists());
        assert_eq!(read_fixture(&out).unwrap(), lines);
    }

    #[test]
    fn an_abandoned_writer_leaves_only_the_partial_file() {
        let dir = TempDir::new("abandon");
        let out = dir.out("a.jsonl");
        let mut writer = FixtureWriter::create(&out, false)
            .unwrap()
            .with_flush_interval(Duration::ZERO);
        let line = FixtureLine {
            recv: 1,
            msg: trade("BTC-USD", 10, 1),
        };
        writer.write_line(&line).unwrap();
        drop(writer);
        assert!(!out.exists());
        assert_eq!(read_fixture(partial_path(&out)).unwrap(), [line]);
    }

    #[test]
    fn writer_refuses_to_overwrite_without_force() {
        let dir = TempDir::new("exists");
        let out = dir.out("a.jsonl");
        fs::create_dir_all(out.parent().unwrap()).unwrap();
        fs::write(&out, "keep me").unwrap();
        let err = FixtureWriter::create(&out, false).unwrap_err();
        assert!(matches!(&err, RecordError::Exists(p) if *p == out), "{err}");
        assert!(err.to_string().contains("--force"), "{err}");
        assert_eq!(fs::read_to_string(&out).unwrap(), "keep me");
        assert!(!partial_path(&out).exists());
    }

    #[test]
    fn writer_refuses_a_leftover_partial_without_force() {
        let dir = TempDir::new("stale");
        let out = dir.out("a.jsonl");
        fs::create_dir_all(out.parent().unwrap()).unwrap();
        fs::write(partial_path(&out), "stale").unwrap();
        let err = FixtureWriter::create(&out, false).unwrap_err();
        assert!(
            matches!(&err, RecordError::Exists(p) if *p == partial_path(&out)),
            "{err}"
        );
        assert_eq!(fs::read_to_string(partial_path(&out)).unwrap(), "stale");
    }

    #[test]
    fn force_replaces_the_output_and_a_leftover_partial() {
        let dir = TempDir::new("force");
        let out = dir.out("a.jsonl");
        fs::create_dir_all(out.parent().unwrap()).unwrap();
        fs::write(&out, "old").unwrap();
        fs::write(partial_path(&out), "stale").unwrap();
        let mut writer = FixtureWriter::create(&out, true).unwrap();
        let line = FixtureLine {
            recv: 5,
            msg: trade("BTC-USD", 10, 1),
        };
        writer.write_line(&line).unwrap();
        writer.commit().unwrap();
        assert_eq!(read_fixture(&out).unwrap(), [line]);
        assert!(!partial_path(&out).exists());
    }

    #[test]
    fn commit_without_force_fails_when_the_output_appeared_meanwhile() {
        let dir = TempDir::new("race");
        let out = dir.out("a.jsonl");
        let writer = FixtureWriter::create(&out, false).unwrap();
        fs::write(&out, "someone else").unwrap();
        let err = writer.commit().unwrap_err();
        assert!(matches!(err, RecordError::Exists(_)), "{err}");
        assert_eq!(fs::read_to_string(&out).unwrap(), "someone else");
        assert!(partial_path(&out).exists(), "the recording is kept");
    }

    // --- record_stream ----------------------------------------------------------------------

    /// A clock that returns 1_000, 1_001, 1_002, ...
    fn counter() -> impl FnMut() -> TimeMs {
        let mut next = 1_000;
        move || {
            next += 1;
            next - 1
        }
    }

    async fn canned(msgs: Vec<MarketMsg>) -> mpsc::Receiver<MarketMsg> {
        let (tx, rx) = mpsc::channel(msgs.len().max(1));
        for msg in msgs {
            tx.send(msg).await.unwrap();
        }
        // Keep the sender alive for the whole test so that only the limits can end the stream.
        std::mem::forget(tx);
        rx
    }

    #[tokio::test]
    async fn stream_stops_at_the_message_limit() {
        let msgs = (1..=5).map(|i| trade("BTC-USD", i, i)).collect();
        let mut rx = canned(msgs).await;
        let mut recorder = Recorder::new(&all_symbols());
        let mut sink: Vec<FixtureLine> = Vec::new();
        let limits = RecordLimits {
            duration: Some(TEST_TIMEOUT),
            max_messages: Some(3),
        };
        let stop = record_stream(&mut rx, &mut recorder, &mut sink, &mut counter(), limits)
            .await
            .unwrap();
        assert_eq!(stop, StopReason::MaxMessages);
        assert_eq!(sink.len(), 3);
        assert_eq!(recorder.finish().lines, 3);
    }

    #[tokio::test]
    async fn the_message_limit_counts_lines_not_filtered_messages() {
        let msgs = vec![
            trade("ETH-USD", 1, 1),
            trade("BTC-USD", 2, 2),
            trade("ETH-USD", 3, 3),
            trade("BTC-USD", 4, 4),
            trade("BTC-USD", 5, 5),
        ];
        let mut rx = canned(msgs).await;
        let mut recorder = Recorder::new(&["BTC-USD".to_owned()]);
        let mut sink: Vec<FixtureLine> = Vec::new();
        let limits = RecordLimits {
            duration: Some(TEST_TIMEOUT),
            max_messages: Some(2),
        };
        record_stream(&mut rx, &mut recorder, &mut sink, &mut counter(), limits)
            .await
            .unwrap();
        let prices: Vec<i64> = sink
            .iter()
            .map(|l| match &l.msg {
                MarketMsg::Trade { price, .. } => price.0,
                other => panic!("unexpected {other:?}"),
            })
            .collect();
        assert_eq!(prices, [2, 4]);
    }

    #[tokio::test]
    async fn stream_stops_at_the_duration_limit() {
        let mut rx = canned(vec![trade("BTC-USD", 1, 1)]).await;
        let mut recorder = Recorder::new(&all_symbols());
        let mut sink: Vec<FixtureLine> = Vec::new();
        let limits = RecordLimits {
            duration: Some(Duration::from_millis(50)),
            max_messages: None,
        };
        let stop = tokio::time::timeout(
            TEST_TIMEOUT,
            record_stream(&mut rx, &mut recorder, &mut sink, &mut counter(), limits),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(stop, StopReason::Duration);
        assert_eq!(sink.len(), 1);
    }

    #[tokio::test]
    async fn stream_stops_when_the_channel_closes() {
        let (tx, mut rx) = mpsc::channel(4);
        tx.send(trade("BTC-USD", 1, 1)).await.unwrap();
        tx.send(trade("SOL-USD", 2, 2)).await.unwrap();
        drop(tx);
        let mut recorder = Recorder::new(&all_symbols());
        let mut sink: Vec<FixtureLine> = Vec::new();
        let stop = record_stream(
            &mut rx,
            &mut recorder,
            &mut sink,
            &mut counter(),
            RecordLimits::default(),
        )
        .await
        .unwrap();
        assert_eq!(stop, StopReason::ChannelClosed);
        assert_eq!(
            sink.iter().map(|l| l.recv).collect::<Vec<_>>(),
            [1_000, 1_001]
        );
    }

    #[tokio::test]
    async fn a_zero_message_limit_records_nothing() {
        let mut rx = canned(vec![trade("BTC-USD", 1, 1)]).await;
        let mut recorder = Recorder::new(&all_symbols());
        let mut sink: Vec<FixtureLine> = Vec::new();
        let limits = RecordLimits {
            duration: None,
            max_messages: Some(0),
        };
        let stop = record_stream(&mut rx, &mut recorder, &mut sink, &mut counter(), limits)
            .await
            .unwrap();
        assert_eq!(stop, StopReason::MaxMessages);
        assert!(sink.is_empty());
    }

    /// File-level round trip (P3): messages in, committed file, `read_fixture` out.
    #[tokio::test]
    async fn recorded_file_reads_back_to_the_input_messages() {
        let dir = TempDir::new("roundtrip");
        let out = dir.out("rt.jsonl");
        let msgs = vec![
            snapshot("BTC-USD", 1),
            trade("BTC-USD", 6_400_000, 2),
            trade("XRP-USD", 5, 3),
            delta("BTC-USD", 0, 4),
            trade("SOL-USD", 15_000, 5),
        ];
        let (tx, mut rx) = mpsc::channel(8);
        for msg in &msgs {
            tx.send(msg.clone()).await.unwrap();
        }
        drop(tx);
        let mut recorder = Recorder::new(&all_symbols());
        let mut writer = FixtureWriter::create(&out, false).unwrap();
        let stop = record_stream(
            &mut rx,
            &mut recorder,
            &mut writer,
            &mut counter(),
            RecordLimits::default(),
        )
        .await
        .unwrap();
        assert_eq!(stop, StopReason::ChannelClosed);
        writer.commit().unwrap();

        // The clock ticks once per received message. XRP-USD is a v2 symbol, so it is kept.
        let expected: Vec<FixtureLine> = msgs
            .into_iter()
            .zip(1_000..)
            .map(|(msg, recv)| FixtureLine { recv, msg })
            .collect();
        assert_eq!(read_fixture(&out).unwrap(), expected);
        let summary = recorder.finish();
        assert_eq!((summary.lines, summary.filtered), (5, 0));
    }

    // --- Mock WebSocket, both venues --------------------------------------------------------

    fn sample(wrapped: &str) -> String {
        let value: Value = serde_json::from_str(wrapped).unwrap();
        value["sample"].to_string()
    }

    /// Accepts one connection, reads `expect_frames` text frames (the subscribe messages), sends
    /// `send`, then holds the connection open. Never returns.
    async fn serve_script(listener: TcpListener, expect_frames: usize, send: Vec<String>) {
        let (socket, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(socket).await.unwrap();
        for _ in 0..expect_frames {
            loop {
                match ws.next().await {
                    Some(Ok(Message::Text(_))) => break,
                    Some(Ok(_)) => {}
                    other => panic!("client ended before subscribing: {other:?}"),
                }
            }
        }
        for frame in send {
            ws.send(Message::text(frame)).await.unwrap();
        }
        while let Some(Ok(_)) = ws.next().await {}
        std::future::pending::<()>().await;
    }

    /// Checks that the file replays: a schedule builds and the engine core takes every message
    /// without an error event, and `recv` never decreases.
    fn assert_replays(lines: &[FixtureLine]) {
        ReplaySchedule::new(lines.to_vec(), 1).unwrap();
        assert!(lines.windows(2).all(|w| w[0].recv <= w[1].recv));
        let mut engine = Engine::new();
        for line in lines {
            let events = engine.on_market(line.msg.clone());
            assert!(
                !events.iter().any(|e| matches!(e, Event::Error { .. })),
                "{line:?} gave {events:?}"
            );
        }
    }

    struct FakeFetcher;

    impl SnapshotFetcher for FakeFetcher {
        fn fetch<'a>(&'a mut self, symbol: &'a str) -> SnapshotFuture<'a> {
            let snapshot = DepthSnapshot {
                symbol: symbol.to_owned(),
                last_update_id: 100,
                bids: vec![(Price(7_546), Qty(1))],
                asks: vec![(Price(7_547), Qty(2))],
                ts: 5,
            };
            Box::pin(async move { Ok::<_, FetchError>(snapshot) })
        }
    }

    #[tokio::test]
    async fn records_the_coinbase_adapter_against_a_mock_server() {
        let dir = TempDir::new("coinbase");
        let out = dir.out("cb.jsonl");
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let frames = vec![
            sample(include_str!("../tests/data/coinbase_level2_snapshot.json")),
            sample(include_str!("../tests/data/coinbase_trade.json")),
            sample(include_str!("../tests/data/coinbase_level2_update.json")),
        ];
        let (tx, mut rx) = mpsc::channel::<MarketMsg>(64);
        let (err_tx, _errors) = mpsc::channel::<Event>(16);
        let products = ["BTC-USD", "ETH-USD"];
        let mut recorder = Recorder::new(&all_symbols());
        let mut writer = FixtureWriter::create(&out, false).unwrap();
        let limits = RecordLimits {
            duration: None,
            max_messages: Some(3),
        };
        let mut clock = counter();

        let outcome = tokio::time::timeout(TEST_TIMEOUT, async {
            tokio::select! {
                () = coinbase::run_with_url(&url, &products, &tx, &err_tx, Backoff::new()) => {
                    panic!("the adapter stopped on its own");
                }
                () = serve_script(listener, 3, frames) => {
                    panic!("the mock server stopped");
                }
                result = record_stream(&mut rx, &mut recorder, &mut writer, &mut clock, limits) => result,
            }
        })
        .await
        .expect("test timed out")
        .unwrap();
        assert_eq!(outcome, StopReason::MaxMessages);
        writer.commit().unwrap();

        let lines = read_fixture(&out).unwrap();
        assert_eq!(lines.len(), 3);
        assert!(
            matches!(&lines[0].msg, MarketMsg::BookSnapshot { symbol, .. } if symbol == "ETH-USD"),
            "{:?}",
            lines[0]
        );
        assert!(
            matches!(&lines[1].msg, MarketMsg::Trade { symbol, price, .. }
                if symbol == "BTC-USD" && price.0 == 6_716_813),
            "{:?}",
            lines[1]
        );
        assert!(
            matches!(&lines[2].msg, MarketMsg::BookDelta { symbol, .. } if symbol == "ETH-USD"),
            "{:?}",
            lines[2]
        );
        assert_replays(&lines);
    }

    #[tokio::test]
    async fn records_the_backpack_adapter_against_a_mock_server() {
        let dir = TempDir::new("backpack");
        let out = dir.out("bp.jsonl");
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let depth = serde_json::json!({
            "stream": "depth.SOL_USDC",
            "data": {"e":"depth","E":1,"s":"SOL_USDC","a":[["75.50","1"]],"b":[],"U":101,"u":101,"T":2_000_000}
        })
        .to_string();
        let frames = vec![
            depth,
            sample(include_str!("../tests/data/backpack_trade.json")),
        ];
        let (tx, mut rx) = mpsc::channel::<MarketMsg>(64);
        let (err_tx, _errors) = mpsc::channel::<Event>(16);
        let symbols = vec!["SOL-USD".to_owned()];
        let mut fetcher = FakeFetcher;
        let mut recorder = Recorder::new(&all_symbols());
        let mut writer = FixtureWriter::create(&out, false).unwrap();
        let limits = RecordLimits {
            duration: None,
            max_messages: Some(3),
        };
        let mut clock = counter();

        let outcome = tokio::time::timeout(TEST_TIMEOUT, async {
            tokio::select! {
                () = backpack::run_with_url(&url, &symbols, &tx, &err_tx, Backoff::new(), &mut fetcher) => {
                    panic!("the adapter stopped on its own");
                }
                () = serve_script(listener, 1, frames) => {
                    panic!("the mock server stopped");
                }
                result = record_stream(&mut rx, &mut recorder, &mut writer, &mut clock, limits) => result,
            }
        })
        .await
        .expect("test timed out")
        .unwrap();
        assert_eq!(outcome, StopReason::MaxMessages);
        writer.commit().unwrap();

        let lines = read_fixture(&out).unwrap();
        assert_eq!(lines.len(), 3);
        assert!(
            matches!(&lines[0].msg, MarketMsg::BookSnapshot { symbol, .. } if symbol == "SOL-USD"),
            "{:?}",
            lines[0]
        );
        assert!(
            matches!(&lines[1].msg, MarketMsg::BookDelta { symbol, price, .. }
                if symbol == "SOL-USD" && price.0 == 7_550),
            "{:?}",
            lines[1]
        );
        assert!(
            matches!(&lines[2].msg, MarketMsg::Trade { symbol, price, .. }
                if symbol == "SOL-USD" && price.0 == 7_541),
            "{:?}",
            lines[2]
        );
        assert_replays(&lines);
    }
}
