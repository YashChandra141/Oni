//! The connection status screen (Req 33.1) and, once candles exist, the chart screen.

use std::time::Duration;

use protocol::Timeframe;
use ratatui::Frame;
use ratatui::buffer::Buffer;
use ratatui::layout::{Alignment, Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Paragraph};

use crate::app::{App, ConnState};
use crate::book_model::{BookRow, layout_rows};
use crate::book_widget::BookWidget;
use crate::chart_model::visible_bars;
use crate::chart_widget::{AXIS_WIDTH, CandleChart, PlotGeometry};
use crate::hitmap::{HitMap, HitTarget, PanelId};
use crate::indicator_model::{Indicator, IndicatorSeries, legend_text, subpane_rows};
use crate::indicator_widget::{draw_overlays, draw_subpane, indicator_color};
use crate::order_widget;
use crate::tape_widget::TapeWidget;
use crate::watchlist_model::{Direction, WatchQuote, strip_segment, venue_label};
use crate::watchlist_widget::{WatchlistWidget, direction_color, selected_style};

pub const TITLE: &str = "ONI";

/// The chart screen shows the watchlist, book, and tape column from this terminal width. The
/// chart tests use widths up to 60, so they stay on the narrow layout (watchlist strip on row
/// 0, chart panel below it).
pub const WIDE_MIN_WIDTH: u16 = 100;

/// Fewest terminal rows for a wide screen that reserves the bottom row for the command bar. The
/// existing layout tests use 30 rows or fewer, so they keep their layouts. On shorter screens
/// the bar appears over the bottom row only while it has the keyboard or shows an error.
pub const BAR_MIN_HEIGHT_WIDE: u16 = 31;
/// The same for narrow screens. The narrow layout tests use 14 rows or fewer.
pub const BAR_MIN_HEIGHT_NARROW: u16 = 16;
/// Fewest terminal rows for the Positions / Open orders / P&L strip (wide screens only).
pub const STRIP_MIN_HEIGHT: u16 = 40;
/// Rows of the strip: two borders, the header, and five rows.
pub const STRIP_HEIGHT: u16 = 8;

/// Timeframe buttons, left to right (Req 25.3).
pub const TIMEFRAMES: [Timeframe; 5] = [
    Timeframe::M1,
    Timeframe::M5,
    Timeframe::M15,
    Timeframe::H1,
    Timeframe::D1,
];

/// Draws one frame and rebuilds the hit map for it (Req 35.1).
pub fn draw(frame: &mut Frame, app: &App, hits: &mut HitMap) {
    hits.clear();
    if !app.candles.is_empty() {
        draw_chart(frame, app, hits);
        crate::pairing_dialog::draw(frame, &app.pairing);
        return;
    }
    hits.register(frame.area(), HitTarget::Panel(PanelId::Status));
    let mut lines = vec![
        Line::from(TITLE),
        Line::from(""),
        Line::from(format!("server: {}", app.server)),
        Line::from(""),
    ];
    match app.conn {
        ConnState::Connected => {
            lines.push(Line::from("CONNECTED"));
            lines.push(Line::from(connected_summary(app)));
        }
        state => lines.push(Line::from(waking_status(state))),
    }
    if let Some(error) = &app.last_error {
        lines.push(Line::from(format!("last error: {error}")));
    }
    lines.push(Line::from(""));
    lines.push(Line::from("press q to quit, P to sign in with a wallet"));

    let block = Block::bordered().title(TITLE);
    let paragraph = Paragraph::new(lines)
        .block(block)
        .alignment(Alignment::Center);
    frame.render_widget(paragraph, frame.area());
    crate::pairing_dialog::draw(frame, &app.pairing);
}

/// The chart screen: the candle chart (Req 25.1), and on wide terminals a right column with the
/// watchlist over the order book over the trades tape (Req 27.1–27.3). Narrower terminals show
/// a one-line watchlist strip above the chart instead.
fn draw_chart(frame: &mut Frame, app: &App, hits: &mut HitMap) {
    let full = frame.area();
    let wide = full.width >= WIDE_MIN_WIDTH;
    let bar_rows = order_widget::command_rows(app);
    let min_height = if wide {
        BAR_MIN_HEIGHT_WIDE
    } else {
        BAR_MIN_HEIGHT_NARROW
    };
    // The command bar is the bottom row (three rows under a parse error). On a short screen it
    // is drawn over the bottom rows instead, but only while it is in use.
    let reserved = full.height >= min_height;
    let (rest, bar_area) = if reserved {
        let [rest, bar] =
            Layout::vertical([Constraint::Min(0), Constraint::Length(bar_rows)]).areas(full);
        (rest, Some(bar))
    } else if order_widget::bar_active(app) {
        let rows = bar_rows.min(full.height);
        let bar = Rect::new(full.x, full.y + (full.height - rows), full.width, rows);
        (full, Some(bar))
    } else {
        (full, None)
    };
    // The strip sits above the bar on tall wide screens; elsewhere the bar shows a one-line
    // P&L summary.
    let with_strip = wide && reserved && full.height >= STRIP_MIN_HEIGHT;
    let (main, strip_area) = if with_strip {
        let [main, strip] =
            Layout::vertical([Constraint::Min(0), Constraint::Length(STRIP_HEIGHT)]).areas(rest);
        (main, Some(strip))
    } else {
        (rest, None)
    };
    draw_main(frame, app, hits, main);
    if let Some(strip) = strip_area {
        order_widget::draw_strip(frame, app, hits, strip);
    }
    if let Some(bar) = bar_area {
        order_widget::draw_command_bar(frame, app, hits, bar, !with_strip);
    }
    order_widget::draw_dialogs(frame, app, hits);
}

/// The chart, watchlist, book, and tape inside `area`.
fn draw_main(frame: &mut Frame, app: &App, hits: &mut HitMap, area: Rect) {
    if area.width < WIDE_MIN_WIDTH {
        let [strip, chart_area] =
            Layout::vertical([Constraint::Length(1), Constraint::Min(0)]).areas(area);
        draw_watchlist_strip(frame, app, hits, strip);
        draw_chart_panel(frame, app, hits, chart_area);
        return;
    }
    let side_width = (area.width / 5 * 2).clamp(40, 56);
    let [chart_area, side_area] =
        Layout::horizontal([Constraint::Min(0), Constraint::Length(side_width)]).areas(area);
    draw_chart_panel(frame, app, hits, chart_area);
    draw_side_column(frame, app, hits, side_area);
}

