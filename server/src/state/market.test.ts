// MarketState: last trade, top of book, and the candle cache (design §3 state/market.ts,
// Req 8.7, 9.6, 9.8, 15.7, 24.2, 24.3).
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { Bar, Event, IndicatorPoint, IndicatorValues } from "../protocol.ts";
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

  describe("indicator points (chart-and-tape-fix, Req 2.6, 2.7, 3.14)", () => {
    const vals = (n: number) => ({
      ema: n, sma: n, vwap: n, bb_upper: n, bb_mid: n, bb_lower: n, rsi: n, atr: n,
    });
    const withPoints = (bars: Bar[], indicators: { t: number; values: ReturnType<typeof vals> }[]): CandleEvent => ({
      ...candle(true, bars),
      indicators,
    });
    const live = (ts: number, n: number): Event => ({
      type: "indicators",
      symbol: "BTC-USD",
      timeframe: "1m",
      ts,
      values: vals(n),
    });

    test("a snapshot sets normalized points: sorted, deduped (last wins), newest 500", () => {
      const m = new MarketState();
      m.apply(withPoints([bar(0)], [{ t: 60_000, values: vals(2) }, { t: 0, values: vals(1) }, { t: 60_000, values: vals(3) }]));
      expect(m.snapshot("BTC-USD", "1m")?.indicators).toEqual([
        { t: 0, values: vals(1) },
        { t: 60_000, values: vals(3) },
      ]);

      const many = Array.from({ length: 600 }, (_, i) => ({ t: i * 60_000, values: vals(i) }));
      m.apply(withPoints([bar(0)], many));
      const pts = m.snapshot("BTC-USD", "1m")?.indicators ?? [];
      expect(pts).toHaveLength(MAX_SNAPSHOT_BARS);
      expect(pts[0]?.t).toBe(100 * 60_000);
      expect(pts[499]?.t).toBe(599 * 60_000);
    });

    test("a live event floors its ts to the bucket and merges, replacing an equal t", () => {
      const m = new MarketState();
      m.apply(withPoints([bar(0)], [{ t: 0, values: vals(1) }]));
      m.apply(live(60_000 + 17_345, 2));
      m.apply(live(60_000 + 59_999, 3)); // same bucket: replaces
      expect(m.snapshot("BTC-USD", "1m")?.indicators).toEqual([
        { t: 0, values: vals(1) },
        { t: 60_000, values: vals(3) },
      ]);
    });

    test("a live event before any snapshot is ignored", () => {
      const m = new MarketState();
      m.apply(live(0, 1));
      expect(m.snapshot("BTC-USD", "1m")).toBeNull();
      m.apply(candle(true, [bar(0)]));
      expect(m.snapshot("BTC-USD", "1m")?.indicators ?? []).toEqual([]);
    });

    test("a new snapshot replaces earlier points", () => {
      const m = new MarketState();
      m.apply(withPoints([bar(0)], [{ t: 0, values: vals(1) }]));
      m.apply(live(60_000, 2));
      m.apply(withPoints([bar(0)], [{ t: 120_000, values: vals(9) }]));
      expect(m.snapshot("BTC-USD", "1m")?.indicators).toEqual([{ t: 120_000, values: vals(9) }]);
    });

    test("clear and dropCandles drop the points", () => {
      const m = new MarketState();
      m.apply(withPoints([bar(0)], [{ t: 0, values: vals(1) }]));
      m.dropCandles("BTC-USD", "1m");
      m.apply(live(60_000, 2)); // no snapshot any more: ignored
      m.apply(candle(true, [bar(0)]));
      expect(m.snapshot("BTC-USD", "1m")?.indicators ?? []).toEqual([]);

      m.apply(withPoints([bar(0)], [{ t: 0, values: vals(1) }]));
      m.clear();
      expect(m.snapshot("BTC-USD", "1m")).toBeNull();
      m.apply(candle(true, [bar(0)]));
      expect(m.snapshot("BTC-USD", "1m")?.indicators ?? []).toEqual([]);
    });
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

// Property 4 (chart-and-tape-fix, Req 2.6, 2.7): the server cache and the web store agree after
// the same events. The reference model below mirrors the rules in web/lib/store.ts (the server
// must not import from web/):
//  - a snapshot replaces the bars and the indicator points (sorted, deduped by t with the last
//    winning, newest 500);
//  - a live bar merges by t (same t replaces, newer appends), newest 500;
//  - a live indicator point floors its ts to the bucket start and merges by t, newest 500.
// Intentional differences, so the model follows the server's documented rule:
//  - the server ignores live bars and live indicator points before any snapshot; the web store
//    keeps them;
//  - the server does not floor or sort snapshot bars/points; the web store does. Engine snapshots
//    are ascending and bucket-aligned, so the generators produce bar sets that way (points are
//    bucket-aligned but unsorted and duplicated, which both sides normalize);
//  - live bars never go back before the newest cached bar (the server appends, the web store
//    would insert in order).
describe("server cache agrees with the web store model (Property 4)", () => {
  const MIN = 60_000;
  type Pt = IndicatorPoint;
  // Unique value tag goes in `ema`; the other fields are null.
  const vals = (n: number): IndicatorValues => ({
    ema: n, sma: null, vwap: null, bb_upper: null, bb_mid: null, bb_lower: null, rsi: null, atr: null,
  });
  const tail = <T,>(xs: T[], max: number): T[] => (xs.length > max ? xs.slice(xs.length - max) : xs);
  const normalize = (pts: Pt[]): Pt[] => {
    const byT = new Map<number, Pt>();
    for (const p of pts) byT.set(p.t, p);
    return tail([...byT.values()].sort((a, b) => a.t - b.t), 500);
  };

  type Op =
    | { k: "snapshot"; barIdx: number[]; ptIdx: number[] }
    | { k: "bar"; step: number }
    | { k: "ind"; bucket: number; offset: number }
    | { k: "clear" };

  const opArb: fc.Arbitrary<Op> = fc.oneof(
    {
      weight: 2,
      arbitrary: fc.record({
        k: fc.constant("snapshot" as const),
        barIdx: fc.uniqueArray(fc.integer({ min: 0, max: 700 }), { maxLength: 600 }).map((a) => a.sort((x, y) => x - y)),
        ptIdx: fc.array(fc.integer({ min: 0, max: 700 }), { maxLength: 600 }),
      }),
    },
    { weight: 4, arbitrary: fc.record({ k: fc.constant("bar" as const), step: fc.integer({ min: 0, max: 1 }) }) },
    {
      weight: 4,
      arbitrary: fc.record({
        k: fc.constant("ind" as const),
        bucket: fc.integer({ min: 0, max: 800 }),
        offset: fc.integer({ min: 0, max: MIN - 1 }),
      }),
    },
    { weight: 1, arbitrary: fc.record({ k: fc.constant("clear" as const) }) },
  );

  test("same bars and indicator points after random Candle and Indicators events", () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 40 }), (ops) => {
        const m = new MarketState();
        let bars: Bar[] | null = null; // model
        let pts: Pt[] = [];
        let n = 0; // unique value tag, so "last wins" is observable
        for (const op of ops) {
          n += 1;
          if (op.k === "snapshot") {
            const b = op.barIdx.map((i) => bar(i * MIN, String(n)));
            const p = op.ptIdx.map((i) => ({ t: i * MIN, values: vals(n) }));
            m.apply({ ...candle(true, b), indicators: p });
            bars = tail(b, 500);
            pts = normalize(p);
          } else if (op.k === "bar") {
            const last = bars?.at(-1)?.t ?? 0;
            const b = bar(last + op.step * MIN, String(n));
            m.apply(candle(false, [b]));
            if (bars !== null) {
              const i = bars.findIndex((x) => x.t === b.t);
              if (i >= 0) bars[i] = b;
              else bars = tail([...bars, b], 500);
            }
          } else if (op.k === "ind") {
            const ts = op.bucket * MIN + op.offset;
            m.apply({ type: "indicators", symbol: "BTC-USD", timeframe: "1m", ts, values: vals(n) });
            if (bars !== null) pts = normalize([...pts, { t: op.bucket * MIN, values: vals(n) }]);
          } else {
            m.clear();
            bars = null;
            pts = [];
          }
          const snap = m.snapshot("BTC-USD", "1m");
          if (bars === null) {
            expect(snap).toBeNull();
          } else {
            expect(snap?.bars).toEqual(bars);
            expect(snap?.indicators ?? []).toEqual(pts);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  test("a snapshot replaces all earlier points, and clear drops them", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 700 }), { maxLength: 30 }),
        fc.array(fc.integer({ min: 0, max: 700 }), { maxLength: 30 }),
        (first, second) => {
          const m = new MarketState();
          const pts = (idx: number[], n: number): Pt[] => idx.map((i) => ({ t: i * MIN, values: vals(n) }));
          m.apply({ ...candle(true, [bar(0)]), indicators: pts(first, 1) });
          m.apply({ type: "indicators", symbol: "BTC-USD", timeframe: "1m", ts: 5 * MIN, values: vals(2) });
          m.apply({ ...candle(true, [bar(0)]), indicators: pts(second, 3) });
          expect(m.snapshot("BTC-USD", "1m")?.indicators ?? []).toEqual(normalize(pts(second, 3)));
          m.clear();
          expect(m.snapshot("BTC-USD", "1m")).toBeNull();
          m.apply(candle(true, [bar(0)]));
          expect(m.snapshot("BTC-USD", "1m")?.indicators ?? []).toEqual([]);
        },
      ),
      { numRuns: 100 },
    );
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
