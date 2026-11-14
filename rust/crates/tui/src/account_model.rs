//! The account state of the TUI and its pure reducers (Task 12.4, Req 22, 28, 30, 31).
//!
//! Positions, open orders, the preview and confirm dialogs, the parse error, and the rejection
//! line. The Rust twin of the order parts of `web/lib/store.ts`: the same events change the same
//! things, so both clients show the same account. Nothing here reads a clock; callers pass
//! `now_ms`, so tests are exact.

// Some helpers are used only by tests.
#![allow(dead_code)]

use std::collections::{BTreeMap, VecDeque};

use protocol::client::OrderPreview;
use protocol::{AccountId, Event, Money, OrderStatus};

use crate::order_model::{
    ConfirmAction, MAX_PENDING_PLACEMENTS, MAX_REJECTIONS, OpenOrder, ParseErrorState, Placement,
    PositionRow, PreviewState, REJECTION_TTL_MS, Rejection, placement_from_action, preview_deadline,
    seconds_left,
};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AccountState {
    /// The account the data below belongs to. It survives reconnects; a `session` for another
    /// account clears the data (Req 46.4). `None` until the first session.
    account: Option<AccountId>,
    /// Open positions by symbol (Req 28.1). A flat position is removed.
    pub positions: BTreeMap<String, PositionRow>,
    /// The realized P&L of every symbol seen, kept after the position closes (Req 28.3).
    realized_by_symbol: BTreeMap<String, Money>,
    /// Open orders, oldest first (Req 28.2).
    pub orders: Vec<OpenOrder>,
    /// Confirmed placements waiting for their `order_ack`, oldest first.
    pending: VecDeque<Placement>,
    /// The id of the open order the orders panel has selected.
    pub selected_order: Option<String>,
    /// The request id of the last command text sent; only its preview or parse error counts.
    pub last_request_id: Option<String>,
    pub preview: Option<PreviewState>,
    pub parse_error: Option<ParseErrorState>,
    /// The flatten-all or cancel-all dialog.
    pub confirm: Option<ConfirmAction>,
    /// The rejections, newest first (Req 30.6).
    pub rejections: VecDeque<Rejection>,
    /// What the last [`AccountState::tick`] saw, to tell whether the screen needs a redraw.
    tick_secs: Option<u64>,
    tick_rejection_live: bool,
}

impl AccountState {
    pub fn new() -> Self {
        Self::default()
    }

    /// The account the data belongs to.
    pub fn account(&self) -> Option<&AccountId> {
        self.account.as_ref()
    }

    /// True when an account event belongs to the account this client shows. Before the first
    /// session every event is accepted.
    fn is_own(&self, account_id: &AccountId) -> bool {
        self.account.as_ref().is_none_or(|own| own == account_id)
    }

    /// Drops everything that belongs to one account: positions, orders, previews, dialogs
    /// (the web's `clearAccountData`). Rejections and the request id stay.
    pub fn clear(&mut self) {
        self.positions.clear();
        self.realized_by_symbol.clear();
        self.orders.clear();
        self.pending.clear();
        self.selected_order = None;
        self.preview = None;
        self.parse_error = None;
        self.confirm = None;
    }

    /// Applies a `session` message. A different account than before clears the data and the
    /// rejections (Req 46.4). Returns whether the account changed.
    pub fn on_session(&mut self, account_id: &AccountId) -> bool {
        let changed = self.account.as_ref().is_some_and(|own| own != account_id);
        self.account = Some(account_id.clone());
        if changed {
            self.clear();
            self.rejections.clear();
        }
        changed
    }

    /// Applies an `account_reset` notice: the engine restarted and every paper account is flat
    /// (Req 15.7).
    pub fn on_account_reset(&mut self) {
        self.clear();
    }

    // -----------------------------------------------------------------------------------------
    // Engine events