/// The watchlist panel: one row per symbol, each row registered in the hit map (Req 27.3, 27.4).
fn draw_watchlist_panel(frame: &mut Frame, app: &App, hits: &mut HitMap, area: Rect) {
    hits.register(area, HitTarget::Panel(PanelId::Watchlist));
    frame.render_widget(
        WatchlistWidget::new(&app.watchlist, &app.quotes, &app.symbol),
        area,
    );
    let inner = WatchlistWidget::inner(area);
    for (i, symbol) in app
        .watchlist
        .iter()
        .take(usize::from(inner.height))
        .enumerate()
    {
        if let Ok(dy) = u16::try_from(i) {
            let rect = Rect::new(inner.x, inner.y + dy, inner.width, 1);
            hits.register(rect, HitTarget::WatchlistSymbol(symbol.clone()));
        }
    }
}

/// The one-line watchlist of narrow layouts: `BTC 64000.00 | ETH 3200.00 | SOL 150.00`. Each
/// segment takes its price direction color, the selected one is reversed, and each segment
/// that fits is registered in the hit map (Req 27.3, 27.4).
fn draw_watchlist_strip(frame: &mut Frame, app: &App, hits: &mut HitMap, strip: Rect) {
    hits.register(strip, HitTarget::Panel(PanelId::Watchlist));
    let mut spans = Vec::new();
    let end = u32::from(strip.x) + u32::from(strip.width);
    let mut x = u32::from(strip.x);
    for (i, symbol) in app.watchlist.iter().enumerate() {
        let separator = if i == 0 { "" } else { " | " };
        let separator_width = u32::try_from(separator.chars().count()).unwrap_or(u32::MAX);
        let quote = app.quotes.get(symbol);
        let text = strip_segment(symbol, quote);
        let width = u32::try_from(text.chars().count()).unwrap_or(u32::MAX);
        let start = x.saturating_add(separator_width);
        if start.saturating_add(width) > end {
            break;
        }
        let color = direction_color(quote.map_or(Direction::Flat, WatchQuote::direction));
        let mut style = Style::new().fg(color);
        if *symbol == app.symbol {
            style = style.patch(selected_style());
        }
        let rect = Rect::new(
            u16::try_from(start).unwrap_or(u16::MAX),
            strip.y,
            u16::try_from(width).unwrap_or(u16::MAX),
            strip.height,
        );
        hits.register(rect, HitTarget::WatchlistSymbol(symbol.clone()));
        if !separator.is_empty() {
            spans.push(Span::raw(separator));
        }
        spans.push(Span::styled(text, style));
        x = start.saturating_add(width);
    }
    frame.render_widget(Paragraph::new(Line::from(spans)), strip);
}

/// The watchlist (top), the book, the ticket line, and the tape (bottom).
fn draw_side_column(frame: &mut Frame, app: &App, hits: &mut HitMap, area: Rect) {
    let watch_height = WatchlistWidget::height_for(app.watchlist.len()).min(area.height);
    let [watch_area, area] =
        Layout::vertical([Constraint::Length(watch_height), Constraint::Min(0)]).areas(area);
    draw_watchlist_panel(frame, app, hits, watch_area);

    let [book_area, ticket_area, tape_area] = Layout::vertical([
        Constraint::Percentage(60),
        Constraint::Length(1),
        Constraint::Min(0),
    ])
    .areas(area);

    hits.register(book_area, HitTarget::Panel(PanelId::Book));
    let book = app.book();
    frame.render_widget(
        BookWidget::new(&app.symbol, book, app.book_cursor),
        book_area,
    );
    if let Some(book) = book.filter(|b| !b.is_empty()) {
        let inner = BookWidget::inner(book_area);
        for (i, row) in layout_rows(book, usize::from(inner.height))
            .iter()
            .enumerate()
        {
            if let (BookRow::Level { side, index, .. }, Ok(dy)) = (row, u16::try_from(i)) {
                let rect = Rect::new(inner.x, inner.y + dy, inner.width, 1);
                hits.register(
                    rect,
                    HitTarget::BookLevel {
                        side: *side,
                        index: *index,
                    },
                );
            }
        }
    }

    // Req 30.1, 30.2: the ticket line with the book's limit price (selected symbol only), the
    // quantity, and the BUY and SELL buttons.
    order_widget::draw_ticket_line(frame, app, hits, ticket_area);

    hits.register(tape_area, HitTarget::Panel(PanelId::Tape));
    frame.render_widget(TapeWidget::new(&app.symbol, &app.tape), tape_area);
}

/// The chart panel with its timeframe buttons inside `area`.
fn draw_chart_panel(frame: &mut Frame, app: &App, hits: &mut HitMap, area: Rect) {
    let title = format!(" {} {} ", app.symbol, app.timeframe);
    let title_width = title.chars().count();
    let block = Block::bordered().title(title);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    hits.register(area, HitTarget::Panel(PanelId::Chart));
    if let Some(hello) = &app.hello {
        // The identity (GUEST or the short address) follows the mode once the session arrives.
        let mode = venue_label(hello.venue, hello.data_mode);
        let label = match &app.session {
            Some(session) => format!(" {mode} · {} ", session.label()),
            None => format!(" {mode} "),
        };
        draw_mode_label(frame.buffer_mut(), area, title_width, &label);
    }

    let empty = IndicatorSeries::default();
    let series = app.indicator_series().unwrap_or(&empty);
    // Req 26.4: the legend row exists only while some enabled indicator has a value, so the
    // chart layout does not change before indicator data arrives.
    let legend = legend_text(series, &app.toggles);
    let legend_height = u16::from(!legend.is_empty());

    let [strip, legend_area, chart_area] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Length(legend_height),
        Constraint::Min(0),
    ])
    .areas(inner);
    let next_x = draw_timeframe_buttons(frame, app, hits, strip);
    draw_indicator_toggles(frame, app, hits, strip, next_x);
    if legend_height > 0 {
        frame.render_widget(
            Paragraph::new(legend).style(Style::new().fg(Color::Gray)),
            legend_area,
        );
    }

    // Req 26.2: the RSI/ATR sub-pane takes the bottom quarter of a tall enough chart column.
    let sub_rows = if app.toggles.wants_subpane() {
        subpane_rows(chart_area.height)
    } else {
        0
    };
    let [price_area, sub_area] =
        Layout::vertical([Constraint::Min(0), Constraint::Length(sub_rows)]).areas(chart_area);

    let plot_width = usize::from(price_area.width.saturating_sub(AXIS_WIDTH));
    let shown = visible_bars(&app.candles, plot_width, &app.chart_view);
    let hook = |buf: &mut Buffer, geometry: &PlotGeometry| {
        draw_overlays(buf, geometry, shown, series, &app.toggles);
    };
    let chart = CandleChart::new(&app.candles, app.timeframe, app.chart_view)
        .crosshair(app.crosshair)
        .overlay(&hook);
    frame.render_widget(chart, price_area);
    hits.register(price_area, HitTarget::Chart);
    if sub_rows > 0 {
        draw_subpane(frame.buffer_mut(), sub_area, shown, series, &app.toggles);
    }
}

