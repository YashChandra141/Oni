// Pure chart data helpers (Task 5.4, Req 25.1-25.3). Prices and volumes are converted with
// BigInt scaling; the JS numbers are display-only.
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { Bar, IndicatorValues, ServerMessage } from "../../shared/protocol/index";
import { applyServerMessage, candleKey, initialState } from "./store";
import {
  indicatorLineData,
  indicatorLineUpdates,
  type IndicatorLineGap,
  type IndicatorLinePoint,
} from "./indicatorData";
import {
  CHART_THEME,
  type CandlePoint,
  type ChartSyncState,
  type VolumePoint,
  barsToCandles,
  barsToVolume,
  formatDisplayNumber,
  chartSyncState,
  isTimeframe,
  planChartSync,
  priceFormatFor,
  readOhlc,
  readValue,
  shouldReposition,
  timeframeFromKey,
  timeframeLabels,
  unitsToNumber,
} from "./chartData";

function bar(t: number, open: string, high: string, low: string, close: string, volume = "100000000"): Bar {
  return { t, open, high, low, close, volume };
}

describe("unitsToNumber", () => {
  test("scales by the decimals exactly", () => {
    expect(unitsToNumber("6400012", 2)).toBe(64000.12);
    expect(unitsToNumber("5", 2)).toBe(0.05);
    expect(unitsToNumber("0", 2)).toBe(0);
    expect(unitsToNumber("150000000", 8)).toBe(1.5);
    expect(unitsToNumber("-5", 2)).toBe(-0.05);
  });

  test("a value above 2^53 keeps its digits through BigInt scaling", () => {
    expect(unitsToNumber("9007199254740993", 2)).toBe(Number("90071992547409.93"));
  });

  test("malformed input gives null", () => {
    expect(unitsToNumber("abc", 2)).toBeNull();
    expect(unitsToNumber("1.5", 2)).toBeNull();
    expect(unitsToNumber("", 2)).toBeNull();
    expect(unitsToNumber("100", -1)).toBeNull();
  });
});

describe("barsToCandles", () => {
  test("converts ms to whole UTC seconds and ticks to prices", () => {
    const candles = barsToCandles([bar(1_700_000_000_999, "6400000", "6410050", "6395025", "6405075")], 2);
    expect(candles.map((c) => ({ ...c, time: c.time as number }))).toEqual([
      { time: 1_700_000_000, open: 64000, high: 64100.5, low: 63950.25, close: 64050.75 },
    ]);
  });

  test("orders by time", () => {
    const candles = barsToCandles(
      [
        bar(180_000, "300", "300", "300", "300"),
        bar(60_000, "100", "100", "100", "100"),
        bar(120_000, "200", "200", "200", "200"),
      ],
      2,
    );
    expect(candles.map((c) => c.time as number)).toEqual([60, 120, 180]);
    expect(candles.map((c) => c.close)).toEqual([1, 2, 3]);
  });

  test("keeps the last of bars with equal times", () => {
    const candles = barsToCandles(
      [bar(60_000, "100", "100", "100", "100"), bar(60_000, "100", "150", "100", "150")],
      2,
    );
    expect(candles).toHaveLength(1);
    expect(candles[0]?.close).toBe(1.5);
  });

  test("skips a bar with a malformed field or time", () => {
    const candles = barsToCandles(
      [
        bar(60_000, "100", "100", "100", "100"),
        bar(120_000, "oops", "100", "100", "100"),
        bar(Number.NaN, "100", "100", "100", "100"),
        bar(-1, "100", "100", "100", "100"),
      ],
      2,
    );
    expect(candles.map((c) => c.time as number)).toEqual([60]);
  });

  test("empty input gives empty output", () => {
    expect(barsToCandles([], 2)).toEqual([]);
  });

  test("every candle keeps low <= open, close <= high when the input does", () => {
    const candles = barsToCandles(
      [bar(60_000, "100", "120", "90", "110"), bar(120_000, "110", "110", "80", "85")],
      2,
    );
    for (const c of candles) {
      expect(c.low).toBeLessThanOrEqual(c.open);
      expect(c.low).toBeLessThanOrEqual(c.close);
      expect(c.high).toBeGreaterThanOrEqual(c.open);
      expect(c.high).toBeGreaterThanOrEqual(c.close);
    }
  });
});

