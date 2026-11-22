// Unit tests for the pure Risk_Engine check (Req 19.1–19.6, trading-safety rule 5).

import { describe, expect, test } from "bun:test";

import { defaultLimits, I64_MAX, notionalMoney, resolveLimits } from "./limits.ts";
import {
  checkOrder,
  type RateWindow,
  type RiskContext,
  type RiskOrder,
  type RiskOrderKind,
} from "./risk.ts";

const LAST = 6_400_000n; // $64,000.00
const MONEY = 10n ** 10n;

function order(over: Partial<RiskOrder> = {}): RiskOrder {
  return {
    accountId: "guest",
    connectionId: "c1",
    symbol: "BTC-USD",
    side: "buy",
    qty: 1_000_000n, // 0.01 BTC
    kind: { type: "limit", price: LAST },
    ...over,
  };
}

function ctx(over: Partial<RiskContext> = {}): RiskContext {
  return {
    limits: defaultLimits(),
    killSwitch: false,
    positionLots: 0n,
    openOrderCount: 0,
    lastPrice: LAST,
    bestBid: LAST - 100n,
    bestAsk: LAST + 100n,
    rate: [],
    now: 10_000,
    ...over,
  };
}

function reason(order_: RiskOrder, ctx_: RiskContext): string {
  const r = checkOrder(order_, ctx_);
  return r.ok ? "ok" : r.reason;
}

describe("notionalMoney", () => {
  test("matches hand-computed values and the Rust example", () => {
    // All three instruments have price_decimals 2 and qty_decimals 8, so the scale is
    // 10^(10 − 2 − 8) = 10^0 = 1 and notional = ticks × lots.
    // 0.1 BTC at $64,000.00 (Rust: notional_is_exact):
    //   6,400,000 ticks × 10,000,000 lots = 64,000,000,000,000 = 6,400 × 10^10 → $6,400.
    expect(notionalMoney("BTC-USD", 6_400_000n, 10_000_000n)).toBe(6_400n * MONEY);
    // One lot at one tick: 1 × 1 = 1 Money unit = 10^-10 USD, the smallest Money unit.
    expect(notionalMoney("BTC-USD", 1n, 1n)).toBe(1n);
    // 2 ETH at $3,000.50: 300,050 × 200,000,000 = 60,010,000,000,000 = 6,001 × 10^10 → $6,001.
    expect(notionalMoney("ETH-USD", 300_050n, 200_000_000n)).toBe(6_001n * MONEY);
    // 1,000 SOL at $150.25: 15,025 × 100,000,000,000 = 1,502,500,000,000,000
    //   = 150,250 × 10^10 → $150,250.
    expect(notionalMoney("SOL-USD", 15_025n, 100_000_000_000n)).toBe(150_250n * MONEY);
    // 3.90625 BTC at $64,000.00 is exactly the default $250,000 limit:
    //   6,400,000 × 390,625,000 = 2,500,000,000,000,000 = 250,000 × 10^10.
    expect(notionalMoney("BTC-USD", 6_400_000n, 390_625_000n)).toBe(250_000n * MONEY);
  });

  test("returns the exact value where Rust would report overflow (above i64)", () => {
    // i64::MAX ticks × 2 lots overflows i64 in Rust (notional_overflow_is_an_error); the bigint
    // result is exact and larger than any maxOrderValue, which is capped at I64_MAX.
    expect(notionalMoney("BTC-USD", I64_MAX, 2n)).toBe(I64_MAX * 2n);
    expect(notionalMoney("BTC-USD", I64_MAX, 2n) > I64_MAX).toBe(true);
  });

  test("throws RangeError for an unknown symbol", () => {
    expect(() => notionalMoney("NOPE-USD", 1n, 1n)).toThrow(RangeError);
  });
});

