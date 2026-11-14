// Risk_Engine: a pure pre-trade check (Req 19). No I/O, no clock, no hidden state; the rate
// window is passed in and returned. There are no bypass flags (trading-safety rule 5).
//
// Rules run in this order and the first failure wins:
//   1 kill_switch      2 rate_limit      3 max_open_orders
//   4 price_band       5 max_order_value 6 max_position

import { notionalMoney, type RiskLimits } from "./limits.ts";

export type RejectReason =
  | "kill_switch"
  | "rate_limit"
  | "max_open_orders"
  | "price_band"
  | "max_order_value"
  | "max_position";

export type RiskOrderKind =
  | { readonly type: "market" }
  | { readonly type: "limit"; readonly price: bigint }
  | { readonly type: "stop"; readonly stopPrice: bigint };

export interface RiskOrder {
  readonly accountId: string;
  /** Identifies the WebSocket connection (or other source) for the rate limit. */
  readonly connectionId: string;
  readonly symbol: string;
  readonly side: "buy" | "sell";
  /** Lots, positive. */
  readonly qty: bigint;
  readonly kind: RiskOrderKind;
}

/** Timestamps (ms) of the recent order attempts of one connection, oldest first. */
export type RateWindow = readonly number[];

export interface RiskContext {
  readonly limits: RiskLimits;
  readonly killSwitch: boolean;
  /** Signed position of the order's account in the order's symbol, in lots. */
  readonly positionLots: bigint;
  /** Open orders of the order's account. */
  readonly openOrderCount: number;
  readonly lastPrice: bigint | null;
  readonly bestBid: bigint | null;
  readonly bestAsk: bigint | null;
  /** The rate window of `order.connectionId`. */
  readonly rate: RateWindow;
  /** Current time, ms. */
  readonly now: number;
}

export type RiskResult =
  | { readonly ok: true; readonly rate: RateWindow }
  | { readonly ok: false; readonly reason: RejectReason; readonly rate: RateWindow };

const BPS = 10_000n;
const RATE_WINDOW_MS = 1000;

/** Price used to value the order, or null when there is none. Market orders use the best opposite price, then the last price. */
export function referencePrice(order: RiskOrder, ctx: RiskContext): bigint | null {
  switch (order.kind.type) {
    case "limit":
      return order.kind.price;
    case "stop":
      return order.kind.stopPrice;
    case "market":
      return (order.side === "buy" ? ctx.bestAsk : ctx.bestBid) ?? ctx.lastPrice;
  }
}

/**
 * Checks one new order. Throws RangeError for an unknown symbol, a non-positive quantity or
 * price, a non-positive lastPrice/bestBid/bestAsk, a negative or fractional openOrderCount, or a
 * non-finite `now` (callers validate earlier); it never approves such input. Validation runs
 * before the kill switch, so invalid input throws even while the kill switch is on.
 *
 * Rate window: a kill_switch rejection returns `ctx.rate` unchanged. Otherwise the window is
 * pruned to attempts newer than `now - 1000` ms. If it already holds `rateLimitPerSecond`
 * attempts the order is rejected with rate_limit and the pruned window is returned (the rejected
 * attempt is not recorded, so a rejected burst does not extend the lockout). If it holds fewer,
 * `now` is appended whether or not a later rule rejects the order, since an attempt counts.
 *
 * Price band: limit and stop prices must lie within ±priceBandBps of the last trade price
 * (edges inclusive). With no last price, limit and stop orders are rejected with price_band, and
 * so are market orders that have no reference price either.
 *
 * Max position: the resulting |position ± qty| must not exceed the symbol's limit. An order that
 * reduces the absolute position is always allowed by this rule, even when the position is
 * already over the limit. Only the current position counts, not open orders.
 */
export function checkOrder(order: RiskOrder, ctx: RiskContext): RiskResult {
  const { limits } = ctx;
  const maxPosition = limits.maxPositionLots[order.symbol];
  if (maxPosition === undefined) throw new RangeError(`unknown symbol ${order.symbol}`);
  if (order.qty <= 0n) throw new RangeError("qty must be positive");
  if (order.kind.type === "limit" && order.kind.price <= 0n) {
    throw new RangeError("limit price must be positive");
  }
  if (order.kind.type === "stop" && order.kind.stopPrice <= 0n) {
    throw new RangeError("stop price must be positive");
  }
  // Also validates the symbol against the instrument table.
  notionalMoney(order.symbol, 1n, 1n);
  // A malformed context must not turn into an approval (e.g. a zero best ask valuing a market
  // order at $0), so it throws as well.
  for (const [name, price] of [
    ["lastPrice", ctx.lastPrice],
    ["bestBid", ctx.bestBid],
    ["bestAsk", ctx.bestAsk],
  ] as const) {
    if (price !== null && price <= 0n) throw new RangeError(`${name} must be positive`);
  }
  if (!Number.isSafeInteger(ctx.openOrderCount) || ctx.openOrderCount < 0) {
    throw new RangeError("openOrderCount must be a non-negative integer");
  }
  if (!Number.isFinite(ctx.now)) throw new RangeError("now must be finite");

  // 1. kill switch (Req 19.6). Does not consume the rate window.
  if (ctx.killSwitch) return { ok: false, reason: "kill_switch", rate: ctx.rate };

  // 2. rate limit (Req 19.5).
  const recent = ctx.rate.filter((t) => t > ctx.now - RATE_WINDOW_MS);
  if (recent.length >= limits.rateLimitPerSecond) {
    return { ok: false, reason: "rate_limit", rate: recent };
  }
  const rate: RateWindow = [...recent, ctx.now];

  // 3. open orders (Req 19.3): the new order must fit.
  if (ctx.openOrderCount >= limits.maxOpenOrders) {
    return { ok: false, reason: "max_open_orders", rate };
  }

  // 4. price band (Req 19.4).
  const { kind } = order;
  if (kind.type !== "market") {
    if (ctx.lastPrice === null) return { ok: false, reason: "price_band", rate };
    const price = kind.type === "limit" ? kind.price : kind.stopPrice;
    const diff = price > ctx.lastPrice ? price - ctx.lastPrice : ctx.lastPrice - price;
    if (diff * BPS > ctx.lastPrice * BigInt(limits.priceBandBps)) {
      return { ok: false, reason: "price_band", rate };
    }
  }
  const reference = referencePrice(order, ctx);
  if (reference === null) return { ok: false, reason: "price_band", rate };

  // 5. order value (Req 19.1).
  if (notionalMoney(order.symbol, reference, order.qty) > limits.maxOrderValue) {
    return { ok: false, reason: "max_order_value", rate };
  }

  // 6. position (Req 19.2).
  const signed = order.side === "buy" ? order.qty : -order.qty;
  const resulting = abs(ctx.positionLots + signed);
  if (resulting > maxPosition && resulting >= abs(ctx.positionLots)) {
    return { ok: false, reason: "max_position", rate };
  }

  return { ok: true, rate };
}

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}
