//! Pure model of order entry: command history, ticket text, preview timing, and the row types
//! of the account panels (Task 12.4, Req 22, 28, 30, 31). The Rust twin of
//! `web/lib/orderEntry.ts`, so both clients build the same command text and show the same
//! numbers.
//!
//! No ratatui types and no I/O. Prices, quantities, and money are integers; text is built with
//! integer math only.

// Some helpers are used only by tests.
#![allow(dead_code)]

use protocol::client::{OrderPreview, PreviewAction};
use protocol::{MONEY_DECIMALS, Money, OrderKind, Price, Qty, Side, instrument};

use crate::chart_model::{PRICE_DECIMALS, QTY_DECIMALS, format_fixed};

/// Most submitted command texts kept (Req 31.3).
pub const MAX_HISTORY: usize = 50;
/// How long the server keeps a preview (it expires after 60 s).
pub const PREVIEW_TTL_MS: i64 = 60_000;
/// How long the latest rejection stays on screen (Req 30.6).
pub const REJECTION_TTL_MS: i64 = 10_000;
/// Most rejections kept, newest first.
pub const MAX_REJECTIONS: usize = 10;
/// Most confirmed placements that wait for their `order_ack`.
pub const MAX_PENDING_PLACEMENTS: usize = 20;

// ---------------------------------------------------------------------------------------------
// Command history (Req 31.3)

/// Adds a submitted text: blank text is ignored, a repeat of the newest entry is not added, and
/// only the newest [`MAX_HISTORY`] entries stay.
pub fn push_history(history: &mut Vec<String>, text: &str) {
    if text.trim().is_empty() || history.last().is_some_and(|last| last == text) {
        return;
    }
    history.push(text.to_owned());
    if history.len() > MAX_HISTORY {
        let excess = history.len() - MAX_HISTORY;
        history.drain(..excess);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistoryDirection {
    /// Up: an older entry.
    Prev,
    /// Down: a newer entry, then the draft.
    Next,
}

/// The result of one history step.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryStep {
    /// The position after the step; `None` when back at the draft being typed.
    pub index: Option<usize>,
    /// The text to show, or `None` to restore the draft.
    pub text: Option<String>,
}

/// One Up or Down step. `history` is oldest first and `index` is the current position (`None`
/// when not browsing). Up from the draft goes to the newest entry and stops at the oldest. Down
/// past the newest entry returns to the draft.
pub fn history_step(
    history: &[String],
    index: Option<usize>,
    direction: HistoryDirection,
) -> HistoryStep {
    if history.is_empty() {
        return HistoryStep {
            index: None,
            text: None,
        };
    }
    let last = history.len() - 1;
    let target = match (direction, index) {
        (HistoryDirection::Prev, None) => last,
        (HistoryDirection::Prev, Some(i)) => i.min(last).saturating_sub(1),
        (HistoryDirection::Next, None) => {
            return HistoryStep {
                index: None,
                text: None,
            };
        }
        (HistoryDirection::Next, Some(i)) => {
            let next = i.saturating_add(1);
            if next > last {
                return HistoryStep {
                    index: None,
                    text: None,
                };
            }
            next
        }
    };
    HistoryStep {
        index: Some(target),
        text: history.get(target).cloned(),
    }
}

// ---------------------------------------------------------------------------------------------
// Quantity text and the ticket (Req 30.2)

/// True when `text` can be a prefix of a valid quantity: digits, at most one `.`, and at most
/// `decimals` digits after it. The empty text and `1.` are allowed (they are being typed).
pub fn qty_text_allowed(text: &str, decimals: u32) -> bool {
    let (whole, fraction) = match text.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (text, None),
    };
    let digits = |s: &str| s.chars().all(|c| c.is_ascii_digit());
    let max_fraction = usize::try_from(decimals).unwrap_or(usize::MAX);
    digits(whole)
        && whole.len() <= 19
        && fraction.is_none_or(|f| digits(f) && f.len() <= max_fraction)
}

/// Parses a typed quantity such as `0.1` into lots. `None` unless the text is a positive
/// decimal with digits on both sides of any `.`, at most `decimals` fraction digits, and an
/// i64 result.
pub fn parse_qty(text: &str, decimals: u32) -> Option<Qty> {
    let text = text.trim();
    if !qty_text_allowed(text, decimals) {
        return None;
    }
    let (whole, fraction) = text.split_once('.').unwrap_or((text, ""));
    if whole.is_empty() || (text.contains('.') && fraction.is_empty()) {
        return None;
    }
    let width = usize::try_from(decimals).ok()?;
    let digits = format!("{whole}{fraction:0<width$}");
    let units: i64 = digits.parse().ok()?;
    (units > 0).then_some(Qty(units))
}

