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
//   CommandText → `Preview` or `ParseError` (`?` text → LLM_Order_Parser → `Preview` or `ParseError`, or `Notice ai_disabled` without a key, Req 23);
//   the preview's venue is the message's venue or the default, checked against the hello list.
// - Copilot (`setAi`, Task 10.6): SetProvider → Providers; AiRequest → Analysis, ScanResult,
//   StrategyDraft, or AiError, through AiLimiter and abortable with AiCancel. A trade idea becomes
//   an Order_Preview (needs Confirm); the AI never submits an order.
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
  type Venue,
  VenueSchema,
  parseClientMessage,
} from "../protocol.ts";
import { formatCommand } from "../commands/formatter.ts";
import { type ParsedCommand, parseCommand } from "../commands/parser.ts";
import type { PreviewStore } from "../commands/previews.ts";
import { AiError, analyze, mapAnalystError } from "../ai/analyst.ts";
import { type AiLimiter, toAiErrorReason } from "../ai/limits.ts";
import { chat } from "../ai/chat.ts";
import { draftStrategy, scan } from "../ai/scan.ts";
import { type MarketSnapshot, buildMarketSnapshot } from "../ai/snapshot.ts";
import type { JsonLlmProvider, LlmProviderId } from "../llm/provider.ts";
import { LLM_DISABLED_MESSAGE, type LlmOrderParser } from "../llm/parser.ts";
import type { ProviderRegistry } from "../llm/registry.ts";
import type { NewsCache, NewsState } from "../news/cache.ts";
import type { AccountState } from "../state/account.ts";
import type { OrderOrigin, Router } from "../router.ts";
import { MarketState } from "../state/market.ts";
import { type SubscriptionKey, SubscriptionRegistry } from "./clients.ts";
import { type BatchEvent, type BatcherTimer, EventBatcher, coalesceKey, defaultTimer } from "./batcher.ts";
import { latency, nowUs } from "../latency/histogram.ts";
import {
  NOTICES_TOPIC,
  PendingRequests,
  TopicMembers,
  accountTopic,
  candlesTopic,
  marketTopic,
  routeAccountEvent,
  tickerTopic,
} from "./routing.ts";

export { NOTICES_TOPIC, accountTopic, candlesTopic, marketTopic, tickerTopic };

/** Wire protocol version sent in `Hello` (`PROTOCOL_VERSION` in rust/crates/protocol/src/lib.rs). */
export const PROTOCOL_VERSION = 3;

/**
 * Starting_Balance sent in `Hello`, as Money (10^-10 USD): 100,000 USD, the design default of
 * STARTING_BALANCE. The config variable and the engine flag arrive with the balance task.
 */
export const DEFAULT_STARTING_BALANCE = "1000000000000000";

/** Text of the typed Notice that a not-yet-built feature answers with. */
export const NOT_IMPLEMENTED_MESSAGE = "not implemented yet";

/**
 * The default venue for a configuration: the Live_Venue in live mode, `replay` otherwise.
 * The default stays the first CEX; all LIVE_VENUES are available (see availableVenuesOf).
 */
export function defaultVenueOf(config: Pick<Config, "dataMode" | "liveVenue">): Venue {
  return config.dataMode === "live" ? config.liveVenue : "replay";
}

/** The venues a client may name: every configured live venue in live mode, `replay` in replay mode. */
export function availableVenuesOf(
  config: Pick<Config, "dataMode" | "liveVenue"> & Partial<Pick<Config, "liveVenues">>,
): readonly Venue[] {
  if (config.dataMode !== "live") return ["replay"];
  const all: Venue[] = [...(config.liveVenues ?? [config.liveVenue])];
  if (!all.includes(config.liveVenue) && config.liveVenues === undefined) all.push(config.liveVenue);
  return all;
}

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
  send(data: string, compress?: boolean): unknown;
  subscribe(topic: string): void;
  unsubscribe(topic: string): void;
  /** Bytes queued in the socket (Bun `getBufferedAmount`). Absent in simple fakes. */
  getBufferedAmount?(): number;
  /** Closes the socket (Bun `close`). */
  close?(code?: number, reason?: string): void;
}

/** Above this many buffered bytes, coalescible updates are held back (Req 34.8). */
export const SLOW_CLIENT_BYTES = 1024 * 1024;
/** Above this many buffered bytes the socket is closed with 1013 (Req 34.9). */
export const CLOSE_CLIENT_BYTES = 4 * 1024 * 1024;
/** Minimum gap between `slow_client` notices to one connection. */
export const SLOW_NOTICE_INTERVAL_MS = 10_000;

/** Per-connection outbound state: its batcher and slow-client bookkeeping. */
interface Outbound {
  readonly batcher: EventBatcher;
  /** Newest held coalescible event per key while the socket is slow. */
  readonly held: Map<string, BatchEvent>;
  /** Receipt times (µs) of events queued since the last send. */
  firstReceiptUs: number | null;
  lastSlowNoticeMs: number;
  /** Confirm times (µs) awaiting an OrderAck. */
  readonly confirms: number[];
}

const MAX_PENDING_CONFIRMS = 32;

/** Publishes to every socket subscribed to a topic. In production this is the Bun server. */
export interface Publisher {
  publish(topic: string, data: string): unknown;
}

/** The supervisor surface the gateway needs. It does not include the order sender. */
export type GatewaySupervisor = Pick<
  EngineSupervisor,
  | "running"
  | "sessionId"
  | "sendControl"
  | "setSubscriptionProvider"
  | "onEvent"
  | "onNotice"
  | "onClearAccount"
  | "onSessionStart"
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

