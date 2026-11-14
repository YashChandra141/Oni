//! `engine synth`: a seeded random-walk fixture generator (design §2 "Market feed"), so the
//! repository has replay data before any live recording (Req 6.1, 6.2).
//!
//! The generator is deterministic: the same [`SynthConfig`] always gives the same lines, on
//! every platform. It uses its own SplitMix64 generator, and its floating-point math is limited
//! to `+`, `-`, `*`, `/`, `sqrt`, `round`, and integer conversions, which IEEE 754 and Rust
//! define exactly. Floats only size the random steps; every emitted price and quantity is an
//! integer count of ticks or lots.
//!
//! For each symbol the generator writes:
//! - one `book_snapshot` at the start time with [`BOOK_DEPTH`] levels per side;
//! - a `book_delta` group every 500–2000 ms. Each group first moves the price with a
//!   geometric random walk, then shifts the book so the price stays between the best bid and the
//!   best ask, then (half the time) changes the size of one level near the top;
//! - a `trade` every 300–2300 ms at the current walk price.
//!
//! Book levels sit on a fixed grid of `level_step` ticks per symbol, and the spread is one grid
//! step. Moving the book by k grid steps costs 4·k deltas, so the grid is coarse enough that the
//! price usually stays inside one step between updates. That keeps the default two-hour fixture
//! under 8 MB. Deltas are ordered so that the best bid stays below the best ask after every
//! single delta, and neither side ever becomes empty. A zero `qty` removes a level; every other
//! `qty` is positive.
//!
//! Each symbol draws from its own stream, seeded from the seed and the symbol name, so a
//! symbol's lines do not depend on which other symbols are requested. The streams are merged
//! with a stable sort on `recv`: ties keep the order of [`SynthConfig::symbols`], then the
//! order in which the lines were generated. Every message's `ts` equals its `recv`.

use std::fmt;
use std::str::FromStr;

use protocol::{Level, Price, Qty, Side, TimeMs};

use super::MarketMsg;
use super::fixture::FixtureLine;

/// Seed used when `--seed` is not given.
pub const DEFAULT_SEED: u64 = 42;
/// Fixture length in minutes when `--duration` is not given. Two hours gives the 1h candles
/// content and keeps the default fixture under 8 MB.
pub const DEFAULT_DURATION_MINUTES: u32 = 120;
/// Start time when `--start` is not given: 2027-01-01T00:00:00Z. A constant, not the clock, so
/// the output is reproducible.
pub const DEFAULT_START_MS: TimeMs = 1_798_761_600_000;
/// Price levels per side of the generated book.
pub const BOOK_DEPTH: i64 = 20;

/// Gap between two trades of one symbol, in ms (inclusive range).
const TRADE_GAP_MS: (i64, i64) = (300, 2_300);
/// Gap between two book updates of one symbol, in ms (inclusive range).
const BOOK_GAP_MS: (i64, i64) = (500, 2_000);
/// Chance that a book update also changes the size of one level.
const SIZE_CHANGE_CHANCE: f64 = 0.5;
/// Chance that a trade is a buy after the price went up. After a fall it is 1 minus this.
const TREND_BUY_CHANCE: f64 = 0.65;
const ONE_HOUR_MS: f64 = 3_600_000.0;

/// What to generate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SynthConfig {
    pub seed: u64,
    /// Length of the fixture in ms. Lines have `start_ms <= recv < start_ms + duration_ms`.
    pub duration_ms: TimeMs,
    pub start_ms: TimeMs,
    /// Symbols to generate. Repeats are ignored.
    pub symbols: Vec<SynthSymbol>,
}

/// A symbol the generator has a price profile for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SynthSymbol {
    Btc,
    Eth,
    Sol,
}

impl SynthSymbol {
    /// Every symbol, in instrument table order.
    pub const ALL: [Self; 3] = [Self::Btc, Self::Eth, Self::Sol];

    /// The full symbol, e.g. `BTC-USD`.
    pub fn symbol(self) -> &'static str {
        self.profile().symbol
    }

    fn profile(self) -> &'static Profile {
        match self {
            Self::Btc => &BTC,
            Self::Eth => &ETH,
            Self::Sol => &SOL,
        }
    }
}

