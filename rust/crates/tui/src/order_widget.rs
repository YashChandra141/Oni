//! Drawing of the order entry parts of the screen (Task 12.4, Req 22, 28, 30, 31): the command
//! bar with its parse-error caret, the Positions / Open orders / P&L strip, the ticket line,
//! and the preview and confirm dialogs.
//!
//! Every function draws into a rectangle the caller picked, registers its clickable cells in
//! the hit map, and reads only `App`. The text comes from small pure functions, so the tests
//! can check it with a `TestBackend` without a terminal.

use protocol::{Price, Qty, Side};
use ratatui::Frame;
use ratatui::layout::{Alignment, Constraint, Layout, Position, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Clear, Paragraph};

use crate::account_model::AccountState;
use crate::app::App;
use crate::book_model::format_ticket;
use crate::chart_model::format_price;
use crate::hitmap::{HitMap, HitTarget, PanelId};
use crate::order_input::{Focus, effective_focus};
use crate::order_model::{
    ConfirmAction, OpenOrder, PositionRow, PreviewState, caret_column, format_money,
    format_qty_trimmed, money_text, preview_action_label, rejection_text, seconds_left,
};

/// Shown in the empty, unfocused command bar.
pub const PLACEHOLDER: &str = "press : to type a command   B buy  S sell  F flatten  X cancel all";
/// Width of the P&L panel in the bottom strip.
pub const PNL_PANEL_WIDTH: u16 = 26;

fn pnl_style(raw: i128) -> Style {
    match raw.signum() {
        1 => Style::new().fg(crate::brand::BUY),
        -1 => Style::new().fg(crate::brand::SELL),
        _ => Style::new().fg(crate::brand::MUTED),
    }
}

fn side_style(side: Option<Side>) -> Style {
    match side {
        Some(Side::Buy) => Style::new().fg(crate::brand::BUY),
        Some(Side::Sell) => Style::new().fg(crate::brand::SELL),
        None => Style::new(),
    }
}

/// `+1.25` for gains, `-0.50` for losses, `0.00` for zero.
pub fn signed_money(raw: i128) -> String {
    let text = format_money(raw, 2);
    if raw > 0 { format!("+{text}") } else { text }
}

/// The one-line P&L summary of narrow layouts: `P&L +1.25  R +1.00  U +0.25` (Req 28.3).
pub fn pnl_summary_text(account: &AccountState) -> String {
    format!(
        "P&L {}  R {}  U {}",
        signed_money(account.total_pnl()),
        signed_money(account.realized_total()),
        signed_money(account.unrealized_total())
    )
}