describe("barsToVolume", () => {
  test("colours by close against open, with equal counting as up", () => {
    const volume = barsToVolume(
      [
        bar(60_000, "100", "120", "90", "110", "150000000"),
        bar(120_000, "110", "110", "80", "85", "200000000"),
        bar(180_000, "100", "100", "100", "100", "50000000"),
      ],
      8,
    );
    expect(volume.map((v) => v.color)).toEqual([
      CHART_THEME.volumeUp,
      CHART_THEME.volumeDown,
      CHART_THEME.volumeUp,
    ]);
    expect(volume.map((v) => v.value)).toEqual([1.5, 2, 0.5]);
    expect(volume.map((v) => v.time as number)).toEqual([60, 120, 180]);
  });

  test("compares open and close as integers, not as text", () => {
    // "9" > "10" as text, but 9 < 10 as numbers.
    const [point] = barsToVolume([bar(60_000, "9", "10", "9", "10")], 8);
    expect(point?.color).toBe(CHART_THEME.volumeUp);
  });

  test("orders, de-duplicates, and skips malformed bars like the candles", () => {
    const volume = barsToVolume(
      [
        bar(120_000, "1", "1", "1", "1", "200000000"),
        bar(60_000, "1", "1", "1", "1", "100000000"),
        bar(60_000, "1", "1", "1", "1", "300000000"),
        bar(180_000, "1", "1", "1", "1", "not-a-number"),
      ],
      8,
    );
    expect(volume.map((v) => [v.time as number, v.value])).toEqual([
      [60, 3],
      [120, 2],
    ]);
  });

  test("skips a volume bar whose open or close is malformed", () => {
    const volume = barsToVolume(
      [
        bar(60_000, "1x", "1", "1", "1", "100000000"),
        bar(120_000, "1", "1", "1", "2.5", "100000000"),
        bar(180_000, "1", "1", "1", "1", "100000000"),
      ],
      8,
    );
    expect(volume.map((v) => v.time as number)).toEqual([180]);
  });

  test("empty input gives empty volume", () => {
    expect(barsToVolume([], 8)).toEqual([]);
  });
});

describe("timeframes", () => {
  test("labels are in button order", () => {
    expect([...timeframeLabels]).toEqual(["1m", "5m", "15m", "1h", "4h", "1d"]);
  });

  test("keys 1 to 6 select the timeframe at that position (Req 25.3)", () => {
    expect(["1", "2", "3", "4", "5", "6"].map((k) => timeframeFromKey(k))).toEqual([
      "1m",
      "5m",
      "15m",
      "1h",
      "4h",
      "1d",
    ]);
  });

  test("other keys select nothing", () => {
    for (const key of ["0", "7", "9", "a", "", "11", "+", "Enter"]) {
      expect(timeframeFromKey(key)).toBeNull();
    }
  });

  test("isTimeframe accepts exactly the six labels", () => {
    for (const tf of timeframeLabels) expect(isTimeframe(tf)).toBe(true);
    for (const other of ["1s", "2h", "1M", "", "1m "]) expect(isTimeframe(other)).toBe(false);
  });
});

describe("priceFormatFor", () => {
  test("derives precision and minMove from the decimals", () => {
    expect(priceFormatFor(2)).toEqual({ type: "price", precision: 2, minMove: 0.01 });
    expect(priceFormatFor(0)).toEqual({ type: "price", precision: 0, minMove: 1 });
    expect(priceFormatFor(1)).toEqual({ type: "price", precision: 1, minMove: 0.1 });
    expect(priceFormatFor(8)).toEqual({ type: "price", precision: 8, minMove: 0.00000001 });
  });

  test("an invalid decimals value falls back to 2", () => {
    for (const bad of [-1, 1.5, 9, Number.NaN]) {
      expect(priceFormatFor(bad)).toEqual({ type: "price", precision: 2, minMove: 0.01 });
    }
  });
});

