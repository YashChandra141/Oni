//! Keyboard and mouse handling for order entry (Task 12.4, Req 22, 28, 30, 31).
//!
//! Everything here is pure: [`decide_key`] turns a key into a [`KeyCommand`] from the app state
//! and the shared keymap, and [`apply_key_command`] changes the app and returns the messages to
//! send. The event loop in `main.rs` only routes. Nothing here places an order: B and S send
//! `command_text` and wait for the server's preview (Req 22.4); F and X open a dialog first
//! (Req 30.4, 30.5); only a confirmed dialog sends `flatten_all`, `cancel_all`, or `confirm`.
//!
//! Focus priority is dialog > command > ticket > orders > book/chart > global, the same order
//! the web uses in `web/lib/orderKeys.ts`. Inside a dialog only the dialog keys do anything, so
//! B, S, F, and X cannot open a second order while the user decides. Inside the command bar
//! only the command keys and text editing apply, so letters type text.

// Part of the API (such as `Focus::context`) is used only by tests.
#![allow(dead_code)]

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use protocol::client::ClientMessage;
use protocol::{OrderId, Side};

use crate::app::App;
use crate::chart_model::QTY_DECIMALS;
use crate::keymap::{Action, Context, Keymap, chord_from_crossterm, resolve};
use crate::line_editor::LineEditor;
use crate::mouse::MouseAction;
use crate::order_model::{
    ConfirmAction, HistoryDirection, history_step, push_history, qty_text_allowed,
    ticket_command_text,
};

/// Which part of the screen has the keyboard.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Focus {
    #[default]
    Chart,
    /// The book has a cursor (derived from `book_cursor`, never stored in `App::focus`).
    Book,
    Orders,
    /// The quantity field of the ticket line.
    Ticket,
    Command,
    /// A preview or confirm dialog is open (derived, never stored in `App::focus`).
    Dialog,
}

impl Focus {
    /// The keymap context of this focus. The ticket line has no context of its own.
    pub fn context(self) -> Context {
        match self {
            Focus::Chart => Context::Chart,
            Focus::Book => Context::Book,
            Focus::Orders => Context::Orders,
            Focus::Ticket => Context::Global,
            Focus::Command => Context::Command,
            Focus::Dialog => Context::Dialog,
        }
    }
}

/// The focus now: a dialog wins, then the stored focus, then the book cursor.
pub fn effective_focus(app: &App) -> Focus {
    if app.account.dialog_open() {
        Focus::Dialog
    } else if app.focus != Focus::Chart {
        app.focus
    } else if app.book_cursor.is_some() {
        Focus::Book
    } else {
        Focus::Chart
    }
}

/// True while keys must not reach the global handlers (quit, pairing, chart keys): a dialog is
/// open or the command bar is taking text.
pub fn blocks_global_keys(app: &App) -> bool {
    matches!(effective_focus(app), Focus::Dialog | Focus::Command)
}

// ---------------------------------------------------------------------------------------------
// Text editing

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditOp {
    Insert(char),
    Backspace,
    Delete,
    Left,
    Right,
    Home,
    End,
}

/// Applies one edit. Returns whether the text or the cursor changed.
pub fn apply_edit(editor: &mut LineEditor, op: EditOp) -> bool {
    match op {
        EditOp::Insert(c) => editor.insert(c),
        EditOp::Backspace => editor.backspace(),
        EditOp::Delete => editor.delete(),
        EditOp::Left => editor.left(),
        EditOp::Right => editor.right(),
        EditOp::Home => editor.home(),
        EditOp::End => editor.end(),
    }
}

fn has_command_modifier(key: &KeyEvent) -> bool {
    key.modifiers.intersects(
        KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SUPER | KeyModifiers::META,
    )
}

fn edit_op_for_navigation(code: KeyCode) -> Option<EditOp> {
    match code {
        KeyCode::Backspace => Some(EditOp::Backspace),
        KeyCode::Delete => Some(EditOp::Delete),
        KeyCode::Left => Some(EditOp::Left),
        KeyCode::Right => Some(EditOp::Right),
        KeyCode::Home => Some(EditOp::Home),
        KeyCode::End => Some(EditOp::End),
        _ => None,
    }
}

/// The edit a key makes in a text field: a character, or a navigation key.
fn edit_op_for_key(key: &KeyEvent) -> Option<EditOp> {
    match key.code {
        KeyCode::Char(c) if !has_command_modifier(key) => Some(EditOp::Insert(c)),
        code => edit_op_for_navigation(code),
    }
}

/// The command bar's text, history, and the request it last sent (Req 31).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CommandLine {
    pub editor: LineEditor,
    /// Submitted texts, oldest first, at most 50 (Req 31.3).
    pub history: Vec<String>,
    /// The history position while browsing with Up and Down.
    pub history_index: Option<usize>,
    /// The text being typed when browsing started.
    draft: String,
    /// The request id of the text sent from the bar; its preview clears the bar (Req 31.4).
    pub submitted: Option<String>,
}

impl CommandLine {
    /// Applies a text edit. Changing the text ends history browsing.
    pub fn edit(&mut self, op: EditOp) -> bool {
        let changed = apply_edit(&mut self.editor, op);
        if changed && matches!(op, EditOp::Insert(_) | EditOp::Backspace | EditOp::Delete) {
            self.history_index = None;
        }
        changed
    }

