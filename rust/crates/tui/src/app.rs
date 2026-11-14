//! App state and its pure update function.
//!
//! Task 6.2 covers connection state only (Req 33.1). Market data, orders, and panels arrive in
//! later tasks. Sign-in is Task 21; here the `session` message is only displayed.

use std::collections::{HashMap, VecDeque};
use std::time::Duration;

use protocol::client::{DataMode, NoticeKind, ServerMessage};
use protocol::{AccountId, Bar, Event, IndicatorValues, Price, Qty, Side, Timeframe, Venue};

use crate::account_model::AccountState;
use crate::book_model::{BookCursor, BookState, MAX_TAPE, TapeEntry};
use crate::chart_model::{ChartView, Crosshair, MAX_BARS, QTY_DECIMALS};
use crate::indicator_model::{IndicatorPoint, IndicatorSeries, Toggles};
use crate::line_editor::LineEditor;
use crate::net::NetEvent;
use crate::order_input::{CommandLine, Focus};
use crate::order_model::{RequestIds, parse_qty};
use crate::pairing::PairingState;
use crate::watchlist_model::{WatchQuote, default_watchlist, watchlist_symbols};

/// The chart symbol at start.
pub const DEFAULT_SYMBOL: &str = "BTC-USD";

/// How many recent errors the app keeps.
pub const MAX_RECENT_ERRORS: usize = 16;

/// The state of the connection to the server, as the UI shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnState {
    /// The first attempt, or an immediate retry, is in progress.
    Connecting,
    /// Waiting `next_delay` before attempt `attempt` (Req 33.1, 33.2).
    Waking { attempt: u32, next_delay: Duration },
    /// The WebSocket is open.
    Connected,
    /// The connection just failed or dropped; a retry is about to be scheduled.
    Disconnected,
}

/// The parts of the server's `hello` that the UI shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HelloInfo {
    pub protocol_version: u32,
    pub data_mode: DataMode,
    pub venue: Option<Venue>,
    pub engine_running: bool,
}

/// The connection's account, from the server's `session` message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionInfo {
    pub account_id: AccountId,
    /// The wallet address, or `None` for the guest account.
    pub address: Option<String>,
}

impl SessionInfo {
    /// The status-line identity: `GUEST` or the shortened wallet address (Req 48.14).
    pub fn label(&self) -> String {
        match &self.address {
            Some(address) => crate::auth::short_address(address),
            None => "GUEST".to_owned(),
        }
    }
}

/// True when `event` means the saved Session_Token is no longer good and the Token_Store file
/// must be deleted: the `auth_failed`, `session_expired`, and `signed_out` notices (Req 48.12).
/// Pure; the caller (main) does the deletion so the reducer stays free of I/O.
pub fn forgets_token(event: &NetEvent) -> bool {
    matches!(
        event,
        NetEvent::Message(ServerMessage::Notice {
            kind: NoticeKind::AuthFailed | NoticeKind::SessionExpired | NoticeKind::SignedOut,
            ..
        })
    )
}

