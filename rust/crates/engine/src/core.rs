//! Engine state machine: turns Commands and market data into Events. Pure: no I/O and no
//! wall-clock reads, so replay stays deterministic. The runtime owns the only instance and does
//! all I/O, including loading replay fixtures for `start_replay`.
//!
//! Candles (design §2 "Candle_Builder", Req 8.7, 8.8):
//! - The [`CandleBuilder`] builds bars for every symbol that trades, whether or not anyone is
//!   subscribed, so a later subscription gets history.
//! - `subscribe` adds the (symbol, timeframe) key and answers at once with
//!   `Candle { snapshot: true }` carrying up to 500 bars, oldest first, or no bars if the key has
//!   none yet. Every `subscribe` sends a snapshot, including a repeat for a key that is already
//!   subscribed (the server resends subscriptions after an engine restart).
//! - `unsubscribe` removes the key. A later `subscribe` sends a fresh snapshot.
//! - A trade emits its `Trade` Event first, then one `Candle { snapshot: false, bars: [bar] }`
//!   per subscribed key of that symbol whose bar changed, in [`Timeframe::ALL`] order. The bar
//!   is usually the current one; an out-of-order trade changes an older bar, which clients
//!   replace by its `t`. A trade the builder drops produces only the `Trade` Event.
//!
//! Indicators (Req 10.1, 10.2): the engine feeds every changed bar into the
//! [`SymbolIndicators`] of its (symbol, timeframe), subscribed or not, so a later `subscribe`
//! has state. For a subscribed key, `Indicators` follows that key's `Candle` event, so one
//! trade yields: Trade, then Candle, Indicators per timeframe in [`Timeframe::ALL`] order, then
//! Book if due. A late bar (older than the key's newest bar) is not fed in: committed state is
//! never rewritten, its Candle event is still sent, and no Indicators event follows. `subscribe`
//! answers with the snapshot and then one `Indicators` event (ts = start of the newest bar)
//! when the key has at least one bar, and with only the empty snapshot otherwise.
//!
//! Order book (Req 9): every market message of a symbol ends with a "Book if due" check. A
//! dirty book is emitted when market time is at least 100 ms past the last Book event of that
//! symbol (or none was sent yet), so one Book event is the last event of the call, after Trade
//! and Candle events. A negative delta yields an `invalid_book_delta` Error and no state change.
//!
//! Because snapshots are emitted synchronously from `on_command` and live updates only from
//! later `on_market` calls, a key's snapshot always precedes its live updates.
//!
//! Event order on subscribe, warm-up, and backfill:
//! - `subscribe` answers with the key's snapshot, then one `Indicators` event for the newest
//!   bar (see above). In backfill mode (live only, [`Engine::with_backfill`]) the first
//!   `subscribe` of a key also queues one [`HistoryRequest`] and marks the key `InFlight`; the
//!   snapshot it returns holds the live bars only.
//! - `warm_up` (replay only) emits nothing per message. It returns one snapshot per subscribed
//!   key, then `Position` refreshes. It never touches the backfill state, and `Engine::new()`
//!   never builds history requests.
//! - `on_history` (live only) is a plain method call by the runtime, never a Command. For an
//!   `InFlight` key it merges the venue bars older than the live bars, marks the key `Done`,
//!   rebuilds the key's indicators from the merged ring, and, if the ring changed and the key
//!   is subscribed, returns a fresh snapshot (the same events `subscribe` returns). Any other
//!   state is a no-op. `on_history_failed` clears an `InFlight` key, so a later `subscribe`
//!   retries, and returns one `feed_disconnected` Error. Each key requests at most once per run
//!   unless a request failed.

use std::collections::btree_map::Entry;
use std::collections::{BTreeMap, BTreeSet};

use protocol::{
    AccountId, Bar, Command, DecodeError, ErrorCode, Event, INSTRUMENTS, Money,
    OrderKind, OrderStatus, Price, Qty, Side, TimeMs, Timeframe, Venue, instrument,
};
use tracing::debug;

use crate::account::{AccountError, Accounts, DEFAULT_ACCOUNT_CAP, PaperAccount};
use crate::balance::BalanceConfig;
use crate::book::OrderBook;
use crate::candles::CandleBuilder;
use crate::feed::MarketMsg;
use crate::indicators::SymbolIndicators;
use crate::matcher::{MatchOutput, Matcher, PlaceRequest};
use crate::ticker::{self, TickerThrottle};

/// Characters of an unknown symbol echoed in an error.
const MAX_SYMBOL_ECHO: usize = 64;

/// Levels per side in a Book event (Req 9.6).
const BOOK_LEVELS: usize = 20;
/// Minimum market time between two Book events of one symbol, in ms (Req 9.7).
const BOOK_INTERVAL_MS: TimeMs = 100;

/// One symbol's book and its throttle state.
#[derive(Debug, Default)]
struct BookState {
    book: OrderBook,
    /// Market time of the last emitted Book event.
    last_emit_ts: Option<TimeMs>,
    /// The book changed since the last emitted Book event.
    dirty: bool,
}

/// Characters of a backfill failure reason kept in the Error message.
const MAX_REASON_CHARS: usize = 200;

/// Backfill progress of one (symbol, timeframe) key. An absent key has no state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BackfillState {
    /// A request was queued and no result has arrived.
    InFlight,
    /// The history was merged; the key never requests again in this run.
    Done,
}

/// A request for the runtime to fetch recent public candles of one key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryRequest {
    pub symbol: String,
    pub timeframe: Timeframe,
}

/// Engine state.
#[derive(Debug, Default)]
pub struct Engine {
    /// Backfill state per key. `None` outside backfill mode (replay), where no request is built.
    backfill: Option<BTreeMap<(String, Timeframe), BackfillState>>,
    /// Requests queued by `subscribe`, drained by [`Engine::take_history_requests`].
    history_requests: Vec<HistoryRequest>,
    /// Paper_Accounts, created on the first `PlaceOrder` of each account (Req 14.1, 14.4).
    /// Every matcher fill goes to its account, followed by a `Position` event (Req 13.4), and a
    /// changed last trade price refreshes the unrealized P&L.
    accounts: Accounts,
    candles: CandleBuilder,
    /// Indicators per (symbol, timeframe), kept for every key that has traded.
    indicators: BTreeMap<(String, Timeframe), SymbolIndicators>,
    books: BTreeMap<String, BookState>,
    /// Subscribed timeframes per symbol. A symbol with no timeframes left is removed.
    subscriptions: BTreeMap<String, BTreeSet<Timeframe>>,
    /// Paper matcher (Req 11, 12). Matching events follow the market events of a message.
    matcher: Matcher,
    /// Last trade price per symbol, for stop orders (Req 11.5).
    last_price: BTreeMap<String, Price>,
    /// Market time of the latest market message; the time stamp of fills of a new order.
    now: TimeMs,
    /// Equity in the last `Balance` event of each account, to throttle equity-only updates.
    last_equity: BTreeMap<AccountId, i64>,
    /// Symbols with an active ticker subscription (Req 18.3).
    ticker_subs: BTreeSet<String>,
    /// One Ticker24h per symbol per second of market time (Req 18.4).
    ticker_throttle: TickerThrottle,
    /// The venue of the market data this engine runs on, stamped on every event: `Replay` in
    /// replay mode, the configured live venue in live mode. The per-venue pairs of task 5
    /// replace it.
    venue: Venue,
}

impl Engine {
    pub fn new() -> Self {
        Self::default()
    }

    /// The same engine with `venue` as its market venue (stamped on every event).
    pub fn with_venue(mut self, venue: Venue) -> Self {
        self.venue = venue;
        self.matcher = std::mem::take(&mut self.matcher).with_venue(venue);
        self
    }

    /// The same engine with the paper balance settings `config`: new accounts start with its
    /// Starting_Balance and the matcher charges its fee rate (Req 16.1, 16.2).
    pub fn with_balance(mut self, config: BalanceConfig) -> Self {
        self.accounts = Accounts::with_config(DEFAULT_ACCOUNT_CAP, config);
        self.matcher = Matcher::new(config.fee_bps).with_venue(self.venue);
        self
    }

    /// An engine for live mode: the first `subscribe` of each key queues a history request.
    pub fn with_backfill() -> Self {
        Self {
            backfill: Some(BTreeMap::new()),
            ..Self::default()
        }
    }

    /// Drains the queued history requests, oldest first.
    pub fn take_history_requests(&mut self) -> Vec<HistoryRequest> {
        std::mem::take(&mut self.history_requests)
    }

    /// Takes the venue history of an `InFlight` key (design D1, D2). Any other state is a no-op.
    ///
    /// Merges the bars older than the live bars, marks the key `Done`, and, if the ring
    /// changed, rebuilds the key's indicators from the merged ring. Returns the key's snapshot
    /// events when the ring changed and the key is subscribed, otherwise nothing.
    pub fn on_history(&mut self, symbol: &str, timeframe: Timeframe, bars: &[Bar]) -> Vec<Event> {
        let key = (symbol.to_owned(), timeframe);
        let Some(state) = self.backfill.as_mut().and_then(|s| s.get_mut(&key)) else {
            return Vec::new();
        };
        if *state != BackfillState::InFlight {
            return Vec::new();
        }
        *state = BackfillState::Done;
        // No market message yet means `now` is still 0, which is never a real market time.
        let market_now = (self.now != 0).then_some(self.now);
        let merge = self
            .candles
            .merge_history(symbol, timeframe, bars, market_now);
        debug!(
            symbol,
            %timeframe,
            added = merge.added,
            invalid = merge.invalid,
            "candle history merged"
        );
        if !merge.changed {
            return Vec::new();
        }
        let ring = self.candles.bars(symbol, timeframe);
        self.indicators
            .insert(key, SymbolIndicators::from_bars(&ring));
        let subscribed = self
            .subscriptions
            .get(symbol)
            .is_some_and(|tfs| tfs.contains(&timeframe));
        if subscribed {
            self.snapshot_events(symbol, timeframe)
        } else {
            Vec::new()
        }
    }

    /// Reports a failed fetch. An `InFlight` key is cleared so the next `subscribe` retries; a
    /// `Done` key keeps its state. Returns one `feed_disconnected` Error naming the key, with
    /// the reason cut to 200 characters. The live bars are untouched.
    pub fn on_history_failed(
        &mut self,
        symbol: &str,
        timeframe: Timeframe,
        reason: &str,
    ) -> Vec<Event> {
        if let Some(states) = self.backfill.as_mut() {
            let key = (symbol.to_owned(), timeframe);
            if states.get(&key) == Some(&BackfillState::InFlight) {
                states.remove(&key);
            }
        }
        let reason: String = reason.chars().take(MAX_REASON_CHARS).collect();
        vec![Event::Error {
            code: ErrorCode::FeedDisconnected,
            message: format!(
                "candle backfill for {} {timeframe} failed: {reason}",
                echo_symbol(symbol)
            ),
        }]
    }