describe("formatting", () => {
  // formatChartTime moved to ./timeFormat (local time display); see timeFormat.test.ts.

  test("formatDisplayNumber uses fixed decimals", () => {
    expect(formatDisplayNumber(1.5, 2)).toBe("1.50");
    expect(formatDisplayNumber(64000.126, 2)).toBe("64000.13");
    expect(formatDisplayNumber(3, 0)).toBe("3");
    expect(formatDisplayNumber(Number.NaN, 2)).toBe("—");
  });
});

describe("planChartSync", () => {
  // Bars with start times `times` (ms); only `t` matters for the plan.
  const bars = (...times: number[]) => times.map((t) => bar(t, "1", "1", "1", "1"));
  const input = (key: string, snapshot: number, rewrite: number, ...times: number[]) => ({
    key,
    snapshot,
    rewrite,
    bars: bars(...times),
  });
  const stateOf = (key: string, snapshot: number, rewrite: number, ...times: number[]) =>
    chartSyncState(input(key, snapshot, rewrite, ...times));
  const updateTimes = (plan: ReturnType<typeof planChartSync>) =>
    plan.kind === "update" ? plan.bars.map((b) => b.t) : null;

  test("the first data is a full set", () => {
    expect(planChartSync(null, input("k", 0, 0, 1, 2, 3)).kind).toBe("set");
  });

  test("a change in the last bar only is an update with only that bar", () => {
    const prev = stateOf("k", 0, 0, 1, 2, 3);
    expect(updateTimes(planChartSync(prev, input("k", 0, 0, 1, 2, 3)))).toEqual([3]);
  });

  test("a new bar (count changed) is an update with only that bar", () => {
    // Replaces "a new bar (count changed) is a full set", which pinned the bug.
    const prev = stateOf("k", 0, 0, 1, 2, 3);
    expect(updateTimes(planChartSync(prev, input("k", 0, 0, 1, 2, 3, 4)))).toEqual([3, 4]);
  });

  test("a different view key is a full set", () => {
    const prev = stateOf("k", 0, 0, 1, 2, 3);
    expect(planChartSync(prev, input("other", 0, 0, 1, 2, 3)).kind).toBe("set");
  });

  test("a changed snapshot counter is a full set, even with the same bars", () => {
    const prev = stateOf("k", 0, 0, 1, 2, 3);
    expect(planChartSync(prev, input("k", 1, 0, 1, 2, 3)).kind).toBe("set");
  });

  test("a changed rewrite counter is a full set", () => {
    const prev = stateOf("k", 0, 0, 1, 2, 3);
    expect(planChartSync(prev, input("k", 0, 1, 1, 2, 3)).kind).toBe("set");
  });

  test("a history trim with unchanged counters still updates only the tail", () => {
    const prev = stateOf("k", 0, 0, 1, 2, 3);
    expect(updateTimes(planChartSync(prev, input("k", 0, 0, 2, 3, 4)))).toEqual([3, 4]);
  });

  test("empty data, or an empty previous state, is a full set", () => {
    expect(planChartSync(stateOf("k", 0, 0), input("k", 0, 0)).kind).toBe("set");
    expect(planChartSync(stateOf("k", 0, 0, 1), input("k", 0, 0)).kind).toBe("set");
    expect(planChartSync(stateOf("k", 0, 0), input("k", 0, 0, 1)).kind).toBe("set");
  });

  test("a newest bar older than the previous last bar is a full set", () => {
    const prev = stateOf("k", 0, 0, 1, 2, 3);
    expect(planChartSync(prev, input("k", 0, 0, 1, 2)).kind).toBe("set");
  });

  test("chartSyncState records the key, counters, and newest bar time", () => {
    expect(stateOf("k", 2, 3, 1, 5)).toEqual({ key: "k", snapshot: 2, rewrite: 3, lastTime: 5 });
    expect(stateOf("k", 0, 0)).toEqual({ key: "k", snapshot: 0, rewrite: 0, lastTime: null });
  });
});

