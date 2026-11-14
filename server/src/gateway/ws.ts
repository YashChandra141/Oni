// WebSocket gateway (design §3 "Gateway (Req 17)").
//
// - On open: assign a connection id, start a guest Connection_Session, subscribe the socket to
//   `account:guest` and `notices`, send `Hello`, then `Session { account_id: "guest",
//   address: null }` (Req 1.8, 46.1).
// - `Authenticate { token }` is verified by the injected token verifier. Accepted: the socket
//   moves to `account:w_<address>` and gets `Session` (Req 46.2). Rejected: the connection keeps
//   its account, gets `Session` and `Notice auth_failed` (Req 46.3). The token is never logged
//   or echoed (Req 16.4).
// - Logout (`handleLogout(jti)`) and expiry (`downgradeExpired`) move connections back to
//   guest, send `Session` and a notice (Req 46.4, 46.5, 46.6). Wallet sessions also expire
//   lazily: before each client message the session's `exp` is checked against the clock.
// - `onAccountChange(listener)` reports every account switch (Task 11.2 Router, 12.1 previews).
// - Every client message is validated with Zod (`parseClientMessage`) before anything acts on
//   it (Req 17.3). Invalid input gets `Event(Error { code: "invalid_message" })` and the
//   connection stays open (Req 17.4).
// - Subscriptions are ref-counted per (symbol, timeframe) in `SubscriptionRegistry`: the first
//   subscriber triggers the engine `Subscribe`, later subscribers get the cached snapshot, and
//   the last unsubscribe (or close) sends `Unsubscribe`.
// - Engine events feed `MarketState` (state/market.ts). Candle events are applied only while
//   their key has subscribers, and everything is cleared on engine exit (Req 15.7).
// - Engine events are routed by `routeAccountEvent` (routing.ts) to Bun topics:
//     candles:<symbol>:<tf>  Candle, Indicators            (Req 17.6)
//     market:<symbol>        Trade, Book                   (Req 17.6)
//     account:<account_id>   OrderAck, Fill, Position       (Req 17.7)
//     notices                lifecycle and auth notices; every connection (Req 17.9)
//   OrderRejected goes to the requesting connection, else to `account:<account_id>`
//   (Req 17.10). Heartbeat and Pong are not forwarded. Engine Error events are logged.
//
// - Cancel, CancelAll, FlattenAll, and ResetAccount messages go to the injected Router
//   (`setRouter`) with `{ connectionId, session: ws.data.session, source: "web" }`. A failed
//   result becomes `Error { invalid_command }` with "<action> rejected: <reason>"; a throwing
//   Router becomes `Error { internal }`. Without a Router they are refused.
// - CommandText, Confirm, and Discard use the CommandBar set with `setCommandBar` (Task 12.1):
//   CommandText → `Preview` or `ParseError` (`?` text → `Notice llm_disabled` until Task 13);
//   Confirm → `PreviewStore.take` for this connection and its current account, then the Router;
//   Discard → `PreviewStore.discard`. Without a CommandBar they are refused.
// - `sendTo(connectionId, message)` and `onConnectionClosed(listener)` serve the Router wiring
//   (OrderRejected delivery, rate-window cleanup).
//
// Safety (Req 18.3, 18.5, trading-safety rules 2 and 10): this module only ever calls
// `supervisor.sendControl` with Subscribe and Unsubscribe. It never sees the engine's order
// writer, and an account id is never read from a client message: it comes only from a verified
// token.

import type { WebSocketHandler } from "bun";
import type { VerifyResult } from "../auth/token.ts";
import type { Config } from "../config.ts";
import type { EngineNotice, EngineSupervisor, Logger } from "../engine/supervisor.ts";
import { INSTRUMENTS, instrumentBySymbol } from "../instruments.ts";
import {
  type AccountId,
  type ClientMessage,
  type Event,
  type ServerMessage,
  type Timeframe,
  parseClientMessage,
} from "../protocol.ts";
import { formatCommand } from "../commands/formatter.ts";
import { type ParsedCommand, parseCommand } from "../commands/parser.ts";
import type { PreviewStore } from "../commands/previews.ts";
import type { OrderOrigin, Router } from "../router.ts";
import { MarketState } from "../state/market.ts";
import { type SubscriptionKey, SubscriptionRegistry } from "./clients.ts";
import {
  NOTICES_TOPIC,
  PendingRequests,
  accountTopic,
  candlesTopic,
  marketTopic,
  routeAccountEvent,
} from "./routing.ts";

