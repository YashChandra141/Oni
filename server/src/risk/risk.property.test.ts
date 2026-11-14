// Property P18 — validates Req 19.8 (and 19.2, 19.3, 19.5 per the design property table)
// Property P19 — validates Req 19.9
//
// P18 drives checkOrder through sequences of order attempts from four connections: c1 and c2 are
// two tabs on one wallet, c3 is another wallet, c4 is the guest. The harness keeps each account's
// positions and open orders and each connection's rate window, and builds every RiskContext from
// the order's own account and connection. An oracle written here, separately from risk.ts, lists
// the limits an order would break. Approved orders must break none; rejected orders must break
// the limit named by the reason (or the kill switch must be on).

import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { instrumentBySymbol } from "../instruments.ts";
import { defaultLimits, I64_MAX, type RiskLimits } from "./limits.ts";
import {
  checkOrder,
  type RateWindow,
  type RejectReason,
  type RiskContext,
  type RiskOrder,
  type RiskOrderKind,
} from "./risk.ts";

const NUM_RUNS = 200;

const SYMBOLS = ["BTC-USD", "ETH-USD", "SOL-USD"] as const;
type Sym = (typeof SYMBOLS)[number];

const WALLET_A = "w_7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const WALLET_B = "w_9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

/** Connections and the account each one is signed in to. c1 and c2 share WALLET_A. */
const CONNECTIONS = [
  { id: "c1", account: WALLET_A },
  { id: "c2", account: WALLET_A },
  { id: "c3", account: WALLET_B },
  { id: "c4", account: "guest" },
] as const;

// ---------------------------------------------------------------------------------------------
// Oracle (independent of risk.ts)
// ---------------------------------------------------------------------------------------------

function absBig(n: bigint): bigint {
  return n < 0n ? -n : n;
}

/** Rust `notional`: price × qty × 10^(MONEY_DECIMALS − price_decimals − qty_decimals), exact. */
function oracleNotional(symbol: string, price: bigint, qty: bigint): bigint {
  const info = instrumentBySymbol(symbol);
  if (info === undefined) throw new Error(`oracle: unknown symbol ${symbol}`);
  return price * qty * 10n ** BigInt(10 - info.price_decimals - info.qty_decimals);
}

interface Market {
  readonly lastPrice: bigint | null;
  readonly bestBid: bigint | null;
  readonly bestAsk: bigint | null;
}

/** Harness state, keyed by account id (positions, open orders) and connection id (attempts). */
interface State {
  /** Key `${accountId}|${symbol}` → signed lots. */
  readonly positions: Map<string, bigint>;
  /** Account id → open orders. */
  readonly openOrders: Map<string, number>;
  /** Connection id → rate window as last returned by checkOrder. */
  readonly windows: Map<string, RateWindow>;
}

/** The limits `order` would break, evaluated on the order's own account and connection. */
function oracleFailures(
  order: RiskOrder,
  market: Market,
  limits: RiskLimits,
  state: State,
  now: number,
): Set<RejectReason> {
  const failed = new Set<RejectReason>();
  const position = state.positions.get(`${order.accountId}|${order.symbol}`) ?? 0n;
  const openOrders = state.openOrders.get(order.accountId) ?? 0;
  const attempts = state.windows.get(order.connectionId) ?? [];

  // Req 19.5: this attempt plus the connection's attempts in the last 1000 ms fit the rate.
  const recent = attempts.filter((t) => now - t < 1000).length;
  if (recent + 1 > limits.rateLimitPerSecond) failed.add("rate_limit");

  // Req 19.3: the account's open orders plus this one fit the cap.
  if (openOrders + 1 > limits.maxOpenOrders) failed.add("max_open_orders");

  // Req 19.4: limit/stop price within last × (1 ± bps/10,000), edges included.
  let reference: bigint | null;
  const kind = order.kind;
  if (kind.type === "market") {
    const opposite = order.side === "buy" ? market.bestAsk : market.bestBid;
    reference = opposite !== null ? opposite : market.lastPrice;
  } else {
    const price = kind.type === "limit" ? kind.price : kind.stopPrice;
    reference = price;
    const last = market.lastPrice;
    const bps = BigInt(limits.priceBandBps);
    if (
      last === null ||
      price * 10_000n < last * (10_000n - bps) ||
      price * 10_000n > last * (10_000n + bps)
    ) {
      failed.add("price_band");
    }
  }
  // An order that cannot be valued at all is a price_band failure.
  if (reference === null) failed.add("price_band");
  // Req 19.1: order value within the cap.
  else if (oracleNotional(order.symbol, reference, order.qty) > limits.maxOrderValue) {
    failed.add("max_order_value");
  }

  // Req 19.2: |position after| within the symbol's cap, unless the order shrinks |position|.
  const max = limits.maxPositionLots[order.symbol];
  if (max === undefined) throw new Error(`oracle: no position limit for ${order.symbol}`);
  const after = position + (order.side === "buy" ? order.qty : -order.qty);
  const shrinks = absBig(after) < absBig(position);
  if (absBig(after) > max && !shrinks) failed.add("max_position");

  return failed;
}

