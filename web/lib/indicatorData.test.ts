// Indicator line data, legend, and action mapping (Task 9.3, Req 26.1-26.4).
import { describe, expect, test } from "bun:test";
import type { IndicatorValues } from "../../shared/protocol/index";
import {
  DEFAULT_INDICATOR_TOGGLES,
  INDICATOR_LINES,
  formatIndicatorValue,
  indicatorLineData,
  latestLineValue,
  legendEntries,
  lineValueToDisplay,
  paneOfLine,
  toggleFromAction,
  toggleOfLine,
  type IndicatorPoint,
} from "./indicatorData";

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

function point(t: number, values: Partial<IndicatorValues>): IndicatorPoint {
  return { t, values: { ...EMPTY, ...values } };
}

describe("lineValueToDisplay", () => {
  test("price-like lines divide ticks by 10^priceDecimals", () => {
    expect(lineValueToDisplay("ema", 6400012, 2)).toBeCloseTo(64000.12, 9);
    expect(lineValueToDisplay("vwap", 150, 0)).toBe(150);
    expect(lineValueToDisplay("bb_upper", 12345, 3)).toBeCloseTo(12.345, 9);
    expect(lineValueToDisplay("atr", 250, 2)).toBeCloseTo(2.5, 9);
  });

  test("RSI passes through unscaled", () => {
    expect(lineValueToDisplay("rsi", 71.25, 2)).toBe(71.25);
    expect(lineValueToDisplay("rsi", 0, 8)).toBe(0);
    expect(lineValueToDisplay("rsi", 100, 2)).toBe(100);
  });

  test("null and non-finite values give null", () => {
    expect(lineValueToDisplay("ema", null, 2)).toBeNull();
    expect(lineValueToDisplay("ema", Number.NaN, 2)).toBeNull();
    expect(lineValueToDisplay("rsi", Number.POSITIVE_INFINITY, 2)).toBeNull();
  });

  test("invalid decimals fall back to 2", () => {
    expect(lineValueToDisplay("ema", 100, -1)).toBe(1);
    expect(lineValueToDisplay("ema", 100, 1.5)).toBe(1);
  });
});

describe("indicatorLineData", () => {
  test("converts ms to UTC seconds and skips nulls", () => {
    const points = [
      point(60_000, { ema: null, rsi: 40 }),
      point(120_000, { ema: 10_000, rsi: 55 }),
      point(180_000, { ema: 10_050, rsi: null }),
    ];
    expect(indicatorLineData(points, "ema", 2)).toEqual([
      { time: 120 as never, value: 100 },
      { time: 180 as never, value: 100.5 },
    ]);
    expect(indicatorLineData(points, "rsi", 2)).toEqual([
      { time: 60 as never, value: 40 },
      { time: 120 as never, value: 55 },
    ]);
  });

  test("orders by time and keeps the last point of equal times", () => {
    const points = [point(180_000, { atr: 300 }), point(60_000, { atr: 100 }), point(180_500, { atr: 400 })];
    expect(indicatorLineData(points, "atr", 2)).toEqual([
      { time: 60 as never, value: 1 },
      { time: 180 as never, value: 4 },
    ]);
  });

  test("drops points with an invalid time", () => {
    const points = [point(-1, { ema: 1 }), point(Number.NaN, { ema: 1 }), point(0, { ema: 200 })];
    expect(indicatorLineData(points, "ema", 2)).toEqual([{ time: 0 as never, value: 2 }]);
  });

  test("an empty list gives no data", () => {
    expect(indicatorLineData([], "vwap", 2)).toEqual([]);
  });
});

describe("latestLineValue and legend", () => {
  const points = [point(60_000, { ema: 10_000, rsi: 50 }), point(120_000, { ema: null, rsi: 61.234 })];

  test("latest non-null value of a line", () => {
    expect(latestLineValue(points, "ema", 2)).toBe(100);
    expect(latestLineValue(points, "rsi", 2)).toBe(61.234);
    expect(latestLineValue(points, "atr", 2)).toBeNull();
  });

  test("formats price-like lines with the price decimals and RSI with 2", () => {
    expect(formatIndicatorValue("ema", 64000.1, 2)).toBe("64000.10");
    expect(formatIndicatorValue("atr", 1.5, 3)).toBe("1.500");
    expect(formatIndicatorValue("rsi", 61.234, 8)).toBe("61.23");
    expect(formatIndicatorValue("vwap", null, 2)).toBe("—");
  });

  test("legend lists the lines of enabled toggles only, in button order", () => {
    const entries = legendEntries(points, DEFAULT_INDICATOR_TOGGLES, 2);
    expect(entries.map((e) => e.line)).toEqual(["ema", "vwap", "rsi"]);
    expect(entries.map((e) => e.text)).toEqual(["100.00", "—", "61.23"]);
  });

  test("Bollinger shows three lines", () => {
    const toggles = { ema: false, vwap: false, bollinger: true, rsi: false, atr: false };
    const entries = legendEntries([point(0, { bb_upper: 110, bb_mid: 100, bb_lower: 90 })], toggles, 1);
    expect(entries.map((e) => [e.label, e.text])).toEqual([
      ["BB+", "11.0"],
      ["BB", "10.0"],
      ["BB-", "9.0"],
    ]);
  });

  test("all toggles off gives an empty legend", () => {
    const off = { ema: false, vwap: false, bollinger: false, rsi: false, atr: false };
    expect(legendEntries(points, off, 2)).toEqual([]);
  });
});

describe("toggles and actions", () => {
  test("defaults: EMA, VWAP, RSI on; Bollinger and ATR off", () => {
    expect(DEFAULT_INDICATOR_TOGGLES).toEqual({
      ema: true,
      vwap: true,
      bollinger: false,
      rsi: true,
      atr: false,
    });
  });

  test("maps indicator.* actions to toggle names", () => {
    expect(toggleFromAction("indicator.ema")).toBe("ema");
    expect(toggleFromAction("indicator.vwap")).toBe("vwap");
    expect(toggleFromAction("indicator.bollinger")).toBe("bollinger");
    expect(toggleFromAction("indicator.rsi")).toBe("rsi");
    expect(toggleFromAction("indicator.atr")).toBe("atr");
  });

  test("other actions are not toggles", () => {
    expect(toggleFromAction("order.buy")).toBeNull();
    expect(toggleFromAction("timeframe.1m")).toBeNull();
    expect(toggleFromAction("chart.zoom_in")).toBeNull();
  });

  test("every line belongs to the toggle that lists it, and RSI/ATR go in pane 1", () => {
    for (const [name, lines] of Object.entries(INDICATOR_LINES)) {
      for (const line of lines) expect(toggleOfLine(line)).toBe(name as never);
    }
    expect(paneOfLine("rsi")).toBe(1);
    expect(paneOfLine("atr")).toBe(1);
    expect(paneOfLine("ema")).toBe(0);
    expect(paneOfLine("bb_lower")).toBe(0);
  });
});
