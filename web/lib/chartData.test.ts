// Pure chart data helpers (Task 5.4, Req 25.1-25.3). Prices and volumes are converted with
// BigInt scaling; the JS numbers are display-only.
import { describe, expect, test } from "bun:test";
import type { Bar } from "../../shared/protocol/index";
import {
  CHART_THEME,
  barsToCandles,
  barsToVolume,
  formatChartTime,
  formatDisplayNumber,
  isTimeframe,
  planSeriesUpdate,
  priceFormatFor,
  readOhlc,
  readValue,
  seriesShape,
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
    expect([...timeframeLabels]).toEqual(["1m", "5m", "15m", "1h", "1d"]);
  });

  test("keys 1 to 5 select the timeframe at that position (Req 25.3)", () => {
    expect(["1", "2", "3", "4", "5"].map((k) => timeframeFromKey(k))).toEqual([
      "1m",
      "5m",
      "15m",
      "1h",
      "1d",
    ]);
  });

  test("other keys select nothing", () => {
    for (const key of ["0", "6", "9", "a", "", "11", "+", "Enter"]) {
      expect(timeframeFromKey(key)).toBeNull();
    }
  });

  test("isTimeframe accepts exactly the five labels", () => {
    for (const tf of timeframeLabels) expect(isTimeframe(tf)).toBe(true);
    for (const other of ["1s", "4h", "1M", "", "1m "]) expect(isTimeframe(other)).toBe(false);
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
  test("formatChartTime shows UTC minutes", () => {
    expect(formatChartTime(1_700_000_000)).toBe("2023-11-14 22:13 UTC");
    expect(formatChartTime(0)).toBe("1970-01-01 00:00 UTC");
  });

  test("formatChartTime shows a dash for an invalid time", () => {
    expect(formatChartTime(Number.NaN)).toBe("—");
    expect(formatChartTime(Number.POSITIVE_INFINITY)).toBe("—");
  });

  test("formatDisplayNumber uses fixed decimals", () => {
    expect(formatDisplayNumber(1.5, 2)).toBe("1.50");
    expect(formatDisplayNumber(64000.126, 2)).toBe("64000.13");
    expect(formatDisplayNumber(3, 0)).toBe("3");
    expect(formatDisplayNumber(Number.NaN, 2)).toBe("—");
  });
});

describe("planSeriesUpdate", () => {
  const points = (...times: number[]) => times.map((time) => ({ time }));

  test("the first data is a full set", () => {
    expect(planSeriesUpdate(null, seriesShape("k", points(1, 2, 3)))).toBe("set");
  });

  test("a change in the last bar only is an update", () => {
    const prev = seriesShape("k", points(1, 2, 3));
    expect(planSeriesUpdate(prev, seriesShape("k", points(1, 2, 3)))).toBe("update");
  });

  test("a new bar (count changed) is a full set", () => {
    const prev = seriesShape("k", points(1, 2, 3));
    expect(planSeriesUpdate(prev, seriesShape("k", points(1, 2, 3, 4)))).toBe("set");
  });

  test("a different first time (history trimmed) is a full set", () => {
    const prev = seriesShape("k", points(1, 2, 3));
    expect(planSeriesUpdate(prev, seriesShape("k", points(2, 3, 4)))).toBe("set");
  });

  test("a different key or last time is a full set", () => {
    const prev = seriesShape("k", points(1, 2, 3));
    expect(planSeriesUpdate(prev, seriesShape("other", points(1, 2, 3)))).toBe("set");
    expect(planSeriesUpdate(prev, seriesShape("k", points(1, 2, 4)))).toBe("set");
  });

  test("empty data is always a full set", () => {
    const prev = seriesShape("k", points());
    expect(planSeriesUpdate(prev, seriesShape("k", points()))).toBe("set");
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