impl fmt::Display for SynthSymbol {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.symbol())
    }
}

/// A `--symbols` value that names no generated symbol.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownSymbol(String);

impl fmt::Display for UnknownSymbol {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut value: String = self.0.chars().take(40).collect();
        if value.len() < self.0.len() {
            value.push('…');
        }
        write!(
            f,
            "unknown symbol {value:?}, expected BTC-USD, ETH-USD, or SOL-USD"
        )
    }
}

impl std::error::Error for UnknownSymbol {}

impl FromStr for SynthSymbol {
    type Err = UnknownSymbol;

    /// Accepts the full symbol (`BTC-USD`) or the short one (`BTC`), in any case.
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|sym| {
                let p = sym.profile();
                p.symbol.eq_ignore_ascii_case(s) || p.short.eq_ignore_ascii_case(s)
            })
            .ok_or_else(|| UnknownSymbol(s.to_owned()))
    }
}

/// Price behaviour of one symbol. Prices are ticks (0.01 USD) and quantities lots (10⁻⁸).
#[derive(Debug, PartialEq)]
struct Profile {
    symbol: &'static str,
    short: &'static str,
    start_price: i64,
    /// Ticks between two book levels. The spread is one step.
    level_step: i64,
    /// Standard deviation of the one-hour relative price change.
    hourly_vol: f64,
    /// Trade size range in lots, drawn skewed toward small trades.
    trade_qty: (i64, i64),
    /// Top-level size range in lots. Deeper levels are larger.
    level_qty: (i64, i64),
}

static BTC: Profile = Profile {
    symbol: "BTC-USD",
    short: "BTC",
    start_price: 6_400_000,
    level_step: 1_000,
    hourly_vol: 0.0035,
    trade_qty: (10_000, 50_000_000),
    level_qty: (1_000_000, 150_000_000),
};

static ETH: Profile = Profile {
    symbol: "ETH-USD",
    short: "ETH",
    start_price: 320_000,
    level_step: 60,
    hourly_vol: 0.004,
    trade_qty: (100_000, 800_000_000),
    level_qty: (10_000_000, 2_500_000_000),
};

static SOL: Profile = Profile {
    symbol: "SOL-USD",
    short: "SOL",
    start_price: 15_000,
    level_step: 4,
    hourly_vol: 0.005,
    trade_qty: (1_000_000, 15_000_000_000),
    level_qty: (100_000_000, 50_000_000_000),
};

/// Generates the fixture lines for `config`. See the module docs.
pub fn synth(config: &SynthConfig) -> Vec<FixtureLine> {
    let end = config.start_ms.saturating_add(config.duration_ms.max(0));
    let mut lines = Vec::new();
    let mut done: Vec<SynthSymbol> = Vec::new();
    for &symbol in &config.symbols {
        if done.contains(&symbol) {
            continue;
        }
        done.push(symbol);
        SymbolSim::new(symbol.profile(), config.seed).run(config.start_ms, end, &mut lines);
    }
    // `sort_by_key` is stable, which gives the tie-break described in the module docs.
    lines.sort_by_key(|line| line.recv);
    lines
}

/// Message counts and trade price range of one symbol in a fixture.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SymbolStats {
    pub symbol: String,
    pub trades: usize,
    pub snapshots: usize,
    pub deltas: usize,
    /// Lowest and highest trade price, when the symbol has trades.
    pub trade_range: Option<(Price, Price)>,
}

/// Per-symbol statistics, in order of each symbol's first line.
pub fn stats(lines: &[FixtureLine]) -> Vec<SymbolStats> {
    let mut out: Vec<SymbolStats> = Vec::new();
    for line in lines {
        let symbol = line.msg.symbol();
        let index = match out.iter().position(|s| s.symbol == symbol) {
            Some(index) => index,
            None => {
                out.push(SymbolStats {
                    symbol: symbol.to_owned(),
                    trades: 0,
                    snapshots: 0,
                    deltas: 0,
                    trade_range: None,
                });
                out.len() - 1
            }
        };
        let Some(entry) = out.get_mut(index) else {
            continue;
        };
        match &line.msg {
            MarketMsg::Trade { price, .. } => {
                entry.trades += 1;
                entry.trade_range = Some(match entry.trade_range {
                    Some((low, high)) => (low.min(*price), high.max(*price)),
                    None => (*price, *price),
                });
            }
            MarketMsg::BookSnapshot { .. } => entry.snapshots += 1,
            MarketMsg::BookDelta { .. } => entry.deltas += 1,
        }
    }
    out
}

