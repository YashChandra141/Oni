// SubscriptionRegistry: ref-counts (design §3 Gateway, Req 15.4). The candle cache tests live in
// state/market.test.ts since Task 4.6 moved the cache there.
import { describe, expect, test } from "bun:test";
import { SubscriptionRegistry } from "./clients.ts";

describe("ref-counting", () => {
  test("first subscriber is reported once; duplicates are idempotent", () => {
    const r = new SubscriptionRegistry();
    expect(r.subscribe("a", "BTC-USD", "1m")).toEqual({ first: true, added: true });
    expect(r.subscribe("a", "BTC-USD", "1m")).toEqual({ first: false, added: false });
    expect(r.subscribe("b", "BTC-USD", "1m")).toEqual({ first: false, added: true });
    expect(r.count("BTC-USD", "1m")).toBe(2);
    expect(r.subscribe("a", "BTC-USD", "5m").first).toBe(true);
  });

  test("unsubscribe returns the key only when its count drops to 0", () => {
    const r = new SubscriptionRegistry();
    r.subscribe("a", "BTC-USD", "1m");
    r.subscribe("b", "BTC-USD", "1m");
    expect(r.unsubscribe("a", "BTC-USD", "1m")).toEqual([]);
    expect(r.unsubscribe("a", "BTC-USD", "1m")).toEqual([]); // already gone
    expect(r.unsubscribe("b", "BTC-USD", "1m")).toEqual([{ symbol: "BTC-USD", timeframe: "1m" }]);
    expect(r.count("BTC-USD", "1m")).toBe(0);
    expect(r.unsubscribe("c", "ETH-USD", "1h")).toEqual([]); // never subscribed
  });

  test("removeClient returns every key that lost its last subscriber", () => {
    const r = new SubscriptionRegistry();
    r.subscribe("a", "BTC-USD", "1m");
    r.subscribe("a", "ETH-USD", "5m");
    r.subscribe("b", "BTC-USD", "1m");
    expect(r.removeClient("a")).toEqual([{ symbol: "ETH-USD", timeframe: "5m" }]);
    expect(r.removeClient("a")).toEqual([]);
    expect(r.active()).toEqual([{ symbol: "BTC-USD", timeframe: "1m" }]);
  });

  test("active lists each key once; clientHasSymbol spans timeframes", () => {
    const r = new SubscriptionRegistry();
    r.subscribe("a", "BTC-USD", "1m");
    r.subscribe("b", "BTC-USD", "1m");
    r.subscribe("a", "BTC-USD", "1d");
    expect(r.active()).toEqual([
      { symbol: "BTC-USD", timeframe: "1m" },
      { symbol: "BTC-USD", timeframe: "1d" },
    ]);
    r.unsubscribe("a", "BTC-USD", "1m");
    expect(r.clientHasSymbol("a", "BTC-USD")).toBe(true);
    r.unsubscribe("a", "BTC-USD", "1d");
    expect(r.clientHasSymbol("a", "BTC-USD")).toBe(false);
    expect(r.isSubscribed("b", "BTC-USD", "1m")).toBe(true);
  });
});
