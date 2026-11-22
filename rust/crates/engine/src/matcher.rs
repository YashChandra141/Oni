//! Paper matcher (design §2 "Matcher", Req 11, 12, 14.6–14.8). Pure and deterministic: integer
//! math only, no I/O, no clock. Fill times are the market time the caller passes in.
//!
//! Orders: every accepted order gets an acceptance sequence number from a counter that only
//! grows. Open orders live in a `BTreeMap<u64, Order>` keyed by that number, so every pass walks
//! them in acceptance order across all accounts (Decision A9). Order ids are unique per matcher:
//! an id that is already open is rejected with `duplicate_order_id`, whatever the account. The
//! matcher treats account ids as opaque.
//!
//! Matching: a market order walks the opposite side of the book from the best level, one Fill
//! per level at that level's price (Req 11.1, 12.2). A limit buy fills only at asks at or below
//! its limit, a limit sell only at bids at or above it (Req 11.2, 11.3, 11.10). A remainder that
//! the book cannot fill stays open (Req 11.4, 12.1); a market remainder is retried on every
//! later market update of its symbol. A stop rests until the last trade price reaches or
//! crosses its stop price (buy: last >= stop, sell: last <= stop), then it becomes a market
//! order (Req 11.5). A stop already satisfied by the last price at placement triggers at once.
//!
//! Fills never change the market book (Req 14.8). To keep one displayed quantity from filling
//! twice, each matching pass keeps a consumed-quantity overlay (per side, per price). Orders
//! matched earlier in the pass (lower sequence) use displayed liquidity first. The overlay lives
//! for one pass only, so liquidity "regenerates" on the next book update or trade. That is a
//! simplification of a real venue, where our orders would not be visible in the book.
//!
//! Fees (Req 12.3): `fee = notional(fill) * fee_bps / 10_000`, computed in `i128` and truncated
//! toward zero, charged per fill as [`Money`]. The default rate is [`DEFAULT_FEE_BPS`] (5 bps).
//!
//! Event order for one order: `OrderAck{accepted}`, its Fills, then `OrderAck{filled}` once the
//! remaining quantity reaches zero. Every order's `filled + remaining == original` (Req 12.5):
//! `remaining_qty` is the only mutable quantity and `filled_qty()` is derived from it.
//!
//! Hook for Task 10.2: every call returns a [`MatchOutput`] whose `fills` list carries the data a
//! Paper_Account needs (account, symbol, side, price, qty, fee, ts), in the same order as the
//! Fill events.

use std::collections::BTreeMap;

use protocol::{
    AccountId, Event, Money, OrderId, OrderKind, OrderStatus, Price, Qty, Side, TimeMs, Venue,
    instrument, notional,
};

use crate::book::OrderBook;

/// Default fee rate in basis points of fill notional.
pub const DEFAULT_FEE_BPS: u32 = 5;

/// A request to place an order, as the core receives it from `PlaceOrder`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlaceRequest {
    pub account_id: AccountId,
    pub order_id: OrderId,
    pub symbol: String,
    pub side: Side,
    pub qty: Qty,
    pub kind: OrderKind,
}

/// One open order.
// `original_qty` is read only by `filled_qty`, which tests use.
#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Order {
    /// Acceptance sequence number; matching passes run in this order.
    pub seq: u64,
    pub account_id: AccountId,
    pub order_id: OrderId,
    pub symbol: String,
    pub side: Side,
    pub kind: OrderKind,
    pub original_qty: i64,
    pub remaining_qty: i64,
    /// A stop whose stop price was reached; it now matches as a market order.
    pub stop_triggered: bool,
}

impl Order {
    /// Quantity filled so far. `filled_qty() + remaining_qty == original_qty` always (Req 12.5).
    #[allow(dead_code)] // used by tests only
    pub fn filled_qty(&self) -> i64 {
        self.original_qty - self.remaining_qty
    }
}

/// Data of one fill, for the Paper_Account (Task 10.2).
// The account reads every field except `order_id` and `ts`; tests read them.
#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FillRecord {
    pub account_id: AccountId,
    pub order_id: OrderId,
    pub symbol: String,
    pub side: Side,
    pub price: Price,
    pub qty: Qty,
    pub fee: Money,
    pub ts: TimeMs,
}