/// SplitMix64 (Steele, Lea, and Flood, 2014). Small, fast, and good enough for demo data. Not
/// for cryptography.
#[derive(Debug, Clone)]
struct SplitMix64 {
    state: u64,
}

impl SplitMix64 {
    fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in [0, 1), from the top 53 bits.
    fn unit(&mut self) -> f64 {
        const SCALE: f64 = 1.0 / 9_007_199_254_740_992.0; // 2^-53
        (self.next_u64() >> 11) as f64 * SCALE
    }

    /// Uniform in `lo..=hi` for `lo <= hi`. The modulo bias is negligible for the small ranges
    /// used here.
    fn between(&mut self, lo: i64, hi: i64) -> i64 {
        let span = hi.abs_diff(lo).saturating_add(1);
        lo.saturating_add_unsigned(self.next_u64() % span)
    }

    /// In `lo..=hi`, skewed toward `lo` by raising a uniform draw to `power`. Uses repeated
    /// multiplication because `powi` does not promise the same result on every platform.
    fn skewed(&mut self, lo: i64, hi: i64, power: u32) -> i64 {
        let u = self.unit();
        let scaled = (0..power).fold(1.0, |acc, _| acc * u);
        let offset = ((hi - lo) as f64 * scaled) as i64;
        lo.saturating_add(offset).min(hi)
    }

    fn chance(&mut self, p: f64) -> bool {
        self.unit() < p
    }

    /// Approximately standard normal: the Irwin–Hall sum of four uniforms, centred and scaled
    /// to variance 1. It needs no `ln` or `cos`, whose results can differ between platforms.
    fn normal(&mut self) -> f64 {
        let sum = self.unit() + self.unit() + self.unit() + self.unit();
        (sum - 2.0) * 3.0_f64.sqrt()
    }
}

/// FNV-1a hash of the symbol, mixed into the seed so every symbol has its own stream.
fn symbol_seed(seed: u64, symbol: &str) -> u64 {
    let mut hash: u64 = 0xCBF2_9CE4_8422_2325;
    for byte in symbol.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01B3);
    }
    seed ^ hash
}

/// Random walk and book state of one symbol.
struct SymbolSim {
    profile: &'static Profile,
    rng: SplitMix64,
    /// Current price in ticks.
    price: i64,
    /// Grid index of the best bid. Best bid is `index × step` and best ask `(index + 1) × step`,
    /// so `best bid <= price < best ask`.
    index: i64,
    /// Sign of the last price change: 1, 0, or -1.
    trend: i64,
    min_price: i64,
    max_price: i64,
}

impl SymbolSim {
    fn new(profile: &'static Profile, seed: u64) -> Self {
        let step = profile.level_step;
        // The lowest bid is (index - DEPTH + 1) × step, which is at least one step when
        // price >= DEPTH × step.
        let min_price = BOOK_DEPTH.saturating_mul(step);
        let max_price = profile.start_price.saturating_mul(1_000).max(min_price);
        let price = profile.start_price.clamp(min_price, max_price);
        Self {
            profile,
            rng: SplitMix64::new(symbol_seed(seed, profile.symbol)),
            price,
            index: price.div_euclid(step),
            trend: 0,
            min_price,
            max_price,
        }
    }

    fn run(mut self, start: TimeMs, end: TimeMs, out: &mut Vec<FixtureLine>) {
        out.push(self.snapshot(start));
        let mut last_walk = start;
        let mut next_book = self.after(start, BOOK_GAP_MS);
        let mut next_trade = self.after(start, TRADE_GAP_MS);
        loop {
            let now = next_book.min(next_trade);
            if now >= end {
                break;
            }
            if next_book <= next_trade {
                self.walk(now.saturating_sub(last_walk));
                last_walk = now;
                self.update_book(now, out);
                next_book = self.after(now, BOOK_GAP_MS);
            } else {
                out.push(self.trade(now));
                next_trade = self.after(now, TRADE_GAP_MS);
            }
        }
    }

