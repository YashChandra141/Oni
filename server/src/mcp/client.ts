// TerminalClient: the MCP process's client of the running Oni server (design "MCP server
// (Req 24)", Task 14.1).
//
// - REST: `GET /quote/:symbol`, `GET /candles/:symbol?timeframe=&limit=`, `GET /positions`
//   (Req 24.2-24.4). Responses are validated with Zod; Price, Qty, and Money stay decimal
//   strings (tech.md: never Number).
// - WebSocket at `<baseUrl>/ws` (http→ws, https→wss), opened lazily on the first order call and
//   reopened on the next call after it closes. Ready after `Hello` and the `Session` that follows.
//   - `preview(text)`: `CommandText` → the matching `Preview` or `ParseError`; `Notice
//     ai_disabled` rejects (Req 24.5: nothing is confirmed).
//   - `place(text)`: preview, then `Confirm` with its preview_id (Req 24.6). The order goes
//     through the server's Router and Risk_Engine like any client order (trading-safety rules
//     2-4). The outcome is correlated by time and account, see `#awaitOutcome`.
//   WebSocket operations run one at a time, so every reply and error the server sends on this
//   connection belongs to the one operation in flight.
// - Account: the server decides it from the connection's verified session (trading-safety rule
//   10). This client never sends an account id. The `token` hook (Task 14.3) adds
//   `Authenticate { token }` after `Hello` and `Authorization: Bearer` on REST calls. The token is
//   never logged, never put in an error message, and never returned.
//
// Errors are `TerminalError`s with short messages built from static text, server error codes,
// and server-built messages; never from tokens or stack traces.

import { z } from "zod";
import {
  type ClientMessage,
  LevelSchema,
  MoneySchema,
  type OrderPreview,
  PriceSchema,
  QtySchema,
  type ServerMessage,
  ServerMessageSchema,
  SideSchema,
  type Timeframe,
  TimeframeSchema,
  TimeMsSchema,
} from "../protocol.ts";

// ---------------------------------------------------------------------------------------------
// Injected platform pieces
// ---------------------------------------------------------------------------------------------

/** The part of `fetch` the client uses. `globalThis.fetch` satisfies it. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The part of a browser-style WebSocket the client uses (Bun's global WebSocket has it). */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type WebSocketCtor = new (url: string) => WebSocketLike;

/** WebSocket.OPEN */
const WS_OPEN = 1;

// ---------------------------------------------------------------------------------------------
// Errors and results
// ---------------------------------------------------------------------------------------------

export type TerminalErrorKind =
  /** The server could not be reached, or the WebSocket closed. */
  | "unavailable"
  /** No answer in time. */
  | "timeout"
  /** 401, or `Notice auth_failed`: the session token was rejected (Task 14.3). */
  | "unauthorized"
  /** A non-2xx REST answer other than 401. */
  | "http"
  /** The server answered with something that does not match the protocol. */
  | "protocol"
  /** `ParseError` for command text. */
  | "parse_error"
  /** `Notice ai_disabled` for `?` text. */
  | "llm_disabled"
  /** An Error event for the request (for example an invalid message). */
  | "server_error";

export class TerminalError extends Error {
  readonly kind: TerminalErrorKind;
  /** HTTP status for `http` and `unauthorized` REST errors. */
  readonly status: number | null;
  /** Server error code (`no_data`, `unknown_symbol`, `invalid_query`, an ErrorCode), if any. */
  readonly code: string | null;

  constructor(kind: TerminalErrorKind, message: string, extra: { status?: number; code?: string } = {}) {
    super(message);
    this.name = "TerminalError";
    this.kind = kind;
    this.status = extra.status ?? null;
    this.code = extra.code ?? null;
  }
}

/** `GET /quote/:symbol` (state/routes.ts, state/market.ts `Quote`). */
export const QuoteResponseSchema = z.object({
  symbol: z.string(),
  last: z
    .object({ price: PriceSchema, qty: QtySchema, side: SideSchema, ts: TimeMsSchema })
    .nullable(),
  book: z
    .object({
      bid: LevelSchema.nullable(),
      ask: LevelSchema.nullable(),
      spread: PriceSchema.nullable(),
      imbalance_bps: z.number().int(),
      ts: TimeMsSchema,
    })
    .nullable(),
});
export type QuoteResponse = z.infer<typeof QuoteResponseSchema>;