    /// Applies one account event of the engine. Returns whether anything changed. Events of
    /// another account and market data events change nothing.
    pub fn apply_event(&mut self, event: &Event, now_ms: i64) -> bool {
        match event {
            Event::Position {
                account_id,
                symbol,
                qty,
                avg_entry,
                realized,
                unrealized,
            } if self.is_own(account_id) => {
                self.realized_by_symbol.insert(symbol.clone(), *realized);
                if qty.0 == 0 {
                    self.positions.remove(symbol);
                } else {
                    self.positions.insert(
                        symbol.clone(),
                        PositionRow {
                            symbol: symbol.clone(),
                            qty: *qty,
                            avg_entry: *avg_entry,
                            realized: *realized,
                            unrealized: *unrealized,
                        },
                    );
                }
                true
            }
            Event::OrderAck {
                account_id,
                order_id,
                status,
            } if self.is_own(account_id) => self.apply_ack(order_id.as_str(), *status),
            Event::Fill {
                account_id,
                order_id,
                symbol,
                side,
                qty,
                remaining,
                ..
            } if self.is_own(account_id) => {
                let Some(order) = self.orders.iter_mut().find(|o| o.id == order_id.as_str())
                else {
                    return false;
                };
                if order.symbol.is_none() {
                    order.symbol = Some(symbol.clone());
                }
                if order.side.is_none() {
                    order.side = Some(*side);
                }
                order.filled = order.filled.saturating_add(qty.0);
                order.remaining = remaining.0;
                if order.qty == 0 {
                    order.qty = order.filled.saturating_add(order.remaining);
                }
                true
            }
            Event::OrderRejected {
                account_id,
                order_id,
                reason,
            } if self.is_own(account_id) => {
                self.push_rejection(Some(order_id.as_str().to_owned()), reason, now_ms);
                // A rejection of an order that is not open is a rejected new order, so it also
                // drops the oldest confirmed placement that still waits for an ack.
                let is_open = self.orders.iter().any(|o| o.id == order_id.as_str());
                if !is_open {
                    self.pending.pop_front();
                }
                true
            }
            _ => false,
        }
    }

    /// `accepted` opens a row with the label of the oldest pending placement; `canceled` and
    /// `filled` remove the row.
    fn apply_ack(&mut self, order_id: &str, status: OrderStatus) -> bool {
        if status != OrderStatus::Accepted {
            let before = self.orders.len();
            self.orders.retain(|o| o.id != order_id);
            if self.selected_order.as_deref() == Some(order_id) {
                self.selected_order = None;
            }
            return self.orders.len() != before;
        }
        if self.orders.iter().any(|o| o.id == order_id) {
            return false;
        }
        let row = match self.pending.pop_front() {
            Some(placement) => OpenOrder {
                id: order_id.to_owned(),
                symbol: Some(placement.symbol),
                side: Some(placement.side),
                kind: Some(placement.kind),
                price: placement.price,
                qty: placement.qty.0,
                filled: 0,
                remaining: placement.qty.0,
            },
            None => OpenOrder {
                id: order_id.to_owned(),
                symbol: None,
                side: None,
                kind: None,
                price: None,
                qty: 0,
                filled: 0,
                remaining: 0,
            },
        };
        self.orders.push(row);
        true
    }

    // -----------------------------------------------------------------------------------------
    // Rejections (Req 30.6)

    fn push_rejection(&mut self, order_id: Option<String>, reason: &str, now_ms: i64) {
        self.rejections.push_front(Rejection {
            order_id,
            reason: reason.to_owned(),
            at_ms: now_ms,
        });
        self.rejections.truncate(MAX_REJECTIONS);
    }

    /// Shows a client-side problem, such as an incomplete ticket, like a server rejection.
    pub fn add_rejection(&mut self, reason: &str, now_ms: i64) {
        self.push_rejection(None, reason, now_ms);
    }

    /// The newest rejection while it is younger than [`REJECTION_TTL_MS`].
    pub fn latest_rejection(&self, now_ms: i64) -> Option<&Rejection> {
        self.rejections
            .front()
            .filter(|r| now_ms.saturating_sub(r.at_ms) < REJECTION_TTL_MS)
    }

