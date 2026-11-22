// Web UI state (design §5, Req 33). All logic lives in pure, exported functions that take the
// previous state and return the next one, so tests need no React:
//
//   applySocketEvent(state, event)   connection events and server messages from socket.ts
//   applyServerMessage(state, msg)   one decoded ServerMessage
//   applyEvent(state, event)         one engine Event inside a ServerMessage
//
// `useTerminalStore` wraps those functions in a zustand store. Price, Qty, and Money values stay
// decimal strings here; format them with lib/format.ts (BigInt, never Number).

import { create } from "zustand";
import type {
  AccountId,
  AiErrorReason,
  AnalysisResult,
  Bar,
  ClientMessage,
  CopilotAction,
  DataMode,
  Event,
  InstrumentInfo,
  Level,
  NewsItem,
  NoticeKind,
  OrderPreview,
  PairHealth,
  PreviewAction,
  PreviewError,
  ProviderId,
  ProviderInfo,
  ScanItem,
  ServerMessage,
  Side,
  Ticker,
  Timeframe,
  TwapStatus,
  Venue,
  VenueStatusKind,
} from "../../shared/protocol/index";
import { BOOK_LEVELS, moveBookCursor, type CursorDirection } from "./bookView";
import { bucketStartMs } from "./chartData";
import {
  DEFAULT_INDICATOR_TOGGLES,
  MAX_INDICATOR_POINTS,
  type IndicatorName,
  type IndicatorPoint,
  type IndicatorToggles,
} from "./indicatorData";
import { recordPong } from "./latency";
import { addUnits, pushHistory } from "./orderEntry";
import type { SocketEvent } from "./socket";

/** Most fills kept in the recent-fills list, newest first (Req 28.3). */
export const MAX_FILLS = 100;
/** Most rejections kept, newest first (Req 30.6). */
export const MAX_REJECTIONS = 10;
/** Most confirmed placements waiting for their order_ack. */
export const MAX_PENDING_PLACEMENTS = 20;

const INTEGER = /^-?\d+$/;

/** Most candles kept per symbol and timeframe (matches the server's history snapshot, Req 8.7). */
export const MAX_CANDLES = 500;
/** Most trades kept in the tape, newest first. */
export const MAX_TAPE = 200;
/** Most notices kept, oldest first. */
export const MAX_NOTICES = 20;
/** Most news items kept (the server sends one list). */
export const MAX_NEWS = 50;
/** Most AI results and errors kept, by request id. */
export const MAX_AI_RESULTS = 20;
export const DEFAULT_SYMBOL = "BTC-USD";
export const DEFAULT_TIMEFRAME: Timeframe = "1m";

/** Req 33.1: any state other than `connected` shows the "waking server" status. */
export type ConnectionState =
  /** An attempt is in progress, with no delay in front of it. */
  | { readonly kind: "connecting"; readonly attempt: number }
  /** Waiting `nextDelayMs` before attempt `attempt`. */
  | { readonly kind: "waking"; readonly attempt: number; readonly nextDelayMs: number }
  | { readonly kind: "connected" }
  /** The connection just failed or dropped; the next retry is about to be scheduled. */
  | { readonly kind: "disconnected"; readonly reason: string };

/** The parts of the server's `hello` that the UI shows. */
export interface HelloInfo {
  readonly protocolVersion: number;
  readonly dataMode: DataMode;
  /** The live venue shown in the mode label: the default venue in live mode, else null. */
  readonly venue: Venue | null;
  /** Protocol v3: the venues the market feed connects to (empty in replay mode). */
  readonly liveVenues: readonly Venue[];
  readonly defaultVenue: Venue;
  readonly engineRunning: boolean;
}

/** The connection's account, from the server's `session` message. */
export interface SessionInfo {
  readonly accountId: AccountId;
  readonly address: string | null;
}

export interface Selection {
  readonly venue: Venue;
  readonly symbol: string;
  readonly timeframe: Timeframe;
}

/** The latest 24-hour ticker of one (venue, symbol) pair. */
export interface TickerState {
  readonly ticker: Ticker;
  readonly synthetic: boolean;
  readonly ts: number;
}

/** The paper balances of one account (Money strings). */
export interface BalanceState {
  readonly paperBalance: string;
  readonly freeBalance: string;
  readonly equity: string;
  readonly ts: number;
}

export interface ProvidersState {
  readonly available: readonly ProviderInfo[];
  readonly default: ProviderId | null;
  readonly selected: ProviderId | null;
}

export interface NewsState {
  /** False while no news provider answers. */
  readonly available: boolean;
  /** Newest first as sent, at most `MAX_NEWS`. */
  readonly items: readonly NewsItem[];
  readonly updatedAt: number | null;
}

export interface TwapState {
  readonly twapId: string;
  readonly symbol: string;
  readonly side: Side;
  readonly venue: Venue;
  readonly slices: number;
  readonly sent: number;
  readonly status: TwapStatus;
  readonly reason: string | null;
}

export interface AnalysisState {
  readonly requestId: string;
  readonly provider: ProviderId;
  readonly model: string;
  readonly analysis: AnalysisResult;
  readonly preview: OrderPreview | null;
  readonly previewError: PreviewError | null;
}

export interface ScanState {
  readonly requestId: string;
  readonly items: readonly ScanItem[];
}

export interface StrategyState {
  readonly requestId: string;
  readonly text: string;
}

export interface AiErrorState {
  readonly requestId: string;
  readonly reason: AiErrorReason;
  readonly message: string;
}

/** Results of AI requests by request id, oldest first, at most `MAX_AI_RESULTS` each. */
export interface AiState {
  readonly analyses: Readonly<Record<string, AnalysisState>>;
  readonly scans: Readonly<Record<string, ScanState>>;
  readonly strategies: Readonly<Record<string, StrategyState>>;
  readonly errors: Readonly<Record<string, AiErrorState>>;
}