    /// An engine whose Paper_Account cap is `cap` instead of 1,000 (for tests, Req 14.5).
    #[cfg(test)]
    pub fn with_account_cap(cap: usize) -> Self {
        Self {
            accounts: Accounts::new(cap),
            ..Self::default()
        }
    }

    /// Handles one validated Command and returns the Events it produces, in order.
    ///
    /// `start_replay` never reaches the core: the runtime handles it, because it reads a file.
    pub fn on_command(&mut self, cmd: Command) -> Vec<Event> {
        match cmd {
            // Req 1.6: answer a ping with a pong that carries the same id.
            Command::Ping { id } => vec![Event::Pong { id }],
            // The command's `venue` is ignored until the per-venue pairs of task 5: the engine
            // has one market venue.
            Command::SubscribeTicker { symbol, .. } => self.subscribe_ticker(symbol),
            Command::UnsubscribeTicker { symbol, .. } => self.unsubscribe_ticker(&symbol),
            Command::Subscribe {
                symbol, timeframe, ..
            } => self.subscribe(symbol, timeframe),
            Command::Unsubscribe {
                symbol, timeframe, ..
            } => self.unsubscribe(&symbol, timeframe),
            Command::PlaceOrder {
                account_id,
                order_id,
                symbol,
                side,
                qty,
                kind,
                ..
            } => {
                // Req 14.4, 14.5: the account is created flat on its first order; a new account
                // over the cap gets `account_limit` and no order is placed.
                if self.accounts.get_or_create(&account_id).is_err() {
                    return vec![Event::OrderRejected {
                        account_id,
                        venue: self.venue,
                        order_id,
                        reason: "account_limit".to_owned(),
                    }];
                }
                let empty = OrderBook::new();
                let book = self.books.get(&symbol).map_or(&empty, |s| &s.book);
                let last = self.last_price.get(&symbol).copied();
                // Req 16.4: refuse an order the account cannot pay for, before any state change.
                let reference = reference_price(book, side, &kind, last);
                if let (Some(reference), Some(account)) =
                    (reference, self.accounts.get(&account_id))
                    && !affordable(account, &symbol, side, qty, reference)
                {
                    return vec![Event::OrderRejected {
                        account_id,
                        venue: self.venue,
                        order_id,
                        reason: "insufficient_balance".to_owned(),
                    }];
                }
                let req = PlaceRequest {
                    account_id: account_id.clone(),
                    order_id: order_id.clone(),
                    symbol: symbol.clone(),
                    side,
                    qty,
                    kind,
                };
                let out = self.matcher.place(req, book, last, self.now);
                let rejected = out
                    .events
                    .iter()
                    .any(|e| matches!(e, Event::OrderRejected { .. }));
                let mut reserved = false;
                if !rejected
                    && let (Some(reference), Some(account)) =
                        (reference, self.accounts.get_mut(&account_id))
                {
                    reserved = account
                        .reserve_order(&order_id, &symbol, side, qty, reference)
                        .is_ok();
                }
                let (mut events, touched) = self.take_output(out);
                if reserved && !touched.contains(&account_id) {
                    self.push_balance(&account_id, &mut events);
                }
                events
            }
            Command::Cancel {
                account_id,
                order_id,
            } => {
                let mut events = self.matcher.cancel(&account_id, &order_id);
                self.release_canceled(&account_id, &mut events);
                events
            }
            Command::CancelAll { account_id } => {
                let mut events = self.matcher.cancel_all(&account_id);
                self.release_canceled(&account_id, &mut events);
                events
            }
            Command::ResetAccount { account_id } => self.reset_account(&account_id),
            other => {
                debug!(command = ?other, "command not handled yet");
                Vec::new()
            }
        }
    }

    /// Cancels the account's orders, flattens its positions, and emits a flat `Position` for
    /// every symbol (Req 14.3). Other accounts are untouched (Req 14.5). An account that does not
    /// exist yet gets the same events and is not created (Req 14.4).
    fn reset_account(&mut self, account_id: &AccountId) -> Vec<Event> {
        let mut events = self.matcher.cancel_all(account_id);
        if let Some(account) = self.accounts.get_mut(account_id) {
            account.reset();
        }
        let flat = PaperAccount::default();
        let account = self.accounts.get(account_id).unwrap_or(&flat);
        for inst in INSTRUMENTS {
            let last = self.last_price.get(inst.symbol).copied();
            events.push(position_or_error(account, account_id, inst.symbol, last));
        }
        // Req 16.1: the balance is back at the Starting_Balance.
        self.push_balance(account_id, &mut events);
        events
    }

    /// Releases the reservations of the orders that `events` report as canceled and, if any
    /// was held, appends the account's new `Balance` (free balance changed).
    fn release_canceled(&mut self, account_id: &AccountId, events: &mut Vec<Event>) {
        let Some(account) = self.accounts.get_mut(account_id) else {
            return;
        };
        let mut released = false;
        for event in events.iter() {
            if let Event::OrderAck {
                order_id,
                status: OrderStatus::Canceled,
                ..
            } = event
            {
                released |= account.release_order(order_id);
            }
        }
        if released {
            self.push_balance(account_id, events);
        }
    }

    /// Appends the account's `Balance` event and remembers its equity (Req 16.9).
    fn push_balance(&mut self, account_id: &AccountId, events: &mut Vec<Event>) {
        let Some(account) = self.accounts.get(account_id) else {
            return;
        };
        match balance_event(account, account_id, &self.last_price, self.now) {
            Ok(event) => {
                if let Event::Balance { equity, .. } = &event {
                    self.last_equity.insert(account_id.clone(), equity.0);
                }
                events.push(event);
            }
            Err(err) => events.push(internal_error(err)),
        }
    }

    /// Applies the fills of one matcher call to their accounts and returns the call's events
    /// followed by one `Position` per distinct (account, symbol), in the order of each pair's
    /// last fill, plus the accounts those events cover. A fill that cannot be applied (overflow)
    /// leaves its account unchanged and yields an `Error` event instead.
    fn take_output(&mut self, out: MatchOutput) -> (Vec<Event>, BTreeSet<AccountId>) {
        let MatchOutput { mut events, fills } = out;
        let mut last_fill: BTreeMap<(AccountId, String), usize> = BTreeMap::new();
        let mut errors: Vec<Event> = Vec::new();
        for (i, fill) in fills.iter().enumerate() {
            let result = match self.accounts.get_mut(&fill.account_id) {
                Some(account) => account.apply_fill(fill),
                None => Err(AccountError::InvalidFill),
            };
            match result {
                Ok(()) => {
                    last_fill.insert((fill.account_id.clone(), fill.symbol.clone()), i);
                }
                Err(err) => errors.push(internal_error(err)),
            }
        }
        events.extend(errors);
        let mut touched = BTreeSet::new();
        let mut ordered: Vec<((AccountId, String), usize)> = last_fill.into_iter().collect();
        ordered.sort_by_key(|(_, index)| *index);
        for ((account_id, symbol), _) in ordered {
            let last = self.last_price.get(&symbol).copied();
            if let Some(account) = self.accounts.get(&account_id) {
                events.push(position_or_error(account, &account_id, &symbol, last));
            }
            touched.insert(account_id);
        }
        // Req 16.9: a fill moves the balance; one `Balance` per account after its positions.
        for account_id in &touched {
            self.push_balance(account_id, &mut events);
        }
        (events, touched)
    }

    /// Runs a matching pass for `symbol` and appends its events after the market events.
    /// Returns the accounts that got a `Position` event from the pass.
    fn run_matcher(
        &mut self,
        symbol: &str,
        ts: TimeMs,
        events: &mut Vec<Event>,
    ) -> BTreeSet<AccountId> {
        let empty = OrderBook::new();
        let book = self.books.get(symbol).map_or(&empty, |s| &s.book);
        let last = self.last_price.get(symbol).copied();
        let out = self.matcher.on_market(symbol, book, last, ts);
        let (matched, touched) = self.take_output(out);
        events.extend(matched);
        touched
    }

    /// After a changed last trade price: a `Position` with the refreshed unrealized P&L for
    /// every account with an open position in `symbol`, in `AccountId` order (Req 13.3, 13.4).
    /// Accounts in `skip` already got a `Position` from this call's matching pass.
    fn refresh_unrealized(
        &mut self,
        symbol: &str,
        skip: &BTreeSet<AccountId>,
        events: &mut Vec<Event>,
    ) {
        let last = self.last_price.get(symbol).copied();
        let mut moved: Vec<AccountId> = Vec::new();
        for (id, account) in self.accounts.iter() {
            if skip.contains(id) || !account.is_open(symbol) {
                continue;
            }
            events.push(position_or_error(account, id, symbol, last));
            // Req 16.9: Equity moved by at least 0.01 USD since the last `Balance`.
            let equity = account
                .equity(|s| self.last_price.get(s).copied())
                .ok()
                .and_then(|e| i64::try_from(e).ok());
            let due = match (equity, self.last_equity.get(id)) {
                (Some(now), Some(prev)) => now.abs_diff(*prev) >= EQUITY_STEP,
                (Some(_), None) => true,
                (None, _) => false,
            };
            if due {
                moved.push(id.clone());
            }
        }
        for id in &moved {
            self.push_balance(id, events);
        }
    }