export { NOTICES_TOPIC, accountTopic, candlesTopic, marketTopic };

/** Wire protocol version sent in `Hello` (`PROTOCOL_VERSION` in rust/crates/protocol/src/lib.rs). */
export const PROTOCOL_VERSION = 2;

/** Largest accepted inbound message. Bun closes the socket with 1009 above it. */
export const MAX_INBOUND_BYTES = 64 * 1024;

/** The Account_Id of every connection without a valid Session_Token (Req 14.2). */
export const GUEST_ACCOUNT_ID = "guest";

/** The Connection_Session of one WebSocket (design "Connection_Session"). */
export interface ConnectionSession {
  readonly accountId: AccountId;
  /** Wallet_Address, or null for the guest. */
  readonly address: string | null;
  /** Token identifier, or null for the guest. */
  readonly jti: string | null;
  /** Token expiry in epoch seconds, or null for the guest. */
  readonly exp: number | null;
}

export const GUEST_SESSION: ConnectionSession = {
  accountId: GUEST_ACCOUNT_ID,
  address: null,
  jti: null,
  exp: null,
};

/** Per-connection data stored on the Bun socket (`ws.data`). */
export interface ClientData {
  /** Assigned in `open` with `crypto.randomUUID()`. */
  clientId?: string;
  /** Set in `open`; guest by default. */
  session?: ConnectionSession;
}

/** The part of Bun's `ServerWebSocket` the gateway uses. Tests pass a fake. */
export interface GatewaySocket {
  readonly data: ClientData;
  send(data: string): unknown;
  subscribe(topic: string): void;
  unsubscribe(topic: string): void;
}

/** Publishes to every socket subscribed to a topic. In production this is the Bun server. */
export interface Publisher {
  publish(topic: string, data: string): unknown;
}

/** The supervisor surface the gateway needs. It does not include the order sender. */
export type GatewaySupervisor = Pick<
  EngineSupervisor,
  "running" | "sessionId" | "sendControl" | "setSubscriptionProvider" | "onEvent" | "onNotice" | "onClearAccount"
>;

/** The Auth_Service surface the gateway needs (TokenService satisfies it). */
export interface TokenVerifier {
  verify(token: string): Promise<VerifyResult>;
}

/** Called on every account switch, sign-in and downgrade alike. */
export type AccountChangeListener = (
  connectionId: string,
  oldAccountId: AccountId,
  newAccountId: AccountId,
) => void;

/** The Router surface the gateway calls for Cancel, CancelAll, FlattenAll, and ResetAccount. */
export type GatewayRouter = Pick<Router, "cancel" | "cancelAll" | "flattenAll" | "resetAccount">;

/**
 * What the command bar needs (Task 12.1): the preview store, the account positions that `%`
 * amounts resolve against, and the Router calls a confirmed preview makes. Set with
 * `setCommandBar`. The owner also subscribes `previews.discardForConnection` to
 * `onAccountChange` and `onConnectionClosed` (Req 46.4).
 */
export interface CommandBar {
  readonly previews: PreviewStore;
  readonly accounts: { positionLots(accountId: AccountId, symbol: string): bigint };
  readonly router: Pick<Router, "submit" | "cancelAll" | "flattenAll">;
}

/** Called when a connection closes, with its connection id. */
export type ConnectionClosedListener = (connectionId: string) => void;