fn truncate(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

fn right_pad(text: &str, width: usize) -> String {
    format!("{text:<width$}")
}

fn left_pad(text: &str, width: usize) -> String {
    format!("{text:>width$}")
}

// ---------------------------------------------------------------------------------------------
// Command bar (Req 31)

/// Rows the command bar needs: the bar, plus the caret and message rows under a parse error.
pub fn command_rows(app: &App) -> u16 {
    if app.account.parse_error.is_some() {
        3
    } else {
        1
    }
}

/// True when the bar must be visible even on a screen too short to reserve a row for it: it
/// has the keyboard, shows a parse error, or shows a rejection.
pub fn bar_active(app: &App) -> bool {
    app.focus == Focus::Command
        || app.account.parse_error.is_some()
        || app.account.latest_rejection(app.now_ms).is_some()
}

/// The part of `text` that fits in `width` cells with the cursor inside it, and the character
/// index where that part starts.
pub fn visible_window(text: &str, cursor: usize, width: usize) -> (String, usize) {
    if width == 0 {
        return (String::new(), 0);
    }
    let start = if cursor >= width {
        cursor + 1 - width
    } else {
        0
    };
    (text.chars().skip(start).take(width).collect(), start)
}

/// Draws the command bar into `area`: row 0 is the input and, after a parse error, row 1 holds
/// a caret under the first invalid token and row 2 the message (Req 31.4). The right end of row
/// 0 shows the latest rejection for 10 s (Req 30.6) or, with `show_summary`, the P&L summary.
pub fn draw_command_bar(
    frame: &mut Frame,
    app: &App,
    hits: &mut HitMap,
    area: Rect,
    show_summary: bool,
) {
    if area.width == 0 || area.height == 0 {
        return;
    }
    frame.render_widget(Clear, area);
    hits.register(area, HitTarget::Panel(PanelId::CommandBar));

    let right = match app.account.latest_rejection(app.now_ms) {
        Some(rejection) => Some((
            format!("REJECTED: {}", rejection_text(&rejection.reason)),
            Style::new()
                .fg(crate::brand::SELL)
                .add_modifier(Modifier::BOLD),
        )),
        None if show_summary => Some((
            pnl_summary_text(&app.account),
            pnl_style(app.account.total_pnl()),
        )),
        None => None,
    };
    let max_right = usize::from(area.width) / 2;
    let right = right.map(|(text, style)| (truncate(&text, max_right), style));
    let right_width = right.as_ref().map_or(0, |(text, _)| {
        u16::try_from(text.chars().count()).unwrap_or(0)
    });
    let gap = u16::from(right_width > 0);
    let left = Rect::new(
        area.x,
        area.y,
        area.width.saturating_sub(right_width + gap),
        1,
    );
    if let Some((text, style)) = right {
        let rect = Rect::new(
            area.right().saturating_sub(right_width),
            area.y,
            right_width,
            1,
        );
        frame.render_widget(Paragraph::new(Span::styled(text, style)), rect);
    }

    let dialog = app.account.dialog_open();
    let focused = app.focus == Focus::Command && !dialog;
    let prompt_style = if focused {
        Style::new()
            .fg(crate::brand::AMBER)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::new().fg(crate::brand::FAINT)
    };
    let text_width = usize::from(left.width).saturating_sub(2);
    let editor = &app.command.editor;
    let (shown, start) = visible_window(editor.text(), editor.cursor(), text_width);
    let mut spans = vec![Span::styled("> ", prompt_style)];
    if editor.is_empty() && !focused {
        spans.push(Span::styled(
            truncate(PLACEHOLDER, text_width),
            Style::new().fg(crate::brand::FAINT),
        ));
    } else {
        spans.push(Span::raw(shown));
    }
    frame.render_widget(Paragraph::new(Line::from(spans)), left);
    if focused && left.width > 2 {
        let column = u16::try_from(editor.cursor().saturating_sub(start)).unwrap_or(u16::MAX);
        let x = (left.x + 2)
            .saturating_add(column)
            .min(left.right().saturating_sub(1));
        frame.set_cursor_position(Position::new(x, area.y));
    }

    if let Some(error) = &app.account.parse_error {
        let red = Style::new().fg(crate::brand::SELL);
        if area.height >= 2 {
            let caret = caret_column(error.position, editor.len_chars());
            let offset = 2 + caret.saturating_sub(start);
            let line = format!("{}^", " ".repeat(offset));
            let rect = Rect::new(area.x, area.y + 1, area.width, 1);
            frame.render_widget(Paragraph::new(Span::styled(line, red)), rect);
        }
        if area.height >= 3 {
            let rect = Rect::new(area.x, area.y + 2, area.width, 1);
            frame.render_widget(
                Paragraph::new(Span::styled(format!("  {}", error.message), red)),
                rect,
            );
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Ticket line (Req 30.1, 30.2)

/// One piece of a one-line widget: its text, its style, and what a click on it does.
type Segment = (String, Style, Option<HitTarget>);

/// Draws segments left to right inside `area` (one row), registers each clickable one, and
/// returns the x of each segment's start. Segments past the right edge are cut.
fn draw_segments(
    frame: &mut Frame,
    hits: &mut HitMap,
    area: Rect,
    segments: Vec<Segment>,
) -> Vec<u16> {
    let mut starts = Vec::with_capacity(segments.len());
    let mut x = area.x;
    for (text, style, target) in segments {
        starts.push(x);
        let width = u16::try_from(text.chars().count()).unwrap_or(u16::MAX);
        let width = width.min(area.right().saturating_sub(x));
        if width == 0 {
            continue;
        }
        let rect = Rect::new(x, area.y, width, 1);
        frame.render_widget(Paragraph::new(Span::styled(text, style)), rect);
        if let Some(target) = target {
            hits.register(rect, target);
        }
        x += width;
    }
    starts
}

/// The ticket line text before the quantity: `TICKET: LMT 64000.00` or `TICKET: -`.
pub fn ticket_head(price: Option<Price>) -> String {
    format_ticket(price)
}

/// `TICKET: LMT 64000.00  QTY 0.1       [BUY] [SELL]`. The quantity is typed here while the ticket
/// has the keyboard, and B and S send the ticket as command text (Req 30.2).
pub fn draw_ticket_line(frame: &mut Frame, app: &App, hits: &mut HitMap, area: Rect) {
    if area.width == 0 || area.height == 0 {
        return;
    }
    let area = Rect::new(area.x, area.y, area.width, 1);
    let focused = effective_focus(app) == Focus::Ticket;
    let qty_text = app.ticket_qty.text();
    // A text that is not a quantity yet (empty, `1.`, `0`) is shown in red while typing.
    let invalid = !qty_text.is_empty() && app.ticket.qty.is_none();
    let value = if qty_text.is_empty() && !focused {
        "-".to_owned()
    } else {
        qty_text.to_owned()
    };
    let mut value_style = Style::new();
    if focused {
        value_style = value_style.add_modifier(Modifier::REVERSED);
    }
    if invalid {
        value_style = value_style.fg(crate::brand::SELL);
    }
    let head = match app.ticket.kind {
        // Limit keeps the book-prefill text the tests and Req 30.1 describe.
        crate::order_model::TicketKind::Limit => ticket_head(app.ticket_limit_price()),
        crate::order_model::TicketKind::Market => "TICKET: MKT".to_owned(),
        crate::order_model::TicketKind::Stop => match app.ticket_limit_price() {
            Some(p) => format!("TICKET: STP {}", crate::chart_model::format_price(p)),
            None => "TICKET: STP -".to_owned(),
        },
        crate::order_model::TicketKind::Twap => format!(
            "TICKET: TWAP {}x{}s",
            app.ticket.twap_slices, app.ticket.twap_secs
        ),
    };
    let value_cell = right_pad(&value, 10);
    let segments: Vec<Segment> = vec![
        (head, Style::new(), None),
        (
            " QTY ".to_owned(),
            Style::new().fg(crate::brand::MUTED),
            Some(HitTarget::TicketQty),
        ),
        (value_cell, value_style, Some(HitTarget::TicketQty)),
        (
            " [BUY]".to_owned(),
            Style::new()
                .fg(crate::brand::BUY)
                .add_modifier(Modifier::BOLD),
            Some(HitTarget::TicketBuy),
        ),
        (
            " [SELL]".to_owned(),
            Style::new()
                .fg(crate::brand::SELL)
                .add_modifier(Modifier::BOLD),
            Some(HitTarget::TicketSell),
        ),
    ];
    let starts = draw_segments(frame, hits, area, segments);
    if focused && let Some(start) = starts.get(2) {
        let column = u16::try_from(app.ticket_qty.cursor()).unwrap_or(u16::MAX);
        let x = start
            .saturating_add(column)
            .min(area.right().saturating_sub(1));
        frame.set_cursor_position(Position::new(x, area.y));
    }
}

// ---------------------------------------------------------------------------------------------
// Bottom strip: Positions / Open orders / P&L (Req 28)

/// Where the first of `rows` visible rows starts so the selected row stays in view.
pub fn scroll_start(selected: Option<usize>, total: usize, rows: usize) -> usize {
    match selected {
        Some(index) if rows > 0 && index >= rows => {
            (index + 1 - rows).min(total.saturating_sub(rows))
        }
        _ => 0,
    }
}

/// The Positions table lines: a header, then one row per open position (Req 28.1).
pub fn positions_lines(account: &AccountState) -> Vec<Line<'static>> {
    let header = format!(
        "{}{}{}{}{}",
        right_pad("SYMBOL", 8),
        left_pad("QTY", 10),
        left_pad("AVG", 10),
        left_pad("RPNL", 9),
        left_pad("UPNL", 9)
    );
    let mut lines = vec![Line::styled(header, Style::new().fg(crate::brand::MUTED))];
    if account.positions.is_empty() {
        lines.push(Line::styled(
            "no positions",
            Style::new().fg(crate::brand::FAINT),
        ));
        return lines;
    }
    for row in account.positions.values() {
        lines.push(position_line(row));
    }
    lines
}

fn position_line(row: &PositionRow) -> Line<'static> {
    let qty_style = if row.qty.0 < 0 {
        Style::new().fg(crate::brand::SELL)
    } else {
        Style::new().fg(crate::brand::BUY)
    };
    let avg = row.avg_entry.map_or_else(|| "-".to_owned(), format_price);
    Line::from(vec![
        Span::raw(right_pad(&row.symbol, 8)),
        Span::styled(left_pad(&format_qty_trimmed(row.qty), 10), qty_style),
        Span::raw(left_pad(&avg, 10)),
        Span::styled(
            left_pad(&money_text(row.realized), 9),
            pnl_style(i128::from(row.realized.0)),
        ),
        Span::styled(
            left_pad(&money_text(row.unrealized), 9),
            pnl_style(i128::from(row.unrealized.0)),
        ),
    ])
}

const ORDER_PREFIX: &str = " ✕ ";

/// The header of the Open orders table; the first three cells are the ✕ column.
pub fn orders_header() -> String {
    format!(
        "{}{}{}{}{}{}{}",
        "   ",
        right_pad("SIDE", 5),
        right_pad("SYMBOL", 8),
        right_pad("TYPE", 4),
        left_pad("PRICE", 9),
        left_pad("FILLED", 7),
        left_pad("LEFT", 7)
    )
}

/// One Open orders row: the ✕ cell, side, symbol, type, price, filled, and remaining (Req 28.2).
pub fn order_line(order: &OpenOrder, selected: bool) -> Line<'static> {
    let side = match order.side {
        Some(Side::Buy) => "BUY",
        Some(Side::Sell) => "SELL",
        None => "-",
    };
    let kind = order.kind.map_or("-", |kind| kind.label());
    let price = order.price.map_or_else(|| "-".to_owned(), format_price);
    let symbol = order.symbol.clone().unwrap_or_else(|| "-".to_owned());
    let base = if selected {
        Style::new().add_modifier(Modifier::REVERSED)
    } else {
        Style::new()
    };
    Line::from(vec![
        Span::styled(ORDER_PREFIX, base.fg(crate::brand::SELL)),
        Span::styled(right_pad(side, 5), base.patch(side_style(order.side))),
        Span::styled(right_pad(&symbol, 8), base),
        Span::styled(right_pad(kind, 4), base),
        Span::styled(left_pad(&price, 9), base),
        Span::styled(left_pad(&format_qty_trimmed(Qty(order.filled)), 7), base),
        Span::styled(left_pad(&format_qty_trimmed(Qty(order.remaining)), 7), base),
    ])
}

/// The three P&L lines: realized, unrealized, and the total, right-aligned to `width`.
pub fn pnl_lines(account: &AccountState, width: usize) -> Vec<Line<'static>> {
    let row = |label: &str, raw: i128| {
        let value = signed_money(raw);
        let gap = width.saturating_sub(label.chars().count() + value.chars().count());
        Line::from(vec![
            Span::styled(label.to_owned(), Style::new().fg(crate::brand::MUTED)),
            Span::raw(" ".repeat(gap)),
            Span::styled(value, pnl_style(raw)),
        ])
    };
    vec![
        row("REALIZED", account.realized_total()),
        row("UNREALIZED", account.unrealized_total()),
        row("TOTAL", account.total_pnl()),
    ]
}