    /// One Up or Down step through the history (Req 31.3). Down while not browsing does nothing;
    /// Up saves the text being typed as the draft, and Down past the newest entry restores it.
    pub fn step_history(&mut self, direction: HistoryDirection) -> bool {
        if self.history_index.is_none() {
            if direction == HistoryDirection::Next || self.history.is_empty() {
                return false;
            }
            self.draft = self.editor.text().to_owned();
        }
        let step = history_step(&self.history, self.history_index, direction);
        self.history_index = step.index;
        match step.text {
            Some(text) => self.editor.set(&text),
            None => self.editor.set(&self.draft),
        }
        true
    }

    /// The preview of the submitted text arrived: the bar is ready for the next command.
    pub fn after_preview(&mut self) {
        self.editor.clear();
        self.history_index = None;
        self.submitted = None;
    }
}

// ---------------------------------------------------------------------------------------------
// Keys

/// What a key press does to the order entry state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyCommand {
    Buy,
    Sell,
    AskFlatten,
    AskCancelAll,
    FocusCommand,
    /// An edit in the command bar.
    Command(EditOp),
    HistoryPrev,
    HistoryNext,
    Submit,
    Blur,
    /// An edit in the ticket quantity field.
    Ticket(EditOp),
    /// `M` in the ticket: clear the limit price, so the order is a market order.
    TicketMarket,
    /// Enter or Escape in the ticket quantity field.
    TicketDone,
    DialogConfirm,
    DialogCancel,
    OrdersUp,
    OrdersDown,
    CancelSelected,
    LeaveOrders,
    /// A key that a modal part of the screen (dialog or command bar) takes and ignores.
    Swallow,
}

/// What a global keymap action does for order entry, if anything.
fn global_action_command(action: Action) -> Option<KeyCommand> {
    match action {
        Action::OrderBuy => Some(KeyCommand::Buy),
        Action::OrderSell => Some(KeyCommand::Sell),
        Action::AccountFlatten => Some(KeyCommand::AskFlatten),
        Action::OrdersCancelAll => Some(KeyCommand::AskCancelAll),
        Action::CommandFocus => Some(KeyCommand::FocusCommand),
        _ => None,
    }
}

fn global_order_command(keymap: &Keymap, chord: Option<&str>) -> Option<KeyCommand> {
    chord
        .and_then(|c| resolve(keymap, Context::Global, c))
        .and_then(global_action_command)
}

fn dialog_command(keymap: &Keymap, chord: Option<&str>) -> KeyCommand {
    match chord.and_then(|c| resolve(keymap, Context::Dialog, c)) {
        Some(Action::DialogConfirm) => KeyCommand::DialogConfirm,
        Some(Action::DialogCancel) => KeyCommand::DialogCancel,
        _ => KeyCommand::Swallow,
    }
}

fn command_bar_command(keymap: &Keymap, key: &KeyEvent, chord: Option<&str>) -> KeyCommand {
    match chord.and_then(|c| resolve(keymap, Context::Command, c)) {
        Some(Action::HistoryPrev) => KeyCommand::HistoryPrev,
        Some(Action::HistoryNext) => KeyCommand::HistoryNext,
        Some(Action::CommandSubmit) => KeyCommand::Submit,
        Some(Action::CommandBlur) => KeyCommand::Blur,
        _ => edit_op_for_key(key).map_or(KeyCommand::Swallow, KeyCommand::Command),
    }
}

fn ticket_command(
    app: &App,
    keymap: &Keymap,
    key: &KeyEvent,
    chord: Option<&str>,
) -> Option<KeyCommand> {
    match key.code {
        KeyCode::Esc => return Some(KeyCommand::TicketDone),
        // With a book cursor, Enter keeps prefilling from the book (`book.prefill`).
        KeyCode::Enter if app.book_cursor.is_none() => return Some(KeyCommand::TicketDone),
        KeyCode::Char('m' | 'M') if !has_command_modifier(key) => {
            return Some(KeyCommand::TicketMarket);
        }
        KeyCode::Char(c) if (c.is_ascii_digit() || c == '.') && !has_command_modifier(key) => {
            return Some(KeyCommand::Ticket(EditOp::Insert(c)));
        }
        code => {
            if let Some(op) = edit_op_for_navigation(code) {
                return Some(KeyCommand::Ticket(op));
            }
        }
    }
    global_order_command(keymap, chord)
}

fn orders_command(keymap: &Keymap, key: &KeyEvent, chord: Option<&str>) -> Option<KeyCommand> {
    if key.code == KeyCode::Esc {
        return Some(KeyCommand::LeaveOrders);
    }
    match chord.and_then(|c| resolve(keymap, Context::Orders, c))? {
        Action::OrdersUp => Some(KeyCommand::OrdersUp),
        Action::OrdersDown => Some(KeyCommand::OrdersDown),
        Action::OrderCancel => Some(KeyCommand::CancelSelected),
        other => global_action_command(other),
    }
}