/// Events of one matcher call, plus the fills they contain.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MatchOutput {
    pub events: Vec<Event>,
    pub fills: Vec<FillRecord>,
}

/// Quantity already used per price level during one matching pass.
#[derive(Debug, Default)]
struct Overlay {
    asks: BTreeMap<Price, i64>,
    bids: BTreeMap<Price, i64>,
}

/// Open orders and the matching rules.
#[derive(Debug)]
pub struct Matcher {
    fee_bps: i64,
    next_seq: u64,
    orders: BTreeMap<u64, Order>,
    /// The market venue stamped on every OrderAck, OrderRejected, and Fill. The engine has one
    /// market venue until the per-venue pairs of task 5.
    venue: Venue,
}

impl Default for Matcher {
    fn default() -> Self {
        Self::new(DEFAULT_FEE_BPS)
    }
}

impl Matcher {
    pub fn new(fee_bps: u32) -> Self {
        Self {
            fee_bps: i64::from(fee_bps),
            next_seq: 0,
            orders: BTreeMap::new(),
            venue: Venue::Replay,
        }
    }

    /// The same matcher, stamping `venue` on its events.
    pub fn with_venue(mut self, venue: Venue) -> Self {
        self.venue = venue;
        self
    }

    /// Number of open orders, all accounts.
    #[allow(dead_code)] // used by tests only
    pub fn open_count(&self) -> usize {
        self.orders.len()
    }

    /// Open orders of one account, in acceptance order.
    #[allow(dead_code)] // used by tests only
    pub fn open_orders_for<'a>(
        &'a self,
        account_id: &'a AccountId,
    ) -> impl Iterator<Item = &'a Order> + 'a {
        self.orders
            .values()
            .filter(move |o| &o.account_id == account_id)
    }

    /// Accepts an order and matches it at once against `book` (Req 11.1–11.6).
    ///
    /// `book` is the symbol's book (an empty book if none exists yet) and `last` the symbol's
    /// last trade price, if any.
    pub fn place(
        &mut self,
        req: PlaceRequest,
        book: &OrderBook,
        last: Option<Price>,
        ts: TimeMs,
    ) -> MatchOutput {
        let mut out = MatchOutput::default();
        let venue = self.venue;
        let reject = |out: &mut MatchOutput, req: &PlaceRequest, reason: &str| {
            out.events.push(Event::OrderRejected {
                account_id: req.account_id.clone(),
                venue,
                order_id: req.order_id.clone(),
                reason: reason.to_owned(),
            });
        };
        if instrument(&req.symbol).is_none() {
            reject(&mut out, &req, "unknown_symbol");
            return out;
        }
        if req.qty.0 <= 0 {
            reject(&mut out, &req, "invalid_quantity");
            return out;
        }
        let bad_price = match req.kind {
            OrderKind::Market => false,
            OrderKind::Limit { price } => price.0 <= 0,
            OrderKind::Stop { stop_price } => stop_price.0 <= 0,
        };
        if bad_price {
            reject(&mut out, &req, "invalid_price");
            return out;
        }
        if self.orders.values().any(|o| o.order_id == req.order_id) {
            reject(&mut out, &req, "duplicate_order_id");
            return out;
        }

        let seq = self.next_seq;
        self.next_seq = self.next_seq.saturating_add(1);
        let stop_triggered = match req.kind {
            OrderKind::Stop { stop_price } => stop_hit(req.side, stop_price, last),
            _ => false,
        };
        let mut order = Order {
            seq,
            account_id: req.account_id,
            order_id: req.order_id,
            symbol: req.symbol,
            side: req.side,
            kind: req.kind,
            original_qty: req.qty.0,
            remaining_qty: req.qty.0,
            stop_triggered,
        };
        out.events.push(ack(
            venue,
            &order.account_id,
            &order.order_id,
            OrderStatus::Accepted,
        ));
        let mut overlay = Overlay::default();
        let done = match_order(
            &mut order,
            book,
            &mut overlay,
            MatchParams {
                venue,
                fee_bps: self.fee_bps,
                ts,
            },
            &mut out,
        );
        if !done {
            self.orders.insert(seq, order);
        }
        out
    }

    /// Runs a matching pass for `symbol` after a book update or a trade: stops that the last
    /// price reached trigger first, then every open order of the symbol matches in sequence
    /// order against one shared overlay.
    pub fn on_market(
        &mut self,
        symbol: &str,
        book: &OrderBook,
        last: Option<Price>,
        ts: TimeMs,
    ) -> MatchOutput {
        let mut out = MatchOutput::default();
        let seqs: Vec<u64> = self
            .orders
            .iter()
            .filter(|(_, o)| o.symbol == symbol)
            .map(|(seq, _)| *seq)
            .collect();
        for seq in &seqs {
            if let Some(order) = self.orders.get_mut(seq)
                && let OrderKind::Stop { stop_price } = order.kind
                && !order.stop_triggered
                && stop_hit(order.side, stop_price, last)
            {
                order.stop_triggered = true;
            }
        }
        let params = MatchParams {
            venue: self.venue,
            fee_bps: self.fee_bps,
            ts,
        };
        let mut overlay = Overlay::default();
        for seq in seqs {
            let done = match self.orders.get_mut(&seq) {
                Some(order) => match_order(order, book, &mut overlay, params, &mut out),
                None => continue,
            };
            if done {
                self.orders.remove(&seq);
            }
        }
        out
    }

    /// Cancels one open order of `account_id` (Req 11.7). An order that is not open, or is open
    /// under another account, gives `OrderRejected{unknown_order}` for the requester and stays
    /// open (Req 11.9, 14.6). The reason does not reveal that the order exists elsewhere.
    pub fn cancel(&mut self, account_id: &AccountId, order_id: &OrderId) -> Vec<Event> {
        let found = self
            .orders
            .iter()
            .find(|(_, o)| &o.order_id == order_id && &o.account_id == account_id)
            .map(|(seq, _)| *seq);
        match found.and_then(|seq| self.orders.remove(&seq)) {
            Some(order) => vec![ack(
                self.venue,
                &order.account_id,
                &order.order_id,
                OrderStatus::Canceled,
            )],
            None => vec![Event::OrderRejected {
                account_id: account_id.clone(),
                venue: self.venue,
                order_id: order_id.clone(),
                reason: "unknown_order".to_owned(),
            }],
        }
    }

    /// Cancels every open order of `account_id`, in sequence order (Req 11.8, 14.7).
    pub fn cancel_all(&mut self, account_id: &AccountId) -> Vec<Event> {
        let seqs: Vec<u64> = self
            .orders
            .iter()
            .filter(|(_, o)| &o.account_id == account_id)
            .map(|(seq, _)| *seq)
            .collect();
        let venue = self.venue;
        seqs.into_iter()
            .filter_map(|seq| self.orders.remove(&seq))
            .map(|o| ack(venue, &o.account_id, &o.order_id, OrderStatus::Canceled))
            .collect()
    }
}

