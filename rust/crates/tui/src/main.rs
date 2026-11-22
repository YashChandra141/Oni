//! Oni TUI (Ratatui + crossterm).
//!
//! Task 6.1: CLI, terminal guard, panic hook. Task 6.2: WebSocket connection with reconnect
//! and the "waking server" status (Req 33.1–33.3).
//!
//! Event loop: a tokio current-thread runtime selects over terminal input, network events,
//! and a 34 ms tick. A frame is drawn on a tick only when state changed, so there are at most
//! 30 redraws per second (Req 34.3).
//!
//! Input: a dedicated std thread calls the blocking `crossterm::event::read` in a loop and
//! forwards each result into a tokio channel. A std thread rather than `spawn_blocking`,
//! because dropping the runtime waits for blocking tasks and the thread may still be parked
//! in `read` when the user quits; a std thread is simply left behind and ends with the process.

mod account_model;
mod app;
mod auth;
mod book_model;
mod book_widget;
mod braille;
mod brand;
mod chart_model;
mod chart_widget;
mod cli;
mod copilot;
mod frame_limiter;
mod hitmap;
mod http;
mod indicator_model;
mod indicator_widget;
mod keymap;
mod latency;
mod line_editor;
mod mouse;
mod net;
mod order_input;
mod order_model;
mod order_widget;
mod pairing;
mod pairing_dialog;
mod tape_widget;
mod terminal;
mod ui;
mod watchlist_model;
mod watchlist_widget;

use std::io::{self, IsTerminal};
use std::process::ExitCode;
use std::thread;

use clap::Parser;
use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use protocol::Timeframe;
use protocol::client::ClientMessage;
use ratatui::Terminal;
use ratatui::backend::CrosstermBackend;
use tokio::sync::mpsc;
use tokio::time::{self, MissedTickBehavior};

use crate::app::{App, PickerKind};
use crate::auth::TokenStore;
use crate::book_model::BookCursor;
use crate::cli::Cli;
// The same interval drives the redraw tick and the limiter, so every tick may draw.
use crate::frame_limiter::{FRAME_INTERVAL, FrameLimiter};
use crate::hitmap::HitMap;
use crate::indicator_model::Indicator;
use crate::keymap::{Action, Context, Keymap, chord_from_crossterm, resolve};
use crate::mouse::{DragState, MouseAction, mouse_action};
use crate::net::Subscription;
use crate::order_input::Focus;
use crate::pairing::{PairingEvent, PairingHandle, PairingKind, PairingMsg, PairingState};
use crate::terminal::TerminalGuard;
use crate::watchlist_model::{
    DEFAULT_WATCHLIST, WATCH_TIMEFRAME, is_watch_key, next_symbol, prev_symbol,
};

/// Capacity of the terminal input channel.
const INPUT_CHANNEL_CAPACITY: usize = 64;
/// Capacity of the pairing driver's channel.
const PAIRING_CHANNEL_CAPACITY: usize = 16;

fn main() -> ExitCode {
    let cli = Cli::parse();

    // Req 48.13: sign out and exit before the full-screen UI starts.
    if cli.logout {
        return logout(&cli.server);
    }

    // Req 32.2, 32.4: the keymap is embedded and validated before the terminal changes mode.
    let keymap = match Keymap::embedded() {
        Ok(keymap) => keymap,
        Err(errors) => {
            eprintln!("tui: the embedded keymap (shared/keymap.json) is invalid:");
            for error in &errors {
                eprintln!("tui:   {error}");
            }
            return ExitCode::FAILURE;
        }
    };

    // Never touch raw mode when there is no terminal (CI, pipes, tests).
    if !io::stdout().is_terminal() {
        eprintln!("tui: stdout is not a terminal; run tui in an interactive terminal");
        return ExitCode::FAILURE;
    }

    match run(&cli.server, &keymap, cli.guest) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("tui: {err}");
            ExitCode::FAILURE
        }
    }
}

/// `--logout`: revokes and deletes the saved token, prints one line, and exits 0 (Req 48.13).
/// The line never contains the token.
fn logout(server: &str) -> ExitCode {
    let Some(store) = TokenStore::default_location() else {
        println!("tui: no config directory found; there is no saved sign-in.");
        return ExitCode::SUCCESS;
    };
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(err) => {
            eprintln!("tui: {err}");
            return ExitCode::FAILURE;
        }
    };
    println!("{}", runtime.block_on(cli::run_logout(&store, server)));
    ExitCode::SUCCESS
}

fn run(server: &str, keymap: &Keymap, guest: bool) -> io::Result<()> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    runtime.block_on(run_async(server, keymap, guest))
}

