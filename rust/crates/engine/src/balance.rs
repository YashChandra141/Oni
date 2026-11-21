//! Paper balance model (design "Paper balance and the insufficient-balance check", Req 16).
//! Pure: no I/O, no clock, integers only.
//!
//! All amounts are [`Money`] units (10^-10 USD) held in `i128`. Every operation is checked: an
//! overflow is a [`BalanceError`], never a wrap.
//!
//! - `fee(n) = n × fee_bps / 10000`, toward zero.
//! - The fill price `p'` of an order is its reference price moved by the slippage allowance:
//!   rounded up for a buy, down for a sell, and at least one tick ([`slipped_price`]).
//! - Buy of `q` lots with `pos` held and signed cost basis `B`: covered lots
//!   `c = min(q, max(0, −pos))`, released basis `b_c = |B| × c / |pos|` (toward zero) and
//!   `RF = N(q, p') + fee(N(q, p')) − 2·b_c`.
//! - Sell of `q` lots: closed lots `k = min(q, max(0, pos))`, new short lots `u = q − k` and
//!   `RF = fee(N(q, p')) + N(u, p') − N(k, p')`.
//! - `Free_Balance = Paper_Balance − 2 × Short_Basis − Reserved`.
//! - `Equity = Paper_Balance + Σ N(Mark, pos)`.

use std::fmt;

use protocol::{Instrument, Price, Qty, Side, notional};

/// Money units per USD (`MONEY_DECIMALS` = 10).
pub const MONEY_PER_USD: i128 = 10_000_000_000;
/// Basis points per unit.
pub const BPS_DENOM: i128 = 10_000;
/// Default Starting_Balance in USD (Req 16.2).
pub const DEFAULT_STARTING_BALANCE_USD: u32 = 100_000;
/// Smallest accepted Starting_Balance in USD.
pub const MIN_STARTING_BALANCE_USD: u32 = 1_000;
/// Largest accepted Starting_Balance in USD.
pub const MAX_STARTING_BALANCE_USD: u32 = 100_000_000;
/// Default fee rate in basis points.
pub const DEFAULT_FEE_BPS: u32 = 5;
/// Default slippage allowance in basis points (Req 16.6).
pub const DEFAULT_SLIPPAGE_BPS: u32 = 100;

/// Why a balance computation failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BalanceError {
    /// A checked integer operation failed.
    Overflow,
    /// The quantity or price is not positive, or the position and basis disagree in sign.
    InvalidInput,
}

impl fmt::Display for BalanceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Overflow => f.write_str("balance arithmetic overflow"),
            Self::InvalidInput => f.write_str("invalid input for balance computation"),
        }
    }
}

impl std::error::Error for BalanceError {}

/// Balance settings of an engine run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BalanceConfig {
    /// Starting_Balance in Money units.
    pub starting_balance: i128,
    /// Fee rate in basis points.
    pub fee_bps: u32,
    /// Slippage allowance in basis points.
    pub slippage_bps: u32,
}

impl Default for BalanceConfig {
    fn default() -> Self {
        Self {
            starting_balance: i128::from(DEFAULT_STARTING_BALANCE_USD) * MONEY_PER_USD,
            fee_bps: DEFAULT_FEE_BPS,
            slippage_bps: DEFAULT_SLIPPAGE_BPS,
        }
    }
}

impl BalanceConfig {
    /// A config with `usd` whole USD as the Starting_Balance (1,000 to 100,000,000).
    pub fn with_starting_usd(self, usd: u32) -> Result<Self, BalanceError> {
        if !(MIN_STARTING_BALANCE_USD..=MAX_STARTING_BALANCE_USD).contains(&usd) {
            return Err(BalanceError::InvalidInput);
        }
        Ok(Self {
            starting_balance: i128::from(usd) * MONEY_PER_USD,
            ..self
        })
    }
}

fn checked(value: Option<i128>) -> Result<i128, BalanceError> {
    value.ok_or(BalanceError::Overflow)
}

/// Exact notional of `lots` at `price`, in Money units.
fn leg(inst: &Instrument, price: Price, lots: i64) -> Result<i128, BalanceError> {
    if lots == 0 {
        return Ok(0);
    }
    notional(inst, price, Qty(lots))
        .map(|m| i128::from(m.0))
        .map_err(|_| BalanceError::Overflow)
}

/// `fee(n) = n × fee_bps / 10000`, toward zero.
pub fn fee(notional: i128, fee_bps: u32) -> Result<i128, BalanceError> {
    Ok(checked(notional.checked_mul(i128::from(fee_bps)))? / BPS_DENOM)
}