    /// Handles one market data message from the feed and returns the Events it produces.
    pub fn on_market(&mut self, msg: MarketMsg) -> Vec<Event> {
        match msg {
            MarketMsg::Trade {
                symbol,
                price,
                qty,
                side,
                ts,
            } => {
                let book_symbol = symbol.clone();
                self.now = ts;
                let price_changed = self.last_price.insert(symbol.clone(), price) != Some(price);
                // Req 8.1–8.3: every trade updates the candles of its symbol.
                let changed = self.candles.on_trade(&symbol, price, qty, ts);
                if changed.is_empty() {
                    let dropped = self.candles.dropped();
                    debug!(
                        symbol = %symbol,
                        ts,
                        dropped_total = dropped.total(),
                        ?dropped,
                        "trade not applied to candles"
                    );
                }
                // Req 8.8: live updates only for subscribed keys, in Timeframe::ALL order.
                // Req 10.1, 10.2: indicators update for every key; subscribed keys also get an
                // Indicators event right after their Candle event.
                let mut updates: Vec<Event> = Vec::new();
                for (timeframe, bar) in changed {
                    let values = self
                        .indicators
                        .entry((symbol.clone(), timeframe))
                        .or_default()
                        .update(&bar);
                    let is_subscribed = self
                        .subscriptions
                        .get(&symbol)
                        .is_some_and(|tfs| tfs.contains(&timeframe));
                    if !is_subscribed {
                        continue;
                    }
                    updates.push(Event::Candle {
                        venue: self.venue,
                        symbol: symbol.clone(),
                        timeframe,
                        snapshot: false,
                        bars: vec![bar],
                        indicators: None,
                    });
                    if let Some(values) = values {
                        updates.push(Event::Indicators {
                            venue: self.venue,
                            symbol: symbol.clone(),
                            timeframe,
                            ts: bar.t,
                            values,
                        });
                    }
                }
                let mut events = Vec::with_capacity(1 + updates.len());
                // Req 9.8: every trade is forwarded with symbol, price, qty, aggressor side,
                // time, before the candle updates it caused.
                events.push(Event::Trade {
                    venue: self.venue,
                    symbol,
                    price,
                    qty,
                    side,
                    synthetic: false,
                    ts,
                });
                events.extend(updates);
                // Req 18.4: a subscribed symbol's ticker follows its trade, at most 1 per second.
                if self.ticker_subs.contains(&book_symbol)
                    && let Some(event) = self.ticker_event(&book_symbol)
                    && self.ticker_throttle.take(&book_symbol, ts)
                {
                    events.push(event);
                }
                self.book_if_due(&book_symbol, ts, &mut events);
                // Req 11.5: a trade may trigger stops; matching events come last.
                let touched = self.run_matcher(&book_symbol, ts, &mut events);
                // Req 13.3: a changed last price refreshes the unrealized P&L; these Position
                // events come after everything else.
                if price_changed {
                    self.refresh_unrealized(&book_symbol, &touched, &mut events);
                }
                events
            }
            MarketMsg::BookSnapshot {
                symbol,
                bids,
                asks,
                ts,
            } => {
                let state = self.books.entry(symbol.clone()).or_default();
                state.book.apply_snapshot(&bids, &asks);
                state.dirty = true;
                self.now = ts;
                let mut events = Vec::new();
                self.book_if_due(&symbol, ts, &mut events);
                self.run_matcher(&symbol, ts, &mut events);
                events
            }
            MarketMsg::BookDelta {
                symbol,
                side,
                price,
                qty,
                ts,
            } => {
                let state = self.books.entry(symbol.clone()).or_default();
                let mut events = Vec::new();
                self.now = ts;
                let mut applied = false;
                match state.book.apply_delta(side, price, qty) {
                    Ok(()) => {
                        state.dirty = true;
                        applied = true;
                    }
                    // Req 9.4: discard the delta and report it; the book is unchanged.
                    Err(err) => events.push(Event::Error {
                        code: ErrorCode::InvalidBookDelta,
                        message: format!(
                            "book delta for {} discarded: {err}",
                            echo_symbol(&symbol)
                        ),
                    }),
                }
                self.book_if_due(&symbol, ts, &mut events);
                if applied {
                    self.run_matcher(&symbol, ts, &mut events);
                }
                events
            }
        }
    }

    /// Emits the symbol's book when it is dirty and its 100 ms market-time window has passed
    /// (Req 9.7). Runs after every market message of the symbol, so a book that missed its
    /// window goes out with the next message after the window, of any kind.
    fn book_if_due(&mut self, symbol: &str, ts: TimeMs, events: &mut Vec<Event>) {
        let Some(state) = self.books.get_mut(symbol) else {
            return;
        };
        if !state.dirty {
            return;
        }
        let due = state
            .last_emit_ts
            .is_none_or(|last| ts.saturating_sub(last) >= BOOK_INTERVAL_MS);
        if !due {
            return;
        }
        let (bids, asks) = state.book.top(BOOK_LEVELS);
        events.push(Event::Book {
            venue: self.venue,
            symbol: symbol.to_owned(),
            bids,
            asks,
            spread: state.book.spread(),
            imbalance_bps: state.book.imbalance_bps(BOOK_LEVELS),
            synthetic: false,
            ts,
        });
        state.last_emit_ts = Some(ts);
        state.dirty = false;
    }

    /// Adds the key and returns its snapshot (Req 8.7).
    fn subscribe(&mut self, symbol: String, timeframe: Timeframe) -> Vec<Event> {
        // The codec already refuses unknown symbols; checked again so the core never relies
        // on its caller (Req 4.2).
        if instrument(&symbol).is_none() {
            return vec![unknown_symbol(&symbol)];
        }
        self.subscriptions
            .entry(symbol.clone())
            .or_default()
            .insert(timeframe);
        // Backfill mode only: one request per key until it succeeds or fails.
        if let Some(states) = self.backfill.as_mut()
            && let Entry::Vacant(slot) = states.entry((symbol.clone(), timeframe))
        {
            slot.insert(BackfillState::InFlight);
            self.history_requests.push(HistoryRequest {
                symbol: symbol.clone(),
                timeframe,
            });
        }
        self.snapshot_events(&symbol, timeframe)
    }

    /// The answer for one key: `Candle { snapshot: true }` with up to 500 bars, then one
    /// `Indicators` event for the newest bar when the key has any (Req 8.7, 10.2). Shared by
    /// `subscribe` and `warm_up`.
    fn snapshot_events(&self, symbol: &str, timeframe: Timeframe) -> Vec<Event> {
        let bars = self.candles.bars(symbol, timeframe);
        let current = self
            .indicators
            .get(&(symbol.to_owned(), timeframe))
            .and_then(SymbolIndicators::current);
        let indicators = self
            .indicators
            .get(&(symbol.to_owned(), timeframe))
            .map(|state| {
                // Merge-join: both sides are ascending by `t`.
                let mut points = Vec::with_capacity(bars.len());
                let mut history = state.history().iter().peekable();
                for bar in &bars {
                    while history.next_if(|p| p.t < bar.t).is_some() {}
                    if let Some(point) = history.next_if(|p| p.t == bar.t) {
                        points.push(*point);
                    }
                }
                points
            })
            .unwrap_or_default();
        let mut events = vec![Event::Candle {
            venue: self.venue,
            symbol: symbol.to_owned(),
            timeframe,
            snapshot: true,
            bars,
            indicators: Some(indicators),
        }];
        if let Some((ts, values)) = current {
            events.push(Event::Indicators {
                venue: self.venue,
                symbol: symbol.to_owned(),
                timeframe,
                ts,
                values,
            });
        }
        events
    }

    /// Applies replay warm-up messages (the old part of a fixture) to the state at once, with
    /// no per-message output (Req 2.3, 2.4).
    ///
    /// The result equals playing the messages through `on_market`, except: no Trade, Book,
    /// live Candle, live Indicators, or matcher events are produced (open orders do not fill
    /// during warm-up), books are only marked dirty so each symbol's next message emits its
    /// Book, and an invalid book delta is counted and logged at debug, with no Error event.
    ///
    /// With no messages it returns nothing. Otherwise it returns a snapshot for every
    /// subscribed key (symbol order, then timeframe order), then a `Position` refresh for every
    /// account with an open position in a symbol whose last price changed.
    pub fn warm_up(&mut self, msgs: Vec<MarketMsg>) -> Vec<Event> {
        if msgs.is_empty() {
            return Vec::new();
        }
        let before = self.last_price.clone();
        let mut invalid_deltas: u64 = 0;
        for msg in msgs {
            match msg {
                MarketMsg::Trade {
                    symbol,
                    price,
                    qty,
                    ts,
                    ..
                } => {
                    self.now = ts;
                    self.last_price.insert(symbol.clone(), price);
                    for (timeframe, bar) in self.candles.on_trade(&symbol, price, qty, ts) {
                        self.indicators
                            .entry((symbol.clone(), timeframe))
                            .or_default()
                            .update(&bar);
                    }
                }
                MarketMsg::BookSnapshot {
                    symbol,
                    bids,
                    asks,
                    ts,
                } => {
                    self.now = ts;
                    let state = self.books.entry(symbol).or_default();
                    state.book.apply_snapshot(&bids, &asks);
                    state.dirty = true;
                }
                MarketMsg::BookDelta {
                    symbol,
                    side,
                    price,
                    qty,
                    ts,
                } => {
                    self.now = ts;
                    let state = self.books.entry(symbol).or_default();
                    if state.book.apply_delta(side, price, qty).is_ok() {
                        state.dirty = true;
                    } else {
                        invalid_deltas = invalid_deltas.saturating_add(1);
                    }
                }
            }
        }
        if invalid_deltas > 0 {
            debug!(invalid_deltas, "warm-up discarded invalid book deltas");
        }
        let mut events = Vec::new();
        for (symbol, timeframes) in &self.subscriptions {
            for &timeframe in timeframes {
                events.extend(self.snapshot_events(symbol, timeframe));
            }
        }
        let changed: Vec<String> = self
            .last_price
            .iter()
            .filter(|(symbol, price)| before.get(*symbol) != Some(*price))
            .map(|(symbol, _)| symbol.clone())
            .collect();
        let none = BTreeSet::new();
        for symbol in changed {
            self.refresh_unrealized(&symbol, &none, &mut events);
        }
        events
    }

    /// The symbol's Ticker24h from its 1h series, stamped with the latest market time.
    fn ticker_event(&self, symbol: &str) -> Option<Event> {
        let bars = self.candles.bars(symbol, Timeframe::H1);
        let stats = ticker::compute(&bars)?;
        Some(Event::Ticker24h {
            symbol: symbol.to_owned(),
            venue: self.venue,
            ticker: stats.ticker,
            synthetic: false,
            ts: self.now,
        })
    }

    /// Adds the ticker subscription and answers at once if the symbol has hourly bars
    /// (Req 18.3). A repeat subscribe answers again.
    fn subscribe_ticker(&mut self, symbol: String) -> Vec<Event> {
        if instrument(&symbol).is_none() {
            return vec![unknown_symbol(&symbol)];
        }
        let event = self.ticker_event(&symbol);
        self.ticker_throttle.reset(&symbol);
        if event.is_some() {
            self.ticker_throttle.take(&symbol, self.now);
        }
        self.ticker_subs.insert(symbol);
        event.into_iter().collect()
    }

    /// Stops the ticker stream and resets its throttle. Emits nothing.
    fn unsubscribe_ticker(&mut self, symbol: &str) -> Vec<Event> {
        if instrument(symbol).is_none() {
            return vec![unknown_symbol(symbol)];
        }
        self.ticker_subs.remove(symbol);
        self.ticker_throttle.reset(symbol);
        Vec::new()
    }