/// One [`Matcher`] per order venue: an order rests in the matcher of its venue and is matched
/// only against that venue's book. Cancels and account resets search every venue.
#[derive(Debug)]
pub struct Matchers {
    fee_bps: u32,
    /// The venue that stamps a rejection of an order that is open nowhere.
    default_venue: Venue,
    by_venue: BTreeMap<Venue, Matcher>,
}

impl Default for Matchers {
    fn default() -> Self {
        Self::new(DEFAULT_FEE_BPS, Venue::Replay)
    }
}

impl Matchers {
    pub fn new(fee_bps: u32, default_venue: Venue) -> Self {
        Self {
            fee_bps,
            default_venue,
            by_venue: BTreeMap::new(),
        }
    }

    /// The same set with `venue` as the default venue.
    pub fn with_venue(mut self, venue: Venue) -> Self {
        self.default_venue = venue;
        self
    }

    fn matcher_mut(&mut self, venue: Venue) -> &mut Matcher {
        let fee_bps = self.fee_bps;
        self.by_venue
            .entry(venue)
            .or_insert_with(|| Matcher::new(fee_bps).with_venue(venue))
    }

    /// [`Matcher::place`] on the matcher of `venue`.
    pub fn place(
        &mut self,
        venue: Venue,
        req: PlaceRequest,
        book: &OrderBook,
        last: Option<Price>,
        ts: TimeMs,
    ) -> MatchOutput {
        self.matcher_mut(venue).place(req, book, last, ts)
    }