/** One trade as shown in the tape and the last-trade readout. */
export interface TapeEntry {
  /** Stable unique id from `nextTapeId`; use as the React row key. */
  readonly id: number;
  readonly venue: Venue;
  readonly symbol: string;
  readonly price: string;
  readonly qty: string;
  readonly side: Side;
  readonly ts: number;
}

/** The latest order book of one symbol (Req 27.1). Prices and quantities are decimal strings. */
export interface BookState {
  readonly bids: readonly Level[];
  readonly asks: readonly Level[];
  readonly spread: string | null;
  readonly imbalanceBps: number;
  readonly ts: number;
}

/** The order ticket fields the book prefills (Req 30.1). Full order form: Task 12.3. */
export interface TicketState {
  readonly symbol: string;
  readonly side: "buy" | "sell" | null;
  /** Limit price in ticks, as a decimal string. */
  readonly price: string | null;
  readonly qty: string | null;
}

/** The keyboard cursor on the book. `index` counts from the top of that side as displayed. */
export interface BookCursor {
  readonly side: "bid" | "ask";
  readonly index: number;
}

export interface NoticeEntry {
  readonly kind: NoticeKind;
  readonly message: string;
}

/** One open Position of the session's account (Req 28.1). Flat positions are not kept. */
export interface PositionRow {
  readonly symbol: string;
  /** Signed quantity in lots. */
  readonly qty: string;
  /** Average entry price in ticks. */
  readonly avgEntry: string | null;
  /** Realized P&L, Money (10^-10 USD). */
  readonly realized: string;
  /** Unrealized P&L, Money. */
  readonly unrealized: string;
}

/**
 * One open order (Req 28.2). `order_ack` carries only the order id, so symbol, side, type, and
 * price come from the placement the user confirmed (see `PendingPlacement`) or, for `symbol` and
 * `side`, from the first fill. They are null when neither is known.
 */
export interface OrderRow {
  readonly orderId: string;
  readonly symbol: string | null;
  readonly side: Side | null;
  readonly kind: "market" | "limit" | "stop" | null;
  /** Limit or stop price in ticks. */
  readonly price: string | null;
  /** Original quantity in lots (filled + remaining when unknown at the ack). */
  readonly qty: string;
  readonly filled: string;
  readonly remaining: string;
}

export interface FillRow {
  readonly orderId: string;
  readonly symbol: string;
  readonly side: Side;
  readonly price: string;
  readonly qty: string;
  readonly fee: string;
  readonly ts: number;
}

/** A confirmed `place` preview that has not been acknowledged yet, oldest first. */
export interface PendingPlacement {
  readonly symbol: string;
  readonly side: Side;
  readonly kind: "market" | "limit" | "stop";
  readonly price: string | null;
  readonly qty: string;
}

/** The Order_Preview waiting for the user (Req 22.1), with the request it answers. */
export interface PreviewState {
  readonly requestId: string;
  readonly preview: OrderPreview;
}

export interface ParseErrorState {
  readonly requestId: string;
  readonly message: string;
  /** Character position of the first invalid token (Req 21.5). */
  readonly position: number;
}

/** A rejection to show (Req 30.6): an order_rejected event or a failed confirm/cancel request. */
export interface RejectionEntry {
  readonly orderId: string | null;
  readonly reason: string;
}

/** An action that needs a yes/no dialog before anything is sent (Req 30.4, 30.5). */
export type ConfirmAction = "flatten_all" | "cancel_all";

