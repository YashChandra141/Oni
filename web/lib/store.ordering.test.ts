// Property 5 (store half): the web store keeps candle and indicator lists ordered, unique, and
// capped, and counts snapshots and late revisions in `seriesVersion` (chart-and-tape-fix, Req 2.7, 2.8).
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { Bar, IndicatorValues, ServerMessage, Timeframe } from "../../shared/protocol/index";
import { MAX_INDICATOR_POINTS } from "./indicatorData";
import { MAX_CANDLES, applyServerMessage, candleKey, initialState, type TerminalState } from "./store";

const SYMBOL = "BTC-USD";
// Multiples of 5 minutes are aligned buckets for both timeframes below.
const STEP = 300_000;
const TIMEFRAMES: readonly Timeframe[] = ["1m", "5m"];

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

function bar(k: number): Bar {
  return { t: k * STEP, open: "100", high: "110", low: "90", close: "105", volume: "1" };
}

type Step =
  | { readonly kind: "snapshot"; readonly tf: Timeframe; readonly ks: readonly number[] }
  | { readonly kind: "live"; readonly tf: Timeframe; readonly ks: readonly number[] }
  | { readonly kind: "indicators"; readonly tf: Timeframe; readonly k: number };

// Bar indexes reach past MAX_CANDLES so the cap is exercised; lists are unsorted with duplicates.
const index = fc.integer({ min: 0, max: 800 });
const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc.record({
    kind: fc.constant("snapshot" as const),
    tf: fc.constantFrom(...TIMEFRAMES),
    ks: fc.array(index, { maxLength: 700 }),
  }),
  fc.record({
    kind: fc.constant("live" as const),
    tf: fc.constantFrom(...TIMEFRAMES),
    ks: fc.array(index, { minLength: 1, maxLength: 5 }),
  }),
  fc.record({
    kind: fc.constant("indicators" as const),
    tf: fc.constantFrom(...TIMEFRAMES),
    k: index,
  }),
);

function toMessage(step: Step): ServerMessage {
  switch (step.kind) {
    case "snapshot":
    case "live":
      return {
        type: "event",
        event: {
          type: "candle",
          symbol: SYMBOL,
          timeframe: step.tf,
          snapshot: step.kind === "snapshot",
          bars: step.ks.map(bar),
        },
      };
    case "indicators":
      return {
        type: "event",
        event: {
          type: "indicators",
          symbol: SYMBOL,
          timeframe: step.tf,
          // Mid-bucket timestamp: the store buckets it to the candle open time.
          ts: step.k * STEP + 1234,
          values: { ...EMPTY, ema: step.k },
        },
      };
  }
}

function strictlyAscending(times: readonly number[]): boolean {
  return times.every((t, i) => i === 0 || t > (times[i - 1] as number));
}

function assertOrdered(state: TerminalState): void {
  for (const bars of Object.values(state.candles)) {
    expect(strictlyAscending(bars.map((b) => b.t))).toBe(true);
    expect(bars.length).toBeLessThanOrEqual(MAX_CANDLES);
  }
  for (const points of Object.values(state.indicators)) {
    expect(strictlyAscending(points.map((p) => p.t))).toBe(true);
    expect(points.length).toBeLessThanOrEqual(MAX_INDICATOR_POINTS);
  }
}

describe("web store ordering (Property 5)", () => {
  test("lists stay strictly ascending, unique, and capped; versions count snapshots and late bars", () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 30 }), (steps) => {
        let state = initialState();
        for (const step of steps) {
          const key = candleKey(SYMBOL, step.tf);
          const before = state.seriesVersion[key] ?? { snapshot: 0, rewrite: 0 };
          let newest = (state.candles[key] ?? []).at(-1)?.t ?? null;
          let expectedRewrite = before.rewrite;
          if (step.kind === "live") {
            // A late revision is a live bar older than the newest stored bar at that moment.
            for (const k of step.ks) {
              const t = k * STEP;
              if (newest !== null && t < newest) expectedRewrite += 1;
              if (newest === null || t > newest) newest = t;
            }
          }

          state = applyServerMessage(state, toMessage(step));

          assertOrdered(state);
          const after = state.seriesVersion[key] ?? { snapshot: 0, rewrite: 0 };
          if (step.kind === "snapshot") {
            expect(after.snapshot).toBe(before.snapshot + 1);
            expect(after.rewrite).toBe(before.rewrite);
          } else if (step.kind === "live") {
            expect(after.snapshot).toBe(before.snapshot);
            expect(after.rewrite).toBe(expectedRewrite);
          } else {
            expect(after).toEqual(before);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  test("a late live bar raises rewrite by one and lands in order", () => {
    let state = applyServerMessage(
      initialState(),
      toMessage({ kind: "snapshot", tf: "1m", ks: [5, 1, 3, 3] }),
    );
    state = applyServerMessage(state, toMessage({ kind: "live", tf: "1m", ks: [2] }));
    const key = candleKey(SYMBOL, "1m");
    expect(state.seriesVersion[key]).toEqual({ snapshot: 1, rewrite: 1 });
    expect(state.candles[key]?.map((b) => b.t / STEP)).toEqual([1, 2, 3, 5]);
  });
});