async fn run_async(server: &str, keymap: &Keymap, guest: bool) -> io::Result<()> {
    let guard = TerminalGuard::enter()?;
    let mut terminal = Terminal::new(CrosstermBackend::new(io::stdout()))?;
    let mut input = spawn_input_thread()?;

    // Req 33.3: the watchlist subscriptions, which include the default chart key (BTC-USD 1m).
    // The net task's subscription set sends them, and every chart key added later, again after
    // every reconnect.
    let initial = watchlist_subscriptions();
    // Keep the sender alive for the whole loop; dropping it stops the connection task.
    // Req 33.4, 48.12: after each hello the net task asks for the saved token. It is read from
    // the Token_Store each time, so a token deleted after a failed sign-in is not sent again.
    // `--guest` never reads the file.
    let store = TokenStore::default_location();
    let token_source: net::TokenSource = {
        let store = store.clone();
        let server = server.to_owned();
        Box::new(move || auth::session_token(guest, store.as_ref(), &server, auth::now_secs()))
    };
    let (net_tx, mut net) = net::spawn_connection(server.to_owned(), initial, token_source);

    let mut app = App::new(server);
    let mut tick = time::interval(FRAME_INTERVAL);
    tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    // Starts dirty, so the first frame is drawn on the first tick (Req 34.3).
    let mut limiter = FrameLimiter::new(FRAME_INTERVAL);
    let mut net_open = true;
    // The hit map of the last drawn frame, rebuilt on every draw (Req 35.1).
    let mut hits = HitMap::new();
    let mut drag = DragState::default();
    // Task 21.2: the pairing driver reports through this channel. `pairing_id` tells the
    // current attempt's messages from those of a cancelled one.
    let (pair_tx, mut pair_rx) = mpsc::channel::<PairingMsg>(PAIRING_CHANNEL_CAPACITY);
    let mut pairing_task: Option<PairingHandle> = None;
    let mut pairing_id: u64 = 0;

    loop {
        tokio::select! {
            key = input.recv() => match key {
                // While the pairing dialog is open only Ctrl-C quits; `q` is ignored.
                // `q` quits, except while a dialog or the command bar has the keys (Req 31.1).
                Some(Ok(Event::Key(key)))
                    if is_hard_exit(&key)
                        || (!app.pairing.is_open()
                            && !order_input::blocks_global_keys(&app)
                            && !copilot::captures_text(&app)
                            && is_quit(keymap, &key)) =>
                {
                    break;
                }
                // The dialog takes over the keys: Esc cancels, P retries after a failure, and
                // everything else is ignored (Req 32.1).
                Some(Ok(Event::Key(key))) if app.pairing.is_open() => {
                    if pairing::is_cancel_key(&key) {
                        app.pairing.apply(PairingEvent::Cancel);
                        pairing_task = None;
                        limiter.mark_dirty();
                    } else if pairing::is_pair_key(keymap, &key)
                        && matches!(app.pairing, PairingState::Expired | PairingState::Failed(_))
                    {
                        start_pairing(&mut app, &mut pairing_task, &mut pairing_id, &pair_tx);
                        limiter.mark_dirty();
                    }
                }
                // An open venue or provider picker is modal for the keys (Task 16.3).
                Some(Ok(Event::Key(key)))
                    if app.picker.is_some() && key.kind != KeyEventKind::Release =>
                {
                    app.now_ms = wall_ms();
                    if let Some((changed, messages)) = apply_picker_key(&mut app, keymap, &key) {
                        for message in messages {
                            let _ = net_tx.try_send(message);
                        }
                        if changed {
                            limiter.mark_dirty();
                        }
                    }
                }
                // `copilot.focus` (keymap, default `C`) focuses the Copilot input line.
                Some(Ok(Event::Key(key)))
                    if key.kind == KeyEventKind::Press
                        && (app.page == app::Page::Copilot || app.page == app::Page::News)
                        && app.focus == Focus::Chart
                        && !app.account.dialog_open()
                        && !app.help_open
                        && !app.copilot.focused
                        && global_action(keymap, &key) == Some(Action::CopilotFocus) =>
                {
                    app.copilot.focused = true;
                    limiter.mark_dirty();
                }
                // News and Copilot keys (Task 16.4): the Copilot input line takes every key while
                // focused; `t` previews the trade idea, Enter/`y` act on news.
                Some(Ok(Event::Key(key)))
                    if key.kind == KeyEventKind::Press
                        && (app.page == app::Page::Copilot || app.page == app::Page::News)
                        && app.focus == Focus::Chart
                        && !app.account.dialog_open()
                        && !app.help_open
                        && (app.copilot.focused
                            || matches!(
                                key.code,
                                KeyCode::Char('t' | 'T' | 'y' | 'Y' | 'j' | 'k')
                                    | KeyCode::Up
                                    | KeyCode::Down
                                    | KeyCode::Enter
                                    | KeyCode::Esc
                            ))
                        && !is_hard_exit(&key) =>
                {
                    app.now_ms = wall_ms();
                    if let Some(outcome) = copilot::handle_key(&mut app, &key) {
                        for message in outcome.messages {
                            let _ = net_tx.try_send(message);
                        }
                        if let Some(sequence) = outcome.osc52 {
                            use std::io::Write;
                            let mut out = io::stdout();
                            let _ = out.write_all(sequence.as_bytes());
                            let _ = out.flush();
                        }
                        if outcome.changed {
                            limiter.mark_dirty();
                        }
                    }
                }
                // Order entry (Task 12.4): B, S, F, X, `:`, the dialog keys, the command bar, the
                // ticket quantity, and the orders panel. The decision is pure; see order_input.
                Some(Ok(Event::Key(key)))
                    if key.kind != KeyEventKind::Release
                        && order_input::decide_key(&app, keymap, &key).is_some() =>
                {
                    app.now_ms = wall_ms();
                    let now = app.now_ms;
                    if let Some(command) = order_input::decide_key(&app, keymap, &key) {
                        let outcome = order_input::apply_key_command(&mut app, command, now);
                        for message in outcome.messages {
                            let _ = net_tx.try_send(message);
                        }
                        if outcome.changed {
                            limiter.mark_dirty();
                        }
                    }
                }
                Some(Ok(Event::Key(key)))
                    if key.kind == KeyEventKind::Press
                        && key.code == KeyCode::Esc
                        && app.book_cursor.is_some() =>
                {
                    // Esc leaves the book (Task 8.3).
                    app.book_cursor = None;
                    limiter.mark_dirty();
                }
                // `model.next` (`M`) cycles the Ollama model (Task 19.5, Req 38.14).
                Some(Ok(Event::Key(key)))
                    if !app.pairing.is_open()
                        && app.picker.is_none()
                        && key.kind == KeyEventKind::Press
                        && global_action(keymap, &key) == Some(Action::ModelNext) =>
                {
                    if let Some(message) = app.cycle_ollama_model() {
                        let _ = net_tx.try_send(message);
                        limiter.mark_dirty();
                    }
                }
                // `venue.next` and `provider.next` open the pickers (Task 16.3).
                Some(Ok(Event::Key(key)))
                    if !app.pairing.is_open()
                        && matches!(
                            global_action(keymap, &key),
                            Some(Action::VenueNext | Action::ProviderNext)
                        )
                        && key.kind == KeyEventKind::Press =>
                {
                    if let Some((changed, _)) = apply_picker_key(&mut app, keymap, &key)
                        && changed
                    {
                        limiter.mark_dirty();
                    }
                }
                // `P` (`auth.pair`) opens the pairing dialog (Req 48.1).
                Some(Ok(Event::Key(key))) if pairing::is_pair_key(keymap, &key) => {
                    start_pairing(&mut app, &mut pairing_task, &mut pairing_id, &pair_tx);
                    limiter.mark_dirty();
                }
                // Menu keys: 1 to 8 switch page, `<` and `>` move the timeframe, F1 toggles
                // help, Esc closes it (Req 30.1).
                Some(Ok(Event::Key(key)))
                    if key.kind == KeyEventKind::Press
                        && !app.pairing.is_open()
                        && menu_key_kind(&app, keymap, &key).is_some() =>
                {
                    let (changed, messages) = match menu_key_kind(&app, keymap, &key) {
                        Some(kind) => apply_menu_key(&mut app, kind),
                        None => (false, Vec::new()),
                    };
                    for message in messages {
                        let _ = net_tx.try_send(message);
                    }
                    if changed {
                        limiter.mark_dirty();
                    }
                }
                // `l` switches the chart between candles and a line (Task 16.9).
                Some(Ok(Event::Key(key)))
                    if key.kind == KeyEventKind::Press
                        && key.code == KeyCode::Char('l')
                        && !key.modifiers.intersects(
                            crossterm::event::KeyModifiers::CONTROL
                                | crossterm::event::KeyModifiers::ALT,
                        )
                        && !app.pairing.is_open()
                        && !app.help_open
                        && !app.copilot.focused
                        && app.picker.is_none()
                        && order_input::effective_focus(&app) != order_input::Focus::Ticket =>
                {
                    app.chart_line = !app.chart_line;
                    limiter.mark_dirty();
                }
                Some(Ok(Event::Key(key))) if key.kind == KeyEventKind::Press => {
                    // Until panel focus exists (Task 6.5), keys resolve in the book context for
                    // the book actions and in the chart context for everything else.
                    let action = chord_from_crossterm(&key).and_then(|chord| {
                        resolve(keymap, Context::Book, &chord)
                            .filter(|action| is_book_action(*action))
                            .or_else(|| resolve(keymap, Context::Chart, &chord))
                    });
                    if let Some(action) = action {
                        let (changed, messages) = if is_book_action(action) {
                            (apply_book_action(&mut app, action), Vec::new())
                        } else if is_indicator_action(action) {
                            (apply_indicator_action(&mut app, action), Vec::new())
                        } else if is_symbol_action(action) {
                            apply_symbol_action(&mut app, action)
                        } else {
                            apply_chart_action(&mut app, action)
                        };
                        for message in messages {
                            // A full channel drops the message; the subscription set the
                            // net task keeps is only changed by messages that arrive.
                            let _ = net_tx.try_send(message);
                        }
                        if changed {
                            limiter.mark_dirty();
                        }
                    }
                }
                // The order entry actions (B, S, F, X, `:`, the dialog, command, and orders
                // keys) are decided by `order_input::decide_key` in the arm above.
                // The mouse is ignored while the pairing dialog is open.
                Some(Ok(Event::Mouse(mouse))) if !app.pairing.is_open() => {
                    if let Some(action) = mouse_action(&hits, &mut drag, mouse) {
                        if action == MouseAction::Quit {
                            break;
                        }
                        app.now_ms = wall_ms();
                        let (changed, messages) = apply_mouse_action(&mut app, action);
                        for message in messages {
                            let _ = net_tx.try_send(message);
                        }
                        if changed {
                            limiter.mark_dirty();
                        }
                    }
                }
                // Ratatui resizes its buffers on the next draw; only a redraw is needed.
                Some(Ok(Event::Resize(_, _))) => limiter.mark_dirty(),
                Some(Ok(_)) => {}
                Some(Err(err)) => return Err(err),
                // The input thread ended without an error: nothing can quit the app any
                // more, so leave the loop and restore the terminal.
                None => break,
            },
            event = net.recv(), if net_open => match event {
                Some(event) => {
                    // Req 48.12: a rejected, expired, or signed-out token is deleted. Guest
                    // mode never sent the file's token, so it leaves the file alone.
                    if !guest && app::forgets_token(&event) && let Some(store) = &store {
                        let _ = store.delete();
                    }
                    // The reducers read the clock from the app (preview deadlines, rejections).
                    app.now_ms = wall_ms();
                    // Task 16.4: ask for the news list on every (re)connect.
                    if matches!(event, net::NetEvent::Connected) {
                        let _ = net_tx.try_send(ClientMessage::SubscribeNews);
                    }
                    if app::update(&mut app, event) {
                        limiter.mark_dirty();
                    }
                    // A `hello` that moved the Active_Venue: resubscribe on the new venue.
                    if let Some(old) = app.venue_switched_from.take() {
                        for message in venue_switch_messages(&app, old) {
                            let _ = net_tx.try_send(message);
                        }
                    }
                }
                None => net_open = false,
            },
            msg = pair_rx.recv() => {
                // Messages of a cancelled or finished attempt are dropped.
                if let Some(msg) = msg && msg.id == pairing_id && app.pairing.is_open() {
                    match msg.kind {
                        PairingKind::State(state) => app.pairing = state,
                        PairingKind::SignedIn(session) => {
                            // Req 48.1, 48.11: save the token for this server, sign this
                            // connection in, and close the dialog. The `Session` message that
                            // answers updates the status line.
                            let (message, saved) =
                                pairing::complete_sign_in(&session, store.as_ref());
                            let _ = net_tx.try_send(message);
                            app.pairing = match saved {
                                Ok(()) => PairingState::Idle,
                                Err(text) => PairingState::Failed(text),
                            };
                            pairing_task = None;
                        }
                    }
                    limiter.mark_dirty();
                }
            },
            scheduled = tick.tick() => {
                // The scheduled tick time, not the time after drawing, so consecutive
                // checks are never closer than the interval and ticks are not skipped.
                let now = scheduled.into_std();
                // A preview countdown second, an expired preview, or the end of the rejection
                // line needs a redraw even though no event arrived.
                if app.tick(wall_ms()) {
                    limiter.mark_dirty();
                }
                // Task 16.10: a ping every 2 s feeds the header latency.
                if let Some(ping) = app.latency_ping(wall_ms()) {
                    let _ = net_tx.try_send(ping);
                }
                if limiter.should_draw(now) {
                    terminal.draw(|frame| ui::draw(frame, &app, &mut hits))?;
                    limiter.drew(now);
                }
            }
        }
    }
    drop(terminal);
    drop(guard);
    Ok(())
}

