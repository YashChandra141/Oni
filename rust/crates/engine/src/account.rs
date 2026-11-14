//! Paper_Account (design §2 "Paper_Account", Req 13, 14). Pure: no I/O, no clock, integers only.
//!
//! Per symbol an account tracks a signed `qty` in lots, a signed `cost_basis` (the notional of
//! the open position in [`Money`] units, negative for shorts), and the `realized` P&L. All
//! arithmetic runs in `i128` with checked operations. A result that does not fit an `i64`
//! (the wire type of [`Money`]) is [`AccountError::Overflow`], and the account is left unchanged.
//!
//! Fill rules (Req 13.1, 13.2):
//! - A fill that opens a position or grows it adds its signed notional to the cost basis.
//! - A fill that reduces a position by `r` lots removes `cost_basis × r / |qty|` from the basis
//!   (i128, toward zero; the whole basis when the position closes) and adds
//!   `direction × (notional(fill, r) − |removed|)` to realized P&L, where `direction` is +1 for
//!   a long and −1 for a short position.
//! - A fill that crosses zero is split into a reducing part (`|qty|` lots) and an opening part
//!   (the rest), both at the fill price.
//! - The fee reduces realized P&L. For a crossing fill the reducing part carries
//!   `fee × reduce_qty / fill_qty` (toward zero) and the opening part carries the remainder, so
//!   the two shares always add up to the fee ([`split_fee`]).
//!
//! Because the basis is exact, a buy of `q` at `b` followed by a sell of `q` at `s` leaves a
//! flat position with realized P&L `(s − b) × q − fees` with no rounding (Req 13.5).
//!
//! Unrealized P&L is `notional(last, qty) − cost_basis` (Req 13.3). The average entry price is
//! `cost_basis / qty` at tick scale, rounded to the nearest tick (half away from zero); it is
//! for display only and never feeds back into P&L.

use std::collections::BTreeMap;
use std::fmt;

use protocol::{AccountId, Event, Instrument, Money, Price, Qty, Side, instrument, notional};

use crate::matcher::FillRecord;

/// Default cap on the number of Paper_Accounts (Req 14.5).
pub const DEFAULT_ACCOUNT_CAP: usize = 1_000;

/// Why a fill could not be applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccountError {
    /// A checked integer operation failed, or a result does not fit an `i64`.
    Overflow,
    /// The fill has a non-positive quantity or price, or a negative fee.
    InvalidFill,
    /// The fill names a symbol that is not in the instrument table.
    UnknownSymbol,
}

impl fmt::Display for AccountError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Overflow => f.write_str("paper account arithmetic overflow"),
            Self::InvalidFill => f.write_str("invalid fill for paper account"),
            Self::UnknownSymbol => f.write_str("fill for unknown symbol"),
        }
    }
}

impl std::error::Error for AccountError {}

/// The account cap is reached and the account does not exist yet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AccountLimit;

impl fmt::Display for AccountLimit {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("account limit reached")
    }
}

impl std::error::Error for AccountLimit {}

/// One account's position in one symbol.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PositionState {
    /// Signed quantity in lots; negative is short.
    pub qty: i64,
    /// Signed notional of the open position in Money units; zero when flat.
    pub cost_basis: i128,
    /// Realized P&L in Money units, net of fees.
    pub realized: i128,
}

fn checked(value: Option<i128>) -> Result<i128, AccountError> {
    value.ok_or(AccountError::Overflow)
}

fn to_i64(value: i128) -> Result<i64, AccountError> {
    i64::try_from(value).map_err(|_| AccountError::Overflow)
}

/// Notional of `lots` (signed) at `price`, in Money units.
fn leg_notional(inst: &Instrument, price: Price, lots: i128) -> Result<i128, AccountError> {
    let lots = to_i64(lots)?;
    notional(inst, price, Qty(lots))
        .map(|m| i128::from(m.0))
        .map_err(|_| AccountError::Overflow)
}

