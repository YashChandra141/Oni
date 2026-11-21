// TS mirror of rust/crates/engine/src/balance.rs (Req 16.5, 16.7, 16.10). BigInt only.
// Money units are 10^-10 USD. Every function is pure and matches the Rust rounding exactly:
// `fee` and released basis truncate toward zero (BigInt division does the same); the slipped
// price rounds up for a buy and down for a sell, and is at least one tick.
// Golden vectors shared with Rust: shared/balance-vectors.json.

import type { InstrumentInfo, Side } from "../protocol.ts";

export const MONEY_PER_USD = 10_000_000_000n;
export const BPS_DENOM = 10_000n;
export const DEFAULT_FEE_BPS = 5;
export const DEFAULT_SLIPPAGE_BPS = 100;

const I64_MAX = (1n << 63n) - 1n;
const I64_MIN = -(1n << 63n);
const I128_MAX = (1n << 127n) - 1n;
const I128_MIN = -(1n << 127n);

export type BalanceErrorCode = "overflow" | "invalid_input";

export class BalanceError extends Error {
  readonly code: BalanceErrorCode;
  constructor(code: BalanceErrorCode) {
    super(code === "overflow" ? "balance arithmetic overflow" : "invalid input for balance computation");
    this.name = "BalanceError";
    this.code = code;
  }
}

/** Checks a result against the engine's i128 range. */
function c(value: bigint): bigint {
  if (value > I128_MAX || value < I128_MIN) throw new BalanceError("overflow");
  return value;
}

function abs(value: bigint): bigint {
  return value < 0n ? c(-value) : value;
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/** Exact notional of `lots` at `price` in Money units; must fit i64 like Rust `notional`. */
function leg(inst: Pick<InstrumentInfo, "price_decimals" | "qty_decimals">, price: bigint, lots: bigint): bigint {
  if (lots === 0n) return 0n;
  const exp = 10 - inst.price_decimals - inst.qty_decimals;
  if (exp < 0) throw new BalanceError("overflow");
  const value = price * lots * 10n ** BigInt(exp);
  if (value > I64_MAX || value < I64_MIN) throw new BalanceError("overflow");
  return value;
}

/** `fee(n) = n × feeBps / 10000`, toward zero. */
export function fee(notional: bigint, feeBps: bigint): bigint {
  return c(notional * feeBps) / BPS_DENOM;
}

/** Reference price moved by the slippage allowance, at least one tick. */
export function slippedPrice(reference: bigint, side: Side, slippageBps: bigint): bigint {
  if (reference <= 0n) throw new BalanceError("invalid_input");
  const adjusted =
    side === "buy"
      ? (c(reference * (BPS_DENOM + slippageBps)) + (BPS_DENOM - 1n)) / BPS_DENOM
      : c(reference * max(BPS_DENOM - slippageBps, 0n)) / BPS_DENOM;
  const out = max(adjusted, 1n);
  if (out > I64_MAX) throw new BalanceError("overflow");
  return out;
}

export interface RequiredFundsAtInput {
  readonly instrument: Pick<InstrumentInfo, "price_decimals" | "qty_decimals">;
  readonly side: Side;
  /** Lots, positive. */
  readonly qty: bigint;
  /** Fill price in ticks (already slipped). */
  readonly fillPrice: bigint;
  /** Signed position in lots. */
  readonly pos: bigint;
  /** Signed cost basis in Money units (negative for a short). */
  readonly basis: bigint;
  readonly feeBps: bigint;
}

export function requiredFundsAt(input: RequiredFundsAtInput): bigint {
  const { instrument, side, qty, fillPrice, pos, basis, feeBps } = input;
  if (qty <= 0n || fillPrice <= 0n || (pos === 0n && basis !== 0n)) {
    throw new BalanceError("invalid_input");
  }
  const n = leg(instrument, fillPrice, qty);
  const f = fee(n, feeBps);
  if (side === "buy") {
    const covered = min(qty, max(-pos, 0n));
    const released = covered > 0n ? c(abs(basis) * covered) / abs(pos) : 0n;
    return c(c(n + f) - c(released * 2n));
  }
  const closed = min(qty, max(pos, 0n));
  const opened = qty - closed;
  return c(c(f + leg(instrument, fillPrice, opened)) - leg(instrument, fillPrice, closed));
}

export interface RequiredFundsInput extends Omit<RequiredFundsAtInput, "fillPrice"> {
  /** Reference price in ticks; the slippage allowance is applied first. */
  readonly reference: bigint;
  readonly slippageBps: bigint;
}

/** Required_Funds of an order from its reference price. May be negative. */
export function requiredFunds(input: RequiredFundsInput): bigint {
  const { reference, slippageBps, ...rest } = input;
  return requiredFundsAt({ ...rest, fillPrice: slippedPrice(reference, input.side, slippageBps) });
}

/** Short_Basis: the sum of |basis| over positions with a negative quantity. */
export function shortBasis(positions: Iterable<{ readonly qty: bigint; readonly basis: bigint }>): bigint {
  let total = 0n;
  for (const p of positions) if (p.qty < 0n) total = c(total + abs(p.basis));
  return total;
}

/** Reserved_Balance: the sum of max(0, RF) over open orders. */
export function reservedTotal(required: Iterable<bigint>): bigint {
  let total = 0n;
  for (const rf of required) total = c(total + max(rf, 0n));
  return total;
}

/** `Free_Balance = Paper_Balance − 2 × Short_Basis − Reserved`. May be negative. */
export function freeBalance(paperBalance: bigint, shortBasisValue: bigint, reserved: bigint): bigint {
  return c(c(paperBalance - c(shortBasisValue * 2n)) - reserved);
}

export interface Holding {
  readonly instrument: Pick<InstrumentInfo, "price_decimals" | "qty_decimals">;
  readonly mark: bigint;
  readonly pos: bigint;
}

/** `Equity = Paper_Balance + Σ N(Mark, pos)`. */
export function equity(paperBalance: bigint, holdings: Iterable<Holding>): bigint {
  let total = paperBalance;
  for (const h of holdings) total = c(total + leg(h.instrument, h.mark, h.pos));
  return total;
}