/// Opens the pairing dialog and starts the driver for a new attempt. Dropping the previous
/// handle first cancels any earlier attempt.
fn start_pairing(
    app: &mut App,
    task: &mut Option<PairingHandle>,
    id: &mut u64,
    tx: &mpsc::Sender<PairingMsg>,
) {
    *task = None;
    *id = id.saturating_add(1);
    app.pairing = PairingState::Idle;
    app.pairing.apply(PairingEvent::Started);
    *task = Some(pairing::spawn(&app.server, *id, tx.clone()));
}

/// Starts the thread that reads terminal input. It stops after a read error or once the
/// receiver is gone; on quit it may stay blocked in `read` until the process exits.
fn spawn_input_thread() -> io::Result<mpsc::Receiver<io::Result<Event>>> {
    let (tx, rx) = mpsc::channel(INPUT_CHANNEL_CAPACITY);
    thread::Builder::new()
        .name("tui-input".to_owned())
        .spawn(move || {
            loop {
                let result = event::read();
                let failed = result.is_err();
                if tx.blocking_send(result).is_err() || failed {
                    break;
                }
            }
        })?;
    Ok(rx)
}

/// Applies a timeframe or zoom/pan action to the chart. Returns whether the screen changed and
/// the messages to send: a timeframe change unsubscribes the old key and subscribes the new
/// one (Req 25.3, 33.3). Other actions do nothing here.
fn apply_chart_action(app: &mut App, action: Action) -> (bool, Vec<ClientMessage>) {
    let timeframe = match action {
        Action::Timeframe1m => Timeframe::M1,
        Action::Timeframe5m => Timeframe::M5,
        Action::Timeframe15m => Timeframe::M15,
        Action::Timeframe1h => Timeframe::H1,
        Action::Timeframe4h => Timeframe::H4,
        Action::Timeframe1d => Timeframe::D1,
        Action::ChartZoomIn => {
            app.chart_view.zoom_in();
            return (true, Vec::new());
        }
        Action::ChartZoomOut => {
            app.chart_view.zoom_out();
            return (true, Vec::new());
        }
        Action::ChartPanBack => {
            app.chart_view.pan_back(app.candles.len());
            return (true, Vec::new());
        }
        Action::ChartPanForward => {
            app.chart_view.pan_forward();
            return (true, Vec::new());
        }
        _ => return (false, Vec::new()),
    };
    select_timeframe(app, timeframe)
}

/// True for the actions of the `book` keymap context.
fn is_book_action(action: Action) -> bool {
    matches!(
        action,
        Action::BookUp | Action::BookDown | Action::BookPrefill
    )
}

/// True for the `indicator.*` actions of the `global` keymap context (Req 26.3).
fn is_indicator_action(action: Action) -> bool {
    indicator_of(action).is_some()
}

fn indicator_of(action: Action) -> Option<Indicator> {
    match action {
        Action::IndicatorEma => Some(Indicator::Ema),
        Action::IndicatorVwap => Some(Indicator::Vwap),
        Action::IndicatorBollinger => Some(Indicator::Bollinger),
        Action::IndicatorRsi => Some(Indicator::Rsi),
        Action::IndicatorAtr => Some(Indicator::Atr),
        _ => None,
    }
}