/// Draws the Positions, Open orders, and P&L panels side by side in `area`.
pub fn draw_strip(frame: &mut Frame, app: &App, hits: &mut HitMap, area: Rect) {
    let [positions, orders, pnl] = Layout::horizontal([
        Constraint::Percentage(40),
        Constraint::Min(0),
        Constraint::Length(PNL_PANEL_WIDTH),
    ])
    .areas(area);
    draw_positions(frame, app, hits, positions);
    draw_orders(frame, app, hits, orders);
    draw_pnl(frame, app, pnl);
}

fn draw_positions(frame: &mut Frame, app: &App, hits: &mut HitMap, area: Rect) {
    hits.register(area, HitTarget::Panel(PanelId::Positions));
    let block = crate::brand::block().title(" POSITIONS ");
    let inner = block.inner(area);
    frame.render_widget(block, area);
    frame.render_widget(Paragraph::new(positions_lines(&app.account)), inner);
}

fn draw_orders(frame: &mut Frame, app: &App, hits: &mut HitMap, area: Rect) {
    hits.register(area, HitTarget::Panel(PanelId::Orders));
    let focused = app.focus == Focus::Orders && !app.account.dialog_open();
    let mut block = crate::brand::block().title(" OPEN ORDERS ");
    if focused {
        block = block.border_style(Style::new().fg(crate::brand::ACCENT_BRIGHT));
    }
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if inner.height == 0 {
        return;
    }
    let account = &app.account;
    let header = Rect::new(inner.x, inner.y, inner.width, 1);
    frame.render_widget(
        Paragraph::new(Line::styled(
            orders_header(),
            Style::new().fg(crate::brand::MUTED),
        )),
        header,
    );
    if account.orders.is_empty() {
        if inner.height > 1 {
            let rect = Rect::new(inner.x, inner.y + 1, inner.width, 1);
            frame.render_widget(
                Paragraph::new(Line::styled(
                    "no open orders",
                    Style::new().fg(crate::brand::FAINT),
                )),
                rect,
            );
        }
        draw_twaps(frame, app, inner, 2);
        return;
    }
    let rows = usize::from(inner.height - 1);
    let selected = account
        .selected_order
        .as_deref()
        .and_then(|id| account.orders.iter().position(|o| o.id == id));
    let first = scroll_start(selected, account.orders.len(), rows);
    for (offset, order) in account.orders.iter().skip(first).take(rows).enumerate() {
        let Ok(dy) = u16::try_from(offset) else {
            break;
        };
        let rect = Rect::new(inner.x, inner.y + 1 + dy, inner.width, 1);
        let is_selected = account.selected_order.as_deref() == Some(order.id.as_str());
        frame.render_widget(Paragraph::new(order_line(order, is_selected)), rect);
        hits.register(rect, HitTarget::OrderRow(order.id.clone()));
        // The ✕ cell is registered after the row, so it wins.
        let cross = Rect::new(rect.x, rect.y, 3_u16.min(rect.width), 1);
        hits.register(cross, HitTarget::OpenOrder(order.id.clone()));
    }
    let shown = account.orders.len().saturating_sub(first).min(rows);
    draw_twaps(frame, app, inner, shown.saturating_add(1));
}

