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
  Bar,
  DataMode,
  Event,
  InstrumentInfo,
  Level,
  NoticeKind,
  ServerMessage,
  Side,
  Timeframe,
  Venue,
} from "../../shared/protocol/index";
import { BOOK_LEVELS, moveBookCursor, type CursorDirection } from "./bookView";
import {
  DEFAULT_INDICATOR_TOGGLES,
  MAX_INDICATOR_POINTS,
  type IndicatorName,
  type IndicatorPoint,
  type IndicatorToggles,
} from "./indicatorData";
import type { SocketEvent } from "./socket";

/** Most candles kept per symbol and timeframe (matches the server's history snapshot, Req 8.7). */
export const MAX_CANDLES = 500;
/** Most trades kept in the tape, newest first. */
export const MAX_TAPE = 200;
/** Most notices kept, oldest first. */
export const MAX_NOTICES = 20;
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
  readonly venue: Venue | null;
  readonly engineRunning: boolean;
}

/** The connection's account, from the server's `session` message. */
export interface SessionInfo {
  readonly accountId: AccountId;
  readonly address: string | null;
}

export interface Selection {
  readonly symbol: string;
  readonly timeframe: Timeframe;
}

/** One trade as shown in the tape and the last-trade readout. */
export interface TapeEntry {
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
  /** Which indicators the chart shows (Req 26.3). */
  readonly indicatorToggles: IndicatorToggles;
  /** The most recent trade per symbol. */
  readonly lastTrade: Readonly<Record<string, TapeEntry>>;
  /** Recent trades, newest first, at most `MAX_TAPE`. */
  readonly tape: readonly TapeEntry[];
  /** Latest order book per symbol. */
  readonly book: Readonly<Record<string, BookState>>;
  readonly ticket: TicketState;
  /** Keyboard cursor on the selected symbol's book; null when none. */
  readonly bookCursor: BookCursor | null;
  readonly notices: readonly NoticeEntry[];
  /** Frames that were not valid messages, over all connections. */
  readonly badFrames: number;
  readonly lastError: string | null;
}

export interface TerminalActions {
  handleSocketEvent(event: SocketEvent): void;
  selectSymbol(symbol: string): void;
  selectTimeframe(timeframe: Timeframe): void;
  /** Prefills the limit ticket with a book price (ticks as received). */
  prefillLimit(symbol: string, priceTicks: string): void;
  /** Moves the book cursor up or down (Req 30.1). */
  moveBookCursor(direction: CursorDirection): void;
  setBookCursor(cursor: BookCursor | null): void;
  /** Flips one indicator toggle (Req 26.3: hotkey or click). */
  toggleIndicator(name: IndicatorName): void;
}

export type TerminalStore = TerminalState & TerminalActions;

/** Key of the `candles` record for one symbol and timeframe. */
export function candleKey(symbol: string, timeframe: Timeframe): string {
  return `${symbol}|${timeframe}`;
}

export function initialState(): TerminalState {
  return {
    connection: { kind: "connecting", attempt: 1 },
    hello: null,
    session: null,
    instruments: {},
    selection: { symbol: DEFAULT_SYMBOL, timeframe: DEFAULT_TIMEFRAME },
    candles: {},
    indicators: {},
    indicatorToggles: DEFAULT_INDICATOR_TOGGLES,
    lastTrade: {},
    tape: [],
    book: {},
    ticket: { symbol: DEFAULT_SYMBOL, side: null, price: null, qty: null },
    bookCursor: null,
    notices: [],
    badFrames: 0,
    lastError: null,
  };
}

// ---------------------------------------------------------------------------------------------
// Selection

export function withSymbol(state: TerminalState, symbol: string): TerminalState {
  if (state.selection.symbol === symbol) return state;
  return { ...state, selection: { ...state.selection, symbol }, bookCursor: null };
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
  const book = state.book[state.selection.symbol];
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

/** Applies a `candle` event: a snapshot replaces the list, a live event merges each bar. */
export function applyCandleEvent(
  state: TerminalState,
  event: Extract<Event, { type: "candle" }>,
): TerminalState {
  const incoming = Array.isArray(event.bars) ? event.bars : [];
  const key = candleKey(event.symbol, event.timeframe);
  let bars: readonly Bar[];
  if (event.snapshot) {
    bars = tail(incoming, MAX_CANDLES);
  } else {
    bars = state.candles[key] ?? [];
    for (const bar of incoming) bars = mergeBar(bars, bar);
  }
  return { ...state, candles: { ...state.candles, [key]: bars } };
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
  if (typeof event.ts !== "number" || !Number.isFinite(event.ts)) return state;
  const key = candleKey(event.symbol, event.timeframe);
  const points = mergeIndicatorPoint(state.indicators[key] ?? [], {
    t: event.ts,
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
        symbol: event.symbol,
        price: event.price,
        qty: event.qty,
        side: event.side,
        ts: event.ts,
      };
      return {
        ...state,
        lastTrade: { ...state.lastTrade, [event.symbol]: entry },
        tape: [entry, ...state.tape].slice(0, MAX_TAPE),
      };
    }
    case "error":
      return { ...state, lastError: `server error ${event.code}: ${event.message}` };
    case "book":
      return {
        ...state,
        book: {
          ...state.book,
          [event.symbol]: {
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
    case "order_rejected":
    case "fill":
    case "position":
      // TODO(Task 12): keep open orders, fills, and positions for the account panels.
      return state;
    case "heartbeat":
    case "pong":
      return state;
  }
}

/** Applies one decoded server message. */
export function applyServerMessage(state: TerminalState, message: ServerMessage): TerminalState {
  switch (message.type) {
    case "hello": {
      const list = Array.isArray(message.instruments) ? message.instruments : [];
      return {
        ...state,
        hello: {
          protocolVersion: message.protocol_version,
          dataMode: message.data_mode,
          venue: message.venue,
          engineRunning: message.engine_running,
        },
        instruments: Object.fromEntries(list.map((info): [string, InstrumentInfo] => [info.symbol, info])),
      };
    }
    case "session":
      return { ...state, session: { accountId: message.account_id, address: message.address } };
    case "event":
      return applyEvent(state, message.event);
    case "notice": {
      // The stored token is cleared on auth_failed, session_expired, and signed_out by the socket
      // layer (socket.ts), not here, so this reducer stays pure.
      const notices = [...state.notices, { kind: message.kind, message: message.message }];
      return { ...state, notices: tail(notices, MAX_NOTICES) };
    }
    case "preview":
    case "parse_error":
      // TODO(Task 12): hold the pending Order_Preview and parse errors for the command bar.
      return state;
    case "pong":
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
      return { ...state, connection: { kind: "connected" }, hello: null, session: null };
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
  selectTimeframe: (timeframe) => set((state) => withTimeframe(state, timeframe)),
  prefillLimit: (symbol, priceTicks) =>
    set((state) => prefillTicketFromBook(state, symbol, priceTicks)),
  moveBookCursor: (direction) => set((state) => withBookCursorMoved(state, direction)),
  setBookCursor: (cursor) => set({ bookCursor: cursor }),
  toggleIndicator: (name) => set((state) => withIndicatorToggled(state, name)),
}));