/// Toggles the indicator of an `indicator.*` action (keys E, W, O, R, T). Returns whether
/// the screen changed; other actions change nothing.
fn apply_indicator_action(app: &mut App, action: Action) -> bool {
    match indicator_of(action) {
        Some(indicator) => {
            app.toggles.toggle(indicator);
            true
        }
        None => false,
    }
}

/// Applies a book action (Req 30.1). Up and down move the cursor over the asks (top) and then
/// the bids, starting at the best ask when there is no cursor yet. Enter prefills the limit
/// ticket with the selected level's price. Returns whether the screen changed.
fn apply_book_action(app: &mut App, action: Action) -> bool {
    match action {
        Action::BookUp => move_book_cursor(app, true),
        Action::BookDown => move_book_cursor(app, false),
        Action::BookPrefill => {
            let price = app
                .book_cursor
                .and_then(|c| app.book().and_then(|b| b.level(c.side, c.index)))
                .map(|level| level.price);
            match price {
                Some(price) => {
                    let symbol = app.symbol.clone();
                    app.prefill_limit(&symbol, price);
                    // Keyboard flow: pick the price, then type the quantity (Req 30.2). Esc
                    // gives the keys back.
                    app.focus = Focus::Ticket;
                    true
                }
                None => false,
            }
        }
        _ => false,
    }
}

/// Moves the book cursor one row. Without a cursor it selects the best ask (or the best bid).
fn move_book_cursor(app: &mut App, up: bool) -> bool {
    let next = {
        let Some(book) = app.book() else {
            return false;
        };
        match app.book_cursor.and_then(|c| c.clamp(book)) {
            Some(cursor) if up => Some(cursor.up(book)),
            Some(cursor) => Some(cursor.down(book)),
            None => BookCursor::first(book),
        }
    };
    let changed = next != app.book_cursor;
    app.book_cursor = next;
    changed
}

/// The subscriptions that keep every watchlist price live (Req 27.3): each default watchlist
/// symbol at 1m. They are never unsubscribed, so the net task resends all of them after every
/// reconnect (Req 33.3). BTC-USD 1m is also the default chart key.
fn watchlist_subscriptions() -> Vec<Subscription> {
    DEFAULT_WATCHLIST
        .iter()
        .map(|symbol| Subscription::new(*symbol, WATCH_TIMEFRAME))
        .collect()
}

/// The messages that move the chart from `(old_symbol, old_timeframe)` to the app's current
/// key: unsubscribe the old key unless the watchlist keeps it open, then subscribe the new key.
/// The subscribe is sent even when the watchlist already holds the new key, because the server
/// answers it with the candle snapshot the chart needs after it was cleared.
fn chart_key_messages(app: &App, old_symbol: &str, old_timeframe: Timeframe) -> Vec<ClientMessage> {
    let mut messages = Vec::with_capacity(2);
    if !is_watch_key(old_symbol, old_timeframe) {
        messages.push(ClientMessage::Unsubscribe {
            venue: app.active_venue,
            symbol: old_symbol.to_owned(),
            timeframe: old_timeframe,
        });
    }
    messages.push(ClientMessage::Subscribe {
        venue: app.active_venue,
        symbol: app.symbol.clone(),
        timeframe: app.timeframe,
    });
    messages
}

/// The (symbol, timeframe) keys a venue holds: the watchlist at 1m plus the chart key.
fn venue_keys(app: &App) -> Vec<(String, Timeframe)> {
    let mut keys: Vec<(String, Timeframe)> = DEFAULT_WATCHLIST
        .iter()
        .map(|symbol| ((*symbol).to_owned(), WATCH_TIMEFRAME))
        .collect();
    let chart = (app.symbol.clone(), app.timeframe);
    if !keys.contains(&chart) {
        keys.push(chart);
    }
    keys
}

/// The messages that move every subscription from venue `old` to the app's Active_Venue.
fn venue_switch_messages(app: &App, old: protocol::Venue) -> Vec<ClientMessage> {
    let keys = venue_keys(app);
    let mut messages = Vec::with_capacity(keys.len() * 2);
    for (symbol, timeframe) in &keys {
        messages.push(ClientMessage::Unsubscribe {
            venue: old,
            symbol: symbol.clone(),
            timeframe: *timeframe,
        });
    }
    for (symbol, timeframe) in keys {
        messages.push(ClientMessage::Subscribe {
            venue: app.active_venue,
            symbol,
            timeframe,
        });
    }
    messages
}

/// Opens the venue or provider picker; with a picker open, handles the keys that move,
/// choose, and close it. Returns `None` when `key` is not a picker key.
fn apply_picker_key(
    app: &mut App,
    keymap: &Keymap,
    key: &KeyEvent,
) -> Option<(bool, Vec<ClientMessage>)> {
    if key.kind != KeyEventKind::Press
        || key
            .modifiers
            .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
    {
        return None;
    }
    if let Some(picker) = app.picker {
        let changed = match key.code {
            KeyCode::Up | KeyCode::Char('k') => app.move_picker(false),
            KeyCode::Down | KeyCode::Char('j') => app.move_picker(true),
            KeyCode::Esc => {
                app.picker = None;
                true
            }
            KeyCode::Enter => return Some(choose_picker_row(app, picker.cursor)),
            // The picker is modal: every other key is swallowed.
            _ => false,
        };
        return Some((changed, Vec::new()));
    }
    let kind = match global_action(keymap, key) {
        Some(Action::VenueNext) => PickerKind::Venue,
        Some(Action::ProviderNext) => PickerKind::Provider,
        _ => return None,
    };
    Some((app.open_picker(kind), Vec::new()))
}

/// Chooses a picker row (key Enter or a click): resubscribes on a venue change and sends
/// `SetProvider` on a provider choice.
fn choose_picker_row(app: &mut App, index: usize) -> (bool, Vec<ClientMessage>) {
    let (changed, switched, message) = app.choose_picker_row(index);
    let mut messages = Vec::new();
    if let Some((old, _)) = switched {
        messages.extend(venue_switch_messages(app, old));
    }
    messages.extend(message);
    (changed, messages)
}

/// Switches the chart timeframe and returns the subscription messages.
fn select_timeframe(app: &mut App, timeframe: Timeframe) -> (bool, Vec<ClientMessage>) {
    match app.select_timeframe(timeframe) {
        Some(previous) => {
            let symbol = app.symbol.clone();
            (true, chart_key_messages(app, &symbol, previous))
        }
        None => (false, Vec::new()),
    }
}

/// Switches every panel to `symbol` (Req 27.4) and returns the subscription messages. A symbol
/// that is not on the watchlist, or the current symbol, changes nothing.
fn select_symbol(app: &mut App, symbol: &str) -> (bool, Vec<ClientMessage>) {
    if !app.watchlist.iter().any(|s| s == symbol) {
        return (false, Vec::new());
    }
    match app.select_symbol(symbol) {
        Some(previous) => {
            let timeframe = app.timeframe;
            (true, chart_key_messages(app, &previous, timeframe))
        }
        None => (false, Vec::new()),
    }
}

/// True for the `symbol.next` and `symbol.prev` actions (Tab and Shift+Tab, Req 27.4).
fn is_symbol_action(action: Action) -> bool {
    matches!(action, Action::SymbolNext | Action::SymbolPrev)
}