export interface GatewayOptions {
  readonly supervisor: GatewaySupervisor;
  readonly config: Pick<Config, "dataMode" | "liveVenue">;
  /** Defaults to a new registry. */
  readonly registry?: SubscriptionRegistry;
  /** Defaults to a new MarketState. */
  readonly market?: MarketState;
  /** Defaults to console. */
  readonly logger?: Logger;
  /** Client id generator. Defaults to `crypto.randomUUID`. */
  readonly randomUUID?: () => string;
  /** Verifies Session_Tokens. Without it every Authenticate is rejected. */
  readonly tokens?: TokenVerifier;
  /** Epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
}

const consoleLogger: Logger = {
  info: (line) => console.log(line),
  warn: (line) => console.warn(line),
  error: (line) => console.error(line),
};

function encode(message: ServerMessage): string {
  return JSON.stringify(message);
}

function errorMessage(
  code: "invalid_message" | "invalid_command" | "unknown_symbol" | "internal",
  message: string,
): string {
  return encode({ type: "event", event: { type: "error", code, message } });
}

const ORDER_ENTRY_UNAVAILABLE = "order entry not available yet";

/** The outcome of one Router action, as the gateway reads it. */
export type OrderActionResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Maps a Cancel, CancelAll, FlattenAll, or ResetAccount client message to its Router call.
 * Null for any other message. The account comes from `origin.session`, never from the message
 * (Req 18.5). Pure; the gateway and the P35 property test share it.
 */
export function orderActionFor(
  msg: ClientMessage,
): { readonly action: string; readonly run: (router: GatewayRouter, origin: OrderOrigin) => OrderActionResult } | null {
  switch (msg.type) {
    case "cancel": {
      const orderId = msg.order_id;
      return { action: "cancel", run: (router, origin) => router.cancel(orderId, origin) };
    }
    case "cancel_all":
      return { action: "cancel all", run: (router, origin) => router.cancelAll(origin) };
    case "flatten_all":
      return { action: "flatten all", run: (router, origin) => router.flattenAll(origin) };
    case "reset_account":
      return { action: "reset account", run: (router, origin) => router.resetAccount(origin) };
    default:
      return null;
  }
}

export class Gateway {
  readonly registry: SubscriptionRegistry;
  readonly market: MarketState;
  /** orderId → requesting connection. The Router (Task 11.2) fills it; OrderRejected reads it. */
  readonly pendingRequests: PendingRequests;
  readonly #supervisor: GatewaySupervisor;
  readonly #config: Pick<Config, "dataMode" | "liveVenue">;
  readonly #log: Logger;
  readonly #randomUUID: () => string;
  readonly #tokens: TokenVerifier | null;
  readonly #now: () => number;
  readonly #unlisten: (() => void)[] = [];
  /** connection id → socket, for `{ toConnection }` routing and downgrades. */
  readonly #sockets = new Map<string, GatewaySocket>();
  /** jti → connection ids signed in with that token. */
  readonly #byJti = new Map<string, Set<string>>();
  readonly #accountListeners = new Set<AccountChangeListener>();
  readonly #closedListeners = new Set<ConnectionClosedListener>();
  #publisher: Publisher | null = null;
  #router: GatewayRouter | null = null;
  #commandBar: CommandBar | null = null;