/// The order ticket the book prefills (Req 30.1). Order entry itself comes in Task 12.
// `side` and `qty` are filled by order entry (Task 12); the book only sets symbol and price.
#[allow(dead_code)]
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Ticket {
    pub symbol: String,
    pub side: Option<Side>,
    pub limit_price: Option<Price>,
    pub qty: Option<Qty>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct App {
    pub server: String,
    pub conn: ConnState,
    /// The `hello` of the current connection; cleared on each new connection.
    pub hello: Option<HelloInfo>,
    /// The `session` of the current connection; cleared on each new connection.
    pub session: Option<SessionInfo>,
    /// Engine events received over all connections.
    pub events_received: u64,
    pub last_error: Option<String>,
    /// The most recent errors, oldest first, at most [`MAX_RECENT_ERRORS`].
    pub recent_errors: VecDeque<String>,
    /// The symbol the chart shows (Req 33.3 default).
    pub symbol: String,
    /// The timeframe the chart shows.
    pub timeframe: Timeframe,
    /// Candles of the selected symbol and timeframe, oldest first, at most [`MAX_BARS`].
    pub candles: Vec<Bar>,
    /// The chart's zoom and pan window.
    pub chart_view: ChartView,
    /// The mouse crosshair, in cells relative to the chart area (Req 25.4).
    pub crosshair: Option<Crosshair>,
    /// The last book of each symbol (Req 27.1).
    pub books: HashMap<String, BookState>,
    /// Recent trades of all symbols, newest first, at most [`MAX_TAPE`] (Req 27.2). The tape
    /// panel shows the selected symbol only.
    pub tape: VecDeque<TapeEntry>,
    /// The selected book level; `None` while the book has no keyboard focus.
    pub book_cursor: Option<BookCursor>,
    /// The limit ticket prefilled from the book (Req 30.1).
    pub ticket: Ticket,
    /// Indicator values per (symbol, timeframe), from `Event::Indicators` (Req 26.1, 26.2).
    pub indicators: HashMap<(String, Timeframe), IndicatorSeries>,
    /// Which indicators are shown (Req 26.3).
    pub toggles: Toggles,
    /// The watchlist symbols, from the last `hello` (Req 27.3). Kept across reconnects.
    pub watchlist: Vec<String>,
    /// The last trade price of each symbol, and the previous different one for the direction
    /// color, from `Event::Trade` (Req 27.3).
    pub quotes: HashMap<String, WatchQuote>,
    /// The pairing dialog (Task 21.2). While it is open it takes over the keys.
    pub pairing: PairingState,
    /// Positions, open orders, previews, dialogs, and rejections of the account (Task 12.4).
    pub account: AccountState,
    /// Which part of the screen has the keyboard. Never `Book` or `Dialog`: those come from
    /// the book cursor and the open dialogs (see `order_input::effective_focus`).
    pub focus: Focus,
    /// The command bar: text, history, and the request it last sent (Req 31).
    pub command: CommandLine,
    /// The quantity text of the ticket line (Req 30.2). `ticket.qty` is its parsed value.
    pub ticket_qty: LineEditor,
    /// The wall clock in epoch ms at the last event, key, or tick. The reducers read it for
    /// preview deadlines and rejection times, so they stay free of clock reads.
    pub now_ms: i64,
    pub request_ids: RequestIds,
}

impl App {
    pub fn new(server: impl Into<String>) -> Self {
        Self {
            server: server.into(),
            conn: ConnState::Connecting,
            hello: None,
            session: None,
            events_received: 0,
            last_error: None,
            recent_errors: VecDeque::new(),
            symbol: DEFAULT_SYMBOL.to_owned(),
            timeframe: Timeframe::M1,
            candles: Vec::new(),
            chart_view: ChartView::default(),
            crosshair: None,
            books: HashMap::new(),
            tape: VecDeque::new(),
            book_cursor: None,
            ticket: Ticket::default(),
            indicators: HashMap::new(),
            toggles: Toggles::default(),
            watchlist: default_watchlist(),
            quotes: HashMap::new(),
            pairing: PairingState::Idle,
            account: AccountState::new(),
            focus: Focus::Chart,
            command: CommandLine::default(),
            ticket_qty: LineEditor::new(),
            now_ms: 0,
            request_ids: RequestIds::default(),
        }
    }

    /// Records the wall clock and closes an expired preview. Returns whether the screen changed
    /// (a countdown second passed, a preview expired, or the rejection line ended).
    pub fn tick(&mut self, now_ms: i64) -> bool {
        self.now_ms = now_ms;
        self.account.tick(now_ms)
    }

    /// The limit price of the ticket, for the selected symbol only (Req 30.1).
    pub fn ticket_limit_price(&self) -> Option<Price> {
        if self.ticket.symbol == self.symbol {
            self.ticket.limit_price
        } else {
            None
        }
    }

    /// Sets `ticket.qty` from the quantity text and puts the ticket on the selected symbol.
    pub fn sync_ticket_qty(&mut self) {
        if self.ticket.symbol.is_empty() {
            self.ticket.symbol = self.symbol.clone();
        }
        self.ticket.qty = parse_qty(self.ticket_qty.text(), QTY_DECIMALS);
    }

    /// The indicator series of the selected symbol and timeframe.
    pub fn indicator_series(&self) -> Option<&IndicatorSeries> {
        self.indicators.get(&(self.symbol.clone(), self.timeframe))
    }

    /// Merges an `Indicators` event into the series of its (symbol, timeframe). The point's
    /// bar start is `ts` aligned down to the timeframe, so it matches the candle `t`. Series
    /// of other symbols or timeframes than the selected ones are ignored.
    pub fn apply_indicators(
        &mut self,
        symbol: &str,
        timeframe: Timeframe,
        ts: i64,
        values: IndicatorValues,
    ) {
        if symbol != self.symbol || timeframe != self.timeframe {
            return;
        }
        let t = ts - ts.rem_euclid(timeframe.millis());
        self.indicators
            .entry((symbol.to_owned(), timeframe))
            .or_default()
            .merge(IndicatorPoint { t, values });
    }

    /// The book of the selected symbol.
    pub fn book(&self) -> Option<&BookState> {
        self.books.get(&self.symbol)
    }

    /// Stores a book, replacing the one of that symbol. The cursor stays on a valid level.
    pub fn apply_book(&mut self, symbol: String, book: BookState) {
        let selected = symbol == self.symbol;
        self.books.insert(symbol, book);
        if selected {
            self.book_cursor = match (self.book_cursor, self.books.get(&self.symbol)) {
                (Some(cursor), Some(book)) => cursor.clamp(book),
                _ => None,
            };
        }
    }

    /// Adds a trade to the tape, newest first, and drops the oldest beyond [`MAX_TAPE`]. The
    /// trade also becomes its symbol's watchlist price (Req 27.3).
    pub fn push_trade(&mut self, entry: TapeEntry) {
        match self.quotes.get_mut(&entry.symbol) {
            Some(quote) => quote.update(entry.price),
            None => {
                self.quotes
                    .insert(entry.symbol.clone(), WatchQuote::new(entry.price));
            }
        }
        self.tape.push_front(entry);
        self.tape.truncate(MAX_TAPE);
    }

    /// Prefills the limit ticket with `price` for `symbol` (Req 30.1).
    pub fn prefill_limit(&mut self, symbol: &str, price: Price) {
        if self.ticket.symbol != symbol {
            // A ticket that never had a symbol keeps a quantity typed before the first prefill;
            // a quantity counted in another symbol's lots does not carry over.
            let had_symbol = !self.ticket.symbol.is_empty();
            let qty = if had_symbol { None } else { self.ticket.qty };
            self.ticket = Ticket {
                symbol: symbol.to_owned(),
                qty,
                ..Ticket::default()
            };
            if had_symbol {
                self.ticket_qty.clear();
            }
        }
        self.ticket.limit_price = Some(price);
    }

    /// Switches every panel to another symbol (Req 27.4): the chart's candles and the
    /// indicator series of the old (symbol, timeframe) are cleared, the chart view goes back to
    /// the newest bar, the crosshair and book cursor are dropped, and the ticket moves to the
    /// new symbol without a limit price. The book and tape follow `symbol` when drawn. Returns
    /// the previous symbol when it changed, so the caller can swap the chart subscription.
    pub fn select_symbol(&mut self, symbol: &str) -> Option<String> {
        if symbol == self.symbol {
            return None;
        }
        let previous = std::mem::replace(&mut self.symbol, symbol.to_owned());
        self.candles.clear();
        self.indicators.remove(&(previous.clone(), self.timeframe));
        self.chart_view.offset_from_right = 0;
        self.crosshair = None;
        self.book_cursor = None;
        self.ticket.symbol = symbol.to_owned();
        self.ticket.limit_price = None;
        // A quantity counted in the old symbol's lots does not carry over (Req 30.2).
        self.ticket.qty = None;
        self.ticket_qty.clear();
        Some(previous)
    }

    /// Stores candles for the selected key. A snapshot replaces the series. A live bar with the
    /// same `t` as a stored bar replaces it; otherwise it is inserted in time order. The series
    /// keeps the newest [`MAX_BARS`] bars (Req 8.7, 8.8).
    pub fn apply_candles(&mut self, snapshot: bool, bars: &[Bar]) {
        if snapshot {
            self.candles.clear();
        }
        for bar in bars {
            match self.candles.binary_search_by_key(&bar.t, |b| b.t) {
                Ok(i) => self.candles[i] = *bar,
                Err(i) => self.candles.insert(i, *bar),
            }
        }
        if self.candles.len() > MAX_BARS {
            let excess = self.candles.len() - MAX_BARS;
            self.candles.drain(..excess);
        }
        self.chart_view.clamp_to(self.candles.len());
    }

    /// Switches the chart timeframe. Returns the previous timeframe when it changed, so the
    /// caller can unsubscribe from it and subscribe to the new one.
    pub fn select_timeframe(&mut self, timeframe: Timeframe) -> Option<Timeframe> {
        if timeframe == self.timeframe {
            return None;
        }
        let previous = self.timeframe;
        self.timeframe = timeframe;
        self.candles.clear();
        self.chart_view.offset_from_right = 0;
        Some(previous)
    }

    fn record_error(&mut self, error: String) {
        if self.recent_errors.len() == MAX_RECENT_ERRORS {
            self.recent_errors.pop_front();
        }
        self.recent_errors.push_back(error.clone());
        self.last_error = Some(error);
    }
}

/// Applies one network event. Returns whether the screen needs a redraw.
pub fn update(app: &mut App, event: NetEvent) -> bool {
    match event {
        NetEvent::Connecting {
            attempt,
            next_delay,
        } => {
            let conn = if next_delay.is_zero() {
                ConnState::Connecting
            } else {
                ConnState::Waking {
                    attempt,
                    next_delay,
                }
            };
            let changed = app.conn != conn;
            app.conn = conn;
            changed
        }
        NetEvent::Connected => {
            app.conn = ConnState::Connected;
            app.hello = None;
            app.session = None;
            true
        }
        NetEvent::Disconnected { reason } => {
            app.conn = ConnState::Disconnected;
            app.record_error(reason);
            true
        }
        NetEvent::BadFrame { error } => {
            app.record_error(format!("bad frame: {error}"));
            true
        }
        NetEvent::Message(message) => apply_message(app, message),
    }
}

fn apply_message(app: &mut App, message: ServerMessage) -> bool {
    match message {
        ServerMessage::Hello {
            protocol_version,
            data_mode,
            venue,
            engine_running,
            instruments,
        } => {
            app.watchlist = watchlist_symbols(&instruments);
            app.hello = Some(HelloInfo {
                protocol_version,
                data_mode,
                venue,
                engine_running,
            });
            true
        }
        ServerMessage::Session {
            account_id,
            address,
        } => {
            // Another account: nothing of the old one stays on screen (Req 46.4).
            app.account.on_session(&account_id);
            app.session = Some(SessionInfo {
                account_id,
                address,
            });
            true
        }
        ServerMessage::Event { event } => {
            app.events_received = app.events_received.saturating_add(1);
            match event {
                Event::Error { code, message } => {
                    app.record_error(format!("server error {code:?}: {message}"));
                }
                Event::Candle {
                    symbol,
                    timeframe,
                    snapshot,
                    bars,
                } => {
                    if symbol == app.symbol && timeframe == app.timeframe {
                        app.apply_candles(snapshot, &bars);
                    }
                }
                Event::Indicators {
                    symbol,
                    timeframe,
                    ts,
                    values,
                } => app.apply_indicators(&symbol, timeframe, ts, values),
                Event::Book {
                    symbol,
                    bids,
                    asks,
                    spread,
                    imbalance_bps,
                    ts,
                } => app.apply_book(
                    symbol,
                    BookState {
                        bids,
                        asks,
                        spread,
                        imbalance_bps,
                        ts,
                    },
                ),
                Event::Trade {
                    symbol,
                    price,
                    qty,
                    side,
                    ts,
                } => app.push_trade(TapeEntry {
                    symbol,
                    price,
                    qty,
                    side,
                    ts,
                }),
                account_event @ (Event::OrderAck { .. }
                | Event::OrderRejected { .. }
                | Event::Fill { .. }
                | Event::Position { .. }) => {
                    app.account.apply_event(&account_event, app.now_ms);
                }
                _ => {}
            }
            true
        }
        // The engine restarted: every paper account is flat again (Req 15.7).
        ServerMessage::Notice {
            kind: NoticeKind::AccountReset,
            ..
        } => {
            app.account.on_account_reset();
            true
        }
        // The server's preview of the last command (Req 22.1). A preview of the text typed in the
        // command bar clears the bar, and the dialog takes the keys from it (Req 31.4).
        ServerMessage::Preview {
            request_id,
            preview,
        } => {
            let applied = app.account.on_preview(&request_id, &preview, app.now_ms);
            if applied {
                if app.command.submitted.as_deref() == Some(request_id.as_str()) {
                    app.command.after_preview();
                }
                if app.focus == Focus::Command {
                    app.focus = Focus::Chart;
                }
            }
            applied
        }
        // The text is kept so the user can fix it (Req 21.5, 31.4).
        ServerMessage::ParseError {
            request_id,
            message,
            position,
        } => app.account.on_parse_error(&request_id, &message, position),
        ServerMessage::Notice { .. } | ServerMessage::Pong { .. } => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::client::InstrumentInfo;
    use protocol::{ErrorCode, Price, Qty, Side};

    fn hello(data_mode: DataMode, venue: Option<Venue>) -> NetEvent {
        NetEvent::Message(ServerMessage::Hello {
            protocol_version: 2,
            data_mode,
            venue,
            engine_running: true,
            instruments: InstrumentInfo::all(),
        })
    }

    fn guest_session() -> NetEvent {
        NetEvent::Message(ServerMessage::Session {
            account_id: AccountId::new("guest").unwrap(),
            address: None,
        })
    }

    fn trade() -> NetEvent {
        NetEvent::Message(ServerMessage::Event {
            event: Event::Trade {
                symbol: "BTC-USD".into(),
                price: Price(6_400_000),
                qty: Qty(1),
                side: Side::Buy,
                ts: 1,
            },
        })
    }

    #[test]
    fn starts_connecting() {
        let app = App::new("ws://localhost:8080/ws");
        assert_eq!(app.conn, ConnState::Connecting);
        assert_eq!(app.hello, None);
        assert_eq!(app.events_received, 0);
    }

    // Req 33.1
    #[test]
    fn connecting_with_a_delay_is_waking() {
        let mut app = App::new("ws://x/ws");
        let first = NetEvent::Connecting {
            attempt: 1,
            next_delay: Duration::ZERO,
        };
        assert!(!update(&mut app, first));
        assert_eq!(app.conn, ConnState::Connecting);

        assert!(update(
            &mut app,
            NetEvent::Disconnected {
                reason: "connection refused".into()
            }
        ));
        assert_eq!(app.conn, ConnState::Disconnected);
        assert_eq!(app.last_error.as_deref(), Some("connection refused"));

        let waking = NetEvent::Connecting {
            attempt: 2,
            next_delay: Duration::from_millis(250),
        };
        assert!(update(&mut app, waking.clone()));
        assert_eq!(
            app.conn,
            ConnState::Waking {
                attempt: 2,
                next_delay: Duration::from_millis(250)
            }
        );
        assert!(!update(&mut app, waking));
    }

    fn notice(kind: NoticeKind) -> NetEvent {
        NetEvent::Message(ServerMessage::Notice {
            kind,
            message: "m".into(),
        })
    }

    // Req 48.12
    #[test]
    fn only_the_three_auth_notices_forget_the_token() {
        for kind in [
            NoticeKind::AuthFailed,
            NoticeKind::SessionExpired,
            NoticeKind::SignedOut,
        ] {
            assert!(forgets_token(&notice(kind)), "{kind:?}");
        }
        for kind in [
            NoticeKind::AccountReset,
            NoticeKind::EngineDown,
            NoticeKind::EngineUp,
            NoticeKind::LlmDisabled,
        ] {
            assert!(!forgets_token(&notice(kind)), "{kind:?}");
        }
        assert!(!forgets_token(&NetEvent::Connected));
        assert!(!forgets_token(&guest_session()));
    }

    // Req 48.14
    #[test]
    fn the_session_label_is_guest_or_the_short_address() {
        let mut app = App::new("ws://x/ws");
        update(&mut app, guest_session());
        assert_eq!(app.session.as_ref().map(SessionInfo::label).as_deref(), Some("GUEST"));
        let address = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
        update(
            &mut app,
            NetEvent::Message(ServerMessage::Session {
                account_id: AccountId::new(format!("w_{address}")).unwrap(),
                address: Some(address.to_owned()),
            }),
        );
        assert_eq!(
            app.session.as_ref().map(SessionInfo::label).as_deref(),
            Some("9WzD…AWWM")
        );
    }

    #[test]
    fn connected_then_hello_session_and_events() {
        let mut app = App::new("ws://x/ws");
        assert!(update(&mut app, NetEvent::Connected));
        assert_eq!(app.conn, ConnState::Connected);

        assert!(update(
            &mut app,
            hello(DataMode::Live, Some(Venue::Backpack))
        ));
        let info = app.hello.clone().unwrap();
        assert_eq!(info.protocol_version, 2);
        assert_eq!(info.data_mode, DataMode::Live);
        assert_eq!(info.venue, Some(Venue::Backpack));

        assert!(update(&mut app, guest_session()));
        assert_eq!(
            app.session.as_ref().map(|s| s.account_id.as_str()),
            Some("guest")
        );

        assert!(update(&mut app, trade()));
        assert!(update(&mut app, trade()));
        assert_eq!(app.events_received, 2);

        assert!(!update(
            &mut app,
            NetEvent::Message(ServerMessage::Pong { id: 1 })
        ));
    }

    #[test]
    fn a_new_connection_clears_hello_and_session_but_keeps_the_count() {
        let mut app = App::new("ws://x/ws");
        update(&mut app, NetEvent::Connected);
        update(&mut app, hello(DataMode::Replay, None));
        update(&mut app, guest_session());
        update(&mut app, trade());
        update(
            &mut app,
            NetEvent::Disconnected {
                reason: "reset".into(),
            },
        );
        update(&mut app, NetEvent::Connected);
        assert_eq!(app.hello, None);
        assert_eq!(app.session, None);
        assert_eq!(app.events_received, 1);
    }

    #[test]
    fn errors_go_to_a_bounded_ring() {
        let mut app = App::new("ws://x/ws");
        for i in 0..(MAX_RECENT_ERRORS + 4) {
            assert!(update(
                &mut app,
                NetEvent::BadFrame {
                    error: format!("e{i}")
                }
            ));
        }
        assert_eq!(app.recent_errors.len(), MAX_RECENT_ERRORS);
        assert_eq!(
            app.recent_errors.front().map(String::as_str),
            Some("bad frame: e4")
        );
        let last = format!("bad frame: e{}", MAX_RECENT_ERRORS + 3);
        assert_eq!(app.last_error, Some(last));

        let server_error = NetEvent::Message(ServerMessage::Event {
            event: Event::Error {
                code: ErrorCode::InvalidJson,
                message: "bad".into(),
            },
        });
        assert!(update(&mut app, server_error));
        assert_eq!(app.events_received, 1);
        assert!(app.last_error.as_deref().unwrap().contains("bad"));
    }

    fn bar(t: i64, close: i64) -> Bar {
        Bar {
            t,
            open: Price(close),
            high: Price(close),
            low: Price(close),
            close: Price(close),
            volume: Qty(1),
        }
    }

    fn candles(timeframe: Timeframe, snapshot: bool, bars: Vec<Bar>) -> NetEvent {
        NetEvent::Message(ServerMessage::Event {
            event: Event::Candle {
                symbol: "BTC-USD".into(),
                timeframe,
                snapshot,
                bars,
            },
        })
    }

    #[test]
    fn candles_snapshot_replaces_and_live_bars_replace_or_insert() {
        let mut app = App::new("ws://x/ws");
        update(
            &mut app,
            candles(Timeframe::M1, true, vec![bar(60, 1), bar(120, 2)]),
        );
        assert_eq!(app.candles.len(), 2);
        // Same t replaces.
        update(&mut app, candles(Timeframe::M1, false, vec![bar(120, 9)]));
        assert_eq!(app.candles.len(), 2);
        assert_eq!(app.candles[1].close, Price(9));
        // A newer t is appended; an older t is inserted in order.
        update(&mut app, candles(Timeframe::M1, false, vec![bar(180, 3)]));
        update(&mut app, candles(Timeframe::M1, false, vec![bar(0, 0)]));
        let times: Vec<i64> = app.candles.iter().map(|b| b.t).collect();
        assert_eq!(times, [0, 60, 120, 180]);
        // A snapshot replaces everything.
        update(&mut app, candles(Timeframe::M1, true, vec![bar(5, 5)]));
        assert_eq!(app.candles.len(), 1);
        // Other timeframes and symbols are ignored.
        update(&mut app, candles(Timeframe::H1, true, vec![bar(1, 1), bar(2, 2)]));
        assert_eq!(app.candles.len(), 1);
    }

    #[test]
    fn candles_are_capped_at_500_keeping_the_newest() {
        let mut app = App::new("ws://x/ws");
        let bars: Vec<Bar> = (0..510).map(|t| bar(t, 1)).collect();
        app.apply_candles(true, &bars);
        assert_eq!(app.candles.len(), MAX_BARS);
        assert_eq!(app.candles[0].t, 10);
    }

    #[test]
    fn selecting_a_timeframe_clears_candles_and_reports_the_previous_one() {
        let mut app = App::new("ws://x/ws");
        app.apply_candles(true, &[bar(1, 1)]);
        assert_eq!(app.select_timeframe(Timeframe::M1), None);
        assert_eq!(app.candles.len(), 1);
        assert_eq!(app.select_timeframe(Timeframe::H1), Some(Timeframe::M1));
        assert_eq!(app.timeframe, Timeframe::H1);
        assert!(app.candles.is_empty());
    }

    fn book_event(symbol: &str, asks: &[i64], bids: &[i64]) -> NetEvent {
        use protocol::Level;
        let level = |p: &i64| Level {
            price: Price(*p),
            qty: Qty(1),
        };
        NetEvent::Message(ServerMessage::Event {
            event: Event::Book {
                symbol: symbol.into(),
                bids: bids.iter().map(level).collect(),
                asks: asks.iter().map(level).collect(),
                spread: Some(Price(50)),
                imbalance_bps: 10,
                ts: 7,
            },
        })
    }

    fn trade_at(symbol: &str, price: i64) -> NetEvent {
        NetEvent::Message(ServerMessage::Event {
            event: Event::Trade {
                symbol: symbol.into(),
                price: Price(price),
                qty: Qty(1),
                side: Side::Sell,
                ts: price,
            },
        })
    }

    // Req 27.1
    #[test]
    fn a_book_event_replaces_the_book_of_its_symbol() {
        let mut app = App::new("ws://x/ws");
        assert!(app.book().is_none());
        assert!(update(&mut app, book_event("BTC-USD", &[101, 102], &[100])));
        assert_eq!(app.book().map(|b| b.asks.len()), Some(2));
        assert_eq!(app.book().map(|b| b.ts), Some(7));
        update(&mut app, book_event("BTC-USD", &[103], &[]));
        let book = app.book().unwrap();
        assert_eq!((book.asks.len(), book.bids.len()), (1, 0));
        assert_eq!(book.spread, Some(Price(50)));
        // Another symbol keeps its own book and leaves the selected one alone.
        update(&mut app, book_event("ETH-USD", &[5], &[4, 3]));
        assert_eq!(app.books.len(), 2);
        assert_eq!(app.book().map(|b| b.asks.len()), Some(1));
    }

    #[test]
    fn the_cursor_is_clamped_when_the_book_shrinks() {
        let mut app = App::new("ws://x/ws");
        update(&mut app, book_event("BTC-USD", &[101, 102, 103], &[100]));
        app.book_cursor = Some(BookCursor {
            side: crate::hitmap::BookSide::Ask,
            index: 2,
        });
        update(&mut app, book_event("BTC-USD", &[101], &[100]));
        assert_eq!(app.book_cursor.map(|c| c.index), Some(0));
        // An emptied book drops the cursor.
        update(&mut app, book_event("BTC-USD", &[], &[]));
        assert_eq!(app.book_cursor, None);
    }

    // Req 27.2
    #[test]
    fn the_tape_is_newest_first_and_capped() {
        let mut app = App::new("ws://x/ws");
        for i in 0..(MAX_TAPE + 5) {
            let price = i64::try_from(i).unwrap();
            assert!(update(&mut app, trade_at("BTC-USD", price)));
        }
        assert_eq!(app.tape.len(), MAX_TAPE);
        let newest = i64::try_from(MAX_TAPE + 4).unwrap();
        assert_eq!(app.tape.front().map(|t| t.price), Some(Price(newest)));
        assert_eq!(app.tape.back().map(|t| t.price), Some(Price(5)));
        assert_eq!(app.tape.front().map(|t| t.side), Some(Side::Sell));
    }

    // Req 30.1
    #[test]
    fn prefill_sets_the_limit_price_and_symbol() {
        let mut app = App::new("ws://x/ws");
        app.prefill_limit("BTC-USD", Price(6_400_100));
        assert_eq!(app.ticket.symbol, "BTC-USD");
        assert_eq!(app.ticket.limit_price, Some(Price(6_400_100)));
        app.ticket.qty = Some(Qty(5));
        app.prefill_limit("BTC-USD", Price(6_400_000));
        assert_eq!(app.ticket.limit_price, Some(Price(6_400_000)));
        assert_eq!(app.ticket.qty, Some(Qty(5)));
        // Another symbol starts a fresh ticket.
        app.prefill_limit("ETH-USD", Price(1));
        assert_eq!(app.ticket.qty, None);
    }

    fn indicators_event(symbol: &str, timeframe: Timeframe, ts: i64, ema: f64) -> NetEvent {
        NetEvent::Message(ServerMessage::Event {
            event: Event::Indicators {
                symbol: symbol.into(),
                timeframe,
                ts,
                values: IndicatorValues {
                    ema: Some(ema),
                    ..IndicatorValues::default()
                },
            },
        })
    }

    // Req 26.1, 26.2
    #[test]
    fn indicator_events_merge_by_bar_start_and_ignore_other_keys() {
        let mut app = App::new("ws://x/ws");
        assert!(app.indicator_series().is_none());
        assert!(update(&mut app, indicators_event("BTC-USD", Timeframe::M1, 60_000, 1.0)));
        // A later event time inside the same bar replaces the point.
        update(&mut app, indicators_event("BTC-USD", Timeframe::M1, 90_000, 2.0));
        update(&mut app, indicators_event("BTC-USD", Timeframe::M1, 0, 0.5));
        let points = app.indicator_series().unwrap().points();
        let got: Vec<(i64, Option<f64>)> = points.iter().map(|p| (p.t, p.values.ema)).collect();
        assert_eq!(got, [(0, Some(0.5)), (60_000, Some(2.0))]);
        // Other symbols and timeframes are ignored.
        update(&mut app, indicators_event("ETH-USD", Timeframe::M1, 0, 9.0));
        update(&mut app, indicators_event("BTC-USD", Timeframe::H1, 0, 9.0));
        assert_eq!(app.indicators.len(), 1);
        assert_eq!(app.indicator_series().unwrap().points().len(), 2);
    }

    #[test]
    fn indicator_points_are_capped_at_500() {
        let mut app = App::new("ws://x/ws");
        for i in 0..510 {
            app.apply_indicators("BTC-USD", Timeframe::M1, i * 60_000, IndicatorValues::default());
        }
        let points = app.indicator_series().unwrap().points();
        assert_eq!(points.len(), 500);
        assert_eq!(points[0].t, 10 * 60_000);
    }

    #[test]
    fn changing_the_symbol_resets_the_cursor() {
        let mut app = App::new("ws://x/ws");
        app.book_cursor = Some(BookCursor {
            side: crate::hitmap::BookSide::Bid,
            index: 1,
        });
        assert_eq!(app.select_symbol("BTC-USD"), None);
        assert!(app.book_cursor.is_some());
        assert_eq!(app.select_symbol("ETH-USD").as_deref(), Some("BTC-USD"));
        assert_eq!(app.symbol, "ETH-USD");
        assert_eq!(app.book_cursor, None);
    }

    // Req 27.4
    #[test]
    fn selecting_a_symbol_switches_every_panel() {
        use crate::chart_model::Crosshair;
        let mut app = App::new("ws://x/ws");
        app.apply_candles(true, &[bar(0, 1), bar(60_000, 2)]);
        app.apply_indicators("BTC-USD", Timeframe::M1, 0, IndicatorValues::default());
        app.chart_view.offset_from_right = 1;
        app.crosshair = Some(Crosshair { col: 1, row: 1 });
        app.prefill_limit("BTC-USD", Price(6_400_000));
        update(&mut app, book_event("ETH-USD", &[5], &[4]));
        update(&mut app, trade_at("ETH-USD", 320_000));

        assert_eq!(app.select_symbol("ETH-USD").as_deref(), Some("BTC-USD"));
        assert!(app.candles.is_empty());
        let old_key = ("BTC-USD".to_owned(), Timeframe::M1);
        assert!(!app.indicators.contains_key(&old_key));
        assert_eq!(app.chart_view.offset_from_right, 0);
        assert_eq!(app.crosshair, None);
        assert_eq!(app.ticket.symbol, "ETH-USD");
        assert_eq!(app.ticket.limit_price, None);
        // The book and tape of the new symbol are the ones shown.
        assert_eq!(app.book().map(|b| b.asks.len()), Some(1));
        assert!(app.tape.iter().any(|t| t.symbol == app.symbol));
        // Candles of the old symbol are ignored from now on; the new symbol's are kept.
        update(&mut app, candles(Timeframe::M1, true, vec![bar(0, 9)]));
        assert!(app.candles.is_empty());
    }

    // Req 27.3
    #[test]
    fn trades_of_every_symbol_update_the_watchlist_prices() {
        use crate::watchlist_model::Direction;
        let mut app = App::new("ws://x/ws");
        assert!(app.quotes.is_empty());
        update(&mut app, trade_at("BTC-USD", 6_400_000));
        update(&mut app, trade_at("ETH-USD", 320_000));
        update(&mut app, trade_at("BTC-USD", 6_400_100));
        update(&mut app, trade_at("ETH-USD", 319_900));
        let btc = app.quotes["BTC-USD"];
        assert_eq!(btc.last, Price(6_400_100));
        assert_eq!(btc.prev, Some(Price(6_400_000)));
        assert_eq!(btc.direction(), Direction::Up);
        assert_eq!(app.quotes["ETH-USD"].direction(), Direction::Down);
        assert!(!app.quotes.contains_key("SOL-USD"));
        // The selected symbol is still BTC-USD; other symbols' trades only feed the watchlist
        // and the (filtered) tape.
        assert_eq!(app.symbol, "BTC-USD");
    }

    #[test]
    fn hello_sets_the_watchlist_and_reconnects_keep_it() {
        let mut app = App::new("ws://x/ws");
        assert_eq!(app.watchlist, ["BTC-USD", "ETH-USD", "SOL-USD"]);
        update(&mut app, NetEvent::Connected);
        let only_sol = vec![InstrumentInfo {
            symbol: "SOL-USD".into(),
            short: "SOL".into(),
            price_decimals: 2,
            qty_decimals: 8,
        }];
        update(
            &mut app,
            NetEvent::Message(ServerMessage::Hello {
                protocol_version: 2,
                data_mode: DataMode::Replay,
                venue: None,
                engine_running: true,
                instruments: only_sol,
            }),
        );
        assert_eq!(app.watchlist, ["SOL-USD"]);
        update(&mut app, NetEvent::Connected);
        assert_eq!(app.watchlist, ["SOL-USD"]);
        // An empty instrument table falls back to the defaults.
        update(
            &mut app,
            NetEvent::Message(ServerMessage::Hello {
                protocol_version: 2,
                data_mode: DataMode::Replay,
                venue: None,
                engine_running: true,
                instruments: Vec::new(),
            }),
        );
        assert_eq!(app.watchlist, ["BTC-USD", "ETH-USD", "SOL-USD"]);
    }
}

#[cfg(test)]
mod order_reducer_tests {
    use super::*;
    use protocol::client::{OrderPreview, PreviewAction};
    use protocol::{Money, OrderId, OrderKind, OrderStatus};

    fn guest() -> AccountId {
        AccountId::new("guest").unwrap()
    }

    fn event(event: Event) -> NetEvent {
        NetEvent::Message(ServerMessage::Event { event })
    }

    fn session(account: &str, address: Option<&str>) -> NetEvent {
        NetEvent::Message(ServerMessage::Session {
            account_id: AccountId::new(account).unwrap(),
            address: address.map(str::to_owned),
        })
    }

    fn position(qty: i64) -> NetEvent {
        event(Event::Position {
            account_id: guest(),
            symbol: "BTC-USD".into(),
            qty: Qty(qty),
            avg_entry: Some(Price(6_400_000)),
            realized: Money(10_000_000_000),
            unrealized: Money(-5_000_000_000),
        })
    }

    fn ack(id: &str, status: OrderStatus) -> NetEvent {
        event(Event::OrderAck {
            account_id: guest(),
            order_id: OrderId::new(id).unwrap(),
            status,
        })
    }

    fn preview(request_id: &str) -> NetEvent {
        NetEvent::Message(ServerMessage::Preview {
            request_id: request_id.into(),
            preview: OrderPreview {
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
            },
        })
    }

    // Req 28.1
    #[test]
    fn position_events_fill_the_positions_table() {
        let mut app = App::new("ws://x/ws");
        assert!(update(&mut app, session("guest", None)));
        assert!(update(&mut app, position(10_000_000)));
        let row = &app.account.positions["BTC-USD"];
        assert_eq!(row.qty, Qty(10_000_000));
        assert_eq!(row.avg_entry, Some(Price(6_400_000)));
        assert_eq!(app.account.realized_total(), 10_000_000_000);
        assert_eq!(app.account.unrealized_total(), -5_000_000_000);
        // A flat position leaves the table and keeps the realized P&L.
        update(&mut app, position(0));
        assert!(app.account.positions.is_empty());
        assert_eq!(app.account.realized_total(), 10_000_000_000);
    }

    // Req 28.2
    #[test]
    fn order_acks_open_and_close_rows_through_the_net_path() {
        let mut app = App::new("ws://x/ws");
        update(&mut app, session("guest", None));
        // The confirmed placement labels the row of the next accepted ack.
        app.account.command_sent("r1");
        update(&mut app, preview("r1"));
        assert_eq!(app.account.take_preview_for_confirm().as_deref(), Some("p1"));
        update(&mut app, ack("o-1", OrderStatus::Accepted));
        assert_eq!(app.account.orders.len(), 1);
        assert_eq!(app.account.orders[0].symbol.as_deref(), Some("BTC-USD"));
        update(&mut app, event(Event::Fill {
            account_id: guest(),
            order_id: OrderId::new("o-1").unwrap(),
            symbol: "BTC-USD".into(),
            side: Side::Buy,
            price: Price(6_400_000),
            qty: Qty(4_000_000),
            fee: Money(0),
            remaining: Qty(6_000_000),
            ts: 1,
        }));
        assert_eq!(app.account.orders[0].filled, 4_000_000);
        assert_eq!(app.account.orders[0].remaining, 6_000_000);
        update(&mut app, ack("o-1", OrderStatus::Canceled));
        assert!(app.account.orders.is_empty());
    }

    // Req 30.6
    #[test]
    fn an_order_rejection_becomes_the_rejection_line() {
        let mut app = App::new("ws://x/ws");
        update(&mut app, session("guest", None));
        app.now_ms = 5_000;
        assert!(update(&mut app, event(Event::OrderRejected {
            account_id: guest(),
            order_id: OrderId::new("o-7").unwrap(),
            reason: "kill_switch".into(),
        })));
        let latest = app.account.latest_rejection(5_000).unwrap();
        assert_eq!(latest.reason, "kill_switch");
        assert!(app.account.latest_rejection(15_000).is_none());
    }

    // Req 22.1
    #[test]
    fn a_preview_answers_the_last_request_only() {
        let mut app = App::new("ws://x/ws");
        assert!(!update(&mut app, preview("r1")));
        app.account.command_sent("r1");
        assert!(update(&mut app, preview("r1")));
        assert_eq!(app.account.preview.as_ref().map(|p| p.deadline_ms), Some(30_000));
        assert!(app.account.dialog_open());
    }

    // Req 21.5, 31.4
    #[test]
    fn a_parse_error_is_stored_with_its_position() {
        let mut app = App::new("ws://x/ws");
        app.account.command_sent("r1");
        let error = NetEvent::Message(ServerMessage::ParseError {
            request_id: "r1".into(),
            message: "unknown symbol".into(),
            position: 4,
        });
        assert!(update(&mut app, error));
        assert_eq!(app.account.parse_error.as_ref().map(|e| e.position), Some(4));
    }

    // Req 46.4
    #[test]
    fn a_session_for_another_account_clears_the_account_state() {
        let mut app = App::new("ws://x/ws");
        update(&mut app, session("guest", None));
        update(&mut app, position(5));
        update(&mut app, ack("o-1", OrderStatus::Accepted));
        app.account.command_sent("r1");
        update(&mut app, preview("r1"));
        // The same account on a reconnect keeps the data.
        update(&mut app, NetEvent::Connected);
        update(&mut app, session("guest", None));
        assert_eq!(app.account.positions.len(), 1);
        assert_eq!(app.account.orders.len(), 1);
        assert!(app.account.preview.is_some());
        // Another account clears positions, orders, and the preview.
        update(&mut app, session("w_abc", Some("abc")));
        assert!(app.account.positions.is_empty());
        assert!(app.account.orders.is_empty());
        assert!(app.account.preview.is_none());
        // Events of the old account are ignored from now on.
        assert!(update(&mut app, position(5)));
        assert!(app.account.positions.is_empty());
    }

    // Req 15.7
    #[test]
    fn an_account_reset_notice_clears_the_account_state() {
        let mut app = App::new("ws://x/ws");
        update(&mut app, session("guest", None));
        update(&mut app, position(5));
        update(&mut app, ack("o-1", OrderStatus::Accepted));
        let notice = NetEvent::Message(ServerMessage::Notice {
            kind: NoticeKind::AccountReset,
            message: "reset".into(),
        });
        assert!(update(&mut app, notice));
        assert!(app.account.positions.is_empty() && app.account.orders.is_empty());
        // Other notices change nothing on screen.
        let engine_down = NetEvent::Message(ServerMessage::Notice {
            kind: NoticeKind::EngineDown,
            message: "down".into(),
        });
        assert!(!update(&mut app, engine_down));
    }

    #[test]
    fn the_ticket_quantity_follows_the_symbol() {
        let mut app = App::new("ws://x/ws");
        app.ticket_qty.set("0.5");
        app.sync_ticket_qty();
        assert_eq!(app.ticket.qty, Some(Qty(50_000_000)));
        assert_eq!(app.ticket.symbol, "BTC-USD");
        assert_eq!(app.ticket_limit_price(), None);
        app.prefill_limit("BTC-USD", Price(6_400_000));
        assert_eq!(app.ticket_limit_price(), Some(Price(6_400_000)));
        // Another symbol starts a fresh ticket without a price or a quantity.
        app.select_symbol("ETH-USD");
        assert_eq!(app.ticket.qty, None);
        assert!(app.ticket_qty.is_empty());
        assert_eq!(app.ticket_limit_price(), None);
    }

    #[test]
    fn tick_records_the_clock_and_expires_the_preview() {
        let mut app = App::new("ws://x/ws");
        app.account.command_sent("r1");
        update(&mut app, preview("r1"));
        assert!(app.tick(0));
        assert_eq!(app.now_ms, 0);
        assert!(app.tick(31_000));
        assert!(app.account.preview.is_none());
        assert_eq!(app.now_ms, 31_000);
    }
}