/// Applies `symbol.next` / `symbol.prev`: the next or previous watchlist symbol, wrapping.
/// Returns whether the screen changed and the subscription messages; other actions do nothing.
fn apply_symbol_action(app: &mut App, action: Action) -> (bool, Vec<ClientMessage>) {
    let target = match action {
        Action::SymbolNext => next_symbol(&app.symbol, &app.watchlist),
        Action::SymbolPrev => prev_symbol(&app.symbol, &app.watchlist),
        _ => return (false, Vec::new()),
    };
    select_symbol(app, &target)
}

/// Applies a mouse action to the chart. Returns whether the screen changed and the messages to
/// send (Req 25.3, 25.4).
fn apply_mouse_action(app: &mut App, action: MouseAction) -> (bool, Vec<ClientMessage>) {
    // Order entry clicks (✕, ticket buttons, dialog buttons, panel focus). While a dialog is
    // open it takes every action, so the dialog is modal for the mouse too (Task 12.4).
    // The venue and provider pickers (Task 16.3). An open picker takes every mouse action.
    match action {
        MouseAction::OpenPicker(kind) if app.picker.is_none() => {
            return (app.open_picker(kind), Vec::new());
        }
        MouseAction::PickerRow(index) if app.picker.is_some() => {
            return choose_picker_row(app, index);
        }
        MouseAction::ClosePicker if app.picker.is_some() => {
            app.picker = None;
            return (true, Vec::new());
        }
        _ if app.picker.is_some() => return (false, Vec::new()),
        _ => {}
    }
    let now = app.now_ms;
    if let Some(outcome) = order_input::apply_order_mouse(app, &action, now) {
        return (outcome.changed, outcome.messages);
    }
    match action {
        MouseAction::ZoomIn => app.chart_view.zoom_in(),
        MouseAction::ZoomOut => app.chart_view.zoom_out(),
        MouseAction::PanBack(cols) => app.chart_view.pan_back_by(cols, app.candles.len()),
        MouseAction::PanForward(cols) => app.chart_view.pan_forward_by(cols),
        MouseAction::SelectTimeframe(timeframe) => return select_timeframe(app, timeframe),
        MouseAction::SelectPage(page) => return (app.select_page(page), Vec::new()),
        MouseAction::SelectSymbol(symbol) => return select_symbol(app, &symbol),
        MouseAction::ToggleIndicator(indicator) => {
            app.toggles.toggle(indicator);
        }
        MouseAction::PrefillBookLevel { side, index } => {
            let Some(level) = app.book().and_then(|b| b.level(side, index)) else {
                return (false, Vec::new());
            };
            app.book_cursor = Some(BookCursor { side, index });
            let symbol = app.symbol.clone();
            app.prefill_limit(&symbol, level.price);
            return (true, Vec::new());
        }
        MouseAction::BookCursorUp => return (move_book_cursor(app, true), Vec::new()),
        MouseAction::BookCursorDown => return (move_book_cursor(app, false), Vec::new()),
        MouseAction::SetCrosshair(crosshair) => {
            let changed = app.crosshair != Some(crosshair);
            app.crosshair = Some(crosshair);
            return (changed, Vec::new());
        }
        MouseAction::ClearCrosshair => {
            let changed = app.crosshair.is_some();
            app.crosshair = None;
            return (changed, Vec::new());
        }
        // Handled by `apply_order_mouse` above.
        MouseAction::CancelOrder(_)
        | MouseAction::SelectOrder(_)
        | MouseAction::TicketBuy
        | MouseAction::TicketSell
        | MouseAction::FocusTicket
        | MouseAction::FocusCommand
        | MouseAction::FocusOrders
        | MouseAction::DialogConfirm
        | MouseAction::DialogCancel
        | MouseAction::OpenPicker(_)
        | MouseAction::PickerRow(_)
        | MouseAction::ClosePicker
        | MouseAction::Quit => return (false, Vec::new()),
    }
    (true, Vec::new())
}

/// A key of the left menu.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MenuKey {
    Page(crate::app::Page),
    TimeframePrev,
    TimeframeNext,
    Help,
    CloseHelp,
}

/// Decides whether `key` is a menu key. Pure.
fn menu_key_kind(app: &App, keymap: &Keymap, key: &KeyEvent) -> Option<MenuKey> {
    if key.code == KeyCode::Esc && app.help_open {
        return Some(MenuKey::CloseHelp);
    }
    let digit = match global_action(keymap, key)? {
        Action::Help => return Some(MenuKey::Help),
        Action::TimeframePrev => return Some(MenuKey::TimeframePrev),
        Action::TimeframeNext => return Some(MenuKey::TimeframeNext),
        Action::Page1 => '1',
        Action::Page2 => '2',
        Action::Page3 => '3',
        Action::Page4 => '4',
        Action::Page5 => '5',
        Action::Page6 => '6',
        Action::Page7 => '7',
        Action::Page8 => '8',
        _ => return None,
    };
    crate::app::Page::from_digit(digit).map(MenuKey::Page)
}

/// The `global` keymap action bound to a key press, if any.
fn global_action(keymap: &Keymap, key: &KeyEvent) -> Option<Action> {
    resolve(keymap, Context::Global, &chord_from_crossterm(key)?)
}

/// Applies a menu key. Timeframe moves step through the timeframe buttons.
fn apply_menu_key(app: &mut App, kind: MenuKey) -> (bool, Vec<ClientMessage>) {
    match kind {
        MenuKey::Page(page) => (app.select_page(page), Vec::new()),
        MenuKey::Help => {
            app.help_open = !app.help_open;
            (true, Vec::new())
        }
        MenuKey::CloseHelp => {
            app.help_open = false;
            (true, Vec::new())
        }
        MenuKey::TimeframePrev | MenuKey::TimeframeNext => {
            let frames = crate::ui::TIMEFRAMES;
            let Some(index) = frames.iter().position(|t| *t == app.timeframe) else {
                return (false, Vec::new());
            };
            let next = if kind == MenuKey::TimeframeNext {
                (index + 1).min(frames.len() - 1)
            } else {
                index.saturating_sub(1)
            };
            match frames.get(next) {
                Some(timeframe) => select_timeframe(app, *timeframe),
                None => (false, Vec::new()),
            }
        }
    }
}

/// The wall clock in epoch milliseconds. The reducers never read the clock themselves: the loop
/// stores this in `App::now_ms` before each event, key, click, and tick.
fn wall_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|elapsed| i64::try_from(elapsed.as_millis()).ok())
        .unwrap_or(0)
}

/// Ctrl-C (which arrives as a key event in raw mode). Always quits, whatever the keymap says.
fn is_hard_exit(key: &KeyEvent) -> bool {
    key.kind == KeyEventKind::Press
        && key.code == KeyCode::Char('c')
        && key.modifiers.contains(KeyModifiers::CONTROL)
}

