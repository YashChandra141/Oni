// Indicator state in the Web UI store (Task 9.3, Req 26.3, 26.4).
import { beforeEach, describe, expect, test } from "bun:test";
import type { IndicatorValues, ServerMessage } from "../../shared/protocol/index";
import { MAX_INDICATOR_POINTS, type IndicatorPoint } from "./indicatorData";
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
    event: { type: "indicators", symbol, timeframe, ts, values: { ...EMPTY, ...values } },
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