// ---------------------------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------------------------

const randomLimitsArb: fc.Arbitrary<RiskLimits> = fc
  .record({
    maxOrderValue: fc.bigInt({ min: 1n, max: I64_MAX }),
    btc: fc.bigInt({ min: 1n, max: 10n ** 12n }),
    eth: fc.bigInt({ min: 1n, max: 10n ** 12n }),
    sol: fc.bigInt({ min: 1n, max: 10n ** 12n }),
    maxOpenOrders: fc.integer({ min: 1, max: 60 }),
    priceBandBps: fc.integer({ min: 1, max: 15_000 }),
    rateLimitPerSecond: fc.integer({ min: 1, max: 12 }),
  })
  .map((r) => ({
    maxOrderValue: r.maxOrderValue,
    maxPositionLots: { "BTC-USD": r.btc, "ETH-USD": r.eth, "SOL-USD": r.sol },
    maxOpenOrders: r.maxOpenOrders,
    priceBandBps: r.priceBandBps,
    rateLimitPerSecond: r.rateLimitPerSecond,
  }));

const limitsArb: fc.Arbitrary<RiskLimits> = fc.oneof(fc.constant(defaultLimits()), randomLimitsArb);

/** Offsets in basis points around a reference price; ±3,000 reaches past the default ±1,000. */
const bpsOffsetArb = fc.integer({ min: -3_000, max: 3_000 });

/** `base` moved by `bps` basis points, rounded down, at least one tick. */
function nearPrice(base: bigint, bps: number): bigint {
  const p = (base * BigInt(10_000 + bps)) / 10_000n;
  return p < 1n ? 1n : p;
}

type PriceSpec = { readonly rel: number } | { readonly abs: bigint };
type KindSpec =
  | { readonly type: "market" }
  | { readonly type: "limit" | "stop"; readonly price: PriceSpec };

const priceSpecArb: fc.Arbitrary<PriceSpec> = fc.oneof(
  fc.record({ rel: bpsOffsetArb }),
  fc.record({ abs: fc.bigInt({ min: 1n, max: 10n ** 13n }) }),
);

const kindSpecArb: fc.Arbitrary<KindSpec> = fc.oneof(
  fc.constant({ type: "market" as const }),
  fc.record({ type: fc.constantFrom("limit" as const, "stop" as const), price: priceSpecArb }),
);

function resolveKind(spec: KindSpec, last: bigint | null, base: bigint): RiskOrderKind {
  if (spec.type === "market") return { type: "market" };
  const anchor = last ?? base;
  const price = "rel" in spec.price ? nearPrice(anchor, spec.price.rel) : spec.price.abs;
  return spec.type === "limit" ? { type: "limit", price } : { type: "stop", stopPrice: price };
}