/// A quantity with trailing fraction zeros removed: `0.10000000` is `0.1`, a whole number has
/// no point.
pub fn format_qty_trimmed(qty: Qty) -> String {
    let fixed = format_fixed(qty.0, QTY_DECIMALS);
    if QTY_DECIMALS == 0 {
        return fixed;
    }
    fixed.trim_end_matches('0').trim_end_matches('.').to_owned()
}

/// Canonical command text for a ticket, in the form the server's formatter prints and its
/// parser accepts: `BUY BTC-USD 0.1 LMT 64000.00`, or without ` LMT ...` for a market order.
/// An incomplete ticket gives the text to show as a rejection and nothing to send.
pub fn ticket_command_text(
    symbol: &str,
    side: Side,
    limit_price: Option<Price>,
    qty: Option<Qty>,
) -> Result<String, String> {
    if instrument(symbol).is_none() {
        return Err("no symbol selected".to_owned());
    }
    let qty = match qty {
        Some(qty) if qty.0 > 0 => qty,
        _ => return Err("enter a quantity".to_owned()),
    };
    let word = match side {
        Side::Buy => "BUY",
        Side::Sell => "SELL",
    };
    let head = format!("{word} {symbol} {}", format_qty_trimmed(qty));
    match limit_price {
        None => Ok(head),
        Some(price) if price.0 > 0 => Ok(format!(
            "{head} LMT {}",
            format_fixed(price.0, PRICE_DECIMALS)
        )),
        Some(_) => Err("invalid limit price".to_owned()),
    }
}

// ---------------------------------------------------------------------------------------------
// Money (Req 28.1, 28.3)

/// Money (10^-10 USD) with `places` fraction digits, truncated toward zero. A negative value
/// that truncates to zero has no sign. The sum of several Money values fits in `i128`.
pub fn format_money(raw: i128, places: u32) -> String {
    let places = places.min(MONEY_DECIMALS);
    let scale = 10u128.pow(MONEY_DECIMALS - places);
    let truncated = raw.unsigned_abs() / scale;
    let unit = 10u128.pow(places);
    let sign = if raw < 0 && truncated > 0 { "-" } else { "" };
    let (whole, fraction) = (truncated / unit, truncated % unit);
    if places == 0 {
        format!("{sign}{whole}")
    } else {
        let width = usize::try_from(places).unwrap_or(0);
        format!("{sign}{whole}.{fraction:0width$}")
    }
}

/// [`format_money`] with the two places the panels show.
pub fn money_text(money: Money) -> String {
    format_money(i128::from(money.0), 2)
}

// ---------------------------------------------------------------------------------------------
// Preview timing (Req 22.1)

/// The time (epoch ms) when the preview stops being confirmable on this client. The server's
/// `expires_at` is trusted when it lies within the server's TTL of `first_seen_ms`; otherwise
/// (clock skew) the deadline is `first_seen_ms` plus the TTL.
pub fn preview_deadline(expires_at: i64, first_seen_ms: i64) -> i64 {
    let remaining = expires_at.saturating_sub(first_seen_ms);
    if remaining > 0 && remaining <= PREVIEW_TTL_MS + 5_000 {
        expires_at
    } else {
        first_seen_ms.saturating_add(PREVIEW_TTL_MS)
    }
}

/// Whole seconds left, rounded up, at least 0.
pub fn seconds_left(deadline_ms: i64, now_ms: i64) -> u64 {
    let ms = deadline_ms.saturating_sub(now_ms).max(0);
    u64::try_from(ms.saturating_add(999) / 1_000).unwrap_or(0)
}

// ---------------------------------------------------------------------------------------------
// Row and state types

/// The short order type shown in the open orders table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KindLabel {
    Market,
    Limit,
    Stop,
}

impl KindLabel {
    pub fn label(self) -> &'static str {
        match self {
            KindLabel::Market => "MKT",
            KindLabel::Limit => "LMT",
            KindLabel::Stop => "STP",
        }
    }
}

/// The label and the limit or stop price of an order kind.
pub fn kind_parts(kind: OrderKind) -> (KindLabel, Option<Price>) {
    match kind {
        OrderKind::Market => (KindLabel::Market, None),
        OrderKind::Limit { price } => (KindLabel::Limit, Some(price)),
        OrderKind::Stop { stop_price } => (KindLabel::Stop, Some(stop_price)),
    }
}