/** `GET /candles/:symbol`. */
export const CandlesResponseSchema = z.object({
  symbol: z.string(),
  timeframe: TimeframeSchema,
  bars: z.array(
    z.object({
      t: TimeMsSchema,
      open: PriceSchema,
      high: PriceSchema,
      low: PriceSchema,
      close: PriceSchema,
      volume: QtySchema,
    }),
  ),
});
export type CandlesResponse = z.infer<typeof CandlesResponseSchema>;

/** `GET /positions`: the caller's Paper_Account (Req 20.6, 20.28). */
export const PositionsResponseSchema = z.array(
  z.object({
    symbol: z.string(),
    qty: QtySchema,
    avg_entry: PriceSchema.nullable(),
    realized: MoneySchema,
    unrealized: MoneySchema,
  }),
);
export type PositionsResponse = z.infer<typeof PositionsResponseSchema>;

/** One Fill event, as received (decimal strings kept). */
export interface FillSummary {
  readonly order_id: string;
  readonly symbol: string;
  readonly side: "buy" | "sell";
  readonly price: string;
  readonly qty: string;
  readonly fee: string;
  readonly remaining: string;
  readonly ts: number;
}

export type PlaceStatus =
  /** The order filled completely. */
  | "filled"
  /** Accepted, some fills, still open when the settle window ended. */
  | "partially_filled"
  /** Accepted and resting (no fills in the settle window). */
  | "open"
  /** The order was canceled. */
  | "canceled"
  /** The Router, the Risk_Engine, the engine, or the confirm step rejected it. */
  | "rejected"
  /** CANCEL ALL / FLAT: the settle window ended; see `acks`, `fills`, `rejections`. */
  | "done";

export interface PlaceOutcome {
  readonly action: "place" | "cancel_all" | "flatten_all";
  /** Canonical command text of the confirmed preview. */
  readonly command: string;
  readonly status: PlaceStatus;
  /** The order id for a single order, once acknowledged or rejected; else null. */
  readonly order_id: string | null;
  /** Rejection reason (risk reason such as `max_order_value`, or `confirm rejected: expired`). */
  readonly reason: string | null;
  readonly fills: readonly FillSummary[];
  readonly acks: readonly { readonly order_id: string; readonly status: string }[];
  readonly rejections: readonly { readonly order_id: string; readonly reason: string }[];
}

// ---------------------------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------------------------

