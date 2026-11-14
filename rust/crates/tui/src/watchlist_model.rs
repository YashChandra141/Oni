//! Pure watchlist model (Req 27.3, 27.4) and the data-mode label of the status line (Req 44.7).
//!
//! No ratatui types and no App state. The same rules as `web/lib/watchlist.ts` and
//! `web/lib/status.ts`:
//!
//! - The symbols come from the `hello` instrument table when it has any, else BTC-USD, ETH-USD,
//!   and SOL-USD.
//! - Next and previous wrap. An unknown current symbol gives the first (next) or the last
//!   (previous) symbol; an empty list keeps the current symbol.
//! - The price direction holds until the price moves again: a quote keeps the last price and
//!   the last *different* price before it.

use protocol::client::{DataMode, InstrumentInfo};
use protocol::{Price, Timeframe, Venue};

use crate::chart_model::format_price;

/// The watchlist when `hello` has no instrument table (Req 27.3).
pub const DEFAULT_WATCHLIST: [&str; 3] = ["BTC-USD", "ETH-USD", "SOL-USD"];

/// The timeframe of the subscriptions that keep every watchlist symbol's trades flowing.
pub const WATCH_TIMEFRAME: Timeframe = Timeframe::M1;

/// Shown instead of a price before the first trade of a symbol.
pub const NO_PRICE: &str = "—";

/// The direction of the latest price change.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Up,
    Down,
    Flat,
}

/// The last trade price of one symbol and the last different price before it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WatchQuote {
    pub last: Price,
    /// The previous price that differs from `last`; `None` until the price first moves.
    pub prev: Option<Price>,
}

impl WatchQuote {
    /// The quote after the first trade of a symbol.
    pub fn new(price: Price) -> Self {
        Self {
            last: price,
            prev: None,
        }
    }

    /// Applies a trade price. A repeated price keeps the previous one, so the direction holds.
    pub fn update(&mut self, price: Price) {
        if price != self.last {
            self.prev = Some(self.last);
            self.last = price;
        }
    }

    /// The direction from the previous price to the last one.
    pub fn direction(&self) -> Direction {
        price_change(self.prev, Some(self.last))
    }
}

/// The default watchlist as owned strings.
pub fn default_watchlist() -> Vec<String> {
    DEFAULT_WATCHLIST.iter().map(|s| (*s).to_owned()).collect()
}

/// The watchlist symbols: the instrument table's symbols in table order (duplicates dropped)
/// when there are any, else [`DEFAULT_WATCHLIST`].
pub fn watchlist_symbols(instruments: &[InstrumentInfo]) -> Vec<String> {
    let mut symbols: Vec<String> = Vec::with_capacity(instruments.len());
    for instrument in instruments {
        if !symbols.contains(&instrument.symbol) {
            symbols.push(instrument.symbol.clone());
        }
    }
    if symbols.is_empty() {
        default_watchlist()
    } else {
        symbols
    }
}

/// The symbol after `current`, wrapping. An unknown `current` gives the first symbol.
pub fn next_symbol(current: &str, list: &[String]) -> String {
    let next = match list.iter().position(|s| s == current) {
        Some(i) => list.get((i + 1) % list.len()),
        None => list.first(),
    };
    next.cloned().unwrap_or_else(|| current.to_owned())
}

/// The symbol before `current`, wrapping. An unknown `current` gives the last symbol.
pub fn prev_symbol(current: &str, list: &[String]) -> String {
    let prev = match list.iter().position(|s| s == current) {
        Some(0) | None => list.last(),
        Some(i) => list.get(i - 1),
    };
    prev.cloned().unwrap_or_else(|| current.to_owned())
}

/// The direction from `prev` to `last`; `Flat` when either is missing or they are equal.
pub fn price_change(prev: Option<Price>, last: Option<Price>) -> Direction {
    match (prev, last) {
        (Some(prev), Some(last)) if last > prev => Direction::Up,
        (Some(prev), Some(last)) if last < prev => Direction::Down,
        _ => Direction::Flat,
    }
}

/// The venue's display name. Backpack's USDC pairs are shown as USD, so it carries "(USDC)".
/// Same text as `venueName` in `web/lib/status.ts`.
pub fn venue_name(venue: Venue) -> &'static str {
    match venue {
        Venue::Backpack => "Backpack (USDC)",
        Venue::Coinbase => "Coinbase",
    }
}

/// `REPLAY`, or `LIVE · <venue>`, or `LIVE` when the venue is unknown (Req 44.7). Same text as
/// `modeLabel` in `web/lib/status.ts`.
pub fn venue_label(venue: Option<Venue>, data_mode: DataMode) -> String {
    match (data_mode, venue) {
        (DataMode::Replay, _) => "REPLAY".to_owned(),
        (DataMode::Live, Some(venue)) => format!("LIVE · {}", venue_name(venue)),
        (DataMode::Live, None) => "LIVE".to_owned(),
    }
}

/// The base asset of a symbol: `BTC` for `BTC-USD`. A symbol without `-` is returned whole.
pub fn short_symbol(symbol: &str) -> &str {
    symbol.split('-').next().unwrap_or(symbol)
}

/// The last price with two decimals, or [`NO_PRICE`] before the first trade.
pub fn price_text(quote: Option<&WatchQuote>) -> String {
    quote.map_or_else(|| NO_PRICE.to_owned(), |q| format_price(q.last))
}

/// One segment of the narrow watchlist strip: `BTC 64000.00`.
pub fn strip_segment(symbol: &str, quote: Option<&WatchQuote>) -> String {
    format!("{} {}", short_symbol(symbol), price_text(quote))
}