// Task 1.6, Property 5 (bug condition: changed_bar.t >= newest(stored_bars).t, Req 1.7, 2.8).
// Expected behavior (design.md): a live change at or after the newest stored bar is applied as an
// `update` that carries exactly the changed bar(s), never a full `setData`. Ported to
// planChartSync in task 7.1 with the stronger assertion on the carried bars.
describe("Property 5: incremental chart updates (exploration)", () => {
  const bars = (...times: number[]) => times.map((t) => bar(t, "1", "1", "1", "1"));
  const input = (key: string, ...times: number[]) => ({ key, snapshot: 0, rewrite: 0, bars: bars(...times) });
  const stateOf = (key: string, ...times: number[]) => chartSyncState(input(key, ...times));

  test("a stored list that gained one newer bar is an update, not a full set", () => {
    const prev = stateOf("BTC-USD|1m", 60, 120, 180);
    const plan = planChartSync(prev, input("BTC-USD|1m", 60, 120, 180, 240));
    expect(plan.kind).toBe("update");
    // The update re-sends the previous forming bar (180) and the new bar (240), nothing older.
    expect(plan.kind === "update" ? plan.bars.map((b) => b.t) : null).toEqual([180, 240]);
  });

  test("a change to the forming (last) bar is an update", () => {
    const prev = stateOf("BTC-USD|1m", 60, 120, 180);
    const plan = planChartSync(prev, input("BTC-USD|1m", 60, 120, 180));
    expect(plan.kind).toBe("update");
    expect(plan.kind === "update" ? plan.bars.map((b) => b.t) : null).toEqual([180]);
  });

  test("for any list, appending one newer bar is an update of exactly the old last and new bar", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 0, max: 1_000_000 }), { minLength: 1, maxLength: 50 }),
        fc.integer({ min: 1, max: 1000 }),
        (rawTimes, gap) => {
          const times = [...rawTimes].sort((a, b) => a - b);
          const newest = times[times.length - 1] ?? 0;
          const prev = stateOf("k", ...times);
          const plan = planChartSync(prev, input("k", ...times, newest + gap));
          expect(plan.kind).toBe("update");
          expect(plan.kind === "update" ? plan.bars.map((b) => b.t) : null).toEqual([newest, newest + gap]);
        },
      ),
    );
  });

  test("for any list, a change only to the forming bar is an update of exactly that bar", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 0, max: 1_000_000 }), { minLength: 1, maxLength: 50 }),
        (rawTimes) => {
          const times = [...rawTimes].sort((a, b) => a - b);
          const newest = times[times.length - 1] ?? 0;
          const prev = stateOf("k", ...times);
          const plan = planChartSync(prev, input("k", ...times));
          expect(plan.kind).toBe("update");
          expect(plan.kind === "update" ? plan.bars.map((b) => b.t) : null).toEqual([newest]);
        },
      ),
    );
  });
});

describe("crosshair readers", () => {
  test("readOhlc reads the four numbers", () => {
    expect(readOhlc({ time: 1, open: 1, high: 3, low: 0.5, close: 2 })).toEqual({
      open: 1,
      high: 3,
      low: 0.5,
      close: 2,
    });
  });

  test("readOhlc rejects missing fields and non-objects", () => {
    expect(readOhlc({ time: 1, value: 5 })).toBeNull();
    expect(readOhlc({ open: "1", high: 1, low: 1, close: 1 })).toBeNull();
    expect(readOhlc(null)).toBeNull();
    expect(readOhlc(undefined)).toBeNull();
    expect(readOhlc(5)).toBeNull();
  });

  test("readValue reads a histogram value", () => {
    expect(readValue({ time: 1, value: 2.5 })).toBe(2.5);
    expect(readValue({ time: 1 })).toBeNull();
    expect(readValue(undefined)).toBeNull();
  });
});