/// Splits a fill's fee between its reducing and opening parts: the reducing part gets
/// `fee × reduce / fill` rounded toward zero and the opening part the remainder, so the shares
/// add up to `fee`.
pub fn split_fee(fee: i128, reduce: i128, fill: i128) -> Result<(i128, i128), AccountError> {
    if fill <= 0 {
        return Err(AccountError::InvalidFill);
    }
    let share = checked(fee.checked_mul(reduce))? / fill;
    let rest = checked(fee.checked_sub(share))?;
    Ok((share, rest))
}

/// Applies one fill to one position and returns the new state. Pure: the input is not changed,
/// and an error leaves the caller's state as it was.
pub fn apply_to_position(
    inst: &Instrument,
    pos: PositionState,
    side: Side,
    price: Price,
    qty: Qty,
    fee: Money,
) -> Result<PositionState, AccountError> {
    if qty.0 <= 0 || price.0 <= 0 || fee.0 < 0 {
        return Err(AccountError::InvalidFill);
    }
    let fill_qty = i128::from(qty.0);
    let fill_dir: i128 = match side {
        Side::Buy => 1,
        Side::Sell => -1,
    };
    let held = i128::from(pos.qty);
    let held_dir = held.signum();
    let held_abs = held.abs();
    let (reduce, open) = if held != 0 && held_dir != fill_dir {
        let reduce = fill_qty.min(held_abs);
        (reduce, fill_qty - reduce)
    } else {
        (0, fill_qty)
    };
    let (fee_reduce, fee_open) = split_fee(i128::from(fee.0), reduce, fill_qty)?;

    let mut qty_now = held;
    let mut basis = pos.cost_basis;
    let mut realized = pos.realized;

    if reduce > 0 {
        let removed = if reduce == held_abs {
            basis
        } else {
            checked(basis.checked_mul(reduce))? / held_abs
        };
        let proceeds = leg_notional(inst, price, reduce)?;
        // `removed` has the sign of the position; its magnitude is the basis of the reduced lots.
        let removed_abs = checked(removed.checked_mul(held_dir))?;
        let gain = checked(held_dir.checked_mul(checked(proceeds.checked_sub(removed_abs))?))?;
        realized = checked(realized.checked_add(gain))?;
        realized = checked(realized.checked_sub(fee_reduce))?;
        basis = checked(basis.checked_sub(removed))?;
        qty_now = checked(qty_now.checked_add(checked(fill_dir.checked_mul(reduce))?))?;
    }
    if open > 0 {
        let leg = checked(leg_notional(inst, price, open)?.checked_mul(fill_dir))?;
        basis = checked(basis.checked_add(leg))?;
        realized = checked(realized.checked_sub(fee_open))?;
        qty_now = checked(qty_now.checked_add(checked(fill_dir.checked_mul(open))?))?;
    }
    if qty_now == 0 {
        basis = 0;
    }
    // Everything the events carry must fit an i64.
    to_i64(basis)?;
    to_i64(realized)?;
    Ok(PositionState {
        qty: to_i64(qty_now)?,
        cost_basis: basis,
        realized,
    })
}

/// Money units per (tick × lot) for the instrument.
fn unit(inst: &Instrument) -> Result<i128, AccountError> {
    leg_notional(inst, Price(1), 1)
}

/// One Paper_Account: positions by symbol. A symbol that was never traded has no entry.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PaperAccount {
    positions: BTreeMap<String, PositionState>,
}

impl PaperAccount {
    /// The position in `symbol`; flat if there is none.
    pub fn position(&self, symbol: &str) -> PositionState {
        self.positions.get(symbol).copied().unwrap_or_default()
    }

    /// True when the account has a non-zero position in `symbol`.
    pub fn is_open(&self, symbol: &str) -> bool {
        self.position(symbol).qty != 0
    }