describe("limits", () => {
  test("defaults", () => {
    const l = defaultLimits();
    expect(l.maxOrderValue).toBe(250_000n * MONEY);
    expect(l.maxPositionLots["BTC-USD"]).toBe(5n * 10n ** 8n);
    expect(l.maxPositionLots["ETH-USD"]).toBe(100n * 10n ** 8n);
    expect(l.maxPositionLots["SOL-USD"]).toBe(2_000n * 10n ** 8n);
    expect(l.maxPositionLots["BNB-USD"]).toBe(1_000n * 10n ** 8n);
    expect(l.maxPositionLots["XRP-USD"]).toBe(500_000n * 10n ** 6n);
    expect(l.maxPositionLots["DOGE-USD"]).toBe(2_000_000n * 10n ** 4n);
    expect(l.maxPositionLots["JUP-USD"]).toBe(1_000_000n * 10n ** 4n);
    expect(l.maxPositionLots["WIF-USD"]).toBe(500_000n * 10n ** 4n);
    expect(l.maxPositionLots["BONK-USD"]).toBe(100_000_000_000n);
    expect(l.maxPositionLots["PEPE-USD"]).toBe(100_000_000_000n);
    expect(l.maxOpenOrders).toBe(50);
    expect(l.priceBandBps).toBe(1000);
    expect(l.rateLimitPerSecond).toBe(10);
  });

  test("resolveLimits applies valid overrides and rejects bad ones", () => {
    const l = resolveLimits({ maxOrderValue: "5", maxOpenOrders: 2 });
    expect(l.maxOrderValue).toBe(5n);
    expect(l.maxOpenOrders).toBe(2);
    expect(l.priceBandBps).toBe(1000);
    expect(() => resolveLimits({ maxOrderValue: "0" })).toThrow();
    expect(() => resolveLimits({ maxOrderValue: "-5" })).toThrow();
    expect(() => resolveLimits({ maxOpenOrders: 0 })).toThrow();
    expect(() => resolveLimits({ bypass: true })).toThrow();
    expect(() => resolveLimits({ killSwitch: false })).toThrow();
    // Limits are i64 values in the engine: i64::MAX is accepted, one more is not.
    expect(resolveLimits({ maxOrderValue: I64_MAX.toString() }).maxOrderValue).toBe(I64_MAX);
    expect(() => resolveLimits({ maxOrderValue: (I64_MAX + 1n).toString() })).toThrow();
  });
});

describe("kill switch (Req 19.6)", () => {
  test("rejects a valid order and does not consume the rate window", () => {
    const rate: RateWindow = [9_500];
    const r = checkOrder(order(), ctx({ killSwitch: true, rate }));
    expect(r).toEqual({ ok: false, reason: "kill_switch", rate: [9_500] });
  });

  test("beats every other violated rule", () => {
    const bad = order({ qty: 10n ** 12n, kind: { type: "limit", price: 1n } });
    const c = ctx({
      killSwitch: true,
      openOrderCount: 99,
      lastPrice: null,
      positionLots: 10n ** 12n,
      rate: Array.from({ length: 20 }, () => 9_999),
    });
    expect(reason(bad, c)).toBe("kill_switch");
  });
});

describe("rate limit (Req 19.5)", () => {
  test("ten attempts in the last second are allowed, the eleventh is rejected", () => {
    const nine = Array.from({ length: 9 }, (_, i) => 9_100 + i);
    const ok = checkOrder(order(), ctx({ rate: nine }));
    expect(ok.ok).toBe(true);
    expect(ok.rate).toEqual([...nine, 10_000]);
    const ten = [...nine, 9_500];
    const r = checkOrder(order(), ctx({ rate: ten }));
    expect(r).toEqual({ ok: false, reason: "rate_limit", rate: ten });
  });

  test("the window slides: an attempt exactly 1000 ms old no longer counts", () => {
    const rate = [9_000, ...Array.from({ length: 9 }, (_, i) => 9_500 + i)];
    expect(reason(order(), ctx({ rate }))).toBe("ok");
    expect(reason(order(), ctx({ rate: [9_001, ...rate.slice(1)] }))).toBe("rate_limit");
  });

  test("a full window frees up as its oldest attempt passes 1000 ms", () => {
    const full = Array.from({ length: 10 }, (_, i) => 9_500 + i); // 9,500 … 9,509
    // At 10,499 every attempt is younger than 1000 ms.
    expect(reason(order(), ctx({ rate: full, now: 10_499 }))).toBe("rate_limit");
    // At 10,500 the attempt at 9,500 is exactly 1000 ms old and falls out, leaving nine.
    const r = checkOrder(order(), ctx({ rate: full, now: 10_500 }));
    expect(r).toEqual({ ok: true, rate: [...full.slice(1), 10_500] });
  });

  test("two connections on one wallet each have their own window", () => {
    const wallet = "w_7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
    const full = Array.from({ length: 10 }, () => 9_900);
    const tab1 = order({ accountId: wallet, connectionId: "tab1" });
    const tab2 = order({ accountId: wallet, connectionId: "tab2" });
    expect(reason(tab1, ctx({ rate: full }))).toBe("rate_limit");
    expect(reason(tab2, ctx({ rate: [] }))).toBe("ok");
    // The account-level limits still see the account's shared state from either tab.
    expect(reason(tab2, ctx({ rate: [], openOrderCount: 50 }))).toBe("max_open_orders");
  });

  test("connections are independent: the caller passes each connection's own window", () => {
    const full = Array.from({ length: 10 }, () => 9_900);
    expect(reason(order({ connectionId: "c1" }), ctx({ rate: full }))).toBe("rate_limit");
    expect(reason(order({ connectionId: "c2" }), ctx({ rate: [] }))).toBe("ok");
  });

  test("an attempt is recorded even when a later rule rejects it", () => {
    const r = checkOrder(order({ qty: 10n ** 12n }), ctx());
    expect(r.ok).toBe(false);
    expect(r.rate).toEqual([10_000]);
  });

  test("honours a custom limit", () => {
    const limits = resolveLimits({ rateLimitPerSecond: 1 });
    expect(reason(order(), ctx({ limits, rate: [9_999] }))).toBe("rate_limit");
  });
});