/// What `key` does for order entry, or `None` when it is not an order entry key and the other
/// handlers (chart, book, watchlist, quit, pairing) should see it. Pure.
pub fn decide_key(app: &App, keymap: &Keymap, key: &KeyEvent) -> Option<KeyCommand> {
    if key.kind == KeyEventKind::Release {
        return None;
    }
    let chord = chord_from_crossterm(key);
    let chord = chord.as_deref();
    match effective_focus(app) {
        Focus::Dialog => Some(dialog_command(keymap, chord)),
        Focus::Command => Some(command_bar_command(keymap, key, chord)),
        Focus::Ticket => ticket_command(app, keymap, key, chord),
        Focus::Orders => orders_command(keymap, key, chord),
        Focus::Chart | Focus::Book => global_order_command(keymap, chord),
    }
}

// ---------------------------------------------------------------------------------------------
// Applying commands

/// What an applied key or click changed.
#[derive(Debug, Default, PartialEq)]
pub struct KeyOutcome {
    /// Whether the screen needs a redraw.
    pub changed: bool,
    /// The messages to send to the server, in order.
    pub messages: Vec<ClientMessage>,
}

impl KeyOutcome {
    fn changed(changed: bool) -> Self {
        Self {
            changed,
            messages: Vec::new(),
        }
    }

    fn send(message: ClientMessage) -> Self {
        Self {
            changed: true,
            messages: vec![message],
        }
    }
}

/// Builds the ticket's command text and sends it as `command_text` (Req 30.2). An incomplete
/// ticket shows a rejection and sends nothing. The ticket never places an order itself.
fn submit_ticket(app: &mut App, side: Side, now_ms: i64) -> KeyOutcome {
    let symbol = app.symbol.clone();
    match ticket_command_text(&symbol, side, app.ticket_limit_price(), app.ticket.qty) {
        Err(reason) => {
            app.account.add_rejection(&reason, now_ms);
            KeyOutcome::changed(true)
        }
        Ok(text) => {
            let request_id = app.request_ids.next(now_ms);
            // Ticket orders are not typed, so they stay out of the command history.
            app.account.command_sent(&request_id);
            // Task 16.3 sends the TUI's Active_Venue; until then the server picks its default.
            KeyOutcome::send(ClientMessage::CommandText {
                request_id,
                text,
                venue: None,
            })
        }
    }
}

/// Sends the command bar text as `command_text` with a fresh request id and records it in the
/// history. The text stays until the matching preview arrives (Req 31.1, 31.4).
fn submit_command(app: &mut App, now_ms: i64) -> KeyOutcome {
    let text = app.command.editor.text().to_owned();
    if text.trim().is_empty() {
        return KeyOutcome::default();
    }
    let request_id = app.request_ids.next(now_ms);
    app.account.command_sent(&request_id);
    push_history(&mut app.command.history, &text);
    app.command.history_index = None;
    app.command.submitted = Some(request_id.clone());
    // Task 16.3 sends the TUI's Active_Venue; until then the server picks its default.
    KeyOutcome::send(ClientMessage::CommandText {
        request_id,
        text,
        venue: None,
    })
}

/// Enter or Y in a dialog: sends `flatten_all` or `cancel_all` for the confirm dialog, or
/// `confirm` for the preview (Req 22.2, 30.4, 30.5).
fn confirm_dialog(app: &mut App, now_ms: i64) -> KeyOutcome {
    if let Some(action) = app.account.clear_confirm() {
        let request_id = app.request_ids.next(now_ms);
        let message = match action {
            ConfirmAction::FlattenAll => ClientMessage::FlattenAll { request_id },
            ConfirmAction::CancelAll => ClientMessage::CancelAll { request_id },
        };
        return KeyOutcome::send(message);
    }
    match app.account.take_preview_for_confirm() {
        Some(preview_id) => {
            let request_id = app.request_ids.next(now_ms);
            KeyOutcome::send(ClientMessage::Confirm {
                request_id,
                preview_id,
            })
        }
        None => KeyOutcome::default(),
    }
}

/// Escape or N in a dialog: the confirm dialog closes and sends nothing; a preview is discarded
/// with `discard` (Req 22.3).
fn cancel_dialog(app: &mut App) -> KeyOutcome {
    if app.account.clear_confirm().is_some() {
        return KeyOutcome::changed(true);
    }
    match app.account.take_preview_for_discard() {
        Some(preview_id) => KeyOutcome::send(ClientMessage::Discard { preview_id }),
        None => KeyOutcome::default(),
    }
}

fn cancel_order(app: &mut App, id: &str, now_ms: i64) -> KeyOutcome {
    match OrderId::new(id) {
        Ok(order_id) => {
            let request_id = app.request_ids.next(now_ms);
            KeyOutcome::send(ClientMessage::Cancel {
                request_id,
                order_id,
            })
        }
        Err(_) => KeyOutcome::default(),
    }
}

fn set_focus(app: &mut App, focus: Focus) -> bool {
    let changed = app.focus != focus;
    app.focus = focus;
    changed
}

/// Edits the ticket quantity. Text that could not become a valid quantity (a letter, a second
/// point, too many decimals) is refused.
fn edit_ticket_qty(app: &mut App, op: EditOp) -> bool {
    let before = app.ticket_qty.clone();
    let changed = apply_edit(&mut app.ticket_qty, op);
    if !qty_text_allowed(app.ticket_qty.text(), QTY_DECIMALS) {
        app.ticket_qty = before;
        return false;
    }
    app.sync_ticket_qty();
    changed
}