    /// [`Matcher::on_market`] on the matcher of `venue`; nothing if it has no orders.
    pub fn on_market(
        &mut self,
        venue: Venue,
        symbol: &str,
        book: &OrderBook,
        last: Option<Price>,
        ts: TimeMs,
    ) -> MatchOutput {
        match self.by_venue.get_mut(&venue) {
            Some(matcher) => matcher.on_market(symbol, book, last, ts),
            None => MatchOutput::default(),
        }
    }

    /// Cancels the account's order `order_id` on whichever venue it rests.
    pub fn cancel(&mut self, account_id: &AccountId, order_id: &OrderId) -> Vec<Event> {
        for matcher in self.by_venue.values_mut() {
            let events = matcher.cancel(account_id, order_id);
            if !matches!(events.first(), Some(Event::OrderRejected { .. })) {
                return events;
            }
        }
        let venue = self.default_venue;
        self.matcher_mut(venue).cancel(account_id, order_id)
    }

    /// Cancels every open order of the account on every venue, venue by venue.
    pub fn cancel_all(&mut self, account_id: &AccountId) -> Vec<Event> {
        self.by_venue
            .values_mut()
            .flat_map(|matcher| matcher.cancel_all(account_id))
            .collect()
    }

    /// Number of open orders, all accounts and venues.
    #[allow(dead_code)] // used by tests only
    pub fn open_count(&self) -> usize {
        self.by_venue.values().map(Matcher::open_count).sum()
    }

    /// Open orders of one account, venue by venue, in acceptance order within a venue.
    #[allow(dead_code)] // used by tests only
    pub fn open_orders_for<'a>(
        &'a self,
        account_id: &'a AccountId,
    ) -> impl Iterator<Item = &'a Order> + 'a {
        self.by_venue
            .values()
            .flat_map(move |matcher| matcher.open_orders_for(account_id))
    }
}

fn ack(venue: Venue, account_id: &AccountId, order_id: &OrderId, status: OrderStatus) -> Event {
    Event::OrderAck {
        account_id: account_id.clone(),
        venue,
        order_id: order_id.clone(),
        status,
    }
}

/// True when `last` has reached or crossed the stop price.
fn stop_hit(side: Side, stop_price: Price, last: Option<Price>) -> bool {
    last.is_some_and(|last| match side {
        Side::Buy => last >= stop_price,
        Side::Sell => last <= stop_price,
    })
}

/// `value * fee_bps / 10_000` in i128, truncated toward zero. `None` on overflow.
fn fee_for(value: Money, fee_bps: i64) -> Option<Money> {
    let fee = i128::from(value.0)
        .checked_mul(i128::from(fee_bps))?
        .checked_div(10_000)?;
    i64::try_from(fee).ok().map(Money)
}

/// The per-call inputs of [`match_order`] that are not the order, the book, or the overlay.
#[derive(Debug, Clone, Copy)]
struct MatchParams {
    venue: Venue,
    fee_bps: i64,
    ts: TimeMs,
}