/// Draws TWAP plan statuses in the rows of `inner` from `first_row` on (Task 16.4).
fn draw_twaps(frame: &mut Frame, app: &App, inner: Rect, first_row: usize) {
    for (i, twap) in app.twaps.iter().rev().enumerate() {
        let Ok(dy) = u16::try_from(first_row.saturating_add(i)) else {
            break;
        };
        if dy >= inner.height {
            break;
        }
        let side = match twap.side {
            Side::Buy => "BUY",
            Side::Sell => "SELL",
        };
        let status = match twap.status {
            protocol::TwapStatus::Active => "active",
            protocol::TwapStatus::Done => "done",
            protocol::TwapStatus::Canceled => "canceled",
        };
        let reason = twap
            .reason
            .as_deref()
            .map_or_else(String::new, |r| format!(" ({r})"));
        let text = format!(
            "TWAP {side} {} {}/{} {status}{reason}",
            twap.symbol, twap.sent, twap.slices
        );
        let rect = Rect::new(inner.x, inner.y + dy, inner.width, 1);
        frame.render_widget(
            Paragraph::new(Line::styled(
                text,
                Style::new().fg(crate::brand::ACCENT_BRIGHT),
            )),
            rect,
        );
    }
}

fn draw_pnl(frame: &mut Frame, app: &App, area: Rect) {
    let block = crate::brand::block().title(" P&L ");
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let lines = pnl_lines(&app.account, usize::from(inner.width));
    frame.render_widget(Paragraph::new(lines), inner);
}

// ---------------------------------------------------------------------------------------------
// Dialogs (Req 22.1-22.3, 30.4, 30.5)

/// A box of `width` x `height` centered in `area`, cut to fit.
pub fn centered(area: Rect, width: u16, height: u16) -> Rect {
    let width = width.min(area.width);
    let height = height.min(area.height);
    Rect::new(
        area.x + (area.width - width) / 2,
        area.y + (area.height - height) / 2,
        width,
        height,
    )
}

/// The two buttons of a dialog on the row `y`, starting at `x`: the confirm button in green and
/// the cancel button in red. Registers both in the hit map.
fn draw_buttons(
    frame: &mut Frame,
    hits: &mut HitMap,
    inner: Rect,
    y: u16,
    confirm: &str,
    cancel: &str,
) {
    if y >= inner.bottom() {
        return;
    }
    let row = Rect::new(inner.x, y, inner.width, 1);
    let segments: Vec<Segment> = vec![
        (" ".to_owned(), Style::new(), None),
        (
            confirm.to_owned(),
            Style::new()
                .fg(crate::brand::BUY)
                .add_modifier(Modifier::BOLD),
            Some(HitTarget::DialogConfirm),
        ),
        ("  ".to_owned(), Style::new(), None),
        (
            cancel.to_owned(),
            Style::new()
                .fg(crate::brand::SELL)
                .add_modifier(Modifier::BOLD),
            Some(HitTarget::DialogCancel),
        ),
    ];
    draw_segments(frame, hits, row, segments);
}