  constructor(options: GatewayOptions) {
    this.#supervisor = options.supervisor;
    this.#config = options.config;
    this.registry = options.registry ?? new SubscriptionRegistry();
    this.market = options.market ?? new MarketState();
    this.#log = options.logger ?? consoleLogger;
    this.#randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
    this.#tokens = options.tokens ?? null;
    this.#now = options.now ?? Date.now;
    this.pendingRequests = new PendingRequests({ now: this.#now });

    // Req 15.4: the supervisor resends these after every engine start.
    this.#supervisor.setSubscriptionProvider(() => this.registry.active());
    this.#unlisten.push(
      this.#supervisor.onEvent((event) => this.handleEngineEvent(event)),
      this.#supervisor.onNotice((notice) => this.handleNotice(notice)),
      // A new engine process has its own book, candles, and replay; the cached market data is
      // void (Req 15.7). Subscriptions stay: the supervisor resends them and the new engine
      // answers with fresh snapshots.
      this.#supervisor.onClearAccount(() => this.market.clear()),
    );
  }

  /** Sets the topic publisher (the Bun server). Events before this are dropped. */
  setPublisher(publisher: Publisher | null): void {
    this.#publisher = publisher;
  }

  /** Sets the Router that handles order actions. Without one they are refused. */
  setRouter(router: GatewayRouter | null): void {
    this.#router = router;
  }

  /** Enables CommandText, Confirm, and Discard. Without it they are refused. */
  setCommandBar(bar: CommandBar | null): void {
    this.#commandBar = bar;
  }

  /** Sends one message to one open connection. Returns false when it is not open. */
  sendTo(connectionId: string, message: ServerMessage): boolean {
    const ws = this.#sockets.get(connectionId);
    if (ws === undefined) return false;
    ws.send(encode(message));
    return true;
  }

  /** Subscribes to connection closes. Returns a function that removes the listener. */
  onConnectionClosed(listener: ConnectionClosedListener): () => void {
    this.#closedListeners.add(listener);
    return () => {
      this.#closedListeners.delete(listener);
    };
  }

  /** Removes the supervisor listeners. */
  dispose(): void {
    for (const unlisten of this.#unlisten.splice(0)) unlisten();
    this.#publisher = null;
    this.#router = null;
    this.#commandBar = null;
  }

  /**
   * Subscribes to account switches (sign-in, logout, expiry). Returns a function that removes
   * the listener. A throwing listener is logged and does not stop the others.
   */
  onAccountChange(listener: AccountChangeListener): () => void {
    this.#accountListeners.add(listener);
    return () => {
      this.#accountListeners.delete(listener);
    };
  }

  /** The Connection_Session of a connection, or undefined when it is not open. */
  sessionOf(connectionId: string): ConnectionSession | undefined {
    return this.#sockets.get(connectionId)?.data.session;
  }

  /** Handlers for `Bun.serve({ websocket })`. */
  handlers(): WebSocketHandler<ClientData> {
    return {
      data: {} as ClientData,
      maxPayloadLength: MAX_INBOUND_BYTES,
      open: (ws) => this.open(ws),
      message: (ws, message) => this.message(ws, message),
      close: (ws) => this.close(ws),
    };
  }

  // -------------------------------------------------------------------------------------------
  // Socket lifecycle
  // -------------------------------------------------------------------------------------------

  open(ws: GatewaySocket): void {
    const clientId = this.#clientId(ws);
    ws.data.session = GUEST_SESSION;
    this.#sockets.set(clientId, ws);
    ws.subscribe(accountTopic(GUEST_ACCOUNT_ID)); // Req 46.1
    ws.subscribe(NOTICES_TOPIC); // Req 17.9
    ws.send(
      encode({
        type: "hello",
        protocol_version: PROTOCOL_VERSION,
        data_mode: this.#config.dataMode,
        // Req 1.11: the Live_Venue in live mode, null in replay mode.
        venue: this.#config.dataMode === "live" ? this.#config.liveVenue : null,
        engine_running: this.#supervisor.running,
        instruments: INSTRUMENTS.map((i) => ({ ...i })),
      }),
    );
    // Req 1.8, 46.1: tell the client which Paper_Account it is on.
    ws.send(encode({ type: "session", account_id: GUEST_ACCOUNT_ID, address: null }));
    this.#log.info(`[gateway] client ${clientId} connected`);
  }

  message(ws: GatewaySocket, raw: string | ArrayBufferView | ArrayBuffer): void {
    const clientId = this.#clientId(ws);
    if (typeof raw !== "string") {
      ws.send(errorMessage("invalid_message", "expected a JSON text message"));
      return;
    }
    if (raw.length > MAX_INBOUND_BYTES) {
      ws.send(errorMessage("invalid_message", "message is too large"));
      return;
    }
    // Req 17.3, 17.4: validate first; on failure reply with an Error and keep the socket open.
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      const detail = parsed.code === "invalid_json" ? "not valid JSON" : parsed.message;
      ws.send(errorMessage("invalid_message", `invalid client message: ${detail}`));
      return;
    }
    // Req 46.5: a wallet session past its expiry becomes guest before the message is handled.
    this.#expireIfDue(ws, clientId);
    this.#handle(ws, clientId, parsed.value);
  }

  close(ws: GatewaySocket): void {
    const clientId = ws.data.clientId;
    if (clientId === undefined) return;
    this.#sockets.delete(clientId);
    this.#unindexJti(clientId, ws.data.session?.jti ?? null);
    this.pendingRequests.dropConnection(clientId);
    for (const listener of [...this.#closedListeners]) {
      try {
        listener(clientId);
      } catch (err) {
        this.#log.error(`[gateway] connection-closed listener failed: ${err instanceof Error ? err.name : "unknown"}`);
      }
    }
    // Bun drops the socket's topic subscriptions itself; only the engine side needs work.
    for (const key of this.registry.removeClient(clientId)) this.#release(key);
    this.#log.info(`[gateway] client ${clientId} disconnected`);
  }

  // -------------------------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------------------------

  /**
   * Logout (Req 46.4): every connection signed in with `jti` becomes guest, gets `Session` and
   * `Notice signed_out`.
   */
  handleLogout(jti: string): void {
    const ids = this.#byJti.get(jti);
    if (ids === undefined) return;
    for (const id of [...ids]) this.#downgrade(id, "signed_out", "You were signed out.");
    this.#byJti.delete(jti);
  }

  /**
   * Expiry (Req 46.5, used by the Router on `session_expired`): the connection becomes guest
   * and gets `Session` and `Notice session_expired`. A no-op for a guest or unknown connection.
   */
  downgradeExpired(connectionId: string): void {
    this.#downgrade(connectionId, "session_expired", "Your session expired; you are on the guest account.");
  }

  #expireIfDue(ws: GatewaySocket, clientId: string): void {
    const exp = ws.data.session?.exp;
    if (exp === null || exp === undefined) return;
    if (Math.floor(this.#now() / 1000) >= exp) this.downgradeExpired(clientId);
  }

  /** Moves a wallet connection to guest. Does nothing for a guest or closed connection. */
  #downgrade(connectionId: string, kind: "signed_out" | "session_expired", message: string): void {
    const ws = this.#sockets.get(connectionId);
    if (ws === undefined || ws.data.session === undefined || ws.data.session.jti === null) return;
    this.#switchSession(connectionId, ws, GUEST_SESSION);
    ws.send(encode({ type: "session", account_id: GUEST_ACCOUNT_ID, address: null }));
    ws.send(encode({ type: "notice", kind, message }));
  }

  /** Swaps topics, updates the jti index and the session, then fires the account-change hook. */
  #switchSession(connectionId: string, ws: GatewaySocket, next: ConnectionSession): void {
    const prev = ws.data.session ?? GUEST_SESSION;
    this.#unindexJti(connectionId, prev.jti);
    if (prev.accountId !== next.accountId) {
      ws.unsubscribe(accountTopic(prev.accountId));
      ws.subscribe(accountTopic(next.accountId));
    }
    ws.data.session = next;
    if (next.jti !== null) {
      let ids = this.#byJti.get(next.jti);
      if (ids === undefined) {
        ids = new Set();
        this.#byJti.set(next.jti, ids);
      }
      ids.add(connectionId);
    }
    for (const listener of [...this.#accountListeners]) {
      try {
        listener(connectionId, prev.accountId, next.accountId);
      } catch (err) {
        this.#log.error(`[gateway] account-change listener failed: ${err instanceof Error ? err.name : "unknown"}`);
      }
    }
  }

  #unindexJti(connectionId: string, jti: string | null): void {
    if (jti === null) return;
    const ids = this.#byJti.get(jti);
    if (ids === undefined) return;
    ids.delete(connectionId);
    if (ids.size === 0) this.#byJti.delete(jti);
  }

  async #authenticate(ws: GatewaySocket, clientId: string, token: string): Promise<void> {
    let result: VerifyResult;
    try {
      result = this.#tokens === null ? { ok: false, reason: "malformed" } : await this.#tokens.verify(token);
    } catch {
      result = { ok: false, reason: "malformed" };
    }
    // The socket may have closed while the token was being verified.
    if (this.#sockets.get(clientId) !== ws) return;

    if (!result.ok) {
      this.#log.warn(`[gateway] client ${clientId} authenticate rejected: ${result.reason}`);
      const current = ws.data.session ?? GUEST_SESSION;
      ws.send(encode({ type: "session", account_id: current.accountId, address: current.address }));
      ws.send(encode({ type: "notice", kind: "auth_failed", message: "Sign-in failed; you are on the guest account." }));
      return;
    }
    const { claims } = result;
    this.#switchSession(clientId, ws, {
      accountId: claims.accountId,
      address: claims.address,
      jti: claims.jti,
      exp: claims.exp,
    });
    ws.send(encode({ type: "session", account_id: claims.accountId, address: claims.address }));
    this.#log.info(`[gateway] client ${clientId} signed in as ${claims.accountId}`);
  }