    /// Applies a fill (Req 13.1, 13.2). On error the account is unchanged.
    pub fn apply_fill(&mut self, fill: &FillRecord) -> Result<(), AccountError> {
        let inst = instrument(&fill.symbol).ok_or(AccountError::UnknownSymbol)?;
        let next = apply_to_position(
            inst,
            self.position(&fill.symbol),
            fill.side,
            fill.price,
            fill.qty,
            fill.fee,
        )?;
        self.positions.insert(fill.symbol.clone(), next);
        Ok(())
    }

    /// Unrealized P&L: `notional(last, qty) − cost_basis` (Req 13.3). Zero for a flat position
    /// and when no trade price is known yet.
    pub fn mark(&self, symbol: &str, last: Option<Price>) -> Result<Money, AccountError> {
        let pos = self.position(symbol);
        let (Some(last), true) = (last, pos.qty != 0) else {
            return Ok(Money(0));
        };
        let inst = instrument(symbol).ok_or(AccountError::UnknownSymbol)?;
        let value = leg_notional(inst, last, i128::from(pos.qty))?;
        let unrealized = checked(value.checked_sub(pos.cost_basis))?;
        to_i64(unrealized).map(Money)
    }

    /// Average entry price: cost basis per lot at tick scale, rounded to the nearest tick (half
    /// away from zero). `None` when flat. Display only.
    pub fn avg_entry(&self, symbol: &str) -> Option<Price> {
        let pos = self.position(symbol);
        if pos.qty == 0 {
            return None;
        }
        let inst = instrument(symbol)?;
        let den = i128::from(pos.qty).abs().checked_mul(unit(inst).ok()?)?;
        let num = pos.cost_basis.abs();
        if den == 0 {
            return None;
        }
        let ticks = num.checked_mul(2)?.checked_add(den)? / den.checked_mul(2)?;
        i64::try_from(ticks).ok().map(Price)
    }

    /// The Position event for `symbol` (Req 13.4), flat if the account holds nothing there.
    pub fn position_event(
        &self,
        account_id: &AccountId,
        symbol: &str,
        last: Option<Price>,
    ) -> Result<Event, AccountError> {
        let pos = self.position(symbol);
        Ok(Event::Position {
            account_id: account_id.clone(),
            symbol: symbol.to_owned(),
            qty: Qty(pos.qty),
            avg_entry: self.avg_entry(symbol),
            realized: Money(to_i64(pos.realized)?),
            unrealized: self.mark(symbol, last)?,
        })
    }

    /// Flattens every position and zeroes all P&L (Req 14.3).
    pub fn reset(&mut self) {
        self.positions.clear();
    }
}

/// Every Paper_Account, by id, with a cap on how many may exist (Req 14.4, 14.5).
#[derive(Debug, Clone)]
pub struct Accounts {
    map: BTreeMap<AccountId, PaperAccount>,
    cap: usize,
}

impl Default for Accounts {
    fn default() -> Self {
        Self::new(DEFAULT_ACCOUNT_CAP)
    }
}

impl Accounts {
    pub fn new(cap: usize) -> Self {
        Self {
            map: BTreeMap::new(),
            cap,
        }
    }

    /// The account with this id, created flat on first use. A new account over the cap is
    /// refused; an existing account is always returned.
    pub fn get_or_create(&mut self, id: &AccountId) -> Result<&mut PaperAccount, AccountLimit> {
        if !self.map.contains_key(id) && self.map.len() >= self.cap {
            return Err(AccountLimit);
        }
        Ok(self.map.entry(id.clone()).or_default())
    }

    pub fn get(&self, id: &AccountId) -> Option<&PaperAccount> {
        self.map.get(id)
    }

    pub fn get_mut(&mut self, id: &AccountId) -> Option<&mut PaperAccount> {
        self.map.get_mut(id)
    }

