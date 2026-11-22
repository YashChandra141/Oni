// Server entry point (design §3): config → supervisor → gateway → Bun.serve.
//
// `createApp` builds the request and WebSocket handlers from injected dependencies, and
// `startServer` runs them with Bun.serve and starts the supervisor. The Task 3.6 integration
// test calls `startServer` with port 0 and its own engine path. The process entry point
// (signals, exit codes) runs only when this file is executed directly (`bun src/main.ts`).
//
// Routing in `fetch`: `/ws` goes through the Origin check (403 when denied, Req 17.2) and is
// upgraded (Req 17.1); every other request goes to the Hono app.

import { isAbsolute, resolve } from "node:path";
import type { Server } from "bun";
import { clientIp } from "./auth/clientip.ts";
import { NonceStore } from "./auth/nonces.ts";
import { PairingStore } from "./auth/pairing.ts";
import { RateLimiter } from "./auth/ratelimit.ts";
import { createAuthRoutes, socketAddressFromEnv } from "./auth/routes.ts";
import { TokenService } from "./auth/token.ts";
import { type Config, type SecretSource, loadConfigOrExit, redactSecrets } from "./config.ts";
import { PreviewStore } from "./commands/previews.ts";
import { LlmOrderParser, type LlmProviderSource } from "./llm/parser.ts";
import { buildRegistry } from "./llm/registry.ts";
import { ActivityLog, MAX_LIST_LIMIT } from "./activity/log.ts";
import { activityRoutes } from "./activity/routes.ts";
import { EngineSupervisor, type Logger, spawnEngineProcess } from "./engine/supervisor.ts";
import { SubscriptionRegistry } from "./gateway/clients.ts";
import { checkOrigin } from "./gateway/origin.ts";
import { AiLimiter } from "./ai/limits.ts";
import { type AiDeps, type ClientData, Gateway, type GatewaySupervisor, defaultVenueOf } from "./gateway/ws.ts";
import { configuredVenueHealth, createHttpApp } from "./http.ts";
import { NewsCache, createConfiguredNewsProvider } from "./news/cache.ts";
import { configureGuardedFetch } from "./net/http.ts";
import type { Event, Venue } from "./protocol.ts";
import { defaultLimits } from "./risk/limits.ts";
import {
  Router,
  type RouterSender,
  closedOrderSender,
  createOrderIdGenerator,
  marketPrices,
} from "./router.ts";
import { AccountState } from "./state/account.ts";
import { MarketState } from "./state/market.ts";
import { marketRoutes } from "./state/routes.ts";

/** Repository root (server/src → ../..). */
export const REPO_ROOT = resolve(import.meta.dir, "..", "..");

/** Relative engine and fixture paths are resolved against the repository root. */
export function resolveFromRoot(path: string): string {
  return isAbsolute(path) ? path : resolve(REPO_ROOT, path);
}

export const WS_PATH = "/ws";