  // -------------------------------------------------------------------------------------------
  // Client messages
  // -------------------------------------------------------------------------------------------

  #handle(ws: GatewaySocket, clientId: string, msg: ClientMessage): void {
    switch (msg.type) {
      case "subscribe":
        this.#subscribe(ws, clientId, msg.symbol, msg.timeframe);
        return;
      case "unsubscribe":
        this.#unsubscribe(ws, clientId, msg.symbol, msg.timeframe);
        return;
      case "ping":
        ws.send(encode({ type: "pong", id: msg.id }));
        return;
      // Order actions go to the Router (Req 18.1). It takes the account id from the verified
      // session passed in the origin, never from the message (Req 18.5).
      case "cancel":
      case "cancel_all":
      case "flatten_all":
      case "reset_account": {
        const mapped = orderActionFor(msg);
        if (mapped !== null) this.#orderAction(ws, clientId, mapped.action, mapped.run);
        return;
      }
      // Command bar (Req 21, 22). Refused until `setCommandBar` is called.
      case "command_text":
      case "confirm":
      case "discard": {
        const bar = this.#commandBar;
        if (bar === null) {
          ws.send(errorMessage("internal", ORDER_ENTRY_UNAVAILABLE));
          return;
        }
        if (msg.type === "command_text") this.#commandText(ws, clientId, bar, msg.request_id, msg.text);
        else if (msg.type === "confirm") this.#confirm(ws, clientId, bar, msg.preview_id);
        else bar.previews.discard(msg.preview_id, clientId);
        return;
      }
      case "authenticate":
        this.#authenticate(ws, clientId, msg.token).catch(() => {
          this.#log.error(`[gateway] client ${clientId} authenticate failed unexpectedly`);
        });
        return;
    }
  }

  /**
   * Command bar text (Req 21, 22.1). Text starting with `?` is a plain-English order: Task 13
   * replaces the notice below with the LLM_Order_Parser, which must also end in a preview.
   * Anything else is parsed here. The account for `%` amounts is the session's, never the message's.
   */
  #commandText(ws: GatewaySocket, clientId: string, bar: CommandBar, requestId: string, text: string): void {
    if (text.trimStart().startsWith("?")) {
      // TODO(Task 13): hand `text.trimStart().slice(1)` to the LLM_Order_Parser and send its preview.
      ws.send(
        encode({ type: "notice", kind: "llm_disabled", message: "Plain-English orders are disabled." }),
      );
      return;
    }
    const accountId = (ws.data.session ?? GUEST_SESSION).accountId;
    const result = parseCommand(text, { positionLots: (symbol) => bar.accounts.positionLots(accountId, symbol) });
    if (!result.ok) {
      ws.send(
        encode({
          type: "parse_error",
          request_id: requestId,
          message: result.error.message,
          position: result.error.position,
        }),
      );
      return;
    }
    const preview = bar.previews.create(clientId, accountId, result.command, formatCommand(result.command));
    ws.send(encode({ type: "preview", request_id: requestId, preview }));
  }

  /**
   * Confirm (Req 22.4, trading-safety rule 3): the preview must be this connection's, unexpired,
   * and for the connection's current account. Then it goes to the Router, which applies the
   * Risk_Engine. A rejected order reaches the requester through the Router's `onRejected`.
   */
  #confirm(ws: GatewaySocket, clientId: string, bar: CommandBar, previewId: string): void {
    const session = ws.data.session ?? GUEST_SESSION;
    const taken = bar.previews.take(previewId, clientId, session.accountId);
    if (!taken.ok) {
      ws.send(errorMessage("invalid_command", `confirm rejected: ${taken.error}`));
      return;
    }
    const origin: OrderOrigin = { connectionId: clientId, session, source: "web" };
    try {
      this.#runConfirmed(ws, taken.command, bar.router, origin);
    } catch {
      this.#log.error(`[gateway] client ${clientId} confirm failed unexpectedly`);
      ws.send(errorMessage("internal", "confirm failed"));
    }
  }

  #runConfirmed(
    ws: GatewaySocket,
    command: ParsedCommand,
    router: CommandBar["router"],
    origin: OrderOrigin,
  ): void {
    switch (command.kind) {
      case "place":
        // A rejection is already delivered as an OrderRejected event (Req 19.7).
        router.submit(
          { symbol: command.symbol, side: command.side, qty: command.qty, kind: command.order },
          origin,
        );
        return;
      case "cancel_all": {
        const result = router.cancelAll(origin);
        if (!result.ok) ws.send(errorMessage("invalid_command", `cancel all rejected: ${result.reason}`));
        return;
      }
      case "flatten_all": {
        const result = router.flattenAll(origin);
        if (!result.ok) ws.send(errorMessage("invalid_command", `flatten all rejected: ${result.reason}`));
        return;
      }
    }
  }

  /** Runs one Router action for this connection and reports a failure to it. */
  #orderAction(
    ws: GatewaySocket,
    clientId: string,
    action: string,
    run: (router: GatewayRouter, origin: OrderOrigin) => OrderActionResult,
  ): void {
    const router = this.#router;
    if (router === null) {
      ws.send(errorMessage("internal", ORDER_ENTRY_UNAVAILABLE));
      return;
    }
    const origin: OrderOrigin = { connectionId: clientId, session: ws.data.session ?? GUEST_SESSION, source: "web" };
    try {
      const result = run(router, origin);
      if (!result.ok) ws.send(errorMessage("invalid_command", `${action} rejected: ${result.reason}`));
    } catch {
      this.#log.error(`[gateway] client ${clientId} ${action} failed unexpectedly`);
      ws.send(errorMessage("internal", `${action} failed`));
    }
  }

  #subscribe(ws: GatewaySocket, clientId: string, symbol: string, timeframe: Timeframe): void {
    if (instrumentBySymbol(symbol) === undefined) {
      const known = INSTRUMENTS.map((i) => i.symbol).join(", ");
      ws.send(errorMessage("unknown_symbol", `unknown symbol; expected one of ${known}`));
      return;
    }
    const { first } = this.registry.subscribe(clientId, symbol, timeframe);
    // Bun topic subscriptions are idempotent, so a repeated subscribe is harmless.
    ws.subscribe(candlesTopic(symbol, timeframe));
    ws.subscribe(marketTopic(symbol));
    if (first) {
      // The engine answers with a history snapshot, published to the candles topic and cached.
      // While the engine is down this returns false; the supervisor resends on start (Req 15.4).
      this.#supervisor.sendControl({ type: "subscribe", symbol, timeframe });
      return;
    }
    // Later subscribers get the cached snapshot. Without one yet, the engine's snapshot is still
    // on its way and reaches this client through the topic.
    const snapshot = this.market.snapshot(symbol, timeframe);
    if (snapshot !== null) ws.send(encode({ type: "event", event: snapshot }));
  }

  /** A key lost its last subscriber: stop the engine stream and drop its now-stale candles. */
  #release(key: SubscriptionKey): void {
    this.market.dropCandles(key.symbol, key.timeframe);
    this.#supervisor.sendControl({ type: "unsubscribe", symbol: key.symbol, timeframe: key.timeframe });
  }

  #unsubscribe(ws: GatewaySocket, clientId: string, symbol: string, timeframe: Timeframe): void {
    if (!this.registry.isSubscribed(clientId, symbol, timeframe)) return;
    const dropped = this.registry.unsubscribe(clientId, symbol, timeframe);
    ws.unsubscribe(candlesTopic(symbol, timeframe));
    // market:<symbol> is shared by every timeframe of the symbol: keep it while any remain.
    if (!this.registry.clientHasSymbol(clientId, symbol)) ws.unsubscribe(marketTopic(symbol));
    for (const key of dropped) this.#release(key);
  }

  // -------------------------------------------------------------------------------------------
  // Engine output
  // -------------------------------------------------------------------------------------------

  /** Routes one engine event to its topic or connection (Req 17.6, 17.7, 17.10). */
  handleEngineEvent(event: Event): void {
    // Candles are cached only for keys that still have subscribers: a snapshot that arrives
    // after the last unsubscribe would otherwise sit in the cache, never updated again.
    if (event.type !== "candle" || this.registry.count(event.symbol, event.timeframe) > 0) {
      this.market.apply(event);
    }
    if (event.type === "error") {
      this.#log.warn(`[gateway] engine error ${event.code}: ${event.message}`);
      return;
    }

    let requester: string | undefined;
    if (event.type === "order_rejected") {
      const candidate = this.pendingRequests.take(event.order_id);
      // Deliver to the requester only while it is still connected and still on the account the
      // order was placed for; otherwise fall back to the account topic.
      if (candidate !== undefined && this.#sockets.get(candidate)?.data.session?.accountId === event.account_id) {
        requester = candidate;
      }
    }
    const route = routeAccountEvent(event, { requester });
    const data = encode({ type: "event", event });
    if ("topic" in route) {
      this.#publish(route.topic, data);
    } else if ("toConnection" in route) {
      this.#sockets.get(route.toConnection)?.send(data);
    }
  }

  /** Engine lifecycle notices go to every connection on the notices topic (Req 17.9). */
  handleNotice(notice: EngineNotice): void {
    this.#publish(NOTICES_TOPIC, encode({ type: "notice", kind: notice.kind, message: notice.message }));
  }

  #publish(topic: string, data: string): void {
    this.#publisher?.publish(topic, data);
  }

  #clientId(ws: GatewaySocket): string {
    if (ws.data.clientId === undefined) ws.data.clientId = this.#randomUUID();
    return ws.data.clientId;
  }
}
