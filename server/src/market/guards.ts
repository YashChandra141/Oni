// Market guards (design "Risk order", Property 23; Req 14.6 to 14.8, 15.9).
//
// Pure. Order of checks: venue_unavailable, then stale_market_data, then price_deviation.
// The Router runs these before the Risk_Engine; none consumes the rate window.

export type VenueStatus = "up" | "down" | "disabled";
export type PairHealth = "ok" | "stale" | "suspect";

export type GuardReason = "venue_unavailable" | "stale_market_data" | "price_deviation";

export interface PairInfo {
  readonly health: PairHealth;
  /** Epoch ms of the pair's last price, or null when none has arrived. */
  readonly lastPriceTs: number | null;
}

export interface GuardContext {
  /** Status of the order's venue. */
  readonly venueStatus: VenueStatus;
  /** Whether the venue lists the symbol. */
  readonly listed: boolean;
  /** The pair, or null when unknown. */
  readonly pair: PairInfo | null;
  /** Epoch ms. */
  readonly now: number;
  /** Maximum age of the last price in ms. */
  readonly maxAgeMs: number;
}

export type GuardResult = { readonly ok: true } | { readonly ok: false; readonly reason: GuardReason };

export function checkMarketGuards(ctx: GuardContext): GuardResult {
  if (ctx.venueStatus !== "up" || !ctx.listed) return { ok: false, reason: "venue_unavailable" };
  const pair = ctx.pair;
  if (pair === null) return { ok: false, reason: "venue_unavailable" };
  if (pair.health === "stale" || pair.lastPriceTs === null || ctx.now - pair.lastPriceTs > ctx.maxAgeMs) {
    return { ok: false, reason: "stale_market_data" };
  }
  if (pair.health === "suspect") return { ok: false, reason: "price_deviation" };
  return { ok: true };
}

/**
 * DEX divergence: true when |dex - mark| / mark exceeds maxPct percent. BigInt only.
 * A non-positive mark cannot be judged and counts as diverged.
 */
export function isDiverged(dexPrice: bigint, markPrice: bigint, maxPct: number): boolean {
  if (markPrice <= 0n || dexPrice <= 0n) return true;
  const diff = dexPrice > markPrice ? dexPrice - markPrice : markPrice - dexPrice;
  // maxPct in basis points of a percent: 0.01% resolution.
  const limitBps = BigInt(Math.round(maxPct * 100));
  return diff * 10_000n > markPrice * limitBps;
}

/** The Router's source of market health. Absent in tests that do not care. */
export interface MarketHealthSource {
  context(symbol: string, venue: string, now: number): GuardContext;
}
