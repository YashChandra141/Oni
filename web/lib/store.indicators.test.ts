// Indicator state in the Web UI store (Task 9.3, Req 26.3, 26.4).
import { beforeEach, describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { IndicatorValues, ServerMessage } from "../../shared/protocol/index";
import { bucketStartMs } from "./chartData";
import { MAX_INDICATOR_POINTS, indicatorLineData, type IndicatorPoint } from "./indicatorData";
import {
  applyEvent,
  applyServerMessage,
  candleKey,
  initialState,
  mergeIndicatorPoint,
  useTerminalStore,
  withIndicatorToggled,
} from "./store";

const EMPTY: IndicatorValues = {
  ema: null,
  sma: null,
  vwap: null,
  bb_upper: null,
  bb_mid: null,
  bb_lower: null,
  rsi: null,
  atr: null,
};

function pt(t: number, ema: number | null = null): IndicatorPoint {
  return { t, values: { ...EMPTY, ema } };
}

function indicators(
  symbol: string,
  timeframe: "1m" | "5m",
  ts: number,
  values: Partial<IndicatorValues>,
): ServerMessage {
  return {
    type: "event",
    event: { type: "indicators", venue: "replay", symbol, timeframe, ts, values: { ...EMPTY, ...values } },
  };
}

const times = (list: readonly IndicatorPoint[] | undefined): number[] => (list ?? []).map((p) => p.t);

describe("mergeIndicatorPoint", () => {
  test("appends a newer point", () => {
    expect(times(mergeIndicatorPoint([pt(1), pt(2)], pt(3)))).toEqual([1, 2, 3]);
  });

  test("replaces the point with the same t", () => {
    const merged = mergeIndicatorPoint([pt(1, 10), pt(2, 20)], pt(2, 25));
    expect(times(merged)).toEqual([1, 2]);
    expect(merged[1]?.values.ema).toBe(25);
    const first = mergeIndicatorPoint([pt(1, 10), pt(2, 20)], pt(1, 11));
    expect(first[0]?.values.ema).toBe(11);
  });

  test("inserts an older point in time order", () => {
    expect(times(mergeIndicatorPoint([pt(1), pt(3)], pt(2)))).toEqual([1, 2, 3]);
    expect(times(mergeIndicatorPoint([pt(2), pt(3)], pt(1)))).toEqual([1, 2, 3]);
    expect(times(mergeIndicatorPoint([], pt(5)))).toEqual([5]);
  });

  test("keeps at most MAX_INDICATOR_POINTS, dropping the oldest", () => {
    let list: readonly IndicatorPoint[] = [];
    for (let t = 0; t < MAX_INDICATOR_POINTS + 10; t += 1) list = mergeIndicatorPoint(list, pt(t));
    expect(list.length).toBe(MAX_INDICATOR_POINTS);
    expect(list[0]?.t).toBe(10);
    expect(list[list.length - 1]?.t).toBe(MAX_INDICATOR_POINTS + 9);
  });

  test("does not modify the input list", () => {
    const input = [pt(1, 1), pt(2, 2)];
    mergeIndicatorPoint(input, pt(2, 3));
    expect(input[1]?.values.ema).toBe(2);
  });
});

describe("indicators events", () => {
  test("are stored by symbol|timeframe", () => {
    let state = applyServerMessage(initialState(), indicators("BTC-USD", "1m", 60_000, { ema: 1.5, rsi: 50 }));
    state = applyServerMessage(state, indicators("ETH-USD", "5m", 300_000, { atr: 7 }));
    expect(state.indicators[candleKey("BTC-USD", "1m")]).toEqual([
      { t: 60_000, values: { ...EMPTY, ema: 1.5, rsi: 50 } },
    ]);
    expect(times(state.indicators[candleKey("ETH-USD", "5m")])).toEqual([300_000]);
    expect(state.indicators[candleKey("BTC-USD", "5m")]).toBeUndefined();
  });

  test("an update for the forming bar replaces its values", () => {
    let state = applyServerMessage(initialState(), indicators("BTC-USD", "1m", 60_000, { ema: 1 }));
    state = applyServerMessage(state, indicators("BTC-USD", "1m", 60_000, { ema: 2 }));
    state = applyServerMessage(state, indicators("BTC-USD", "1m", 120_000, { ema: 3 }));
    const list = state.indicators[candleKey("BTC-USD", "1m")];
    expect(list?.map((p) => p.values.ema)).toEqual([2, 3]);
  });

  test("an event with a non-finite ts is ignored", () => {
    const state = initialState();
    const next = applyEvent(state, {
      type: "indicators",
      venue: "replay",
      symbol: "BTC-USD",
      timeframe: "1m",
      ts: Number.NaN,
      values: EMPTY,
    });
    expect(next).toBe(state);
  });
});

describe("indicator toggles", () => {
  test("defaults: EMA, VWAP, RSI on; Bollinger and ATR off", () => {
    expect(initialState().indicatorToggles).toEqual({
      ema: true,
      vwap: true,
      bollinger: false,
      rsi: true,
      atr: false,
    });
  });

  test("withIndicatorToggled flips one toggle only", () => {
    const state = withIndicatorToggled(initialState(), "bollinger");
    expect(state.indicatorToggles.bollinger).toBe(true);
    expect(state.indicatorToggles.ema).toBe(true);
    expect(withIndicatorToggled(state, "bollinger").indicatorToggles.bollinger).toBe(false);
  });

  describe("store action", () => {
    beforeEach(() => {
      useTerminalStore.setState(initialState());
    });

    test("toggleIndicator flips the toggle in the store", () => {
      useTerminalStore.getState().toggleIndicator("rsi");
      expect(useTerminalStore.getState().indicatorToggles.rsi).toBe(false);
      useTerminalStore.getState().toggleIndicator("rsi");
      expect(useTerminalStore.getState().indicatorToggles.rsi).toBe(true);
    });
  });
});

// Bug condition exploration (chart-and-tape-fix Task 1.2). Expected to FAIL on unfixed code:
// the store keys indicator points by the trade time instead of the candle open time.
describe("Property 1: indicator points align to candle open times (web store)", () => {
  const TF_MS = { "1m": 60_000, "5m": 300_000 } as const;
  const bucketStartMs = (ts: number, tf: "1m" | "5m"): number => Math.floor(ts / TF_MS[tf]) * TF_MS[tf];
  const KEY = candleKey("BTC-USD", "1m");

  test("three Indicators events inside one minute leave one point at the minute start", () => {
    let state = initialState();
    for (const [i, ts] of [180_120, 185_700, 189_100].entries()) {
      state = applyServerMessage(state, indicators("BTC-USD", "1m", ts, { ema: i + 1 }));
    }
    const list = state.indicators[KEY] ?? [];
    expect(times(list)).toEqual([180_000]);
    expect(list[0]?.values.ema).toBe(3);
  });

  test("stored points are bucket-aligned, unique, ascending, capped, last event wins", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("1m" as const, "5m" as const),
        fc.array(fc.integer({ min: 0, max: 400 * 3_600_000 }), { minLength: 1, maxLength: 700 }),
        (tf, stamps) => {
          let state = initialState();
          stamps.forEach((ts, i) => {
            state = applyServerMessage(state, indicators("BTC-USD", tf, ts, { ema: i }));
          });
          const list = state.indicators[candleKey("BTC-USD", tf)] ?? [];
          const lastWins = new Map<number, number>();
          stamps.forEach((ts, i) => lastWins.set(bucketStartMs(ts, tf), i));
          const buckets = [...lastWins.keys()].sort((a, b) => a - b).slice(-MAX_INDICATOR_POINTS);
          expect(times(list)).toEqual(buckets);
          expect(list.length).toBeLessThanOrEqual(MAX_INDICATOR_POINTS);
          for (const p of list) expect(p.values.ema).toBe(lastWins.get(p.t) ?? null);
        },
      ),
      { numRuns: 100 },
    );
  });

  test("indicatorLineData times are open times of stored candles", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 3_600_000 }), { minLength: 1, maxLength: 60 }), (stamps) => {
        let state = initialState();
        const openTimes = new Set<number>();
        for (const ts of stamps) {
          const t = bucketStartMs(ts, "1m");
          openTimes.add(t);
          state = applyServerMessage(state, {
            type: "event",
            event: {
              type: "candle",
              venue: "replay",
              symbol: "BTC-USD",
              timeframe: "1m",
              snapshot: false,
              bars: [{ t, open: "100", high: "100", low: "100", close: "100", volume: "1" }],
            },
          } as ServerMessage);
          state = applyServerMessage(state, indicators("BTC-USD", "1m", ts, { ema: 1 }));
        }
        const stored = new Set((state.candles[KEY] ?? []).map((b) => b.t / 1000));
        const line = indicatorLineData(state.indicators[KEY] ?? [], "ema", 2);
        for (const p of line) expect(stored.has(p.time)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});

