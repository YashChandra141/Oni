//! Oni engine: a sidecar process that reads Commands as JSON lines on stdin and
//! writes Events as JSON lines on stdout (Req 3.1, 3.2). Logs go to stderr only (Req 3.3).

mod account;
mod balance;
mod book;
mod candles;
mod core;
mod feed;
mod indicators;
mod lines;
mod matcher;
mod pair;
mod record;
mod runtime;
mod synthetic_book;
mod ticker;
mod venues;

use std::fs;
use std::io::IsTerminal;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::{Args, Parser, Subcommand, ValueEnum};
use protocol::TimeMs;
use tokio::io::BufReader;
use tracing::{error, info};

use feed::fixture::{FixtureError, FixtureLine, read_fixture, write_fixture};
use feed::synth::{self, SynthConfig, SynthSymbol};

#[derive(Debug, Parser)]
#[command(name = "engine", version, about = "Oni engine sidecar")]
struct Cli {
    #[command(subcommand)]
    command: CliCommand,
}

#[derive(Debug, Subcommand)]
enum CliCommand {
    /// Read Commands from stdin and write Events to stdout until stdin closes.
    Run(RunArgs),
    /// Write a seeded random-walk fixture with trades, book snapshots, and book deltas.
    Synth(SynthArgs),
    /// Record a venue's public market data feed into a fixture file.
    Record(RecordArgs),
}

#[derive(Debug, Args)]
struct RecordArgs {
    /// Venue whose public feed is recorded.
    #[arg(long, value_enum, default_value_t = VenueArg::Backpack)]
    venue: VenueArg,
    /// Comma-separated symbols, e.g. BTC-USD,SOL-USD. Short names such as BTC also work.
    #[arg(
        long,
        value_delimiter = ',',
        num_args = 1..,
        value_parser = record::parse_symbol_arg,
        default_value = "BTC-USD,ETH-USD,SOL-USD"
    )]
    symbols: Vec<String>,
    /// Fixture file to write. Lines go to `<out>.partial` first. Missing directories are created.
    #[arg(long)]
    out: PathBuf,
    /// Stop after this many seconds (1 to 86400).
    #[arg(
        long,
        default_value_t = record::DEFAULT_DURATION_SECS,
        value_parser = clap::value_parser!(u64).range(1..=record::MAX_DURATION_SECS)
    )]
    duration: u64,
    /// Stop after this many fixture lines.
    #[arg(long, value_parser = clap::value_parser!(u64).range(1..))]
    max_messages: Option<u64>,
    /// Replace an existing output file (and a leftover `.partial` file).
    #[arg(long)]
    force: bool,
}

#[derive(Debug, Args)]
struct SynthArgs {
    /// Fixture file to write, replacing any existing file. Missing directories are created.
    #[arg(long)]
    out: PathBuf,
    /// Random seed. The same arguments always produce the same file.
    #[arg(long, default_value_t = synth::DEFAULT_SEED)]
    seed: u64,
    /// Length of the fixture in minutes (1 to 1440).
    #[arg(
        long,
        default_value_t = synth::DEFAULT_DURATION_MINUTES,
        value_parser = clap::value_parser!(u32).range(1..=1_440)
    )]
    duration: u32,
    /// Start time in epoch ms. Defaults to a constant (2027-01-01T00:00:00Z), not the clock.
    #[arg(
        long,
        default_value_t = synth::DEFAULT_START_MS,
        value_parser = clap::value_parser!(i64).range(0..)
    )]
    start: TimeMs,
    /// Comma-separated symbols, e.g. BTC-USD,SOL-USD. Short names such as BTC also work.
    #[arg(
        long,
        value_delimiter = ',',
        num_args = 1..,
        default_values_t = SynthSymbol::ALL
    )]
    symbols: Vec<SynthSymbol>,
}