/// Applies a decided key command. `now_ms` is the wall clock for request ids and rejections.
pub fn apply_key_command(app: &mut App, command: KeyCommand, now_ms: i64) -> KeyOutcome {
    match command {
        KeyCommand::Buy => submit_ticket(app, Side::Buy, now_ms),
        KeyCommand::Sell => submit_ticket(app, Side::Sell, now_ms),
        KeyCommand::AskFlatten => {
            app.account.request_confirm(ConfirmAction::FlattenAll);
            KeyOutcome::changed(true)
        }
        KeyCommand::AskCancelAll => {
            app.account.request_confirm(ConfirmAction::CancelAll);
            KeyOutcome::changed(true)
        }
        KeyCommand::FocusCommand => KeyOutcome::changed(set_focus(app, Focus::Command)),
        KeyCommand::Command(op) => KeyOutcome::changed(app.command.edit(op)),
        KeyCommand::HistoryPrev => {
            KeyOutcome::changed(app.command.step_history(HistoryDirection::Prev))
        }
        KeyCommand::HistoryNext => {
            KeyOutcome::changed(app.command.step_history(HistoryDirection::Next))
        }
        KeyCommand::Submit => submit_command(app, now_ms),
        KeyCommand::Blur | KeyCommand::TicketDone | KeyCommand::LeaveOrders => {
            KeyOutcome::changed(set_focus(app, Focus::Chart))
        }
        KeyCommand::Ticket(op) => KeyOutcome::changed(edit_ticket_qty(app, op)),
        KeyCommand::TicketMarket => {
            let changed = app.ticket.limit_price.is_some();
            app.ticket.limit_price = None;
            KeyOutcome::changed(changed)
        }
        KeyCommand::DialogConfirm => confirm_dialog(app, now_ms),
        KeyCommand::DialogCancel => cancel_dialog(app),
        KeyCommand::OrdersUp => KeyOutcome::changed(app.account.move_selection(true)),
        KeyCommand::OrdersDown => KeyOutcome::changed(app.account.move_selection(false)),
        KeyCommand::CancelSelected => match app.account.selected_order.clone() {
            Some(id) => cancel_order(app, &id, now_ms),
            None => KeyOutcome::default(),
        },
        KeyCommand::Swallow => KeyOutcome::default(),
    }
}