/// The reference price moved by `slippage_bps`: up (rounded up) for a buy, down (rounded down)
/// for a sell, and at least one tick.
pub fn slipped_price(
    reference: Price,
    side: Side,
    slippage_bps: u32,
) -> Result<Price, BalanceError> {
    if reference.0 <= 0 {
        return Err(BalanceError::InvalidInput);
    }
    let base = i128::from(reference.0);
    let bps = i128::from(slippage_bps);
    let adjusted = match side {
        Side::Buy => {
            let num = checked(base.checked_mul(BPS_DENOM + bps))?;
            checked(num.checked_add(BPS_DENOM - 1))? / BPS_DENOM
        }
        Side::Sell => {
            let num = checked(base.checked_mul((BPS_DENOM - bps).max(0)))?;
            num / BPS_DENOM
        }
    };
    let adjusted = adjusted.max(1);
    i64::try_from(adjusted)
        .map(Price)
        .map_err(|_| BalanceError::Overflow)
}

/// Required_Funds of an order at fill price `fill_price` (already slipped), against a position
/// of `pos` signed lots with signed cost basis `basis` (negative for a short).
pub fn required_funds_at(
    inst: &Instrument,
    side: Side,
    qty: Qty,
    fill_price: Price,
    pos: i64,
    basis: i128,
    fee_bps: u32,
) -> Result<i128, BalanceError> {
    if qty.0 <= 0 || fill_price.0 <= 0 || (pos == 0 && basis != 0) {
        return Err(BalanceError::InvalidInput);
    }
    let n = leg(inst, fill_price, qty.0)?;
    let f = fee(n, fee_bps)?;
    match side {
        Side::Buy => {
            let covered = qty.0.min(pos.saturating_neg().max(0));
            let released = if covered > 0 {
                let abs_pos = i128::from(pos).abs();
                let basis_abs = basis.checked_abs().ok_or(BalanceError::Overflow)?;
                checked(basis_abs.checked_mul(i128::from(covered)))? / abs_pos
            } else {
                0
            };
            let gross = checked(n.checked_add(f))?;
            checked(gross.checked_sub(checked(released.checked_mul(2))?))
        }
        Side::Sell => {
            let closed = qty.0.min(pos.max(0));
            let opened = qty.0 - closed;
            let sum = checked(f.checked_add(leg(inst, fill_price, opened)?))?;
            checked(sum.checked_sub(leg(inst, fill_price, closed)?))
        }
    }
}

/// Required_Funds of an order from its reference price: applies the slippage allowance first.
pub fn required_funds(
    inst: &Instrument,
    side: Side,
    qty: Qty,
    reference: Price,
    pos: i64,
    basis: i128,
    config: &BalanceConfig,
) -> Result<i128, BalanceError> {
    let fill_price = slipped_price(reference, side, config.slippage_bps)?;
    required_funds_at(inst, side, qty, fill_price, pos, basis, config.fee_bps)
}

/// Short_Basis: the sum of `|basis|` over positions `(qty, basis)` with a negative quantity.
pub fn short_basis(positions: impl IntoIterator<Item = (i64, i128)>) -> Result<i128, BalanceError> {
    positions
        .into_iter()
        .filter(|(qty, _)| *qty < 0)
        .try_fold(0_i128, |acc, (_, basis)| {
            checked(acc.checked_add(basis.checked_abs().ok_or(BalanceError::Overflow)?))
        })
}

/// Reserved_Balance: the sum of `max(0, RF)` over the funds required by the open orders.
pub fn reserved_total(required: impl IntoIterator<Item = i128>) -> Result<i128, BalanceError> {
    required
        .into_iter()
        .try_fold(0_i128, |acc, rf| checked(acc.checked_add(rf.max(0))))
}

/// `Free_Balance = Paper_Balance − 2 × Short_Basis − Reserved`. May be negative.
pub fn free_balance(
    paper_balance: i128,
    short_basis: i128,
    reserved: i128,
) -> Result<i128, BalanceError> {
    let after_basis = checked(paper_balance.checked_sub(checked(short_basis.checked_mul(2))?))?;
    checked(after_basis.checked_sub(reserved))
}