export interface AppDeps {
  readonly config: Pick<
    Config,
    "allowedOrigins" | "dataMode" | "liveVenue" | "webUrl" | "sessionSecret" | "isProduction" | "killSwitch"
  > &
    Partial<Pick<Config, "aiRatePerMin" | "aiDailyCap">> &
    SecretSource;
  readonly supervisor: GatewaySupervisor;
  /**
   * The engine's order writer, handed to the Router and to nothing else (Req 18.3). `startServer`
   * creates it once from the supervisor. Without one every order is rejected `engine_unavailable`.
   */
  readonly orderSender?: RouterSender;
  /**
   * Activity_Log of the current engine run (oni-terminal-v2 Req 2.1). Defaults to a new one. It
   * gets the Router's order and rejection records and the engine's Fill and OrderRejected events,
   * is cleared on every engine start, and backs `/orders`, `/journal`, `/positions`.
   */
  readonly activity?: ActivityLog;
  readonly registry?: SubscriptionRegistry;
  /** LLM_Provider for `?` orders. Null or unset disables them (Req 23.7). `startServer` builds it from OPENAI_API_KEY. */
  readonly llm?: LlmProviderSource | null;
  /** Provider registry for the Copilot (Task 10.6). Unset: AI requests answer `ai_disabled`. */
  readonly aiRegistry?: AiDeps["registry"];
  /** Defaults to a new MarketState. */
  readonly market?: MarketState;
  /** Defaults to a new AccountState. */
  readonly accounts?: AccountState;
  readonly logger?: Logger;
  /** Epoch milliseconds, shared by every auth store. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/** Called after a logout denylisted a token (Task 19.1: the gateway signs its connections out). */
export type LogoutListener = (jti: string, address: string) => void;

export interface AppAuth {
  /** Subscribes to logouts. Returns a function that removes the listener. */
  onLogout(listener: LogoutListener): () => void;
  /** For the gateway's `Authenticate` handling (Task 19.1). */
  readonly tokens: TokenService;
}

export interface App {
  readonly auth: AppAuth;
  readonly gateway: Gateway;
  /** Last trade, top of book, and candle cache, fed by the gateway from engine events. */
  readonly market: MarketState;
  /** Positions and open orders of every Paper_Account, fed from engine events (Req 14.1). */
  readonly accounts: AccountState;
  /** The only path to the engine for order Commands (Req 18). */
  readonly router: Router;
  /** Orders, fills, and rejections of the current engine run (oni-terminal-v2 Req 2.1). */
  readonly activity: ActivityLog;
  readonly fetch: (req: Request, server: Server<ClientData>) => Response | Promise<Response> | undefined;
  readonly websocket: ReturnType<Gateway["handlers"]>;
}

function jsonResponse(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

export function createApp(deps: AppDeps): App {
  // The gateway feeds the market state from `supervisor.onEvent` and clears it on every engine
  // exit (`supervisor.onClearAccount`). The quote/candles routes and the MCP tools read it later.
  const market = deps.market ?? new MarketState();

  // Per-account positions and open orders: fed from the same engine events, emptied on every
  // engine exit (Req 15.7). The Router (as its AccountView) and the REST routes read it.
  const accounts = deps.accounts ?? new AccountState(deps.logger === undefined ? {} : { logger: deps.logger });
  deps.supervisor.onEvent((event) => accounts.apply(event));
  deps.supervisor.onClearAccount(() => accounts.clear());

  // Auth services (Task 18.6). One clock for all of them, and for the gateway's lazy expiry.
  const now = deps.now ?? Date.now;
  const tokens = new TokenService({ secret: deps.config.sessionSecret, now });
  const gateway = new Gateway({
    supervisor: deps.supervisor,
    config: deps.config,
    market,
    tokens,
    now,
    ...(deps.registry === undefined ? {} : { registry: deps.registry }),
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
  });
  const logoutListeners = new Set<LogoutListener>();
  // TODO(Task 18.6): confirm that Render's proxy appends the client IP to X-Forwarded-For (design
  // "Rate limits"); `clientIp` takes the rightmost entry when `trustProxy` is true.
  const trustProxy = deps.config.isProduction;
  const authRoutes = createAuthRoutes({
    config: deps.config,
    nonces: new NonceStore({ now }),
    tokens,
    pairing: new PairingStore({ now, issueToken: (address) => tokens.issue(address) }),
    limiter: new RateLimiter({ now }),
    now,
    onLogout: (jti, address) => {
      for (const listener of logoutListeners) listener(jti, address);
    },
    getClientIp: (c) => clientIp(c.req.header("x-forwarded-for"), socketAddressFromEnv(c.env), trustProxy),
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    redact: (text) => redactSecrets(text, deps.config),
  });
  const auth: AppAuth = {
    tokens,
    onLogout: (listener) => {
      logoutListeners.add(listener);
      return () => {
        logoutListeners.delete(listener);
      };
    },
  };

  // Req 46.4: a logout moves every connection on that token back to guest.
  auth.onLogout((jti) => gateway.handleLogout(jti));

  // The Router: the only module that writes order Commands (Req 18.1, 18.3). Account ids come
  // from the gateway's verified sessions (Req 18.5).
  const logger = deps.logger ?? { info: console.log, warn: console.warn, error: console.error };

  // Activity_Log (oni-terminal-v2 Req 2.1, 2.2): synchronous in-memory appends. It holds the
  // current engine run only, so it is emptied on every engine start.
  const activity = deps.activity ?? new ActivityLog();
  deps.supervisor.onSessionStart(() => activity.clear());
  // The default venue: the configured live venue, or `replay` (protocol v3). Fill and OrderRejected
  // events carry their own venue; this is the Router's default for orders without one.
  const venue = (): Venue => defaultVenueOf(deps.config);
  deps.supervisor.onEvent((event) => {
    try {
      recordEngineEvent(activity, event, venue(), now());
    } catch (err) {
      logger.error(`[activity] recording ${event.type} failed: ${err instanceof Error ? err.name : "unknown"}`);
    }
  });

  const router = new Router({
    sender: deps.orderSender ?? closedOrderSender,
    engineRunning: () => deps.supervisor.running,
    risk: { limits: defaultLimits(), killSwitch: deps.config.killSwitch },
    market: marketPrices(market),
    health: market,
    accounts,
    activity,
    venue,
    now,
    newOrderId: createOrderIdGenerator(),
    pendingRequests: gateway.pendingRequests,
    onSessionExpired: (connectionId) => gateway.downgradeExpired(connectionId),
    onRejected: (connectionId, event) => {
      gateway.sendTo(connectionId, { type: "event", event });
    },
    logger,
    onTwapStatus: (status) => gateway.publishTwapStatus(status),
  });
  gateway.setRouter(router);
  gateway.setTwap(router);
  gateway.onConnectionClosed((connectionId) => router.forgetConnection(connectionId));
  gateway.onAccountChange((connectionId) => router.twapSessionChanged(connectionId));
  deps.supervisor.onSessionStart(() => router.twapEngineRestarted());

  // Command bar (Task 12.1, Req 21, 22.4, 46.4): pending previews are bound to a connection and
  // its account, and are dropped on an account switch and on close.
  const previews = new PreviewStore({ now });
  // Plain-English orders (Task 13.2, Req 23): disabled without a provider (Req 23.7). The parser
  // yields commands only; they become previews and need Confirm like typed ones (Req 23.6).
  const prices = marketPrices(market);
  const llm = new LlmOrderParser({
    registry: deps.llm ?? null,
    positionLots: (accountId, symbol) => accounts.positionLots(accountId, symbol),
    lastPrice: (symbol) => prices.lastPrice(symbol, venue()),
  });
  gateway.setCommandBar({ previews, accounts, router, llm });
  if (deps.aiRegistry !== undefined) {
    gateway.setAi({ registry: deps.aiRegistry, limiter: new AiLimiter({
        now,
        ...(deps.config.aiRatePerMin === undefined ? {} : { ratePerMin: deps.config.aiRatePerMin }),
        ...(deps.config.aiDailyCap === undefined ? {} : { dailyCap: deps.config.aiDailyCap }),
      }), accounts });
  }
  gateway.onAccountChange((connectionId) => {
    previews.discardForConnection(connectionId);
  });
  gateway.onConnectionClosed((connectionId) => {
    previews.discardForConnection(connectionId);
  });

  const http = createHttpApp({
    engine: deps.supervisor,
    auth: authRoutes,
    allowedOrigins: deps.config.allowedOrigins,
    // Req 1.9: one entry for the configured venue (or replay) until VenueStatus events (Task 9).
    venues: () => [configuredVenueHealth(deps.config, deps.supervisor)],
    activity: activityRoutes({ log: activity, positions: accounts, auth: tokens }),
    market: marketRoutes({ market, venue }),
  });

  const fetch = (req: Request, server: Server<ClientData>): Response | Promise<Response> | undefined => {
    const url = new URL(req.url);
    if (url.pathname !== WS_PATH) return http.fetch(req, { socketAddress: server.requestIP(req)?.address });
    // Req 17.2, trading-safety rule 8. A missing Origin is allowed (design §3 Gateway).
    if (checkOrigin(req.headers.get("origin"), deps.config.allowedOrigins) === "deny") {
      return jsonResponse({ error: "origin_not_allowed" }, 403);
    }
    if (server.upgrade(req, { data: {} })) return undefined; // Bun answers the upgrade itself
    return jsonResponse({ error: "websocket_upgrade_required" }, 426);
  };

  return { auth, gateway, market, accounts, router, activity, fetch, websocket: gateway.handlers() };
}

/**
 * Appends the Activity_Log record of an engine event (oni-terminal-v2 Req 2.2): a fill record for
 * a Fill, and a rejection record for an engine OrderRejected. The rejection keeps the source and
 * order fields of the Router's order record for that order id, when the log still has one (an
 * engine rejection of a Cancel for an unknown id has none). Other events are ignored.
 */
export function recordEngineEvent(log: ActivityLog, event: Event, _defaultVenue: string, now: number): void {
  // Protocol v3: Fill and OrderRejected carry their venue, so the default is no longer needed.
  if (event.type === "fill") {
    log.append({
      kind: "fill",
      venue: event.venue,
      accountId: event.account_id,
      orderId: event.order_id,
      symbol: event.symbol,
      side: event.side,
      price: BigInt(event.price),
      qty: BigInt(event.qty),
      fee: BigInt(event.fee),
      remaining: BigInt(event.remaining),
      ts: event.ts,
    });
  } else if (event.type === "order_rejected") {
    const order = log.listOrders(event.account_id, MAX_LIST_LIMIT).find((r) => r.orderId === event.order_id);
    log.append({
      kind: "rejection",
      venue: event.venue,
      accountId: event.account_id,
      orderId: event.order_id,
      reason: event.reason,
      symbol: order?.symbol ?? null,
      side: order?.side ?? null,
      qty: order?.qty ?? null,
      orderKind: order?.orderKind ?? null,
      price: order?.price ?? null,
      source: order?.source ?? null,
      ts: now,
    });
  }
}

export interface StartServerOptions {
  readonly config: Config;
  /** Overrides `config.port`. Use 0 for a free port in tests. */
  readonly port?: number;
  /** Defaults to Bun's default (all interfaces). Tests pass "127.0.0.1". */
  readonly hostname?: string;
  /** Defaults to a real EngineSupervisor for `config`. */
  readonly supervisor?: GatewaySupervisor & {
    start(): void;
    stop(): Promise<void>;
    /** Test supervisors may omit it; their orders are then rejected `engine_unavailable`. */
    createOrderSender?(): RouterSender;
  };
  /** Replay fixture directory for the default supervisor. Defaults to `<repo>/fixtures`. */
  readonly fixturesDir?: string;
  readonly logger?: Logger;
  /** Activity_Log. Defaults to a new, empty one. */
  readonly activity?: ActivityLog;
}

export interface RunningServer {
  readonly auth: AppAuth;
  readonly server: Server<ClientData>;
  readonly gateway: Gateway;
  readonly market: MarketState;
  readonly accounts: AccountState;
  readonly router: Router;
  /** Orders, fills, and rejections of the current engine run. */
  readonly activity: ActivityLog;
  readonly supervisor: GatewaySupervisor & { start(): void; stop(): Promise<void> };
  /** The bound port (useful with port 0). */
  readonly port: number;
  /** Stops the supervisor (and the engine), then the HTTP server. Safe to call twice. */
  stop(): Promise<void>;
}

export function startServer(options: StartServerOptions): RunningServer {
  const { config } = options;
  const supervisor =
    options.supervisor ??
    new EngineSupervisor({
      config,
      fixturesDir: resolveFromRoot(options.fixturesDir ?? "fixtures"),
      // ENGINE_PATH defaults to a repo-relative path; resolve it so the cwd does not matter.
      spawn: (request) => spawnEngineProcess({ ...request, enginePath: resolveFromRoot(request.enginePath) }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });

  // The order writer is created once and goes straight to the Router (Req 18.3).
  const orderSender = supervisor.createOrderSender?.() ?? closedOrderSender;

  // Req 23.7: no available provider, no plain-English orders.
  const llm = buildRegistry(config);

  // Every outbound HTTP request goes through the allowlisted wrapper (trading-safety rule 1).
  configureGuardedFetch(config, options.logger ?? console);

  // News (Task 11.4): provider chosen by config (production gating included); none disables it.
  const news = new NewsCache({
    provider: createConfiguredNewsProvider(config),
    ttlSeconds: config.newsTtlSeconds,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  const app = createApp({
    config,
    supervisor,
    llm,
    aiRegistry: llm,
    orderSender,
    ...(options.activity === undefined ? {} : { activity: options.activity }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  const server = Bun.serve({
    port: options.port ?? config.port,
    ...(options.hostname === undefined ? {} : { hostname: options.hostname }),
    fetch: app.fetch,
    websocket: app.websocket,
  });
  app.gateway.setPublisher(server);
  app.gateway.setNews(news);
  news.start();
  supervisor.start();

  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      news.stop();
      await supervisor.stop();
      app.gateway.dispose();
      await server.stop(true);
    })();
    return stopping;
  };

  return {
    auth: app.auth,
    server,
    gateway: app.gateway,
    market: app.market,
    accounts: app.accounts,
    router: app.router,
    activity: app.activity,
    supervisor,
    port: server.port ?? 0,
    stop,
  };
}

if (import.meta.main) {
  const config = loadConfigOrExit();
  const running = startServer({ config });
  const mode =
    config.dataMode === "replay" ? `replay mode, ${config.replayFixture} at ${config.replaySpeed}x` : "live mode";
  console.log(`[server] listening on port ${running.port} (${mode})`);

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] ${signal} received, shutting down`);
    running.stop().then(
      () => process.exit(0),
      (err: unknown) => {
        console.error(`[server] shutdown failed: ${err instanceof Error ? err.name : "unknown error"}`);
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