#[derive(Debug, Args)]
struct RunArgs {
    /// Market data source. Not used yet.
    #[arg(long, value_enum, default_value_t = DataMode::Replay)]
    mode: DataMode,
    /// Directory that holds replay fixtures. A `start_replay` Command names a file in it.
    #[arg(long, default_value = "fixtures")]
    fixtures: PathBuf,
    /// Superseded by `--venues`; accepted for compatibility and otherwise ignored.
    #[arg(long, value_enum, default_value_t = VenueArg::Backpack, hide = true)]
    #[allow(dead_code)]
    venue: VenueArg,
    /// Live venues, comma separated: coinbase, backpack, jupiter, raydium. Without this flag the
    /// `LIVE_VENUES` environment variable is used, then all four. Only used with `--mode live`.
    #[arg(long, value_enum, value_delimiter = ',', num_args = 1..)]
    venues: Option<Vec<LiveVenueArg>>,
    /// Jupiter poll interval in ms when `JUPITER_API_KEY` is set (500 or more).
    #[arg(long, value_parser = clap::value_parser!(u64).range(500..=60_000))]
    jupiter_poll_ms: Option<u64>,
    /// Raydium price poll interval in ms.
    #[arg(
        long,
        default_value_t = feed::raydium::DEFAULT_POLL_MS,
        value_parser = clap::value_parser!(u64).range(1_000..=60_000)
    )]
    raydium_poll_ms: u64,
    /// Synthetic_Book levels per side.
    #[arg(
        long,
        default_value_t = synthetic_book::DEX_LEVELS_U32,
        value_parser = clap::value_parser!(u32).range(1..=50)
    )]
    dex_levels: u32,
    /// Synthetic_Book full spread in bps.
    #[arg(
        long,
        default_value_t = synthetic_book::DEX_SPREAD_BPS,
        value_parser = clap::value_parser!(i64).range(1..=10_000)
    )]
    dex_spread_bps: i64,
    /// Synthetic_Book price step between levels in bps.
    #[arg(
        long,
        default_value_t = synthetic_book::DEX_STEP_BPS,
        value_parser = clap::value_parser!(i64).range(1..=1_000)
    )]
    dex_step_bps: i64,
    /// Notional of each Synthetic_Book level in whole USD.
    #[arg(
        long,
        default_value_t = 25_000,
        value_parser = clap::value_parser!(u32).range(1..=1_000_000_000)
    )]
    dex_level_notional: u32,
    /// Largest accepted DEX price deviation from the reference price, in percent.
    #[arg(
        long,
        default_value_t = 5,
        value_parser = clap::value_parser!(u32).range(1..=100)
    )]
    dex_max_deviation_pct: u32,
    /// Starting_Balance of every Paper_Account in whole USD (1,000 to 100,000,000).
    #[arg(
        long,
        default_value_t = balance::DEFAULT_STARTING_BALANCE_USD,
        value_parser = clap::value_parser!(u32).range(1_000..=100_000_000)
    )]
    starting_balance: u32,
    /// Slippage allowance in basis points that Required_Funds adds to an order's reference price.
    #[arg(
        long,
        default_value_t = balance::DEFAULT_SLIPPAGE_BPS,
        value_parser = clap::value_parser!(u32).range(0..=10_000)
    )]
    balance_slippage_bps: u32,
}

/// Command line spelling of `protocol::Venue` (the protocol crate has no clap dependency).
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
enum VenueArg {
    Coinbase,
    Backpack,
}

impl From<VenueArg> for protocol::Venue {
    fn from(arg: VenueArg) -> Self {
        match arg {
            VenueArg::Coinbase => Self::Coinbase,
            VenueArg::Backpack => Self::Backpack,
        }
    }
}

/// Live venues that `--venues` and `LIVE_VENUES` accept.
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
enum LiveVenueArg {
    Coinbase,
    Backpack,
    Jupiter,
    Raydium,
}

impl From<LiveVenueArg> for protocol::Venue {
    fn from(arg: LiveVenueArg) -> Self {
        match arg {
            LiveVenueArg::Coinbase => Self::Coinbase,
            LiveVenueArg::Backpack => Self::Backpack,
            LiveVenueArg::Jupiter => Self::Jupiter,
            LiveVenueArg::Raydium => Self::Raydium,
        }
    }
}

/// Parses a `LIVE_VENUES` value such as `coinbase,backpack`.
fn parse_live_venues(text: &str) -> Result<Vec<protocol::Venue>, String> {
    let mut out = Vec::new();
    for part in text.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        let venue = LiveVenueArg::from_str(part, true)
            .map_err(|_| format!("unknown venue {part:?} in LIVE_VENUES"))?;
        out.push(protocol::Venue::from(venue));
    }
    Ok(out)
}

