// MarketState: last trade, top of book, and the candle cache (design §3 state/market.ts,
// Req 8.7, 9.6, 9.8, 15.7, 24.2, 24.3).
import { describe, expect, test } from "bun:test";
import type { Bar, Event } from "../protocol.ts";
import { type CandleEvent, MAX_SNAPSHOT_BARS, MarketState, mergeBars } from "./market.ts";

function bar(t: number, close = "100"): Bar {
  return { t, open: "100", high: "110", low: "90", close, volume: "5" };
}

function candle(snapshot: boolean, bars: Bar[], symbol = "BTC-USD"): CandleEvent {
  return { type: "candle", symbol, timeframe: "1m", snapshot, bars };
}

const TRADE: Event = { type: "trade", symbol: "BTC-USD", price: "6400000", qty: "289871", side: "sell", ts: 10 };

const BOOK: Event = {
  type: "book",
  symbol: "BTC-USD",
  // Deliberately not best first: the best level is found by price, not position.
  bids: [
    { price: "6399000", qty: "2" },
    { price: "6400000", qty: "1" },
  ],
  asks: [
    { price: "6402000", qty: "4" },
    { price: "6401000", qty: "3" },
  ],
  spread: "1000",
  imbalance_bps: -4000,
  ts: 20,
};

describe("last trade and top of book", () => {
  test("nothing is known before any event", () => {
    const m = new MarketState();
    expect(m.quote("BTC-USD")).toBeNull();
    expect(m.lastTrade("BTC-USD")).toBeNull();
    expect(m.topOfBook("BTC-USD")).toBeNull();
  });

  test("a trade sets the last trade; a later trade replaces it", () => {
    const m = new MarketState();
    m.apply(TRADE);
    expect(m.lastTrade("BTC-USD")).toEqual({ price: "6400000", qty: "289871", side: "sell", ts: 10 });
    m.apply({ ...TRADE, price: "6401000", side: "buy", ts: 11 });
    expect(m.quote("BTC-USD")).toEqual({
      symbol: "BTC-USD",
      last: { price: "6401000", qty: "289871", side: "buy", ts: 11 },
      book: null,
    });
    expect(m.lastTrade("ETH-USD")).toBeNull(); // per symbol
  });

  test("a book event gives the highest bid and the lowest ask", () => {
    const m = new MarketState();
    m.apply(BOOK);
    expect(m.topOfBook("BTC-USD")).toEqual({
      bid: { price: "6400000", qty: "1" },
      ask: { price: "6401000", qty: "3" },
      spread: "1000",
      imbalance_bps: -4000,
      ts: 20,
    });
    m.apply(TRADE);
    expect(m.quote("BTC-USD")?.last?.price).toBe("6400000");
    expect(m.quote("BTC-USD")?.book?.bid?.price).toBe("6400000");
  });

  test("an empty side gives null; prices compare as integers, not strings", () => {
    const m = new MarketState();
    m.apply({
      ...BOOK,
      bids: [
        { price: "99", qty: "1" },
        { price: "100", qty: "1" },
      ],
      asks: [],
      spread: null,
    });
    const top = m.topOfBook("BTC-USD");
    expect(top?.bid).toEqual({ price: "100", qty: "1" });
    expect(top?.ask).toBeNull();
    expect(top?.spread).toBeNull();
  });

  test("returned values are copies", () => {
    const m = new MarketState();
    m.apply(BOOK);
    const top = m.topOfBook("BTC-USD");
    if (top === null || top.bid === null) throw new Error("expected a bid");
    top.bid.price = "1";
    expect(m.topOfBook("BTC-USD")?.bid?.price).toBe("6400000");
  });

  test("other events are ignored", () => {
    const m = new MarketState();
    m.apply({ type: "heartbeat", ts: 1 });
    m.apply({ type: "order_ack", account_id: "guest", order_id: "o1", status: "accepted" });
    expect(m.quote("BTC-USD")).toBeNull();
  });
});