export interface TerminalState {
  readonly connection: ConnectionState;
  /** The `hello` of the current connection; cleared when a connection opens. */
  readonly hello: HelloInfo | null;
  /** The `session` of the current connection; cleared when a connection opens. */
  readonly session: SessionInfo | null;
  /** Instrument table from `hello`, by full symbol. */
  readonly instruments: Readonly<Record<string, InstrumentInfo>>;
  readonly selection: Selection;
  /** Candles, oldest first, by `candleKey(symbol, timeframe)`. */
  readonly candles: Readonly<Record<string, readonly Bar[]>>;
  /** Indicator values, oldest first, by `candleKey(symbol, timeframe)` (Req 26.4). */
  readonly indicators: Readonly<Record<string, readonly IndicatorPoint[]>>;
  /**
   * Per series key: `snapshot` counts candle snapshots, `rewrite` counts live bars older than the
   * newest stored bar. The chart uses them to choose `setData` over `series.update`.
   */
  readonly seriesVersion: Readonly<Record<string, { readonly snapshot: number; readonly rewrite: number }>>;
  /** Which indicators the chart shows (Req 26.3). */
  readonly indicatorToggles: IndicatorToggles;
  /** The most recent trade per `pairKey(venue, symbol)`. */
  readonly lastTrade: Readonly<Record<string, TapeEntry>>;
  /** Recent trades per `pairKey(venue, symbol)`, newest first, at most `MAX_TAPE` each. */
  readonly tape: Readonly<Record<string, readonly TapeEntry[]>>;
  /** Id given to the next tape entry; starts at 1 and never repeats (stable row keys). */
  readonly nextTapeId: number;
  /** Latest order book per `pairKey(venue, symbol)`. */
  readonly book: Readonly<Record<string, BookState>>;
  /** Latest 24-hour ticker per `pairKey(venue, symbol)`. */
  readonly tickers: Readonly<Record<string, TickerState>>;
  /** Connection status per venue, from `hello` and `venue_status`. */
  readonly venueStatus: Readonly<Partial<Record<Venue, VenueStatusKind>>>;
  /** Health per `pairKey(venue, symbol)`. */
  readonly pairHealth: Readonly<Record<string, PairHealth>>;
  /** Reference venue per symbol; null when none qualifies. */
  readonly referenceVenue: Readonly<Record<string, Venue | null>>;
  /** Paper balances per account id. */
  readonly balances: Readonly<Record<string, BalanceState>>;
  /** Paper starting balance (Money) from `hello`. */
  readonly startingBalance: string | null;
  readonly providers: ProvidersState;
  readonly news: NewsState;
  readonly newsEnabled: boolean;
  /** TWAP plans by id. */
  readonly twaps: Readonly<Record<string, TwapState>>;
  readonly ai: AiState;
  readonly ticket: TicketState;
  /** Keyboard cursor on the selected symbol's book; null when none. */
  readonly bookCursor: BookCursor | null;
  readonly notices: readonly NoticeEntry[];
  /** The account whose data the panels below hold; survives reconnects, null before the first session. */
  readonly dataAccountId: AccountId | null;
  /** Open Positions by symbol, for the session's account (Req 28.1). */
  readonly positions: Readonly<Record<string, PositionRow>>;
  /** Latest realized P&L by symbol, kept for flat symbols too, so the P&L total survives a close. */
  readonly realizedBySymbol: Readonly<Record<string, { readonly realized: string }>>;
  /** Open orders by order id (Req 28.2). */
  readonly openOrders: Readonly<Record<string, OrderRow>>;
  /** Recent fills, newest first, at most `MAX_FILLS`. */
  readonly fills: readonly FillRow[];
  readonly pendingPlacements: readonly PendingPlacement[];
  /** The request id of the last command text sent; only its preview or parse error is shown. */
  readonly lastRequestId: string | null;
  readonly preview: PreviewState | null;
  readonly parseError: ParseErrorState | null;
  /** Latest rejections, newest first, at most `MAX_REJECTIONS`. */
  readonly rejections: readonly RejectionEntry[];
  /** Submitted command texts, oldest first, at most 50 (Req 31.3). */
  readonly commandHistory: readonly string[];
  /** The F or X confirmation dialog, or null. */
  readonly confirmAction: ConfirmAction | null;
  /** Frames that were not valid messages, over all connections. */
  readonly badFrames: number;
  readonly lastError: string | null;
}

export interface TerminalActions {
  handleSocketEvent(event: SocketEvent): void;
  selectSymbol(symbol: string): void;
  /** Picks the venue the panels show; the socket hook resubscribes with it. */
  selectVenue(venue: Venue): void;
  /** Selects the LLM provider for this connection (sends `set_provider`). */
  setProvider(provider: ProviderId): boolean;
  /** Sends a Copilot request for the selected venue, symbol, and timeframe; returns its request id. */
  sendAiRequest(action: CopilotAction, text: string): string | null;
  /** Cancels the remaining child orders of a TWAP plan. */
  cancelTwap(twapId: string): boolean;
  /** Starts receiving news. */
  subscribeNews(): boolean;
  selectTimeframe(timeframe: Timeframe): void;
  /** Prefills the limit ticket with a book price (ticks as received). */
  prefillLimit(symbol: string, priceTicks: string): void;
  /** Moves the book cursor up or down (Req 30.1). */
  moveBookCursor(direction: CursorDirection): void;
  setBookCursor(cursor: BookCursor | null): void;
  /** Flips one indicator toggle (Req 26.3: hotkey or click). */
  toggleIndicator(name: IndicatorName): void;
  /** Sets the ticket quantity in lots (null clears it). */
  setTicketQty(qtyLots: string | null): void;
  /** Sets or clears the ticket's limit price (null = market). */
  setTicketPrice(priceTicks: string | null): void;
  /** Records a sent command text: remembers the request id and, when `text` is given, history. */
  commandSent(requestId: string, text: string | null): void;
  /** Closes the preview after the user confirmed it, remembering a `place` for its ack. */
  previewConfirmed(): void;
  /** Closes the preview (discarded, expired, or replaced). */
  clearPreview(): void;
  clearParseError(): void;
  requestConfirm(action: ConfirmAction): void;
  clearConfirm(): void;
  dismissRejections(): void;
  /** Shows a client-side problem in the rejection area. */
  addRejection(reason: string): void;
}

export type TerminalStore = TerminalState & TerminalActions;

/** Key of the per-pair records (book, tape, ticker, health) for one venue and symbol. */
export function pairKey(venue: Venue, symbol: string): string {
  return `${venue}|${symbol}`;
}

/** Key of the `candles` record for one venue, symbol, and timeframe. */
export function candleKey(venue: Venue, symbol: string, timeframe: Timeframe): string {
  return `${venue}|${symbol}|${timeframe}`;
}

const EMPTY_PROVIDERS: ProvidersState = { available: [], default: null, selected: null };
const EMPTY_AI: AiState = { analyses: {}, scans: {}, strategies: {}, errors: {} };

/** Adds `value` under `key`, dropping the oldest entries beyond `MAX_AI_RESULTS`. */
function addCapped<T>(record: Readonly<Record<string, T>>, key: string, value: T): Readonly<Record<string, T>> {
  const { [key]: _old, ...rest } = record;
  const entries = Object.entries(rest);
  const kept = entries.length >= MAX_AI_RESULTS ? entries.slice(entries.length - MAX_AI_RESULTS + 1) : entries;
  return { ...Object.fromEntries(kept), [key]: value };
}

/** Sends one client message; registered by `useTerminalSocket`. */
let sender: ((message: ClientMessage) => boolean) | null = null;
export function setStoreSender(fn: ((message: ClientMessage) => boolean) | null): void {
  sender = fn;
}
function sendMessage(message: ClientMessage): boolean {
  return sender?.(message) ?? false;
}
let aiRequestCounter = 0;