    fn after(&mut self, now: TimeMs, (lo, hi): (i64, i64)) -> TimeMs {
        now.saturating_add(self.rng.between(lo, hi))
    }

    /// Moves the price by a relative step with standard deviation `hourly_vol × √(dt / 1 h)`,
    /// rounded to whole ticks and kept within `[min_price, max_price]`.
    fn walk(&mut self, dt_ms: i64) {
        let sigma = self.profile.hourly_vol * (dt_ms as f64 / ONE_HOUR_MS).sqrt();
        let change = (self.price as f64 * sigma * self.rng.normal()).round() as i64;
        let next = self
            .price
            .saturating_add(change)
            .clamp(self.min_price, self.max_price);
        self.trend = (next - self.price).signum();
        self.price = next;
    }

    fn update_book(&mut self, now: TimeMs, out: &mut Vec<FixtureLine>) {
        let target = self.price.div_euclid(self.profile.level_step);
        if target > self.index {
            self.shift_up(now, target, out);
        } else if target < self.index {
            self.shift_down(now, target, out);
        }
        self.index = target;
        if self.rng.chance(SIZE_CHANGE_CHANCE) {
            // Skewed toward the top of the book.
            let u = self.rng.unit();
            let depth = (u * u * BOOK_DEPTH as f64) as i64;
            let depth = depth.min(BOOK_DEPTH - 1);
            let (side, level) = if self.rng.chance(0.5) {
                (Side::Buy, self.index - depth)
            } else {
                (Side::Sell, self.index + 1 + depth)
            };
            let qty = self.level_qty(depth);
            out.push(self.delta(now, side, level, qty));
        }
    }

    /// Moves the book from best bid index `self.index` up to `j`. Asks are added above the book
    /// before the crossed asks are removed, and the crossed asks are removed before new bids are
    /// added, so every intermediate book is uncrossed with both sides non-empty.
    fn shift_up(&mut self, now: TimeMs, j: i64, out: &mut Vec<FixtureLine>) {
        let (i, w) = (self.index, BOOK_DEPTH);
        for a in (i + w + 1).max(j + 1)..=j + w {
            let qty = self.level_qty(a - (j + 1));
            out.push(self.delta(now, Side::Sell, a, qty));
        }
        for a in i + 1..=(i + w).min(j) {
            out.push(self.delta(now, Side::Sell, a, Qty(0)));
        }
        for b in (i + 1).max(j - w + 1)..=j {
            let qty = self.level_qty(j - b);
            out.push(self.delta(now, Side::Buy, b, qty));
        }
        for b in i - w + 1..=i.min(j - w) {
            out.push(self.delta(now, Side::Buy, b, Qty(0)));
        }
    }

    /// The mirror image of [`Self::shift_up`].
    fn shift_down(&mut self, now: TimeMs, j: i64, out: &mut Vec<FixtureLine>) {
        let (i, w) = (self.index, BOOK_DEPTH);
        for b in ((j - w + 1)..=(i - w).min(j)).rev() {
            let qty = self.level_qty(j - b);
            out.push(self.delta(now, Side::Buy, b, qty));
        }
        for b in ((j + 1).max(i - w + 1)..=i).rev() {
            out.push(self.delta(now, Side::Buy, b, Qty(0)));
        }
        for a in (j + 1..=i.min(j + w)).rev() {
            let qty = self.level_qty(a - (j + 1));
            out.push(self.delta(now, Side::Sell, a, qty));
        }
        for a in (i + 1).max(j + w + 1)..=i + w {
            out.push(self.delta(now, Side::Sell, a, Qty(0)));
        }
    }

