// GET /quote/:symbol and GET /candles/:symbol?timeframe=&limit= (Req 24.2, 24.3), read from the
// shared MarketState (memory only). These lived in the journal routes before oni-terminal-v2;
// the MCP client (mcp/client.ts) validates their JSON with QuoteResponseSchema and
// CandlesResponseSchema. Market data is shared by every account, so no auth is needed.

import { Hono } from "hono";
import { z } from "zod";
import { instrumentBySymbol } from "../instruments.ts";
import { TimeframeSchema, type Venue } from "../protocol.ts";
import { DEFAULT_MARKET_VENUE, MAX_SNAPSHOT_BARS, type MarketState } from "./market.ts";

export interface MarketRoutesDeps {
  readonly market: Pick<MarketState, "quote" | "candles">;
  /** Venue the routes read (protocol v3 keys market data by venue). Defaults to `replay`. */
  readonly venue?: () => Venue;
}

const CandlesQuerySchema = z.object({
  timeframe: TimeframeSchema,
  limit: z
    .string()
    .regex(/^[0-9]{1,3}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(MAX_SNAPSHOT_BARS))
    .optional(),
});

export function marketRoutes(deps: MarketRoutesDeps): Hono {
  const app = new Hono();
  const venue = deps.venue ?? (() => DEFAULT_MARKET_VENUE);

  app.get("/quote/:symbol", (c) => {
    const symbol = c.req.param("symbol");
    if (instrumentBySymbol(symbol) === undefined) return c.json({ error: "unknown_symbol" }, 404);
    return c.json(deps.market.quote(symbol, venue()) ?? { symbol, last: null, book: null });
  });

  app.get("/candles/:symbol", (c) => {
    const symbol = c.req.param("symbol");
    if (instrumentBySymbol(symbol) === undefined) return c.json({ error: "unknown_symbol" }, 404);
    const parsed = CandlesQuerySchema.safeParse({ timeframe: c.req.query("timeframe"), limit: c.req.query("limit") });
    if (!parsed.success) return c.json({ error: "invalid_query" }, 400);
    const { timeframe, limit } = parsed.data;
    const bars = deps.market.candles(symbol, timeframe, limit ?? MAX_SNAPSHOT_BARS, venue()) ?? [];
    return c.json({ symbol, timeframe, bars });
  });

  return app;
}
