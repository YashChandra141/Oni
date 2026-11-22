// Risk_Engine: a pure pre-trade check (Req 19). No I/O, no clock, no hidden state; the rate
// window is passed in and returned. There are no bypass flags (trading-safety rule 5).
//
// Rules run in this order and the first failure wins:
//   1 kill_switch      2 rate_limit      3 max_open_orders
//   4 price_band       5 max_order_value 6 max_position   7 insufficient_balance

import { instrumentBySymbol } from "../instruments.ts";
import { BalanceError, DEFAULT_FEE_BPS, DEFAULT_SLIPPAGE_BPS, requiredFunds } from "./balance.ts";
import { notionalMoney, type RiskLimits } from "./limits.ts";

export type RejectReason =
  | "kill_switch"
  | "rate_limit"
  | "max_open_orders"
  | "price_band"
  | "max_order_value"
  | "max_position"
  | "insufficient_balance";

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
  /**
   * Cached engine balance of the order's account (Req 16.5). Absent or null before the first
   * Balance event: the check is skipped and the engine's own check (Req 16.7) is the backstop.
   */
  readonly balance?: RiskBalance | null;
}

export interface RiskBalance {
  /** Free_Balance from the latest Balance event, Money units. */
  readonly freeBalance: bigint;
  /** Average entry price of the order's account in the symbol, ticks; null when flat or unknown. */
  readonly avgEntry?: bigint | null;
  /** Fee rate in basis points. Defaults to DEFAULT_FEE_BPS. */
  readonly feeBps?: bigint;
  /** Slippage allowance in basis points. Defaults to DEFAULT_SLIPPAGE_BPS. */
  readonly slippageBps?: bigint;
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

  // 7. balance (Req 16.5): Free_Balance − Required_Funds must stay at or above zero.
  if (ctx.balance !== undefined && ctx.balance !== null) {
    const inst = instrumentBySymbol(order.symbol);
    if (inst === undefined) throw new RangeError(`unknown symbol ${order.symbol}`);
    const bal = ctx.balance;
    const pos = ctx.positionLots;
    // Signed cost basis, rebuilt from the cached average entry (or the reference price).
    const entry = bal.avgEntry ?? reference;
    const basis = pos === 0n ? 0n : (pos < 0n ? -1n : 1n) * notionalMoney(order.symbol, entry, abs(pos));
    let required: bigint;
    try {
      required = requiredFunds({
        instrument: inst,
        side: order.side,
        qty: order.qty,
        pos,
        basis,
        feeBps: bal.feeBps ?? BigInt(DEFAULT_FEE_BPS),
        reference,
        slippageBps: bal.slippageBps ?? BigInt(DEFAULT_SLIPPAGE_BPS),
      });
    } catch (err) {
      // Arithmetic overflow means the order is far beyond any balance. Fail closed.
      if (err instanceof BalanceError) return { ok: false, reason: "insufficient_balance", rate };
      throw err;
    }
    if (bal.freeBalance - required < 0n) return { ok: false, reason: "insufficient_balance", rate };
  }

  return { ok: true, rate };
}

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}