    /// Removes the key. Emits nothing, also for a key that was not subscribed.
    fn unsubscribe(&mut self, symbol: &str, timeframe: Timeframe) -> Vec<Event> {
        if instrument(symbol).is_none() {
            return vec![unknown_symbol(symbol)];
        }
        if let Some(tfs) = self.subscriptions.get_mut(symbol) {
            tfs.remove(&timeframe);
            if tfs.is_empty() {
                self.subscriptions.remove(symbol);
            }
        }
        Vec::new()
    }
}

/// Equity move that triggers a `Balance` event: 0.01 USD in Money units (Req 16.9).
const EQUITY_STEP: u64 = 100_000_000;

/// The price an order is expected to fill near, for Required_Funds: the limit price, the stop
/// price, or for a market order the best opposite level (else the last trade). `None` when
/// nothing is known, in which case the order cannot fill yet.
fn reference_price(
    book: &OrderBook,
    side: Side,
    kind: &OrderKind,
    last: Option<Price>,
) -> Option<Price> {
    match kind {
        OrderKind::Limit { price } => Some(*price),
        OrderKind::Stop { stop_price } => Some(*stop_price),
        OrderKind::Market => {
            let best = match side {
                Side::Buy => book.best_ask(),
                Side::Sell => book.best_bid(),
            };
            best.or(last)
        }
    }
}

/// True when the account's Free_Balance covers the order's Required_Funds (Req 16.4). Input the
/// matcher rejects on its own (bad quantity, price, or symbol) passes here; any overflow fails.
fn affordable(
    account: &PaperAccount,
    symbol: &str,
    side: Side,
    qty: Qty,
    reference: Price,
) -> bool {
    match account.required_funds(symbol, side, qty, reference) {
        Ok(required) => account
            .free_balance()
            .ok()
            .and_then(|free| free.checked_sub(required))
            .is_some_and(|left| left >= 0),
        Err(AccountError::InvalidFill | AccountError::UnknownSymbol) => true,
        Err(AccountError::Overflow) => false,
    }
}

/// The account's `Balance` event at market time `ts`.
fn balance_event(
    account: &PaperAccount,
    account_id: &AccountId,
    last_price: &BTreeMap<String, Price>,
    ts: TimeMs,
) -> Result<Event, AccountError> {
    let money = |v: i128| {
        i64::try_from(v)
            .map(Money)
            .map_err(|_| AccountError::Overflow)
    };
    Ok(Event::Balance {
        account_id: account_id.clone(),
        paper_balance: money(account.paper_balance())?,
        free_balance: money(account.free_balance()?)?,
        equity: money(account.equity(|s| last_price.get(s).copied())?)?,
        ts,
    })
}

/// An `Error` event for a Paper_Account failure (overflow).
fn internal_error(err: AccountError) -> Event {
    Event::Error {
        code: ErrorCode::Internal,
        message: format!("paper account: {err}"),
    }
}

/// The account's `Position` event for `symbol`, or an `Error` event if its P&L overflows.
fn position_or_error(
    account: &PaperAccount,
    account_id: &AccountId,
    symbol: &str,
    last: Option<Price>,
) -> Event {
    account
        .position_event(account_id, symbol, last)
        .unwrap_or_else(internal_error)
}

fn echo_symbol(symbol: &str) -> String {
    let mut echo: String = symbol.chars().take(MAX_SYMBOL_ECHO).collect();
    if echo.len() < symbol.len() {
        echo.push('…');
    }
    echo
}

fn unknown_symbol(symbol: &str) -> Event {
    DecodeError::UnknownSymbol(echo_symbol(symbol)).to_event()
}

/// Property test P7 (Task 4.5).
#[cfg(test)]
mod properties;

