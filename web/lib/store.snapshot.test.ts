// Property 4: a candle snapshot replaces the stored indicator points of its key (Req 2.7).
// **Validates: Requirements 2.7**
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { Bar, Event, IndicatorValues, ServerMessage, Timeframe } from "../../shared/protocol/index";
import { bucketStartMs } from "./chartData";
import { MAX_INDICATOR_POINTS, type IndicatorPoint } from "./indicatorData";
import { applyServerMessage, candleKey, initialState, type TerminalState } from "./store";

type CandleEvent = Extract<Event, { type: "candle" }>;

interface RawPoint {
  readonly t: number;
  readonly values: IndicatorValues;
}

const TIMEFRAMES: readonly Timeframe[] = ["1m", "5m", "15m", "1h", "1d"];
const SYMBOL = "BTC-USD";
const OTHER_SYMBOL = "ETH-USD";

function values(ema: number): IndicatorValues {
  return { ema, sma: null, vwap: null, bb_upper: null, bb_mid: null, bb_lower: null, rsi: null, atr: null };
}

function bar(t: number): Bar {
  return { t, open: "100", high: "110", low: "90", close: "100", volume: "5" };
}

function candleMessage(
  symbol: string,
  timeframe: Timeframe,
  snapshot: boolean,
  bars: Bar[],
  indicators?: readonly RawPoint[],
): ServerMessage {
  const base: CandleEvent = { type: "candle", venue: "replay", symbol, timeframe, snapshot, bars };
  const event: CandleEvent = indicators === undefined ? base : { ...base, indicators: [...indicators] };
  return { type: "event", event };
}

function indicatorsMessage(symbol: string, timeframe: Timeframe, ts: number, ema: number): ServerMessage {
  return { type: "event", event: { type: "indicators", venue: "replay", symbol, timeframe, ts, values: values(ema) } };
}

/** Model: floor each t to its bucket, last wins, ascending, newest MAX_INDICATOR_POINTS. */
function expectedPoints(raw: readonly RawPoint[], tf: Timeframe): IndicatorPoint[] {
  const byTime = new Map<number, IndicatorPoint>();
  for (const p of raw) {
    const t = bucketStartMs(p.t, tf);
    byTime.set(t, { t, values: p.values });
  }
  const sorted = [...byTime.values()].sort((a, b) => a.t - b.t);
  return sorted.slice(Math.max(0, sorted.length - MAX_INDICATOR_POINTS));
}

type Step =
  | { kind: "bars"; other: boolean; t: number }
  | { kind: "indicators"; other: boolean; t: number }
  | { kind: "snapshot"; other: boolean; points: number[] };

const timeArb = fc.oneof(
  fc.integer({ min: 0, max: 600_000 }),
  fc.integer({ min: 0, max: 100_000_000 }),
);

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc.record({ kind: fc.constant("bars" as const), other: fc.boolean(), t: timeArb }),
  fc.record({ kind: fc.constant("indicators" as const), other: fc.boolean(), t: timeArb }),
  fc.record({
    kind: fc.constant("snapshot" as const),
    other: fc.boolean(),
    points: fc.array(timeArb, { maxLength: 30 }),
  }),
);

function applyStep(state: TerminalState, step: Step, tf: Timeframe, seq: number): TerminalState {
  const symbol = step.other ? OTHER_SYMBOL : SYMBOL;
  switch (step.kind) {
    case "bars":
      return applyServerMessage(state, candleMessage(symbol, tf, false, [bar(bucketStartMs(step.t, tf))]));
    case "indicators":
      return applyServerMessage(state, indicatorsMessage(symbol, tf, step.t, seq));
    case "snapshot":
      return applyServerMessage(
        state,
        candleMessage(
          symbol,
          tf,
          true,
          [bar(bucketStartMs(0, tf))],
          step.points.map((t, i) => ({ t, values: values(seq * 1000 + i) })),
        ),
      );
  }
}

describe("Property 4: snapshots replace stored indicator points in the web store", () => {
  test("the stored points equal the normalized snapshot points; other keys are untouched", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...TIMEFRAMES),
        fc.array(stepArb, { maxLength: 15 }),
        // Unaligned, unsorted, duplicated; sometimes more than MAX_INDICATOR_POINTS distinct buckets.
        fc.oneof(
          fc.array(timeArb, { maxLength: 40 }),
          fc.array(fc.integer({ min: 0, max: 100_000_000 }), { minLength: 520, maxLength: 700 }),
        ),
        fc.boolean(),
        (tf, prior, finalTimes, withIndicators) => {
          let state = initialState();
          prior.forEach((step, i) => {
            state = applyStep(state, step, tf, i + 1);
          });
          const key = candleKey(SYMBOL, tf);
          const before = state;
          const raw: RawPoint[] = finalTimes.map((t, i) => ({ t, values: values(-1 - i) }));
          const message = withIndicators
            ? candleMessage(SYMBOL, tf, true, [bar(bucketStartMs(0, tf))], raw)
            : candleMessage(SYMBOL, tf, true, [bar(bucketStartMs(0, tf))]);
          const after = applyServerMessage(state, message);

          const expected = withIndicators ? expectedPoints(raw, tf) : [];
          expect(after.indicators[key]).toEqual(expected);
          // No earlier point remains: every stored t comes from the snapshot's buckets.
          const allowed = new Set(expected.map((p) => p.t));
          for (const p of after.indicators[key] ?? []) expect(allowed.has(p.t)).toBe(true);
          // Other keys are untouched.
          for (const k of Object.keys(before.indicators)) {
            if (k !== key) expect(after.indicators[k]).toBe(before.indicators[k]);
          }
          for (const k of Object.keys(before.candles)) {
            if (k !== key) expect(after.candles[k]).toBe(before.candles[k]);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
