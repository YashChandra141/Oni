//! Ticker24h from the 1h bar series (design D9, Req 18.3, 18.4, 18.7). Pure: no I/O, no clock.
//!
//! The window is the 24 most recent hourly bars of a symbol, including the forming bar.
//! `open` is the first bar's open, `last` the last bar's close, `high` and `low` the extremes
//! over the window, `volume` the sum of the bar volumes. `change_bps` is
//! `(last - open) * 10000 / open` in i128 integer math, truncated toward zero. `partial` is true
//! with fewer than 24 bars. `window_ms` is the span the bars cover: the last bar's start plus one
//! hour, minus the first bar's start.
//!
//! The series is per symbol for now; task 6.1 keys it per (venue, symbol) and sets `volume` to
//! `None` for DEX pairs.

use std::collections::BTreeMap;

use protocol::{Bar, Qty, Ticker, TimeMs, Timeframe};

/// Bars in a full 24-hour window.
pub const WINDOW_BARS: usize = 24;
/// Minimum market time between two Ticker24h events of one symbol, in ms (Req 18.4).
pub const TICKER_INTERVAL_MS: TimeMs = 1_000;

/// A computed ticker and the span of time it covers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TickerStats {
    pub ticker: Ticker,
    pub window_ms: TimeMs,
}

/// The ticker of a 1h bar series (oldest first). `None` for an empty series, a non-positive
/// open, or arithmetic overflow.
pub fn compute(bars: &[Bar]) -> Option<TickerStats> {
    let start = bars.len().saturating_sub(WINDOW_BARS);
    let window = bars.get(start..)?;
    let first = window.first()?;
    let last = window.last()?;
    let mut high = first.high;
    let mut low = first.low;
    let mut volume: i64 = 0;
    for bar in window {
        high = high.max(bar.high);
        low = low.min(bar.low);
        volume = volume.checked_add(bar.volume.0)?;
    }
    if first.open.0 <= 0 {
        return None;
    }
    let diff = i128::from(last.close.0).checked_sub(i128::from(first.open.0))?;
    let bps = diff
        .checked_mul(10_000)?
        .checked_div(i128::from(first.open.0))?;
    let change_bps = i32::try_from(bps).ok()?;
    let hour = Timeframe::H1.millis();
    let window_ms = last
        .t
        .checked_add(hour)?
        .checked_sub(first.t)
        .filter(|w| *w >= 0)?;
    Some(TickerStats {
        ticker: Ticker {
            open: first.open,
            high,
            low,
            last: last.close,
            volume: Some(Qty(volume)),
            change_bps,
            partial: window.len() < WINDOW_BARS,
        },
        window_ms,
    })
}

/// Limits Ticker24h emission to one per symbol per 1 s of market time (Req 18.4).
#[derive(Debug, Default)]
pub struct TickerThrottle {
    last_emit: BTreeMap<String, TimeMs>,
}

impl TickerThrottle {
    /// True, and records `now`, when `symbol` has not emitted or the interval has passed.
    pub fn take(&mut self, symbol: &str, now: TimeMs) -> bool {
        let due = self
            .last_emit
            .get(symbol)
            .is_none_or(|last| now.saturating_sub(*last) >= TICKER_INTERVAL_MS);
        if due {
            self.last_emit.insert(symbol.to_owned(), now);
        }
        due
    }

    /// Forgets `symbol`, so its next emission is due at once.
    pub fn reset(&mut self, symbol: &str) {
        self.last_emit.remove(symbol);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::Price;

    const H: TimeMs = 3_600_000;

    fn bar(i: i64, open: i64, high: i64, low: i64, close: i64, vol: i64) -> Bar {
        Bar {
            t: i * H,
            open: Price(open),
            high: Price(high),
            low: Price(low),
            close: Price(close),
            volume: Qty(vol),
        }
    }

    fn flat(n: i64) -> Vec<Bar> {
        (0..n).map(|i| bar(i, 100, 110, 90, 100, 2)).collect()
    }

    #[test]
    fn empty_series_gives_none() {
        assert_eq!(compute(&[]), None);
    }

    #[test]
    fn partial_window() {
        let stats = compute(&flat(5)).unwrap();
        assert!(stats.ticker.partial);
        assert_eq!(stats.window_ms, 5 * H);
        assert_eq!(stats.ticker.volume, Some(Qty(10)));
    }

    #[test]
    fn full_window_uses_last_24_bars() {
        let mut bars = flat(30);
        bars[0] = bar(0, 1, 9_999, 1, 1, 1_000); // outside the window
        let stats = compute(&bars).unwrap();
        assert!(!stats.ticker.partial);
        assert_eq!(stats.window_ms, 24 * H);
        assert_eq!(stats.ticker.volume, Some(Qty(48)));
        assert_eq!(stats.ticker.high, Price(110));
        assert_eq!(stats.ticker.open, Price(100));
    }

    #[test]
    fn high_low_and_last() {
        let bars = vec![
            bar(0, 100, 120, 95, 105, 1),
            bar(1, 105, 150, 100, 110, 1),
            bar(2, 110, 115, 80, 112, 1),
        ];
        let t = compute(&bars).unwrap().ticker;
        assert_eq!((t.high, t.low, t.last), (Price(150), Price(80), Price(112)));
    }

    #[test]
    fn change_sign_and_truncation() {
        let up = [bar(0, 300, 300, 300, 301, 1)];
        assert_eq!(compute(&up).unwrap().ticker.change_bps, 33); // 33.33 -> 33
        let down = [bar(0, 300, 300, 299, 299, 1)];
        assert_eq!(compute(&down).unwrap().ticker.change_bps, -33); // toward zero
        assert_eq!(compute(&flat(1)).unwrap().ticker.change_bps, 0);
    }

    #[test]
    fn throttle_one_per_second() {
        let mut t = TickerThrottle::default();
        assert!(t.take("BTC-USD", 5_000));
        assert!(!t.take("BTC-USD", 5_999));
        assert!(t.take("ETH-USD", 5_100));
        assert!(t.take("BTC-USD", 6_000));
    }

    #[test]
    fn throttle_reset_makes_next_due() {
        let mut t = TickerThrottle::default();
        assert!(t.take("BTC-USD", 5_000));
        t.reset("BTC-USD");
        assert!(t.take("BTC-USD", 5_001));
    }
}