export interface TerminalClientOptions {
  /** Server base URL, e.g. `http://localhost:8080`. http or https only. */
  readonly baseUrl: string;
  /** Defaults to `globalThis.fetch`. */
  readonly fetch?: FetchLike;
  /** Defaults to `globalThis.WebSocket`. */
  readonly WebSocket?: WebSocketCtor;
  /** Session_Token source (Task 14.3). Null or absent: guest account. Never logged. */
  readonly token?: () => string | null;
  /** Request id generator. Defaults to `crypto.randomUUID`. */
  readonly randomId?: () => string;
  /** REST timeout. Default 10 s. */
  readonly httpTimeoutMs?: number;
  /** Time to get Hello and Session after connecting. Default 10 s. */
  readonly connectTimeoutMs?: number;
  /** Time to get the Preview or ParseError. Default 10 s. */
  readonly previewTimeoutMs?: number;
  /** Time to get an order outcome after Confirm. Default 10 s. */
  readonly placeTimeoutMs?: number;
  /** After an accepted ack (or for CANCEL ALL / FLAT), how long to collect fills. Default 2 s. */
  readonly settleMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_SETTLE_MS = 2_000;

/** What `TerminalClient` offers the tools; tests may substitute it. */
export interface TerminalApi {
  quote(symbol: string): Promise<QuoteResponse>;
  candles(symbol: string, timeframe: Timeframe, limit: number): Promise<CandlesResponse>;
  positions(): Promise<PositionsResponse>;
  preview(text: string): Promise<OrderPreview>;
  place(text: string): Promise<PlaceOutcome>;
}

type ConnSignal = { readonly kind: "message"; readonly msg: ServerMessage } | { readonly kind: "closed" };

interface Connection {
  readonly ws: WebSocketLike;
  readonly ready: Promise<void>;
  closed: boolean;
  /** Account_Id from the latest `Session`. */
  accountId: string | null;
  /** The in-flight operation's listener. */
  listener: ((signal: ConnSignal) => void) | null;
}

/** Normalizes a base URL to `scheme://host[:port][/path]` without a trailing slash. */
export function normalizeBaseUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError("baseUrl must be an absolute http or https URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("baseUrl must be an absolute http or https URL");
  }
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

/**
 * The path prefix of a normalized base URL, without a trailing slash: "" for the root. An http(s)
 * URL's pathname is never empty (setting it to "" leaves "/"), so the root must be special-cased
 * or every route would start with "//".
 */
function basePath(url: URL): string {
  return url.pathname.replace(/\/+$/, "");
}

/** `http://h/p` → `ws://h/p/ws`, `https://…` → `wss://…/ws`. */
export function wsUrlFor(baseUrl: string): string {
  const url = normalizeBaseUrl(baseUrl);
  const scheme = url.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${url.host}${basePath(url)}/ws`;
}

const ErrorBodySchema = z.object({ error: z.string().regex(/^[a-z_]{1,40}$/) });

export class TerminalClient implements TerminalApi {
  readonly #base: string;
  readonly #origin: string;
  readonly #wsUrl: string;
  readonly #fetch: FetchLike;
  readonly #WebSocket: WebSocketCtor;
  readonly #token: () => string | null;
  readonly #randomId: () => string;
  readonly #httpTimeoutMs: number;
  readonly #connectTimeoutMs: number;
  readonly #previewTimeoutMs: number;
  readonly #placeTimeoutMs: number;
  readonly #settleMs: number;
  #conn: Connection | null = null;
  /** Serializes WebSocket operations. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: TerminalClientOptions) {
    const url = normalizeBaseUrl(options.baseUrl);
    this.#base = `${url.protocol}//${url.host}${basePath(url)}`;
    this.#origin = url.origin;
    this.#wsUrl = wsUrlFor(options.baseUrl);
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    // Boundary cast: the DOM-style handler signatures are wider than WebSocketLike's.
    this.#WebSocket = options.WebSocket ?? (globalThis.WebSocket as unknown as WebSocketCtor);
    this.#token = options.token ?? (() => null);
    this.#randomId = options.randomId ?? (() => crypto.randomUUID());
    this.#httpTimeoutMs = options.httpTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#previewTimeoutMs = options.previewTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#placeTimeoutMs = options.placeTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  }

  // -------------------------------------------------------------------------------------------
  // REST
  // -------------------------------------------------------------------------------------------

  /** `GET /quote/:symbol` (Req 24.2). `symbol` is a full instrument symbol. */
  quote(symbol: string): Promise<QuoteResponse> {
    return this.#get(`/quote/${encodeURIComponent(symbol)}`, QuoteResponseSchema);
  }

  /** `GET /candles/:symbol?timeframe=&limit=` (Req 24.3). */
  candles(symbol: string, timeframe: Timeframe, limit: number): Promise<CandlesResponse> {
    const query = new URLSearchParams({ timeframe, limit: String(limit) });
    return this.#get(`/candles/${encodeURIComponent(symbol)}?${query.toString()}`, CandlesResponseSchema);
  }

  /** `GET /positions` of this client's Paper_Account (Req 24.4). */
  positions(): Promise<PositionsResponse> {
    return this.#get("/positions", PositionsResponseSchema);
  }

  async #get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    const token = this.#token();
    if (token !== null && token !== "") headers.authorization = `Bearer ${token}`;

    let res: Response;
    try {
      res = await this.#fetch(`${this.#base}${path}`, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(this.#httpTimeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new TerminalError("timeout", `the terminal server at ${this.#origin} did not answer in time`);
      }
      throw new TerminalError("unavailable", `cannot reach the terminal server at ${this.#origin}`);
    }