/// The venues to run: `--venues`, else `LIVE_VENUES`, else all four. Ordered like
/// `Venue::LIVE` (CEXs first) and deduplicated.
fn resolve_venues(args: &RunArgs) -> Result<Vec<protocol::Venue>, String> {
    let chosen: Vec<protocol::Venue> = match (&args.venues, std::env::var("LIVE_VENUES")) {
        (Some(list), _) => list.iter().copied().map(Into::into).collect(),
        (None, Ok(text)) => parse_live_venues(&text)?,
        (None, Err(_)) => protocol::Venue::LIVE.to_vec(),
    };
    let ordered: Vec<protocol::Venue> = protocol::Venue::LIVE
        .into_iter()
        .filter(|v| chosen.contains(v))
        .collect();
    if ordered.is_empty() {
        return Err("no live venues selected".into());
    }
    Ok(ordered)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
enum DataMode {
    /// Recorded fixture files.
    Replay,
    /// The Coinbase public feed.
    Live,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    init_tracing();
    match cli.command {
        CliCommand::Run(args) => run(&args),
        CliCommand::Synth(args) => synth_fixture(&args),
        CliCommand::Record(args) => record::run_command(&record::RecordConfig {
            venue: args.venue.into(),
            symbols: args.symbols,
            out: args.out,
            duration: Some(std::time::Duration::from_secs(args.duration)),
            max_messages: args.max_messages,
            force: args.force,
        }),
    }
}

/// Sends all logs to stderr so stdout carries only Events (Req 3.3). The level is fixed at
/// INFO because filtering by `RUST_LOG` needs tracing-subscriber's `env-filter` feature.
fn init_tracing() {
    let result = tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_ansi(std::io::stderr().is_terminal())
        .with_max_level(tracing::Level::INFO)
        .try_init();
    if let Err(err) = result {
        eprintln!("engine: logging setup failed: {err}");
    }
}

fn run(args: &RunArgs) -> ExitCode {
    info!(
        version = env!("CARGO_PKG_VERSION"),
        mode = ?args.mode,
        fixtures = %args.fixtures.display(),
        "engine starting"
    );
    let rt = match tokio::runtime::Builder::new_current_thread()
        // Time for the heartbeat and replay; I/O for the live feed's sockets.
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(err) => {
            error!(%err, "failed to start the tokio runtime");
            return ExitCode::FAILURE;
        }
    };
    let balance = match (balance::BalanceConfig {
        slippage_bps: args.balance_slippage_bps,
        ..balance::BalanceConfig::default()
    })
    .with_starting_usd(args.starting_balance)
    {
        Ok(balance) => balance,
        Err(err) => {
            error!(%err, "invalid balance settings");
            return ExitCode::FAILURE;
        }
    };
    let live = if args.mode == DataMode::Live {
        let venues = match resolve_venues(args) {
            Ok(venues) => venues,
            Err(err) => {
                error!(%err, "invalid live venues");
                return ExitCode::FAILURE;
            }
        };
        let Some(level_notional) = i64::from(args.dex_level_notional)
            .checked_mul(10_000_000_000)
            .map(protocol::Money)
        else {
            error!("--dex-level-notional is too large");
            return ExitCode::FAILURE;
        };
        info!(
            venues = ?venues.iter().map(|v| v.name()).collect::<Vec<_>>(),
            "live venues"
        );
        Some(runtime::LiveFeedConfig {
            venues,
            symbols: protocol::INSTRUMENTS
                .iter()
                .map(|instrument| instrument.symbol.to_owned())
                .collect(),
            jupiter_poll_ms: args.jupiter_poll_ms,
            raydium_poll_ms: args.raydium_poll_ms,
            dex: synthetic_book::DexParams {
                levels: usize::try_from(args.dex_levels).unwrap_or(synthetic_book::DEX_LEVELS),
                spread_bps: args.dex_spread_bps,
                step_bps: args.dex_step_bps,
                level_notional,
            },
            dex_max_deviation_pct: args.dex_max_deviation_pct,
        })
    } else {
        None
    };
    let input = BufReader::new(tokio::io::stdin());
    let config = runtime::RunConfig {
        balance,
        heartbeat: runtime::HEARTBEAT_PERIOD,
        fixtures_dir: args.fixtures.clone(),
        live,
    };
    let result = rt.block_on(runtime::run(input, tokio::io::stdout(), config));
    // tokio reads stdin on a blocking thread that cannot be interrupted; do not wait for it.
    rt.shutdown_background();
    match result {
        Ok(()) => {
            info!("engine stopped");
            ExitCode::SUCCESS
        }
        Err(err) => {
            error!(%err, "engine stopped");
            ExitCode::FAILURE
        }
    }
}