/// The text rows of the preview dialog: the headline, the server's canonical text, and the
/// countdown to the deadline.
pub fn preview_lines(state: &PreviewState, now_ms: i64) -> Vec<Line<'static>> {
    vec![
        Line::styled(
            preview_action_label(&state.preview.action),
            Style::new().fg(Color::Cyan).add_modifier(Modifier::BOLD),
        ),
        Line::from(""),
        Line::styled(
            state.preview.text.clone(),
            Style::new().fg(crate::brand::AMBER),
        ),
        Line::styled(
            format!("expires in {}s", seconds_left(state.deadline_ms, now_ms)),
            Style::new().fg(crate::brand::MUTED),
        ),
        Line::from(""),
    ]
}

const CONFIRM_LABEL: &str = " Confirm [Enter/Y] ";
const DISCARD_LABEL: &str = " Discard [Esc/N] ";
const CANCEL_LABEL: &str = " Cancel [Esc/N] ";

fn draw_preview_dialog(frame: &mut Frame, hits: &mut HitMap, state: &PreviewState, now_ms: i64) {
    let area = centered(frame.area(), 58, 9);
    frame.render_widget(Clear, area);
    let block = crate::brand::block().title(" Order preview ");
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let lines = preview_lines(state, now_ms);
    frame.render_widget(Paragraph::new(lines).alignment(Alignment::Left), inner);
    draw_buttons(
        frame,
        hits,
        inner,
        inner.y + 5,
        CONFIRM_LABEL,
        DISCARD_LABEL,
    );
}

fn draw_confirm_dialog(frame: &mut Frame, hits: &mut HitMap, action: ConfirmAction) {
    let area = centered(frame.area(), 46, 6);
    frame.render_widget(Clear, area);
    let block = crate::brand::block().title(" Confirm ");
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let lines = vec![
        Line::styled(
            action.question(),
            Style::new()
                .fg(crate::brand::AMBER)
                .add_modifier(Modifier::BOLD),
        ),
        Line::from(""),
    ];
    frame.render_widget(Paragraph::new(lines), inner);
    draw_buttons(frame, hits, inner, inner.y + 2, CONFIRM_LABEL, CANCEL_LABEL);
}