    if (res.status === 401) {
      throw new TerminalError("unauthorized", "the terminal server rejected the session token", { status: 401 });
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    if (!res.ok) {
      const parsed = ErrorBodySchema.safeParse(body);
      const code = parsed.success ? parsed.data.error : undefined;
      const suffix = code === undefined ? "" : ` (${code})`;
      throw new TerminalError("http", `the terminal server answered HTTP ${res.status}${suffix}`, {
        status: res.status,
        ...(code === undefined ? {} : { code }),
      });
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new TerminalError("protocol", "unexpected response from the terminal server");
    return parsed.data;
  }

  // -------------------------------------------------------------------------------------------
  // WebSocket
  // -------------------------------------------------------------------------------------------

  /** Returns the server's Order_Preview for `text`. Confirms nothing (Req 24.5). */
  preview(text: string): Promise<OrderPreview> {
    return this.#exclusive(async () => {
      const conn = await this.#connection();
      return this.#previewOn(conn, text);
    });
  }

  /**
   * Previews `text`, confirms that preview on the same connection, and waits for the outcome
   * (Req 24.6). The server's Router applies the Risk_Engine; this client cannot skip it.
   */
  place(text: string): Promise<PlaceOutcome> {
    return this.#exclusive(async () => {
      const conn = await this.#connection();
      const preview = await this.#previewOn(conn, text);
      return this.#confirmOn(conn, preview);
    });
  }

  /** Closes the WebSocket, if open. A later call reconnects. */
  close(): void {
    const conn = this.#conn;
    this.#conn = null;
    if (conn !== null && !conn.closed) {
      conn.closed = true;
      try {
        conn.ws.close(1000, "client closing");
      } catch {
        // already closing
      }
    }
  }

  #exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work, work);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** The open, ready connection; opens a new one when there is none or it closed. */
  async #connection(): Promise<Connection> {
    const existing = this.#conn;
    if (existing !== null && !existing.closed) {
      await existing.ready;
      return existing;
    }
    const conn = this.#open();
    this.#conn = conn;
    try {
      await conn.ready;
    } catch (err) {
      if (this.#conn === conn) this.#conn = null;
      if (!conn.closed) {
        conn.closed = true;
        try {
          conn.ws.close(1000, "connect failed");
        } catch {
          // ignore
        }
      }
      throw err;
    }
    return conn;
  }

  #open(): Connection {
    let ws: WebSocketLike;
    try {
      ws = new this.#WebSocket(this.#wsUrl);
    } catch {
      const failed = Promise.reject(
        new TerminalError("unavailable", `cannot reach the terminal server at ${this.#origin}`),
      );
      failed.catch(() => undefined);
      return {
        ws: { readyState: 3, send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null },
        ready: failed,
        closed: true,
        accountId: null,
        listener: null,
      };
    }

    let resolveReady!: () => void;
    let rejectReady!: (err: TerminalError) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    ready.catch(() => undefined);

    const conn: Connection = { ws, ready, closed: false, accountId: null, listener: null };
    let isReady = false;
    let gotHello = false;
    /** Set when Authenticate was sent: then only a wallet Session (or auth_failed) settles. */
    let authenticating = false;

    const timer = setTimeout(() => {
      if (!isReady) rejectReady(new TerminalError("timeout", "the terminal server did not send Hello in time"));
    }, this.#connectTimeoutMs);

    const settleReady = (err?: TerminalError) => {
      if (isReady) return;
      isReady = true;
      clearTimeout(timer);
      if (err === undefined) resolveReady();
      else rejectReady(err);
    };

    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      let raw: unknown;
      try {
        raw = JSON.parse(event.data);
      } catch {
        return;
      }
      const parsed = ServerMessageSchema.safeParse(raw);
      if (!parsed.success) return;
      const msg = parsed.data;

      if (msg.type === "session") conn.accountId = msg.account_id;

      if (!isReady) {
        if (msg.type === "hello") {
          gotHello = true;
          const token = this.#token();
          if (token !== null && token !== "") {
            // Task 14.3: sign in. The server answers `Session { w_<address> }` on success, or
            // `Session { current }` then `Notice auth_failed` on failure (gateway/ws.ts), so
            // the guest Session that follows Hello does not settle readiness.
            authenticating = true;
            try {
              this.#send(conn, { type: "authenticate", token });
            } catch {
              settleReady(new TerminalError("unavailable", `the connection to ${this.#origin} is not open`));
            }
          }
        } else if (msg.type === "session" && gotHello) {
          if (!authenticating || msg.address !== null) settleReady();
        } else if (msg.type === "notice" && msg.kind === "auth_failed") {
          settleReady(new TerminalError("unauthorized", "the terminal server rejected the session token"));
        }
        return;
      }
      conn.listener?.({ kind: "message", msg });
    };

    ws.onclose = () => {
      conn.closed = true;
      if (this.#conn === conn) this.#conn = null;
      settleReady(new TerminalError("unavailable", `the connection to ${this.#origin} closed`));
      conn.listener?.({ kind: "closed" });
    };
    ws.onerror = () => {
      // onclose follows; nothing to log (the event may quote the URL).
    };
    ws.onopen = () => {};

    return conn;
  }

  #send(conn: Connection, message: ClientMessage): void {
    if (conn.closed || conn.ws.readyState !== WS_OPEN) {
      throw new TerminalError("unavailable", `the connection to ${this.#origin} is not open`);
    }
    conn.ws.send(JSON.stringify(message));
  }

  #previewOn(conn: Connection, text: string): Promise<OrderPreview> {
    const requestId = this.#randomId();
    return new Promise<OrderPreview>((resolve, reject) => {
      const finish = (result: { ok: true; preview: OrderPreview } | { ok: false; error: TerminalError }) => {
        clearTimeout(timer);
        if (conn.listener === listener) conn.listener = null;
        if (result.ok) resolve(result.preview);
        else reject(result.error);
      };
      const listener = (signal: ConnSignal) => {
        if (signal.kind === "closed") {
          finish({ ok: false, error: new TerminalError("unavailable", `the connection to ${this.#origin} closed`) });
          return;
        }
        const msg = signal.msg;
        if (msg.type === "preview" && msg.request_id === requestId) {
          finish({ ok: true, preview: msg.preview });
        } else if (msg.type === "parse_error" && msg.request_id === requestId) {
          finish({
            ok: false,
            error: new TerminalError("parse_error", `${msg.message} (at character ${msg.position})`),
          });
        } else if (msg.type === "notice" && msg.kind === "ai_disabled") {
          // Protocol v3 renamed the notice kind `llm_disabled` to `ai_disabled`; the error kind
          // the tools see keeps its name.
          finish({ ok: false, error: new TerminalError("llm_disabled", "plain-English orders are disabled on the server") });
        } else if (msg.type === "event" && msg.event.type === "error") {
          finish({
            ok: false,
            error: new TerminalError("server_error", `server error ${msg.event.code}: ${msg.event.message}`, {
              code: msg.event.code,
            }),
          });
        }
      };
      const timer = setTimeout(() => {
        finish({ ok: false, error: new TerminalError("timeout", "no preview from the terminal server in time") });
      }, this.#previewTimeoutMs);

      conn.listener = listener;
      try {
        // No venue: the server uses its default venue. MCP arguments never choose one (rule 10).
        this.#send(conn, { type: "command_text", request_id: requestId, text, venue: null });
      } catch (err) {
        finish({ ok: false, error: err instanceof TerminalError ? err : new TerminalError("unavailable", "send failed") });
      }
    });
  }

  /**
   * Sends `Confirm` and waits for the outcome. Correlation (the server's events carry no
   * request id): only events after the Confirm count, and only account events whose
   * `account_id` is this connection's Session account.
   * - Single order: the first `OrderRejected` → rejected. The first `OrderAck accepted` fixes
   *   the order id; then its Fills are collected until `remaining` is 0 or an ack `filled` /
   *   `canceled` for that id, or until `settleMs` passes (status `open` / `partially_filled`).
   * - CANCEL ALL / FLAT: acks, fills, and rejections are collected for `settleMs`.
   * - Any Error event (e.g. `confirm rejected: expired`) → rejected with its message. Errors
   *   are sent only to this connection, and operations run one at a time, so it is ours.
   * Limitation: other connections on the same account (e.g. a web UI on `guest`) receive and
   * send account events too; an ack of their order inside the window could be taken for ours.
   */
  #confirmOn(conn: Connection, preview: OrderPreview): Promise<PlaceOutcome> {
    const action = preview.action.type;
    const accountId = conn.accountId;
    let orderId: string | null = null;
    const fills: FillSummary[] = [];
    const acks: { order_id: string; status: string }[] = [];
    const rejections: { order_id: string; reason: string }[] = [];

    return new Promise<PlaceOutcome>((resolve, reject) => {
      let settleTimer: ReturnType<typeof setTimeout> | undefined;
      const outcome = (status: PlaceStatus, reason: string | null = null): PlaceOutcome => ({
        action,
        command: preview.text,
        status,
        order_id: orderId,
        reason,
        fills: [...fills],
        acks: [...acks],
        rejections: [...rejections],
      });
      const finish = (result: { ok: true; outcome: PlaceOutcome } | { ok: false; error: TerminalError }) => {
        clearTimeout(timer);
        if (settleTimer !== undefined) clearTimeout(settleTimer);
        if (conn.listener === listener) conn.listener = null;
        if (result.ok) resolve(result.outcome);
        else reject(result.error);
      };
      const startSettle = (status: () => PlaceStatus) => {
        if (settleTimer !== undefined) return;
        settleTimer = setTimeout(() => finish({ ok: true, outcome: outcome(status()) }), this.#settleMs);
      };

      const listener = (signal: ConnSignal) => {
        if (signal.kind === "closed") {
          finish({
            ok: false,
            error: new TerminalError("unavailable", "the connection closed before the order result arrived"),
          });
          return;
        }
        const msg = signal.msg;
        if (msg.type !== "event") return;
        const ev = msg.event;
        if (ev.type === "error") {
          finish({ ok: true, outcome: outcome("rejected", ev.message) });
          return;
        }
        if (ev.type !== "order_ack" && ev.type !== "order_rejected" && ev.type !== "fill") return;
        if (accountId !== null && ev.account_id !== accountId) return;

        if (action !== "place") {
          if (ev.type === "order_ack") acks.push({ order_id: ev.order_id, status: ev.status });
          else if (ev.type === "order_rejected") rejections.push({ order_id: ev.order_id, reason: ev.reason });
          else fills.push(fillSummary(ev));
          return;
        }

        if (ev.type === "order_rejected") {
          if (orderId === null || ev.order_id === orderId) {
            orderId = ev.order_id;
            rejections.push({ order_id: ev.order_id, reason: ev.reason });
            finish({ ok: true, outcome: outcome("rejected", ev.reason) });
          }
          return;
        }
        if (ev.type === "order_ack") {
          if (orderId === null && ev.status === "accepted") {
            orderId = ev.order_id;
            acks.push({ order_id: ev.order_id, status: ev.status });
            startSettle(() => (fills.length > 0 ? "partially_filled" : "open"));
          } else if (ev.order_id === orderId && ev.status !== "accepted") {
            acks.push({ order_id: ev.order_id, status: ev.status });
            finish({ ok: true, outcome: outcome(ev.status === "filled" ? "filled" : "canceled") });
          }
          return;
        }
        // fill
        if (orderId !== null && ev.order_id === orderId) {
          fills.push(fillSummary(ev));
          if (ev.remaining === "0") finish({ ok: true, outcome: outcome("filled") });
        }
      };

      const timer = setTimeout(() => {
        finish({
          ok: false,
          error: new TerminalError(
            "timeout",
            "no order result from the terminal server in time; check get_positions before retrying",
          ),
        });
      }, this.#placeTimeoutMs);

      conn.listener = listener;
      try {
        this.#send(conn, { type: "confirm", request_id: this.#randomId(), preview_id: preview.preview_id });
      } catch (err) {
        finish({ ok: false, error: err instanceof TerminalError ? err : new TerminalError("unavailable", "send failed") });
        return;
      }
      if (action !== "place") startSettle(() => "done");
    });
  }
}

function fillSummary(ev: {
  order_id: string;
  symbol: string;
  side: "buy" | "sell";
  price: string;
  qty: string;
  fee: string;
  remaining: string;
  ts: number;
}): FillSummary {
  return {
    order_id: ev.order_id,
    symbol: ev.symbol,
    side: ev.side,
    price: ev.price,
    qty: ev.qty,
    fee: ev.fee,
    remaining: ev.remaining,
    ts: ev.ts,
  };
}
