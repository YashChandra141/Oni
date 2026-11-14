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
import { createOpenAiProvider } from "./llm/openai.ts";
import { LlmOrderParser } from "./llm/parser.ts";
import type { LlmProvider } from "./llm/provider.ts";
import { classifyPrismaError } from "./journal/classify.ts";
import { createLazyPrismaStore } from "./journal/lazy.ts";
import { fromFillEvent, fromRejectedEvent, fromRouterRecord } from "./journal/map.ts";
import { MemoryJournalStore } from "./journal/memory.ts";
import { JournalQueue } from "./journal/queue.ts";
import { createJournalRoutes } from "./journal/routes.ts";
import type { JournalStore } from "./journal/store.ts";
import { EngineSupervisor, type Logger, spawnEngineProcess } from "./engine/supervisor.ts";
import { SubscriptionRegistry } from "./gateway/clients.ts";
import { checkOrigin } from "./gateway/origin.ts";
import { type ClientData, Gateway, type GatewaySupervisor } from "./gateway/ws.ts";
import { createHttpApp } from "./http.ts";
import { defaultLimits } from "./risk/limits.ts";
import {
  Router,
  type RouterJournal,
  type RouterSender,
  closedOrderSender,
  createOrderIdGenerator,
  marketPrices,
} from "./router.ts";
import { AccountState } from "./state/account.ts";
import { MarketState } from "./state/market.ts";

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
    SecretSource;
  readonly supervisor: GatewaySupervisor;
  /**
   * The engine's order writer, handed to the Router and to nothing else (Req 18.3). `startServer`
   * creates it once from the supervisor. Without one every order is rejected `engine_unavailable`.
   */
  readonly orderSender?: RouterSender;
  /** Receives the Router's order and rejection records. Overrides `journalQueue` for the Router (tests). */
  readonly journal?: RouterJournal;
  /**
   * The Journal_Queue (Task 11.4). When given with `journalStore`, the Router's records and the
   * engine's Fill and OrderRejected events are enqueued, `/health` reports its status, and
   * `/orders`, `/journal`, `/positions`, `/quote`, `/candles` are served.
   */
  readonly journalQueue?: JournalQueue;
  readonly journalStore?: Pick<JournalStore, "listOrders" | "listJournal">;
  readonly registry?: SubscriptionRegistry;
  /** LLM_Provider for `?` orders. Null or unset disables them (Req 23.7). `startServer` builds it from OPENAI_API_KEY. */
  readonly llm?: LlmProvider | null;
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
  // from the gateway's verified sessions (Req 18.5). The journal is a no-op until Task 11.4.
  const logger = deps.logger ?? { info: console.log, warn: console.warn, error: console.error };
  // Journal (Task 11.4): every enqueue is a synchronous in-memory push, never a database wait
  // (Req 20.8). Records carry the Session_Id of the engine run at enqueue time (Req 20.18).
  const queue = deps.journalQueue;
  const newId = (): string => crypto.randomUUID();
  const routerJournal: RouterJournal =
    deps.journal ??
    (queue === undefined
      ? { enqueue: () => {} }
      : {
          enqueue: (record) =>
            queue.enqueue(fromRouterRecord(record, { sessionId: deps.supervisor.sessionId, now: record.ts, newId })),
        });
  if (queue !== undefined) {
    deps.supervisor.onEvent((event) => {
      try {
        const ctx = { sessionId: deps.supervisor.sessionId, now: now(), newId };
        if (event.type === "fill") queue.enqueue(fromFillEvent(event, ctx));
        else if (event.type === "order_rejected") queue.enqueue(fromRejectedEvent(event, ctx));
      } catch (err) {
        logger.error(`[journal] mapping ${event.type} failed: ${err instanceof Error ? err.name : "unknown"}`);
      }
    });
  }

  const router = new Router({
    sender: deps.orderSender ?? closedOrderSender,
    engineRunning: () => deps.supervisor.running,
    risk: { limits: defaultLimits(), killSwitch: deps.config.killSwitch },
    market: marketPrices(market),
    accounts,
    journal: routerJournal,
    now,
    newOrderId: createOrderIdGenerator(),
    pendingRequests: gateway.pendingRequests,
    onSessionExpired: (connectionId) => gateway.downgradeExpired(connectionId),
    onRejected: (connectionId, event) => {
      gateway.sendTo(connectionId, { type: "event", event });
    },
    logger,
  });
  gateway.setRouter(router);
  gateway.onConnectionClosed((connectionId) => router.forgetConnection(connectionId));

  // Command bar (Task 12.1, Req 21, 22.4, 46.4): pending previews are bound to a connection and
  // its account, and are dropped on an account switch and on close.
  const previews = new PreviewStore({ now });
  // Plain-English orders (Task 13.2, Req 23): disabled without a provider (Req 23.7). The parser
  // yields commands only; they become previews and need Confirm like typed ones (Req 23.6).
  const prices = marketPrices(market);
  const llm = new LlmOrderParser({
    provider: deps.llm ?? null,
    positionLots: (accountId, symbol) => accounts.positionLots(accountId, symbol),
    lastPrice: (symbol) => prices.lastPrice(symbol),
  });
  gateway.setCommandBar({ previews, accounts, router, llm });
  gateway.onAccountChange((connectionId) => {
    previews.discardForConnection(connectionId);
  });
  gateway.onConnectionClosed((connectionId) => {
    previews.discardForConnection(connectionId);
  });

  const stateRoutes =
    queue === undefined || deps.journalStore === undefined
      ? undefined
      : createJournalRoutes({
          tokens,
          store: deps.journalStore,
          status: () => queue.status(),
          markUnreachable: () => queue.markUnreachable(),
          sessionId: () => deps.supervisor.sessionId,
          accounts,
          market,
        });

  const http = createHttpApp({
    engine: deps.supervisor,
    auth: authRoutes,
    allowedOrigins: deps.config.allowedOrigins,
    ...(queue === undefined ? {} : { journalStatus: () => queue.status() }),
    ...(stateRoutes === undefined ? {} : { state: stateRoutes }),
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

  return { auth, gateway, market, accounts, router, fetch, websocket: gateway.handlers() };
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
  /**
   * Journal store. Defaults to MemoryJournalStore when DATABASE_URL is unset (Req 16.6) and to the
   * Prisma store (loaded lazily) otherwise.
   */
  readonly journalStore?: JournalStore;
  /**
   * Whether the Journal schema is ready. Defaults to true when there is no DATABASE_URL and to
   * false otherwise; the Start_Script calls `journal.setMigrated(...)` after `prisma migrate deploy`.
   */
  readonly journalMigrated?: boolean;
}

export interface RunningServer {
  readonly auth: AppAuth;
  readonly server: Server<ClientData>;
  readonly gateway: Gateway;
  readonly market: MarketState;
  readonly accounts: AccountState;
  readonly router: Router;
  /** The Journal_Queue; the Start_Script calls `setMigrated` on it. */
  readonly journal: JournalQueue;
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

  const log = options.logger ?? { info: console.log, warn: console.warn, error: console.error };
  const redact = (text: string): string => redactSecrets(text, config);
  const databaseUrl = config.databaseUrl;
  const store: JournalStore =
    options.journalStore ??
    (databaseUrl === undefined ? new MemoryJournalStore() : createLazyPrismaStore(config, log, redact));
  const journal = new JournalQueue({
    store,
    classify: classifyPrismaError,
    logger: log,
    redact,
    migrated: options.journalMigrated ?? databaseUrl === undefined,
  });

  // Req 23.7: no OPENAI_API_KEY, no provider, no plain-English orders.
  const openaiApiKey = config.openaiApiKey;
  const llm =
    openaiApiKey === undefined
      ? null
      : createOpenAiProvider({
          apiKey: openaiApiKey,
          model: config.openaiModel,
          fetch: (input, init) => globalThis.fetch(input, init),
        });

  const app = createApp({
    config,
    supervisor,
    llm,
    orderSender,
    journalQueue: journal,
    journalStore: store,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  const server = Bun.serve({
    port: options.port ?? config.port,
    ...(options.hostname === undefined ? {} : { hostname: options.hostname }),
    fetch: app.fetch,
    websocket: app.websocket,
  });
  app.gateway.setPublisher(server);
  supervisor.start();

  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      await supervisor.stop();
      app.gateway.dispose();
      await server.stop(true);
      // SIGTERM path: write what is queued, give up after 5 s (design Decision J4).
      await journal.flush(5_000);
      await store.close().catch(() => {});
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
    journal,
    supervisor,
    port: server.port ?? 0,
    stop,
  };
}

if (import.meta.main) {
  const config = loadConfigOrExit();
  const running = startServer({ config });
  if (config.databaseUrl !== undefined) {
    // Migrations are applied by server/scripts/start.ts; started directly, the writer holds records.
    console.warn("[server] DATABASE_URL is set but Migrations were not applied: run server/scripts/start.ts");
  }
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