    fn snapshot(&mut self, now: TimeMs) -> FixtureLine {
        let step = self.profile.level_step;
        let mut bids = Vec::new();
        let mut asks = Vec::new();
        for depth in 0..BOOK_DEPTH {
            let price = Price((self.index - depth).saturating_mul(step));
            let qty = self.level_qty(depth);
            bids.push(Level { price, qty });
        }
        for depth in 0..BOOK_DEPTH {
            let price = Price((self.index + 1 + depth).saturating_mul(step));
            let qty = self.level_qty(depth);
            asks.push(Level { price, qty });
        }
        let msg = MarketMsg::BookSnapshot {
            symbol: self.profile.symbol.to_owned(),
            bids,
            asks,
            ts: now,
        };
        FixtureLine { recv: now, msg }
    }

    fn trade(&mut self, now: TimeMs) -> FixtureLine {
        let buy_chance = match self.trend {
            1 => TREND_BUY_CHANCE,
            -1 => 1.0 - TREND_BUY_CHANCE,
            _ => 0.5,
        };
        let side = if self.rng.chance(buy_chance) {
            Side::Buy
        } else {
            Side::Sell
        };
        let (lo, hi) = self.profile.trade_qty;
        let msg = MarketMsg::Trade {
            symbol: self.profile.symbol.to_owned(),
            price: Price(self.price),
            qty: Qty(self.rng.skewed(lo, hi, 3)),
            side,
            ts: now,
        };
        FixtureLine { recv: now, msg }
    }

    fn delta(&self, now: TimeMs, side: Side, level: i64, qty: Qty) -> FixtureLine {
        let msg = MarketMsg::BookDelta {
            symbol: self.profile.symbol.to_owned(),
            side,
            price: Price(level.saturating_mul(self.profile.level_step)),
            qty,
            ts: now,
        };
        FixtureLine { recv: now, msg }
    }