describe("max open orders (Req 19.3)", () => {
  test("49 open orders allow one more, 50 do not", () => {
    expect(reason(order(), ctx({ openOrderCount: 49 }))).toBe("ok");
    expect(reason(order(), ctx({ openOrderCount: 50 }))).toBe("max_open_orders");
  });
});

describe("price band (Req 19.4)", () => {
  const kinds = (price: bigint): RiskOrderKind[] => [
    { type: "limit", price },
    { type: "stop", stopPrice: price },
  ];

  test("exactly ±10 % is allowed, one tick beyond is rejected", () => {
    for (const mk of [(p: bigint) => kinds(p)[0]!, (p: bigint) => kinds(p)[1]!]) {
      expect(reason(order({ kind: mk(7_040_000n) }), ctx())).toBe("ok");
      expect(reason(order({ kind: mk(7_040_001n) }), ctx())).toBe("price_band");
      expect(reason(order({ side: "sell", kind: mk(5_760_000n) }), ctx())).toBe("ok");
      expect(reason(order({ side: "sell", kind: mk(5_759_999n) }), ctx())).toBe("price_band");
    }
  });

  test("limit and stop orders with no last price are rejected with price_band", () => {
    expect(reason(order(), ctx({ lastPrice: null }))).toBe("price_band");
    expect(reason(order({ kind: { type: "stop", stopPrice: LAST } }), ctx({ lastPrice: null }))).toBe(
      "price_band",
    );
  });

  test("market orders with no reference price are rejected with price_band", () => {
    const m = order({ kind: { type: "market" } });
    expect(reason(m, ctx({ lastPrice: null, bestAsk: null, bestBid: null }))).toBe("price_band");
    expect(reason(m, ctx({ lastPrice: null, bestAsk: null }))).toBe("price_band");
  });

  test("a market buy with a book but no trade yet uses the best ask", () => {
    const m = order({ kind: { type: "market" } });
    expect(reason(m, ctx({ lastPrice: null }))).toBe("ok");
  });

  test("a market order is not band-checked", () => {
    const m = order({ kind: { type: "market" } });
    expect(reason(m, ctx({ bestAsk: LAST * 3n }))).toBe("ok");
  });
});

describe("max order value (Req 19.1)", () => {
  // $250,000 / $64,000 = 3.90625 BTC = 390,625,000 lots.
  const exact = 390_625_000n;

  test("exactly the limit is allowed, one lot over is rejected", () => {
    expect(reason(order({ qty: exact }), ctx())).toBe("ok");
    expect(reason(order({ qty: exact + 1n }), ctx())).toBe("max_order_value");
  });

  test("market buys are valued at the best ask, sells at the best bid", () => {
    const buy = order({ qty: exact, kind: { type: "market" } });
    expect(reason(buy, ctx({ bestAsk: LAST }))).toBe("ok");
    expect(reason(buy, ctx({ bestAsk: LAST + 1n }))).toBe("max_order_value");
    const sell = order({ side: "sell", qty: exact, kind: { type: "market" } });
    expect(reason(sell, ctx({ bestBid: LAST, bestAsk: LAST * 2n }))).toBe("ok");
    expect(reason(sell, ctx({ bestBid: LAST + 1n }))).toBe("max_order_value");
  });

  test("a market order with no opposite quote falls back to the last price", () => {
    const buy = order({ qty: exact, kind: { type: "market" } });
    expect(reason(buy, ctx({ bestAsk: null }))).toBe("ok");
    expect(reason({ ...buy, qty: exact + 1n }, ctx({ bestAsk: null }))).toBe("max_order_value");
  });

  test("a stop order is valued at its stop price", () => {
    const stop = order({ qty: exact, kind: { type: "stop", stopPrice: LAST + 1n } });
    expect(reason(stop, ctx())).toBe("max_order_value");
  });
});