/// Property test P28 and account unit tests (Task 10.4).
#[cfg(test)]
#[path = "core_accounts_properties.rs"]
mod account_properties;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::candles::MAX_BARS;
    use crate::feed::synth::{SynthConfig, SynthSymbol, synth};
    use protocol::{
        AccountId, Bar, ErrorCode, Level, OrderId, OrderKind, Price, Qty, Side, TimeMs,
    };

    const MIN: TimeMs = 60_000;
    const BTC: &str = "BTC-USD";
    const ETH: &str = "ETH-USD";

    fn subscribe(symbol: &str, timeframe: Timeframe) -> Command {
        Command::Subscribe {
            venue: Venue::Replay,
            symbol: symbol.into(),
            timeframe,
        }
    }

    fn unsubscribe(symbol: &str, timeframe: Timeframe) -> Command {
        Command::Unsubscribe {
            venue: Venue::Replay,
            symbol: symbol.into(),
            timeframe,
        }
    }

    fn trade_msg(symbol: &str, price: i64, qty: i64, ts: TimeMs) -> MarketMsg {
        MarketMsg::Trade {
            symbol: symbol.into(),
            price: Price(price),
            qty: Qty(qty),
            side: Side::Buy,
            ts,
        }
    }

    fn trade_event(symbol: &str, price: i64, qty: i64, ts: TimeMs) -> Event {
        Event::Trade {
            venue: Venue::Replay,
            symbol: symbol.into(),
            price: Price(price),
            qty: Qty(qty),
            side: Side::Buy,
            synthetic: false,
            ts,
        }
    }

    fn bar(t: TimeMs, ohlc: [i64; 4], volume: i64) -> Bar {
        Bar {
            t,
            open: Price(ohlc[0]),
            high: Price(ohlc[1]),
            low: Price(ohlc[2]),
            close: Price(ohlc[3]),
            volume: Qty(volume),
        }
    }

    fn candle(symbol: &str, timeframe: Timeframe, snapshot: bool, bars: Vec<Bar>) -> Event {
        Event::Candle {
            venue: Venue::Replay,
            symbol: symbol.into(),
            timeframe,
            snapshot,
            bars,
            indicators: None,
        }
    }

    fn with_indicators(event: Event, indicators: Option<Vec<protocol::IndicatorPoint>>) -> Event {
        match event {
            Event::Candle {
                venue,
                symbol,
                timeframe,
                snapshot,
                bars,
                ..
            } => Event::Candle {
                venue,
                symbol,
                timeframe,
                snapshot,
                bars,
                indicators,
            },
            other => other,
        }
    }

    /// The indicator points of a snapshot, asserted to cover exactly the bar times `ts`.
    fn snapshot_indicators(event: &Event, ts: &[TimeMs]) -> Option<Vec<protocol::IndicatorPoint>> {
        let Event::Candle {
            indicators: Some(points),
            ..
        } = event
        else {
            panic!("snapshot without indicators: {event:?}");
        };
        assert_eq!(points.iter().map(|p| p.t).collect::<Vec<_>>(), ts);
        Some(points.clone())
    }

    #[test]
    fn ping_gets_pong_with_same_id() {
        let mut engine = Engine::new();
        for id in [0, 1, u64::MAX] {
            assert_eq!(
                engine.on_command(Command::Ping { id }),
                vec![Event::Pong { id }]
            );
        }
    }

    #[test]
    fn order_commands_drive_the_matcher() {
        use protocol::OrderStatus;
        let mut engine = Engine::new();
        let guest = AccountId::new("guest").unwrap();
        let other = AccountId::new("w_other").unwrap();
        let o1 = OrderId::new("o-1").unwrap();
        let place = |kind: OrderKind| Command::PlaceOrder {
            account_id: guest.clone(),
            venue: Venue::Replay,
            order_id: o1.clone(),
            symbol: "ETH-USD".into(),
            side: Side::Buy,
            qty: Qty(5),
            kind,
        };
        let ack = |account: &AccountId, status| Event::OrderAck {
            account_id: account.clone(),
            venue: Venue::Replay,
            order_id: o1.clone(),
            status,
        };

        // A market order with no book rests, with only the accepted ack.
        assert_eq!(
            engine.on_command(place(OrderKind::Market)),
            [ack(&guest, OrderStatus::Accepted)]
        );
        // Another account cannot cancel it.
        assert_eq!(
            engine.on_command(Command::Cancel {
                account_id: other.clone(),
                order_id: o1.clone(),
            }),
            [Event::OrderRejected {
                account_id: other.clone(),
                venue: Venue::Replay,
                order_id: o1.clone(),
                reason: "unknown_order".into(),
            }]
        );
        // A book snapshot fills it: Book event first, then Fill and the filled ack.
        let events = engine.on_market(snap("ETH-USD", &[(9, 1)], &[(11, 8)], 50));
        assert_eq!(events.len(), 4);
        assert!(is_book(&events[0]));
        assert!(matches!(
            &events[1],
            Event::Fill {
                price: Price(11),
                qty: Qty(5),
                remaining: Qty(0),
                ts: 50,
                ..
            }
        ));
        assert_eq!(events[2], ack(&guest, OrderStatus::Filled));
        // Req 13.4: the Position follows the fill and the filled ack.
        assert!(matches!(
            &events[3],
            Event::Position {
                qty: Qty(5),
                avg_entry: Some(Price(11)),
                ..
            }
        ));
        // Nothing left to cancel.
        assert_eq!(
            engine.on_command(Command::CancelAll {
                account_id: guest.clone()
            }),
            []
        );
        // ResetAccount flattens the account: one flat Position per instrument (Req 14.3).
        let reset = engine.on_command(Command::ResetAccount { account_id: guest });
        assert_eq!(reset.len(), INSTRUMENTS.len());
        assert!(reset.iter().all(|e| matches!(
            e,
            Event::Position {
                qty: Qty(0),
                avg_entry: None,
                ..
            }
        )));
    }

    #[test]
    fn trade_triggers_a_stop_and_matching_events_follow_market_events() {
        use protocol::OrderStatus;
        let mut engine = Engine::new();
        let guest = AccountId::new("guest").unwrap();
        engine.on_market(snap(BTC, &[(99, 1)], &[(110, 9)], 0));
        let events = engine.on_command(Command::PlaceOrder {
            account_id: guest.clone(),
            venue: Venue::Replay,
            order_id: OrderId::new("s-1").unwrap(),
            symbol: BTC.into(),
            side: Side::Buy,
            qty: Qty(2),
            kind: OrderKind::Stop {
                stop_price: Price(105),
            },
        });
        assert_eq!(events.len(), 1);
        let events = engine.on_market(trade_msg(BTC, 105, 1, 200));
        assert_eq!(events[0], trade_event(BTC, 105, 1, 200));
        let tail = &events[events.len() - 3..];
        assert!(matches!(
            &tail[0],
            Event::Fill {
                price: Price(110),
                qty: Qty(2),
                ts: 200,
                ..
            }
        ));
        assert!(matches!(
            &tail[1],
            Event::OrderAck {
                status: OrderStatus::Filled,
                ..
            }
        ));
        assert!(matches!(&tail[2], Event::Position { qty: Qty(2), .. }));
    }

    #[test]
    fn market_trade_becomes_a_trade_event() {
        let mut engine = Engine::new();
        let msg = MarketMsg::Trade {
            symbol: "SOL-USD".into(),
            price: Price(15_000),
            qty: Qty(7),
            side: Side::Sell,
            ts: 1_798_761_600_123,
        };
        let expected = Event::Trade {
            venue: Venue::Replay,
            symbol: "SOL-USD".into(),
            price: Price(15_000),
            qty: Qty(7),
            side: Side::Sell,
            synthetic: false,
            ts: 1_798_761_600_123,
        };
        assert_eq!(engine.on_market(msg), vec![expected]);
    }

    fn lv(price: i64, qty: i64) -> Level {
        Level {
            price: Price(price),
            qty: Qty(qty),
        }
    }

    fn snap(symbol: &str, bids: &[(i64, i64)], asks: &[(i64, i64)], ts: TimeMs) -> MarketMsg {
        MarketMsg::BookSnapshot {
            symbol: symbol.into(),
            bids: bids.iter().map(|&(p, q)| lv(p, q)).collect(),
            asks: asks.iter().map(|&(p, q)| lv(p, q)).collect(),
            ts,
        }
    }

    fn delta(symbol: &str, side: Side, price: i64, qty: i64, ts: TimeMs) -> MarketMsg {
        MarketMsg::BookDelta {
            symbol: symbol.into(),
            side,
            price: Price(price),
            qty: Qty(qty),
            ts,
        }
    }

    fn is_book(event: &Event) -> bool {
        matches!(event, Event::Book { .. })
    }

    #[test]
    fn first_book_message_emits_immediately_with_book_content() {
        let mut engine = Engine::new();
        let events = engine.on_market(snap(BTC, &[(99, 3), (98, 1)], &[(101, 1), (102, 2)], 5));
        assert_eq!(
            events,
            [Event::Book {
                venue: Venue::Replay,
                symbol: BTC.into(),
                bids: vec![lv(99, 3), lv(98, 1)],
                asks: vec![lv(101, 1), lv(102, 2)],
                spread: Some(Price(2)),
                imbalance_bps: 1_428,
                synthetic: false,
                ts: 5,
            }]
        );
    }

    #[test]
    fn book_event_has_at_most_20_levels_per_side() {
        let mut engine = Engine::new();
        let bids: Vec<(i64, i64)> = (1..=30).map(|i| (100 - i, 1)).collect();
        let asks: Vec<(i64, i64)> = (1..=30).map(|i| (100 + i, 1)).collect();
        let events = engine.on_market(snap(BTC, &bids, &asks, 0));
        let [Event::Book { bids, asks, .. }] = events.as_slice() else {
            panic!("expected one book event, got {events:?}");
        };
        assert_eq!((bids.len(), asks.len()), (20, 20));
        assert_eq!(bids[0].price, Price(99));
        assert_eq!(asks[0].price, Price(101));
    }

    #[test]
    fn second_book_message_within_100ms_is_withheld() {
        let mut engine = Engine::new();
        assert_eq!(
            engine
                .on_market(snap(BTC, &[(99, 1)], &[(101, 1)], 1_000))
                .len(),
            1
        );
        assert_eq!(engine.on_market(delta(BTC, Side::Buy, 98, 2, 1_099)), []);
    }

    #[test]
    fn pending_book_is_emitted_by_a_later_trade_after_the_window() {
        let mut engine = Engine::new();
        engine.on_market(snap(BTC, &[(99, 1)], &[(101, 1)], 1_000));
        assert_eq!(engine.on_market(delta(BTC, Side::Buy, 98, 2, 1_050)), []);
        // A trade inside the window emits only the trade.
        assert_eq!(
            engine.on_market(trade_msg(BTC, 100, 1, 1_099)),
            [trade_event(BTC, 100, 1, 1_099)]
        );
        // A trade after the window: Trade first, then the pending Book.
        let events = engine.on_market(trade_msg(BTC, 100, 1, 1_100));
        assert_eq!(events.len(), 2);
        assert_eq!(events[0], trade_event(BTC, 100, 1, 1_100));
        let Event::Book { bids, ts, .. } = &events[1] else {
            panic!("expected book, got {:?}", events[1]);
        };
        assert_eq!(bids, &vec![lv(99, 1), lv(98, 2)]);
        assert_eq!(*ts, 1_100);
        // Clean now: nothing more is emitted.
        assert!(
            !engine
                .on_market(trade_msg(BTC, 100, 1, 1_300))
                .iter()
                .any(is_book)
        );
    }

    #[test]
    fn book_events_come_after_trade_and_candle_events() {
        let mut engine = Engine::new();
        engine.on_command(subscribe(BTC, Timeframe::M1));
        engine.on_market(snap(BTC, &[(99, 1)], &[(101, 1)], 0));
        engine.on_market(delta(BTC, Side::Buy, 98, 2, 10));
        let events = engine.on_market(trade_msg(BTC, 100, 1, 200));
        assert_eq!(events.len(), 4);
        assert!(matches!(events[0], Event::Trade { .. }));
        assert!(matches!(events[1], Event::Candle { .. }));
        assert!(matches!(events[2], Event::Indicators { .. }));
        assert!(is_book(&events[3]));
    }

    #[test]
    fn two_book_messages_100ms_apart_both_emit() {
        let mut engine = Engine::new();
        assert!(is_book(
            &engine.on_market(snap(BTC, &[(99, 1)], &[(101, 1)], 0))[0]
        ));
        let events = engine.on_market(delta(BTC, Side::Sell, 102, 1, 100));
        assert_eq!(events.len(), 1);
        assert!(is_book(&events[0]));
    }

    #[test]
    fn throttle_is_per_symbol() {
        let mut engine = Engine::new();
        engine.on_market(snap(BTC, &[(99, 1)], &[(101, 1)], 0));
        let events = engine.on_market(snap(ETH, &[(9, 1)], &[(11, 1)], 10));
        assert_eq!(events.len(), 1);
    }

    #[test]
    fn negative_delta_emits_an_error_and_no_book() {
        let mut engine = Engine::new();
        engine.on_market(snap(BTC, &[(99, 1)], &[(101, 1)], 0));
        let events = engine.on_market(delta(BTC, Side::Buy, 99, -1, 500));
        match events.as_slice() {
            [Event::Error { code, message }] => {
                assert_eq!(*code, ErrorCode::InvalidBookDelta);
                assert!(message.contains(BTC), "{message}");
            }
            other => panic!("expected one error, got {other:?}"),
        }
        // Book unchanged and not dirty: a later trade emits no Book.
        assert!(
            !engine
                .on_market(trade_msg(BTC, 100, 1, 900))
                .iter()
                .any(is_book)
        );
        assert_eq!(engine.books[BTC].book.bids.get(&Price(99)), Some(&Qty(1)));
    }

    #[test]
    fn crossing_delta_is_reflected_in_the_emitted_book() {
        let mut engine = Engine::new();
        engine.on_market(snap(BTC, &[(99, 1)], &[(101, 1), (103, 1)], 0));
        let events = engine.on_market(delta(BTC, Side::Buy, 101, 5, 100));
        let [
            Event::Book {
                bids, asks, spread, ..
            },
        ] = events.as_slice()
        else {
            panic!("expected one book event, got {events:?}");
        };
        assert_eq!(bids, &vec![lv(101, 5), lv(99, 1)]);
        assert_eq!(asks, &vec![lv(103, 1)]);
        assert_eq!(*spread, Some(Price(2)));
    }

    #[test]
    fn same_inputs_give_the_same_book_events() {
        let run = || {
            let mut engine = Engine::new();
            let mut out = Vec::new();
            out.extend(engine.on_market(snap(BTC, &[(99, 1)], &[(101, 1)], 0)));
            out.extend(engine.on_market(delta(BTC, Side::Buy, 100, 2, 40)));
            out.extend(engine.on_market(delta(BTC, Side::Buy, 100, -2, 60)));
            out.extend(engine.on_market(trade_msg(BTC, 100, 1, 130)));
            out
        };
        assert_eq!(run(), run());
    }

    /// Sanity run on generated data: at most one Book per symbol per 100 ms of market time,
    /// and no crossed book.
    #[test]
    fn synth_books_are_throttled_and_never_crossed() {
        let lines = synth(&SynthConfig {
            seed: 11,
            duration_ms: 2 * MIN,
            start_ms: 1_798_761_600_000,
            symbols: SynthSymbol::ALL.to_vec(),
        });
        let mut engine = Engine::new();
        let mut last: BTreeMap<String, TimeMs> = BTreeMap::new();
        let mut books = 0;
        for line in lines {
            for event in engine.on_market(line.msg) {
                if let Event::Book {
                    symbol,
                    bids,
                    asks,
                    ts,
                    ..
                } = event
                {
                    books += 1;
                    if let Some(prev) = last.insert(symbol.clone(), ts) {
                        assert!(ts - prev >= 100, "{symbol}: {prev} -> {ts}");
                    }
                    if let (Some(b), Some(a)) = (bids.first(), asks.first()) {
                        assert!(b.price < a.price, "{symbol}: {b:?} vs {a:?}");
                    }
                    assert!(bids.len() <= 20 && asks.len() <= 20);
                }
            }
        }
        assert!(books > 10, "{books}");
    }

    #[test]
    fn subscribe_without_bars_sends_an_empty_snapshot() {
        let mut engine = Engine::new();
        for tf in Timeframe::ALL {
            assert_eq!(
                engine.on_command(subscribe(BTC, tf)),
                vec![with_indicators(
                    candle(BTC, tf, true, Vec::new()),
                    Some(Vec::new())
                )]
            );
        }
    }

    #[test]
    fn snapshot_carries_history_and_comes_before_live_updates() {
        let mut engine = Engine::new();
        // Candles build with no subscriber.
        assert_eq!(
            engine.on_market(trade_msg(BTC, 100, 1, 0)),
            [trade_event(BTC, 100, 1, 0)]
        );
        engine.on_market(trade_msg(BTC, 110, 2, MIN));

        let snapshot = engine.on_command(subscribe(BTC, Timeframe::M1));
        let expected = vec![bar(0, [100; 4], 1), bar(MIN, [110; 4], 2)];
        assert_eq!(snapshot.len(), 2);
        assert_eq!(
            snapshot[0],
            with_indicators(
                candle(BTC, Timeframe::M1, true, expected),
                snapshot_indicators(&snapshot[0], &[0, MIN])
            )
        );
        assert!(matches!(
            &snapshot[1],
            Event::Indicators { timeframe: Timeframe::M1, ts, .. } if *ts == MIN
        ));

        let events = engine.on_market(trade_msg(BTC, 105, 3, MIN + 1));
        assert_eq!(events.len(), 3);
        assert_eq!(events[0], trade_event(BTC, 105, 3, MIN + 1));
        assert_eq!(
            events[1],
            candle(
                BTC,
                Timeframe::M1,
                false,
                vec![bar(MIN, [110, 110, 105, 105], 5)]
            )
        );
        // chart-and-tape-fix bugfix 2.1: the live Indicators ts is the candle
        // open time (the trade at MIN + 1 falls in the bar opening at MIN).
        assert!(matches!(
            &events[2],
            Event::Indicators { timeframe: Timeframe::M1, ts, .. } if *ts == MIN
        ));
    }

    #[test]
    fn snapshot_is_capped_at_500_bars() {
        let mut engine = Engine::new();
        for i in 0..600 {
            engine.on_market(trade_msg(BTC, 100 + i, 1, i * MIN));
        }
        let events = engine.on_command(subscribe(BTC, Timeframe::M1));
        let [
            Event::Candle { bars, snapshot, .. },
            Event::Indicators { .. },
        ] = events.as_slice()
        else {
            panic!("expected a candle and an indicators event, got {events:?}");
        };
        assert!(*snapshot);
        assert_eq!(bars.len(), MAX_BARS);
        assert_eq!(bars.first().map(|b| b.t), Some(100 * MIN));
        assert_eq!(bars.last(), Some(&bar(599 * MIN, [699; 4], 1)));
    }

    #[test]
    fn only_subscribed_keys_get_live_updates() {
        let mut engine = Engine::new();
        engine.on_command(subscribe(BTC, Timeframe::M5));
        let events = engine.on_market(trade_msg(BTC, 100, 1, 0));
        assert_eq!(events.len(), 3);
        assert_eq!(events[0], trade_event(BTC, 100, 1, 0));
        assert_eq!(
            events[1],
            candle(BTC, Timeframe::M5, false, vec![bar(0, [100; 4], 1)])
        );
        assert!(matches!(
            &events[2],
            Event::Indicators {
                timeframe: Timeframe::M5,
                ..
            }
        ));
        // Another symbol, and another timeframe of no subscriber: trades only.
        assert_eq!(
            engine.on_market(trade_msg(ETH, 7, 1, 0)),
            [trade_event(ETH, 7, 1, 0)]
        );
        // Unsubscribing a key that was never subscribed changes nothing.
        assert_eq!(engine.on_command(unsubscribe(BTC, Timeframe::H1)), []);
        assert_eq!(engine.on_market(trade_msg(BTC, 101, 1, 1)).len(), 3);
    }

    /// Property 8 (Req 3.2): a live `Candle` line, encoded as the engine writes it to stdout,
    /// has no `indicators` key, and the subscribe answer ends with exactly one `Indicators`
    /// event for the newest bar.
    #[test]
    fn live_candle_json_has_no_indicators_key_and_snapshot_ends_with_one_indicators() {
        let mut engine = Engine::new();
        engine.on_market(trade_msg(BTC, 100, 1, 0));
        engine.on_market(trade_msg(BTC, 110, 2, MIN));

        let answer = engine.on_command(subscribe(BTC, Timeframe::M1));
        let indicators = answer
            .iter()
            .filter(|e| matches!(e, Event::Indicators { .. }))
            .count();
        assert_eq!(indicators, 1);
        assert!(matches!(
            answer.last(),
            Some(Event::Indicators { timeframe: Timeframe::M1, ts, .. }) if *ts == MIN
        ));

        let live = engine.on_market(trade_msg(BTC, 105, 3, MIN + 1));
        let mut candles = 0;
        for event in &live {
            let line = protocol::encode_line(event).unwrap();
            if matches!(event, Event::Candle { .. }) {
                candles += 1;
                assert!(line.contains("\"type\":\"candle\""), "{line}");
                assert!(!line.contains("\"indicators\":"), "{line}");
            }
        }
        assert_eq!(candles, 1);
    }

    #[test]
    fn unsubscribe_stops_updates_and_resubscribe_sends_a_new_snapshot() {
        let mut engine = Engine::new();
        engine.on_command(subscribe(BTC, Timeframe::M1));
        engine.on_market(trade_msg(BTC, 100, 1, 0));
        assert_eq!(engine.on_command(unsubscribe(BTC, Timeframe::M1)), []);
        assert_eq!(engine.subscriptions, BTreeMap::new());

        // Still built while nobody listens.
        assert_eq!(
            engine.on_market(trade_msg(BTC, 120, 2, MIN)),
            [trade_event(BTC, 120, 2, MIN)]
        );
        let snapshot = engine.on_command(subscribe(BTC, Timeframe::M1));
        let bars = vec![bar(0, [100; 4], 1), bar(MIN, [120; 4], 2)];
        assert_eq!(snapshot.len(), 2);
        let points = snapshot_indicators(&snapshot[0], &[0, MIN]);
        assert_eq!(
            snapshot[0],
            with_indicators(
                candle(BTC, Timeframe::M1, true, bars.clone()),
                points.clone()
            )
        );
        // Subscribing again while subscribed also resends the snapshot.
        let again = engine.on_command(subscribe(BTC, Timeframe::M1));
        assert_eq!(again.len(), 2);
        assert_eq!(
            again[0],
            with_indicators(candle(BTC, Timeframe::M1, true, bars), points)
        );
        assert_eq!(engine.on_market(trade_msg(BTC, 121, 1, MIN)).len(), 3);
    }

    #[test]
    fn trade_comes_first_then_candles_in_timeframe_order() {
        let mut engine = Engine::new();
        for tf in Timeframe::ALL.into_iter().rev() {
            engine.on_command(subscribe(BTC, tf));
        }
        engine.on_market(trade_msg(BTC, 100, 1, 0));
        let events = engine.on_market(trade_msg(BTC, 130, 2, 2 * MIN));
        let mut expected = vec![candle(
            BTC,
            Timeframe::M1,
            false,
            vec![bar(2 * MIN, [130; 4], 2)],
        )];
        for tf in &Timeframe::ALL[1..] {
            expected.push(candle(
                BTC,
                *tf,
                false,
                vec![bar(0, [100, 130, 100, 130], 3)],
            ));
        }
        assert_eq!(events[0], trade_event(BTC, 130, 2, 2 * MIN));
        // Then Candle, Indicators for each timeframe in order.
        assert_eq!(events.len(), 1 + 2 * Timeframe::ALL.len());
        for (i, tf) in Timeframe::ALL.into_iter().enumerate() {
            assert_eq!(events[1 + 2 * i], expected[i], "{tf}");
            // chart-and-tape-fix bugfix 2.1: Indicators ts is the candle open time of the
            // timeframe (the 2 * MIN trade opens a new 1m bar; higher bars open at 0).
            let open = if tf == Timeframe::M1 { 2 * MIN } else { 0 };
            assert!(
                matches!(
                    &events[2 + 2 * i],
                    Event::Indicators { symbol, timeframe, ts, .. }
                        if symbol == BTC && *timeframe == tf && *ts == open
                ),
                "{tf}: {:?}",
                events[2 + 2 * i]
            );
        }
    }

    #[test]
    fn indicators_only_for_subscribed_keys_and_not_for_late_bars() {
        let mut engine = Engine::new();
        // Indicators build with no subscriber; subscribing then shows them at once.
        engine.on_market(trade_msg(BTC, 100, 1, 0));
        engine.on_market(trade_msg(BTC, 110, 1, 2 * MIN));
        let events = engine.on_market(trade_msg(ETH, 5, 1, 0));
        assert_eq!(events.len(), 1);
        let snapshot = engine.on_command(subscribe(BTC, Timeframe::M1));
        let Some(Event::Indicators { values, ts, .. }) = snapshot.get(1) else {
            panic!("expected an indicators event, got {snapshot:?}");
        };
        assert_eq!(*ts, 2 * MIN);
        assert_eq!(values.ema, Some(100.0 + (2.0 / 21.0) * 10.0));
        assert_eq!(values.vwap, Some(105.0));
        // Late trade into an older bar: Candle only, no Indicators.
        let late = engine.on_market(trade_msg(BTC, 90, 1, 30_000));
        assert_eq!(late.len(), 2);
        assert!(matches!(late[1], Event::Candle { .. }));
        // Other symbols and timeframes with no subscription: trade only.
        assert_eq!(engine.on_market(trade_msg(ETH, 6, 1, 1)).len(), 1);
    }

    #[test]
    fn same_inputs_give_the_same_indicator_events() {
        let run = || {
            let mut engine = Engine::new();
            let mut out = engine.on_command(subscribe(BTC, Timeframe::M1));
            for i in 0..40 {
                let price = 100 + (i * 7) % 11;
                out.extend(engine.on_market(trade_msg(BTC, price, 1 + i % 3, i * 20_000)));
            }
            out.extend(engine.on_command(subscribe(BTC, Timeframe::M1)));
            out
        };
        let first = run();
        assert!(first.iter().any(|e| matches!(e, Event::Indicators { .. })));
        assert_eq!(first, run());
    }

    #[test]
    fn out_of_order_trades_update_older_bars_or_are_dropped() {
        let mut engine = Engine::new();
        engine.on_command(subscribe(BTC, Timeframe::M1));
        engine.on_market(trade_msg(BTC, 100, 1, 0));
        engine.on_market(trade_msg(BTC, 100, 1, 2 * MIN));
        // Late but inside the ring: the older bar changes and is sent as a live update.
        assert_eq!(
            engine.on_market(trade_msg(BTC, 90, 1, 30_000)),
            [
                trade_event(BTC, 90, 1, 30_000),
                candle(
                    BTC,
                    Timeframe::M1,
                    false,
                    vec![bar(0, [100, 100, 90, 90], 2)]
                ),
            ]
        );
        // Older than the oldest kept bar: the trade is forwarded, no candle changes.
        assert_eq!(
            engine.on_market(trade_msg(BTC, 80, 1, -1)),
            [trade_event(BTC, 80, 1, -1)]
        );
        assert_eq!(engine.candles.dropped().late, 1);
    }

    #[test]
    fn unknown_symbols_are_refused() {
        let mut engine = Engine::new();
        for cmd in [
            subscribe("DOGE-USD", Timeframe::M1),
            unsubscribe("DOGE-USD", Timeframe::M1),
        ] {
            match engine.on_command(cmd).as_slice() {
                [Event::Error { code, message }] => {
                    assert_eq!(*code, ErrorCode::UnknownSymbol);
                    assert!(message.contains("DOGE-USD"), "{message}");
                }
                other => panic!("expected one error, got {other:?}"),
            }
        }
        assert!(engine.subscriptions.is_empty());
    }

    /// Sanity run on generated data: 10 minutes of all three symbols through the engine.
    #[test]
    fn synth_fixture_builds_consistent_candles() {
        let lines = synth(&SynthConfig {
            seed: 7,
            duration_ms: 10 * MIN,
            start_ms: 1_798_761_600_000,
            symbols: SynthSymbol::ALL.to_vec(),
        });
        let mut engine = Engine::new();
        for tf in Timeframe::ALL {
            engine.on_command(subscribe(BTC, tf));
        }
        let mut btc_trades = Vec::new();
        let mut live: BTreeMap<Timeframe, usize> = BTreeMap::new();
        for line in lines {
            if let MarketMsg::Trade {
                symbol,
                price,
                qty,
                ts,
                ..
            } = &line.msg
                && symbol == BTC
            {
                btc_trades.push((*price, *qty, *ts));
            }
            for event in engine.on_market(line.msg) {
                if let Event::Candle {
                    symbol,
                    timeframe,
                    snapshot,
                    bars,
                    ..
                } = event
                {
                    assert_eq!(symbol, BTC);
                    assert!(!snapshot);
                    assert_eq!(bars.len(), 1);
                    *live.entry(timeframe).or_default() += 1;
                }
            }
        }
        assert!(btc_trades.len() > 100, "{}", btc_trades.len());
        assert_eq!(engine.candles.dropped().total(), 0);
        let total_qty: i64 = btc_trades.iter().map(|t| t.1.0).sum();
        for tf in Timeframe::ALL {
            // One live update per BTC trade per timeframe.
            assert_eq!(live.get(&tf), Some(&btc_trades.len()), "{tf}");
            let bars = engine.candles.bars(BTC, tf);
            assert_eq!(bars, crate::candles::build_direct(&btc_trades, tf), "{tf}");
            assert!(bars.len() <= 11, "{tf}: {}", bars.len());
            assert_eq!(bars.iter().map(|b| b.volume.0).sum::<i64>(), total_qty);
            for b in &bars {
                assert_eq!(b.t.rem_euclid(tf.millis()), 0, "{tf}");
                assert!(b.low <= b.open && b.open <= b.high, "{tf} {b:?}");
                assert!(b.low <= b.close && b.close <= b.high, "{tf} {b:?}");
            }
        }
        for symbol in [ETH, "SOL-USD"] {
            assert!(!engine.candles.bars(symbol, Timeframe::M1).is_empty());
        }
    }

    // Backfill bookkeeping (Task 3.4, Req 2.5, 2.6).

    fn req(symbol: &str, timeframe: Timeframe) -> HistoryRequest {
        HistoryRequest {
            symbol: symbol.into(),
            timeframe,
        }
    }

    /// A valid 1m venue bar at minute `m`.
    fn venue_bar(m: i64) -> Bar {
        bar(m * MIN, [100, 110, 90, 105], 5)
    }

    #[test]
    fn replay_engine_queues_no_history_requests() {
        let mut engine = Engine::new();
        engine.on_command(subscribe(BTC, Timeframe::M1));
        engine.on_command(subscribe(ETH, Timeframe::M5));
        assert!(engine.take_history_requests().is_empty());
        // No state, so history is ignored.
        assert!(
            engine
                .on_history(BTC, Timeframe::M1, &[venue_bar(1)])
                .is_empty()
        );
        assert!(engine.candles.bars(BTC, Timeframe::M1).is_empty());
    }

    #[test]
    fn backfill_queues_one_request_per_key() {
        let mut engine = Engine::with_backfill();
        engine.on_command(subscribe(BTC, Timeframe::M1));
        engine.on_command(subscribe(BTC, Timeframe::M1));
        engine.on_command(subscribe(BTC, Timeframe::M5));
        engine.on_command(unsubscribe(BTC, Timeframe::M1));
        engine.on_command(subscribe(BTC, Timeframe::M1));
        assert_eq!(
            engine.take_history_requests(),
            [req(BTC, Timeframe::M1), req(BTC, Timeframe::M5)]
        );
        assert!(engine.take_history_requests().is_empty());
        // A finished key never asks again.
        engine.on_history(BTC, Timeframe::M1, &[venue_bar(1)]);
        engine.on_command(subscribe(BTC, Timeframe::M1));
        assert!(engine.take_history_requests().is_empty());
    }

    #[test]
    fn on_history_merges_snapshots_and_later_calls_do_nothing() {
        let mut engine = Engine::with_backfill();
        engine.on_command(subscribe(BTC, Timeframe::M1));
        engine.on_market(trade_msg(BTC, 100, 1, 10 * MIN + 5));
        let live = engine.candles.bars(BTC, Timeframe::M1);
        assert_eq!(live.len(), 1);

        // Minute 10 and 11 are at or after the cutoff and are dropped.
        let venue: Vec<Bar> = (7..=11).map(venue_bar).collect();
        let events = engine.on_history(BTC, Timeframe::M1, &venue);
        let merged = engine.candles.bars(BTC, Timeframe::M1);
        let times: Vec<TimeMs> = merged.iter().map(|b| b.t).collect();
        assert_eq!(times, [7 * MIN, 8 * MIN, 9 * MIN, 10 * MIN]);
        assert_eq!(merged.last(), live.last());
        assert_eq!(events.len(), 2);
        assert!(matches!(
            &events[0],
            Event::Candle { snapshot: true, bars, .. } if *bars == merged
        ));
        assert!(matches!(
            &events[1],
            Event::Indicators { ts, .. } if *ts == 10 * MIN
        ));
        let expected = SymbolIndicators::from_bars(&merged);
        let key = (BTC.to_owned(), Timeframe::M1);
        let actual = engine.indicators.get(&key).map(SymbolIndicators::history);
        assert_eq!(actual, Some(expected.history()));

        // A second result for the same key is ignored.
        let more: Vec<Bar> = (1..=6).map(venue_bar).collect();
        assert!(engine.on_history(BTC, Timeframe::M1, &more).is_empty());
        assert_eq!(engine.candles.bars(BTC, Timeframe::M1), merged);
    }

    #[test]
    fn on_history_for_an_unsubscribed_key_merges_without_events() {
        let mut engine = Engine::with_backfill();
        engine.on_command(subscribe(BTC, Timeframe::M1));
        engine.on_command(unsubscribe(BTC, Timeframe::M1));
        engine.on_market(trade_msg(BTC, 100, 1, 10 * MIN + 5));
        let venue: Vec<Bar> = (8..=9).map(venue_bar).collect();
        assert!(engine.on_history(BTC, Timeframe::M1, &venue).is_empty());
        assert_eq!(engine.candles.bars(BTC, Timeframe::M1).len(), 3);
        // The key is done: a later subscribe sends the merged snapshot and no new request.
        engine.take_history_requests();
        let events = engine.on_command(subscribe(BTC, Timeframe::M1));
        assert!(matches!(
            &events[0],
            Event::Candle { snapshot: true, bars, .. } if bars.len() == 3
        ));
        assert!(engine.take_history_requests().is_empty());
    }

    #[test]
    fn on_history_failed_reports_truncates_and_allows_a_retry() {
        let mut engine = Engine::with_backfill();
        engine.on_command(subscribe(BTC, Timeframe::M1));
        engine.on_market(trade_msg(BTC, 100, 1, 10 * MIN + 5));
        assert_eq!(engine.take_history_requests().len(), 1);

        let reason = "é".repeat(300);
        let events = engine.on_history_failed(BTC, Timeframe::M1, &reason);
        assert_eq!(events.len(), 1);
        let Event::Error { code, message } = &events[0] else {
            panic!("expected an error event, got {:?}", events[0]);
        };
        assert_eq!(*code, ErrorCode::FeedDisconnected);
        assert!(message.contains(BTC));
        assert!(message.contains(&Timeframe::M1.to_string()));
        assert_eq!(message.matches('é').count(), 200);
        // Live bars are kept.
        assert_eq!(engine.candles.bars(BTC, Timeframe::M1).len(), 1);

        // The next subscribe asks again.
        engine.on_command(subscribe(BTC, Timeframe::M1));
        assert_eq!(engine.take_history_requests(), [req(BTC, Timeframe::M1)]);
    }
}