/// The data-mode status (`REPLAY` or `LIVE · <venue>`, Req 44.7), right-aligned in the top
/// border of the chart panel. Drawn only when it fits after the title with one border cell
/// between them, so it never covers the title.
fn draw_mode_label(buf: &mut Buffer, area: Rect, title_width: usize, label: &str) {
    let label_width = label.chars().count();
    // Corner, title, at least one border cell, label, corner.
    let needed = title_width.saturating_add(label_width).saturating_add(3);
    if area.height == 0 || needed > usize::from(area.width) {
        return;
    }
    let Ok(label_cols) = u16::try_from(label_width) else {
        return;
    };
    let x = area.x + area.width - 1 - label_cols;
    buf.set_stringn(
        x,
        area.y,
        label,
        label_width,
        Style::new().fg(Color::Yellow),
    );
}

/// The one-line toggle strip `EMA VWAP BB RSI ATR` after the timeframe buttons, starting at
/// column `start`. Active toggles are drawn in their line color, reversed. Each button that
/// fits is registered in the hit map (Req 26.3).
fn draw_indicator_toggles(
    frame: &mut Frame,
    app: &App,
    hits: &mut HitMap,
    strip: Rect,
    start: u16,
) {
    let mut spans = Vec::new();
    let end = u32::from(strip.x) + u32::from(strip.width);
    let mut x = u32::from(start);
    for indicator in Indicator::ALL {
        let label = format!(" {} ", indicator.label());
        let width = u32::try_from(label.chars().count()).unwrap_or(u32::MAX);
        if x + width > end {
            break;
        }
        let style = if app.toggles.is_on(indicator) {
            Style::new()
                .fg(indicator_color(indicator))
                .add_modifier(Modifier::REVERSED | Modifier::BOLD)
        } else {
            Style::new().fg(Color::DarkGray)
        };
        let rect = Rect::new(
            u16::try_from(x).unwrap_or(u16::MAX),
            strip.y,
            u16::try_from(width).unwrap_or(u16::MAX),
            strip.height,
        );
        spans.push(Span::styled(label, style));
        spans.push(Span::raw(" "));
        hits.register(rect, HitTarget::IndicatorToggle(indicator));
        x += width + 1;
    }
    let strip_end = strip.x.saturating_add(strip.width);
    let first = start.min(strip_end);
    let rect = Rect::new(first, strip.y, strip_end - first, strip.height);
    frame.render_widget(Paragraph::new(Line::from(spans)), rect);
}

/// One-line button strip: `1m 5m 15m 1h 1d`, the active one highlighted. Each visible button
/// is registered in the hit map. Returns the column after the last button.
fn draw_timeframe_buttons(frame: &mut Frame, app: &App, hits: &mut HitMap, strip: Rect) -> u16 {
    let mut spans = Vec::new();
    let mut x = u32::from(strip.x);
    let end = u32::from(strip.x) + u32::from(strip.width);
    for timeframe in TIMEFRAMES {
        let label = format!(" {timeframe} ");
        let width = u32::try_from(label.chars().count()).unwrap_or(u32::MAX);
        if x + width > end {
            break;
        }
        let style = if timeframe == app.timeframe {
            Style::new().add_modifier(Modifier::REVERSED | Modifier::BOLD)
        } else {
            Style::new()
        };
        spans.push(Span::styled(label, style));
        spans.push(Span::raw(" "));
        let rect = Rect::new(
            u16::try_from(x).unwrap_or(u16::MAX),
            strip.y,
            u16::try_from(width).unwrap_or(u16::MAX),
            strip.height,
        );
        hits.register(rect, HitTarget::TimeframeButton(timeframe));
        x += width + 1;
    }
    frame.render_widget(Paragraph::new(Line::from(spans)), strip);
    u16::try_from(x).unwrap_or(u16::MAX)
}

/// The "waking server" line shown while there is no open connection (Req 33.1).
pub fn waking_status(state: ConnState) -> String {
    match state {
        ConnState::Waking {
            attempt,
            next_delay,
        } => format!(
            "WAKING SERVER… attempt {attempt}, retry in {} s",
            seconds(next_delay)
        ),
        ConnState::Connecting => "WAKING SERVER… connecting".to_owned(),
        ConnState::Disconnected => "WAKING SERVER… connection lost, retrying".to_owned(),
        ConnState::Connected => "CONNECTED".to_owned(),
    }
}

fn connected_summary(app: &App) -> String {
    let protocol = app.hello.as_ref().map_or_else(
        || "protocol ?".to_owned(),
        |h| format!("protocol v{}", h.protocol_version),
    );
    let mode = app.hello.as_ref().map_or_else(
        || "…".to_owned(),
        |h| venue_label(h.venue, h.data_mode),
    );
    let account = app
        .session
        .as_ref()
        .map_or_else(|| "…".to_owned(), crate::app::SessionInfo::label);
    let engine = match &app.hello {
        Some(h) if !h.engine_running => " · ENGINE DOWN",
        _ => "",
    };
    format!(
        "{protocol} · {mode} · account {account} · events {}{engine}",
        app.events_received
    )
}