    pub fn dismiss_rejections(&mut self) {
        self.rejections.clear();
    }

    // -----------------------------------------------------------------------------------------
    // Previews and dialogs (Req 22)

    /// Records a sent command text: only the answer to this request id is shown, and an older
    /// preview or parse error goes away.
    pub fn command_sent(&mut self, request_id: &str) {
        self.last_request_id = Some(request_id.to_owned());
        self.preview = None;
        self.parse_error = None;
    }

    /// Applies a server `preview`. Returns whether it answers the last request (Req 22.1).
    pub fn on_preview(&mut self, request_id: &str, preview: &OrderPreview, now_ms: i64) -> bool {
        if self.last_request_id.as_deref() != Some(request_id) {
            return false;
        }
        self.preview = Some(PreviewState {
            request_id: request_id.to_owned(),
            preview: preview.clone(),
            deadline_ms: preview_deadline(preview.expires_at, now_ms),
        });
        self.parse_error = None;
        true
    }

    /// Applies a server `parse_error`. Returns whether it answers the last request (Req 31.4).
    pub fn on_parse_error(&mut self, request_id: &str, message: &str, position: usize) -> bool {
        if self.last_request_id.as_deref() != Some(request_id) {
            return false;
        }
        self.preview = None;
        self.parse_error = Some(ParseErrorState {
            request_id: request_id.to_owned(),
            message: message.to_owned(),
            position,
        });
        true
    }

    /// The user confirmed the preview: closes it, queues a `place` for its ack, and returns the
    /// preview id to send.
    pub fn take_preview_for_confirm(&mut self) -> Option<String> {
        let state = self.preview.take()?;
        if let Some(placement) = placement_from_action(&state.preview.action) {
            self.pending.push_back(placement);
            while self.pending.len() > MAX_PENDING_PLACEMENTS {
                self.pending.pop_front();
            }
        }
        Some(state.preview.preview_id)
    }

    /// The user discarded the preview: closes it and returns the preview id to send.
    pub fn take_preview_for_discard(&mut self) -> Option<String> {
        self.preview.take().map(|state| state.preview.preview_id)
    }

    /// Opens the yes/no dialog. A pending preview is dropped (the server lets it expire), so
    /// only one dialog is ever open.
    pub fn request_confirm(&mut self, action: ConfirmAction) {
        self.confirm = Some(action);
        self.preview = None;
    }

    pub fn clear_confirm(&mut self) -> Option<ConfirmAction> {
        self.confirm.take()
    }

    /// True while a preview or confirm dialog is open (the `dialog` keymap context).
    pub fn dialog_open(&self) -> bool {
        self.preview.is_some() || self.confirm.is_some()
    }

    /// Closes an expired preview and tells whether the countdown or the rejection line changed
    /// since the last call, so the caller redraws only when needed.
    pub fn tick(&mut self, now_ms: i64) -> bool {
        let mut changed = false;
        let deadline = self.preview.as_ref().map(|p| p.deadline_ms);
        match deadline {
            Some(deadline) if now_ms >= deadline => {
                self.preview = None;
                self.tick_secs = None;
                changed = true;
            }
            Some(deadline) => {
                let secs = seconds_left(deadline, now_ms);
                if self.tick_secs != Some(secs) {
                    self.tick_secs = Some(secs);
                    changed = true;
                }
            }
            None => self.tick_secs = None,
        }
        let live = self.latest_rejection(now_ms).is_some();
        if live != self.tick_rejection_live {
            self.tick_rejection_live = live;
            changed = true;
        }
        changed
    }

    // -----------------------------------------------------------------------------------------
    // Orders panel selection (Req 30.3)