export function initialState(): TerminalState {
  return {
    connection: { kind: "connecting", attempt: 1 },
    hello: null,
    session: null,
    instruments: {},
    selection: { venue: "replay", symbol: DEFAULT_SYMBOL, timeframe: DEFAULT_TIMEFRAME },
    candles: {},
    indicators: {},
    seriesVersion: {},
    indicatorToggles: DEFAULT_INDICATOR_TOGGLES,
    lastTrade: {},
    tape: {},
    nextTapeId: 1,
    book: {},
    tickers: {},
    venueStatus: {},
    pairHealth: {},
    referenceVenue: {},
    balances: {},
    startingBalance: null,
    providers: EMPTY_PROVIDERS,
    news: { available: false, items: [], updatedAt: null },
    newsEnabled: false,
    twaps: {},
    ai: EMPTY_AI,
    ticket: { symbol: DEFAULT_SYMBOL, side: null, price: null, qty: null },
    bookCursor: null,
    notices: [],
    dataAccountId: null,
    positions: {},
    realizedBySymbol: {},
    openOrders: {},
    fills: [],
    pendingPlacements: [],
    lastRequestId: null,
    preview: null,
    parseError: null,
    rejections: [],
    commandHistory: [],
    confirmAction: null,
    badFrames: 0,
    lastError: null,
  };
}

// ---------------------------------------------------------------------------------------------
// Account panels and the command bar (Task 12.3, Req 22, 28, 30, 31)

/** True when an account event belongs to the account this client shows. */
function isOwnAccount(state: TerminalState, accountId: AccountId): boolean {
  const expected = state.session?.accountId ?? state.dataAccountId;
  return expected === null || expected === accountId;
}

/** Drops everything that belongs to one account: positions, orders, fills, previews, dialogs. */
export function clearAccountData(state: TerminalState): TerminalState {
  return {
    ...state,
    positions: {},
    realizedBySymbol: {},
    openOrders: {},
    fills: [],
    pendingPlacements: [],
    balances: {},
    preview: null,
    parseError: null,
    confirmAction: null,
  };
}

function withRejection(state: TerminalState, entry: RejectionEntry): TerminalState {
  return { ...state, rejections: [entry, ...state.rejections].slice(0, MAX_REJECTIONS) };
}

/** Shows a client-side problem (an incomplete ticket) the same way as a server rejection. */
export function withRejectionAdded(state: TerminalState, reason: string): TerminalState {
  return withRejection(state, { orderId: null, reason });
}

/** Applies a `position` event: replaces the symbol's row, or drops it when the position is flat. */
export function applyPositionEvent(
  state: TerminalState,
  event: Extract<Event, { type: "position" }>,
): TerminalState {
  if (!isOwnAccount(state, event.account_id) || !INTEGER.test(event.qty)) return state;
  const positions = { ...state.positions };
  if (BigInt(event.qty) === 0n) {
    delete positions[event.symbol];
  } else {
    positions[event.symbol] = {
      symbol: event.symbol,
      qty: event.qty,
      avgEntry: event.avg_entry,
      realized: event.realized,
      unrealized: event.unrealized,
    };
  }
  return {
    ...state,
    positions,
    realizedBySymbol: { ...state.realizedBySymbol, [event.symbol]: { realized: event.realized } },
  };
}

/** Applies an `order_ack`: accepted opens a row, canceled or filled removes it. */
export function applyOrderAckEvent(
  state: TerminalState,
  event: Extract<Event, { type: "order_ack" }>,
): TerminalState {
  if (!isOwnAccount(state, event.account_id)) return state;
  if (event.status !== "accepted") {
    if (!(event.order_id in state.openOrders)) return state;
    const openOrders = { ...state.openOrders };
    delete openOrders[event.order_id];
    return { ...state, openOrders };
  }
  if (event.order_id in state.openOrders) return state;
  const [pending, ...rest] = state.pendingPlacements;
  const row: OrderRow =
    pending === undefined
      ? {
          orderId: event.order_id,
          symbol: null,
          side: null,
          kind: null,
          price: null,
          qty: "0",
          filled: "0",
          remaining: "0",
        }
      : {
          orderId: event.order_id,
          symbol: pending.symbol,
          side: pending.side,
          kind: pending.kind,
          price: pending.price,
          qty: pending.qty,
          filled: "0",
          remaining: pending.qty,
        };
  return {
    ...state,
    pendingPlacements: pending === undefined ? state.pendingPlacements : rest,
    openOrders: { ...state.openOrders, [event.order_id]: row },
  };
}

/** Applies a `fill`: adds it to the recent list and updates the order's filled and remaining. */
export function applyFillEvent(
  state: TerminalState,
  event: Extract<Event, { type: "fill" }>,
): TerminalState {
  if (!isOwnAccount(state, event.account_id)) return state;
  const fill: FillRow = {
    orderId: event.order_id,
    symbol: event.symbol,
    side: event.side,
    price: event.price,
    qty: event.qty,
    fee: event.fee,
    ts: event.ts,
  };
  const fills = [fill, ...state.fills].slice(0, MAX_FILLS);
  const order = state.openOrders[event.order_id];
  if (order === undefined) return { ...state, fills };
  const filled = addUnits(order.filled, event.qty);
  const updated: OrderRow = {
    ...order,
    symbol: order.symbol ?? event.symbol,
    side: order.side ?? event.side,
    filled,
    remaining: event.remaining,
    qty: order.qty === "0" ? addUnits(filled, event.remaining) : order.qty,
  };
  return { ...state, fills, openOrders: { ...state.openOrders, [event.order_id]: updated } };
}