/// A confirmed `place` preview that has no `order_ack` yet. `order_ack` carries only the order
/// id, so the label of the open order comes from here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Placement {
    pub symbol: String,
    pub side: Side,
    pub kind: KindLabel,
    pub price: Option<Price>,
    pub qty: Qty,
}

/// The placement a confirmed preview action stands for; `None` for cancel-all and flatten-all.
pub fn placement_from_action(action: &PreviewAction) -> Option<Placement> {
    match action {
        PreviewAction::Place {
            symbol,
            side,
            qty,
            kind,
        } => {
            let (kind, price) = kind_parts(*kind);
            Some(Placement {
                symbol: symbol.clone(),
                side: *side,
                kind,
                price,
                qty: *qty,
            })
        }
        PreviewAction::CancelAll | PreviewAction::FlattenAll => None,
    }
}

/// One open order (Req 28.2). Fields the placement and the fills do not tell are `None`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenOrder {
    pub id: String,
    pub symbol: Option<String>,
    pub side: Option<Side>,
    pub kind: Option<KindLabel>,
    pub price: Option<Price>,
    /// Original quantity in lots; 0 while unknown.
    pub qty: i64,
    pub filled: i64,
    pub remaining: i64,
}

/// One open position (Req 28.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PositionRow {
    pub symbol: String,
    pub qty: Qty,
    pub avg_entry: Option<Price>,
    pub realized: Money,
    pub unrealized: Money,
}

/// A rejection shown for [`REJECTION_TTL_MS`] (Req 30.6).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rejection {
    pub order_id: Option<String>,
    pub reason: String,
    pub at_ms: i64,
}

/// A rejection reason as text: `max_order_value` reads as `max order value`.
pub fn rejection_text(reason: &str) -> String {
    reason.replace('_', " ")
}

/// The Order_Preview waiting for the user, with the request it answers (Req 22.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviewState {
    pub request_id: String,
    pub preview: OrderPreview,
    /// Epoch ms after which the dialog closes by itself.
    pub deadline_ms: i64,
}

/// A command the server could not parse (Req 21.5, 31.4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseErrorState {
    pub request_id: String,
    pub message: String,
    /// Character position of the first invalid token.
    pub position: usize,
}

/// An action that needs a yes/no dialog before anything is sent (Req 30.4, 30.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfirmAction {
    FlattenAll,
    CancelAll,
}

impl ConfirmAction {
    /// The question the dialog asks.
    pub fn question(self) -> &'static str {
        match self {
            ConfirmAction::FlattenAll => "Flatten every position?",
            ConfirmAction::CancelAll => "Cancel every open order?",
        }
    }
}

/// The headline of the preview dialog for the preview's action.
pub fn preview_action_label(action: &PreviewAction) -> &'static str {
    match action {
        PreviewAction::Place { .. } => "PLACE PAPER ORDER",
        PreviewAction::CancelAll => "CANCEL ALL OPEN ORDERS",
        PreviewAction::FlattenAll => "FLATTEN ALL POSITIONS",
    }
}

/// The column of the parse-error caret: the error position, kept inside the text.
pub fn caret_column(position: usize, text_chars: usize) -> usize {
    position.min(text_chars)
}

/// Request ids that are unique within one run of the TUI.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RequestIds {
    counter: u64,
}

impl RequestIds {
    /// A fresh id such as `t3-1a2b`. `salt` (the wall clock) tells runs apart.
    pub fn next(&mut self, salt: i64) -> String {
        self.counter = self.counter.saturating_add(1);
        format!("t{:x}-{:x}", self.counter, salt & 0xffff)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn texts(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_owned()).collect()
    }

    // Req 31.3
    #[test]
    fn history_ignores_blank_and_consecutive_duplicates_and_keeps_fifty() {
        let mut history = Vec::new();
        push_history(&mut history, "BUY BTC 1");
        push_history(&mut history, "   ");
        push_history(&mut history, "");
        push_history(&mut history, "BUY BTC 1");
        push_history(&mut history, "SELL BTC 1");
        push_history(&mut history, "BUY BTC 1");
        assert_eq!(history, texts(&["BUY BTC 1", "SELL BTC 1", "BUY BTC 1"]));
        for i in 0..80 {
            push_history(&mut history, &format!("cmd {i}"));
        }
        assert_eq!(history.len(), MAX_HISTORY);
        assert_eq!(history.last().map(String::as_str), Some("cmd 79"));
        assert_eq!(history.first().map(String::as_str), Some("cmd 30"));
    }