/** The Router surface the gateway calls for TWAP start (on Confirm) and CancelTwap. */
export type GatewayTwap = Pick<Router, "startTwap" | "cancelTwap">;

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
  /**
   * The LLM_Order_Parser (Task 13.2, Req 23). Absent or disabled: `?` text gets
   * `Notice ai_disabled` (Req 23.7). It yields commands only; they become previews here and
   * reach the Router only through Confirm.
   */
  readonly llm?: Pick<LlmOrderParser, "parse">;
}

/** Copilot wiring (Task 10.6): providers, limits, and the account state snapshots read. */
export interface AiDeps {
  readonly registry: Pick<ProviderRegistry, "info" | "get" | "defaultId" | "refresh"> &
    Partial<Pick<ProviderRegistry, "hasModel" | "chooseOllamaModel" | "onModelsChanged">>;
  readonly limiter: Pick<AiLimiter, "acquire" | "release" | "forget">;
  readonly accounts: Pick<AccountState, "positions" | "balance">;
}

type AiErrorReason = Extract<ServerMessage, { type: "ai_error" }>["reason"];
type AiRequestMsg = Extract<ClientMessage, { type: "ai_request" }>;

const SCAN_SNAPSHOT_CANDLES = 50;
const SCAN_SNAPSHOT_BOOK_LEVELS = 5;
const SCAN_SNAPSHOT_NEWS = 3;
const AI_NEWS_ITEMS = 10;

function aiReasonOf(error: AiError): AiErrorReason {
  switch (error.code) {
    case "validation_error":
      return "validation_error";
    case "timeout":
      return "timeout";
    case "cancelled":
      return "canceled";
    case "refused":
    case "provider_unavailable":
      return "provider_error";
  }
}

/** Called when a connection closes, with its connection id. */
export type ConnectionClosedListener = (connectionId: string) => void;

export interface GatewayOptions {
  readonly supervisor: GatewaySupervisor;
  readonly config: Pick<Config, "dataMode" | "liveVenue"> & Partial<Pick<Config, "liveVenues">>;
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
  /** Timer of every connection's event batcher (Req 34). Tests inject one that flushes at once. */
  readonly batcherTimer?: BatcherTimer;
}

const consoleLogger: Logger = {
  info: (line) => console.log(line),
  warn: (line) => console.warn(line),
  error: (line) => console.error(line),
};

const NEWS_TOPIC = "news";