describe("max position (Req 19.2)", () => {
  const big = resolveLimits({ maxOrderValue: "9000000000000000000" });
  const five = 5n * 10n ** 8n;

  test("reaching exactly the limit is allowed, one lot beyond is rejected", () => {
    expect(reason(order({ qty: five }), ctx({ limits: big }))).toBe("ok");
    expect(reason(order({ qty: five + 1n }), ctx({ limits: big }))).toBe("max_position");
    expect(reason(order({ qty: 1n }), ctx({ limits: big, positionLots: five }))).toBe(
      "max_position",
    );
  });

  test("the short side is limited the same way", () => {
    const sell = order({ side: "sell", qty: five });
    expect(reason(sell, ctx({ limits: big }))).toBe("ok");
    expect(reason({ ...sell, qty: five + 1n }, ctx({ limits: big }))).toBe("max_position");
    expect(reason(order({ side: "sell", qty: 1n }), ctx({ limits: big, positionLots: -five }))).toBe(
      "max_position",
    );
  });

  test("an order that reduces the absolute position is allowed, even when over the limit", () => {
    const over = five + 10n;
    expect(reason(order({ side: "sell", qty: 1n }), ctx({ limits: big, positionLots: over }))).toBe(
      "ok",
    );
    // Flipping from +over to -(over - 20) reduces |position| and is allowed.
    expect(
      reason(order({ side: "sell", qty: 2n * over - 20n }), ctx({ limits: big, positionLots: over })),
    ).toBe("ok");
    // Flipping to a larger absolute position is not.
    expect(
      reason(order({ side: "sell", qty: 2n * over + 20n }), ctx({ limits: big, positionLots: over })),
    ).toBe("max_position");
    // Buying more while over the limit is rejected.
    expect(reason(order({ qty: 1n }), ctx({ limits: big, positionLots: over }))).toBe(
      "max_position",
    );
  });

  test("limits are per symbol", () => {
    const eth = order({ symbol: "ETH-USD", qty: 100n * 10n ** 8n, kind: { type: "limit", price: 300_000n } });
    expect(reason(eth, ctx({ limits: big, lastPrice: 300_000n }))).toBe("ok");
    expect(reason({ ...eth, qty: eth.qty + 1n }, ctx({ limits: big, lastPrice: 300_000n }))).toBe(
      "max_position",
    );
  });
});

describe("rule order: the first failure wins", () => {
  const limits = resolveLimits({ maxOrderValue: "1", maxOpenOrders: 1 });
  const everythingWrong = order({ qty: 6n * 10n ** 8n, kind: { type: "limit", price: 1n } });

  test("rate_limit, then max_open_orders, then price_band, then max_order_value, then max_position", () => {
    const full = Array.from({ length: 10 }, () => 9_999);
    const base = ctx({ limits, openOrderCount: 5, rate: full });
    expect(reason(everythingWrong, base)).toBe("rate_limit");
    expect(reason(everythingWrong, { ...base, rate: [] })).toBe("max_open_orders");
    expect(reason(everythingWrong, { ...base, rate: [], openOrderCount: 0 })).toBe("price_band");
    const inBand = order({ qty: 6n * 10n ** 8n });
    expect(reason(inBand, { ...base, rate: [], openOrderCount: 0 })).toBe("max_order_value");
    const noValueLimit = resolveLimits({ maxOrderValue: "9000000000000000000" });
    expect(reason(inBand, ctx({ limits: noValueLimit }))).toBe("max_position");
  });
});

describe("invalid input throws instead of approving", () => {
  test("unknown symbol, non-positive qty or price", () => {
    expect(() => checkOrder(order({ symbol: "NOPE-USD" }), ctx())).toThrow(RangeError);
    expect(() => checkOrder(order({ qty: 0n }), ctx())).toThrow(RangeError);
    expect(() => checkOrder(order({ qty: -1n }), ctx())).toThrow(RangeError);
    expect(() => checkOrder(order({ kind: { type: "limit", price: 0n } }), ctx())).toThrow(
      RangeError,
    );
    expect(() => checkOrder(order({ kind: { type: "stop", stopPrice: -5n } }), ctx())).toThrow(
      RangeError,
    );
  });

  test("a malformed context throws, even with the kill switch on", () => {
    // A zero best ask would value a market buy at $0; it must not become an approval.
    const m = order({ kind: { type: "market" } });
    expect(() => checkOrder(m, ctx({ bestAsk: 0n }))).toThrow(RangeError);
    expect(() => checkOrder(order(), ctx({ lastPrice: -1n }))).toThrow(RangeError);
    expect(() => checkOrder(order(), ctx({ openOrderCount: -1 }))).toThrow(RangeError);
    expect(() => checkOrder(order(), ctx({ openOrderCount: 1.5 }))).toThrow(RangeError);
    expect(() => checkOrder(order(), ctx({ now: Number.NaN }))).toThrow(RangeError);
    expect(() => checkOrder(order({ qty: 0n }), ctx({ killSwitch: true }))).toThrow(RangeError);
  });
});

describe("purity", () => {
  test("does not mutate the input window", () => {
    const rate = Object.freeze([9_500, 9_600]) as RateWindow;
    const r = checkOrder(order(), ctx({ rate }));
    expect(r.rate).toEqual([9_500, 9_600, 10_000]);
    expect(rate).toEqual([9_500, 9_600]);
  });
});