/// True when the keymap binds this key to `app.quit`.
/// Until panel focus exists (Tasks 6.5 and 6.6), keys resolve in the `global` context.
fn is_quit(keymap: &Keymap, key: &KeyEvent) -> bool {
    if key.kind != KeyEventKind::Press {
        return false;
    }
    chord_from_crossterm(key)
        .is_some_and(|chord| resolve(keymap, Context::Global, &chord) == Some(Action::AppQuit))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::KeyEventState;

    fn key(code: KeyCode, modifiers: KeyModifiers, kind: KeyEventKind) -> KeyEvent {
        KeyEvent {
            code,
            modifiers,
            kind,
            state: KeyEventState::NONE,
        }
    }

    fn press(code: KeyCode, modifiers: KeyModifiers) -> KeyEvent {
        key(code, modifiers, KeyEventKind::Press)
    }

    fn keymap() -> Keymap {
        Keymap::embedded().unwrap()
    }

    #[test]
    fn q_quits_through_the_keymap() {
        let keymap = keymap();
        assert!(is_quit(
            &keymap,
            &press(KeyCode::Char('q'), KeyModifiers::NONE)
        ));
        assert!(is_quit(
            &keymap,
            &press(KeyCode::Char('Q'), KeyModifiers::SHIFT)
        ));
    }

    #[test]
    fn ctrl_c_is_a_hard_exit_regardless_of_the_keymap() {
        assert!(is_hard_exit(&press(
            KeyCode::Char('c'),
            KeyModifiers::CONTROL
        )));
        assert!(!is_hard_exit(&press(
            KeyCode::Char('c'),
            KeyModifiers::NONE
        )));
        assert!(!is_hard_exit(&key(
            KeyCode::Char('c'),
            KeyModifiers::CONTROL,
            KeyEventKind::Release
        )));
        // The keymap does not bind Ctrl-C, so only the hard exit handles it.
        assert!(!is_quit(
            &keymap(),
            &press(KeyCode::Char('c'), KeyModifiers::CONTROL)
        ));
    }

    #[test]
    fn other_keys_and_releases_do_not_quit() {
        let keymap = keymap();
        assert!(!is_quit(
            &keymap,
            &press(KeyCode::Char('c'), KeyModifiers::NONE)
        ));
        assert!(!is_quit(
            &keymap,
            &press(KeyCode::Char('q'), KeyModifiers::CONTROL)
        ));
        assert!(!is_quit(
            &keymap,
            &press(KeyCode::Char('x'), KeyModifiers::NONE)
        ));
        assert!(!is_quit(
            &keymap,
            &press(KeyCode::Enter, KeyModifiers::NONE)
        ));
        assert!(!is_quit(&keymap, &press(KeyCode::Esc, KeyModifiers::NONE)));
        assert!(!is_quit(
            &keymap,
            &key(
                KeyCode::Char('q'),
                KeyModifiers::NONE,
                KeyEventKind::Release
            )
        ));
    }

    fn sub(symbol: &str, timeframe: Timeframe) -> ClientMessage {
        ClientMessage::Subscribe {
            venue: protocol::Venue::Replay,
            symbol: symbol.into(),
            timeframe,
        }
    }

    fn unsub(symbol: &str, timeframe: Timeframe) -> ClientMessage {
        ClientMessage::Unsubscribe {
            venue: protocol::Venue::Replay,
            symbol: symbol.into(),
            timeframe,
        }
    }

    #[test]
    fn timeframe_action_swaps_the_subscription() {
        let mut app = App::new("ws://x/ws");
        let (changed, messages) = apply_chart_action(&mut app, Action::Timeframe5m);
        assert!(changed);
        assert_eq!(app.timeframe, Timeframe::M5);
        // BTC-USD 1m stays subscribed for the watchlist, so only the new key is sent.
        assert_eq!(messages, vec![sub("BTC-USD", Timeframe::M5)]);
        // The same timeframe again does nothing.
        let (changed, messages) = apply_chart_action(&mut app, Action::Timeframe5m);
        assert!(!changed && messages.is_empty());
        // A key the watchlist does not hold is unsubscribed before the new one is subscribed.
        let (changed, messages) = apply_chart_action(&mut app, Action::Timeframe1h);
        assert!(changed);
        assert_eq!(
            messages,
            vec![
                unsub("BTC-USD", Timeframe::M5),
                sub("BTC-USD", Timeframe::H1)
            ]
        );
    }

    // Req 27.4
    #[test]
    fn tab_and_shift_tab_resolve_to_the_symbol_actions() {
        let keymap = keymap();
        // The same lookup as the event loop: book first (book actions only), then chart.
        let action_of = |key: KeyEvent| {
            chord_from_crossterm(&key).and_then(|chord| {
                resolve(&keymap, Context::Book, &chord)
                    .filter(|action| is_book_action(*action))
                    .or_else(|| resolve(&keymap, Context::Chart, &chord))
            })
        };
        assert_eq!(
            action_of(press(KeyCode::Tab, KeyModifiers::NONE)),
            Some(Action::SymbolNext)
        );
        assert_eq!(
            action_of(press(KeyCode::BackTab, KeyModifiers::SHIFT)),
            Some(Action::SymbolPrev)
        );
        assert!(is_symbol_action(Action::SymbolNext) && is_symbol_action(Action::SymbolPrev));
        assert!(!is_symbol_action(Action::BookUp));
    }

    // Req 27.4
    #[test]
    fn symbol_actions_cycle_the_watchlist_and_swap_the_chart_key() {
        let mut app = App::new("ws://x/ws");
        // 1m: both keys are watchlist keys, so only the subscribe (for the snapshot) is sent.
        let (changed, messages) = apply_symbol_action(&mut app, Action::SymbolNext);
        assert!(changed);
        assert_eq!(app.symbol, "ETH-USD");
        assert_eq!(messages, vec![sub("ETH-USD", Timeframe::M1)]);
        apply_symbol_action(&mut app, Action::SymbolNext);
        assert_eq!(app.symbol, "SOL-USD");
        // Wraps around.
        apply_symbol_action(&mut app, Action::SymbolNext);
        assert_eq!(app.symbol, "BTC-USD");
        let (_, messages) = apply_symbol_action(&mut app, Action::SymbolPrev);
        assert_eq!(app.symbol, "SOL-USD");
        assert_eq!(messages, vec![sub("SOL-USD", Timeframe::M1)]);
        // At another timeframe the old chart key is unsubscribed first.
        apply_chart_action(&mut app, Action::Timeframe15m);
        let (changed, messages) = apply_symbol_action(&mut app, Action::SymbolPrev);
        assert!(changed);
        assert_eq!(app.symbol, "ETH-USD");
        assert_eq!(
            messages,
            vec![
                unsub("SOL-USD", Timeframe::M15),
                sub("ETH-USD", Timeframe::M15)
            ]
        );
        // Other actions do nothing.
        let (changed, messages) = apply_symbol_action(&mut app, Action::ChartZoomIn);
        assert!(!changed && messages.is_empty());
    }

    #[test]
    fn a_one_symbol_watchlist_does_not_switch() {
        let mut app = App::new("ws://x/ws");
        app.watchlist = vec!["BTC-USD".to_owned()];
        let (changed, messages) = apply_symbol_action(&mut app, Action::SymbolNext);
        assert!(!changed && messages.is_empty());
        assert_eq!(app.symbol, "BTC-USD");
    }

    // Req 27.4
    #[test]
    fn clicking_a_watchlist_symbol_switches_like_the_keyboard() {
        let mut app = app_with_book();
        app.book_cursor = cursor(crate::hitmap::BookSide::Ask, 0);
        let (changed, messages) =
            apply_mouse_action(&mut app, MouseAction::SelectSymbol("SOL-USD".into()));
        assert!(changed);
        assert_eq!(app.symbol, "SOL-USD");
        assert_eq!(app.book_cursor, None);
        assert_eq!(app.ticket.symbol, "SOL-USD");
        assert_eq!(messages, vec![sub("SOL-USD", Timeframe::M1)]);
        // The selected symbol again, or a symbol off the watchlist, changes nothing.
        let (changed, messages) =
            apply_mouse_action(&mut app, MouseAction::SelectSymbol("SOL-USD".into()));
        assert!(!changed && messages.is_empty());
        let (changed, _) =
            apply_mouse_action(&mut app, MouseAction::SelectSymbol("NOPE-USD".into()));
        assert!(!changed);
        assert_eq!(app.symbol, "SOL-USD");
    }

    // Req 33.3: after any number of switches the net task's set still holds every watchlist
    // key plus the current chart key, so a reconnect resubscribes all of them.
    #[test]
    fn the_subscription_set_keeps_the_watchlist_keys_across_switches() {
        use crate::net::SubscriptionSet;
        let mut set = SubscriptionSet::new(watchlist_subscriptions());
        assert_eq!(
            set.messages(),
            [
                sub("BTC-USD", Timeframe::M1),
                sub("ETH-USD", Timeframe::M1),
                sub("SOL-USD", Timeframe::M1)
            ]
        );
        let mut app = App::new("ws://x/ws");
        let steps: Vec<(bool, Vec<ClientMessage>)> = vec![
            apply_chart_action(&mut app, Action::Timeframe5m),
            apply_symbol_action(&mut app, Action::SymbolNext),
            apply_chart_action(&mut app, Action::Timeframe1h),
            apply_symbol_action(&mut app, Action::SymbolPrev),
            apply_chart_action(&mut app, Action::Timeframe1m),
            apply_symbol_action(&mut app, Action::SymbolPrev),
        ];
        for (_, messages) in &steps {
            for message in messages {
                set.observe(message);
            }
        }
        assert_eq!(
            (app.symbol.as_str(), app.timeframe),
            ("SOL-USD", Timeframe::M1)
        );
        assert_eq!(
            set.messages(),
            [
                sub("BTC-USD", Timeframe::M1),
                sub("ETH-USD", Timeframe::M1),
                sub("SOL-USD", Timeframe::M1)
            ]
        );
        // On a key the watchlist does not hold, that key is in the set as well.
        for message in apply_chart_action(&mut app, Action::Timeframe1d).1 {
            set.observe(&message);
        }
        assert_eq!(set.messages().len(), 4);
        assert!(set.messages().contains(&sub("SOL-USD", Timeframe::D1)));
    }

    #[test]
    fn mouse_actions_update_the_app() {
        use crate::chart_model::Crosshair;
        let mut app = App::new("ws://x/ws");
        let before = app.chart_view.visible;
        assert!(apply_mouse_action(&mut app, MouseAction::ZoomIn).0);
        assert!(app.chart_view.visible < before);
        let ch = Crosshair { col: 2, row: 1 };
        assert!(apply_mouse_action(&mut app, MouseAction::SetCrosshair(ch)).0);
        assert!(!apply_mouse_action(&mut app, MouseAction::SetCrosshair(ch)).0);
        assert!(apply_mouse_action(&mut app, MouseAction::ClearCrosshair).0);
        assert!(!apply_mouse_action(&mut app, MouseAction::ClearCrosshair).0);
        let (changed, messages) =
            apply_mouse_action(&mut app, MouseAction::SelectTimeframe(Timeframe::H1));
        assert!(changed);
        assert_eq!(app.timeframe, Timeframe::H1);
        // BTC-USD 1m is a watchlist key, so only the subscribe for 1h is sent.
        assert_eq!(messages, vec![sub("BTC-USD", Timeframe::H1)]);
    }

    fn app_with_book() -> App {
        use crate::book_model::BookState;
        use protocol::{Level, Price, Qty};
        let level = |p: i64| Level {
            price: Price(p),
            qty: Qty(1),
        };
        let mut app = App::new("ws://x/ws");
        app.apply_book(
            "BTC-USD".to_owned(),
            BookState {
                asks: vec![level(6_400_100), level(6_400_200)],
                bids: vec![level(6_400_000), level(6_399_900)],
                spread: Some(Price(100)),
                imbalance_bps: 0,
                ts: 0,
            },
        );
        app
    }

    fn cursor(side: crate::hitmap::BookSide, index: usize) -> Option<BookCursor> {
        Some(BookCursor { side, index })
    }

    // Req 30.1
    #[test]
    fn book_keys_resolve_in_the_book_context() {
        let keymap = keymap();
        let chord = |code| chord_from_crossterm(&press(code, KeyModifiers::NONE)).unwrap();
        for (code, action) in [
            (KeyCode::Up, Action::BookUp),
            (KeyCode::Down, Action::BookDown),
            (KeyCode::Enter, Action::BookPrefill),
        ] {
            let resolved = resolve(&keymap, Context::Book, &chord(code));
            assert_eq!(resolved, Some(action));
            assert!(is_book_action(action));
        }
        assert!(!is_book_action(Action::ChartZoomIn));
    }

    #[test]
    fn arrows_move_the_cursor_and_enter_prefills_the_selected_price() {
        use crate::hitmap::BookSide::{Ask, Bid};
        use protocol::Price;
        let mut app = app_with_book();
        // Enter without a cursor does nothing.
        assert!(!apply_book_action(&mut app, Action::BookPrefill));
        assert_eq!(app.ticket.limit_price, None);
        // The first arrow selects the best ask.
        assert!(apply_book_action(&mut app, Action::BookDown));
        assert_eq!(app.book_cursor, cursor(Ask, 0));
        // Down crosses the spread to the best bid.
        assert!(apply_book_action(&mut app, Action::BookDown));
        assert_eq!(app.book_cursor, cursor(Bid, 0));
        assert!(apply_book_action(&mut app, Action::BookPrefill));
        assert_eq!(app.ticket.symbol, "BTC-USD");
        assert_eq!(app.ticket.limit_price, Some(Price(6_400_000)));
        // Up goes back to the best ask and the worse ask.
        assert!(apply_book_action(&mut app, Action::BookUp));
        assert!(apply_book_action(&mut app, Action::BookUp));
        assert_eq!(app.book_cursor, cursor(Ask, 1));
        // At the top the cursor stays and nothing changed.
        assert!(!apply_book_action(&mut app, Action::BookUp));
        assert!(apply_book_action(&mut app, Action::BookPrefill));
        assert_eq!(app.ticket.limit_price, Some(Price(6_400_200)));
        // Other actions are not for the book.
        assert!(!apply_book_action(&mut app, Action::ChartZoomIn));
    }

    #[test]
    fn book_actions_do_nothing_without_a_book() {
        let mut app = App::new("ws://x/ws");
        assert!(!apply_book_action(&mut app, Action::BookDown));
        assert_eq!(app.book_cursor, None);
    }

    // Req 30.1
    #[test]
    fn a_mouse_click_on_a_level_prefills_the_ticket_and_moves_the_cursor() {
        use crate::hitmap::BookSide::{Ask, Bid};
        use protocol::Price;
        let mut app = app_with_book();
        let (changed, messages) = apply_mouse_action(
            &mut app,
            MouseAction::PrefillBookLevel {
                side: Ask,
                index: 1,
            },
        );
        assert!(changed && messages.is_empty());
        assert_eq!(app.book_cursor, cursor(Ask, 1));
        assert_eq!(app.ticket.symbol, "BTC-USD");
        assert_eq!(app.ticket.limit_price, Some(Price(6_400_200)));
        // A level that is gone (the book shrank) changes nothing.
        let before = app.clone();
        let (changed, _) = apply_mouse_action(
            &mut app,
            MouseAction::PrefillBookLevel {
                side: Bid,
                index: 9,
            },
        );
        assert!(!changed);
        assert_eq!(app, before);
    }

    #[test]
    fn the_wheel_moves_the_book_cursor() {
        use crate::hitmap::BookSide::{Ask, Bid};
        let mut app = app_with_book();
        assert!(apply_mouse_action(&mut app, MouseAction::BookCursorDown).0);
        assert_eq!(app.book_cursor, cursor(Ask, 0));
        assert!(apply_mouse_action(&mut app, MouseAction::BookCursorDown).0);
        assert_eq!(app.book_cursor, cursor(Bid, 0));
        assert!(apply_mouse_action(&mut app, MouseAction::BookCursorUp).0);
        assert_eq!(app.book_cursor, cursor(Ask, 0));
    }

    // Req 26.3
    #[test]
    fn indicator_keys_resolve_and_toggle() {
        let keymap = keymap();
        let mut app = App::new("ws://x/ws");
        let before = app.toggles;
        for (key, action) in [
            ('e', Action::IndicatorEma),
            ('w', Action::IndicatorVwap),
            ('o', Action::IndicatorBollinger),
            ('r', Action::IndicatorRsi),
            ('t', Action::IndicatorAtr),
        ] {
            let chord = chord_from_crossterm(&press(KeyCode::Char(key), KeyModifiers::NONE));
            let resolved = chord.and_then(|c| resolve(&keymap, Context::Chart, &c));
            assert_eq!(resolved, Some(action), "key {key}");
            assert!(is_indicator_action(action));
            assert!(apply_indicator_action(&mut app, action));
        }
        // Every flag flipped from its default.
        let after = app.toggles;
        assert_eq!(
            (after.ema, after.vwap, after.bollinger, after.rsi, after.atr),
            (
                !before.ema,
                !before.vwap,
                !before.bollinger,
                !before.rsi,
                !before.atr
            )
        );
        // Toggling again restores it, and other actions change nothing.
        assert!(apply_indicator_action(&mut app, Action::IndicatorEma));
        assert_eq!(app.toggles.ema, before.ema);
        assert!(!apply_indicator_action(&mut app, Action::ChartZoomIn));
        assert!(!is_indicator_action(Action::ChartZoomIn));
    }

    #[test]
    fn clicking_a_toggle_flips_the_indicator() {
        let mut app = App::new("ws://x/ws");
        let was = app.toggles.bollinger;
        let (changed, messages) =
            apply_mouse_action(&mut app, MouseAction::ToggleIndicator(Indicator::Bollinger));
        assert!(changed && messages.is_empty());
        assert_eq!(app.toggles.bollinger, !was);
    }

    #[test]
    fn zoom_and_pan_actions_change_the_view_and_send_nothing() {
        let mut app = App::new("ws://x/ws");
        let before = app.chart_view.visible;
        let (changed, messages) = apply_chart_action(&mut app, Action::ChartZoomIn);
        assert!(changed && messages.is_empty());
        assert!(app.chart_view.visible < before);
        // Pan is limited by the (empty) data.
        apply_chart_action(&mut app, Action::ChartPanBack);
        assert_eq!(app.chart_view.offset_from_right, 0);
        let (changed, _) = apply_chart_action(&mut app, Action::AppQuit);
        assert!(!changed);
    }
}

