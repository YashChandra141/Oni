// WebSocket client for the Web UI: connect, reconnect with backoff, resubscribe, ping
// (Req 33.1-33.3). It mirrors rust/crates/tui/src/net.rs, and it has no React, no DOM globals,
// and no real timers of its own: the WebSocket constructor and the timer functions are injected,
// so tests drive it with a fake socket and a manual scheduler.
//
// - Backoff (Req 33.2): 250 ms doubling, capped at 10 s (see backoff.ts). It resets when the
//   server's `hello` arrives, not when the socket opens.
// - Subscriptions (Req 33.3): every `subscribe` and `unsubscribe` updates a deduplicated set, and
//   the whole set is sent again right after every (re)connect, before anything else goes out.
// - Offline messages: while there is no open socket, `send` only updates the subscription set.
//   Everything else (confirms, cancels, pings) is dropped, not queued, so it is never replayed
//   against a server the user can no longer see.
// - Bad frames: anything that is not a JSON object with a string `type` is reported as a
//   `bad_frame` event and skipped. Nothing here throws on server input.
//
// - Authenticate (Req 33.4): when `deps.tokens` holds a token, `authenticate` is sent right after
//   every `hello`. A notice `auth_failed`, `session_expired`, or `signed_out` clears the stored
//   token (done here, not in the store reducer, so the reducers stay pure).

import type { ClientMessage, ServerMessage, Timeframe, Venue } from "../../shared/protocol/index";
import type { TokenSource } from "./auth";
import { createBackoff, nextDelay, resetBackoff } from "./backoff";

/**
 * The venue every web subscription names. Protocol v3 subscriptions carry a venue; the venue
 * picker and the per-venue panels arrive in Task 14.3, so the web UI uses `replay` until then.
 */
export const WEB_VENUE: Venue = "replay";

/** How often the client sends a `ping` while the socket is open. */
export const PING_INTERVAL_MS = 15_000;
/** Longest accepted text frame, in UTF-16 code units. Longer frames count as bad frames. */
export const MAX_FRAME_CHARS = 1 << 20;
/** `WebSocket.OPEN`. */
export const WS_OPEN = 1;

/** What the socket reports to its owner (the store, through `useTerminalSocket`). */
export type SocketEvent =
  /** Attempt `attempt` starts after `nextDelayMs` (0 for an immediate attempt). */
  | { readonly type: "connecting"; readonly attempt: number; readonly nextDelayMs: number }
  /** The WebSocket is open and the subscriptions have been resent. */
  | { readonly type: "open" }
  /** A decoded message from the server. */
  | { readonly type: "message"; readonly message: ServerMessage }
  /** A frame that was not a JSON object with a string `type`; it was skipped. */
  | { readonly type: "bad_frame"; readonly error: string }
  /** A connection attempt failed or the open connection was lost. */
  | { readonly type: "closed"; readonly reason: string };