/// Paper_Account wiring (Task 10.2, Req 13, 14).
#[cfg(test)]
mod paper_tests {
    use super::*;
    use protocol::{Level, Money, OrderId, OrderKind, OrderStatus, Qty, Side};

    const BTC: &str = "BTC-USD";

    fn acct(name: &str) -> AccountId {
        AccountId::new(name).unwrap()
    }

    fn place(account: &str, id: &str, side: Side, qty: i64, kind: OrderKind) -> Command {
        Command::PlaceOrder {
            account_id: acct(account),
            venue: Venue::Replay,
            order_id: OrderId::new(id).unwrap(),
            symbol: BTC.into(),
            side,
            qty: Qty(qty),
            kind,
        }
    }

    fn market(account: &str, id: &str, side: Side, qty: i64) -> Command {
        place(account, id, side, qty, OrderKind::Market)
    }

    fn snap(ts: TimeMs) -> MarketMsg {
        let lv = |price, qty| Level {
            price: Price(price),
            qty: Qty(qty),
        };
        MarketMsg::BookSnapshot {
            symbol: BTC.into(),
            bids: vec![lv(99, 50)],
            asks: vec![lv(101, 50)],
            ts,
        }
    }

    fn trade(price: i64, ts: TimeMs) -> MarketMsg {
        MarketMsg::Trade {
            symbol: BTC.into(),
            price: Price(price),
            qty: Qty(1),
            side: Side::Buy,
            ts,
        }
    }