#[cfg(test)]
mod order_routing_tests {
    use super::*;
    use crate::net::NetEvent;
    use protocol::client::{OrderPreview, PreviewAction, ServerMessage};
    use protocol::{OrderKind, Price, Qty, Side};

    fn preview_app() -> App {
        let mut app = App::new("ws://x/ws");
        app.account.command_sent("r1");
        app::update(
            &mut app,
            NetEvent::msg(ServerMessage::Preview {
                request_id: "r1".into(),
                preview: OrderPreview {
                    preview_id: "p1".into(),
                    text: "BUY BTC-USD 0.1".into(),
                    action: PreviewAction::Place {
                        symbol: "BTC-USD".into(),
                        venue: protocol::Venue::Replay,
                        side: Side::Buy,
                        qty: Qty(10_000_000),
                        kind: OrderKind::Market,
                    },
                    expires_at: 30_000,
                },
            }),
        );
        app
    }

    // Req 31.1: letters are text in the command bar, so `q` must not quit.
    #[test]
    fn quit_is_blocked_by_the_command_bar_and_by_dialogs() {
        let mut app = App::new("ws://x/ws");
        assert!(!order_input::blocks_global_keys(&app));
        app.focus = Focus::Command;
        assert!(order_input::blocks_global_keys(&app));
        app.focus = Focus::Orders;
        assert!(!order_input::blocks_global_keys(&app));
        assert!(order_input::blocks_global_keys(&preview_app()));
    }