/// Applies a mouse action that belongs to order entry. Returns `None` for the other actions
/// (chart, book, watchlist) when no dialog is open. While a dialog is open every action but the
/// two dialog buttons is swallowed, so the dialog is modal for the mouse too.
pub fn apply_order_mouse(app: &mut App, action: &MouseAction, now_ms: i64) -> Option<KeyOutcome> {
    if app.account.dialog_open() {
        return Some(match action {
            MouseAction::DialogConfirm => confirm_dialog(app, now_ms),
            MouseAction::DialogCancel => cancel_dialog(app),
            _ => KeyOutcome::default(),
        });
    }
    match action {
        MouseAction::CancelOrder(id) => Some(cancel_order(app, id, now_ms)),
        MouseAction::SelectOrder(id) => {
            let focused = set_focus(app, Focus::Orders);
            let selected = app.account.select_order(id);
            Some(KeyOutcome::changed(focused || selected))
        }
        MouseAction::TicketBuy => Some(submit_ticket(app, Side::Buy, now_ms)),
        MouseAction::TicketSell => Some(submit_ticket(app, Side::Sell, now_ms)),
        MouseAction::FocusTicket => Some(KeyOutcome::changed(set_focus(app, Focus::Ticket))),
        MouseAction::FocusCommand => Some(KeyOutcome::changed(set_focus(app, Focus::Command))),
        MouseAction::FocusOrders => Some(KeyOutcome::changed(set_focus(app, Focus::Orders))),
        MouseAction::DialogConfirm | MouseAction::DialogCancel => Some(KeyOutcome::default()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::update;
    use crate::net::NetEvent;
    use protocol::client::{OrderPreview, PreviewAction, ServerMessage};
    use protocol::{AccountId, Event, Money, OrderKind, OrderStatus, Price, Qty};

    fn keymap() -> Keymap {
        Keymap::embedded().unwrap()
    }

    fn press(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn ch(c: char) -> KeyEvent {
        press(KeyCode::Char(c))
    }

    fn decide(app: &App, key: KeyEvent) -> Option<KeyCommand> {
        decide_key(app, &keymap(), &key)
    }

    /// Decides and applies a key, as the event loop does.
    fn send_key(app: &mut App, key: KeyEvent) -> KeyOutcome {
        match decide(app, key) {
            Some(command) => apply_key_command(app, command, 1_000),
            None => KeyOutcome::default(),
        }
    }

    fn type_text(app: &mut App, text: &str) {
        for c in text.chars() {
            send_key(app, ch(c));
        }
    }

    fn preview_message(request_id: &str, preview_id: &str, action: PreviewAction) -> NetEvent {
        NetEvent::Message(ServerMessage::Preview {
            request_id: request_id.into(),
            preview: OrderPreview {
                preview_id: preview_id.into(),
                text: "BUY BTC-USD 0.1 LMT 64000.00".into(),
                action,
                expires_at: 30_000,
            },
        })
    }

    fn place_action() -> PreviewAction {
        PreviewAction::Place {
            symbol: "BTC-USD".into(),
            venue: protocol::Venue::Replay,
            side: Side::Buy,
            qty: Qty(10_000_000),
            kind: OrderKind::Limit {
                price: Price(6_400_000),
            },
        }
    }

    /// An app with an open preview for request `r1`.
    fn app_with_preview() -> App {
        let mut app = App::new("ws://x/ws");
        app.account.command_sent("r1");
        update(&mut app, preview_message("r1", "p1", place_action()));
        assert!(app.account.preview.is_some());
        app
    }

    // Req 30.2, 30.4, 30.5, 31.1
    #[test]
    fn b_s_f_x_and_colon_resolve_through_the_keymap() {
        let app = App::new("ws://x/ws");
        assert_eq!(decide(&app, ch('b')), Some(KeyCommand::Buy));
        assert_eq!(decide(&app, ch('B')), Some(KeyCommand::Buy));
        assert_eq!(decide(&app, ch('s')), Some(KeyCommand::Sell));
        assert_eq!(decide(&app, ch('f')), Some(KeyCommand::AskFlatten));
        assert_eq!(decide(&app, ch('x')), Some(KeyCommand::AskCancelAll));
        assert_eq!(decide(&app, ch(':')), Some(KeyCommand::FocusCommand));
        // Other keys are not order entry keys.
        assert_eq!(decide(&app, ch('q')), None);
        assert_eq!(decide(&app, ch('1')), None);
        assert_eq!(decide(&app, press(KeyCode::Tab)), None);
        assert_eq!(decide(&app, press(KeyCode::Up)), None);
        assert_eq!(decide(&app, press(KeyCode::Enter)), None);
        // A modifier makes it a different key.
        let ctrl_b = KeyEvent::new(KeyCode::Char('b'), KeyModifiers::CONTROL);
        assert_eq!(decide(&app, ctrl_b), None);
        // A release is never a command.
        let release = KeyEvent::new_with_kind(
            KeyCode::Char('b'),
            KeyModifiers::NONE,
            KeyEventKind::Release,
        );
        assert_eq!(decide(&app, release), None);
    }

    // Req 22.2, 22.3
    #[test]
    fn dialog_keys_confirm_or_cancel_and_everything_else_is_swallowed() {
        let app = app_with_preview();
        assert_eq!(effective_focus(&app), Focus::Dialog);
        assert_eq!(
            decide(&app, press(KeyCode::Enter)),
            Some(KeyCommand::DialogConfirm)
        );
        assert_eq!(decide(&app, ch('y')), Some(KeyCommand::DialogConfirm));
        assert_eq!(decide(&app, ch('Y')), Some(KeyCommand::DialogConfirm));
        assert_eq!(
            decide(&app, press(KeyCode::Esc)),
            Some(KeyCommand::DialogCancel)
        );
        assert_eq!(decide(&app, ch('n')), Some(KeyCommand::DialogCancel));
        for key in [
            ch('b'),
            ch('s'),
            ch('f'),
            ch('x'),
            ch(':'),
            ch('q'),
            press(KeyCode::Tab),
        ] {
            assert_eq!(decide(&app, key), Some(KeyCommand::Swallow), "{key:?}");
        }
        assert!(blocks_global_keys(&app));
    }

    // Req 31.1
    #[test]
    fn the_command_bar_takes_letters_as_text() {
        let mut app = App::new("ws://x/ws");
        assert!(apply_key_command(&mut app, KeyCommand::FocusCommand, 0).changed);
        assert_eq!(effective_focus(&app), Focus::Command);
        assert!(blocks_global_keys(&app));
        // `q`, `b`, and `p` are text here, not quit, buy, or pairing.
        assert_eq!(
            decide(&app, ch('q')),
            Some(KeyCommand::Command(EditOp::Insert('q')))
        );
        assert_eq!(
            decide(&app, ch('b')),
            Some(KeyCommand::Command(EditOp::Insert('b')))
        );
        assert_eq!(
            decide(&app, ch('P')),
            Some(KeyCommand::Command(EditOp::Insert('P')))
        );
        assert_eq!(
            decide(&app, press(KeyCode::Enter)),
            Some(KeyCommand::Submit)
        );
        assert_eq!(decide(&app, press(KeyCode::Esc)), Some(KeyCommand::Blur));
        assert_eq!(
            decide(&app, press(KeyCode::Up)),
            Some(KeyCommand::HistoryPrev)
        );
        assert_eq!(
            decide(&app, press(KeyCode::Down)),
            Some(KeyCommand::HistoryNext)
        );
        assert_eq!(
            decide(&app, press(KeyCode::Backspace)),
            Some(KeyCommand::Command(EditOp::Backspace))
        );
        assert_eq!(decide(&app, press(KeyCode::Tab)), Some(KeyCommand::Swallow));
        let ctrl_x = KeyEvent::new(KeyCode::Char('x'), KeyModifiers::CONTROL);
        assert_eq!(decide(&app, ctrl_x), Some(KeyCommand::Swallow));
    }

    // Req 30.3
    #[test]
    fn the_orders_panel_binds_up_down_and_delete() {
        let mut app = App::new("ws://x/ws");
        app.focus = Focus::Orders;
        assert_eq!(decide(&app, press(KeyCode::Up)), Some(KeyCommand::OrdersUp));
        assert_eq!(
            decide(&app, press(KeyCode::Down)),
            Some(KeyCommand::OrdersDown)
        );
        assert_eq!(
            decide(&app, press(KeyCode::Delete)),
            Some(KeyCommand::CancelSelected)
        );
        assert_eq!(
            decide(&app, press(KeyCode::Esc)),
            Some(KeyCommand::LeaveOrders)
        );
        // The global order keys still work, other keys fall through.
        assert_eq!(decide(&app, ch('b')), Some(KeyCommand::Buy));
        assert_eq!(decide(&app, ch('f')), Some(KeyCommand::AskFlatten));
        assert_eq!(decide(&app, ch('1')), None);
        // Delete does nothing outside the orders panel.
        app.focus = Focus::Chart;
        assert_eq!(decide(&app, press(KeyCode::Delete)), None);
    }

    // Req 30.2
    #[test]
    fn the_ticket_takes_quantity_characters() {
        let mut app = App::new("ws://x/ws");
        app.focus = Focus::Ticket;
        assert_eq!(
            decide(&app, ch('5')),
            Some(KeyCommand::Ticket(EditOp::Insert('5')))
        );
        assert_eq!(
            decide(&app, ch('.')),
            Some(KeyCommand::Ticket(EditOp::Insert('.')))
        );
        assert_eq!(decide(&app, ch('m')), Some(KeyCommand::TicketMarket));
        assert_eq!(
            decide(&app, press(KeyCode::Enter)),
            Some(KeyCommand::TicketDone)
        );
        assert_eq!(
            decide(&app, press(KeyCode::Esc)),
            Some(KeyCommand::TicketDone)
        );
        assert_eq!(decide(&app, ch('b')), Some(KeyCommand::Buy));
        assert_eq!(decide(&app, ch('q')), None);
    }

    #[test]
    fn the_ticket_quantity_is_validated_against_the_decimals() {
        let mut app = App::new("ws://x/ws");
        app.focus = Focus::Ticket;
        type_text(&mut app, "0.1");
        assert_eq!(app.ticket_qty.text(), "0.1");
        assert_eq!(app.ticket.qty, Some(Qty(10_000_000)));
        // A second point and a ninth decimal are refused.
        type_text(&mut app, ".");
        assert_eq!(app.ticket_qty.text(), "0.1");
        type_text(&mut app, "23456789");
        assert_eq!(app.ticket_qty.text(), "0.12345678");
        assert_eq!(app.ticket.qty, Some(Qty(12_345_678)));
        // An unfinished number is not a quantity yet.
        send_key(&mut app, press(KeyCode::Backspace));
        for _ in 0..8 {
            send_key(&mut app, press(KeyCode::Backspace));
        }
        assert_eq!(app.ticket_qty.text(), "0");
        assert_eq!(app.ticket.qty, None);
    }

    // Req 30.2
    #[test]
    fn buy_and_sell_send_the_canonical_command_text_and_never_place_directly() {
        let mut app = App::new("ws://x/ws");
        app.prefill_limit("BTC-USD", Price(6_400_000));
        app.focus = Focus::Ticket;
        type_text(&mut app, "0.1");
        app.focus = Focus::Chart;
        let outcome = send_key(&mut app, ch('b'));
        assert!(outcome.changed);
        assert_eq!(outcome.messages.len(), 1);
        let ClientMessage::CommandText {
            request_id, text, ..
        } = &outcome.messages[0]
        else {
            panic!("expected command_text, got {:?}", outcome.messages[0]);
        };
        assert_eq!(text, "BUY BTC-USD 0.1 LMT 64000.00");
        assert_eq!(
            app.account.last_request_id.as_deref(),
            Some(request_id.as_str())
        );
        // The ticket is not typed, so the history stays empty.
        assert!(app.command.history.is_empty());
        // Sell at market: clear the limit price first.
        app.ticket.limit_price = None;
        let outcome = send_key(&mut app, ch('s'));
        let ClientMessage::CommandText { text, .. } = &outcome.messages[0] else {
            panic!("expected command_text");
        };
        assert_eq!(text, "SELL BTC-USD 0.1");
    }

    // Req 30.2
    #[test]
    fn an_incomplete_ticket_shows_a_rejection_and_sends_nothing() {
        let mut app = App::new("ws://x/ws");
        app.prefill_limit("BTC-USD", Price(6_400_000));
        let outcome = send_key(&mut app, ch('b'));
        assert!(outcome.changed);
        assert!(outcome.messages.is_empty());
        let latest = app.account.latest_rejection(1_000).unwrap();
        assert_eq!(latest.reason, "enter a quantity");
        assert_eq!(app.account.last_request_id, None);
    }

    // Req 30.4, 30.5
    #[test]
    fn f_and_x_open_a_dialog_and_only_confirm_sends() {
        let mut app = App::new("ws://x/ws");
        let outcome = send_key(&mut app, ch('f'));
        assert!(outcome.messages.is_empty());
        assert_eq!(app.account.confirm, Some(ConfirmAction::FlattenAll));
        // Escape closes it and sends nothing.
        let outcome = send_key(&mut app, press(KeyCode::Esc));
        assert!(outcome.messages.is_empty() && outcome.changed);
        assert_eq!(app.account.confirm, None);
        // N does the same.
        send_key(&mut app, ch('x'));
        assert_eq!(app.account.confirm, Some(ConfirmAction::CancelAll));
        assert!(send_key(&mut app, ch('n')).messages.is_empty());
        // Confirm sends flatten_all once.
        send_key(&mut app, ch('f'));
        let outcome = send_key(&mut app, press(KeyCode::Enter));
        assert_eq!(outcome.messages.len(), 1);
        assert!(matches!(
            outcome.messages[0],
            ClientMessage::FlattenAll { .. }
        ));
        assert_eq!(app.account.confirm, None);
        send_key(&mut app, ch('x'));
        let outcome = send_key(&mut app, ch('y'));
        assert!(matches!(
            outcome.messages[0],
            ClientMessage::CancelAll { .. }
        ));
        // With no dialog open, Enter is not a dialog key.
        assert_eq!(decide(&app, press(KeyCode::Enter)), None);
    }

    // Req 22.2, 22.3
    #[test]
    fn confirm_sends_the_preview_id_and_discard_sends_discard() {
        let mut app = app_with_preview();
        let outcome = send_key(&mut app, press(KeyCode::Enter));
        let ClientMessage::Confirm {
            request_id,
            preview_id,
        } = &outcome.messages[0]
        else {
            panic!("expected confirm");
        };
        assert_eq!(preview_id, "p1");
        assert!(!request_id.is_empty());
        assert!(app.account.preview.is_none());

        let mut app = app_with_preview();
        let outcome = send_key(&mut app, press(KeyCode::Esc));
        assert_eq!(
            outcome.messages,
            vec![ClientMessage::Discard {
                preview_id: "p1".into()
            }]
        );
        assert!(app.account.preview.is_none());
        // Nothing is left to confirm.
        assert!(
            send_key(&mut app, press(KeyCode::Enter))
                .messages
                .is_empty()
        );
    }

    // Req 31.1, 31.3
    #[test]
    fn enter_sends_command_text_and_the_history_dedupes_and_steps() {
        let mut app = App::new("ws://x/ws");
        send_key(&mut app, ch(':'));
        type_text(&mut app, "BUY BTC 1");
        let outcome = send_key(&mut app, press(KeyCode::Enter));
        let ClientMessage::CommandText {
            request_id, text, ..
        } = &outcome.messages[0]
        else {
            panic!("expected command_text");
        };
        assert_eq!(text, "BUY BTC 1");
        assert_eq!(app.command.history, vec!["BUY BTC 1".to_owned()]);
        // The text stays until the preview arrives.
        assert_eq!(app.command.editor.text(), "BUY BTC 1");
        assert_eq!(app.command.submitted.as_deref(), Some(request_id.as_str()));
        // A second identical submit gets a fresh request id and no second history entry.
        let outcome = send_key(&mut app, press(KeyCode::Enter));
        let ClientMessage::CommandText {
            request_id: second, ..
        } = &outcome.messages[0]
        else {
            panic!("expected command_text");
        };
        assert_ne!(second, request_id);
        assert_eq!(app.command.history.len(), 1);
        // Blank text sends nothing.
        app.command.editor.clear();
        assert!(
            send_key(&mut app, press(KeyCode::Enter))
                .messages
                .is_empty()
        );
        // History: Up shows the entry, Down restores the draft.
        type_text(&mut app, "SELL");
        send_key(&mut app, press(KeyCode::Up));
        assert_eq!(app.command.editor.text(), "BUY BTC 1");
        send_key(&mut app, press(KeyCode::Down));
        assert_eq!(app.command.editor.text(), "SELL");
        assert!(!send_key(&mut app, press(KeyCode::Down)).changed);
        // Escape blurs the bar.
        send_key(&mut app, press(KeyCode::Esc));
        assert_eq!(effective_focus(&app), Focus::Chart);
    }

    // Req 31.4
    #[test]
    fn a_parse_error_keeps_the_text_and_the_matching_preview_clears_it() {
        let mut app = App::new("ws://x/ws");
        send_key(&mut app, ch(':'));
        type_text(&mut app, "BUY XYZ 1");
        let outcome = send_key(&mut app, press(KeyCode::Enter));
        let ClientMessage::CommandText { request_id, .. } = outcome.messages[0].clone() else {
            panic!("expected command_text");
        };
        update(
            &mut app,
            NetEvent::Message(ServerMessage::ParseError {
                request_id: request_id.clone(),
                message: "unknown symbol XYZ".into(),
                position: 4,
            }),
        );
        let error = app.account.parse_error.clone().unwrap();
        assert_eq!(
            (error.message.as_str(), error.position),
            ("unknown symbol XYZ", 4)
        );
        assert_eq!(app.command.editor.text(), "BUY XYZ 1");
        // A preview for another request changes nothing.
        update(&mut app, preview_message("other", "p9", place_action()));
        assert_eq!(app.command.editor.text(), "BUY XYZ 1");
        assert!(app.account.preview.is_none());
        // The matching preview clears the bar, closes the error, and takes focus off the bar.
        update(&mut app, preview_message(&request_id, "p1", place_action()));
        assert_eq!(app.command.editor.text(), "");
        assert!(app.account.parse_error.is_none());
        assert!(app.account.preview.is_some());
        assert_eq!(app.focus, Focus::Chart);
        assert_eq!(effective_focus(&app), Focus::Dialog);
    }

    // Req 30.3
    #[test]
    fn delete_cancels_the_selected_order_and_the_cross_cancels_its_row() {
        let mut app = App::new("ws://x/ws");
        let account = AccountId::new("guest").unwrap();
        for id in ["o-1", "o-2"] {
            app.account.apply_event(
                &Event::OrderAck {
                    venue: protocol::Venue::Replay,
                    account_id: account.clone(),
                    order_id: OrderId::new(id).unwrap(),
                    status: OrderStatus::Accepted,
                },
                0,
            );
        }
        app.focus = Focus::Orders;
        // Nothing selected: Delete sends nothing.
        assert!(
            send_key(&mut app, press(KeyCode::Delete))
                .messages
                .is_empty()
        );
        send_key(&mut app, press(KeyCode::Down));
        assert_eq!(app.account.selected_order.as_deref(), Some("o-1"));
        send_key(&mut app, press(KeyCode::Down));
        let outcome = send_key(&mut app, press(KeyCode::Delete));
        assert!(matches!(
            &outcome.messages[0],
            ClientMessage::Cancel { order_id, .. } if order_id.as_str() == "o-2"
        ));
        // The cancel waits for the engine's ack: the row is still open.
        assert_eq!(app.account.orders.len(), 2);
        // Mouse: the cross of a row sends the cancel for that row.
        let outcome =
            apply_order_mouse(&mut app, &MouseAction::CancelOrder("o-1".into()), 5).unwrap();
        assert!(matches!(
            &outcome.messages[0],
            ClientMessage::Cancel { order_id, .. } if order_id.as_str() == "o-1"
        ));
    }

    #[test]
    fn mouse_clicks_focus_panels_and_press_the_ticket_buttons() {
        let mut app = App::new("ws://x/ws");
        let go = |app: &mut App, action: MouseAction| apply_order_mouse(app, &action, 0);
        assert!(go(&mut app, MouseAction::FocusCommand).unwrap().changed);
        assert_eq!(app.focus, Focus::Command);
        assert!(go(&mut app, MouseAction::FocusOrders).unwrap().changed);
        assert!(!go(&mut app, MouseAction::FocusOrders).unwrap().changed);
        assert!(go(&mut app, MouseAction::FocusTicket).unwrap().changed);
        assert_eq!(app.focus, Focus::Ticket);
        // The buttons use the same path as B and S: an empty ticket is a rejection.
        let outcome = go(&mut app, MouseAction::TicketBuy).unwrap();
        assert!(outcome.messages.is_empty());
        assert!(app.account.latest_rejection(0).is_some());
        // Chart actions are not order entry.
        assert!(go(&mut app, MouseAction::ZoomIn).is_none());
    }

    #[test]
    fn an_open_dialog_is_modal_for_the_mouse() {
        let mut app = app_with_preview();
        // Other actions are swallowed.
        let outcome = apply_order_mouse(&mut app, &MouseAction::ZoomIn, 0).unwrap();
        assert!(!outcome.changed && outcome.messages.is_empty());
        assert!(app.account.preview.is_some());
        // The buttons confirm or discard.
        let outcome = apply_order_mouse(&mut app, &MouseAction::DialogConfirm, 0).unwrap();
        assert!(matches!(outcome.messages[0], ClientMessage::Confirm { .. }));
        let mut app = app_with_preview();
        let outcome = apply_order_mouse(&mut app, &MouseAction::DialogCancel, 0).unwrap();
        assert!(matches!(outcome.messages[0], ClientMessage::Discard { .. }));
    }

    // Req 46.4
    #[test]
    fn a_session_for_another_account_closes_dialogs_and_clears_the_panels() {
        let mut app = app_with_preview();
        let guest = AccountId::new("guest").unwrap();
        update(
            &mut app,
            NetEvent::Message(ServerMessage::Session {
                account_id: guest.clone(),
                address: None,
            }),
        );
        app.account.apply_event(
            &Event::Position {
                account_id: guest,
                symbol: "BTC-USD".into(),
                qty: Qty(5),
                avg_entry: Some(Price(1)),
                realized: Money(1),
                unrealized: Money(1),
            },
            0,
        );
        send_key(&mut app, press(KeyCode::Esc)); // discard the preview
        send_key(&mut app, ch('f'));
        assert_eq!(app.account.confirm, Some(ConfirmAction::FlattenAll));
        update(
            &mut app,
            NetEvent::Message(ServerMessage::Session {
                account_id: AccountId::new("w_abc").unwrap(),
                address: Some("abc".into()),
            }),
        );
        assert!(app.account.confirm.is_none() && app.account.preview.is_none());
        assert!(app.account.positions.is_empty());
        assert!(!app.account.dialog_open());
    }
}