/**
 * Applies an `order_rejected`: shows the reason (Req 30.6). A rejection of an order that is not
 * open is a rejected new order, so it also drops the oldest confirmed placement that is still
 * waiting for an ack. (A rejected cancel of an order that just filled drops one by mistake; the
 * only effect is a missing label on the next open order.)
 */
export function applyOrderRejectedEvent(
  state: TerminalState,
  event: Extract<Event, { type: "order_rejected" }>,
): TerminalState {
  if (!isOwnAccount(state, event.account_id)) return state;
  const next = withRejection(state, { orderId: event.order_id, reason: event.reason });
  if (event.order_id in state.openOrders || state.pendingPlacements.length === 0) return next;
  return { ...next, pendingPlacements: state.pendingPlacements.slice(1) };
}

/** Adds a placement to the queue that `order_ack` reads, from a confirmed preview action. */
export function placementFromAction(action: PreviewAction): PendingPlacement | null {
  if (action.type !== "place") return null;
  return {
    symbol: action.symbol,
    side: action.side,
    kind: action.kind.type,
    price:
      action.kind.type === "limit"
        ? action.kind.price
        : action.kind.type === "stop"
          ? action.kind.stop_price
          : null,
    qty: action.qty,
  };
}

/** Remembers a sent command text (history gets `text` unless it is null) and its request id. */
export function withCommandSent(
  state: TerminalState,
  requestId: string,
  text: string | null,
): TerminalState {
  return {
    ...state,
    lastRequestId: requestId,
    preview: null,
    parseError: null,
    commandHistory: text === null ? state.commandHistory : pushHistory(state.commandHistory, text),
  };
}

/** The user confirmed the preview: close it and queue a `place` for its ack. */
export function withPreviewConfirmed(state: TerminalState): TerminalState {
  if (state.preview === null) return state;
  const placement = placementFromAction(state.preview.preview.action);
  return {
    ...state,
    preview: null,
    pendingPlacements:
      placement === null
        ? state.pendingPlacements
        : [...state.pendingPlacements, placement].slice(-MAX_PENDING_PLACEMENTS),
  };
}

export function withPreviewCleared(state: TerminalState): TerminalState {
  return state.preview === null ? state : { ...state, preview: null };
}

export function withParseErrorCleared(state: TerminalState): TerminalState {
  return state.parseError === null ? state : { ...state, parseError: null };
}

export function withConfirmRequested(state: TerminalState, action: ConfirmAction): TerminalState {
  // A pending preview is dropped (the server lets it expire) so only one dialog is ever open.
  return { ...state, confirmAction: action, preview: null };
}

export function withConfirmCleared(state: TerminalState): TerminalState {
  return state.confirmAction === null ? state : { ...state, confirmAction: null };
}

export function withRejectionsCleared(state: TerminalState): TerminalState {
  return state.rejections.length === 0 ? state : { ...state, rejections: [] };
}

/** Sets or clears (null = market order) the ticket's limit price in ticks. */
export function withTicketPrice(state: TerminalState, price: string | null): TerminalState {
  return state.ticket.price === price ? state : { ...state, ticket: { ...state.ticket, price } };
}

/** Sets the ticket quantity in lots. */
export function withTicketQty(state: TerminalState, qty: string | null): TerminalState {
  return state.ticket.qty === qty ? state : { ...state, ticket: { ...state.ticket, qty } };
}

// ---------------------------------------------------------------------------------------------
// Selection

export function withSymbol(state: TerminalState, symbol: string): TerminalState {
  if (state.selection.symbol === symbol) return state;
  // The ticket follows the selection: a price from another symbol's book and a quantity counted
  // in that symbol's lots must not carry over (Req 30.1, 30.2).
  const ticket =
    state.ticket.symbol === symbol
      ? state.ticket
      : { symbol, side: state.ticket.side, price: null, qty: null };
  return { ...state, selection: { ...state.selection, symbol }, bookCursor: null, ticket };
}

/** Picks the venue the panels show. The book cursor belongs to the old book, so it resets. */
export function withVenue(state: TerminalState, venue: Venue): TerminalState {
  if (state.selection.venue === venue) return state;
  return { ...state, selection: { ...state.selection, venue }, bookCursor: null };
}

// ---------------------------------------------------------------------------------------------
// Order book and ticket

/** Sets the ticket's symbol and limit price; other ticket fields stay (Req 30.1). */
export function prefillTicketFromBook(
  state: TerminalState,
  symbol: string,
  price: string,
): TerminalState {
  return { ...state, ticket: { ...state.ticket, symbol, price } };
}

/** Moves the book cursor over the selected symbol's displayed levels. */
export function withBookCursorMoved(
  state: TerminalState,
  direction: CursorDirection,
): TerminalState {
  const book = state.book[pairKey(state.selection.venue, state.selection.symbol)];
  const next = moveBookCursor(
    state.bookCursor,
    Math.min(book?.asks.length ?? 0, BOOK_LEVELS),
    Math.min(book?.bids.length ?? 0, BOOK_LEVELS),
    direction,
  );
  return next === state.bookCursor ? state : { ...state, bookCursor: next };
}

export function withTimeframe(state: TerminalState, timeframe: Timeframe): TerminalState {
  if (state.selection.timeframe === timeframe) return state;
  return { ...state, selection: { ...state.selection, timeframe } };
}

// ---------------------------------------------------------------------------------------------
// Candles

/** The last `max` items of `items` (all of them when there are fewer). */
function tail<T>(items: readonly T[], max: number): readonly T[] {
  return items.length > max ? items.slice(items.length - max) : items;
}

/**
 * Merges one live bar into an ascending list: a bar with the same `t` replaces the existing one,
 * a newer bar is appended, and an older bar with no match is inserted in order. The result keeps
 * at most `MAX_CANDLES` bars.
 */