    /// Number of accounts that exist.
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.map.len()
    }

    /// Accounts in `AccountId` order.
    pub fn iter(&self) -> impl Iterator<Item = (&AccountId, &PaperAccount)> {
        self.map.iter()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::OrderId;

    // BTC-USD: 2 price decimals + 8 qty decimals = 10, so one tick × one lot is one Money unit.
    const BTC: &str = "BTC-USD";

    fn acct(name: &str) -> AccountId {
        AccountId::new(name).unwrap()
    }

    fn fill(side: Side, price: i64, qty: i64, fee: i64) -> FillRecord {
        FillRecord {
            account_id: acct("guest"),
            order_id: OrderId::new("o-1").unwrap(),
            symbol: BTC.into(),
            side,
            price: Price(price),
            qty: Qty(qty),
            fee: Money(fee),
            ts: 0,
        }
    }

    fn apply(account: &mut PaperAccount, side: Side, price: i64, qty: i64, fee: i64) {
        account.apply_fill(&fill(side, price, qty, fee)).unwrap();
    }

    fn pos(account: &PaperAccount) -> (i64, i128, i128) {
        let p = account.position(BTC);
        (p.qty, p.cost_basis, p.realized)
    }

    #[test]
    fn open_long() {
        let mut a = PaperAccount::default();
        apply(&mut a, Side::Buy, 100, 10, 1);
        assert_eq!(pos(&a), (10, 1_000, -1));
        assert_eq!(a.avg_entry(BTC), Some(Price(100)));
    }

    #[test]
    fn add_to_long_uses_weighted_average() {
        let mut a = PaperAccount::default();
        apply(&mut a, Side::Buy, 100, 10, 0);
        apply(&mut a, Side::Buy, 110, 10, 0);
        assert_eq!(pos(&a), (20, 2_100, 0));
        assert_eq!(a.avg_entry(BTC), Some(Price(105)));
    }

    #[test]
    fn partial_reduce_then_full_close() {
        let mut a = PaperAccount::default();
        apply(&mut a, Side::Buy, 100, 10, 0);
        apply(&mut a, Side::Buy, 110, 10, 0);
        // Removed basis 2100 × 5 / 20 = 525; proceeds 600; gain 75; fee 2.
        apply(&mut a, Side::Sell, 120, 5, 2);
        assert_eq!(pos(&a), (15, 1_575, 73));
        // Close: whole basis 1575 against proceeds 1500.
        apply(&mut a, Side::Sell, 100, 15, 0);
        assert_eq!(pos(&a), (0, 0, -2));
        assert_eq!(a.avg_entry(BTC), None);
    }

    #[test]
    fn reduce_removes_basis_toward_zero() {
        let mut a = PaperAccount::default();
        apply(&mut a, Side::Buy, 100, 1, 0);
        apply(&mut a, Side::Buy, 101, 2, 0); // basis 302, qty 3
        // 302 × 1 / 3 = 100 (toward zero); proceeds 100; gain 0.
        apply(&mut a, Side::Sell, 100, 1, 0);
        assert_eq!(pos(&a), (2, 202, 0));
    }

    #[test]
    fn flip_long_to_short_splits_the_fee_by_quantity() {
        assert_eq!(split_fee(10, 10, 25), Ok((4, 6)));
        assert_eq!(split_fee(7, 10, 25), Ok((2, 5)));
        assert_eq!(split_fee(0, 10, 25), Ok((0, 0)));
        assert_eq!(split_fee(9, 0, 5), Ok((0, 9)));
        assert_eq!(split_fee(9, 5, 5), Ok((9, 0)));

        let mut a = PaperAccount::default();
        apply(&mut a, Side::Buy, 100, 10, 0);
        // Reduce 10 (basis 1000, proceeds 900: -100), open short 15 at 90 (basis -1350), fee 10.
        apply(&mut a, Side::Sell, 90, 25, 10);
        assert_eq!(pos(&a), (-15, -1_350, -110));
        assert_eq!(a.avg_entry(BTC), Some(Price(90)));
    }

    #[test]
    fn short_positions_are_symmetric() {
        let mut a = PaperAccount::default();
        apply(&mut a, Side::Sell, 100, 10, 0);
        assert_eq!(pos(&a), (-10, -1_000, 0));
        assert_eq!(a.avg_entry(BTC), Some(Price(100)));
        // Cover 4 at 90: removed -400, proceeds 360, gain +40.
        apply(&mut a, Side::Buy, 90, 4, 0);
        assert_eq!(pos(&a), (-6, -600, 40));
        // Cover 6 at 110: loss 60.
        apply(&mut a, Side::Buy, 110, 6, 0);
        assert_eq!(pos(&a), (0, 0, -20));
    }

    #[test]
    fn flip_short_to_long() {
        let mut a = PaperAccount::default();
        apply(&mut a, Side::Sell, 100, 10, 0);
        // Cover 10 at 90 (+100), open long 5 at 90 (basis 450).
        apply(&mut a, Side::Buy, 90, 15, 0);
        assert_eq!(pos(&a), (5, 450, 100));
    }

    #[test]
    fn round_trip_with_fees_is_exact() {
        // Req 13.5: (s - b) × q - fees = 100 × 3 - (960 + 975).
        let mut a = PaperAccount::default();
        apply(&mut a, Side::Buy, 6_400_000, 3, 960);
        apply(&mut a, Side::Sell, 6_500_000, 3, 975);
        assert_eq!(pos(&a), (0, 0, 298_065));
        // Short round trip: sell at 6.5M, buy back at 6.4M.
        let mut b = PaperAccount::default();
        apply(&mut b, Side::Sell, 6_500_000, 3, 975);
        apply(&mut b, Side::Buy, 6_400_000, 3, 960);
        assert_eq!(pos(&b), (0, 0, 298_065));
    }

    #[test]
    fn unrealized_follows_the_last_price() {
        let mut a = PaperAccount::default();
        assert_eq!(a.mark(BTC, Some(Price(100))), Ok(Money(0)));
        apply(&mut a, Side::Buy, 100, 10, 0);
        assert_eq!(a.mark(BTC, Some(Price(105))), Ok(Money(50)));
        assert_eq!(a.mark(BTC, Some(Price(95))), Ok(Money(-50)));
        assert_eq!(a.mark(BTC, None), Ok(Money(0)));

        let mut s = PaperAccount::default();
        apply(&mut s, Side::Sell, 100, 10, 0);
        assert_eq!(s.mark(BTC, Some(Price(95))), Ok(Money(50)));
        assert_eq!(s.mark(BTC, Some(Price(110))), Ok(Money(-100)));
    }

    #[test]
    fn avg_entry_rounds_to_the_nearest_tick() {
        let mut a = PaperAccount::default();
        apply(&mut a, Side::Buy, 100, 1, 0);
        apply(&mut a, Side::Buy, 101, 2, 0); // 302 / 3 = 100.67
        assert_eq!(a.avg_entry(BTC), Some(Price(101)));

        let mut b = PaperAccount::default();
        apply(&mut b, Side::Buy, 100, 1, 0);
        apply(&mut b, Side::Buy, 101, 1, 0); // 100.5 rounds up
        assert_eq!(b.avg_entry(BTC), Some(Price(101)));

        let mut c = PaperAccount::default();
        apply(&mut c, Side::Sell, 100, 1, 0);
        apply(&mut c, Side::Sell, 101, 2, 0); // short: positive price
        assert_eq!(c.avg_entry(BTC), Some(Price(101)));

        let mut d = PaperAccount::default();
        apply(&mut d, Side::Buy, 100, 3, 0);
        apply(&mut d, Side::Buy, 101, 1, 0); // 401 / 4 = 100.25
        assert_eq!(d.avg_entry(BTC), Some(Price(100)));
    }

    #[test]
    fn overflow_returns_an_error_and_changes_nothing() {
        let mut a = PaperAccount::default();
        let huge = fill(Side::Buy, i64::MAX, i64::MAX, 0);
        assert_eq!(a.apply_fill(&huge), Err(AccountError::Overflow));
        assert_eq!(a, PaperAccount::default());

        // Each fill fits, the summed basis does not.
        let big = 4_000_000_000_000_000_000;
        apply(&mut a, Side::Buy, big, 2, 0);
        let before = a.clone();
        assert_eq!(
            a.apply_fill(&fill(Side::Buy, big, 2, 0)),
            Err(AccountError::Overflow)
        );
        assert_eq!(a, before);
    }

    #[test]
    fn invalid_and_unknown_fills_are_refused() {
        let mut a = PaperAccount::default();
        for bad in [
            fill(Side::Buy, 100, 0, 0),
            fill(Side::Buy, 0, 1, 0),
            fill(Side::Buy, 100, 1, -1),
        ] {
            assert_eq!(a.apply_fill(&bad), Err(AccountError::InvalidFill));
        }
        let mut unknown = fill(Side::Buy, 100, 1, 0);
        unknown.symbol = "DOGE-USD".into();
        assert_eq!(a.apply_fill(&unknown), Err(AccountError::UnknownSymbol));
        assert_eq!(a, PaperAccount::default());
        assert_eq!(
            AccountError::Overflow.to_string(),
            "paper account arithmetic overflow"
        );
    }

    #[test]
    fn position_event_carries_all_fields() {
        let mut a = PaperAccount::default();
        apply(&mut a, Side::Buy, 100, 10, 3);
        let event = a.position_event(&acct("guest"), BTC, Some(Price(104))).unwrap();
        assert_eq!(
            event,
            Event::Position {
                account_id: acct("guest"),
                symbol: BTC.into(),
                qty: Qty(10),
                avg_entry: Some(Price(100)),
                realized: Money(-3),
                unrealized: Money(40),
            }
        );
    }

    #[test]
    fn reset_flattens_everything() {
        let mut a = PaperAccount::default();
        apply(&mut a, Side::Buy, 100, 10, 3);
        a.reset();
        assert_eq!(a, PaperAccount::default());
        let event = a.position_event(&acct("guest"), BTC, Some(Price(104))).unwrap();
        assert_eq!(
            event,
            Event::Position {
                account_id: acct("guest"),
                symbol: BTC.into(),
                qty: Qty(0),
                avg_entry: None,
                realized: Money(0),
                unrealized: Money(0),
            }
        );
    }

    #[test]
    fn accounts_are_created_lazily_up_to_the_cap() {
        let mut accounts = Accounts::new(2);
        assert_eq!(accounts.len(), 0);
        assert!(accounts.get(&acct("a")).is_none());
        assert!(accounts.get_or_create(&acct("a")).is_ok());
        assert!(accounts.get_or_create(&acct("b")).is_ok());
        assert_eq!(accounts.get_or_create(&acct("c")).err(), Some(AccountLimit));
        assert_eq!(accounts.len(), 2);
        // Existing accounts keep working at the cap.
        assert!(accounts.get_or_create(&acct("a")).is_ok());
        let ids: Vec<&str> = accounts.iter().map(|(id, _)| id.as_str()).collect();
        assert_eq!(ids, ["a", "b"]);
        assert_eq!(Accounts::default().cap, DEFAULT_ACCOUNT_CAP);
    }

    #[test]
    fn accounts_do_not_share_positions() {
        let mut accounts = Accounts::new(10);
        let mut f = fill(Side::Buy, 100, 5, 0);
        if let Ok(a) = accounts.get_or_create(&acct("a")) {
            a.apply_fill(&f).unwrap();
        }
        f.account_id = acct("b");
        assert!(accounts.get_or_create(&acct("b")).is_ok());
        let a = accounts.get(&acct("a")).unwrap();
        let b = accounts.get(&acct("b")).unwrap();
        assert_eq!(a.position(BTC).qty, 5);
        assert_eq!(b.position(BTC), PositionState::default());
    }
}

#[cfg(test)]
#[path = "account_properties.rs"]
mod properties;