/** Mostly null (no change); otherwise a value from `arb`. */
function sometimes<T>(arb: fc.Arbitrary<T>): fc.Arbitrary<T | null> {
  return fc.oneof({ arbitrary: fc.constant(null), weight: 3 }, { arbitrary: arb, weight: 1 });
}

const qtyArb = fc.oneof(
  fc.bigInt({ min: 1n, max: 10n ** 9n }),
  fc.bigInt({ min: 1n, max: 10n ** 14n }),
);

const positionArb = fc.oneof(
  fc.bigInt({ min: -(10n ** 10n), max: 10n ** 10n }),
  fc.bigInt({ min: -(10n ** 14n), max: 10n ** 14n }),
);

const stepArb = fc.record({
  conn: fc.constantFrom(...CONNECTIONS),
  symbol: fc.constantFrom(...SYMBOLS),
  side: fc.constantFrom("buy" as const, "sell" as const),
  qty: qtyArb,
  kind: kindSpecArb,
  /** Milliseconds since the previous step; zero and small gaps make bursts. */
  dt: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 60 }), fc.integer({ min: 0, max: 1_500 })),
  killSwitch: fc.integer({ min: 0, max: 9 }).map((n) => n === 0),
  /** Position of the step's account in the step's symbol, set from outside (e.g. fills). */
  setPosition: sometimes(positionArb),
  /** Open orders of the step's account, set from outside (e.g. fills and cancels). */
  setOpenOrders: sometimes(fc.integer({ min: 0, max: 70 })),
  last: fc.option(bpsOffsetArb, { nil: null, freq: 8 }),
  bid: fc.option(bpsOffsetArb, { nil: null, freq: 6 }),
  ask: fc.option(bpsOffsetArb, { nil: null, freq: 6 }),
});

const baseArb = fc.oneof(
  fc.bigInt({ min: 1n, max: 10n ** 4n }),
  fc.bigInt({ min: 1n, max: 10n ** 9n }),
);

const scenarioArb = fc.record({
  limits: limitsArb,
  base: fc.record({ "BTC-USD": baseArb, "ETH-USD": baseArb, "SOL-USD": baseArb }),
  start: fc.integer({ min: 0, max: 1_000_000_000 }),
  steps: fc.array(stepArb, { minLength: 1, maxLength: 40 }),
});

// ---------------------------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------------------------

