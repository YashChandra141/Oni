// Risk limits (Req 19) and exact notional math for the Risk_Engine.
// Money is bigint in units of 1e-10 USD, like the Rust `Money` type. Lots are 1e-8 of the base unit.

import { z } from "zod";

import { instrumentBySymbol } from "../instruments.ts";

/** Decimal places in a Money value; mirrors `MONEY_DECIMALS` in rust/crates/protocol/src/num.rs. */
export const MONEY_DECIMALS = 10;

export interface RiskLimits {
  /** Maximum order notional, in Money units (1e-10 USD). Req 19.1. */
  readonly maxOrderValue: bigint;
  /** Maximum absolute position per symbol, in lots. Req 19.2. */
  readonly maxPositionLots: Readonly<Record<string, bigint>>;
  /** Maximum open orders per account. Req 19.3. */
  readonly maxOpenOrders: number;
  /** Price band half-width around the last trade price, in basis points. Req 19.4. */
  readonly priceBandBps: number;
  /** Orders allowed per connection in any rolling second. Req 19.5. */
  readonly rateLimitPerSecond: number;
}

const LOTS_PER_UNIT = 10n ** 8n;

export function defaultLimits(): RiskLimits {
  return {
    maxOrderValue: 250_000n * 10n ** 10n,
    maxPositionLots: {
      "BTC-USD": 5n * LOTS_PER_UNIT,
      "ETH-USD": 100n * LOTS_PER_UNIT,
      "SOL-USD": 2_000n * LOTS_PER_UNIT,
    },
    maxOpenOrders: 50,
    priceBandBps: 1000,
    rateLimitPerSecond: 10,
  };
}

/** Largest i64; Money and Qty are i64 in the engine, so no limit may exceed it. */
export const I64_MAX = 2n ** 63n - 1n;

const positiveBigintString = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/, { message: "must be a positive integer string" })
  .transform((s) => BigInt(s))
  .refine((n) => n <= I64_MAX, { message: "must fit in i64" });

/** Overrides for env or tests. Every field is optional; bigints are positive decimal strings. */
export const RiskLimitsOverrideSchema = z
  .object({
    maxOrderValue: positiveBigintString,
    maxPositionLots: z.record(z.string(), positiveBigintString),
    maxOpenOrders: z.number().int().positive(),
    priceBandBps: z.number().int().positive(),
    rateLimitPerSecond: z.number().int().positive(),
  })
  .partial()
  .strict();

export type RiskLimitsOverride = z.output<typeof RiskLimitsOverrideSchema>;

/** Validates `overrides` and applies them over the defaults. Throws a ZodError on bad input. */
export function resolveLimits(overrides: unknown): RiskLimits {
  const parsed = RiskLimitsOverrideSchema.parse(overrides);
  const base = defaultLimits();
  return {
    maxOrderValue: parsed.maxOrderValue ?? base.maxOrderValue,
    maxPositionLots: { ...base.maxPositionLots, ...(parsed.maxPositionLots ?? {}) },
    maxOpenOrders: parsed.maxOpenOrders ?? base.maxOpenOrders,
    priceBandBps: parsed.priceBandBps ?? base.priceBandBps,
    rateLimitPerSecond: parsed.rateLimitPerSecond ?? base.rateLimitPerSecond,
  };
}

/**
 * Exact notional of `qtyLots` at `priceTicks`, in Money units:
 * price × qty × 10^(MONEY_DECIMALS − priceDecimals − qtyDecimals), as in Rust `notional`
 * (rust/crates/protocol/src/instrument.rs). Wherever Rust returns `Ok`, the value is equal. Where
 * Rust returns `Overflow` (result above i64), this returns the exact larger value instead; that is
 * above every `maxOrderValue` (capped at I64_MAX), so the Risk_Engine still rejects the order.
 * Throws RangeError for an unknown symbol or an instrument finer than Money.
 */
export function notionalMoney(symbol: string, priceTicks: bigint, qtyLots: bigint): bigint {
  const info = instrumentBySymbol(symbol);
  if (info === undefined) throw new RangeError(`unknown symbol ${symbol}`);
  const exp = MONEY_DECIMALS - info.price_decimals - info.qty_decimals;
  if (exp < 0) throw new RangeError(`instrument ${symbol} is finer than Money`);
  return priceTicks * qtyLots * 10n ** BigInt(exp);
}