    /// Moves the selection one row: Up from no selection goes to the last order, Down to the
    /// first. Stops at both ends. Returns whether the selection changed.
    pub fn move_selection(&mut self, up: bool) -> bool {
        if self.orders.is_empty() {
            return false;
        }
        let last = self.orders.len() - 1;
        let at = self
            .selected_order
            .as_deref()
            .and_then(|id| self.orders.iter().position(|o| o.id == id));
        let next = match (at, up) {
            (None, true) => last,
            (None, false) => 0,
            (Some(i), true) => i.saturating_sub(1),
            (Some(i), false) => (i + 1).min(last),
        };
        let id = self.orders.get(next).map(|o| o.id.clone());
        let changed = id != self.selected_order;
        self.selected_order = id;
        changed
    }

    /// Selects the order with this id, if it is open.
    pub fn select_order(&mut self, id: &str) -> bool {
        if !self.orders.iter().any(|o| o.id == id) || self.selected_order.as_deref() == Some(id) {
            return false;
        }
        self.selected_order = Some(id.to_owned());
        true
    }

    // -----------------------------------------------------------------------------------------
    // P&L totals (Req 28.1, 28.3)

    /// Realized P&L summed over every symbol seen, in Money units.
    pub fn realized_total(&self) -> i128 {
        self.realized_by_symbol
            .values()
            .map(|m| i128::from(m.0))
            .sum()
    }

    /// Unrealized P&L summed over the open positions, in Money units.
    pub fn unrealized_total(&self) -> i128 {
        self.positions
            .values()
            .map(|p| i128::from(p.unrealized.0))
            .sum()
    }