/** The part of the DOM `WebSocket` that this module uses. */
export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: ((event: { readonly code?: number; readonly reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface SocketDeps {
  readonly onEvent: (event: SocketEvent) => void;
  /** Opens a WebSocket. May throw (for example on a malformed URL); that counts as a failed attempt. */
  readonly createWebSocket: (url: string) => WebSocketLike;
  /** Like `setTimeout`; the handle is opaque. */
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  /** The stored Session_Token, when sign-in is wired up. Optional so tests can omit it. */
  readonly tokens?: TokenSource;
}

/** Notice kinds after which the stored token is no longer valid (Req 47.6, 46.3-46.5). */
export const TOKEN_CLEARING_NOTICES: readonly string[] = ["auth_failed", "session_expired", "signed_out"];

export interface Subscription {
  readonly venue: Venue;
  readonly symbol: string;
  readonly timeframe: Timeframe;
}

export interface TerminalSocket {
  /**
   * Sends a message. Subscribe, unsubscribe, ticker, and news messages always update the
   * subscription state that is resent after a reconnect. Returns true when the message went out
   * on an open socket, false when it was dropped.
   */
  send(message: ClientMessage): boolean;
  /** `venue` defaults to `WEB_VENUE`. */
  subscribe(symbol: string, timeframe: Timeframe, venue?: Venue): void;
  unsubscribe(symbol: string, timeframe: Timeframe, venue?: Venue): void;
  subscribeTicker(symbol: string, venue: Venue): void;
  unsubscribeTicker(symbol: string, venue: Venue): void;
  subscribeNews(): void;
  unsubscribeNews(): void;
  /** Stops reconnecting, cancels timers, and closes the socket. Idempotent; emits no events. */
  close(): void;
  /** True while a socket is open. */
  isOpen(): boolean;
  /** The active subscriptions, in the order they were first added. */
  subscriptions(): readonly Subscription[];
}

export type FrameResult =
  | { readonly ok: true; readonly message: ServerMessage }
  | { readonly ok: false; readonly error: string };

/**
 * Decodes one WebSocket frame. The check is shallow on purpose: the value must be a JSON object
 * with a string `type`. The cast to `ServerMessage` trusts the server for the rest.
 */
export function parseFrame(data: unknown): FrameResult {
  if (typeof data !== "string") return { ok: false, error: "unexpected binary frame" };
  if (data.length > MAX_FRAME_CHARS) return { ok: false, error: "frame too large" };
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return { ok: false, error: "invalid JSON" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "frame is not a JSON object" };
  }
  if (typeof (value as { type?: unknown }).type !== "string") {
    return { ok: false, error: "frame has no string type" };
  }
  return { ok: true, message: value as ServerMessage };
}

function subscriptionKey(venue: Venue, symbol: string, timeframe: Timeframe): string {
  return `${venue}|${symbol}|${timeframe}`;
}

function describeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

function closeReason(event: { readonly code?: number; readonly reason?: string }): string {
  const code = event.code === undefined ? "" : ` (${event.code})`;
  const reason = event.reason !== undefined && event.reason !== "" ? `: ${event.reason}` : "";
  const text = `connection closed${code}${reason}`;
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** Starts connecting to `url` at once and keeps the connection up until `close()`. */
export function createTerminalSocket(url: string, deps: SocketDeps): TerminalSocket {
  const subs = new Map<string, Subscription>();
  const tickerSubs = new Map<string, { readonly symbol: string; readonly venue: Venue }>();
  let newsSubscribed = false;
  let ws: WebSocketLike | null = null;
  let opened = false;
  let closed = false;
  let backoff = createBackoff();
  let attempt = 1;
  let pingId = 0;
  let reconnectTimer: { readonly handle: unknown } | null = null;
  let pingTimer: { readonly handle: unknown } | null = null;

  function clearReconnectTimer(): void {
    if (reconnectTimer !== null) deps.clearTimer(reconnectTimer.handle);
    reconnectTimer = null;
  }

  function clearPingTimer(): void {
    if (pingTimer !== null) deps.clearTimer(pingTimer.handle);
    pingTimer = null;
  }

  function detach(socket: WebSocketLike): void {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close();
    } catch {
      // Already closed or closing; nothing left to release.
    }
  }

  function transmit(message: ClientMessage): boolean {
    if (ws === null || !opened || ws.readyState !== WS_OPEN) return false;
    try {
      ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  function schedulePing(): void {
    pingTimer = {
      handle: deps.setTimer(() => {
        pingTimer = null;
        if (closed || !opened) return;
        pingId += 1;
        transmit({ type: "ping", id: pingId });
        schedulePing();
      }, PING_INTERVAL_MS),
    };
  }

  // The connection failed or dropped: report it and schedule the next attempt.
  function lost(reason: string): void {
    clearPingTimer();
    const old = ws;
    ws = null;
    opened = false;
    if (old !== null) detach(old);
    deps.onEvent({ type: "closed", reason });
    attempt += 1;
    const next = nextDelay(backoff);
    backoff = next.backoff;
    deps.onEvent({ type: "connecting", attempt, nextDelayMs: next.delayMs });
    reconnectTimer = { handle: deps.setTimer(connect, next.delayMs) };
  }

  function connect(): void {
    reconnectTimer = null;
    if (closed) return;
    let socket: WebSocketLike;
    try {
      socket = deps.createWebSocket(url);
    } catch (error) {
      lost(describeError(error));
      return;
    }
    ws = socket;
    opened = false;
    socket.onopen = () => {
      if (closed || ws !== socket) return;
      opened = true;
      deps.onEvent({ type: "open" });
      // Req 33.3: resubscribe before anything else goes out.
      for (const sub of subs.values()) {
        transmit({ type: "subscribe", venue: sub.venue, symbol: sub.symbol, timeframe: sub.timeframe });
      }
      for (const sub of tickerSubs.values()) {
        transmit({ type: "subscribe_ticker", symbol: sub.symbol, venue: sub.venue });
      }
      if (newsSubscribed) transmit({ type: "subscribe_news" });
      schedulePing();
    };
    socket.onmessage = (event) => {
      if (closed || ws !== socket) return;
      const frame = parseFrame(event.data);
      if (!frame.ok) {
        deps.onEvent({ type: "bad_frame", error: frame.error });
        return;
      }
      const message = frame.message;
      if (message.type === "hello") {
        // The server itself is up: start the next outage's backoff and attempt count over.
        backoff = resetBackoff();
        attempt = 0;
      }
      if (message.type === "notice" && TOKEN_CLEARING_NOTICES.includes(message.kind)) {
        deps.tokens?.clear();
      }
      deps.onEvent({ type: "message", message });
      if (message.type === "hello") {
        // Req 33.4: sign in again on every (re)connect while a valid token is stored.
        const token = deps.tokens?.get() ?? null;
        if (token !== null) transmit({ type: "authenticate", token });
      }
    };
    // A failed WebSocket always fires `close` after `error`; `close` carries the handling.
    socket.onerror = null;
    socket.onclose = (event) => {
      if (closed || ws !== socket) return;
      lost(closeReason(event));
    };
  }

  function send(message: ClientMessage): boolean {
    if (closed) return false;
    if (message.type === "subscribe") {
      subs.set(subscriptionKey(message.venue, message.symbol, message.timeframe), {
        venue: message.venue,
        symbol: message.symbol,
        timeframe: message.timeframe,
      });
    } else if (message.type === "unsubscribe") {
      subs.delete(subscriptionKey(message.venue, message.symbol, message.timeframe));
    } else if (message.type === "subscribe_ticker") {
      tickerSubs.set(`${message.venue}|${message.symbol}`, { symbol: message.symbol, venue: message.venue });
    } else if (message.type === "unsubscribe_ticker") {
      tickerSubs.delete(`${message.venue}|${message.symbol}`);
    } else if (message.type === "subscribe_news") {
      newsSubscribed = true;
    } else if (message.type === "unsubscribe_news") {
      newsSubscribed = false;
    }
    return transmit(message);
  }

  deps.onEvent({ type: "connecting", attempt, nextDelayMs: 0 });
  connect();

  return {
    send,
    subscribe(symbol, timeframe, venue = WEB_VENUE) {
      send({ type: "subscribe", venue, symbol, timeframe });
    },
    unsubscribe(symbol, timeframe, venue = WEB_VENUE) {
      send({ type: "unsubscribe", venue, symbol, timeframe });
    },
    subscribeTicker(symbol, venue) {
      send({ type: "subscribe_ticker", symbol, venue });
    },
    unsubscribeTicker(symbol, venue) {
      send({ type: "unsubscribe_ticker", symbol, venue });
    },
    subscribeNews() {
      send({ type: "subscribe_news" });
    },
    unsubscribeNews() {
      send({ type: "unsubscribe_news" });
    },
    close() {
      if (closed) return;
      closed = true;
      clearReconnectTimer();
      clearPingTimer();
      const old = ws;
      ws = null;
      opened = false;
      if (old !== null) detach(old);
    },
    isOpen() {
      return !closed && opened;
    },
    subscriptions() {
      return [...subs.values()];
    },
  };
}

/** Dependencies for the real browser: the DOM `WebSocket` and `setTimeout`. */
export function browserSocketDeps(onEvent: (event: SocketEvent) => void, tokens?: TokenSource): SocketDeps {
  return {
    onEvent,
    ...(tokens !== undefined ? { tokens } : {}),
    // The DOM WebSocket's handler types are stricter than WebSocketLike's; the shapes match at runtime.
    createWebSocket: (url) => new WebSocket(url) as unknown as WebSocketLike,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}
