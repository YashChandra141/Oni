//! Synthetic_Book of a DEX pair (oni-terminal-v2 task 6.7, Req 12.1 to 12.5, 12.10, 12.11).
//!
//! Pure and integer-only. Around one price sample, bids go down and asks go up in whole ticks:
//! `bid_k = floor(sample * (20000 - S - 2kT) / 20000)` and
//! `ask_k = ceil(sample * (20000 + S + 2kT) / 20000)`, made strictly monotonic. Every level
//! holds `max(1, level_notional / notional_of_one_lot)` lots. The result depends only on the
//! arguments, so the same sample always builds the same book.

use protocol::{Instrument, Level, Money, Price, Qty, notional};

/// Default levels per side.
pub const DEX_LEVELS: usize = 10;
/// [`DEX_LEVELS`] as a `u32`, for the command line default.
pub const DEX_LEVELS_U32: u32 = 10;
/// Default full spread in bps (at least 1).
pub const DEX_SPREAD_BPS: i64 = 10;
/// Default price step between levels in bps.
pub const DEX_STEP_BPS: i64 = 5;
/// Default notional of one level: 25,000 USD in Money units (10^-10 USD).
pub const DEX_LEVEL_NOTIONAL: Money = Money(25_000 * 10_000_000_000);

/// Shape of a Synthetic_Book.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DexParams {
    pub levels: usize,
    pub spread_bps: i64,
    pub step_bps: i64,
    pub level_notional: Money,
}

impl Default for DexParams {
    fn default() -> Self {
        Self {
            levels: DEX_LEVELS,
            spread_bps: DEX_SPREAD_BPS,
            step_bps: DEX_STEP_BPS,
            level_notional: DEX_LEVEL_NOTIONAL,
        }
    }
}

/// Lots that fill `level_notional` at `price`, at least one.
fn level_qty(inst: &Instrument, price: Price, level_notional: Money) -> Qty {
    let one = notional(inst, price, Qty(1)).map_or(0, |m| m.0);
    if one <= 0 {
        return Qty(1);
    }
    Qty((level_notional.0 / one).max(1))
}

/// Builds `(bids, asks)`: bids best first (descending), asks best first (ascending).
pub fn build_synthetic_book(
    sample: Price,
    params: DexParams,
    inst: &Instrument,
) -> (Vec<Level>, Vec<Level>) {
    let mut bids: Vec<Level> = Vec::new();
    let mut asks: Vec<Level> = Vec::new();
    if sample.0 <= 0 {
        return (bids, asks);
    }
    let s = i128::from(sample.0);
    let spread = i128::from(params.spread_bps.max(1));
    let step = i128::from(params.step_bps.max(0));
    for k in 0..params.levels {
        let offset = spread + 2 * (k as i128) * step;
        let num = 20_000 - offset;
        if num <= 0 {
            break;
        }
        let mut bid = s * num / 20_000;
        if let Some(prev) = bids.last()
            && bid >= i128::from(prev.price.0)
        {
            bid = i128::from(prev.price.0) - 1;
        }
        let Ok(bid) = i64::try_from(bid) else { break };
        if bid < 1 {
            break;
        }
        bids.push(Level {
            price: Price(bid),
            qty: level_qty(inst, Price(bid), params.level_notional),
        });
    }
    for k in 0..params.levels {
        let offset = spread + 2 * (k as i128) * step;
        let mut ask = (s * (20_000 + offset) + 19_999) / 20_000;
        if k == 0
            && let Some(best_bid) = bids.first()
            && ask <= i128::from(best_bid.price.0)
        {
            ask = i128::from(best_bid.price.0) + 1;
        }
        if let Some(prev) = asks.last()
            && ask <= i128::from(prev.price.0)
        {
            ask = i128::from(prev.price.0) + 1;
        }
        let Ok(ask) = i64::try_from(ask) else { break };
        asks.push(Level {
            price: Price(ask),
            qty: level_qty(inst, Price(ask), params.level_notional),
        });
    }
    (bids, asks)
}