/// `Equity = Paper_Balance + Σ N(Mark, pos)` over `(instrument, mark, signed lots)`.
pub fn equity<'a>(
    paper_balance: i128,
    holdings: impl IntoIterator<Item = (&'a Instrument, Price, i64)>,
) -> Result<i128, BalanceError> {
    holdings
        .into_iter()
        .try_fold(paper_balance, |acc, (inst, mark, pos)| {
            checked(acc.checked_add(leg(inst, mark, pos)?))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::instrument;

    // BTC-USD: one tick × one lot is one Money unit.
    fn btc() -> &'static Instrument {
        instrument("BTC-USD").unwrap()
    }

    #[test]
    fn fee_rounds_toward_zero() {
        assert_eq!(fee(10_000, 5), Ok(5));
        assert_eq!(fee(1_999, 5), Ok(0));
        assert_eq!(fee(-1_999, 5), Ok(0));
        assert_eq!(fee(i128::MAX, 5), Err(BalanceError::Overflow));
    }

    #[test]
    fn slipped_price_rounds_against_the_trader() {
        assert_eq!(slipped_price(Price(1_000), Side::Buy, 100), Ok(Price(1_010)));
        assert_eq!(slipped_price(Price(1_000), Side::Sell, 100), Ok(Price(990)));
        // 101 × 1.01 = 102.01 rounds up; 101 × 0.99 = 99.99 rounds down.
        assert_eq!(slipped_price(Price(101), Side::Buy, 100), Ok(Price(103)));
        assert_eq!(slipped_price(Price(101), Side::Sell, 100), Ok(Price(99)));
        assert_eq!(slipped_price(Price(7), Side::Buy, 0), Ok(Price(7)));
        // At least one tick.
        assert_eq!(slipped_price(Price(1), Side::Sell, 100), Ok(Price(1)));
        assert_eq!(slipped_price(Price(5), Side::Sell, 10_000), Ok(Price(1)));
        assert_eq!(slipped_price(Price(5), Side::Sell, 20_000), Ok(Price(1)));
        for bad in [Price(0), Price(-1)] {
            assert_eq!(
                slipped_price(bad, Side::Buy, 0),
                Err(BalanceError::InvalidInput)
            );
        }
        assert_eq!(
            slipped_price(Price(i64::MAX), Side::Buy, 100),
            Err(BalanceError::Overflow)
        );
    }

    #[test]
    fn buy_from_flat_costs_notional_plus_fee() {
        // N = 10 × 1000 = 10_000, fee = 5.
        let rf = required_funds_at(btc(), Side::Buy, Qty(10), Price(1_000), 0, 0, 5);
        assert_eq!(rf, Ok(10_005));
    }

    #[test]
    fn buy_that_covers_a_short_releases_double_the_basis() {
        // Short 10 with basis -10_000. Buy 4 at 900: N = 3_600, fee 1, b_c = 4_000.
        let rf = required_funds_at(btc(), Side::Buy, Qty(4), Price(900), -10, -10_000, 5);
        assert_eq!(rf, Ok(3_601 - 8_000));
        // Buy 15: covers 10 (b_c = 10_000), buys 5 extra. N = 13_500, fee 6.
        let rf = required_funds_at(btc(), Side::Buy, Qty(15), Price(900), -10, -10_000, 5);
        assert_eq!(rf, Ok(13_506 - 20_000));
        // Released basis rounds toward zero: 1_001 × 1 / 3 = 333.
        let rf = required_funds_at(btc(), Side::Buy, Qty(1), Price(10), -3, -1_001, 0);
        assert_eq!(rf, Ok(10 - 666));
    }

    #[test]
    fn buy_on_a_long_ignores_the_basis() {
        let rf = required_funds_at(btc(), Side::Buy, Qty(2), Price(100), 5, 500, 0);
        assert_eq!(rf, Ok(200));
    }

    #[test]
    fn sell_closing_a_long_frees_funds() {
        // Close 4 of 10 at 1000: fee on 4_000 is 2, RF = 2 − 4_000.
        let rf = required_funds_at(btc(), Side::Sell, Qty(4), Price(1_000), 10, 9_000, 5);
        assert_eq!(rf, Ok(2 - 4_000));
        // Exactly the whole long.
        let rf = required_funds_at(btc(), Side::Sell, Qty(10), Price(1_000), 10, 9_000, 0);
        assert_eq!(rf, Ok(-10_000));
    }

    #[test]
    fn sell_opening_a_short_requires_its_notional() {
        // From flat: u = 10, k = 0, RF = fee + N = 5 + 10_000.
        let rf = required_funds_at(btc(), Side::Sell, Qty(10), Price(1_000), 0, 0, 5);
        assert_eq!(rf, Ok(10_005));
        // Cross: long 3, sell 10 at 1000: k = 3, u = 7. RF = 5 + 7_000 − 3_000.
        let rf = required_funds_at(btc(), Side::Sell, Qty(10), Price(1_000), 3, 2_000, 5);
        assert_eq!(rf, Ok(5 + 7_000 - 3_000));
        // Growing an existing short.
        let rf = required_funds_at(btc(), Side::Sell, Qty(1), Price(100), -2, -200, 0);
        assert_eq!(rf, Ok(100));
    }

    #[test]
    fn required_funds_applies_the_slippage_allowance() {
        let config = BalanceConfig::default();
        // Buy at reference 1_000 fills at 1_010 for 10 lots: N = 10_100, fee 5.
        let rf = required_funds(btc(), Side::Buy, Qty(10), Price(1_000), 0, 0, &config);
        assert_eq!(rf, Ok(10_105));
        // Sell at reference 1_000 fills at 990: N = 9_900, fee 4.
        let rf = required_funds(btc(), Side::Sell, Qty(10), Price(1_000), 0, 0, &config);
        assert_eq!(rf, Ok(9_904));
    }

    #[test]
    fn required_funds_rejects_bad_input_and_overflow() {
        let bad = [
            required_funds_at(btc(), Side::Buy, Qty(0), Price(1), 0, 0, 5),
            required_funds_at(btc(), Side::Buy, Qty(1), Price(0), 0, 0, 5),
            required_funds_at(btc(), Side::Sell, Qty(-1), Price(1), 0, 0, 5),
            required_funds_at(btc(), Side::Buy, Qty(1), Price(1), 0, 100, 5),
        ];
        for result in bad {
            assert_eq!(result, Err(BalanceError::InvalidInput));
        }
        let big = required_funds_at(btc(), Side::Buy, Qty(i64::MAX), Price(i64::MAX), 0, 0, 5);
        assert_eq!(big, Err(BalanceError::Overflow));
        let huge_basis = required_funds_at(btc(), Side::Buy, Qty(2), Price(1), -2, i128::MIN, 5);
        assert_eq!(huge_basis, Err(BalanceError::Overflow));
        assert_eq!(BalanceError::Overflow.to_string(), "balance arithmetic overflow");
    }

    #[test]
    fn short_basis_sums_absolute_basis_of_shorts_only() {
        assert_eq!(short_basis([]), Ok(0));
        assert_eq!(short_basis([(5, 500), (-2, -300), (-1, -50), (0, 0)]), Ok(350));
        assert_eq!(
            short_basis([(-1, i128::MAX), (-1, -1)]),
            Err(BalanceError::Overflow)
        );
        assert_eq!(short_basis([(-1, i128::MIN)]), Err(BalanceError::Overflow));
    }

    #[test]
    fn reserved_counts_only_positive_required_funds() {
        assert_eq!(reserved_total([]), Ok(0));
        assert_eq!(reserved_total([100, -500, 40]), Ok(140));
        assert_eq!(reserved_total([i128::MAX, 1]), Err(BalanceError::Overflow));
    }

    #[test]
    fn free_balance_boundaries() {
        assert_eq!(free_balance(1_000, 100, 300), Ok(500));
        assert_eq!(free_balance(1_000, 500, 0), Ok(0));
        assert_eq!(free_balance(1_000, 600, 0), Ok(-200));
        assert_eq!(free_balance(0, 0, 1), Ok(-1));
        assert_eq!(free_balance(0, i128::MAX, 0), Err(BalanceError::Overflow));
        assert_eq!(free_balance(i128::MIN, 1, 0), Err(BalanceError::Overflow));
        assert_eq!(free_balance(i128::MIN, 0, 1), Err(BalanceError::Overflow));
    }

    #[test]
    fn equity_marks_longs_and_shorts() {
        let inst = btc();
        assert_eq!(equity(1_000, []), Ok(1_000));
        assert_eq!(equity(1_000, [(inst, Price(10), 5)]), Ok(1_050));
        assert_eq!(equity(1_000, [(inst, Price(10), -5)]), Ok(950));
        assert_eq!(
            equity(1_000, [(inst, Price(10), 5), (inst, Price(20), -1)]),
            Ok(1_030)
        );
        assert_eq!(
            equity(i128::MAX, [(inst, Price(1), 1)]),
            Err(BalanceError::Overflow)
        );
        assert_eq!(
            equity(0, [(inst, Price(i64::MAX), i64::MAX)]),
            Err(BalanceError::Overflow)
        );
    }

    #[test]
    fn config_defaults_and_starting_balance_range() {
        let config = BalanceConfig::default();
        assert_eq!(config.starting_balance, 100_000 * MONEY_PER_USD);
        assert_eq!((config.fee_bps, config.slippage_bps), (5, 100));
        assert_eq!(
            config.with_starting_usd(1_000).map(|c| c.starting_balance),
            Ok(1_000 * MONEY_PER_USD)
        );
        assert!(config.with_starting_usd(100_000_000).is_ok());
        assert_eq!(config.with_starting_usd(999), Err(BalanceError::InvalidInput));
        assert_eq!(
            config.with_starting_usd(100_000_001),
            Err(BalanceError::InvalidInput)
        );
        // The largest allowed balance fits Money (i64).
        assert!(i64::try_from(100_000_000 * MONEY_PER_USD).is_ok());
    }

    fn outcome(result: Result<i128, BalanceError>) -> String {
        match result {
            Ok(v) => v.to_string(),
            Err(BalanceError::Overflow) => "overflow".to_owned(),
            Err(BalanceError::InvalidInput) => "invalid_input".to_owned(),
        }
    }

    /// Writes `shared/balance-vectors.json`, which `server/src/risk/balance.test.ts` replays
    /// against the TS mirror (Req 16.5, 16.7, 16.10).
    #[test]
    fn writes_golden_vectors() {
        use serde_json::json;
        let config = BalanceConfig::default();
        let mut required = Vec::new();
        let symbols = ["BTC-USD", "SOL-USD", "XRP-USD", "BONK-USD"];
        let refs = [1_i64, 7, 101, 12_345, 6_800_000];
        let qtys = [1_i64, 3, 10, 15, 100_001];
        let positions: [(i64, i128); 5] = [(0, 0), (5, 500), (-3, -1_001), (-10, -10_000), (10, 9_000)];
        for sym in symbols {
            let Some(inst) = protocol::instrument(sym) else { continue };
            for (i, &reference) in refs.iter().enumerate() {
                for (j, &q) in qtys.iter().enumerate() {
                    let (pos, basis) = positions[(i + j) % positions.len()];
                    for side in [Side::Buy, Side::Sell] {
                        let rf = required_funds(inst, side, Qty(q), Price(reference), pos, basis, &config);
                        required.push(json!({
                            "symbol": sym,
                            "side": if side == Side::Buy { "buy" } else { "sell" },
                            "qty": q.to_string(),
                            "reference": reference.to_string(),
                            "pos": pos.to_string(),
                            "basis": basis.to_string(),
                            "fee_bps": config.fee_bps,
                            "slippage_bps": config.slippage_bps,
                            "expected": outcome(rf),
                        }));
                    }
                }
            }
        }
        // Error cases.
        if let Some(inst) = protocol::instrument("BTC-USD") {
            let bad = required_funds_at(inst, Side::Buy, Qty(0), Price(1), 0, 0, 5);
            required.push(json!({"symbol": "BTC-USD", "side": "buy", "qty": "0", "reference": "1",
                "pos": "0", "basis": "0", "fee_bps": 5, "slippage_bps": 0, "expected": outcome(bad)}));
        }
        let free: Vec<_> = [(1_000_i128, 100_i128, 300_i128), (1_000, 600, 0), (0, 0, 1), (5, 0, 0)]
            .iter()
            .map(|&(p, s, r)| {
                json!({"paper": p.to_string(), "short_basis": s.to_string(),
                    "reserved": r.to_string(), "expected": outcome(free_balance(p, s, r))})
            })
            .collect();
        let mut equities = Vec::new();
        if let (Some(btc), Some(sol)) = (protocol::instrument("BTC-USD"), protocol::instrument("SOL-USD")) {
            let cases: [(i128, Vec<(&str, i64, i64)>); 3] = [
                (1_000, vec![]),
                (1_000_000, vec![("BTC-USD", 10, 5), ("SOL-USD", 20, -1)]),
                (0, vec![("BTC-USD", 6_800_000, -3)]),
            ];
            for (paper, hs) in cases {
                let holdings = hs.iter().map(|&(s, mark, pos)| {
                    (if s == "BTC-USD" { btc } else { sol }, Price(mark), pos)
                });
                let result = equity(paper, holdings);
                let held: Vec<_> = hs
                    .iter()
                    .map(|&(s, mark, pos)| json!({"symbol": s, "mark": mark.to_string(), "pos": pos.to_string()}))
                    .collect();
                equities.push(json!({"paper": paper.to_string(), "holdings": held, "expected": outcome(result)}));
            }
        }
        let doc = json!({"required_funds": required, "free_balance": free, "equity": equities});
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../shared/balance-vectors.json");
        let text = serde_json::to_string_pretty(&doc).unwrap_or_default();
        assert!(!text.is_empty());
        std::fs::write(path, text + "\n").unwrap();
    }
}
