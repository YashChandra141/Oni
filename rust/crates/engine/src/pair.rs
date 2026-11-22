//! State of one (venue, symbol) pair (oni-terminal-v2 task 6.1, Req 9.1, 9.2, 9.3, 9.4, 9.8).
//!
//! The core keys everything that a market stream changes by (venue, symbol), so several venues
//! can stream the same symbol at once without mixing books, last prices, candles, or
//! subscriptions. Candle rings live in [`crate::candles::VenueCandles`], one builder per venue.

use std::collections::{BTreeMap, BTreeSet};

use protocol::{Price, TimeMs, Timeframe};

use crate::book::OrderBook;
use crate::indicators::SymbolIndicators;
use crate::ticker::TickerThrottle;

/// One pair's book and its throttle state.
#[derive(Debug, Default)]
pub struct BookState {
    pub book: OrderBook,
    /// Market time of the last emitted Book event.
    pub last_emit_ts: Option<TimeMs>,
    /// The book changed since the last emitted Book event.
    pub dirty: bool,
}

/// Backfill progress of one timeframe of a pair. An absent timeframe has no state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackfillState {
    /// A request was queued and no result has arrived.
    InFlight,
    /// The history was merged; the key never requests again in this run.
    Done,
}

/// Everything the core keeps for one (venue, symbol).
#[derive(Debug, Default)]
pub struct PairState {
    pub book: BookState,
    /// Last trade (or DEX sample) price of this venue.
    pub last_price: Option<Price>,
    /// Market time of the latest message of this pair.
    pub last_ts: Option<TimeMs>,
    /// Indicators per timeframe, kept for every timeframe that has traded.
    pub indicators: BTreeMap<Timeframe, SymbolIndicators>,
    /// Subscribed timeframes.
    pub subscriptions: BTreeSet<Timeframe>,
    /// Backfill state per timeframe (live mode only).
    pub backfill: BTreeMap<Timeframe, BackfillState>,
    /// An active ticker subscription (Req 18.3).
    pub ticker_sub: bool,
    /// One Ticker24h per second of market time (Req 18.4).
    pub ticker_throttle: TickerThrottle,
}