// Task 7.3, Property 5 (Req 2.8): applying the sync plans to a series that behaves like Lightweight
// Charts leaves it equal to a full setData of the stored bars.
describe("Property 5: incremental chart updates equal a full setData", () => {
  const MIN = 60_000;
  const SYMBOL = "BTC-USD";
  const PRICE_DECIMALS = 2;
  const QTY_DECIMALS = 8;
  const STORE_KEY = candleKey("replay", SYMBOL, "1m");
  const NULLS: IndicatorValues = {
    ema: null,
    sma: null,
    vwap: null,
    bb_upper: null,
    bb_mid: null,
    bb_lower: null,
    rsi: null,
    atr: null,
  };

  /** A series that applies setData and update the way Lightweight Charts does. */
  class ModelSeries<T extends { readonly time: number }> {
    data: T[] = [];
    setData(items: readonly T[]): void {
      for (let i = 1; i < items.length; i += 1) {
        if ((items[i]?.time ?? 0) <= (items[i - 1]?.time ?? 0)) throw new Error("setData: not ascending");
      }
      this.data = items.slice();
    }
    update(item: T): void {
      const last = this.data[this.data.length - 1];
      if (last === undefined || item.time > last.time) this.data.push(item);
      else if (item.time === last.time) this.data[this.data.length - 1] = item;
      else throw new Error("update: time older than the last point");
    }
  }

  /** Line series: an update of a gap (whitespace) clears the point at that time, or adds nothing. */
  class ModelLineSeries extends ModelSeries<IndicatorLinePoint> {
    updateItem(item: IndicatorLinePoint | IndicatorLineGap): void {
      if ("value" in item) {
        this.update(item);
        return;
      }
      const last = this.data[this.data.length - 1];
      if (last !== undefined && item.time === last.time) this.data.pop();
      else if (last !== undefined && item.time < last.time) throw new Error("update: time older than the last point");
    }
  }

  interface BarSpec {
    readonly open: number;
    readonly close: number;
    readonly spread: number;
    readonly volume: number;
  }
  type Op =
    | { readonly k: "snap"; readonly ks: number[]; readonly specs: BarSpec[]; readonly ind: number[] }
    | { readonly k: "forming"; readonly spec: BarSpec }
    | { readonly k: "newBar"; readonly gap: number; readonly spec: BarSpec }
    | { readonly k: "late"; readonly back: number; readonly spec: BarSpec }
    | { readonly k: "ind"; readonly ahead: 0 | 1; readonly offset: number; readonly ema: number | null };

  const specArb: fc.Arbitrary<BarSpec> = fc.record({
    open: fc.integer({ min: 1, max: 1000 }),
    close: fc.integer({ min: 1, max: 1000 }),
    spread: fc.integer({ min: 0, max: 50 }),
    volume: fc.integer({ min: 0, max: 100_000 }),
  });
  const emaArb = fc.option(fc.integer({ min: 1, max: 100_000 }), { nil: null });
  const opArb: fc.Arbitrary<Op> = fc.oneof(
    {
      weight: 1,
      arbitrary: fc.record({
        k: fc.constant("snap" as const),
        ks: fc.uniqueArray(fc.integer({ min: 0, max: 40 }), { maxLength: 12 }),
        specs: fc.array(specArb, { minLength: 12, maxLength: 12 }),
        ind: fc.array(fc.integer({ min: 1, max: 100_000 }), { minLength: 12, maxLength: 12 }),
      }),
    },
    { weight: 4, arbitrary: fc.record({ k: fc.constant("forming" as const), spec: specArb }) },
    {
      weight: 4,
      arbitrary: fc.record({
        k: fc.constant("newBar" as const),
        gap: fc.integer({ min: 1, max: 3 }),
        spec: specArb,
      }),
    },
    {
      weight: 1,
      arbitrary: fc.record({
        k: fc.constant("late" as const),
        back: fc.integer({ min: 1, max: 5 }),
        spec: specArb,
      }),
    },
    {
      weight: 4,
      arbitrary: fc.record({
        k: fc.constant("ind" as const),
        ahead: fc.constantFrom(0 as const, 1 as const),
        offset: fc.integer({ min: 0, max: MIN - 1 }),
        ema: emaArb,
      }),
    },
  );

  function barOf(t: number, s: BarSpec): Bar {
    const high = Math.max(s.open, s.close) + s.spread;
    const low = Math.max(1, Math.min(s.open, s.close) - s.spread);
    return {
      t,
      open: String(s.open),
      high: String(high),
      low: String(low),
      close: String(s.close),
      volume: String(s.volume),
    };
  }

  const candleMessage = (snapshot: boolean, bars: Bar[], indicators?: unknown): ServerMessage =>
    ({
      type: "event",
      event: { type: "candle", venue: "replay", symbol: SYMBOL, timeframe: "1m", snapshot, bars, indicators },
    }) as unknown as ServerMessage;

  const indicatorsMessage = (ts: number, ema: number | null): ServerMessage => ({
    type: "event",
    event: { type: "indicators", venue: "replay", symbol: SYMBOL, timeframe: "1m", ts, values: { ...NULLS, ema } },
  });

  /** The store messages one op produces, given the current stored bars. */
  function messagesFor(op: Op, stored: readonly Bar[]): ServerMessage[] {
    const newest = stored[stored.length - 1];
    switch (op.k) {
      case "snap": {
        const bars = op.ks.map((k, i) => barOf(k * MIN, op.specs[i % op.specs.length] as BarSpec));
        const ind = op.ks.map((k, i) => ({
          t: k * MIN + 5,
          values: { ...NULLS, ema: op.ind[i % op.ind.length] ?? 1 },
        }));
        return [candleMessage(true, bars, ind)];
      }
      case "forming":
        return [candleMessage(false, [barOf(newest === undefined ? 0 : newest.t, op.spec)])];
      case "newBar":
        return [
          candleMessage(false, [barOf(newest === undefined ? op.gap * MIN : newest.t + op.gap * MIN, op.spec)]),
        ];
      case "late": {
        const newestK = newest === undefined ? 0 : newest.t / MIN;
        const k = Math.max(0, newestK - op.back);
        return [candleMessage(false, [barOf(k * MIN, op.spec)])];
      }
      case "ind": {
        // The engine emits Indicators for the forming candle or the one about to open.
        const base = (newest === undefined ? 0 : newest.t) + op.ahead * MIN;
        return [indicatorsMessage(base + op.offset, op.ema)];
      }
    }
  }

  test("applying each plan to a model series equals barsToCandles/barsToVolume/indicatorLineData of the stored bars", () => {
    fc.assert(
      fc.property(fc.array(fc.array(opArb, { maxLength: 4 }), { minLength: 1, maxLength: 14 }), (batches) => {
        let state = initialState();
        const candleSeries = new ModelSeries<CandlePoint>();
        const volumeSeries = new ModelSeries<VolumePoint>();
        const emaSeries = new ModelLineSeries();
        let applied: ChartSyncState | null = null;
        let lineApplied: ChartSyncState | null = null;

        for (const batch of batches) {
          const before = state.seriesVersion[STORE_KEY] ?? { snapshot: 0, rewrite: 0 };
          for (const op of batch) {
            for (const message of messagesFor(op, state.candles[STORE_KEY] ?? [])) {
              state = applyServerMessage(state, message);
            }
          }
          const bars = state.candles[STORE_KEY] ?? [];
          const points = state.indicators[STORE_KEY] ?? [];
          const after = state.seriesVersion[STORE_KEY] ?? { snapshot: 0, rewrite: 0 };

          // The input ChartPanel builds for the candles and volume.
          const input = {
            key: `${SYMBOL}|1m|${PRICE_DECIMALS}|${QTY_DECIMALS}`,
            snapshot: after.snapshot,
            rewrite: after.rewrite,
            bars,
          };
          const plan = planChartSync(applied, input);
          const countersMoved = after.snapshot !== before.snapshot || after.rewrite !== before.rewrite;
          const last = bars[bars.length - 1];
          if (applied === null || countersMoved || applied.lastTime === null || last === undefined) {
            expect(plan.kind).toBe("set");
          } else {
            // Forming-bar changes and newer bars only: update with exactly the bars at or after the old last.
            const from = applied.lastTime;
            expect(plan.kind).toBe("update");
            if (plan.kind === "update") {
              expect(plan.bars).toEqual(bars.filter((b) => b.t >= from));
              expect(plan.bars.every((b) => b.t >= from)).toBe(true);
            }
          }
          if (plan.kind === "update") {
            for (const p of barsToCandles(plan.bars, PRICE_DECIMALS)) candleSeries.update(p);
            for (const p of barsToVolume(plan.bars, QTY_DECIMALS)) volumeSeries.update(p);
          } else {
            candleSeries.setData(barsToCandles(bars, PRICE_DECIMALS));
            volumeSeries.setData(barsToVolume(bars, QTY_DECIMALS));
          }
          applied = chartSyncState(input);

          // The input ChartPanel builds for the indicator lines (no qty decimals in the key).
          const lineInput = {
            key: `${SYMBOL}|1m|${PRICE_DECIMALS}`,
            snapshot: after.snapshot,
            rewrite: after.rewrite,
            bars,
          };
          const linePlan = planChartSync(lineApplied, lineInput);
          const setTimes = new Set<number>(bars.map((b) => b.t));
          if (linePlan.kind === "update") {
            const updateTimes = new Set<number>(linePlan.bars.map((b) => b.t));
            const updatePoints = points.filter((p) => updateTimes.has(p.t));
            for (const p of indicatorLineUpdates(updatePoints, "ema", PRICE_DECIMALS, updateTimes)) {
              emaSeries.updateItem(p);
            }
          } else {
            emaSeries.setData(indicatorLineData(points, "ema", PRICE_DECIMALS, setTimes));
          }
          lineApplied = chartSyncState(lineInput);

          // Compare from the first stored time on: the 500 cap can drop old bars that an
          // update-only series keeps on the left (documented limitation).
          const expectedCandles = barsToCandles(bars, PRICE_DECIMALS);
          const expectedVolume = barsToVolume(bars, QTY_DECIMALS);
          const expectedEma = indicatorLineData(points, "ema", PRICE_DECIMALS, setTimes);
          const firstTime = expectedCandles[0]?.time ?? Number.POSITIVE_INFINITY;
          const fromFirst = <T extends { readonly time: number }>(items: readonly T[]) =>
            items.filter((p) => p.time >= firstTime);
          expect(fromFirst(candleSeries.data)).toEqual(expectedCandles);
          expect(fromFirst(volumeSeries.data)).toEqual(expectedVolume);
          expect(fromFirst(emaSeries.data)).toEqual(expectedEma);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// Task 7.5 (Req 3.11): a snapshot repositions the view, a rewrite does not.
describe("shouldReposition", () => {
  const prev: ChartSyncState = { key: "k", snapshot: 2, rewrite: 5, lastTime: 3 };

  test("no previous state repositions", () => {
    expect(shouldReposition(null, { key: "k", snapshot: 0, rewrite: 0 })).toBe(true);
  });

  test("a changed view key repositions", () => {
    expect(shouldReposition(prev, { key: "other", snapshot: 2, rewrite: 5 })).toBe(true);
  });

  test("a changed snapshot counter repositions, also on the same key", () => {
    expect(shouldReposition(prev, { key: "k", snapshot: 3, rewrite: 5 })).toBe(true);
  });

  test("a rewrite-only change does not reposition", () => {
    expect(shouldReposition(prev, { key: "k", snapshot: 2, rewrite: 6 })).toBe(false);
  });

  test("no change does not reposition", () => {
    expect(shouldReposition(prev, { key: "k", snapshot: 2, rewrite: 5 })).toBe(false);
  });
});