// Bug condition exploration (chart-and-tape-fix Task 1.5). Expected to FAIL on unfixed code:
// a candle snapshot replaces the bars but leaves the old indicator points in the store.
describe("Property 4: a candle snapshot replaces stored indicator points (web store)", () => {
  const MIN = 60_000;
  const KEY = candleKey("BTC-USD", "1m");
  const snapshotFrom = (startMin: number, count: number): ServerMessage =>
    ({
      type: "event",
      event: {
        type: "candle",
        venue: "replay",
        symbol: "BTC-USD",
        timeframe: "1m",
        snapshot: true,
        bars: Array.from({ length: count }, (_, i) => ({
          t: (startMin + i) * MIN,
          open: "100",
          high: "100",
          low: "100",
          close: "100",
          volume: "1",
        })),
      },
    }) as ServerMessage;

  test("points at t = 0..9 min do not survive a snapshot starting at 20 min", () => {
    let state = initialState();
    for (let m = 0; m < 10; m += 1) {
      state = applyServerMessage(state, indicators("BTC-USD", "1m", m * MIN, { ema: m }));
    }
    expect(times(state.indicators[KEY]).length).toBe(10);
    state = applyServerMessage(state, snapshotFrom(20, 5));
    const stale = times(state.indicators[KEY]).filter((t) => t < 20 * MIN);
    expect(stale).toEqual([]);
  });

  test("for any stored points, no point older than the snapshot's first bar remains", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 1, maxLength: 10 }),
        fc.integer({ min: 20, max: 60 }),
        (mins, startMin) => {
          let state = initialState();
          for (const m of mins) state = applyServerMessage(state, indicators("BTC-USD", "1m", m * MIN, { ema: m }));
          state = applyServerMessage(state, snapshotFrom(startMin, 3));
          expect(times(state.indicators[KEY]).filter((t) => t < startMin * MIN)).toEqual([]);
        },
      ),
      { numRuns: 50 },
    );
  });
});