function newsMessageOf(state: NewsState): ServerMessage {
  return {
    type: "news",
    available: state.available,
    items: state.items.map((i) => ({ ...i, symbols: [...i.symbols] })),
    updated_at: state.updatedAt,
  };
}

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
  readonly #config: Pick<Config, "dataMode" | "liveVenue"> & Partial<Pick<Config, "liveVenues">>;
  readonly #log: Logger;
  readonly #randomUUID: () => string;
  readonly #tokens: TokenVerifier | null;
  readonly #now: () => number;
  readonly #batcherTimer: BatcherTimer;
  readonly #unlisten: (() => void)[] = [];
  /** connection id → socket, for `{ toConnection }` routing and downgrades. */
  readonly #sockets = new Map<string, GatewaySocket>();
  /** jti → connection ids signed in with that token. */
  readonly #byJti = new Map<string, Set<string>>();
  readonly #accountListeners = new Set<AccountChangeListener>();
  readonly #closedListeners = new Set<ConnectionClosedListener>();
  /** Connections with a plain-English order in flight. */
  readonly #llmBusy = new Set<string>();
  /** `<venue>|<symbol>` → connection ids with an active ticker subscription. */
  readonly #tickerClients = new Map<string, Set<string>>();
  /** connection id → selected provider (SetProvider). */
  readonly #selected = new Map<string, LlmProviderId>();
  /** connection id → selected Ollama model (SetModel, Req 38.9). */
  readonly #selectedModel = new Map<string, string>();
  #modelsUnlisten: (() => void) | null = null;
  /** `<connection>|<request_id>` → abort controller of an in-flight AI request. */
  readonly #aiRuns = new Map<string, AbortController>();
  /** connection id → its batcher and slow-client state. */
  readonly #out = new Map<string, Outbound>();
  readonly #members = new TopicMembers();
  #ai: AiDeps | null = null;
  #publisher: Publisher | null = null;
  #router: GatewayRouter | null = null;
  #commandBar: CommandBar | null = null;
  #twap: GatewayTwap | null = null;
  #news: NewsCache | null = null;
  #newsUnlisten: (() => void) | null = null;

  constructor(options: GatewayOptions) {
    this.#supervisor = options.supervisor;
    this.#config = options.config;
    this.registry = options.registry ?? new SubscriptionRegistry();
    this.market = options.market ?? new MarketState();
    this.#log = options.logger ?? consoleLogger;
    this.#randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
    this.#tokens = options.tokens ?? null;
    this.#now = options.now ?? Date.now;
    this.#batcherTimer = options.batcherTimer ?? defaultTimer;
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
      // The supervisor resends candle subscriptions itself; ticker subscriptions are resent here.
      this.#supervisor.onSessionStart(() => {
        for (const key of this.#tickerClients.keys()) {
          const sep = key.indexOf("|");
          const venue = VenueSchema.safeParse(key.slice(0, sep));
          if (venue.success) {
            this.#supervisor.sendControl({ type: "subscribe_ticker", venue: venue.data, symbol: key.slice(sep + 1) });
          }
        }
      }),
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

  /** Sets the Router surface for TWAP start and cancel. Without it they are refused. */
  setTwap(twap: GatewayTwap | null): void {
    this.#twap = twap;
  }

  /** Enables the Copilot (SetProvider, AiRequest, AiCancel). Without it AI requests answer `ai_disabled`. */
  setAi(ai: AiDeps | null): void {
    this.#modelsUnlisten?.();
    this.#modelsUnlisten = null;
    this.#ai = ai;
    // Req 38.10, 38.14: when the Ollama_Model_List changes, drop selections that vanished and tell every client.
    this.#modelsUnlisten = ai?.registry.onModelsChanged?.(() => this.#modelsChanged()) ?? null;
  }

  #modelsChanged(): void {
    const registry = this.#ai?.registry;
    if (registry === undefined) return;
    for (const [clientId, ws] of this.#sockets) {
      const chosen = this.#selectedModel.get(clientId);
      if (chosen !== undefined && registry.hasModel?.(chosen) !== true) this.#selectedModel.delete(clientId);
      try {
        // Availability of ollama changed too, so the provider list goes out first.
        ws.send(encode(this.#providersMessage(clientId)));
        ws.send(encode(this.#ollamaModelsMessage(clientId)));
      } catch {
        this.#log.error(`[gateway] client ${clientId} ollama_models send failed`);
      }
    }
  }

  #ollamaModelsMessage(clientId: string): ServerMessage {
    const registry = this.#ai?.registry;
    const models = registry?.info().find((p) => p.id === "ollama")?.models ?? [];
    const chosen = this.#selectedModel.get(clientId);
    const selected = chosen !== undefined && registry?.hasModel?.(chosen) === true ? chosen : null;
    return {
      type: "ollama_models",
      models: [...models],
      default: registry?.chooseOllamaModel?.() ?? null,
      selected,
    };
  }

  #setModel(ws: GatewaySocket, clientId: string, provider: LlmProviderId, model: string): void {
    const ai = this.#ai;
    if (ai === null) {
      ws.send(encode({ type: "notice", kind: "ai_disabled", message: "AI Copilot is not configured on this server." }));
      return;
    }
    ai.registry
      .refresh()
      .catch(() => undefined)
      .then(() => {
        if (this.#sockets.get(clientId) !== ws) return;
        // Against the latest list only; the name is never logged or echoed (Req 38.11).
        if (provider !== "ollama" || ai.registry.hasModel?.(model) !== true) {
          ws.send(encode({ type: "notice", kind: "model_unknown", message: "That model is not installed." }));
          return;
        }
        this.#selectedModel.set(clientId, model);
        ws.send(encode(this.#ollamaModelsMessage(clientId)));
      })
      .catch(() => {
        this.#log.error(`[gateway] client ${clientId} set model failed unexpectedly`);
      });
  }

  /** Sets the news cache. Refreshes are published to every `SubscribeNews` connection. */
  setNews(news: NewsCache | null): void {
    this.#newsUnlisten?.();
    this.#newsUnlisten = null;
    this.#news = news;
    if (news !== null) {
      this.#newsUnlisten = news.onUpdate((state) => {
        this.#publish(NEWS_TOPIC, encode(newsMessageOf(state)));
      });
    }
  }

  #newsMessage(): ServerMessage {
    return newsMessageOf(this.#news?.state() ?? { available: false, items: [], updatedAt: null });
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
    this.#twap = null;
    this.#modelsUnlisten?.();
    this.#modelsUnlisten = null;
    this.setNews(null);
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
    this.#out.set(clientId, this.#makeOutbound(ws, clientId));
    this.#sub(ws, accountTopic(GUEST_ACCOUNT_ID)); // Req 46.1
    this.#sub(ws, NOTICES_TOPIC); // Req 17.9
    const liveVenues: Venue[] = this.#config.dataMode === "live" ? [...availableVenuesOf(this.#config)] : [];
    ws.send(
      encode({
        type: "hello",
        protocol_version: PROTOCOL_VERSION,
        data_mode: this.#config.dataMode,
        // Protocol v3: the live venues (empty in replay mode) replace the single `venue`.
        live_venues: liveVenues,
        // Latest status from engine VenueStatus events; "connecting" until the first one.
        venue_status: liveVenues.map((venue) => ({
          venue,
          status: this.market.venueStatus(venue) ?? ("connecting" as const),
        })),
        default_venue: defaultVenueOf(this.#config),
        starting_balance: DEFAULT_STARTING_BALANCE,
        engine_running: this.#supervisor.running,
        instruments: INSTRUMENTS.map((i) => ({ ...i, venues: [...i.venues] })),
        providers: this.#providerInfos(),
        news_enabled: this.#news?.enabled ?? false,
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
    this.#out.get(clientId)?.batcher.close();
    this.#out.delete(clientId);
    this.#members.removeAll(clientId);
    this.#unindexJti(clientId, ws.data.session?.jti ?? null);
    this.pendingRequests.dropConnection(clientId);
    this.#selected.delete(clientId);
    this.#selectedModel.delete(clientId);
    for (const [key, controller] of this.#aiRuns) {
      if (key.startsWith(`${clientId}|`)) controller.abort();
    }
    this.#ai?.limiter.forget(clientId);
    for (const listener of [...this.#closedListeners]) {
      try {
        listener(clientId);
      } catch (err) {
        this.#log.error(`[gateway] connection-closed listener failed: ${err instanceof Error ? err.name : "unknown"}`);
      }
    }
    // Bun drops the socket's topic subscriptions itself; only the engine side needs work.
    for (const key of this.registry.removeClient(clientId)) this.#release(key);
    for (const key of [...this.#tickerClients.keys()]) {
      const sep = key.indexOf("|");
      const venue = VenueSchema.safeParse(key.slice(0, sep));
      if (venue.success) this.#releaseTicker(clientId, key, venue.data, key.slice(sep + 1));
    }
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
      this.#unsub(ws, accountTopic(prev.accountId));
      this.#sub(ws, accountTopic(next.accountId));
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
      case "subscribe": {
        const venue = this.#resolveVenue(ws, msg.venue);
        if (venue !== null) this.#subscribe(ws, clientId, venue, msg.symbol, msg.timeframe);
        return;
      }
      case "unsubscribe": {
        const venue = this.#resolveVenue(ws, msg.venue);
        if (venue !== null) this.#unsubscribe(ws, clientId, venue, msg.symbol, msg.timeframe);
        return;
      }
      case "subscribe_ticker": {
        const venue = this.#resolveVenue(ws, msg.venue);
        if (venue !== null) this.#subscribeTicker(ws, clientId, venue, msg.symbol);
        return;
      }
      case "unsubscribe_ticker": {
        const venue = this.#resolveVenue(ws, msg.venue);
        if (venue !== null) this.#unsubscribeTicker(ws, clientId, venue, msg.symbol);
        return;
      }
      // Cancels one TWAP of the session's account only (Req 17.7).
      case "cancel_twap": {
        const twap = this.#twap;
        if (twap === null) {
          ws.send(errorMessage("internal", ORDER_ENTRY_UNAVAILABLE));
          return;
        }
        const origin: OrderOrigin = { connectionId: clientId, session: ws.data.session ?? GUEST_SESSION, source: "web" };
        try {
          const result = twap.cancelTwap(msg.twap_id, origin);
          if (!result.ok) ws.send(errorMessage("invalid_command", `cancel twap rejected: ${result.reason}`));
        } catch {
          this.#log.error(`[gateway] client ${clientId} cancel twap failed unexpectedly`);
          ws.send(errorMessage("internal", "cancel twap failed"));
        }
        return;
      }
      case "set_provider":
        this.#setProvider(ws, clientId, msg.provider);
        return;
      case "set_model":
        this.#setModel(ws, clientId, msg.provider, msg.model);
        return;
      case "ai_request": {
        const venue = this.#resolveVenue(ws, msg.venue);
        if (venue !== null) this.#aiRequest(ws, clientId, msg, venue);
        return;
      }
      case "ai_cancel":
        this.#aiRuns.get(`${clientId}|${msg.request_id}`)?.abort();
        return;
      case "subscribe_news":
        this.#sub(ws, NEWS_TOPIC);
        ws.send(encode(this.#newsMessage()));
        return;
      case "unsubscribe_news":
        this.#unsub(ws, NEWS_TOPIC);
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
        if (msg.type === "command_text") {
          const venue = this.#resolveVenue(ws, msg.venue);
          if (venue !== null) this.#commandText(ws, clientId, bar, msg.request_id, msg.text, venue);
        }
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
   * Command bar text (Req 21, 22.1). Text starting with `?` is a plain-English order and goes
   * to `#llmText`, which also ends in a preview.
   * Anything else is parsed here. The account for `%` amounts is the session's, never the message's.
   */
  #commandText(
    ws: GatewaySocket,
    clientId: string,
    bar: CommandBar,
    requestId: string,
    text: string,
    venue: Venue,
  ): void {
    const startedUs = nowUs();
    if (text.trimStart().startsWith("?")) {
      this.#llmText(ws, clientId, bar, requestId, text.trimStart().slice(1), venue);
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
    const preview = bar.previews.create(clientId, accountId, result.command, formatCommand(result.command), venue);
    ws.send(encode({ type: "preview", request_id: requestId, preview }));
    latency.command_to_preview.record(nowUs() - startedUs);
  }

  /**
   * Plain-English order (Req 23). The LLM_Order_Parser returns a command; it is stored as an
   * Order_Preview for this connection and its account, exactly like typed text (Req 23.3), and
   * needs Confirm (Req 23.6). Failure sends `ParseError` and no preview (Req 23.4, 23.5).
   * One request per connection at a time, to bound model calls. The account is read from the
   * session before the call and checked again after it: a switch in between drops the result.
   */
  #llmText(ws: GatewaySocket, clientId: string, bar: CommandBar, requestId: string, text: string, venue: Venue): void {
    const llm = bar.llm;
    const disabled = (message: string): void => {
      // Protocol v3 renames `llm_disabled` to `ai_disabled`.
      ws.send(encode({ type: "notice", kind: "ai_disabled", message }));
    };
    if (llm === undefined) {
      disabled(LLM_DISABLED_MESSAGE);
      return;
    }
    const fail = (message: string): void => {
      ws.send(encode({ type: "parse_error", request_id: requestId, message, position: 0 }));
    };
    if (this.#llmBusy.has(clientId)) {
      fail("A plain-English order is already being interpreted. Wait for it to finish.");
      return;
    }
    const accountId = (ws.data.session ?? GUEST_SESSION).accountId;
    const startedUs = nowUs();
    this.#llmBusy.add(clientId);
    llm
      .parse(text, accountId, this.#selected.get(clientId), this.#selectedModel.get(clientId))
      .then((result) => {
        if (this.#sockets.get(clientId) !== ws) return; // closed while waiting
        if ((ws.data.session ?? GUEST_SESSION).accountId !== accountId) {
          fail("Your account changed while the order was being interpreted. Try again.");
          return;
        }
        if (!result.ok) {
          if (result.kind === "disabled") disabled(result.message);
          else fail(result.message);
          return;
        }
        // The venue is the client's (validated) or the default, never one from LLM output.
        const preview = bar.previews.create(
          clientId,
          accountId,
          result.command,
          formatCommand(result.command),
          venue,
        );
        ws.send(encode({ type: "preview", request_id: requestId, preview }));
        latency.command_to_preview.record(nowUs() - startedUs);
      })
      .catch(() => {
        this.#log.error(`[gateway] client ${clientId} plain-English order failed unexpectedly`);
        if (this.#sockets.get(clientId) === ws) fail("Plain-English order failed.");
      })
      .finally(() => {
        this.#llmBusy.delete(clientId);
      });
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
    const confirms = this.#out.get(clientId)?.confirms;
    if (confirms !== undefined) {
      confirms.push(nowUs());
      if (confirms.length > MAX_PENDING_CONFIRMS) confirms.shift();
    }
    try {
      this.#runConfirmed(ws, taken.command, taken.venue, bar.router, origin);
    } catch {
      this.#log.error(`[gateway] client ${clientId} confirm failed unexpectedly`);
      ws.send(errorMessage("internal", "confirm failed"));
    }
  }

  #runConfirmed(
    ws: GatewaySocket,
    command: ParsedCommand,
    venue: Venue,
    router: CommandBar["router"],
    origin: OrderOrigin,
  ): void {
    switch (command.kind) {
      case "place":
        // A rejection is already delivered as an OrderRejected event (Req 19.7). The venue is
        // the confirmed preview's (protocol v3).
        router.submit(
          { symbol: command.symbol, side: command.side, qty: command.qty, kind: command.order, venue },
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
      case "twap": {
        // A confirmed preview authorizes the children of this plan only (trading-safety rule 3).
        const twap = this.#twap;
        if (twap === null) {
          ws.send(errorMessage("internal", ORDER_ENTRY_UNAVAILABLE));
          return;
        }
        const result = twap.startTwap(
          {
            symbol: command.symbol,
            side: command.side,
            venue,
            totalQty: command.totalQty,
            slices: command.slices,
            intervalS: command.intervalS,
          },
          origin,
        );
        if (!result.ok) ws.send(errorMessage("invalid_command", `twap rejected: ${result.reason}`));
        return;
      }
    }
  }

  /** Publishes a TWAP status to every connection on the owning account (Req 17.9). */
  publishTwapStatus(status: {
    readonly id: string;
    readonly accountId: AccountId;
    readonly symbol: string;
    readonly side: "buy" | "sell";
    readonly venue: string;
    readonly slices: number;
    readonly sent: number;
    readonly state: "running" | "completed" | "canceled" | "failed";
    readonly reason: string | null;
  }): void {
    const venue = VenueSchema.safeParse(status.venue);
    if (!venue.success) return;
    this.#publish(
      accountTopic(status.accountId),
      encode({
        type: "twap",
        twap_id: status.id,
        symbol: status.symbol,
        side: status.side,
        venue: venue.data,
        slices: status.slices,
        sent: status.sent,
        status: status.state === "running" ? "active" : status.state === "completed" ? "done" : "canceled",
        reason: status.reason,
      }),
    );
  }

  /**
   * The venue a message names, checked against the venues of this configuration (the `hello`
   * list). Null or absent means the default venue. An unavailable venue gets an Error and null.
   */
  #resolveVenue(ws: GatewaySocket, venue: Venue | null): Venue | null {
    const resolved = venue ?? defaultVenueOf(this.#config);
    if (availableVenuesOf(this.#config).includes(resolved)) return resolved;
    ws.send(errorMessage("invalid_message", `venue ${resolved} is not available`));
    return null;
  }

  // -------------------------------------------------------------------------------------------
  // Copilot (Task 10.6). The AI only suggests: a trade idea becomes an Order_Preview for this
  // connection and needs Confirm; nothing here reaches the Router (trading-safety rules 2 to 4).
  // -------------------------------------------------------------------------------------------

  #providerInfos(): {
    id: LlmProviderId;
    model: string;
    reason: string | null;
    models?: { name: string; size: number; family: string | null; parameter_size: string | null }[];
  }[] {
    return (this.#ai?.registry.info() ?? []).map((p) => ({
      id: p.id,
      model: p.model,
      reason: p.available ? null : p.id === "ollama" && p.reachable === true ? "no models" : "not available",
      ...(p.models !== undefined ? { models: p.models.map((m) => ({ ...m })) } : {}),
    }));
  }

  #providersMessage(clientId: string): ServerMessage {
    const registry = this.#ai?.registry;
    const selected = this.#selected.get(clientId) ?? null;
    return {
      type: "providers",
      available: this.#providerInfos(),
      default: registry?.defaultId() ?? null,
      selected: selected !== null && registry?.get(selected) !== undefined ? selected : null,
    };
  }

  #setProvider(ws: GatewaySocket, clientId: string, provider: LlmProviderId): void {
    const ai = this.#ai;
    if (ai === null) {
      ws.send(encode({ type: "notice", kind: "ai_disabled", message: "AI Copilot is not configured on this server." }));
      return;
    }
    ai.registry
      .refresh()
      .catch(() => undefined)
      .then(() => {
        if (this.#sockets.get(clientId) !== ws) return;
        if (ai.registry.get(provider) !== undefined) this.#selected.set(clientId, provider);
        else this.#selected.delete(clientId);
        ws.send(encode(this.#providersMessage(clientId)));
      })
      .catch(() => {
        this.#log.error(`[gateway] client ${clientId} set provider failed unexpectedly`);
      });
  }

  #aiError(ws: GatewaySocket, requestId: string, reason: AiErrorReason, message: string): void {
    ws.send(encode({ type: "ai_error", request_id: requestId, reason, message }));
  }

  /** The connection's selected provider if available, else the default; undefined when none. */
  #resolveProvider(ai: AiDeps, clientId: string): JsonLlmProvider | undefined {
    const selected = this.#selected.get(clientId);
    const chosen = selected !== undefined && ai.registry.get(selected) !== undefined ? selected : ai.registry.defaultId();
    if (chosen === null) return undefined;
    if (chosen === "ollama" && ai.registry.chooseOllamaModel !== undefined) {
      // Req 38.12, 38.13: the selected model if installed, else OLLAMA_MODEL, else the first installed.
      const model = ai.registry.chooseOllamaModel(this.#selectedModel.get(clientId));
      return model === undefined ? undefined : ai.registry.get("ollama", model);
    }
    return ai.registry.get(chosen);
  }

  #snapshotFor(
    ai: AiDeps,
    accountId: AccountId,
    symbol: string,
    venue: Venue,
    timeframe: Timeframe,
    reduced: boolean,
  ): MarketSnapshot {
    const news = this.#news?.top(AI_NEWS_ITEMS) ?? [];
    const snap = buildMarketSnapshot({
      symbol,
      venue,
      timeframe,
      accountId,
      now: this.#now(),
      market: this.market,
      account: ai.accounts,
      news,
    });
    if (!reduced) return snap;
    return {
      ...snap,
      candles: snap.candles.slice(-SCAN_SNAPSHOT_CANDLES),
      book: {
        ...snap.book,
        bids: snap.book.bids.slice(0, SCAN_SNAPSHOT_BOOK_LEVELS),
        asks: snap.book.asks.slice(0, SCAN_SNAPSHOT_BOOK_LEVELS),
      },
      news: snap.news.slice(0, SCAN_SNAPSHOT_NEWS),
    };
  }

  #aiRequest(ws: GatewaySocket, clientId: string, msg: AiRequestMsg, venue: Venue): void {
    const ai = this.#ai;
    const requestId = msg.request_id;
    if (ai === null) {
      this.#aiError(ws, requestId, "ai_disabled", "AI Copilot is not configured on this server.");
      return;
    }
    const key = `${clientId}|${requestId}`;
    if (this.#aiRuns.has(key)) {
      this.#aiError(ws, requestId, "validation_error", "A request with this id is already running.");
      return;
    }
    const controller = new AbortController();
    this.#aiRuns.set(key, controller);
    const accountId = (ws.data.session ?? GUEST_SESSION).accountId;
    this.#runAi(ws, clientId, ai, msg, venue, accountId, controller)
      .catch((error: unknown) => {
        if (this.#sockets.get(clientId) !== ws) return;
        if (error instanceof AiError) {
          this.#aiError(ws, requestId, aiReasonOf(error), error.message);
        } else {
          this.#log.error(`[gateway] client ${clientId} AI request failed unexpectedly`);
          this.#aiError(ws, requestId, "provider_error", "The AI request failed.");
        }
      })
      .finally(() => {
        this.#aiRuns.delete(key);
      });
  }

  async #runAi(
    ws: GatewaySocket,
    clientId: string,
    ai: AiDeps,
    msg: AiRequestMsg,
    venue: Venue,
    accountId: AccountId,
    controller: AbortController,
  ): Promise<void> {
    const requestId = msg.request_id;
    const signal = controller.signal;
    await ai.registry.refresh().catch(() => undefined);
    const provider = this.#resolveProvider(ai, clientId);
    if (provider === undefined) {
      this.#aiError(ws, requestId, "ai_disabled", "No AI provider is available.");
      return;
    }
    const symbols =
      msg.action === "scan"
        ? INSTRUMENTS.filter((i) => i.venues.includes(venue)).map((i) => i.symbol)
        : [msg.symbol];
    if (
      msg.action !== "scan" &&
      msg.action !== "create_strategy" &&
      msg.action !== "chat" &&
      instrumentBySymbol(msg.symbol) === undefined) {
      this.#aiError(ws, requestId, "validation_error", "Unknown symbol.");
      return;
    }
    // Ollama is local and free (0 daily units); a scan costs one unit per symbol.
    const units = provider.id === "ollama" ? 0 : msg.action === "scan" ? symbols.length : 1;
    const acquired = ai.limiter.acquire(clientId, accountId, units);
    if (!acquired.ok) {
      const reason = toAiErrorReason(acquired.reason);
      this.#aiError(ws, requestId, reason, reason === "ai_daily_cap" ? "Daily AI limit reached." : "Too many AI requests. Wait a moment.");
      return;
    }
    try {
      const userText = msg.text.trim() === "" ? undefined : msg.text;
      const text = userText === undefined ? {} : { userText };
      let reply: ServerMessage;
      if (msg.action === "scan") {
        const snapshots = symbols.map((s) => this.#snapshotFor(ai, accountId, s, venue, msg.timeframe, true));
        const items = await scan({ provider, snapshots, signal });
        reply = {
          type: "scan_result",
          request_id: requestId,
          items: items.map((i) => ({
            symbol: i.symbol,
            bias: i.bias,
            confidence_bps: i.confidence_bps,
            summary: i.summary,
          })),
        };
      } else if (msg.action === "chat") {
        const known = instrumentBySymbol(msg.symbol) !== undefined;
        const snapshot = known ? this.#snapshotFor(ai, accountId, msg.symbol, venue, msg.timeframe, true) : undefined;
        const replyText = await chat({
          provider,
          signal,
          userText: msg.text,
          ...(snapshot === undefined ? {} : { snapshot }),
        });
        reply = { type: "ai_chat", request_id: requestId, text: replyText };
      } else if (msg.action === "create_strategy") {
        const known = instrumentBySymbol(msg.symbol) !== undefined;
        const snapshot = known ? this.#snapshotFor(ai, accountId, msg.symbol, venue, msg.timeframe, true) : undefined;
        const draft = await draftStrategy({
          provider,
          signal,
          ...text,
          ...(snapshot === undefined ? {} : { snapshot }),
        });
        reply = { type: "strategy_draft", request_id: requestId, text: draft };
      } else {
        const snapshot = this.#snapshotFor(ai, accountId, msg.symbol, venue, msg.timeframe, false);
        const news = (this.#news?.top(AI_NEWS_ITEMS) ?? []).map((n) => n.title);
        const result = await analyze({ provider, snapshot, news, signal, ...text });
        reply = this.#analysisMessage(clientId, accountId, venue, requestId, msg.symbol, result);
      }
      if (signal.aborted) throw new AiError("cancelled", "The request was cancelled");
      if (this.#sockets.get(clientId) !== ws) return;
      if ((ws.data.session ?? GUEST_SESSION).accountId !== accountId) {
        throw new AiError("cancelled", "Your account changed while the request ran.");
      }
      // The preview was stored for the account at request time, which is still current.
      ws.send(encode(reply));
    } catch (error) {
      throw error instanceof AiError ? error : mapAnalystError(error, signal);
    } finally {
      ai.limiter.release(clientId);
    }
  }

  /** Builds the Analysis reply. A trade idea goes through the normal command parser into a preview. */
  #analysisMessage(
    clientId: string,
    accountId: AccountId,
    venue: Venue,
    requestId: string,
    symbol: string,
    result: Awaited<ReturnType<typeof analyze>>,
  ): ServerMessage {
    const bar = this.#commandBar;
    let preview: Extract<ServerMessage, { type: "preview" }>["preview"] | null = null;
    let previewError: { message: string; position: number } | null = null;
    if (result.commandText !== null && bar !== null) {
      const parsed = parseCommand(result.commandText, {
        positionLots: (s) => bar.accounts.positionLots(accountId, s),
      });
      if (parsed.ok) {
        preview = bar.previews.create(clientId, accountId, parsed.command, formatCommand(parsed.command), venue);
      } else {
        previewError = { message: parsed.error.message, position: parsed.error.position };
      }
    }
    const action = preview?.action;
    return {
      type: "analysis",
      request_id: requestId,
      provider: result.provider,
      model: result.model,
      analysis: {
        symbol,
        summary: result.analysis.summary,
        bias: result.analysis.bias,
        confidence_bps: Math.round(result.analysis.confidence * 10_000),
        rationale: [...result.analysis.rationale],
        suggested_order:
          action !== undefined && action.type === "place"
            ? { side: action.side, qty: action.qty, kind: action.kind }
            : null,
      },
      preview,
      preview_error: previewError,
    };
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

  #subscribe(ws: GatewaySocket, clientId: string, venue: Venue, symbol: string, timeframe: Timeframe): void {
    if (instrumentBySymbol(symbol) === undefined) {
      const known = INSTRUMENTS.map((i) => i.symbol).join(", ");
      ws.send(errorMessage("unknown_symbol", `unknown symbol; expected one of ${known}`));
      return;
    }
    const { first } = this.registry.subscribe(clientId, venue, symbol, timeframe);
    // Bun topic subscriptions are idempotent, so a repeated subscribe is harmless.
    this.#sub(ws, candlesTopic(venue, symbol, timeframe));
    this.#sub(ws, marketTopic(venue, symbol));
    if (first) {
      // The engine answers with a history snapshot, published to the candles topic and cached.
      // While the engine is down this returns false; the supervisor resends on start (Req 15.4).
      this.#supervisor.sendControl({ type: "subscribe", venue, symbol, timeframe });
      return;
    }
    // Later subscribers get the cached snapshot. Without one yet, the engine's snapshot is still
    // on its way and reaches this client through the topic.
    const snapshot = this.market.snapshot(symbol, timeframe, venue);
    if (snapshot !== null) ws.send(encode({ type: "event", event: snapshot }));
  }

  #subscribeTicker(ws: GatewaySocket, clientId: string, venue: Venue, symbol: string): void {
    if (instrumentBySymbol(symbol) === undefined) {
      const known = INSTRUMENTS.map((i) => i.symbol).join(", ");
      ws.send(errorMessage("unknown_symbol", `unknown symbol; expected one of ${known}`));
      return;
    }
    const key = `${venue}|${symbol}`;
    let clients = this.#tickerClients.get(key);
    const first = clients === undefined;
    if (clients === undefined) {
      clients = new Set();
      this.#tickerClients.set(key, clients);
    }
    clients.add(clientId);
    this.#sub(ws, tickerTopic(venue, symbol));
    // The engine starts the ticker stream on the first subscriber only.
    if (first) this.#supervisor.sendControl({ type: "subscribe_ticker", venue, symbol });
  }

  #unsubscribeTicker(ws: GatewaySocket, clientId: string, venue: Venue, symbol: string): void {
    const key = `${venue}|${symbol}`;
    if (!this.#tickerClients.get(key)?.has(clientId)) return;
    this.#unsub(ws, tickerTopic(venue, symbol));
    this.#releaseTicker(clientId, key, venue, symbol);
  }

  #releaseTicker(clientId: string, key: string, venue: Venue, symbol: string): void {
    const clients = this.#tickerClients.get(key);
    if (clients === undefined || !clients.delete(clientId)) return;
    if (clients.size > 0) return;
    this.#tickerClients.delete(key);
    this.#supervisor.sendControl({ type: "unsubscribe_ticker", venue, symbol });
  }

  /** A key lost its last subscriber: stop the engine stream and drop its now-stale candles. */
  #release(key: SubscriptionKey): void {
    this.market.dropCandles(key.symbol, key.timeframe, key.venue);
    this.#supervisor.sendControl({
      type: "unsubscribe",
      venue: key.venue,
      symbol: key.symbol,
      timeframe: key.timeframe,
    });
  }

  #unsubscribe(ws: GatewaySocket, clientId: string, venue: Venue, symbol: string, timeframe: Timeframe): void {
    if (!this.registry.isSubscribed(clientId, venue, symbol, timeframe)) return;
    const dropped = this.registry.unsubscribe(clientId, venue, symbol, timeframe);
    this.#unsub(ws, candlesTopic(venue, symbol, timeframe));
    // market:<venue>:<symbol> is shared by every timeframe of the pair: keep it while any remain.
    if (!this.registry.clientHasSymbol(clientId, venue, symbol)) this.#unsub(ws, marketTopic(venue, symbol));
    for (const key of dropped) this.#release(key);
  }

  // -------------------------------------------------------------------------------------------
  // Engine output
  // -------------------------------------------------------------------------------------------

  /** Routes one engine event to its topic or connection (Req 17.6, 17.7, 17.10). */
  handleEngineEvent(event: Event): void {
    // Candles are cached only for keys that still have subscribers: a snapshot that arrives
    // after the last unsubscribe would otherwise sit in the cache, never updated again.
    if (event.type !== "candle" || this.registry.count(event.venue, event.symbol, event.timeframe) > 0) {
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
    const receiptUs = nowUs();
    const item = event as unknown as BatchEvent;
    if ("topic" in route) {
      for (const id of this.#members.of(route.topic)) {
        this.#deliver(id, item, receiptUs);
        if (event.type === "order_ack" && event.status === "accepted") this.#recordConfirmToAck(id, receiptUs);
      }
    } else if ("toConnection" in route) {
      this.#deliver(route.toConnection, item, receiptUs);
      this.#out.get(route.toConnection)?.confirms.shift();
    }
  }

  #makeOutbound(ws: GatewaySocket, clientId: string): Outbound {
    const out: Outbound = {
      held: new Map(),
      firstReceiptUs: null,
      lastSlowNoticeMs: Number.NEGATIVE_INFINITY,
      confirms: [],
      batcher: new EventBatcher(
        {
          send: (json, compress) => {
            ws.send(json, compress);
            if (out.firstReceiptUs !== null) {
              latency.receipt_to_client.record(nowUs() - out.firstReceiptUs);
              out.firstReceiptUs = null;
            }
            if ((ws.getBufferedAmount?.() ?? 0) > CLOSE_CLIENT_BYTES) this.#closeSlow(ws, clientId);
          },
        },
        this.#batcherTimer,
      ),
    };
    return out;
  }

  #closeSlow(ws: GatewaySocket, clientId: string): void {
    this.#log.warn(`[gateway] client ${clientId} closed: send buffer over ${CLOSE_CLIENT_BYTES} bytes`);
    ws.close?.(1013, "try again later");
  }

  /**
   * Queues one engine event on a connection's batcher. Above 1 MB buffered, coalescible events
   * are held (newest per key) and a `slow_client` notice is sent at most every 10 s; above 4 MB
   * the socket closes with 1013 (Req 34.8, 34.9). Held events go out once the buffer drains.
   */
  #deliver(connectionId: string, event: BatchEvent, receiptUs: number): void {
    const ws = this.#sockets.get(connectionId);
    const out = this.#out.get(connectionId);
    if (ws === undefined || out === undefined) return;
    const buffered = ws.getBufferedAmount?.() ?? 0;
    if (buffered > CLOSE_CLIENT_BYTES) {
      this.#closeSlow(ws, connectionId);
      return;
    }
    const key = coalesceKey(event);
    if (buffered > SLOW_CLIENT_BYTES) {
      const nowMs = this.#now();
      if (nowMs - out.lastSlowNoticeMs >= SLOW_NOTICE_INTERVAL_MS) {
        out.lastSlowNoticeMs = nowMs;
        ws.send(encode({ type: "notice", kind: "slow_client", message: "Connection is slow; some updates were dropped." }));
      }
      if (key !== null) {
        out.held.delete(key);
        out.held.set(key, event);
        return;
      }
    } else if (out.held.size > 0) {
      for (const held of out.held.values()) out.batcher.push(held);
      out.held.clear();
    }
    out.firstReceiptUs ??= receiptUs;
    out.batcher.push(event);
  }

  #recordConfirmToAck(connectionId: string, atUs: number): void {
    const started = this.#out.get(connectionId)?.confirms.shift();
    if (started !== undefined) latency.confirm_to_ack.record(atUs - started);
  }

  #sub(ws: GatewaySocket, topic: string): void {
    ws.subscribe(topic);
    const id = ws.data.clientId;
    if (id !== undefined) this.#members.add(topic, id);
  }

  #unsub(ws: GatewaySocket, topic: string): void {
    ws.unsubscribe(topic);
    const id = ws.data.clientId;
    if (id !== undefined) this.#members.remove(topic, id);
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
