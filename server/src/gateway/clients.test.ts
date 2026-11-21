// SubscriptionRegistry: ref-counts per (venue, symbol, timeframe) (design §3 Gateway, Req 15.4;
// oni-terminal-v2 Req 15.1). The candle cache tests live in state/market.test.ts.
import { describe, expect, test } from "bun:test";
import { SubscriptionRegistry } from "./clients.ts";

describe("ref-counting", () => {
  test("first subscriber is reported once; duplicates are idempotent", () => {
    const r = new SubscriptionRegistry();
    expect(r.subscribe("a", "replay", "BTC-USD", "1m")).toEqual({ first: true, added: true });
    expect(r.subscribe("a", "replay", "BTC-USD", "1m")).toEqual({ first: false, added: false });
    expect(r.subscribe("b", "replay", "BTC-USD", "1m")).toEqual({ first: false, added: true });
    expect(r.count("replay", "BTC-USD", "1m")).toBe(2);
    expect(r.subscribe("a", "replay", "BTC-USD", "5m").first).toBe(true);
    expect(r.subscribe("a", "replay", "BTC-USD", "4h").first).toBe(true);
  });

  test("the venue is part of the key", () => {
    const r = new SubscriptionRegistry();
    expect(r.subscribe("a", "coinbase", "BTC-USD", "1m").first).toBe(true);
    expect(r.subscribe("b", "backpack", "BTC-USD", "1m").first).toBe(true);
    expect(r.count("coinbase", "BTC-USD", "1m")).toBe(1);
    expect(r.unsubscribe("a", "coinbase", "BTC-USD", "1m")).toEqual([
      { venue: "coinbase", symbol: "BTC-USD", timeframe: "1m" },
    ]);
    expect(r.clientHasSymbol("b", "coinbase", "BTC-USD")).toBe(false);
    expect(r.clientHasSymbol("b", "backpack", "BTC-USD")).toBe(true);
  });

  test("unsubscribe returns the key only when its count drops to 0", () => {
    const r = new SubscriptionRegistry();
    r.subscribe("a", "replay", "BTC-USD", "1m");
    r.subscribe("b", "replay", "BTC-USD", "1m");
    expect(r.unsubscribe("a", "replay", "BTC-USD", "1m")).toEqual([]);
    expect(r.unsubscribe("a", "replay", "BTC-USD", "1m")).toEqual([]); // already gone
    expect(r.unsubscribe("b", "replay", "BTC-USD", "1m")).toEqual([
      { venue: "replay", symbol: "BTC-USD", timeframe: "1m" },
    ]);
    expect(r.count("replay", "BTC-USD", "1m")).toBe(0);
    expect(r.unsubscribe("c", "replay", "ETH-USD", "1h")).toEqual([]); // never subscribed
  });

  test("removeClient returns every key that lost its last subscriber", () => {
    const r = new SubscriptionRegistry();
    r.subscribe("a", "replay", "BTC-USD", "1m");
    r.subscribe("a", "replay", "ETH-USD", "5m");
    r.subscribe("b", "replay", "BTC-USD", "1m");
    expect(r.removeClient("a")).toEqual([{ venue: "replay", symbol: "ETH-USD", timeframe: "5m" }]);
    expect(r.removeClient("a")).toEqual([]);
    expect(r.active()).toEqual([{ venue: "replay", symbol: "BTC-USD", timeframe: "1m" }]);
  });

  test("active lists each key once; clientHasSymbol spans timeframes", () => {
    const r = new SubscriptionRegistry();
    r.subscribe("a", "replay", "BTC-USD", "1m");
    r.subscribe("b", "replay", "BTC-USD", "1m");
    r.subscribe("a", "replay", "BTC-USD", "1d");
    expect(r.active()).toEqual([
      { venue: "replay", symbol: "BTC-USD", timeframe: "1m" },
      { venue: "replay", symbol: "BTC-USD", timeframe: "1d" },
    ]);
    r.unsubscribe("a", "replay", "BTC-USD", "1m");
    expect(r.clientHasSymbol("a", "replay", "BTC-USD")).toBe(true);
    r.unsubscribe("a", "replay", "BTC-USD", "1d");
    expect(r.clientHasSymbol("a", "replay", "BTC-USD")).toBe(false);
    expect(r.isSubscribed("b", "replay", "BTC-USD", "1m")).toBe(true);
  });
});