describe("candle cache", () => {
  test("caches a snapshot and merges live bars: same t replaces, new t appends", () => {
    const m = new MarketState();
    expect(m.snapshot("BTC-USD", "1m")).toBeNull();
    m.apply(candle(false, [bar(0)])); // live before any snapshot: not cached
    expect(m.candles("BTC-USD", "1m")).toBeNull();

    m.apply(candle(true, [bar(0), bar(60_000)]));
    m.apply(candle(false, [bar(60_000, "105")]));
    m.apply(candle(false, [bar(120_000, "107")]));
    expect(m.snapshot("BTC-USD", "1m")).toEqual(candle(true, [bar(0), bar(60_000, "105"), bar(120_000, "107")]));

    // A new snapshot replaces the cached bars.
    m.apply(candle(true, [bar(180_000)]));
    expect(m.candles("BTC-USD", "1m")).toEqual([bar(180_000)]);
    // An empty snapshot (engine subscribed before the replay loaded) is still a snapshot.
    m.apply(candle(true, []));
    expect(m.candles("BTC-USD", "1m")).toEqual([]);
    m.apply(candle(false, [bar(240_000)]));
    expect(m.candles("BTC-USD", "1m")).toEqual([bar(240_000)]);
  });

  test("keys are per symbol and timeframe", () => {
    const m = new MarketState();
    m.apply(candle(true, [bar(0)]));
    expect(m.candles("BTC-USD", "5m")).toBeNull();
    expect(m.candles("ETH-USD", "1m")).toBeNull();
  });

  test("candles(limit) returns the most recent bars, oldest first; bad limits throw", () => {
    const m = new MarketState();
    m.apply(candle(true, [bar(0), bar(60_000), bar(120_000)]));
    expect(m.candles("BTC-USD", "1m", 2)).toEqual([bar(60_000), bar(120_000)]);
    expect(m.candles("BTC-USD", "1m", 500)).toHaveLength(3);
    for (const limit of [0, -1, 1.5, MAX_SNAPSHOT_BARS + 1, Number.NaN]) {
      expect(() => m.candles("BTC-USD", "1m", limit)).toThrow(RangeError);
    }
  });

  test("returned bars are copies", () => {
    const m = new MarketState();
    m.apply(candle(true, [bar(0)]));
    const snap = m.snapshot("BTC-USD", "1m");
    if (snap === null) throw new Error("expected a snapshot");
    snap.bars.push(bar(60_000));
    const first = snap.bars[0];
    if (first !== undefined) first.close = "1";
    expect(m.candles("BTC-USD", "1m")).toEqual([bar(0)]);
  });

  test(`keeps at most ${MAX_SNAPSHOT_BARS} bars, dropping the oldest`, () => {
    const m = new MarketState();
    m.apply(candle(true, Array.from({ length: MAX_SNAPSHOT_BARS }, (_, i) => bar(i * 60_000))));
    m.apply(candle(false, [bar(MAX_SNAPSHOT_BARS * 60_000)]));
    const bars = m.candles("BTC-USD", "1m") ?? [];
    expect(bars).toHaveLength(MAX_SNAPSHOT_BARS);
    expect(bars[0]?.t).toBe(60_000);
    expect(bars.at(-1)?.t).toBe(MAX_SNAPSHOT_BARS * 60_000);

    const big: Bar[] = [];
    mergeBars(big, Array.from({ length: 600 }, (_, i) => bar(i)));
    expect(big).toHaveLength(MAX_SNAPSHOT_BARS);
    expect(big[0]?.t).toBe(100);
  });

  test("dropCandles forgets one key only", () => {
    const m = new MarketState();
    m.apply(candle(true, [bar(0)]));
    m.apply(candle(true, [bar(0)], "ETH-USD"));
    m.dropCandles("BTC-USD", "1m");
    expect(m.candles("BTC-USD", "1m")).toBeNull();
    expect(m.candles("ETH-USD", "1m")).toEqual([bar(0)]);
    m.apply(candle(false, [bar(60_000)])); // live after the drop: not cached
    expect(m.candles("BTC-USD", "1m")).toBeNull();
  });
});

test("clear forgets trades, books, and candles (engine restart, Req 15.7)", () => {
  const m = new MarketState();
  m.apply(TRADE);
  m.apply(BOOK);
  m.apply(candle(true, [bar(0)]));
  m.clear();
  expect(m.quote("BTC-USD")).toBeNull();
  expect(m.candles("BTC-USD", "1m")).toBeNull();
  m.apply(candle(false, [bar(60_000)])); // a fresh snapshot is needed first
  expect(m.candles("BTC-USD", "1m")).toBeNull();
});