    pub fn total_pnl(&self) -> i128 {
        self.realized_total().saturating_add(self.unrealized_total())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::client::PreviewAction;
    use protocol::{OrderId, OrderKind, Price, Qty, Side};

    fn guest() -> AccountId {
        AccountId::new("guest").unwrap()
    }

    fn wallet() -> AccountId {
        AccountId::new("w_abc").unwrap()
    }

    fn oid(id: &str) -> OrderId {
        OrderId::new(id).unwrap()
    }

    fn position(account: AccountId, symbol: &str, qty: i64, realized: i64, unrealized: i64) -> Event {
        Event::Position {
            account_id: account,
            symbol: symbol.into(),
            qty: Qty(qty),
            avg_entry: (qty != 0).then_some(Price(6_400_000)),
            realized: Money(realized),
            unrealized: Money(unrealized),
        }
    }

    fn ack(account: AccountId, id: &str, status: OrderStatus) -> Event {
        Event::OrderAck {
            account_id: account,
            order_id: oid(id),
            status,
        }
    }

    fn fill(id: &str, qty: i64, remaining: i64) -> Event {
        Event::Fill {
            account_id: guest(),
            order_id: oid(id),
            symbol: "BTC-USD".into(),
            side: Side::Buy,
            price: Price(6_400_000),
            qty: Qty(qty),
            fee: Money(0),
            remaining: Qty(remaining),
            ts: 1,
        }
    }

    fn rejected(account: AccountId, id: &str, reason: &str) -> Event {
        Event::OrderRejected {
            account_id: account,
            order_id: oid(id),
            reason: reason.into(),
        }
    }

    fn place_preview(id: &str, expires_at: i64) -> OrderPreview {
        OrderPreview {
            preview_id: id.into(),
            text: "BUY BTC-USD 0.1 LMT 64000.00".into(),
            action: PreviewAction::Place {
                symbol: "BTC-USD".into(),
                side: Side::Buy,
                qty: Qty(10_000_000),
                kind: OrderKind::Limit {
                    price: Price(6_400_000),
                },
            },
            expires_at,
        }
    }

    // Req 28.1
    #[test]
    fn position_events_replace_rows_and_flat_positions_leave_the_table() {
        let mut state = AccountState::new();
        assert!(state.apply_event(&position(guest(), "BTC-USD", 10_000_000, 5, 7), 0));
        assert_eq!(state.positions.len(), 1);
        assert_eq!(state.positions["BTC-USD"].unrealized, Money(7));
        assert!(state.apply_event(&position(guest(), "BTC-USD", -20, 5, 9), 0));
        assert_eq!(state.positions["BTC-USD"].qty, Qty(-20));
        // Flat: the row goes, the realized P&L stays in the totals (Req 28.3).
        assert!(state.apply_event(&position(guest(), "BTC-USD", 0, 11, 0), 0));
        assert!(state.positions.is_empty());
        assert_eq!(state.realized_total(), 11);
        assert_eq!(state.unrealized_total(), 0);
    }

    // Req 28.3
    #[test]
    fn totals_sum_all_symbols() {
        let mut state = AccountState::new();
        state.apply_event(&position(guest(), "BTC-USD", 1, 100, 10), 0);
        state.apply_event(&position(guest(), "ETH-USD", 1, -30, -4), 0);
        state.apply_event(&position(guest(), "SOL-USD", 0, 5, 0), 0);
        assert_eq!(state.realized_total(), 75);
        assert_eq!(state.unrealized_total(), 6);
        assert_eq!(state.total_pnl(), 81);
    }

    // Req 28.2
    #[test]
    fn an_ack_opens_a_labelled_row_and_fills_update_it() {
        let mut state = AccountState::new();
        state.command_sent("r1");
        assert!(state.on_preview("r1", &place_preview("p1", 30_000), 0));
        assert_eq!(state.take_preview_for_confirm().as_deref(), Some("p1"));
        assert!(state.apply_event(&ack(guest(), "o-1", OrderStatus::Accepted), 0));
        let row = &state.orders[0];
        assert_eq!(row.id, "o-1");
        assert_eq!(row.symbol.as_deref(), Some("BTC-USD"));
        assert_eq!(row.side, Some(Side::Buy));
        assert_eq!(row.price, Some(Price(6_400_000)));
        assert_eq!((row.qty, row.filled, row.remaining), (10_000_000, 0, 10_000_000));
        // A repeated accepted ack changes nothing.
        assert!(!state.apply_event(&ack(guest(), "o-1", OrderStatus::Accepted), 0));
        // A partial fill moves quantity from remaining to filled.
        assert!(state.apply_event(&fill("o-1", 4_000_000, 6_000_000), 0));
        let row = &state.orders[0];
        assert_eq!((row.filled, row.remaining, row.qty), (4_000_000, 6_000_000, 10_000_000));
        // Filled or canceled removes the row.
        assert!(state.apply_event(&ack(guest(), "o-1", OrderStatus::Filled), 0));
        assert!(state.orders.is_empty());
        assert!(!state.apply_event(&ack(guest(), "o-1", OrderStatus::Canceled), 0));
    }

    #[test]
    fn an_ack_without_a_placement_has_unknown_labels_and_fills_complete_them() {
        let mut state = AccountState::new();
        state.apply_event(&ack(guest(), "o-2", OrderStatus::Accepted), 0);
        assert_eq!(state.orders[0].symbol, None);
        assert_eq!(state.orders[0].qty, 0);
        state.apply_event(&fill("o-2", 3, 7), 0);
        let row = &state.orders[0];
        assert_eq!(row.symbol.as_deref(), Some("BTC-USD"));
        assert_eq!(row.side, Some(Side::Buy));
        assert_eq!((row.filled, row.remaining, row.qty), (3, 7, 10));
        // A fill of an order that is not open changes nothing.
        assert!(!state.apply_event(&fill("o-9", 1, 0), 0));
    }

    // Req 30.6
    #[test]
    fn a_rejection_shows_for_ten_seconds_and_drops_the_oldest_placement() {
        let mut state = AccountState::new();
        state.command_sent("r1");
        state.on_preview("r1", &place_preview("p1", 30_000), 0);
        state.take_preview_for_confirm();
        assert!(state.apply_event(&rejected(guest(), "o-1", "max_order_value"), 1_000));
        let latest = state.latest_rejection(1_000).unwrap();
        assert_eq!(latest.reason, "max_order_value");
        assert_eq!(latest.order_id.as_deref(), Some("o-1"));
        assert!(state.latest_rejection(10_999).is_some());
        assert!(state.latest_rejection(11_000).is_none());
        // The placement was dropped, so the next ack has no label.
        state.apply_event(&ack(guest(), "o-2", OrderStatus::Accepted), 0);
        assert_eq!(state.orders[0].symbol, None);
        // A rejected cancel of an open order keeps the pending placements.
        state.command_sent("r2");
        state.on_preview("r2", &place_preview("p2", 30_000), 0);
        state.take_preview_for_confirm();
        state.apply_event(&rejected(guest(), "o-2", "not_open"), 2_000);
        state.apply_event(&ack(guest(), "o-3", OrderStatus::Accepted), 0);
        assert_eq!(state.orders[1].symbol.as_deref(), Some("BTC-USD"));
    }

    #[test]
    fn rejections_are_newest_first_and_capped() {
        let mut state = AccountState::new();
        for i in 0..15 {
            state.add_rejection(&format!("reason_{i}"), i64::from(i));
        }
        assert_eq!(state.rejections.len(), MAX_REJECTIONS);
        assert_eq!(state.rejections[0].reason, "reason_14");
        state.dismiss_rejections();
        assert!(state.latest_rejection(0).is_none());
    }

    // Req 22.1
    #[test]
    fn only_the_last_requests_preview_or_parse_error_counts() {
        let mut state = AccountState::new();
        state.command_sent("r2");
        assert!(!state.on_preview("r1", &place_preview("p1", 30_000), 0));
        assert!(!state.on_parse_error("r1", "bad", 2));
        assert!(state.preview.is_none() && state.parse_error.is_none());
        assert!(state.on_parse_error("r2", "unknown symbol", 4));
        let error = state.parse_error.clone().unwrap();
        assert_eq!((error.message.as_str(), error.position), ("unknown symbol", 4));
        // A preview clears the error, and sending the next command clears both.
        assert!(state.on_preview("r2", &place_preview("p1", 30_000), 0));
        assert!(state.parse_error.is_none() && state.preview.is_some());
        state.command_sent("r3");
        assert!(state.preview.is_none());
    }

    // Req 22.2, 22.3
    #[test]
    fn confirm_and_discard_take_the_preview_id_once() {
        let mut state = AccountState::new();
        state.command_sent("r1");
        state.on_preview("r1", &place_preview("p1", 30_000), 0);
        assert_eq!(state.take_preview_for_discard().as_deref(), Some("p1"));
        assert_eq!(state.take_preview_for_discard(), None);
        assert_eq!(state.take_preview_for_confirm(), None);
        // A discarded preview queues no placement.
        state.apply_event(&ack(guest(), "o-1", OrderStatus::Accepted), 0);
        assert_eq!(state.orders[0].symbol, None);
    }

    // Req 22.1
    #[test]
    fn the_preview_closes_itself_at_its_deadline_and_the_countdown_redraws() {
        let mut state = AccountState::new();
        state.command_sent("r1");
        state.on_preview("r1", &place_preview("p1", 30_000), 0);
        assert_eq!(state.preview.as_ref().map(|p| p.deadline_ms), Some(30_000));
        assert!(state.tick(0)); // first sight of 30 s
        assert!(!state.tick(100)); // still 30 s
        assert!(state.tick(1_000)); // 29 s
        assert!(!state.tick(1_500));
        assert!(state.tick(30_000)); // expired
        assert!(state.preview.is_none());
        assert!(!state.tick(31_000));
    }

    #[test]
    fn the_rejection_line_expiry_redraws_once() {
        let mut state = AccountState::new();
        state.add_rejection("kill_switch", 1_000);
        assert!(state.tick(1_000));
        assert!(!state.tick(5_000));
        assert!(state.tick(11_000));
        assert!(!state.tick(12_000));
    }

    // Req 30.4, 30.5
    #[test]
    fn the_confirm_dialog_replaces_a_preview() {
        let mut state = AccountState::new();
        state.command_sent("r1");
        state.on_preview("r1", &place_preview("p1", 30_000), 0);
        state.request_confirm(ConfirmAction::FlattenAll);
        assert!(state.preview.is_none());
        assert_eq!(state.confirm, Some(ConfirmAction::FlattenAll));
        assert!(state.dialog_open());
        assert_eq!(state.clear_confirm(), Some(ConfirmAction::FlattenAll));
        assert!(!state.dialog_open());
    }

    // Req 46.4
    #[test]
    fn another_account_clears_everything_and_the_same_account_keeps_it() {
        let mut state = AccountState::new();
        assert!(!state.on_session(&guest()));
        state.apply_event(&position(guest(), "BTC-USD", 5, 1, 1), 0);
        state.apply_event(&ack(guest(), "o-1", OrderStatus::Accepted), 0);
        state.command_sent("r1");
        state.on_preview("r1", &place_preview("p1", 30_000), 0);
        state.add_rejection("kill_switch", 0);
        // The same account again (a reconnect) keeps the data.
        assert!(!state.on_session(&guest()));
        assert_eq!(state.positions.len(), 1);
        assert_eq!(state.orders.len(), 1);
        assert!(state.preview.is_some());
        // Another account clears the data, the dialogs, and the rejections.
        state.request_confirm(ConfirmAction::CancelAll);
        assert!(state.on_session(&wallet()));
        assert!(state.positions.is_empty() && state.orders.is_empty());
        assert!(state.preview.is_none() && state.confirm.is_none());
        assert!(state.rejections.is_empty());
        assert_eq!(state.realized_total(), 0);
        assert_eq!(state.account(), Some(&wallet()));
    }

    #[test]
    fn events_of_another_account_are_ignored() {
        let mut state = AccountState::new();
        state.on_session(&guest());
        assert!(!state.apply_event(&position(wallet(), "BTC-USD", 5, 1, 1), 0));
        assert!(!state.apply_event(&ack(wallet(), "o-1", OrderStatus::Accepted), 0));
        assert!(!state.apply_event(&rejected(wallet(), "o-1", "x"), 0));
        assert!(state.positions.is_empty() && state.orders.is_empty());
        assert!(state.rejections.is_empty());
    }

    // Req 15.7
    #[test]
    fn an_account_reset_notice_clears_the_data_but_not_the_account() {
        let mut state = AccountState::new();
        state.on_session(&guest());
        state.apply_event(&position(guest(), "BTC-USD", 5, 1, 1), 0);
        state.apply_event(&ack(guest(), "o-1", OrderStatus::Accepted), 0);
        state.request_confirm(ConfirmAction::FlattenAll);
        state.on_account_reset();
        assert!(state.positions.is_empty() && state.orders.is_empty() && state.confirm.is_none());
        assert_eq!(state.account(), Some(&guest()));
    }

    // Req 30.3
    #[test]
    fn the_selection_walks_the_orders_and_stops_at_the_ends() {
        let mut state = AccountState::new();
        assert!(!state.move_selection(true));
        for id in ["o-1", "o-2", "o-3"] {
            state.apply_event(&ack(guest(), id, OrderStatus::Accepted), 0);
        }
        // Up from nothing selects the last order; Down from nothing the first.
        assert!(state.move_selection(true));
        assert_eq!(state.selected_order.as_deref(), Some("o-3"));
        assert!(state.move_selection(true));
        assert_eq!(state.selected_order.as_deref(), Some("o-2"));
        assert!(state.move_selection(false));
        assert!(state.move_selection(true));
        assert!(state.move_selection(true));
        assert_eq!(state.selected_order.as_deref(), Some("o-1"));
        assert!(!state.move_selection(true));
        // A removed order is deselected.
        state.apply_event(&ack(guest(), "o-1", OrderStatus::Canceled), 0);
        assert_eq!(state.selected_order, None);
        assert!(state.select_order("o-3"));
        assert!(!state.select_order("o-3"));
        assert!(!state.select_order("nope"));
        state.selected_order = None;
        assert!(state.move_selection(false));
        assert_eq!(state.selected_order.as_deref(), Some("o-2"));
    }
}
