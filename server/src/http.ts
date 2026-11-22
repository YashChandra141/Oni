// Hono app for the plain HTTP endpoints (design §3, oni-terminal-v2 Req 1.9).
//
// `/health` reads memory only and never touches a database (there is none). It reports the
// Engine state, the status of the configured venue (or `replay`), and the Latency_Histogram
// p50/p95, which stay null until Task 13.2 wires the histogram. It has no `db` field (Req 1.9).
// The activity routes (/orders, /journal, /positions) are mounted from `activityRoutes`.

import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ActivityEnv } from "./activity/routes.ts";
import { checkOrigin, normalizeOrigin } from "./gateway/origin.ts";
import { latencySummary } from "./latency/histogram.ts";
import type { HealthLatency } from "./protocol.ts";

/** What `/health` reads. The EngineSupervisor satisfies it. */
export interface EngineHealth {
  readonly running: boolean;
  readonly sessionId: string | null;
}

/** The Venue_Status values of the design (Req 9). */
export type VenueStatusKind = "connecting" | "connected" | "stale" | "down" | "disabled";

export interface VenueHealth {
  readonly venue: string;
  readonly status: VenueStatusKind;
}

/** Latency_Histogram summary per stage (Req 33.12): count, p50 and p95 in microseconds. */
export type LatencyHealth = HealthLatency;

/** Paths the REST routes use; CORS applies to them as to `/auth/*`. */
const CORS_PATHS = ["/auth/*", "/orders", "/positions", "/journal", "/quote/*", "/candles/*"] as const;

export interface HttpDeps {
  readonly engine: EngineHealth;
  /** Auth routes from `createAuthRoutes` (Task 18.6). Omitted in tests that do not need them. */
  readonly auth?: Hono;
  /** Venue statuses for `/health`, read from memory. Defaults to none. */
  readonly venues?: () => readonly VenueHealth[];
  /** Latency summary for `/health`. Defaults to nulls (Task 13.2 fills it in). */
  readonly latency?: () => LatencyHealth;
  /** `/orders`, `/journal`, `/positions` from `activityRoutes`. */
  readonly activity?: Hono<ActivityEnv>;
  /** `/quote/:symbol`, `/candles/:symbol` from `marketRoutes`. */
  readonly market?: Hono;
  /**
   * ALLOWED_ORIGINS. When given, CORS is enabled for those origins only (no credentials, so
   * Authorization travels as a header, never as a cookie).
   */
  readonly allowedOrigins?: readonly string[];
}

export interface HealthBody {
  readonly ok: true;
  /** Wording from the design.md endpoint table. */
  readonly engine: "running" | "stopped";
  /** Session_Id of the latest engine start, or null before the first start. */
  readonly session_id: string | null;
  /** One entry for the configured venue, or `replay` (Req 1.9). */
  readonly venues: readonly VenueHealth[];
  readonly latency: LatencyHealth;
}

export const NO_LATENCY: LatencyHealth = latencySummary();

export function healthBody(
  engine: EngineHealth,
  venues: () => readonly VenueHealth[] = () => [],
  latency: () => LatencyHealth = latencySummary,
): HealthBody {
  return {
    ok: true,
    engine: engine.running ? "running" : "stopped",
    session_id: engine.sessionId,
    venues: venues(),
    latency: latency(),
  };
}

/**
 * The status of the one configured venue, until the engine emits VenueStatus events (Task 9):
 * `down` while the engine is stopped; `connected` for replay (the fixture is local); `connecting`
 * for a live venue, whose real state the server does not know yet.
 */
export function configuredVenueHealth(
  config: { readonly dataMode: "replay" | "live"; readonly liveVenue: string },
  engine: EngineHealth,
): VenueHealth {
  const venue = config.dataMode === "replay" ? "replay" : config.liveVenue;
  if (!engine.running) return { venue, status: "down" };
  return { venue, status: config.dataMode === "replay" ? "connected" : "connecting" };
}

export function createHttpApp(deps: HttpDeps): Hono {
  const app = new Hono();

  const allowedOrigins = deps.allowedOrigins;
  if (allowedOrigins !== undefined) {
    const corsMiddleware = cors({
      // Echo the origin only when it is allowed; otherwise no Access-Control-Allow-Origin header.
      origin: (origin) => (checkOrigin(origin, allowedOrigins) === "allow" ? normalizeOrigin(origin) : null),
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
      credentials: false,
      maxAge: 600,
    });
    for (const path of CORS_PATHS) app.use(path, corsMiddleware);
  }

  if (deps.auth !== undefined) app.route("/", deps.auth);
  if (deps.activity !== undefined) app.route("/", deps.activity);
  if (deps.market !== undefined) app.route("/", deps.market);

  // Req 1.9: always 200 while the process is serving; reads memory only.
  app.get("/health", (c) => c.json(healthBody(deps.engine, deps.venues, deps.latency), 200));

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  // Never echo the error: it could quote configuration or input (Req 16.4).
  app.onError((err, c) => {
    console.error(`[http] unhandled error: ${err instanceof Error ? err.name : "unknown"}`);
    return c.json({ error: "internal" }, 500);
  });

  return app;
}