/// `engine synth`: generates a fixture, writes it, reads it back to check that it passes
/// fixture validation, and logs a summary. Writes nothing to stdout.
fn synth_fixture(args: &SynthArgs) -> ExitCode {
    let config = SynthConfig {
        seed: args.seed,
        duration_ms: TimeMs::from(args.duration) * 60_000,
        start_ms: args.start,
        symbols: args.symbols.clone(),
    };
    info!(
        out = %args.out.display(),
        seed = config.seed,
        duration_min = args.duration,
        start_ms = config.start_ms,
        symbols = ?config.symbols.iter().map(|s| s.symbol()).collect::<Vec<_>>(),
        "generating synthetic fixture"
    );
    let lines = synth::synth(&config);
    let bytes = match write_and_verify(&args.out, &lines) {
        Ok(bytes) => bytes,
        Err(err) => {
            error!(%err, "engine synth failed");
            return ExitCode::FAILURE;
        }
    };
    info!(
        out = %args.out.display(),
        lines = lines.len(),
        bytes,
        "fixture written and verified"
    );
    for s in synth::stats(&lines) {
        let (low, high) = s.trade_range.map_or((0, 0), |(low, high)| (low.0, high.0));
        info!(
            symbol = %s.symbol,
            trades = s.trades,
            snapshots = s.snapshots,
            deltas = s.deltas,
            low_ticks = low,
            high_ticks = high,
            "symbol summary"
        );
    }
    ExitCode::SUCCESS
}

