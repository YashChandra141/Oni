// Hono app for the plain HTTP endpoints (design §3, Req 17.5, 17.8).
//
// Task 3.5 has only `GET /health`. /orders, /positions, /journal, /quote/:symbol, and
// /candles/:symbol arrive with Tasks 11 and 14.
//
// `/health` never queries a database (Req 17.8, design §3 Journal): Render polls it, and a
// query there would keep Neon's compute awake. The `db` field is the placeholder "unknown"
// until the Journal exists (Task 11). Task 11 replaces it with the in-memory Journal_Status
// ("up" | "down"), read from `JournalQueue.status()`.

import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AuthVariables } from "./auth/bearer.ts";
import { checkOrigin, normalizeOrigin } from "./gateway/origin.ts";

/** What `/health` reads. The EngineSupervisor satisfies it. */
export interface EngineHealth {
  readonly running: boolean;
  readonly sessionId: string | null;
}

/** Paths the REST routes use (Task 11.4, 14); CORS applies to them as to `/auth/*`. */
const CORS_PATHS = ["/auth/*", "/orders", "/positions", "/journal", "/quote/*", "/candles/*"] as const;

export interface HttpDeps {
  readonly engine: EngineHealth;
  /** Auth routes from `createAuthRoutes` (Task 18.6). Omitted in tests that do not need them. */
  readonly auth?: Hono;
  /** Journal_Status reader for `/health`: memory only, never a query (Req 17.8). */
  readonly journalStatus?: () => "up" | "down";
  /** `/orders`, `/journal`, `/positions`, `/quote`, `/candles` from `createJournalRoutes` (Task 11.4). */
  readonly state?: Hono<{ Variables: AuthVariables }>;
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
  /** Journal_Status from memory (Req 17.5); "unknown" only when no journal is wired (tests). */
  readonly db: "up" | "down" | "unknown";
  /** Session_Id of the latest engine start (Req 20.18), or null before the first start. */
  readonly session_id: string | null;
}

export function healthBody(engine: EngineHealth, db: () => "up" | "down" | "unknown" = () => "unknown"): HealthBody {
  return {
    ok: true,
    engine: engine.running ? "running" : "stopped",
    db: db(),
    session_id: engine.sessionId,
  };
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
  if (deps.state !== undefined) app.route("/", deps.state);

  // Req 17.5: always 200 while the process is serving; reads memory only (Req 17.8).
  app.get("/health", (c) => c.json(healthBody(deps.engine, deps.journalStatus), 200));

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  // Never echo the error: it could quote configuration or input (Req 16.4).
  app.onError((err, c) => {
    console.error(`[http] unhandled error: ${err instanceof Error ? err.name : "unknown"}`);
    return c.json({ error: "internal" }, 500);
  });

  return app;
}