    /// A positive level size. Level `depth` levels from the top is `(depth + 4) / 4` times
    /// larger on average than the top level.
    fn level_qty(&mut self, depth: i64) -> Qty {
        let (lo, hi) = self.profile.level_qty;
        let base = self.rng.skewed(lo, hi, 2);
        Qty(base.saturating_mul(depth + 4) / 4)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::feed::fixture::{encode_fixture_line, parse_fixture};
    use protocol::instrument;
    use std::collections::{BTreeMap, HashMap};

    const MINUTE_MS: i64 = 60_000;

    fn config(seed: u64, minutes: i64, symbols: &[SynthSymbol]) -> SynthConfig {
        SynthConfig {
            seed,
            duration_ms: minutes * MINUTE_MS,
            start_ms: DEFAULT_START_MS,
            symbols: symbols.to_vec(),
        }
    }

    fn default_config() -> SynthConfig {
        config(
            DEFAULT_SEED,
            i64::from(DEFAULT_DURATION_MINUTES),
            &SynthSymbol::ALL,
        )
    }

    fn encoded(lines: &[FixtureLine]) -> Vec<u8> {
        lines
            .iter()
            .map(|line| encode_fixture_line(line).unwrap())
            .collect::<String>()
            .into_bytes()
    }

    #[derive(Default)]
    struct Book {
        bids: BTreeMap<i64, i64>,
        asks: BTreeMap<i64, i64>,
    }

    impl Book {
        fn best_bid(&self) -> i64 {
            *self.bids.keys().next_back().unwrap()
        }

        fn best_ask(&self) -> i64 {
            *self.asks.keys().next().unwrap()
        }

        fn assert_uncrossed(&self, at: usize) {
            assert!(!self.bids.is_empty() && !self.asks.is_empty(), "line {at}");
            assert!(self.best_bid() < self.best_ask(), "line {at} crossed");
        }
    }

    #[test]
    fn splitmix64_matches_the_reference_output() {
        let mut rng = SplitMix64::new(0);
        assert_eq!(rng.next_u64(), 0xE220_A839_7B1D_CDAF);
        assert_eq!(rng.next_u64(), 0x6E78_9E6A_A1B9_65F4);
    }

    #[test]
    fn same_seed_gives_identical_lines_and_different_seed_differs() {
        let a = synth(&config(7, 30, &SynthSymbol::ALL));
        let b = synth(&config(7, 30, &SynthSymbol::ALL));
        let c = synth(&config(8, 30, &SynthSymbol::ALL));
        assert!(a.len() > 1_000);
        assert_eq!(a, b);
        assert_ne!(a, c);
    }

    #[test]
    fn a_symbol_stream_does_not_depend_on_the_other_symbols() {
        let all = synth(&config(3, 20, &SynthSymbol::ALL));
        let btc_only = synth(&config(3, 20, &[SynthSymbol::Btc]));
        let btc_in_all: Vec<_> = all
            .into_iter()
            .filter(|line| line.msg.symbol() == "BTC-USD")
            .collect();
        assert_eq!(btc_in_all, btc_only);
    }

    #[test]
    fn output_passes_fixture_validation() {
        let lines = synth(&config(DEFAULT_SEED, 30, &SynthSymbol::ALL));
        assert_eq!(parse_fixture(&encoded(&lines)).unwrap(), lines);
    }

    #[test]
    fn replayed_book_is_never_crossed_and_trades_sit_inside_the_spread() {
        for seed in [1, DEFAULT_SEED, 7_777] {
            let lines = synth(&config(seed, 60, &SynthSymbol::ALL));
            let mut books: HashMap<String, Book> = HashMap::new();
            for (at, line) in lines.iter().enumerate() {
                let book = books.entry(line.msg.symbol().to_owned()).or_default();
                match &line.msg {
                    MarketMsg::BookSnapshot { bids, asks, .. } => {
                        book.bids = bids.iter().map(|l| (l.price.0, l.qty.0)).collect();
                        book.asks = asks.iter().map(|l| (l.price.0, l.qty.0)).collect();
                        assert_eq!(book.bids.len(), BOOK_DEPTH as usize);
                        assert_eq!(book.asks.len(), BOOK_DEPTH as usize);
                        book.assert_uncrossed(at);
                    }
                    MarketMsg::BookDelta {
                        side, price, qty, ..
                    } => {
                        let levels = match side {
                            Side::Buy => &mut book.bids,
                            Side::Sell => &mut book.asks,
                        };
                        if qty.0 == 0 {
                            assert!(levels.remove(&price.0).is_some(), "line {at}: no level");
                        } else {
                            assert!(qty.0 > 0, "line {at}");
                            levels.insert(price.0, qty.0);
                        }
                        book.assert_uncrossed(at);
                    }
                    MarketMsg::Trade { price, .. } => {
                        assert!(book.best_bid() <= price.0, "line {at}");
                        assert!(price.0 < book.best_ask(), "line {at}");
                    }
                }
                assert!(book.bids.values().chain(book.asks.values()).all(|&q| q > 0));
            }
            assert_eq!(books.len(), 3);
            for book in books.values() {
                assert_eq!(book.bids.len(), BOOK_DEPTH as usize);
                assert_eq!(book.asks.len(), BOOK_DEPTH as usize);
            }
        }
    }

    #[test]
    fn prices_and_quantities_are_positive() {
        let lines = synth(&config(11, 60, &SynthSymbol::ALL));
        for line in &lines {
            match &line.msg {
                MarketMsg::Trade { price, qty, .. } => assert!(price.0 > 0 && qty.0 > 0),
                MarketMsg::BookSnapshot { bids, asks, .. } => {
                    for level in bids.iter().chain(asks) {
                        assert!(level.price.0 > 0 && level.qty.0 > 0);
                    }
                }
                MarketMsg::BookDelta { price, qty, .. } => assert!(price.0 > 0 && qty.0 >= 0),
            }
        }
    }

    #[test]
    fn recv_is_monotonic_within_the_window_and_ts_equals_recv() {
        let cfg = config(5, 45, &SynthSymbol::ALL);
        let lines = synth(&cfg);
        assert!(lines.windows(2).all(|w| w[0].recv <= w[1].recv));
        let end = cfg.start_ms + cfg.duration_ms;
        for line in &lines {
            assert_eq!(line.msg.ts(), line.recv);
            assert!(cfg.start_ms <= line.recv && line.recv < end);
        }
        // The three snapshots open the fixture, in the requested symbol order.
        let first: Vec<_> = lines.iter().take(3).map(|l| l.msg.symbol()).collect();
        assert_eq!(first, ["BTC-USD", "ETH-USD", "SOL-USD"]);
        assert!(
            lines
                .iter()
                .take(3)
                .all(|l| matches!(l.msg, MarketMsg::BookSnapshot { .. }))
        );
    }

    #[test]
    fn every_requested_symbol_appears_and_no_other() {
        let requested = [SynthSymbol::Sol, SynthSymbol::Btc, SynthSymbol::Sol];
        let lines = synth(&config(9, 10, &requested));
        let stats = stats(&lines);
        let symbols: Vec<_> = stats.iter().map(|s| s.symbol.as_str()).collect();
        assert_eq!(symbols, ["SOL-USD", "BTC-USD"]);
        for s in &stats {
            assert_eq!(s.snapshots, 1, "{}", s.symbol);
            assert!(s.trades > 0 && s.deltas > 0, "{s:?}");
        }
        assert_eq!(
            stats
                .iter()
                .map(|s| s.trades + s.snapshots + s.deltas)
                .sum::<usize>(),
            lines.len()
        );
    }

    #[test]
    fn zero_duration_gives_only_the_snapshots() {
        let lines = synth(&config(1, 0, &SynthSymbol::ALL));
        assert_eq!(lines.len(), 3);
        assert!(
            lines
                .iter()
                .all(|l| matches!(l.msg, MarketMsg::BookSnapshot { .. }))
        );
    }

    #[test]
    fn default_fixture_is_under_8_mb_and_every_hour_has_trades() {
        let cfg = default_config();
        let lines = synth(&cfg);
        let bytes = encoded(&lines).len();
        assert!(bytes < 8 * 1024 * 1024, "{bytes} bytes");
        let hours = (cfg.duration_ms / (60 * MINUTE_MS)) as usize;
        assert!(hours >= 2);
        for symbol in SynthSymbol::ALL {
            let mut per_hour = vec![0_usize; hours];
            for line in &lines {
                if let MarketMsg::Trade { symbol: s, .. } = &line.msg
                    && s == symbol.symbol()
                {
                    let hour = ((line.recv - cfg.start_ms) / (60 * MINUTE_MS)) as usize;
                    per_hour[hour] += 1;
                }
            }
            assert!(
                per_hour.iter().all(|&n| n > 1_000),
                "{symbol}: {per_hour:?}"
            );
        }
    }

    #[test]
    fn profiles_match_the_instrument_table() {
        for symbol in SynthSymbol::ALL {
            let p = symbol.profile();
            let instrument = instrument(p.symbol).unwrap();
            assert_eq!(instrument.short, p.short);
            assert_eq!((instrument.price_decimals, instrument.qty_decimals), (2, 8));
            assert!(p.level_step >= 1);
            assert!(p.start_price >= BOOK_DEPTH * p.level_step);
            assert!(0 < p.trade_qty.0 && p.trade_qty.0 < p.trade_qty.1);
            assert!(0 < p.level_qty.0 && p.level_qty.0 < p.level_qty.1);
        }
    }

    #[test]
    fn symbols_parse_from_full_or_short_names() {
        for symbol in SynthSymbol::ALL {
            assert_eq!(symbol.to_string().parse::<SynthSymbol>().unwrap(), symbol);
        }
        assert_eq!("btc".parse::<SynthSymbol>().unwrap(), SynthSymbol::Btc);
        assert_eq!("sol-usd".parse::<SynthSymbol>().unwrap(), SynthSymbol::Sol);
        let err = "DOGE-USD".parse::<SynthSymbol>().unwrap_err();
        assert_eq!(
            err.to_string(),
            r#"unknown symbol "DOGE-USD", expected BTC-USD, ETH-USD, or SOL-USD"#
        );
    }

    #[test]
    fn rng_helpers_stay_in_range() {
        let mut rng = SplitMix64::new(99);
        for _ in 0..10_000 {
            let u = rng.unit();
            assert!((0.0..1.0).contains(&u));
            assert!((300..=2_300).contains(&rng.between(300, 2_300)));
            assert!((5..=9).contains(&rng.skewed(5, 9, 3)));
        }
        assert_eq!(rng.between(4, 4), 4);
    }
}
