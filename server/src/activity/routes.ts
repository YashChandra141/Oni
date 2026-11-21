// GET /orders, /journal, /positions scoped to the caller's account (oni-terminal-v2 Req 2.11 to
// 2.15, 2.19). The account comes from `Authorization: Bearer` (401 for a bad, expired, or
// denylisted token) and is `guest` without a header. `limit` is an integer 1..1000 (400
// otherwise). `session=all` is accepted for old clients; any other value is 400.

import { type Context, Hono } from "hono";
import { z } from "zod";
import { resolveBearer, type TokenVerifier } from "../auth/bearer.ts";
import type { AccountId } from "../protocol.ts";
import type { AccountView } from "../state/account.ts";
import {
  ActivityLog,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  type ActivityRecord,
} from "./log.ts";

export interface ActivityRoutesDeps {
  readonly log: ActivityLog;
  readonly positions: Pick<AccountView, "positions">;
  readonly auth: TokenVerifier;
}

const LimitSchema = z
  .string()
  .regex(/^[0-9]{1,4}$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(MAX_LIST_LIMIT));

const QuerySchema = z.object({
  limit: LimitSchema.optional(),
  session: z.literal("all").optional(),
});

/** Listing JSON: `type`, decimal strings for Price/Qty/Money, `seq` as a string. */
export function toJson(r: ActivityRecord): Record<string, unknown> {
  const big = (v: bigint | null): string | null => (v === null ? null : v.toString());
  const base = { type: r.kind, seq: String(r.seq), account_id: r.accountId, order_id: r.orderId, ts: r.ts };
  switch (r.kind) {
    case "order":
      return {
        ...base,
        venue: r.venue,
        symbol: r.symbol,
        side: r.side,
        qty: r.qty.toString(),
        order_kind: r.orderKind,
        price: big(r.price),
        source: r.source,
      };
    case "fill":
      return {
        ...base,
        venue: r.venue,
        symbol: r.symbol,
        side: r.side,
        price: r.price.toString(),
        qty: r.qty.toString(),
        fee: r.fee.toString(),
        remaining: r.remaining.toString(),
      };
    case "rejection":
      return {
        ...base,
        venue: r.venue ?? null,
        symbol: r.symbol,
        side: r.side,
        qty: big(r.qty),
        order_kind: r.orderKind,
        price: big(r.price),
        source: r.source,
        reason: r.reason,
      };
  }
}

export type ActivityEnv = { Variables: { accountId: AccountId } };
type Env = ActivityEnv;

export function activityRoutes(deps: ActivityRoutesDeps): Hono<Env> {
  const app = new Hono<Env>();

  // Only on these paths: the app is mounted at "/", and a "*" middleware would also run for
  // /health, /auth/*, and /quote.
  for (const path of ["/orders", "/journal", "/positions"] as const) {
    app.use(path, async (c, next) => {
      const result = await resolveBearer(c.req.header("authorization"), deps.auth);
      if (!result.ok) {
        c.header("Cache-Control", "no-store");
        return c.json({ error: "unauthorized" }, 401);
      }
      c.set("accountId", result.accountId);
      await next();
      return undefined;
    });
  }

  const listing = (kind: "orders" | "journal") => (c: Context<Env>) => {
    const parsed = QuerySchema.safeParse({
      limit: c.req.query("limit"),
      session: c.req.query("session"),
    });
    if (!parsed.success) return c.json({ error: "invalid_query" }, 400);
    const account = c.get("accountId");
    const limit = parsed.data.limit ?? DEFAULT_LIST_LIMIT;
    const rows = kind === "orders" ? deps.log.listOrders(account, limit) : deps.log.listActivity(account, limit);
    return c.json(rows.map(toJson));
  };

  app.get("/orders", listing("orders"));
  app.get("/journal", listing("journal"));

  app.get("/positions", (c) => {
    const account = c.get("accountId");
    return c.json(
      deps.positions.positions(account).map((p) => ({
        symbol: p.symbol,
        qty: p.qty.toString(),
        avg_entry: p.avgEntry === null ? null : p.avgEntry.toString(),
        realized: p.realized.toString(),
        unrealized: p.unrealized.toString(),
      })),
    );
  });

  return app;
}