    fn positions(events: &[Event]) -> Vec<(&str, i64, i64)> {
        events
            .iter()
            .filter_map(|e| match e {
                Event::Position {
                    account_id,
                    qty,
                    unrealized,
                    ..
                } => Some((account_id.as_str(), qty.0, unrealized.0)),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn position_follows_fill_and_filled_ack() {
        let mut engine = Engine::new();
        engine.on_market(snap(0));
        let events = engine.on_command(market("guest", "o-1", Side::Buy, 3));
        assert_eq!(events.len(), 4);
        assert!(matches!(
            &events[0],
            Event::OrderAck {
                status: OrderStatus::Accepted,
                ..
            }
        ));
        let Event::Fill { fee, .. } = &events[1] else {
            panic!("expected a fill, got {:?}", events[1]);
        };
        assert!(matches!(
            &events[2],
            Event::OrderAck {
                status: OrderStatus::Filled,
                ..
            }
        ));
        // Basis 101 × 3; no trade yet, so unrealized is 0; the fee reduces realized P&L.
        assert_eq!(
            events[3],
            Event::Position {
                account_id: acct("guest"),
                symbol: BTC.into(),
                qty: Qty(3),
                avg_entry: Some(Price(101)),
                realized: Money(-fee.0),
                unrealized: Money(0),
            }
        );
    }

    #[test]
    fn unrealized_refreshes_only_when_the_last_price_changes() {
        let mut engine = Engine::new();
        engine.on_market(snap(0));
        engine.on_command(market("guest", "o-1", Side::Buy, 3));
        engine.on_command(market("w_b", "o-2", Side::Buy, 2));
        // A flat account with history gets no refresh.
        engine.on_command(market("w_c", "o-3", Side::Buy, 1));
        engine.on_command(market("w_c", "o-4", Side::Sell, 1));

        let events = engine.on_market(trade(111, 10));
        assert!(matches!(events[0], Event::Trade { .. }));
        // 111 × 3 − 101 × 3 = 30 and 111 × 2 − 101 × 2 = 20, in AccountId order.
        assert_eq!(positions(&events), [("guest", 3, 30), ("w_b", 2, 20)]);
        assert_eq!(events.len(), 3);
        // Same price again: nothing to refresh.
        assert_eq!(engine.on_market(trade(111, 20)).len(), 1);
        // Short positions gain when the price falls.
        engine.on_command(market("w_s", "o-5", Side::Sell, 4));
        let events = engine.on_market(trade(100, 30));
        assert_eq!(
            positions(&events),
            [("guest", 3, -3), ("w_b", 2, -2), ("w_s", -4, -4)]
        );
    }

    #[test]
    fn market_driven_fill_emits_one_position_and_no_duplicate_refresh() {
        let mut engine = Engine::new();
        engine.on_market(snap(0));
        // A resting stop buy at 105 triggers on the trade at 105 and fills at the ask 101.
        engine.on_command(place(
            "guest",
            "s-1",
            Side::Buy,
            2,
            OrderKind::Stop {
                stop_price: Price(105),
            },
        ));
        let events = engine.on_market(trade(105, 10));
        assert!(matches!(events[0], Event::Trade { .. }));
        assert!(matches!(events[1], Event::Fill { .. }));
        assert!(matches!(
            events[2],
            Event::OrderAck {
                status: OrderStatus::Filled,
                ..
            }
        ));
        // One Position for the fill, with unrealized at the new last price: (105 − 101) × 2.
        assert_eq!(events.len(), 4);
        assert_eq!(positions(&events), [("guest", 2, 8)]);
    }

    #[test]
    fn several_fills_of_one_pass_give_one_position_per_account_and_symbol() {
        let mut engine = Engine::new();
        // Two resting buys for two accounts, then asks appear.
        for (account, id) in [("guest", "o-1"), ("w_b", "o-2")] {
            engine.on_command(market(account, id, Side::Buy, 2));
        }
        let events = engine.on_market(snap(5));
        let fills = events
            .iter()
            .filter(|e| matches!(e, Event::Fill { .. }))
            .count();
        assert_eq!(fills, 2);
        assert_eq!(positions(&events), [("guest", 2, 0), ("w_b", 2, 0)]);
        // Fill, filled ack for each order come before any Position.
        let first_position = events
            .iter()
            .position(|e| matches!(e, Event::Position { .. }))
            .unwrap();
        let last_ack = events
            .iter()
            .rposition(|e| matches!(e, Event::OrderAck { .. }))
            .unwrap();
        assert!(last_ack < first_position);
    }

    #[test]
    fn account_cap_rejects_only_new_accounts() {
        let mut engine = Engine::with_account_cap(2);
        let rest = |account: &str, id: &str| {
            place(
                account,
                id,
                Side::Buy,
                1,
                OrderKind::Limit { price: Price(50) },
            )
        };
        assert_eq!(engine.on_command(rest("a", "o-1")).len(), 1);
        assert_eq!(engine.on_command(rest("b", "o-2")).len(), 1);
        assert_eq!(
            engine.on_command(rest("c", "o-3")),
            [Event::OrderRejected {
                account_id: acct("c"),
                venue: Venue::Replay,
                order_id: OrderId::new("o-3").unwrap(),
                reason: "account_limit".into(),
            }]
        );
        assert_eq!(engine.accounts.len(), 2);
        // The order was not placed: it is not cancelable and no cancel_all event appears.
        assert_eq!(engine.matcher.open_count(), 2);
        // Existing accounts keep trading at the cap.
        let events = engine.on_command(rest("a", "o-4"));
        assert!(matches!(
            &events[0],
            Event::OrderAck {
                status: OrderStatus::Accepted,
                ..
            }
        ));
        assert_eq!(engine.matcher.open_count(), 3);
    }

    #[test]
    fn cancel_and_reset_of_an_unknown_account_do_not_create_it() {
        let mut engine = Engine::with_account_cap(1);
        let events = engine.on_command(Command::Cancel {
            account_id: acct("ghost"),
            order_id: OrderId::new("o-9").unwrap(),
        });
        assert!(matches!(&events[0], Event::OrderRejected { .. }));
        assert_eq!(
            engine.on_command(Command::CancelAll {
                account_id: acct("ghost")
            }),
            []
        );
        let events = engine.on_command(Command::ResetAccount {
            account_id: acct("ghost"),
        });
        assert_eq!(events.len(), INSTRUMENTS.len());
        assert_eq!(engine.accounts.len(), 0);
        // The cap slot is still free for a real account.
        assert_eq!(
            engine.on_command(market("real", "o-1", Side::Buy, 1)).len(),
            1
        );
        assert_eq!(engine.accounts.len(), 1);
    }

    #[test]
    fn reset_cancels_orders_flattens_and_leaves_other_accounts_alone() {
        let mut engine = Engine::new();
        engine.on_market(snap(0));
        engine.on_command(market("guest", "o-1", Side::Buy, 3));
        engine.on_command(market("w_b", "o-2", Side::Buy, 2));
        engine.on_command(place(
            "guest",
            "o-3",
            Side::Buy,
            1,
            OrderKind::Limit { price: Price(50) },
        ));
        engine.on_market(trade(110, 10));

        let events = engine.on_command(Command::ResetAccount {
            account_id: acct("guest"),
        });
        assert_eq!(events.len(), 1 + INSTRUMENTS.len());
        assert_eq!(
            events[0],
            Event::OrderAck {
                account_id: acct("guest"),
                venue: Venue::Replay,
                order_id: OrderId::new("o-3").unwrap(),
                status: OrderStatus::Canceled,
            }
        );
        for (event, inst) in events[1..].iter().zip(INSTRUMENTS) {
            assert_eq!(
                event,
                &Event::Position {
                    account_id: acct("guest"),
                    symbol: inst.symbol.into(),
                    qty: Qty(0),
                    avg_entry: None,
                    realized: Money(0),
                    unrealized: Money(0),
                }
            );
        }
        assert_eq!(engine.matcher.open_count(), 0);
        // Only the other account still has a position to refresh: (120 − 101) × 2.
        let events = engine.on_market(trade(120, 20));
        assert_eq!(positions(&events), [("w_b", 2, 38)]);
        // The reset account still exists and trades again from flat.
        let events = engine.on_command(market("guest", "o-4", Side::Sell, 1));
        // Sold at the bid 99; marked at 120: −120 − (−99) = −21.
        assert_eq!(positions(&events), [("guest", -1, -21)]);
    }

    #[test]
    fn same_inputs_give_the_same_account_events() {
        let run = || {
            let mut engine = Engine::new();
            let mut out = engine.on_market(snap(0));
            out.extend(engine.on_command(market("guest", "o-1", Side::Buy, 3)));
            out.extend(engine.on_command(market("w_b", "o-2", Side::Sell, 2)));
            out.extend(engine.on_market(trade(105, 10)));
            out.extend(engine.on_command(market("guest", "o-3", Side::Sell, 5)));
            out.extend(engine.on_command(Command::ResetAccount {
                account_id: acct("w_b"),
            }));
            out
        };
        assert_eq!(run(), run());
    }
}

#[cfg(test)]
mod ticker_tests {
    use super::*;
    use protocol::{Qty, Side};

    const HOUR: TimeMs = 3_600_000;

    fn trade(price: i64, ts: TimeMs) -> MarketMsg {
        MarketMsg::Trade {
            symbol: "BTC-USD".into(),
            price: Price(price),
            qty: Qty(1),
            side: Side::Buy,
            ts,
        }
    }

    fn sub() -> Command {
        Command::SubscribeTicker {
            symbol: "BTC-USD".into(),
            venue: Venue::Replay,
        }
    }

    fn unsub() -> Command {
        Command::UnsubscribeTicker {
            symbol: "BTC-USD".into(),
            venue: Venue::Replay,
        }
    }

    fn tickers(events: &[Event]) -> Vec<&Event> {
        events
            .iter()
            .filter(|e| matches!(e, Event::Ticker24h { .. }))
            .collect()
    }

    #[test]
    fn subscribe_without_data_answers_nothing() {
        let mut engine = Engine::new();
        assert!(engine.on_command(sub()).is_empty());
    }

    #[test]
    fn subscribe_with_data_answers_at_once_and_marks_partial() {
        let mut engine = Engine::new().with_venue(Venue::Coinbase);
        engine.on_market(trade(100, HOUR));
        engine.on_market(trade(110, 2 * HOUR));
        let events = engine.on_command(sub());
        let [Event::Ticker24h { venue, ticker, ts, .. }] = events.as_slice() else {
            panic!("expected one ticker, got {events:?}");
        };
        assert_eq!(*venue, Venue::Coinbase);
        assert_eq!(*ts, 2 * HOUR);
        assert!(ticker.partial);
        assert_eq!(ticker.change_bps, 1_000);
    }

    #[test]
    fn trades_emit_at_most_one_ticker_per_second_of_market_time() {
        let mut engine = Engine::new();
        engine.on_market(trade(100, HOUR));
        engine.on_command(sub());
        assert!(tickers(&engine.on_market(trade(101, HOUR + 500))).is_empty());
        assert_eq!(tickers(&engine.on_market(trade(102, HOUR + 1_000))).len(), 1);
        assert!(tickers(&engine.on_market(trade(103, HOUR + 1_500))).is_empty());
    }

    #[test]
    fn unsubscribe_stops_the_stream() {
        let mut engine = Engine::new();
        engine.on_market(trade(100, HOUR));
        engine.on_command(sub());
        assert!(engine.on_command(unsub()).is_empty());
        assert!(tickers(&engine.on_market(trade(101, HOUR + 5_000))).is_empty());
        // Resubscribing answers at once again.
        assert_eq!(engine.on_command(sub()).len(), 1);
    }
}
