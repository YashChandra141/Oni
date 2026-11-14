// REST routes that read state (design endpoint table; Req 17.5, 20.5-20.7, 20.13, 20.14,
// 20.19-20.21, 20.24-20.26, 20.28-20.30): /orders, /journal, /positions, /quote/:symbol,
// /candles/:symbol.
//
// Order of checks for /orders, /journal, /positions: caller account from the bearer token (a bad
// token is 401 before anything else), then query parameters (400, even while the Journal is
// down), then the Journal_Status (503 journal_unavailable), then the query with a 5 s limit.
// BigInt fields are returned as decimal strings.

import { type Context, Hono } from "hono";
import { z } from "zod";
import { type AuthVariables, type TokenVerifier, bearerMiddleware } from "../auth/bearer.ts";
import { instrumentBySymbol } from "../instruments.ts";
import { type Timeframe, TimeframeSchema } from "../protocol.ts";
import type { AccountState } from "../state/account.ts";
import { MAX_SNAPSHOT_BARS, type MarketState } from "../state/market.ts";
import { rowToJson } from "./map.ts";
import { JOURNAL_DEFAULT_LIMIT, JOURNAL_MAX_LIMIT, type JournalStore } from "./store.ts";

export const QUERY_TIMEOUT_MS = 5_000;

export interface JournalRoutesDeps {
  readonly tokens: TokenVerifier;
  readonly store: Pick<JournalStore, "listOrders" | "listJournal">;
  /** Journal_Status from memory. */
  readonly status: () => "up" | "down";
  /** Called when a query fails or times out: sets the status to down (Req 20.14). */
  readonly markUnreachable: () => void;
  /** Session_Id of the current engine run (Req 20.19). */
  readonly sessionId: () => string | null;
  readonly accounts: Pick<AccountState, "positions">;
  readonly market: Pick<MarketState, "quote" | "candles">;
  readonly queryTimeoutMs?: number;
}

const SessionParam = z.enum(["all"]).optional();
const LimitParam = z
  .string()
  .regex(/^[0-9]{1,5}$/, "limit must be an integer from 1 to 5000")
  .transform(Number)
  .refine((n) => n >= 1 && n <= JOURNAL_MAX_LIMIT, "limit must be an integer from 1 to 5000")
  .optional();

export const JournalQuerySchema = z.object({ session: SessionParam, limit: LimitParam });

export type ParsedJournalQuery =
  | { readonly ok: true; readonly session: "all" | undefined; readonly limit: number }
  | { readonly ok: false; readonly message: string };

/** Validates the `session` and `limit` query parameters (Req 20.19-20.21, 20.24-20.26). Pure. */
export function parseJournalQuery(query: { session?: string | undefined; limit?: string | undefined }): ParsedJournalQuery {
  const parsed = JournalQuerySchema.safeParse({ session: query.session, limit: query.limit });
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "invalid query" };
  return { ok: true, session: parsed.data.session, limit: parsed.data.limit ?? JOURNAL_DEFAULT_LIMIT };
}

class QueryTimeout extends Error {
  constructor() {
    super("journal query timed out");
    this.name = "QueryTimeout";
  }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new QueryTimeout()), ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export function createJournalRoutes(deps: JournalRoutesDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const auth = bearerMiddleware(deps.tokens);
  const timeoutMs = deps.queryTimeoutMs ?? QUERY_TIMEOUT_MS;

  const listRoute = (kind: "orders" | "journal") => async (c: Context<{ Variables: AuthVariables }>) => {
    const parsed = parseJournalQuery({ session: c.req.query("session"), limit: c.req.query("limit") });
    if (!parsed.ok) return c.json({ error: "invalid_query", message: parsed.message }, 400);
    if (deps.status() === "down") return c.json({ error: "journal_unavailable" }, 503);
    const sessionId = parsed.session === "all" ? "all" : deps.sessionId();
    // No engine run yet: nothing can be journaled under a session, so the current-session list is empty.
    if (sessionId === null) return c.json([], 200);
    const q = { account: c.get("account").accountId, session: sessionId, limit: parsed.limit };
    try {
      const rows = await withTimeout(kind === "orders" ? deps.store.listOrders(q) : deps.store.listJournal(q), timeoutMs);
      return c.json(rows.map((row) => rowToJson(row)), 200);
    } catch {
      deps.markUnreachable();
      return c.json({ error: "journal_unavailable" }, 503);
    }
  };

  app.get("/orders", auth, listRoute("orders"));
  app.get("/journal", auth, listRoute("journal"));

  app.get("/positions", auth, (c) => {
    const accountId = c.get("account").accountId;
    const rows = deps.accounts.positions(accountId).map((p) => ({
      symbol: p.symbol,
      qty: p.qty.toString(),
      avg_entry: p.avgEntry === null ? null : p.avgEntry.toString(),
      realized: p.realized.toString(),
      unrealized: p.unrealized.toString(),
    }));
    return c.json(rows, 200);
  });

  app.get("/quote/:symbol", (c) => {
    const symbol = c.req.param("symbol");
    if (instrumentBySymbol(symbol) === undefined) return c.json({ error: "unknown_symbol" }, 404);
    const quote = deps.market.quote(symbol);
    if (quote === null) return c.json({ error: "no_data" }, 404);
    return c.json(quote, 200);
  });

  const CandlesQuery = z.object({
    timeframe: TimeframeSchema.default("1m"),
    limit: z
      .string()
      .regex(/^[0-9]{1,3}$/, `limit must be an integer from 1 to ${MAX_SNAPSHOT_BARS}`)
      .transform(Number)
      .refine((n) => n >= 1 && n <= MAX_SNAPSHOT_BARS, `limit must be an integer from 1 to ${MAX_SNAPSHOT_BARS}`)
      .optional(),
  });

  app.get("/candles/:symbol", (c) => {
    const symbol = c.req.param("symbol");
    if (instrumentBySymbol(symbol) === undefined) return c.json({ error: "unknown_symbol" }, 404);
    const parsed = CandlesQuery.safeParse({ timeframe: c.req.query("timeframe"), limit: c.req.query("limit") });
    if (!parsed.success) return c.json({ error: "invalid_query", message: parsed.error.issues[0]?.message ?? "invalid query" }, 400);
    const timeframe: Timeframe = parsed.data.timeframe;
    const bars = deps.market.candles(symbol, timeframe, parsed.data.limit ?? MAX_SNAPSHOT_BARS);
    if (bars === null) return c.json({ error: "no_data" }, 404);
    return c.json({ symbol, timeframe, bars }, 200);
  });

  return app;
}