export function mergeBar(bars: readonly Bar[], bar: Bar): readonly Bar[] {
  const last = bars[bars.length - 1];
  if (last === undefined || bar.t > last.t) return tail([...bars, bar], MAX_CANDLES);
  for (let i = bars.length - 1; i >= 0; i -= 1) {
    const existing = bars[i];
    if (existing === undefined) continue;
    if (existing.t === bar.t) {
      const next = bars.slice();
      next[i] = bar;
      return next;
    }
    if (existing.t < bar.t) {
      return tail([...bars.slice(0, i + 1), bar, ...bars.slice(i + 1)], MAX_CANDLES);
    }
  }
  return tail([bar, ...bars], MAX_CANDLES);
}

/** Sorts ascending by `t`, keeps the last of equal `t`, and keeps the newest `max`. */
function normalizeByTime<T extends { readonly t: number }>(items: readonly T[], max: number): readonly T[] {
  const byTime = new Map<number, T>();
  for (const item of items) byTime.set(item.t, item);
  return tail([...byTime.values()].sort((a, b) => a.t - b.t), max);
}

/**
 * The snapshot's indicator history. The wire data is still untrusted at runtime, so malformed
 * points are skipped.
 */
function snapshotIndicatorPoints(
  event: Extract<Event, { type: "candle" }>,
): readonly IndicatorPoint[] {
  const raw = event.indicators;
  if (!Array.isArray(raw)) return [];
  const points: IndicatorPoint[] = [];
  for (const item of raw as readonly unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const { t, values } = item as { readonly t?: unknown; readonly values?: unknown };
    if (typeof t !== "number" || !Number.isFinite(t) || t < 0) continue;
    if (typeof values !== "object" || values === null) continue;
    points.push({ t: bucketStartMs(t, event.timeframe), values: values as IndicatorPoint["values"] });
  }
  return normalizeByTime(points, MAX_INDICATOR_POINTS);
}

/**
 * Applies a `candle` event. A snapshot replaces the bars and the indicator points together and
 * bumps `seriesVersion.snapshot`. A live event merges each bar; a bar older than the newest stored
 * bar bumps `seriesVersion.rewrite` (Req 2.7, 2.8, 3.2).
 */
export function applyCandleEvent(
  state: TerminalState,
  event: Extract<Event, { type: "candle" }>,
): TerminalState {
  const incoming = Array.isArray(event.bars) ? event.bars : [];
  const key = candleKey(event.venue, event.symbol, event.timeframe);
  const version = state.seriesVersion[key] ?? { snapshot: 0, rewrite: 0 };
  if (event.snapshot) {
    return {
      ...state,
      candles: { ...state.candles, [key]: normalizeByTime(incoming, MAX_CANDLES) },
      indicators: { ...state.indicators, [key]: snapshotIndicatorPoints(event) },
      seriesVersion: {
        ...state.seriesVersion,
        [key]: { snapshot: version.snapshot + 1, rewrite: version.rewrite },
      },
    };
  }
  let bars: readonly Bar[] = state.candles[key] ?? [];
  let rewrites = 0;
  for (const bar of incoming) {
    const newest = bars[bars.length - 1];
    if (newest !== undefined && bar.t < newest.t) rewrites += 1;
    bars = mergeBar(bars, bar);
  }
  return {
    ...state,
    candles: { ...state.candles, [key]: bars },
    seriesVersion:
      rewrites === 0
        ? state.seriesVersion
        : { ...state.seriesVersion, [key]: { snapshot: version.snapshot, rewrite: version.rewrite + rewrites } },
  };
}

// ---------------------------------------------------------------------------------------------
// Indicators (Task 9.3, Req 26)

/**
 * Merges one indicator point into an ascending list by `t`: the same `t` replaces the existing
 * point, otherwise the point is inserted in time order. Keeps at most `MAX_INDICATOR_POINTS`
 * (the newest).
 */
export function mergeIndicatorPoint(
  points: readonly IndicatorPoint[],
  point: IndicatorPoint,
): readonly IndicatorPoint[] {
  const last = points[points.length - 1];
  if (last === undefined || point.t > last.t) return tail([...points, point], MAX_INDICATOR_POINTS);
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const existing = points[i];
    if (existing === undefined) continue;
    if (existing.t === point.t) {
      const next = points.slice();
      next[i] = point;
      return next;
    }
    if (existing.t < point.t) {
      return tail(
        [...points.slice(0, i + 1), point, ...points.slice(i + 1)],
        MAX_INDICATOR_POINTS,
      );
    }
  }
  return tail([point, ...points], MAX_INDICATOR_POINTS);
}

/** Applies an `indicators` event to the list of its symbol and timeframe. */
export function applyIndicatorsEvent(
  state: TerminalState,
  event: Extract<Event, { type: "indicators" }>,
): TerminalState {
  if (typeof event.ts !== "number" || !Number.isFinite(event.ts) || event.ts < 0) return state;
  const key = candleKey(event.venue, event.symbol, event.timeframe);
  // One point per candle bucket, keyed by the candle open time; the latest values win.
  const points = mergeIndicatorPoint(state.indicators[key] ?? [], {
    t: bucketStartMs(event.ts, event.timeframe),
    values: event.values,
  });
  return { ...state, indicators: { ...state.indicators, [key]: points } };
}

/** Flips one indicator toggle. */
export function withIndicatorToggled(state: TerminalState, name: IndicatorName): TerminalState {
  return {
    ...state,
    indicatorToggles: { ...state.indicatorToggles, [name]: !state.indicatorToggles[name] },
  };
}

// ---------------------------------------------------------------------------------------------
// Server messages