/// Draws the open dialog over everything, if any. The yes/no dialog has priority over a
/// preview, as on the web. Registered last, so its buttons sit on top in the hit map.
pub fn draw_dialogs(frame: &mut Frame, app: &App, hits: &mut HitMap) {
    if let Some(action) = app.account.confirm {
        draw_confirm_dialog(frame, hits, action);
    } else if let Some(state) = &app.account.preview {
        draw_preview_dialog(frame, hits, state, app.now_ms);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::NetEvent;
    use protocol::client::{OrderPreview, PreviewAction, ServerMessage};
    use protocol::{AccountId, Event, Money, OrderId, OrderKind, OrderStatus, Qty};
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;

    fn guest() -> AccountId {
        AccountId::new("guest").unwrap()
    }

    // The widgets take the whole screen here; the area is read first so `frame` is not
    // borrowed twice in one call.
    fn strip(f: &mut Frame, app: &App, h: &mut HitMap) {
        let area = f.area();
        draw_strip(f, app, h, area);
    }

    fn bar(f: &mut Frame, app: &App, h: &mut HitMap, summary: bool) {
        let area = f.area();
        draw_command_bar(f, app, h, area, summary);
    }

    fn ticket(f: &mut Frame, app: &App, h: &mut HitMap) {
        let area = f.area();
        draw_ticket_line(f, app, h, area);
    }

    /// Renders `draw` on a `width` x `height` screen and returns the rows and the hit map.
    fn render(
        width: u16,
        height: u16,
        draw: impl FnOnce(&mut Frame, &mut HitMap),
    ) -> (Vec<String>, HitMap) {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        let mut hits = HitMap::new();
        terminal.draw(|f| draw(f, &mut hits)).unwrap();
        let buffer = terminal.backend().buffer();
        let rows = (0..height)
            .map(|y| {
                (0..width)
                    .map(|x| buffer[(x, y)].symbol().to_owned())
                    .collect::<String>()
            })
            .collect();
        (rows, hits)
    }

    fn app_with_account() -> App {
        let mut app = App::new("ws://x/ws");
        app.account.on_session(&guest());
        let apply = |app: &mut App, event: Event| {
            app.account.apply_event(&event, 0);
        };
        apply(
            &mut app,
            Event::Position {
                account_id: guest(),
                symbol: "BTC-USD".into(),
                qty: Qty(10_000_000),
                avg_entry: Some(Price(6_400_000)),
                realized: Money(12_000_000_000),
                unrealized: Money(-5_000_000_000),
            },
        );
        apply(
            &mut app,
            Event::Position {
                account_id: guest(),
                symbol: "ETH-USD".into(),
                qty: Qty(-250_000_000),
                avg_entry: Some(Price(320_000)),
                realized: Money(0),
                unrealized: Money(30_000_000_000),
            },
        );
        for id in ["o-1", "o-2"] {
            apply(
                &mut app,
                Event::OrderAck {
                    venue: protocol::Venue::Replay,
                    account_id: guest(),
                    order_id: OrderId::new(id).unwrap(),
                    status: OrderStatus::Accepted,
                },
            );
        }
        app
    }

    fn preview_state(expires_at: i64) -> PreviewState {
        PreviewState {
            request_id: "r1".into(),
            preview: OrderPreview {
                preview_id: "p1".into(),
                text: "BUY BTC-USD 0.1 LMT 64000.00".into(),
                action: PreviewAction::Place {
                    symbol: "BTC-USD".into(),
                    venue: protocol::Venue::Replay,
                    side: Side::Buy,
                    qty: Qty(10_000_000),
                    kind: OrderKind::Limit {
                        price: Price(6_400_000),
                    },
                },
                expires_at,
            },
            deadline_ms: expires_at,
        }
    }

    fn find(rows: &[String], needle: &str) -> Option<(u16, u16)> {
        rows.iter().enumerate().find_map(|(y, row)| {
            row.find(needle).map(|byte| {
                let x = row[..byte].chars().count();
                (u16::try_from(x).unwrap(), u16::try_from(y).unwrap())
            })
        })
    }

    #[test]
    fn the_visible_window_keeps_the_cursor_in_view() {
        assert_eq!(visible_window("abc", 3, 10), ("abc".to_owned(), 0));
        // Cursor at the end needs its own cell: 4 characters from index 6, cursor in column 4.
        assert_eq!(visible_window("abcdefghij", 10, 5), ("ghij".to_owned(), 6));
        assert_eq!(visible_window("abcdefghij", 3, 5), ("abcde".to_owned(), 0));
        assert_eq!(visible_window("abc", 1, 0), (String::new(), 0));
    }

    #[test]
    fn scroll_keeps_the_selected_row_visible() {
        assert_eq!(scroll_start(None, 10, 3), 0);
        assert_eq!(scroll_start(Some(1), 10, 3), 0);
        assert_eq!(scroll_start(Some(5), 10, 3), 3);
        assert_eq!(scroll_start(Some(9), 10, 3), 7);
        assert_eq!(scroll_start(Some(2), 3, 0), 0);
    }

    // Req 28.1
    #[test]
    fn the_positions_panel_shows_signed_quantity_entry_and_colored_pnl() {
        let app = app_with_account();
        let (rows, hits) = render(120, 8, |f, h| {
            strip(f, &app, h);
        });
        let text = rows.join("\n");
        assert!(text.contains("POSITIONS"), "{text}");
        assert!(
            text.contains("SYMBOL") && text.contains("RPNL") && text.contains("UPNL"),
            "{text}"
        );
        let btc = rows.iter().find(|r| r.contains("BTC-USD")).unwrap();
        assert!(btc.contains("0.1") && btc.contains("64000.00"), "{btc}");
        assert!(btc.contains("1.20") && btc.contains("-0.50"), "{btc}");
        let eth = rows.iter().find(|r| r.contains("ETH-USD")).unwrap();
        assert!(
            eth.contains("-2.5") && eth.contains("3200.00") && eth.contains("3.00"),
            "{eth}"
        );
        assert_eq!(
            hits.resolve(2, 0),
            Some(&HitTarget::Panel(PanelId::Positions))
        );
    }

    #[test]
    fn the_positions_panel_colors_gains_and_losses() {
        let app = app_with_account();
        let mut terminal = Terminal::new(TestBackend::new(120, 8)).unwrap();
        let mut hits = HitMap::new();
        terminal.draw(|f| strip(f, &app, &mut hits)).unwrap();
        let buffer = terminal.backend().buffer();
        let rows: Vec<String> = (0..8)
            .map(|y| {
                (0..120)
                    .map(|x| buffer[(x, y)].symbol().to_owned())
                    .collect()
            })
            .collect();
        let (x, y) = find(&rows, "-0.50").unwrap();
        assert_eq!(buffer[(x, y)].style().fg, Some(crate::brand::SELL));
        let (x, y) = find(&rows, "1.20").unwrap();
        assert_eq!(buffer[(x, y)].style().fg, Some(crate::brand::BUY));
    }

    // Req 28.2, 30.3
    #[test]
    fn the_orders_panel_lists_rows_with_a_clickable_cross() {
        let mut app = app_with_account();
        app.account.selected_order = Some("o-2".into());
        let (rows, hits) = render(120, 8, |f, h| {
            strip(f, &app, h);
        });
        let text = rows.join("\n");
        assert!(text.contains("OPEN ORDERS"), "{text}");
        assert!(
            text.contains("SIDE") && text.contains("FILLED") && text.contains("LEFT"),
            "{text}"
        );
        // Two rows below the header; the cross is the first cell of each.
        let (cross_x, cross_y) = find(&rows, "✕").unwrap();
        assert_eq!(
            hits.resolve(cross_x, cross_y),
            Some(&HitTarget::OpenOrder("o-1".into()))
        );
        assert_eq!(
            hits.resolve(cross_x + 6, cross_y),
            Some(&HitTarget::OrderRow("o-1".into()))
        );
        assert_eq!(
            hits.resolve(cross_x, cross_y + 1),
            Some(&HitTarget::OpenOrder("o-2".into()))
        );
        assert_eq!(
            hits.resolve(cross_x, cross_y + 4),
            Some(&HitTarget::Panel(PanelId::Orders))
        );
    }

    #[test]
    fn an_order_row_shows_its_label_price_filled_and_remaining() {
        let order = OpenOrder {
            id: "o-1".into(),
            symbol: Some("BTC-USD".into()),
            side: Some(Side::Buy),
            kind: Some(crate::order_model::KindLabel::Limit),
            price: Some(Price(6_400_000)),
            qty: 10_000_000,
            filled: 4_000_000,
            remaining: 6_000_000,
        };
        let text: String = order_line(&order, false)
            .spans
            .iter()
            .map(|s| s.content.to_string())
            .collect();
        assert_eq!(text, " ✕ BUY  BTC-USD LMT  64000.00   0.04   0.06");
        // An order with no known label shows dashes.
        let unknown = OpenOrder {
            id: "o-2".into(),
            symbol: None,
            side: None,
            kind: None,
            price: None,
            qty: 0,
            filled: 0,
            remaining: 0,
        };
        let text: String = order_line(&unknown, false)
            .spans
            .iter()
            .map(|s| s.content.to_string())
            .collect();
        let expected = format!(
            " ✕ {}{}{}",
            right_pad("-", 5),
            right_pad("-", 8),
            right_pad("-", 4)
        );
        assert!(text.starts_with(&expected), "{text}");
    }

    // Req 28.3
    #[test]
    fn the_pnl_panel_shows_realized_unrealized_and_total() {
        let app = app_with_account();
        let (rows, _) = render(120, 8, |f, h| {
            strip(f, &app, h);
        });
        let text = rows.join("\n");
        assert!(text.contains("P&L"), "{text}");
        let realized = rows
            .iter()
            .find(|r| r.contains("REALIZED") && !r.contains("UNREALIZED"))
            .unwrap();
        assert!(realized.contains("+1.20"), "{realized}");
        let unrealized = rows.iter().find(|r| r.contains("UNREALIZED")).unwrap();
        assert!(unrealized.contains("+2.50"), "{unrealized}");
        let total = rows.iter().find(|r| r.contains("TOTAL")).unwrap();
        assert!(total.contains("+3.70"), "{total}");
        assert_eq!(
            pnl_summary_text(&app.account),
            "P&L +3.70  R +1.20  U +2.50"
        );
    }

    // Req 22.1
    #[test]
    fn the_preview_dialog_shows_text_action_countdown_and_buttons() {
        let mut app = App::new("ws://x/ws");
        app.account.command_sent("r1");
        app.now_ms = 0;
        app.account
            .on_preview("r1", &preview_state(30_000).preview, 0);
        let (rows, hits) = render(80, 24, |f, h| draw_dialogs(f, &app, h));
        let text = rows.join("\n");
        assert!(text.contains("Order preview"), "{text}");
        assert!(text.contains("PLACE PAPER ORDER"), "{text}");
        assert!(text.contains("BUY BTC-USD 0.1 LMT 64000.00"), "{text}");
        assert!(text.contains("expires in 30s"), "{text}");
        assert!(
            text.contains("Confirm [Enter/Y]") && text.contains("Discard [Esc/N]"),
            "{text}"
        );
        let (x, y) = find(&rows, "Confirm [Enter/Y]").unwrap();
        assert_eq!(hits.resolve(x, y), Some(&HitTarget::DialogConfirm));
        let (x, y) = find(&rows, "Discard [Esc/N]").unwrap();
        assert_eq!(hits.resolve(x, y), Some(&HitTarget::DialogCancel));
        // The dialog is centered.
        let (title_x, _) = find(&rows, "Order preview").unwrap();
        assert!((11..20).contains(&title_x), "{title_x}");
    }

    #[test]
    fn the_countdown_counts_down_with_the_clock() {
        let state = preview_state(30_000);
        let text = |now| -> String {
            preview_lines(&state, now)
                .iter()
                .map(|l| {
                    l.spans
                        .iter()
                        .map(|s| s.content.to_string())
                        .collect::<String>()
                })
                .collect::<Vec<_>>()
                .join("|")
        };
        assert!(text(0).contains("expires in 30s"));
        assert!(text(12_500).contains("expires in 18s"));
        assert!(text(29_999).contains("expires in 1s"));
        assert!(text(30_000).contains("expires in 0s"));
    }

    // Req 30.4, 30.5
    #[test]
    fn the_confirm_dialogs_ask_and_have_two_buttons() {
        for (action, question) in [
            (ConfirmAction::FlattenAll, "Flatten every position?"),
            (ConfirmAction::CancelAll, "Cancel every open order?"),
        ] {
            let mut app = App::new("ws://x/ws");
            app.account.request_confirm(action);
            let (rows, hits) = render(80, 24, |f, h| draw_dialogs(f, &app, h));
            let text = rows.join("\n");
            assert!(text.contains(question), "{text}");
            assert!(
                text.contains("Confirm [Enter/Y]") && text.contains("Cancel [Esc/N]"),
                "{text}"
            );
            let (x, y) = find(&rows, "Confirm [Enter/Y]").unwrap();
            assert_eq!(hits.resolve(x + 2, y), Some(&HitTarget::DialogConfirm));
            let (x, y) = find(&rows, "Cancel [Esc/N]").unwrap();
            assert_eq!(hits.resolve(x + 2, y), Some(&HitTarget::DialogCancel));
        }
        // No dialog, nothing drawn.
        let app = App::new("ws://x/ws");
        let (rows, hits) = render(80, 24, |f, h| draw_dialogs(f, &app, h));
        assert!(rows.iter().all(|r| r.trim().is_empty()));
        assert!(hits.is_empty());
    }

    // Req 31.4
    #[test]
    fn a_parse_error_puts_a_caret_under_the_first_invalid_token() {
        let mut app = App::new("ws://x/ws");
        app.focus = Focus::Command;
        app.command.editor.set("BUY XYZ 1");
        app.account.command_sent("r1");
        assert!(app.account.on_parse_error("r1", "unknown symbol XYZ", 4));
        assert_eq!(command_rows(&app), 3);
        let (rows, hits) = render(60, 3, |f, h| {
            bar(f, &app, h, false);
        });
        assert!(rows[0].starts_with("> BUY XYZ 1"), "{}", rows[0]);
        // The prompt is two cells wide, and the error is at character 4: column 6.
        assert_eq!(rows[1].find('^'), Some(6), "{}", rows[1]);
        assert!(rows[2].contains("unknown symbol XYZ"), "{}", rows[2]);
        assert_eq!(
            hits.resolve(10, 0),
            Some(&HitTarget::Panel(PanelId::CommandBar))
        );
        // The text stays in the input (Req 31.4).
        assert_eq!(app.command.editor.text(), "BUY XYZ 1");
    }

    #[test]
    fn the_bar_shows_a_placeholder_when_idle_and_the_text_when_typing() {
        let mut app = App::new("ws://x/ws");
        assert_eq!(command_rows(&app), 1);
        assert!(!bar_active(&app));
        let (rows, _) = render(80, 1, |f, h| bar(f, &app, h, false));
        assert!(rows[0].contains("press : to type a command"), "{}", rows[0]);
        app.focus = Focus::Command;
        assert!(bar_active(&app));
        app.command.editor.set("SELL ETH 2");
        let (rows, _) = render(80, 1, |f, h| bar(f, &app, h, false));
        assert!(rows[0].starts_with("> SELL ETH 2"), "{}", rows[0]);
        assert!(!rows[0].contains("press :"), "{}", rows[0]);
    }

    // Req 30.6
    #[test]
    fn the_rejection_line_shows_for_ten_seconds_and_replaces_the_summary() {
        let mut app = App::new("ws://x/ws");
        app.account.add_rejection("max_order_value", 1_000);
        app.now_ms = 1_000;
        assert!(bar_active(&app));
        let (rows, _) = render(80, 1, |f, h| bar(f, &app, h, true));
        assert!(rows[0].contains("REJECTED: max order value"), "{}", rows[0]);
        assert!(!rows[0].contains("P&L"), "{}", rows[0]);
        app.now_ms = 11_000;
        assert!(!bar_active(&app));
        let (rows, _) = render(80, 1, |f, h| bar(f, &app, h, true));
        assert!(!rows[0].contains("REJECTED"), "{}", rows[0]);
        assert!(rows[0].contains("P&L 0.00"), "{}", rows[0]);
    }

    // Req 30.1, 30.2
    #[test]
    fn the_ticket_line_shows_price_quantity_and_buttons() {
        let mut app = App::new("ws://x/ws");
        app.prefill_limit("BTC-USD", Price(6_400_100));
        app.focus = Focus::Ticket;
        app.ticket_qty.set("0.25");
        app.sync_ticket_qty();
        let (rows, hits) = render(60, 1, |f, h| ticket(f, &app, h));
        assert!(
            rows[0].starts_with("TICKET: LMT 64001.00 QTY 0.25"),
            "{}",
            rows[0]
        );
        let (x, y) = find(&rows, "[BUY]").unwrap();
        assert_eq!(hits.resolve(x, y), Some(&HitTarget::TicketBuy));
        let (x, y) = find(&rows, "[SELL]").unwrap();
        assert_eq!(hits.resolve(x, y), Some(&HitTarget::TicketSell));
        let (x, y) = find(&rows, "0.25").unwrap();
        assert_eq!(hits.resolve(x, y), Some(&HitTarget::TicketQty));
        // Without a price or quantity.
        let app = App::new("ws://x/ws");
        let (rows, _) = render(60, 1, |f, h| ticket(f, &app, h));
        assert!(rows[0].starts_with("TICKET: - QTY -"), "{}", rows[0]);
    }

    #[test]
    fn drawing_never_panics_on_tiny_areas() {
        let app = app_with_account();
        for (w, h) in [(1, 1), (3, 2), (10, 3), (30, 5)] {
            let _ = render(w, h, |f, hm| {
                strip(f, &app, hm);
                bar(f, &app, hm, true);
                ticket(f, &app, hm);
                draw_dialogs(f, &app, hm);
            });
        }
        let mut app = app;
        app.account.request_confirm(ConfirmAction::FlattenAll);
        for (w, h) in [(1, 1), (5, 3), (20, 4)] {
            let _ = render(w, h, |f, hm| draw_dialogs(f, &app, hm));
        }
    }

    // `NetEvent` and `ServerMessage` keep the helper imports honest for the reducer-driven test.
    #[test]
    fn the_panels_follow_the_reducers() {
        let mut app = App::new("ws://x/ws");
        crate::app::update(
            &mut app,
            NetEvent::msg(ServerMessage::Session {
                account_id: guest(),
                address: None,
            }),
        );
        let (rows, _) = render(120, 6, |f, h| strip(f, &app, h));
        let text = rows.join("\n");
        assert!(
            text.contains("no positions") && text.contains("no open orders"),
            "{text}"
        );
    }
}