    // Req 31.3
    #[test]
    fn history_steps_walk_back_and_return_to_the_draft() {
        let history = texts(&["a", "b", "c"]);
        let step = |index, direction| history_step(&history, index, direction);
        // Up from the draft shows the newest entry, then older ones, and stops at the oldest.
        let s = step(None, HistoryDirection::Prev);
        assert_eq!((s.index, s.text.as_deref()), (Some(2), Some("c")));
        let s = step(Some(2), HistoryDirection::Prev);
        assert_eq!((s.index, s.text.as_deref()), (Some(1), Some("b")));
        let s = step(Some(0), HistoryDirection::Prev);
        assert_eq!((s.index, s.text.as_deref()), (Some(0), Some("a")));
        // Down walks forward, and past the newest entry restores the draft.
        let s = step(Some(1), HistoryDirection::Next);
        assert_eq!((s.index, s.text.as_deref()), (Some(2), Some("c")));
        let s = step(Some(2), HistoryDirection::Next);
        assert_eq!((s.index, s.text), (None, None));
        // Down while not browsing, and any step over an empty history, do nothing.
        let s = step(None, HistoryDirection::Next);
        assert_eq!((s.index, s.text), (None, None));
        let s = history_step(&[], None, HistoryDirection::Prev);
        assert_eq!((s.index, s.text), (None, None));
    }

    // Req 30.2
    #[test]
    fn quantity_text_is_validated_against_the_decimals() {
        assert!(qty_text_allowed("", 8));
        assert!(qty_text_allowed("1.", 8));
        assert!(qty_text_allowed("0.12345678", 8));
        assert!(!qty_text_allowed("0.123456789", 8));
        assert!(!qty_text_allowed("1.2.3", 8));
        assert!(!qty_text_allowed("-1", 8));
        assert!(!qty_text_allowed("1e5", 8));
        assert_eq!(parse_qty("0.1", 8), Some(Qty(10_000_000)));
        assert_eq!(parse_qty("2", 8), Some(Qty(200_000_000)));
        assert_eq!(parse_qty(" 0.00000001 ", 8), Some(Qty(1)));
        assert_eq!(parse_qty("0", 8), None);
        assert_eq!(parse_qty("0.00000000", 8), None);
        assert_eq!(parse_qty("", 8), None);
        assert_eq!(parse_qty("1.", 8), None);
        assert_eq!(parse_qty(".5", 8), None);
        assert_eq!(parse_qty("0.123456789", 8), None);
        // 10^11 whole units at 8 decimals does not fit in an i64.
        assert_eq!(parse_qty("100000000000", 8), None);
        assert_eq!(parse_qty("92233720368", 8), Some(Qty(9_223_372_036_800_000_000)));
    }

    #[test]
    fn quantities_trim_trailing_zeros() {
        assert_eq!(format_qty_trimmed(Qty(10_000_000)), "0.1");
        assert_eq!(format_qty_trimmed(Qty(200_000_000)), "2");
        assert_eq!(format_qty_trimmed(Qty(1)), "0.00000001");
        assert_eq!(format_qty_trimmed(Qty(123_456_780)), "1.2345678");
    }

    // Req 30.2: the ticket becomes the canonical text; it never places an order itself.
    #[test]
    fn a_ticket_becomes_canonical_command_text() {
        let qty = Some(Qty(10_000_000));
        assert_eq!(
            ticket_command_text("BTC-USD", Side::Buy, Some(Price(6_400_000)), qty),
            Ok("BUY BTC-USD 0.1 LMT 64000.00".to_owned())
        );
        assert_eq!(
            ticket_command_text("ETH-USD", Side::Sell, None, Some(Qty(200_000_000))),
            Ok("SELL ETH-USD 2".to_owned())
        );
        assert_eq!(
            ticket_command_text("BTC-USD", Side::Buy, Some(Price(5)), Some(Qty(1))),
            Ok("BUY BTC-USD 0.00000001 LMT 0.05".to_owned())
        );
    }

    #[test]
    fn an_incomplete_ticket_gives_an_error_and_no_text() {
        let price = Some(Price(100));
        assert_eq!(
            ticket_command_text("BTC-USD", Side::Buy, price, None),
            Err("enter a quantity".to_owned())
        );
        assert_eq!(
            ticket_command_text("BTC-USD", Side::Buy, price, Some(Qty(0))),
            Err("enter a quantity".to_owned())
        );
        assert_eq!(
            ticket_command_text("", Side::Buy, price, Some(Qty(1))),
            Err("no symbol selected".to_owned())
        );
        assert_eq!(
            ticket_command_text("DOGE-USD", Side::Buy, None, Some(Qty(1))),
            Err("no symbol selected".to_owned())
        );
        assert_eq!(
            ticket_command_text("BTC-USD", Side::Buy, Some(Price(0)), Some(Qty(1))),
            Err("invalid limit price".to_owned())
        );
    }