/** Applies one engine event. */
export function applyEvent(state: TerminalState, event: Event): TerminalState {
  switch (event.type) {
    case "candle":
      return applyCandleEvent(state, event);
    case "trade": {
      const entry: TapeEntry = {
        id: state.nextTapeId,
        venue: event.venue,
        symbol: event.symbol,
        price: event.price,
        qty: event.qty,
        side: event.side,
        ts: event.ts,
      };
      const key = pairKey(event.venue, event.symbol);
      return {
        ...state,
        nextTapeId: state.nextTapeId + 1,
        lastTrade: { ...state.lastTrade, [key]: entry },
        tape: { ...state.tape, [key]: [entry, ...(state.tape[key] ?? [])].slice(0, MAX_TAPE) },
      };
    }
    case "error": {
      const next = { ...state, lastError: `server error ${event.code}: ${event.message}` };
      // A refused confirm, cancel, cancel-all, or flatten-all arrives as invalid_command (Req 30.6).
      return event.code === "invalid_command"
        ? withRejection(next, { orderId: null, reason: event.message })
        : next;
    }
    case "book":
      return {
        ...state,
        book: {
          ...state.book,
          [pairKey(event.venue, event.symbol)]: {
            bids: Array.isArray(event.bids) ? event.bids : [],
            asks: Array.isArray(event.asks) ? event.asks : [],
            spread: event.spread,
            imbalanceBps: event.imbalance_bps,
            ts: event.ts,
          },
        },
      };
    case "indicators":
      return applyIndicatorsEvent(state, event);
    case "order_ack":
      return applyOrderAckEvent(state, event);
    case "order_rejected":
      return applyOrderRejectedEvent(state, event);
    case "fill":
      return applyFillEvent(state, event);
    case "position":
      return applyPositionEvent(state, event);
    case "ticker24h":
      return {
        ...state,
        tickers: {
          ...state.tickers,
          [pairKey(event.venue, event.symbol)]: { ticker: event.ticker, synthetic: event.synthetic, ts: event.ts },
        },
      };
    case "venue_status":
      return state.venueStatus[event.venue] === event.status
        ? state
        : { ...state, venueStatus: { ...state.venueStatus, [event.venue]: event.status } };
    case "pair_status":
      return {
        ...state,
        pairHealth: { ...state.pairHealth, [pairKey(event.venue, event.symbol)]: event.health },
      };
    case "reference_venue":
      return { ...state, referenceVenue: { ...state.referenceVenue, [event.symbol]: event.venue } };
    case "balance":
      if (!isOwnAccount(state, event.account_id)) return state;
      return {
        ...state,
        balances: {
          ...state.balances,
          [event.account_id]: {
            paperBalance: event.paper_balance,
            freeBalance: event.free_balance,
            equity: event.equity,
            ts: event.ts,
          },
        },
      };
    case "heartbeat":
      return state;
    case "pong":
      recordPong(event.id);
      return state;
  }
}

/** Applies one decoded server message. */
export function applyServerMessage(state: TerminalState, message: ServerMessage): TerminalState {
  switch (message.type) {
    case "hello": {
      const list = Array.isArray(message.instruments) ? message.instruments : [];
      const liveVenues = Array.isArray(message.live_venues) ? message.live_venues : [];
      const statuses = Array.isArray(message.venue_status) ? message.venue_status : [];
      const available: readonly Venue[] = liveVenues.length > 0 ? liveVenues : [message.default_venue];
      // Keep the user's venue across a reconnect while the server still offers it.
      const venue = available.includes(state.selection.venue) ? state.selection.venue : message.default_venue;
      const providers = Array.isArray(message.providers) ? message.providers : [];
      return {
        ...state,
        selection: venue === state.selection.venue ? state.selection : { ...state.selection, venue },
        bookCursor: venue === state.selection.venue ? state.bookCursor : null,
        venueStatus: Object.fromEntries(statuses.map((entry): [Venue, VenueStatusKind] => [entry.venue, entry.status])),
        startingBalance: message.starting_balance,
        newsEnabled: message.news_enabled === true,
        providers: {
          available: providers,
          default: state.providers.default,
          selected: state.providers.selected,
        },
        hello: {
          protocolVersion: message.protocol_version,
          dataMode: message.data_mode,
          venue: message.data_mode === "live" ? message.default_venue : null,
          liveVenues: Array.isArray(message.live_venues) ? message.live_venues : [],
          defaultVenue: message.default_venue,
          engineRunning: message.engine_running,
        },
        instruments: Object.fromEntries(list.map((info): [string, InstrumentInfo] => [info.symbol, info])),
      };
    }
    case "session": {
      const changed = state.dataAccountId !== null && state.dataAccountId !== message.account_id;
      const next: TerminalState = {
        ...state,
        session: { accountId: message.account_id, address: message.address },
        dataAccountId: message.account_id,
      };
      // A different account: nothing of the old one stays on screen (Req 46.4).
      return changed ? { ...clearAccountData(next), rejections: [] } : next;
    }
    case "event":
      return applyEvent(state, message.event);
    case "event_batch":
      // The server may batch events; they apply in the order the engine emitted them (Req 34.1).
      // The reducer is pure, so the caller commits the whole batch with one `set`.
      return Array.isArray(message.events)
        ? message.events.reduce<TerminalState>((acc, wire) => applyEvent(acc, wire), state)
        : state;
    case "providers":
      return {
        ...state,
        providers: { available: message.available, default: message.default, selected: message.selected },
      };
    case "analysis":
      return {
        ...state,
        ai: {
          ...state.ai,
          analyses: addCapped(state.ai.analyses, message.request_id, {
            requestId: message.request_id,
            provider: message.provider,
            model: message.model,
            analysis: message.analysis,
            preview: message.preview,
            previewError: message.preview_error,
          }),
        },
      };
    case "scan_result":
      return {
        ...state,
        ai: {
          ...state.ai,
          scans: addCapped(state.ai.scans, message.request_id, { requestId: message.request_id, items: message.items }),
        },
      };
    case "strategy_draft":
      return {
        ...state,
        ai: {
          ...state.ai,
          strategies: addCapped(state.ai.strategies, message.request_id, {
            requestId: message.request_id,
            text: message.text,
          }),
        },
      };
    case "ai_error":
      return {
        ...state,
        ai: {
          ...state.ai,
          errors: addCapped(state.ai.errors, message.request_id, {
            requestId: message.request_id,
            reason: message.reason,
            message: message.message,
          }),
        },
      };
    case "news":
      return {
        ...state,
        news: {
          available: message.available,
          items: Array.isArray(message.items) ? message.items.slice(0, MAX_NEWS) : [],
          updatedAt: message.updated_at,
        },
      };
    case "twap":
      return {
        ...state,
        twaps: {
          ...state.twaps,
          [message.twap_id]: {
            twapId: message.twap_id,
            symbol: message.symbol,
            side: message.side,
            venue: message.venue,
            slices: message.slices,
            sent: message.sent,
            status: message.status,
            reason: message.reason,
          },
        },
      };
    case "notice": {
      // The stored token is cleared on auth_failed, session_expired, and signed_out by the socket
      // layer (socket.ts), not here, so this reducer stays pure.
      const notices = [...state.notices, { kind: message.kind, message: message.message }];
      const base = { ...state, notices: tail(notices, MAX_NOTICES) };
      // The engine restarted: every paper account is flat again (Req 15.7).
      return message.kind === "account_reset" ? clearAccountData(base) : base;
    }
    case "preview":
      if (state.lastRequestId !== message.request_id) return state;
      return {
        ...state,
        preview: { requestId: message.request_id, preview: message.preview },
        parseError: null,
      };
    case "parse_error":
      if (state.lastRequestId !== message.request_id) return state;
      return {
        ...state,
        preview: null,
        parseError: {
          requestId: message.request_id,
          message: message.message,
          position: message.position,
        },
      };
    case "pong":
      recordPong(message.id);
      return state;
  }
}