/// Matches one order against the book, appending its Fills and, when it completes, the
/// `filled` ack to `out`. Returns true when the order is complete and must be removed.
/// An untriggered stop does nothing.
fn match_order(
    order: &mut Order,
    book: &OrderBook,
    overlay: &mut Overlay,
    params: MatchParams,
    out: &mut MatchOutput,
) -> bool {
    let MatchParams { venue, fee_bps, ts } = params;
    let limit = match order.kind {
        OrderKind::Market => None,
        OrderKind::Limit { price } => Some(price),
        OrderKind::Stop { .. } if order.stop_triggered => None,
        OrderKind::Stop { .. } => return false,
    };
    let Some(inst) = instrument(&order.symbol) else {
        return false;
    };
    // Levels on the opposite side, best first.
    let levels: Vec<(Price, i64)> = match order.side {
        Side::Buy => book.asks.iter().map(|(p, q)| (*p, q.0)).collect(),
        Side::Sell => book.bids.iter().rev().map(|(p, q)| (*p, q.0)).collect(),
    };
    for (price, level_qty) in levels {
        if order.remaining_qty <= 0 {
            break;
        }
        if let Some(limit) = limit {
            let acceptable = match order.side {
                Side::Buy => price <= limit,
                Side::Sell => price >= limit,
            };
            if !acceptable {
                break;
            }
        }
        let used_map = match order.side {
            Side::Buy => &mut overlay.asks,
            Side::Sell => &mut overlay.bids,
        };
        let used = used_map.get(&price).copied().unwrap_or(0);
        let available = level_qty.saturating_sub(used);
        if available <= 0 {
            continue;
        }
        let take = available.min(order.remaining_qty);
        let Ok(value) = notional(inst, price, Qty(take)) else {
            break;
        };
        let Some(fee) = fee_for(value, fee_bps) else {
            break;
        };
        used_map.insert(price, used.saturating_add(take));
        order.remaining_qty -= take;
        out.events.push(Event::Fill {
            account_id: order.account_id.clone(),
            venue,
            order_id: order.order_id.clone(),
            symbol: order.symbol.clone(),
            side: order.side,
            price,
            qty: Qty(take),
            fee,
            remaining: Qty(order.remaining_qty),
            ts,
        });
        out.fills.push(FillRecord {
            account_id: order.account_id.clone(),
            order_id: order.order_id.clone(),
            symbol: order.symbol.clone(),
            side: order.side,
            price,
            qty: Qty(take),
            fee,
            ts,
        });
    }
    if order.remaining_qty == 0 {
        out.events.push(ack(
            venue,
            &order.account_id,
            &order.order_id,
            OrderStatus::Filled,
        ));
        return true;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::Level;

    const BTC: &str = "BTC-USD";

    fn acct(s: &str) -> AccountId {
        AccountId::new(s).unwrap()
    }

    fn oid(s: &str) -> OrderId {
        OrderId::new(s).unwrap()
    }

    fn lv(price: i64, qty: i64) -> Level {
        Level {
            price: Price(price),
            qty: Qty(qty),
        }
    }

    fn book(bids: &[(i64, i64)], asks: &[(i64, i64)]) -> OrderBook {
        let mut b = OrderBook::new();
        let bids: Vec<Level> = bids.iter().map(|&(p, q)| lv(p, q)).collect();
        let asks: Vec<Level> = asks.iter().map(|&(p, q)| lv(p, q)).collect();
        b.apply_snapshot(&bids, &asks);
        b
    }

    fn req(account: &str, id: &str, side: Side, qty: i64, kind: OrderKind) -> PlaceRequest {
        PlaceRequest {
            account_id: acct(account),
            order_id: oid(id),
            symbol: BTC.into(),
            side,
            qty: Qty(qty),
            kind,
        }
    }

    fn limit(price: i64) -> OrderKind {
        OrderKind::Limit {
            price: Price(price),
        }
    }

    fn stop(price: i64) -> OrderKind {
        OrderKind::Stop {
            stop_price: Price(price),
        }
    }

    /// Fee at the default 5 bps; BTC notional is price * qty.
    fn fee(price: i64, qty: i64) -> Money {
        Money(price * qty * 5 / 10_000)
    }

    fn ack_ev(account: &str, id: &str, status: OrderStatus) -> Event {
        ack(Venue::Replay, &acct(account), &oid(id), status)
    }

    fn fill_ev(account: &str, id: &str, side: Side, price: i64, qty: i64, remaining: i64) -> Event {
        Event::Fill {
            account_id: acct(account),
            venue: Venue::Replay,
            order_id: oid(id),
            symbol: BTC.into(),
            side,
            price: Price(price),
            qty: Qty(qty),
            fee: fee(price, qty),
            remaining: Qty(remaining),
            ts: 7,
        }
    }

    fn with_ts(mut event: Event, new_ts: TimeMs) -> Event {
        if let Event::Fill { ts, .. } = &mut event {
            *ts = new_ts;
        }
        event
    }

    fn rejected(account: &str, id: &str, reason: &str) -> Event {
        Event::OrderRejected {
            account_id: acct(account),
            venue: Venue::Replay,
            order_id: oid(id),
            reason: reason.into(),
        }
    }

    #[test]
    fn market_buy_walks_two_levels() {
        let mut m = Matcher::default();
        let b = book(&[(99_000, 5_000)], &[(100_000, 2_000), (100_100, 5_000)]);
        let out = m.place(
            req("guest", "o-1", Side::Buy, 4_000, OrderKind::Market),
            &b,
            None,
            7,
        );
        assert_eq!(
            out.events,
            vec![
                ack_ev("guest", "o-1", OrderStatus::Accepted),
                fill_ev("guest", "o-1", Side::Buy, 100_000, 2_000, 2_000),
                fill_ev("guest", "o-1", Side::Buy, 100_100, 2_000, 0),
                ack_ev("guest", "o-1", OrderStatus::Filled),
            ]
        );
        assert_eq!(out.fills.len(), 2);
        assert_eq!(out.fills[1].price, Price(100_100));
        assert_eq!(m.open_count(), 0);
    }

    #[test]
    fn fills_do_not_change_the_market_book() {
        let mut m = Matcher::default();
        let b = book(&[(99_000, 5)], &[(100_000, 5)]);
        let before = b.clone();
        m.place(
            req("guest", "o-1", Side::Buy, 5, OrderKind::Market),
            &b,
            None,
            7,
        );
        assert_eq!(b, before);
    }

    #[test]
    fn thin_book_partially_fills_and_remainder_rests() {
        let mut m = Matcher::default();
        let b = book(&[], &[(100_000, 3)]);
        let out = m.place(
            req("guest", "o-1", Side::Buy, 5, OrderKind::Market),
            &b,
            None,
            7,
        );
        assert_eq!(
            out.events,
            vec![
                ack_ev("guest", "o-1", OrderStatus::Accepted),
                fill_ev("guest", "o-1", Side::Buy, 100_000, 3, 2),
            ]
        );
        let acct_guest = acct("guest");
        let open: Vec<&Order> = m.open_orders_for(&acct_guest).collect();
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].remaining_qty, 2);
        assert_eq!(open[0].filled_qty(), 3);
        assert_eq!(
            open[0].filled_qty() + open[0].remaining_qty,
            open[0].original_qty
        );
    }

    #[test]
    fn market_order_on_empty_book_rests_with_only_the_accepted_ack() {
        let mut m = Matcher::default();
        let out = m.place(
            req("guest", "o-1", Side::Sell, 5, OrderKind::Market),
            &OrderBook::new(),
            None,
            7,
        );
        assert_eq!(
            out.events,
            vec![ack_ev("guest", "o-1", OrderStatus::Accepted)]
        );
        assert_eq!(m.open_count(), 1);
        // Retried on a later book update.
        let b = book(&[(99_000, 9)], &[]);
        let out = m.on_market(BTC, &b, None, 8);
        assert_eq!(out.fills.len(), 1);
        assert_eq!(out.fills[0].price, Price(99_000));
        assert_eq!(m.open_count(), 0);
    }

    #[test]
    fn limit_buy_fills_only_at_or_below_limit() {
        let mut m = Matcher::default();
        let b = book(&[], &[(100_000, 2), (100_100, 2)]);
        let out = m.place(
            req("guest", "o-1", Side::Buy, 4, limit(100_000)),
            &b,
            None,
            7,
        );
        assert_eq!(
            out.events,
            vec![
                ack_ev("guest", "o-1", OrderStatus::Accepted),
                fill_ev("guest", "o-1", Side::Buy, 100_000, 2, 2),
            ]
        );
        assert_eq!(m.open_count(), 1);

        let mut m = Matcher::default();
        let out = m.place(
            req("guest", "o-2", Side::Buy, 4, limit(99_999)),
            &b,
            None,
            7,
        );
        assert_eq!(
            out.events,
            vec![ack_ev("guest", "o-2", OrderStatus::Accepted)]
        );
        assert!(out.fills.is_empty());
    }

    #[test]
    fn limit_sell_fills_only_at_or_above_limit() {
        let mut m = Matcher::default();
        let b = book(&[(100_000, 2), (99_900, 2)], &[]);
        let out = m.place(
            req("guest", "o-1", Side::Sell, 4, limit(100_000)),
            &b,
            None,
            7,
        );
        assert_eq!(
            out.events,
            vec![
                ack_ev("guest", "o-1", OrderStatus::Accepted),
                fill_ev("guest", "o-1", Side::Sell, 100_000, 2, 2),
            ]
        );
        let mut m = Matcher::default();
        let out = m.place(
            req("guest", "o-2", Side::Sell, 4, limit(100_001)),
            &b,
            None,
            7,
        );
        assert!(out.fills.is_empty());
        assert_eq!(m.open_count(), 1);
    }

    #[test]
    fn resting_limit_fills_on_a_later_book_update() {
        let mut m = Matcher::default();
        let thin = book(&[], &[(101_000, 5)]);
        m.place(
            req("guest", "o-1", Side::Buy, 3, limit(100_000)),
            &thin,
            None,
            7,
        );
        let better = book(&[], &[(100_000, 5)]);
        let out = m.on_market(BTC, &better, None, 9);
        assert_eq!(out.events.len(), 2);
        assert!(matches!(&out.events[0], Event::Fill { ts: 9, .. }));
        assert_eq!(out.events[1], ack_ev("guest", "o-1", OrderStatus::Filled));
        assert_eq!(m.open_count(), 0);
    }

    #[test]
    fn stop_triggers_on_a_crossing_trade_then_fills_as_market() {
        let mut m = Matcher::default();
        let b = book(&[(99_000, 5)], &[(106_000, 5)]);
        let out = m.place(
            req("guest", "o-1", Side::Buy, 2, stop(105_000)),
            &b,
            Some(Price(100_000)),
            7,
        );
        assert_eq!(
            out.events,
            vec![ack_ev("guest", "o-1", OrderStatus::Accepted)]
        );
        // Below the stop: still resting.
        assert!(
            m.on_market(BTC, &b, Some(Price(104_999)), 8)
                .events
                .is_empty()
        );
        // At the stop: triggers and fills at the ask, not at the stop price.
        let out = m.on_market(BTC, &b, Some(Price(105_000)), 9);
        assert_eq!(
            out.events,
            vec![
                with_ts(fill_ev("guest", "o-1", Side::Buy, 106_000, 2, 0), 9),
                ack_ev("guest", "o-1", OrderStatus::Filled),
            ]
        );
    }

    #[test]
    fn sell_stop_already_satisfied_triggers_at_placement() {
        let mut m = Matcher::default();
        let b = book(&[(90_000, 5)], &[]);
        let out = m.place(
            req("guest", "o-1", Side::Sell, 2, stop(95_000)),
            &b,
            Some(Price(94_000)),
            7,
        );
        assert_eq!(out.events.len(), 3);
        assert_eq!(
            out.events[1],
            fill_ev("guest", "o-1", Side::Sell, 90_000, 2, 0)
        );
        assert_eq!(m.open_count(), 0);
    }

    #[test]
    fn fee_rounds_toward_zero_per_fill() {
        // notional 3 * 1000 = 3000, fee 3000 * 5 / 10000 = 1 (1.5 truncated).
        let mut m = Matcher::default();
        let b = book(&[], &[(3, 400), (4, 600)]);
        let out = m.place(
            req("guest", "o-1", Side::Buy, 1_000, OrderKind::Market),
            &b,
            None,
            7,
        );
        let fees: Vec<Money> = out.fills.iter().map(|f| f.fee).collect();
        // 3*400 = 1200 -> 0 (0.6); 4*600 = 2400 -> 1 (1.2).
        assert_eq!(fees, vec![Money(0), Money(1)]);
        // Custom rate: 100 bps of 3000 = 30.
        let mut m = Matcher::new(100);
        let b = book(&[], &[(3, 1_000)]);
        let out = m.place(
            req("guest", "o-2", Side::Buy, 1_000, OrderKind::Market),
            &b,
            None,
            7,
        );
        assert_eq!(out.fills[0].fee, Money(30));
    }

    #[test]
    fn cancel_removes_an_open_order() {
        let mut m = Matcher::default();
        m.place(
            req("guest", "o-1", Side::Buy, 1, limit(1)),
            &OrderBook::new(),
            None,
            7,
        );
        assert_eq!(
            m.cancel(&acct("guest"), &oid("o-1")),
            vec![ack_ev("guest", "o-1", OrderStatus::Canceled)]
        );
        assert_eq!(m.open_count(), 0);
    }

    #[test]
    fn cancel_of_unknown_or_foreign_order_is_rejected_and_order_stays() {
        let mut m = Matcher::default();
        m.place(
            req("w_a", "o-1", Side::Buy, 1, limit(1)),
            &OrderBook::new(),
            None,
            7,
        );
        assert_eq!(
            m.cancel(&acct("w_b"), &oid("o-1")),
            vec![rejected("w_b", "o-1", "unknown_order")]
        );
        assert_eq!(
            m.cancel(&acct("w_a"), &oid("nope")),
            vec![rejected("w_a", "nope", "unknown_order")]
        );
        assert_eq!(m.open_count(), 1);
    }

    #[test]
    fn cancel_all_only_affects_the_callers_account() {
        let mut m = Matcher::default();
        let empty = OrderBook::new();
        m.place(req("w_a", "a-1", Side::Buy, 1, limit(1)), &empty, None, 7);
        m.place(req("w_b", "b-1", Side::Buy, 1, limit(1)), &empty, None, 7);
        m.place(req("w_a", "a-2", Side::Sell, 1, limit(9)), &empty, None, 7);
        assert_eq!(
            m.cancel_all(&acct("w_a")),
            vec![
                ack_ev("w_a", "a-1", OrderStatus::Canceled),
                ack_ev("w_a", "a-2", OrderStatus::Canceled),
            ]
        );
        assert_eq!(m.open_count(), 1);
        assert_eq!(m.open_orders_for(&acct("w_b")).count(), 1);
    }

    #[test]
    fn two_orders_in_one_pass_share_displayed_liquidity_in_sequence_order() {
        let mut m = Matcher::default();
        let empty = OrderBook::new();
        m.place(
            req("w_a", "a-1", Side::Buy, 5, OrderKind::Market),
            &empty,
            None,
            7,
        );
        m.place(
            req("w_b", "b-1", Side::Buy, 5, OrderKind::Market),
            &empty,
            None,
            7,
        );
        let b = book(&[], &[(100, 6)]);
        let out = m.on_market(BTC, &b, None, 8);
        let fills: Vec<(String, i64)> = out
            .fills
            .iter()
            .map(|f| (f.account_id.to_string(), f.qty.0))
            .collect();
        assert_eq!(fills, vec![("w_a".to_owned(), 5), ("w_b".to_owned(), 1)]);
        assert_eq!(m.open_count(), 1);
        // A fresh pass starts with a fresh overlay: the same displayed 6 lots fill again.
        let out = m.on_market(BTC, &b, None, 9);
        assert_eq!(out.fills.len(), 1);
        assert_eq!(out.fills[0].qty, Qty(4));
    }

    #[test]
    fn invalid_and_duplicate_orders_are_rejected() {
        let mut m = Matcher::default();
        let empty = OrderBook::new();
        let mut bad = req("guest", "o-1", Side::Buy, 1, OrderKind::Market);
        bad.symbol = "NOPE-USD".into();
        assert_eq!(
            m.place(bad, &empty, None, 7).events,
            vec![rejected("guest", "o-1", "unknown_symbol")]
        );
        assert_eq!(
            m.place(
                req("guest", "o-1", Side::Buy, 0, OrderKind::Market),
                &empty,
                None,
                7
            )
            .events,
            vec![rejected("guest", "o-1", "invalid_quantity")]
        );
        m.place(req("w_a", "o-2", Side::Buy, 1, limit(1)), &empty, None, 7);
        assert_eq!(
            m.place(req("w_b", "o-2", Side::Buy, 1, limit(1)), &empty, None, 7)
                .events,
            vec![rejected("w_b", "o-2", "duplicate_order_id")]
        );
        assert_eq!(m.open_count(), 1);
    }

    #[test]
    fn same_inputs_give_identical_output() {
        let run = || {
            let mut m = Matcher::default();
            let b = book(&[(99_000, 3)], &[(100_000, 2), (100_100, 4)]);
            vec![
                m.place(
                    req("w_a", "a-1", Side::Buy, 5, OrderKind::Market),
                    &b,
                    None,
                    7,
                ),
                m.place(req("w_b", "b-1", Side::Sell, 9, limit(99_000)), &b, None, 7),
                m.on_market(BTC, &b, Some(Price(100_000)), 8),
            ]
        };
        assert_eq!(run(), run());
    }
}

#[cfg(test)]
#[path = "matcher_properties.rs"]
mod properties;