/// Creates the parent directory, writes `lines`, and reads the file back through fixture
/// validation. Returns the file size in bytes.
fn write_and_verify(path: &Path, lines: &[FixtureLine]) -> Result<u64, String> {
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent).map_err(|source| {
            FixtureError::Io {
                action: "create directory",
                path: parent.to_path_buf(),
                source,
            }
            .to_string()
        })?;
    }
    write_fixture(path, lines).map_err(|err| err.to_string())?;
    let read = read_fixture(path).map_err(|err| format!("written fixture is invalid: {err}"))?;
    if read != lines {
        return Err("written fixture does not read back to the generated lines".into());
    }
    let meta = fs::metadata(path).map_err(|source| {
        FixtureError::Io {
            action: "read metadata of",
            path: path.to_path_buf(),
            source,
        }
        .to_string()
    })?;
    Ok(meta.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    #[test]
    fn cli_is_well_formed() {
        Cli::command().debug_assert();
    }

    #[test]
    fn run_defaults_to_replay_and_fixtures_dir() {
        let args = run_args(&["engine", "run"]);
        assert_eq!(args.mode, DataMode::Replay);
        assert_eq!(args.fixtures, PathBuf::from("fixtures"));

        let args = run_args(&["engine", "run", "--mode", "live", "--fixtures", "f"]);
        assert_eq!(args.mode, DataMode::Live);
        assert_eq!(args.fixtures, PathBuf::from("f"));
    }

    #[test]
    fn run_venue_defaults_to_backpack_and_accepts_both() {
        assert_eq!(run_args(&["engine", "run"]).venue, VenueArg::Backpack);
        let args = run_args(&["engine", "run", "--mode", "live", "--venue", "coinbase"]);
        assert_eq!(args.venue, VenueArg::Coinbase);
        assert_eq!(protocol::Venue::from(args.venue), protocol::Venue::Coinbase);
        let args = run_args(&["engine", "run", "--venue", "backpack"]);
        assert_eq!(protocol::Venue::from(args.venue), protocol::Venue::Backpack);
        assert!(Cli::try_parse_from(["engine", "run", "--venue", "kraken"]).is_err());
    }

    #[test]
    fn run_balance_flags_default_and_validate() {
        let args = run_args(&["engine", "run"]);
        assert_eq!(args.starting_balance, 100_000);
        assert_eq!(args.balance_slippage_bps, 100);
        let args = run_args(&[
            "engine",
            "run",
            "--starting-balance",
            "2500",
            "--balance-slippage-bps",
            "0",
        ]);
        assert_eq!(
            (args.starting_balance, args.balance_slippage_bps),
            (2_500, 0)
        );
        for argv in [
            ["engine", "run", "--starting-balance", "999"],
            ["engine", "run", "--starting-balance", "100000001"],
            ["engine", "run", "--balance-slippage-bps", "10001"],
        ] {
            assert!(Cli::try_parse_from(argv).is_err(), "{argv:?}");
        }
    }

    #[test]
    fn missing_subcommand_or_bad_mode_is_an_error() {
        assert!(Cli::try_parse_from(["engine"]).is_err());
        assert!(Cli::try_parse_from(["engine", "run", "--mode", "paper"]).is_err());
    }

    fn run_args(argv: &[&str]) -> RunArgs {
        match Cli::try_parse_from(argv).unwrap().command {
            CliCommand::Run(args) => args,
            other => panic!("expected run, got {other:?}"),
        }
    }

    fn synth_args(argv: &[&str]) -> SynthArgs {
        match Cli::try_parse_from(argv).unwrap().command {
            CliCommand::Synth(args) => args,
            other => panic!("expected synth, got {other:?}"),
        }
    }

    #[test]
    fn synth_defaults() {
        let args = synth_args(&["engine", "synth", "--out", "fixtures/demo.jsonl"]);
        assert_eq!(args.out, PathBuf::from("fixtures/demo.jsonl"));
        assert_eq!(args.seed, 42);
        assert_eq!(args.duration, 120);
        assert_eq!(args.start, 1_798_761_600_000);
        assert_eq!(args.symbols, SynthSymbol::ALL);
    }

    #[test]
    fn synth_flags_override_the_defaults() {
        let args = synth_args(&[
            "engine",
            "synth",
            "--out",
            "x.jsonl",
            "--seed",
            "7",
            "--duration",
            "5",
            "--start",
            "0",
            "--symbols",
            "SOL-USD,btc",
        ]);
        assert_eq!(args.seed, 7);
        assert_eq!(args.duration, 5);
        assert_eq!(args.start, 0);
        assert_eq!(args.symbols, [SynthSymbol::Sol, SynthSymbol::Btc]);
    }

    fn record_args(argv: &[&str]) -> RecordArgs {
        match Cli::try_parse_from(argv).unwrap().command {
            CliCommand::Record(args) => args,
            other => panic!("expected record, got {other:?}"),
        }
    }

    #[test]
    fn record_defaults() {
        let args = record_args(&["engine", "record", "--out", "fixtures/live.jsonl"]);
        assert_eq!(args.venue, VenueArg::Backpack);
        assert_eq!(args.symbols, ["BTC-USD", "ETH-USD", "SOL-USD"]);
        assert_eq!(args.out, PathBuf::from("fixtures/live.jsonl"));
        assert_eq!(args.duration, 300);
        assert_eq!(args.max_messages, None);
        assert!(!args.force);
    }

    #[test]
    fn record_flags_override_the_defaults() {
        let args = record_args(&[
            "engine",
            "record",
            "--venue",
            "coinbase",
            "--symbols",
            "sol,BTC-USD",
            "--out",
            "x.jsonl",
            "--duration",
            "10",
            "--max-messages",
            "50",
            "--force",
        ]);
        assert_eq!(args.venue, VenueArg::Coinbase);
        assert_eq!(args.symbols, ["SOL-USD", "BTC-USD"]);
        assert_eq!(args.duration, 10);
        assert_eq!(args.max_messages, Some(50));
        assert!(args.force);
    }

    #[test]
    fn record_rejects_bad_arguments() {
        for argv in [
            &["engine", "record"][..],
            &["engine", "record", "--out", "x", "--venue", "kraken"],
            &["engine", "record", "--out", "x", "--symbols", "NOPE-USD"],
            &["engine", "record", "--out", "x", "--duration", "0"],
            &["engine", "record", "--out", "x", "--max-messages", "0"],
        ] {
            assert!(Cli::try_parse_from(argv).is_err(), "{argv:?}");
        }
        let err = Cli::try_parse_from(["engine", "record", "--out", "x", "--symbols", "NOPE"])
            .unwrap_err()
            .to_string();
        assert!(err.contains("unknown symbol"), "{err}");
    }

    #[test]
    fn synth_rejects_bad_arguments() {
        for argv in [
            &["engine", "synth"][..],
            &["engine", "synth", "--out", "x", "--duration", "0"],
            &["engine", "synth", "--out", "x", "--seed", "-1"],
            &["engine", "synth", "--out", "x", "--start", "-5"],
            &["engine", "synth", "--out", "x", "--symbols", "NOPE-USD"],
        ] {
            assert!(Cli::try_parse_from(argv).is_err(), "{argv:?}");
        }
    }
}
