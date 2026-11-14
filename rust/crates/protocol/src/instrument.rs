//! Instrument table: tick and lot sizes per symbol (Req 4.1).
//!
//! Tick and lot sizes are powers of ten. A tick is 10^-price_decimals USD and a lot is
//! 10^-qty_decimals base units. The values are verified against Coinbase product metadata in
//! Task 7.

use crate::error::ProtocolError;
use crate::num::{Money, Price, Qty};

/// Tick and lot definition for one tradable symbol.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Instrument {
    /// Full symbol, e.g. `BTC-USD`.
    pub symbol: &'static str,
    /// Short symbol accepted by the command parser, e.g. `BTC`.
    pub short: &'static str,
    /// Tick size is 10^-price_decimals USD.
    pub price_decimals: u32,
    /// Lot size is 10^-qty_decimals units of the base asset.
    pub qty_decimals: u32,
}

impl Instrument {
    /// The factor 10^(MONEY_DECIMALS - price_decimals - qty_decimals) that converts
    /// ticks × lots into [`Money`] units.
    fn money_scale(&self) -> Result<i128, ProtocolError> {
        self.price_decimals
            .checked_add(self.qty_decimals)
            .and_then(|decimals| crate::num::MONEY_DECIMALS.checked_sub(decimals))
            .and_then(|exp| 10_i128.checked_pow(exp))
            .ok_or(ProtocolError::InvalidInstrument(self.symbol))
    }
}

/// Every symbol the system trades.
pub static INSTRUMENTS: &[Instrument] = &[
    Instrument {
        symbol: "BTC-USD",
        short: "BTC",
        price_decimals: 2,
        qty_decimals: 8,
    },
    Instrument {
        symbol: "ETH-USD",
        short: "ETH",
        price_decimals: 2,
        qty_decimals: 8,
    },
    Instrument {
        symbol: "SOL-USD",
        short: "SOL",
        price_decimals: 2,
        qty_decimals: 8,
    },
];

/// Looks up an instrument by its full symbol, e.g. `BTC-USD`.
pub fn instrument(symbol: &str) -> Option<&'static Instrument> {
    INSTRUMENTS.iter().find(|i| i.symbol == symbol)
}

/// Exact notional value of `qty` lots at `price` ticks, in [`Money`] units.
///
/// The product is computed in `i128`. A result that does not fit in `i64` is
/// [`ProtocolError::Overflow`], never a wrap.
pub fn notional(instrument: &Instrument, price: Price, qty: Qty) -> Result<Money, ProtocolError> {
    let scale = instrument.money_scale()?;
    let value = i128::from(price.0)
        .checked_mul(i128::from(qty.0))
        .and_then(|v| v.checked_mul(scale))
        .ok_or(ProtocolError::Overflow("notional"))?;
    i64::try_from(value)
        .map(Money)
        .map_err(|_| ProtocolError::Overflow("notional"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn btc() -> &'static Instrument {
        instrument("BTC-USD").unwrap()
    }

    #[test]
    fn table_defines_the_three_symbols() {
        let symbols: Vec<&str> = INSTRUMENTS.iter().map(|i| i.symbol).collect();
        assert_eq!(symbols, ["BTC-USD", "ETH-USD", "SOL-USD"]);
        for i in INSTRUMENTS {
            assert_eq!(i.price_decimals, 2);
            assert_eq!(i.qty_decimals, 8);
            assert!(i.money_scale().is_ok(), "{}", i.symbol);
            assert_eq!(instrument(i.symbol), Some(i));
        }
    }

    #[test]
    fn lookup_rejects_unknown_and_short_symbols() {
        assert_eq!(instrument("DOGE-USD"), None);
        assert_eq!(instrument("BTC"), None);
        assert_eq!(instrument("btc-usd"), None);
    }

    #[test]
    fn notional_is_exact() {
        // 0.1 BTC at $64,000.00 is $6,400 = 6400 × 10^10 Money units.
        let value = notional(btc(), Price(6_400_000), Qty(10_000_000)).unwrap();
        assert_eq!(value, Money(6_400 * 10_i64.pow(10)));
        // One lot at one tick is 10^-10 USD, the smallest Money unit.
        assert_eq!(notional(btc(), Price(1), Qty(1)).unwrap(), Money(1));
        // Short positions give a negative notional.
        assert_eq!(notional(btc(), Price(100), Qty(-3)).unwrap(), Money(-300));
    }

    #[test]
    fn notional_scales_when_decimals_are_below_money_decimals() {
        let coarse = Instrument {
            symbol: "TEST-USD",
            short: "TEST",
            price_decimals: 2,
            qty_decimals: 4,
        };
        // $1.00 × 1.0000 units = $1 = 10^10 Money units.
        let value = notional(&coarse, Price(100), Qty(10_000)).unwrap();
        assert_eq!(value, Money(10_i64.pow(10)));
    }

    #[test]
    fn notional_overflow_is_an_error() {
        let overflow = Err(ProtocolError::Overflow("notional"));
        assert_eq!(notional(btc(), Price(i64::MAX), Qty(2)), overflow);
        assert_eq!(notional(btc(), Price(i64::MIN), Qty(i64::MIN)), overflow);
    }

    #[test]
    fn notional_rejects_instruments_finer_than_money() {
        let fine = Instrument {
            symbol: "FINE-USD",
            short: "FINE",
            price_decimals: 6,
            qty_decimals: 6,
        };
        let result = notional(&fine, Price(1), Qty(1));
        assert_eq!(result, Err(ProtocolError::InvalidInstrument("FINE-USD")));
    }
}