    // Req 28.1, 28.3
    #[test]
    fn money_is_truncated_toward_zero_with_a_sign_only_when_visible() {
        assert_eq!(format_money(123_456_789_012, 2), "12.34");
        assert_eq!(format_money(-123_456_789_012, 2), "-12.34");
        assert_eq!(format_money(0, 2), "0.00");
        // -0.004 truncates to zero and shows no sign.
        assert_eq!(format_money(-40_000_000, 2), "0.00");
        assert_eq!(format_money(10_000_000_000, 0), "1");
        assert!(format_money(i128::from(i64::MAX) * 3, 2).contains('.'));
        assert_eq!(money_text(Money(25_000_000_000)), "2.50");
    }

    // Req 22.1
    #[test]
    fn the_preview_deadline_trusts_the_server_unless_the_clock_is_off() {
        // Within the TTL: the server's time.
        assert_eq!(preview_deadline(1_030_000, 1_000_000), 1_030_000);
        // Already past, or far in the future: the local TTL.
        assert_eq!(preview_deadline(900_000, 1_000_000), 1_060_000);
        assert_eq!(preview_deadline(9_000_000, 1_000_000), 1_060_000);
        assert_eq!(seconds_left(1_030_000, 1_000_000), 30);
        assert_eq!(seconds_left(1_030_000, 1_000_001), 30);
        assert_eq!(seconds_left(1_030_000, 1_029_001), 1);
        assert_eq!(seconds_left(1_030_000, 1_030_000), 0);
        assert_eq!(seconds_left(1_030_000, 2_000_000), 0);
    }

    #[test]
    fn placements_come_from_place_actions_only() {
        let place = PreviewAction::Place {
            symbol: "BTC-USD".into(),
            side: Side::Sell,
            qty: Qty(5),
            kind: OrderKind::Limit {
                price: Price(6_400_000),
            },
        };
        assert_eq!(
            placement_from_action(&place),
            Some(Placement {
                symbol: "BTC-USD".into(),
                side: Side::Sell,
                kind: KindLabel::Limit,
                price: Some(Price(6_400_000)),
                qty: Qty(5),
            })
        );
        assert_eq!(placement_from_action(&PreviewAction::CancelAll), None);
        assert_eq!(placement_from_action(&PreviewAction::FlattenAll), None);
        assert_eq!(kind_parts(OrderKind::Market), (KindLabel::Market, None));
        assert_eq!(
            kind_parts(OrderKind::Stop {
                stop_price: Price(7)
            }),
            (KindLabel::Stop, Some(Price(7)))
        );
    }

    #[test]
    fn labels_and_texts() {
        assert_eq!(KindLabel::Market.label(), "MKT");
        assert_eq!(KindLabel::Limit.label(), "LMT");
        assert_eq!(KindLabel::Stop.label(), "STP");
        assert_eq!(rejection_text("max_order_value"), "max order value");
        assert_eq!(ConfirmAction::FlattenAll.question(), "Flatten every position?");
        assert_eq!(ConfirmAction::CancelAll.question(), "Cancel every open order?");
        assert_eq!(caret_column(4, 10), 4);
        assert_eq!(caret_column(40, 10), 10);
    }

    #[test]
    fn request_ids_are_unique() {
        let mut ids = RequestIds::default();
        let a = ids.next(1_700_000_000_123);
        let b = ids.next(1_700_000_000_123);
        assert_ne!(a, b);
        assert!(a.starts_with("t1-") && b.starts_with("t2-"));
    }

    proptest! {
        // Any amount in lots written as decimal text parses back to the same lots.
        #[test]
        fn quantity_text_round_trips(lots in 1i64..=i64::MAX) {
            let text = format_qty_trimmed(Qty(lots));
            prop_assert!(qty_text_allowed(&text, QTY_DECIMALS));
            prop_assert_eq!(parse_qty(&text, QTY_DECIMALS), Some(Qty(lots)));
        }

        // The history never holds more than 50 entries, whatever is submitted.
        #[test]
        fn history_is_bounded(items in proptest::collection::vec("[a-z ]{0,6}", 0..120)) {
            let mut history = Vec::new();
            for item in &items {
                push_history(&mut history, item);
                prop_assert!(history.len() <= MAX_HISTORY);
            }
            prop_assert!(history.windows(2).all(|w| w[0] != w[1]));
        }
    }
}