describe("Property P18: approved orders satisfy every limit of their own account (Req 19.8)", () => {
  test("approvals break no oracle limit; rejections name a broken limit or the kill switch", () => {
    let approvals = 0;
    let rejections = 0;
    fc.assert(
      fc.property(scenarioArb, ({ limits, base, start, steps }) => {
        const state: State = { positions: new Map(), openOrders: new Map(), windows: new Map() };
        /** Connection id → times of its approved orders. */
        const approvedAt = new Map<string, number[]>();
        let now = start;

        for (const s of steps) {
          now += s.dt;
          const { id: connectionId, account: accountId } = s.conn;
          const symbol: Sym = s.symbol;
          const posKey = `${accountId}|${symbol}`;
          if (s.setPosition !== null) state.positions.set(posKey, s.setPosition);
          if (s.setOpenOrders !== null) state.openOrders.set(accountId, s.setOpenOrders);

          const b = base[symbol];
          const lastPrice = s.last === null ? null : nearPrice(b, s.last);
          const anchor = lastPrice ?? b;
          const market: Market = {
            lastPrice,
            bestBid: s.bid === null ? null : nearPrice(anchor, s.bid),
            bestAsk: s.ask === null ? null : nearPrice(anchor, s.ask),
          };
          const order: RiskOrder = {
            accountId,
            connectionId,
            symbol,
            side: s.side,
            qty: s.qty,
            kind: resolveKind(s.kind, lastPrice, b),
          };
          // The context is built the way the router does it: account state from the order's
          // account, the rate window from the order's connection.
          const ctx: RiskContext = {
            limits,
            killSwitch: s.killSwitch,
            positionLots: state.positions.get(posKey) ?? 0n,
            openOrderCount: state.openOrders.get(accountId) ?? 0,
            ...market,
            rate: state.windows.get(connectionId) ?? [],
            now,
          };

          const failed = oracleFailures(order, market, limits, state, now);
          const result = checkOrder(order, ctx);

          // The returned window holds at most the limit. Past the kill switch (which hands the
          // window back untouched and unpruned) it holds only attempts from the last second.
          expect(result.rate.length).toBeLessThanOrEqual(limits.rateLimitPerSecond);
          if (result.ok || result.reason !== "kill_switch") {
            for (const t of result.rate) expect(t <= now && now - t < 1000).toBe(true);
          }
          state.windows.set(connectionId, result.rate);

          if (result.ok) {
            approvals++;
            expect(s.killSwitch).toBe(false);
            expect([...failed]).toEqual([]);
            // Over the whole sequence, no connection gets more approvals in any second than
            // the rate allows, whatever the other tab on the same wallet does.
            const times = approvedAt.get(connectionId) ?? [];
            times.push(now);
            approvedAt.set(connectionId, times);
            const inLastSecond = times.filter((t) => now - t < 1000).length;
            expect(inLastSecond).toBeLessThanOrEqual(limits.rateLimitPerSecond);
            // The approved order lands on its own account only: a market order fills in full,
            // a limit or stop order rests.
            if (order.kind.type === "market") {
              const signed = order.side === "buy" ? order.qty : -order.qty;
              state.positions.set(posKey, ctx.positionLots + signed);
            } else {
              state.openOrders.set(accountId, ctx.openOrderCount + 1);
            }
          } else {
            rejections++;
            if (result.reason === "kill_switch") {
              expect(s.killSwitch).toBe(true);
            } else {
              expect(failed.has(result.reason)).toBe(true);
            }
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
    // The generators must reach both outcomes, or the property says nothing.
    expect(approvals).toBeGreaterThan(0);
    expect(rejections).toBeGreaterThan(0);
  });
});

const anyPriceArb = fc.bigInt({ min: 1n, max: 10n ** 15n });

const anyKindArb: fc.Arbitrary<RiskOrderKind> = fc.oneof(
  fc.constant({ type: "market" as const }),
  anyPriceArb.map((price) => ({ type: "limit" as const, price })),
  anyPriceArb.map((stopPrice) => ({ type: "stop" as const, stopPrice })),
);

const killedCaseArb = fc.record({
  limits: limitsArb,
  conn: fc.constantFrom(...CONNECTIONS),
  symbol: fc.constantFrom(...SYMBOLS),
  side: fc.constantFrom("buy" as const, "sell" as const),
  qty: qtyArb,
  kind: anyKindArb,
  positionLots: positionArb,
  openOrderCount: fc.integer({ min: 0, max: 1_000 }),
  lastPrice: fc.option(anyPriceArb, { nil: null }),
  bestBid: fc.option(anyPriceArb, { nil: null }),
  bestAsk: fc.option(anyPriceArb, { nil: null }),
  rate: fc.array(fc.integer({ min: 0, max: 2_000_000_000 }), { maxLength: 30 }),
  now: fc.integer({ min: 0, max: 2_000_000_000 }),
});

describe("Property P19: kill switch on means zero approvals (Req 19.9)", () => {
  test("checkOrder never approves while the kill switch is on", () => {
    fc.assert(
      fc.property(killedCaseArb, (c) => {
        const order: RiskOrder = {
          accountId: c.conn.account,
          connectionId: c.conn.id,
          symbol: c.symbol,
          side: c.side,
          qty: c.qty,
          kind: c.kind,
        };
        const ctx: RiskContext = {
          limits: c.limits,
          killSwitch: true,
          positionLots: c.positionLots,
          openOrderCount: c.openOrderCount,
          lastPrice: c.lastPrice,
          bestBid: c.bestBid,
          bestAsk: c.bestAsk,
          rate: c.rate,
          now: c.now,
        };
        const result = checkOrder(order, ctx);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe("kill_switch");
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