// ---------------------------------------------------------------------------------------------
// Connection events

/** Applies one event from the socket: a connection change, a bad frame, or a server message. */
export function applySocketEvent(state: TerminalState, event: SocketEvent): TerminalState {
  switch (event.type) {
    case "connecting":
      return {
        ...state,
        connection:
          event.nextDelayMs === 0
            ? { kind: "connecting", attempt: event.attempt }
            : { kind: "waking", attempt: event.attempt, nextDelayMs: event.nextDelayMs },
      };
    case "open":
      // Req 33.3: candles stay; the resubscribe brings a fresh snapshot that replaces them.
      // A preview and a dialog belong to the old connection (the server drops its previews on close).
      return {
        ...state,
        connection: { kind: "connected" },
        hello: null,
        session: null,
        preview: null,
        parseError: null,
        confirmAction: null,
        pendingPlacements: [],
      };
    case "closed":
      return {
        ...state,
        connection: { kind: "disconnected", reason: event.reason },
        lastError: event.reason,
      };
    case "bad_frame":
      return {
        ...state,
        badFrames: state.badFrames + 1,
        lastError: `bad frame: ${event.error}`,
      };
    case "message":
      return applyServerMessage(state, event.message);
  }
}

// ---------------------------------------------------------------------------------------------
// Store

export const useTerminalStore = create<TerminalStore>()((set) => ({
  ...initialState(),
  handleSocketEvent: (event) => set((state) => applySocketEvent(state, event)),
  selectSymbol: (symbol) => set((state) => withSymbol(state, symbol)),
  selectVenue: (venue) => set((state) => withVenue(state, venue)),
  setProvider: (provider) => sendMessage({ type: "set_provider", provider }),
  sendAiRequest: (action, text) => {
    const { venue, symbol, timeframe } = useTerminalStore.getState().selection;
    aiRequestCounter += 1;
    const requestId = `ai-${Date.now().toString(36)}-${aiRequestCounter}`;
    const sent = sendMessage({ type: "ai_request", request_id: requestId, action, text, symbol, timeframe, venue });
    return sent ? requestId : null;
  },
  cancelTwap: (twapId) => sendMessage({ type: "cancel_twap", request_id: `twap-${twapId}`, twap_id: twapId }),
  subscribeNews: () => sendMessage({ type: "subscribe_news" }),
  selectTimeframe: (timeframe) => set((state) => withTimeframe(state, timeframe)),
  prefillLimit: (symbol, priceTicks) =>
    set((state) => prefillTicketFromBook(state, symbol, priceTicks)),
  moveBookCursor: (direction) => set((state) => withBookCursorMoved(state, direction)),
  setBookCursor: (cursor) => set({ bookCursor: cursor }),
  toggleIndicator: (name) => set((state) => withIndicatorToggled(state, name)),
  setTicketQty: (qtyLots) => set((state) => withTicketQty(state, qtyLots)),
  setTicketPrice: (priceTicks) => set((state) => withTicketPrice(state, priceTicks)),
  commandSent: (requestId, text) => set((state) => withCommandSent(state, requestId, text)),
  previewConfirmed: () => set((state) => withPreviewConfirmed(state)),
  clearPreview: () => set((state) => withPreviewCleared(state)),
  clearParseError: () => set((state) => withParseErrorCleared(state)),
  requestConfirm: (action) => set((state) => withConfirmRequested(state, action)),
  clearConfirm: () => set((state) => withConfirmCleared(state)),
  dismissRejections: () => set((state) => withRejectionsCleared(state)),
  addRejection: (reason) => set((state) => withRejectionAdded(state, reason)),
}));