/// True for the subscriptions the TUI opens at startup and keeps for the whole session: every
/// [`DEFAULT_WATCHLIST`] symbol at [`WATCH_TIMEFRAME`]. A chart switch never unsubscribes them,
/// so the watchlist prices stay live.
pub fn is_watch_key(symbol: &str, timeframe: Timeframe) -> bool {
    timeframe == WATCH_TIMEFRAME && DEFAULT_WATCHLIST.contains(&symbol)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list() -> Vec<String> {
        default_watchlist()
    }

    #[test]
    fn symbols_come_from_hello_else_the_defaults() {
        assert_eq!(watchlist_symbols(&[]), ["BTC-USD", "ETH-USD", "SOL-USD"]);
        assert_eq!(
            watchlist_symbols(&InstrumentInfo::all()),
            ["BTC-USD", "ETH-USD", "SOL-USD"]
        );
        let sol = InstrumentInfo {
            symbol: "SOL-USD".into(),
            short: "SOL".into(),
            price_decimals: 2,
            qty_decimals: 8,
        };
        let btc = InstrumentInfo {
            symbol: "BTC-USD".into(),
            short: "BTC".into(),
            ..sol.clone()
        };
        assert_eq!(
            watchlist_symbols(&[sol.clone(), btc, sol]),
            ["SOL-USD", "BTC-USD"]
        );
    }

    // Req 27.4
    #[test]
    fn next_and_prev_wrap() {
        let l = list();
        assert_eq!(next_symbol("BTC-USD", &l), "ETH-USD");
        assert_eq!(next_symbol("ETH-USD", &l), "SOL-USD");
        assert_eq!(next_symbol("SOL-USD", &l), "BTC-USD");
        assert_eq!(prev_symbol("BTC-USD", &l), "SOL-USD");
        assert_eq!(prev_symbol("SOL-USD", &l), "ETH-USD");
        assert_eq!(prev_symbol("ETH-USD", &l), "BTC-USD");
    }

    #[test]
    fn unknown_current_and_empty_lists() {
        let l = list();
        assert_eq!(next_symbol("DOGE-USD", &l), "BTC-USD");
        assert_eq!(prev_symbol("DOGE-USD", &l), "SOL-USD");
        assert_eq!(next_symbol("BTC-USD", &[]), "BTC-USD");
        assert_eq!(prev_symbol("BTC-USD", &[]), "BTC-USD");
        let one = vec!["ETH-USD".to_owned()];
        assert_eq!(next_symbol("ETH-USD", &one), "ETH-USD");
        assert_eq!(prev_symbol("ETH-USD", &one), "ETH-USD");
    }

    #[test]
    fn price_change_directions() {
        assert_eq!(price_change(Some(Price(1)), Some(Price(2))), Direction::Up);
        assert_eq!(
            price_change(Some(Price(2)), Some(Price(1))),
            Direction::Down
        );
        assert_eq!(
            price_change(Some(Price(2)), Some(Price(2))),
            Direction::Flat
        );
        assert_eq!(price_change(None, Some(Price(2))), Direction::Flat);
        assert_eq!(price_change(Some(Price(2)), None), Direction::Flat);
        assert_eq!(price_change(None, None), Direction::Flat);
    }

    #[test]
    fn quote_direction_holds_until_the_price_moves() {
        let mut q = WatchQuote::new(Price(100));
        assert_eq!(q.direction(), Direction::Flat);
        q.update(Price(101));
        assert_eq!((q.last, q.prev), (Price(101), Some(Price(100))));
        assert_eq!(q.direction(), Direction::Up);
        // The same price again keeps the direction.
        q.update(Price(101));
        assert_eq!(q.direction(), Direction::Up);
        q.update(Price(99));
        assert_eq!(q.direction(), Direction::Down);
        assert_eq!(q.prev, Some(Price(101)));
    }

    // Req 44.7: the same strings as web/lib/status.ts.
    #[test]
    fn venue_labels_match_the_web() {
        assert_eq!(venue_label(None, DataMode::Replay), "REPLAY");
        assert_eq!(
            venue_label(Some(Venue::Backpack), DataMode::Replay),
            "REPLAY"
        );
        assert_eq!(
            venue_label(Some(Venue::Backpack), DataMode::Live),
            "LIVE · Backpack (USDC)"
        );
        assert_eq!(
            venue_label(Some(Venue::Coinbase), DataMode::Live),
            "LIVE · Coinbase"
        );
        assert_eq!(venue_label(None, DataMode::Live), "LIVE");
    }

    #[test]
    fn strip_segments_and_price_text() {
        assert_eq!(short_symbol("BTC-USD"), "BTC");
        assert_eq!(short_symbol("SOLUSD"), "SOLUSD");
        assert_eq!(price_text(None), "—");
        let q = WatchQuote::new(Price(6_400_000));
        assert_eq!(price_text(Some(&q)), "64000.00");
        assert_eq!(strip_segment("BTC-USD", Some(&q)), "BTC 64000.00");
        assert_eq!(strip_segment("ETH-USD", None), "ETH —");
    }

    #[test]
    fn watch_keys_are_the_default_symbols_at_1m() {
        assert!(is_watch_key("BTC-USD", Timeframe::M1));
        assert!(is_watch_key("SOL-USD", Timeframe::M1));
        assert!(!is_watch_key("BTC-USD", Timeframe::M5));
        assert!(!is_watch_key("DOGE-USD", Timeframe::M1));
    }

    #[test]
    fn a_full_cycle_returns_to_the_start() {
        let l = list();
        for start in &l {
            let mut s = start.clone();
            for _ in 0..l.len() {
                s = next_symbol(&s, &l);
            }
            assert_eq!(&s, start);
            assert_eq!(&prev_symbol(&next_symbol(start, &l), &l), start);
        }
    }
}