    // Req 30.2: the keyboard flow is book price, then quantity.
    #[test]
    fn prefilling_from_the_book_hands_the_keys_to_the_ticket() {
        let mut app = App::new("ws://x/ws");
        app.apply_book(
            "BTC-USD".to_owned(),
            crate::book_model::BookState {
                asks: vec![protocol::Level {
                    price: Price(6_400_100),
                    qty: Qty(1),
                }],
                bids: Vec::new(),
                spread: None,
                imbalance_bps: 0,
                ts: 0,
            },
        );
        assert!(apply_book_action(&mut app, Action::BookDown));
        assert!(apply_book_action(&mut app, Action::BookPrefill));
        assert_eq!(app.ticket.limit_price, Some(Price(6_400_100)));
        assert_eq!(app.focus, Focus::Ticket);
    }

    // Req 22.2, 22.3: while a preview is open a click anywhere else does nothing.
    #[test]
    fn a_dialog_takes_the_mouse_and_its_buttons_send() {
        let mut app = preview_app();
        let (changed, messages) = apply_mouse_action(&mut app, MouseAction::ZoomIn);
        assert!(!changed && messages.is_empty());
        let (changed, messages) = apply_mouse_action(&mut app, MouseAction::DialogConfirm);
        assert!(changed);
        assert!(matches!(
            messages.as_slice(),
            [ClientMessage::Confirm { preview_id, .. }] if preview_id == "p1"
        ));
        // Without a dialog the chart actions work again.
        let (changed, _) = apply_mouse_action(&mut app, MouseAction::ZoomIn);
        assert!(changed);
    }

    #[test]
    fn the_cross_of_an_order_row_sends_a_cancel() {
        let mut app = App::new("ws://x/ws");
        let (changed, messages) =
            apply_mouse_action(&mut app, MouseAction::CancelOrder("o-1".into()));
        assert!(changed);
        assert!(matches!(
            messages.as_slice(),
            [ClientMessage::Cancel { order_id, .. }] if order_id.as_str() == "o-1"
        ));
    }

    #[test]
    fn the_wall_clock_is_after_2020() {
        assert!(wall_ms() > 1_577_836_800_000);
    }
}