/// Seconds with one decimal, rounded to the nearest tenth: 250 ms is `0.3`, 10 s is `10.0`.
fn seconds(delay: Duration) -> String {
    let tenths = delay.as_millis().saturating_add(50) / 100;
    format!("{}.{}", tenths / 10, tenths % 10)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::update;
    use crate::cli::DEFAULT_SERVER_URL;
    use crate::net::NetEvent;
    use protocol::client::{DataMode, InstrumentInfo, ServerMessage};
    use protocol::{AccountId, ErrorCode, Event, Venue};
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;

    fn screen_text(width: u16, height: u16, app: &App) -> Vec<String> {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        let mut hits = HitMap::new();
        terminal.draw(|f| draw(f, app, &mut hits)).unwrap();
        let buffer = terminal.backend().buffer();
        (0..height)
            .map(|y| {
                (0..width)
                    .map(|x| buffer[(x, y)].symbol().to_owned())
                    .collect::<String>()
            })
            .collect()
    }

    fn hello(data_mode: DataMode, venue: Option<Venue>) -> NetEvent {
        NetEvent::Message(ServerMessage::Hello {
            protocol_version: 2,
            data_mode,
            venue,
            engine_running: true,
            instruments: InstrumentInfo::all(),
        })
    }

    #[test]
    fn shows_title_url_and_quit_hint() {
        let rows = screen_text(80, 12, &App::new(DEFAULT_SERVER_URL));
        let text = rows.join("\n");
        assert!(rows[0].contains(TITLE), "title missing: {}", rows[0]);
        assert!(
            text.contains(&format!("server: {DEFAULT_SERVER_URL}")),
            "{text}"
        );
        assert!(text.contains("press q to quit"), "{text}");
    }

    // Req 33.1
    #[test]
    fn shows_waking_server_with_attempt_and_retry_delay() {
        let mut app = App::new("ws://localhost:8080/ws");
        let text = screen_text(80, 12, &app).join("\n");
        assert!(text.contains("WAKING SERVER… connecting"), "{text}");

        update(
            &mut app,
            NetEvent::Disconnected {
                reason: "connection refused".into(),
            },
        );
        update(
            &mut app,
            NetEvent::Connecting {
                attempt: 3,
                next_delay: Duration::from_millis(500),
            },
        );
        let text = screen_text(80, 12, &app).join("\n");
        assert!(
            text.contains("WAKING SERVER… attempt 3, retry in 0.5 s"),
            "{text}"
        );
        assert!(text.contains("last error: connection refused"), "{text}");
        assert!(!text.contains("CONNECTED"), "{text}");
    }

    #[test]
    fn shows_protocol_venue_account_and_event_count_when_connected() {
        let mut app = App::new("ws://localhost:8080/ws");
        update(&mut app, NetEvent::Connected);
        update(&mut app, hello(DataMode::Live, Some(Venue::Backpack)));
        update(
            &mut app,
            NetEvent::Message(ServerMessage::Session {
                account_id: AccountId::new("guest").unwrap(),
                address: None,
            }),
        );
        for _ in 0..3 {
            update(
                &mut app,
                NetEvent::Message(ServerMessage::Event {
                    event: Event::Heartbeat { ts: 1 },
                }),
            );
        }
        let text = screen_text(100, 12, &app).join("\n");
        assert!(text.contains("CONNECTED"), "{text}");
        assert!(
            text.contains("protocol v2 · LIVE · Backpack (USDC) · account GUEST · events 3"),
            "{text}"
        );
        assert!(!text.contains("WAKING SERVER"), "{text}");

        update(&mut app, NetEvent::Connected);
        update(&mut app, hello(DataMode::Replay, None));
        let text = screen_text(100, 12, &app).join("\n");
        assert!(
            text.contains("protocol v2 · REPLAY · account … · events 3"),
            "{text}"
        );
    }

    #[test]
    fn server_errors_show_as_last_error() {
        let mut app = App::new("ws://localhost:8080/ws");
        update(&mut app, NetEvent::Connected);
        update(
            &mut app,
            NetEvent::Message(ServerMessage::Event {
                event: Event::Error {
                    code: ErrorCode::InvalidJson,
                    message: "oops".into(),
                },
            }),
        );
        let text = screen_text(100, 12, &app).join("\n");
        assert!(text.contains("last error: server error"), "{text}");
    }

    #[test]
    fn draws_the_chart_when_candles_exist() {
        use protocol::{Bar, Price, Qty};
        let mut app = App::new("ws://localhost:8080/ws");
        let bar = Bar {
            t: 0,
            open: Price(100),
            high: Price(120),
            low: Price(90),
            close: Price(110),
            volume: Qty(1),
        };
        app.apply_candles(true, &[bar]);
        let rows = screen_text(60, 14, &app);
        // Row 0 is the narrow watchlist strip; the chart panel starts on row 1.
        assert!(rows[0].starts_with("BTC — | ETH — | SOL —"), "{}", rows[0]);
        assert!(rows[1].contains("BTC-USD 1m"), "{}", rows[1]);
        assert!(!rows.join("\n").contains("press q to quit"));
        assert!(rows.join("\n").contains('█'));
    }

    // Req 25.3, 35.1
    #[test]
    fn chart_frame_registers_buttons_and_chart_in_the_hit_map() {
        use protocol::{Bar, Price, Qty};
        let mut app = App::new("ws://localhost:8080/ws");
        app.apply_candles(
            true,
            &[Bar {
                t: 0,
                open: Price(100),
                high: Price(120),
                low: Price(90),
                close: Price(110),
                volume: Qty(1),
            }],
        );
        let mut terminal = Terminal::new(TestBackend::new(60, 14)).unwrap();
        let mut hits = HitMap::new();
        terminal.draw(|f| draw(f, &app, &mut hits)).unwrap();
        // Row 0 is the watchlist strip, so the chart panel starts on row 1 and its button strip
        // is row 2 (inside the border). " 1m " starts at column 1.
        assert_eq!(
            hits.resolve(2, 2),
            Some(&HitTarget::TimeframeButton(Timeframe::M1))
        );
        assert_eq!(hits.resolve(10, 5), Some(&HitTarget::Chart));
        assert_eq!(hits.resolve(0, 1), Some(&HitTarget::Panel(PanelId::Chart)));
        assert_eq!(
            hits.resolve(0, 0),
            Some(&HitTarget::WatchlistSymbol("BTC-USD".to_owned()))
        );
    }

    fn app_with_book() -> App {
        use crate::book_model::{BookState, TapeEntry};
        use protocol::{Bar, Level, Price, Qty, Side};
        let mut app = App::new("ws://localhost:8080/ws");
        app.apply_candles(
            true,
            &[Bar {
                t: 0,
                open: Price(100),
                high: Price(120),
                low: Price(90),
                close: Price(110),
                volume: Qty(1),
            }],
        );
        let level = |p: i64, q: i64| Level {
            price: Price(p),
            qty: Qty(q),
        };
        app.apply_book(
            "BTC-USD".to_owned(),
            BookState {
                asks: vec![level(6_400_100, 200_000_000), level(6_400_200, 100_000_000)],
                bids: vec![level(6_400_000, 100_000_000), level(6_399_900, 50_000_000)],
                spread: Some(Price(100)),
                imbalance_bps: 250,
                ts: 0,
            },
        );
        app.push_trade(TapeEntry {
            symbol: "BTC-USD".to_owned(),
            price: Price(6_400_050),
            qty: Qty(10_000_000),
            side: Side::Buy,
            ts: 3_661_000,
        });
        app
    }

    fn draw_with_hits(width: u16, height: u16, app: &App) -> (Vec<String>, HitMap) {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        let mut hits = HitMap::new();
        terminal.draw(|f| draw(f, app, &mut hits)).unwrap();
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

    /// The rows (y) where `x` resolves to a book level.
    fn level_rows(hits: &HitMap, x: u16, height: u16) -> Vec<(u16, HitTarget)> {
        (0..height)
            .filter_map(|y| {
                hits.resolve(x, y)
                    .filter(|t| matches!(t, HitTarget::BookLevel { .. }))
                    .map(|t| (y, t.clone()))
            })
            .collect()
    }

    // Req 27.1, 27.2
    #[test]
    fn wide_terminals_show_the_book_and_tape_beside_the_chart() {
        use crate::hitmap::BookSide;
        let app = app_with_book();
        let (rows, hits) = draw_with_hits(120, 30, &app);
        let text = rows.join("\n");
        assert!(text.contains("BOOK BTC-USD"), "{text}");
        assert!(text.contains("TAPE"), "{text}");
        assert!(text.contains("64001.00"), "{text}");
        assert!(text.contains("01:01:01"), "{text}");
        assert!(text.contains("TICKET: -"), "{text}");
        // The chart keeps the left side and its own panel rectangle.
        assert!(rows[0].contains("BTC-USD 1m"));
        assert_eq!(hits.resolve(0, 0), Some(&HitTarget::Panel(PanelId::Chart)));
        // The watchlist (5 rows) sits above the book at the top of the right column.
        assert_eq!(
            hits.resolve(115, 0),
            Some(&HitTarget::Panel(PanelId::Watchlist))
        );
        assert_eq!(hits.resolve(115, 5), Some(&HitTarget::Panel(PanelId::Book)));
        assert_eq!(hits.resolve(115, 29), Some(&HitTarget::Panel(PanelId::Tape)));
        // Four level rows, ask 1, ask 0, (spread), bid 0, bid 1.
        let levels = level_rows(&hits, 100, 30);
        let kinds: Vec<(BookSide, usize)> = levels
            .iter()
            .filter_map(|(_, t)| match t {
                HitTarget::BookLevel { side, index } => Some((*side, *index)),
                _ => None,
            })
            .collect();
        assert_eq!(
            kinds,
            [
                (BookSide::Ask, 1),
                (BookSide::Ask, 0),
                (BookSide::Bid, 0),
                (BookSide::Bid, 1)
            ]
        );
        // The best ask and best bid are separated by the spread row.
        assert_eq!(levels[2].0, levels[1].0 + 2);
        // The ask row text sits on the row of its hit rectangle.
        assert!(rows[usize::from(levels[1].0)].contains("64001.00"));
    }

    #[test]
    fn narrow_terminals_keep_the_chart_only() {
        let app = app_with_book();
        let (rows, hits) = draw_with_hits(WIDE_MIN_WIDTH - 1, 30, &app);
        let text = rows.join("\n");
        assert!(!text.contains("BOOK"), "{text}");
        assert!(!text.contains("TAPE"), "{text}");
        assert!(level_rows(&hits, 50, 30).is_empty());
        // Row 0 is the watchlist strip; the chart panel starts on row 1.
        assert_eq!(hits.resolve(0, 1), Some(&HitTarget::Panel(PanelId::Chart)));
        let (rows, _) = draw_with_hits(WIDE_MIN_WIDTH, 30, &app);
        assert!(rows.join("\n").contains("BOOK BTC-USD"));
    }

    // Req 30.1
    #[test]
    fn the_ticket_line_shows_the_prefilled_price() {
        use protocol::Price;
        let mut app = app_with_book();
        app.prefill_limit("BTC-USD", Price(6_400_100));
        let (rows, _) = draw_with_hits(120, 30, &app);
        assert!(
            rows.join("\n").contains("TICKET: LMT 64001.00"),
            "{}",
            rows.join("\n")
        );
    }

    #[test]
    fn a_wide_screen_without_book_data_says_no_data() {
        let mut app = app_with_book();
        app.books.clear();
        app.tape.clear();
        let (rows, hits) = draw_with_hits(120, 30, &app);
        assert!(rows.join("\n").contains("no data"));
        assert!(level_rows(&hits, 100, 30).is_empty());
    }

    fn with_indicators() -> App {
        use protocol::IndicatorValues;
        let mut app = app_with_book();
        app.apply_indicators(
            "BTC-USD",
            Timeframe::M1,
            0,
            IndicatorValues {
                ema: Some(6_400_050.0),
                atr: Some(1_234.0),
                rsi: Some(55.0),
                ..IndicatorValues::default()
            },
        );
        app
    }

    fn slice(rows: &[String], y: usize, x0: usize, len: usize) -> String {
        rows[y].chars().skip(x0).take(len).collect()
    }

    // Req 26.4
    #[test]
    fn the_legend_shows_the_latest_enabled_values_under_the_title() {
        // Narrow layout: row 0 is the watchlist strip, row 1 the chart border, row 2 the
        // buttons, and row 3 the legend.
        let mut app = with_indicators();
        let (rows, _) = draw_with_hits(60, 14, &app);
        assert!(rows[3].contains("EMA 64000.50  RSI 55.0"), "{}", rows[3]);
        assert!(!rows[3].contains("ATR"), "{}", rows[3]);
        app.toggles.atr = true;
        app.toggles.ema = false;
        let (rows, _) = draw_with_hits(60, 14, &app);
        assert!(rows[3].contains("RSI 55.0  ATR 12.34"), "{}", rows[3]);
        // No indicator data: no legend row, so the chart layout is the old one.
        let (rows, _) = draw_with_hits(60, 14, &app_with_book());
        assert!(!rows[3].contains("EMA"), "{}", rows[3]);
    }

    // Req 26.3
    #[test]
    fn toggle_buttons_follow_the_timeframe_buttons_in_the_hit_map() {
        // Narrow layout: the button row is row 2, below the watchlist strip and the border.
        let (rows, hits) = draw_with_hits(60, 14, &with_indicators());
        assert!(rows[2].contains("EMA") && rows[2].contains("ATR"), "{}", rows[2]);
        for (x, indicator) in [
            (28, Indicator::Ema),
            (34, Indicator::Vwap),
            (41, Indicator::Bollinger),
            (46, Indicator::Rsi),
            (52, Indicator::Atr),
        ] {
            assert_eq!(hits.resolve(x, 2), Some(&HitTarget::IndicatorToggle(indicator)), "x {x}");
        }
        assert_eq!(
            hits.resolve(2, 2),
            Some(&HitTarget::TimeframeButton(Timeframe::M1))
        );
    }

    // Req 27.3, 27.4
    #[test]
    fn wide_terminals_show_the_watchlist_above_the_book() {
        let mut app = app_with_book();
        update(
            &mut app,
            NetEvent::Message(ServerMessage::Event {
                event: Event::Trade {
                    symbol: "ETH-USD".into(),
                    price: protocol::Price(320_000),
                    qty: protocol::Qty(1),
                    side: protocol::Side::Sell,
                    ts: 1,
                },
            }),
        );
        let (rows, hits) = draw_with_hits(120, 30, &app);
        // The right column starts at x 72; the watchlist rows are y 1..=3.
        assert!(slice(&rows, 0, 72, 48).contains("WATCHLIST"), "{}", rows[0]);
        let btc = slice(&rows, 1, 72, 48);
        assert!(btc.contains("BTC-USD") && btc.contains("64000.50"), "{btc}");
        assert!(slice(&rows, 2, 72, 48).contains("3200.00"));
        assert!(slice(&rows, 3, 72, 48).contains("—"));
        assert_eq!(hits.resolve(80, 0), Some(&HitTarget::Panel(PanelId::Watchlist)));
        for (y, symbol) in [(1, "BTC-USD"), (2, "ETH-USD"), (3, "SOL-USD")] {
            assert_eq!(
                hits.resolve(80, y),
                Some(&HitTarget::WatchlistSymbol(symbol.to_owned())),
                "y {y}"
            );
        }
        // The book follows the selected symbol.
        assert!(rows.join("\n").contains("BOOK BTC-USD"));
    }

    // Req 27.3, 27.4
    #[test]
    fn narrow_terminals_show_a_watchlist_strip_above_the_chart() {
        let mut app = app_with_book();
        app.select_symbol("ETH-USD");
        app.apply_candles(
            true,
            &[protocol::Bar {
                t: 0,
                open: protocol::Price(100),
                high: protocol::Price(120),
                low: protocol::Price(90),
                close: protocol::Price(110),
                volume: protocol::Qty(1),
            }],
        );
        let mut terminal = Terminal::new(TestBackend::new(60, 14)).unwrap();
        let mut hits = HitMap::new();
        terminal.draw(|f| draw(f, &app, &mut hits)).unwrap();
        let buffer = terminal.backend().buffer();
        let row_text = |y: u16| -> String {
            (0..60)
                .map(|x| buffer[(x, y)].symbol().to_owned())
                .collect()
        };
        let row0 = row_text(0);
        assert!(row0.starts_with("BTC 64000.50 | ETH — | SOL —"), "{row0}");
        // Segments: BTC x 0..12, ETH x 15..20, SOL x 23..28; separators belong to the strip.
        let symbol = |s: &str| Some(HitTarget::WatchlistSymbol(s.to_owned()));
        assert_eq!(hits.resolve(0, 0), symbol("BTC-USD").as_ref());
        assert_eq!(hits.resolve(11, 0), symbol("BTC-USD").as_ref());
        assert_eq!(hits.resolve(13, 0), Some(&HitTarget::Panel(PanelId::Watchlist)));
        assert_eq!(hits.resolve(15, 0), symbol("ETH-USD").as_ref());
        assert_eq!(hits.resolve(27, 0), symbol("SOL-USD").as_ref());
        assert_eq!(hits.resolve(40, 0), Some(&HitTarget::Panel(PanelId::Watchlist)));
        // The selected symbol is reversed, the others are not.
        let reversed = |x: u16| {
            let style = buffer[(x, 0)].style();
            style.add_modifier.contains(Modifier::REVERSED)
        };
        assert!(reversed(15) && reversed(19));
        assert!(!reversed(0) && !reversed(23));
        // Every panel follows the selection.
        let row1 = row_text(1);
        assert!(row1.contains("ETH-USD 1m"), "{row1}");
    }

    #[test]
    fn the_strip_drops_segments_that_do_not_fit() {
        let app = app_with_book();
        let (rows, hits) = draw_with_hits(22, 10, &app);
        // "BTC 64000.50 | ETH —" is 20 columns; " | SOL —" would end at 28.
        assert!(rows[0].starts_with("BTC 64000.50 | ETH —"), "{}", rows[0]);
        assert!(!rows[0].contains("SOL"), "{}", rows[0]);
        let sol = HitTarget::WatchlistSymbol("SOL-USD".to_owned());
        assert!((0..22).all(|x| hits.resolve(x, 0) != Some(&sol)));
        // Tiny screens draw without panicking.
        for (w, h) in [(1, 1), (5, 2), (12, 3)] {
            let _ = draw_with_hits(w, h, &app);
        }
    }

    // Req 44.7
    #[test]
    fn the_chart_border_shows_the_data_mode_from_hello() {
        let mut app = app_with_book();
        let (rows, _) = draw_with_hits(60, 14, &app);
        assert!(!rows[1].contains("REPLAY") && !rows[1].contains("LIVE"), "{}", rows[1]);
        update(&mut app, hello(DataMode::Live, Some(Venue::Backpack)));
        let (rows, _) = draw_with_hits(60, 14, &app);
        assert!(rows[1].contains("BTC-USD 1m"), "{}", rows[1]);
        assert!(rows[1].ends_with(" LIVE · Backpack (USDC) ┐"), "{}", rows[1]);
        let (rows, _) = draw_with_hits(120, 30, &app);
        assert!(slice(&rows, 0, 0, 72).contains("LIVE · Backpack (USDC)"), "{}", rows[0]);
        update(&mut app, hello(DataMode::Live, Some(Venue::Coinbase)));
        let (rows, _) = draw_with_hits(60, 14, &app);
        assert!(rows[1].contains(" LIVE · Coinbase "), "{}", rows[1]);
        update(&mut app, hello(DataMode::Live, None));
        let (rows, _) = draw_with_hits(60, 14, &app);
        assert!(rows[1].ends_with(" LIVE ┐"), "{}", rows[1]);
        update(&mut app, hello(DataMode::Replay, None));
        let (rows, _) = draw_with_hits(60, 14, &app);
        assert!(rows[1].ends_with(" REPLAY ┐"), "{}", rows[1]);
        // Too narrow for title and label: the title wins and no label is drawn.
        let (rows, _) = draw_with_hits(20, 10, &app);
        assert!(!rows[1].contains("REPLAY"), "{}", rows[1]);
    }

    // Req 48.14: the chart border names the account once the session exists.
    #[test]
    fn the_chart_border_shows_guest_or_the_short_address_once_a_session_exists() {
        let mut app = app_with_book();
        update(&mut app, hello(DataMode::Live, Some(Venue::Backpack)));
        // No session yet: the mode only.
        let (rows, _) = draw_with_hits(80, 14, &app);
        assert!(!rows[1].contains("GUEST"), "{}", rows[1]);
        assert!(rows[1].ends_with(" LIVE · Backpack (USDC) ┐"), "{}", rows[1]);
        // The guest account.
        update(
            &mut app,
            NetEvent::Message(ServerMessage::Session {
                account_id: AccountId::new("guest").unwrap(),
                address: None,
            }),
        );
        let (rows, _) = draw_with_hits(80, 14, &app);
        assert!(rows[1].contains("BTC-USD 1m"), "{}", rows[1]);
        assert!(rows[1].ends_with(" LIVE · Backpack (USDC) · GUEST ┐"), "{}", rows[1]);
        // A wallet account shows the shortened address and no GUEST.
        let address = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
        update(
            &mut app,
            NetEvent::Message(ServerMessage::Session {
                account_id: AccountId::new(format!("w_{address}")).unwrap(),
                address: Some(address.to_owned()),
            }),
        );
        let (rows, _) = draw_with_hits(80, 14, &app);
        assert!(rows[1].ends_with(" LIVE · Backpack (USDC) · 9WzD…AWWM ┐"), "{}", rows[1]);
        assert!(!rows[1].contains("GUEST"), "{}", rows[1]);
        assert!(!rows[1].contains(address), "{}", rows[1]);
    }

    // Req 26.2
    #[test]
    fn the_subpane_needs_a_tall_chart_column_and_a_toggle() {
        let mut app = with_indicators();
        // 30 rows: the chart column has 27 rows, so a 6 row sub-pane starts at row 23.
        let (rows, _) = draw_with_hits(120, 30, &app);
        assert!(slice(&rows, 23, 62, 3) == "100", "{:?}", slice(&rows, 23, 62, 10));
        // 22 rows: the chart column has 19 rows, below the 20 row threshold.
        let (rows, _) = draw_with_hits(120, 22, &app);
        assert!((0..22).all(|y| !slice(&rows, y, 62, 10).contains("100")));
        // RSI and ATR off: no sub-pane even when tall.
        app.toggles.rsi = false;
        let (rows, _) = draw_with_hits(120, 30, &app);
        assert!((0..30).all(|y| !slice(&rows, y, 62, 10).contains("100")));
        // The sub-pane never changes the wide layout of the side column.
        assert!(rows.join("\n").contains("BOOK BTC-USD"));
    }

    #[test]
    fn retry_delay_is_shown_in_tenths_of_a_second() {
        assert_eq!(seconds(Duration::from_millis(250)), "0.3");
        assert_eq!(seconds(Duration::from_millis(1_000)), "1.0");
        assert_eq!(seconds(Duration::from_secs(10)), "10.0");
        assert_eq!(seconds(Duration::ZERO), "0.0");
    }
}

/// Layout of the order entry rows (Task 12.4): the command bar, the bottom strip, and the
/// dialogs, at the heights the thresholds pick.
#[cfg(test)]
mod order_layout_tests {
    use super::*;
    use protocol::client::{OrderPreview, PreviewAction};
    use protocol::{Bar, OrderKind, Price, Qty, Side};
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;

    fn app_with_candles() -> App {
        let mut app = App::new("ws://localhost:8080/ws");
        app.apply_candles(
            true,
            &[Bar {
                t: 0,
                open: Price(100),
                high: Price(120),
                low: Price(90),
                close: Price(110),
                volume: Qty(1),
            }],
        );
        app
    }

    fn screen(width: u16, height: u16, app: &App) -> (Vec<String>, HitMap) {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        let mut hits = HitMap::new();
        terminal.draw(|f| draw(f, app, &mut hits)).unwrap();
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

    fn open_preview(app: &mut App) {
        app.account.command_sent("r1");
        let preview = OrderPreview {
            preview_id: "p1".into(),
            text: "BUY BTC-USD 0.1 LMT 64000.00".into(),
            action: PreviewAction::Place {
                symbol: "BTC-USD".into(),
                side: Side::Buy,
                qty: Qty(10_000_000),
                kind: OrderKind::Limit {
                    price: Price(6_400_000),
                },
            },
            expires_at: 30_000,
        };
        assert!(app.account.on_preview("r1", &preview, 0));
    }

    // Req 28.1, 28.2, 28.3, 31.1
    #[test]
    fn tall_wide_screens_show_the_strip_above_the_command_bar() {
        let app = app_with_candles();
        let (rows, hits) = screen(120, 45, &app);
        // Main area 36 rows, strip rows 36..44, command bar row 44.
        assert!(rows[36].contains("POSITIONS"), "{}", rows[36]);
        assert!(rows[36].contains("OPEN ORDERS"), "{}", rows[36]);
        assert!(rows[36].contains("P&L"), "{}", rows[36]);
        assert!(rows[44].starts_with("> "), "{}", rows[44]);
        assert!(!rows[44].contains("P&L"), "the strip already shows the P&L: {}", rows[44]);
        assert_eq!(hits.resolve(10, 40), Some(&HitTarget::Panel(PanelId::Positions)));
        assert_eq!(hits.resolve(60, 40), Some(&HitTarget::Panel(PanelId::Orders)));
        assert_eq!(hits.resolve(10, 44), Some(&HitTarget::Panel(PanelId::CommandBar)));
        // The chart still sits above the strip, and the tape ends above it.
        assert_eq!(hits.resolve(0, 0), Some(&HitTarget::Panel(PanelId::Chart)));
        assert_eq!(hits.resolve(115, 35), Some(&HitTarget::Panel(PanelId::Tape)));
    }

    #[test]
    fn medium_wide_screens_reserve_the_bar_row_and_show_the_pnl_summary() {
        let app = app_with_candles();
        let (rows, hits) = screen(120, 35, &app);
        assert!(!rows.join("\n").contains("POSITIONS"));
        assert!(rows[34].starts_with("> "), "{}", rows[34]);
        assert!(rows[34].contains("P&L 0.00"), "{}", rows[34]);
        assert_eq!(hits.resolve(10, 34), Some(&HitTarget::Panel(PanelId::CommandBar)));
        assert_eq!(hits.resolve(115, 33), Some(&HitTarget::Panel(PanelId::Tape)));
    }

    // The thresholds keep the existing fixed-size layouts: 120x30 has no bar row and no strip.
    #[test]
    fn the_existing_wide_layout_at_30_rows_is_unchanged() {
        let app = app_with_candles();
        let (rows, hits) = screen(120, 30, &app);
        assert!(!rows.join("\n").contains("POSITIONS"));
        assert_eq!(hits.resolve(115, 29), Some(&HitTarget::Panel(PanelId::Tape)));
        assert!(rows[29].find("> ").is_none() || !rows[29].starts_with("> "), "{}", rows[29]);
    }

    #[test]
    fn narrow_screens_keep_a_command_bar_row_with_a_pnl_summary() {
        let app = app_with_candles();
        let (rows, hits) = screen(60, 20, &app);
        assert!(rows[19].starts_with("> "), "{}", rows[19]);
        assert!(rows[19].contains("P&L 0.00"), "{}", rows[19]);
        assert_eq!(hits.resolve(0, 19), Some(&HitTarget::Panel(PanelId::CommandBar)));
        // The watchlist strip and the chart panel start where they did.
        assert_eq!(hits.resolve(0, 1), Some(&HitTarget::Panel(PanelId::Chart)));
        // 14 rows (the size of the existing narrow tests) keep the chart to the bottom row.
        let (rows, hits) = screen(60, 14, &app);
        assert!(!rows[13].starts_with("> "), "{}", rows[13]);
        assert_eq!(hits.resolve(0, 13), Some(&HitTarget::Panel(PanelId::Chart)));
    }

    // Req 31.1: `:` shows the bar even on a short screen.
    #[test]
    fn a_focused_bar_is_drawn_over_the_bottom_row_of_a_short_screen() {
        let mut app = app_with_candles();
        app.focus = crate::order_input::Focus::Command;
        app.command.editor.set("BUY BTC 1");
        let (rows, hits) = screen(60, 14, &app);
        assert!(rows[13].starts_with("> BUY BTC 1"), "{}", rows[13]);
        assert_eq!(hits.resolve(5, 13), Some(&HitTarget::Panel(PanelId::CommandBar)));
    }

    // Req 31.4
    #[test]
    fn a_parse_error_shows_under_the_bar_with_a_caret() {
        let mut app = app_with_candles();
        app.focus = crate::order_input::Focus::Command;
        app.command.editor.set("BUY XYZ 1");
        app.account.command_sent("r1");
        assert!(app.account.on_parse_error("r1", "unknown symbol XYZ", 4));
        let (rows, _) = screen(60, 14, &app);
        assert!(rows[11].starts_with("> BUY XYZ 1"), "{}", rows[11]);
        assert_eq!(rows[12].find('^'), Some(6), "{}", rows[12]);
        assert!(rows[13].contains("unknown symbol XYZ"), "{}", rows[13]);
        // On a screen with a reserved bar row the layout grows by two rows instead.
        let (rows, _) = screen(60, 20, &app);
        assert!(rows[17].starts_with("> BUY XYZ 1"), "{}", rows[17]);
        assert_eq!(rows[18].find('^'), Some(6), "{}", rows[18]);
        assert!(rows[19].contains("unknown symbol XYZ"), "{}", rows[19]);
    }

    // Req 22.1
    #[test]
    fn the_preview_dialog_is_drawn_over_the_screen_with_clickable_buttons() {
        let mut app = app_with_candles();
        open_preview(&mut app);
        let (rows, hits) = screen(120, 30, &app);
        let text = rows.join("\n");
        assert!(text.contains("PLACE PAPER ORDER"), "{text}");
        assert!(text.contains("BUY BTC-USD 0.1 LMT 64000.00"), "{text}");
        let confirm_row = rows
            .iter()
            .position(|r| r.contains("Confirm [Enter/Y]"))
            .unwrap();
        // The row holds multi-byte chart characters, so count characters, not bytes.
        let byte = rows[confirm_row].find("Confirm [Enter/Y]").unwrap();
        let x = rows[confirm_row][..byte].chars().count();
        assert_eq!(
            hits.resolve(u16::try_from(x).unwrap(), u16::try_from(confirm_row).unwrap()),
            Some(&HitTarget::DialogConfirm)
        );
    }

    // Req 30.4
    #[test]
    fn the_confirm_dialog_is_drawn_for_flatten_all() {
        let mut app = app_with_candles();
        app.account
            .request_confirm(crate::order_model::ConfirmAction::FlattenAll);
        let (rows, _) = screen(60, 14, &app);
        assert!(rows.join("\n").contains("Flatten every position?"));
    }
}