// Task 6.4: Property 1 over all five timeframes, with chartData.bucketStartMs as the oracle.
// **Validates: Requirements 2.1, 2.2**
describe("Property 1 (all timeframes): indicator points align to candle open times", () => {
  const ALL_TFS = ["1m", "5m", "15m", "1h", "1d"] as const;
  type Tf = (typeof ALL_TFS)[number];
  const ev = (tf: Tf, ts: number, ema: number): ServerMessage => ({
    type: "event",
    event: { type: "indicators", venue: "replay", symbol: "BTC-USD", timeframe: tf, ts, values: { ...EMPTY, ema } },
  });

  test("one point per bucket, strictly ascending, at most 500, last values win", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_TFS),
        fc.array(fc.integer({ min: 0, max: 2_000 * 86_400_000 }), { minLength: 1, maxLength: 700 }),
        (tf, stamps) => {
          let state = initialState();
          stamps.forEach((ts, i) => {
            state = applyServerMessage(state, ev(tf, ts, i));
          });
          const list = state.indicators[candleKey("BTC-USD", tf)] ?? [];
          const lastWins = new Map<number, number>();
          stamps.forEach((ts, i) => lastWins.set(bucketStartMs(ts, tf), i));
          const expected = [...lastWins.keys()].sort((a, b) => a - b).slice(-MAX_INDICATOR_POINTS);
          expect(times(list)).toEqual(expected);
          expect(list.length).toBeLessThanOrEqual(MAX_INDICATOR_POINTS);
          for (let i = 1; i < list.length; i += 1) expect(list[i]!.t).toBeGreaterThan(list[i - 1]!.t);
          for (const p of list) expect(p.values.ema).toBe(lastWins.get(p.t) ?? null);
        },
      ),
      { numRuns: 100 },
    );
  });

  test("indicatorLineData with candleTimesMs returns only times in the candle set", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 100_000 }), { minLength: 1, maxLength: 60 }),
        fc.array(fc.integer({ min: 0, max: 100_000 }), { maxLength: 60 }),
        (pointSecs, candleSecs) => {
          const points = pointSecs.map((s, i) => pt(s * 1000, i));
          const candleTimesMs = new Set(candleSecs.map((s) => s * 1000));
          const line = indicatorLineData(points, "ema", 2, candleTimesMs);
          const allowed = new Set([...candleTimesMs].map((ms) => ms / 1000));
          for (const p of line) expect(allowed.has(p.time)).toBe(true);
          for (let i = 1; i < line.length; i += 1) expect(line[i]!.time).toBeGreaterThan(line[i - 1]!.time);
        },
      ),
      { numRuns: 100 },
    );
  });

  test("non-finite or negative ts values are ignored", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_TFS),
        fc.constantFrom(Number.NaN, Infinity, -Infinity, -1, -60_000, -1e12),
        fc.array(fc.integer({ min: 0, max: 1_000_000_000 }), { maxLength: 10 }),
        (tf, bad, goodStamps) => {
          let state = initialState();
          for (const ts of goodStamps) state = applyServerMessage(state, ev(tf, ts, 1));
          const before = state;
          state = applyServerMessage(state, ev(tf, bad, 99));
          expect(state.indicators).toEqual(before.indicators);
        },
      ),
      { numRuns: 100 },
    );
  });
});
