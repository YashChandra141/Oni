// Property P25 — validates Req 15.2, 15.3
// Backoff delays are non-decreasing and capped at 30 s, and reset after 60 s uptime
// (design.md, Correctness Properties). Drives Backoff the way the Engine_Supervisor does:
// markStarted(), the engine runs for some uptime on a fake clock, then onExit().
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { BACKOFF_INITIAL_MS, BACKOFF_MAX_MS, BACKOFF_RESET_AFTER_MS, Backoff } from "./backoff.ts";

const NUM_RUNS = 300;

/**
 * Reference model, written separately from Backoff: the restart delay after a run of `uptime`
 * ms, given the delay returned for the previous exit (`null` for the first exit).
 */
function model(prev: number | null, uptime: number): number {
  if (uptime >= 60_000) return 500; // Req 15.3
  if (prev === null) return 500; // Req 15.2: starts at 500 ms
  return Math.min(prev * 2, 30_000); // Req 15.2: doubles, capped at 30 s
}

/** Uptimes in ms, weighted toward the 60 s boundary. Fractions occur with `performance.now`. */
const uptimeArb = fc.oneof(
  fc.integer({ min: 0, max: 59_999 }),
  fc.integer({ min: 59_990, max: 60_010 }),
  fc.double({ min: 59_999, max: 60_001, noNaN: true }),
  fc.integer({ min: 60_000, max: 10_000_000 }),
);

const runsArb = fc.array(uptimeArb, { minLength: 1, maxLength: 40 });
/** Any monotonic clock origin, including the zero that `performance.now` starts near. */
const clockStartArb = fc.integer({ min: 0, max: 1_000_000_000 });

interface Drive {
  /** Restart delay returned by each `onExit()`. */
  readonly delays: number[];
  /**
   * Uptime of each run as the fake clock reports it (`now()` at exit minus `now()` at start).
   * It can differ from the generated uptime by float rounding, so the checks use this one.
   */
  readonly uptimes: number[];
}

/** Runs Backoff through `runs` (uptimes in ms) on a fake clock. */
function drive(start: number, runs: readonly number[]): Drive {
  let t = start;
  const backoff = new Backoff({ now: () => t });
  const delays: number[] = [];
  const uptimes: number[] = [];
  for (const run of runs) {
    backoff.markStarted();
    const startedAt = t;
    t += run;
    uptimes.push(t - startedAt);
    delays.push(backoff.onExit());
  }
  return { delays, uptimes };
}

describe("Property P25: engine restart backoff (Req 15.2, 15.3)", () => {
  test("the constants match the model", () => {
    expect([BACKOFF_INITIAL_MS, BACKOFF_MAX_MS, BACKOFF_RESET_AFTER_MS]).toEqual([500, 30_000, 60_000]);
  });

  test("every delay is within [500, 30 000] ms", () => {
    fc.assert(
      fc.property(clockStartArb, runsArb, (start, runs) => {
        for (const d of drive(start, runs).delays) {
          expect(d).toBeGreaterThanOrEqual(500);
          expect(d).toBeLessThanOrEqual(30_000);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("short runs never decrease the delay, and each doubles the previous one up to the cap", () => {
    fc.assert(
      fc.property(clockStartArb, runsArb, (start, runs) => {
        const { delays, uptimes } = drive(start, runs);
        if ((uptimes[0] as number) < 60_000) expect(delays[0]).toBe(500);
        for (let i = 1; i < delays.length; i++) {
          if ((uptimes[i] as number) >= 60_000) continue;
          const prev = delays[i - 1] as number;
          const cur = delays[i] as number;
          expect(cur).toBeGreaterThanOrEqual(prev);
          expect(cur).toBe(Math.min(prev * 2, 30_000));
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("a run with uptime >= 60 000 ms resets the next delay to 500 ms", () => {
    fc.assert(
      fc.property(clockStartArb, runsArb, (start, runs) => {
        const { delays, uptimes } = drive(start, runs);
        uptimes.forEach((uptime, i) => {
          if (uptime >= 60_000) expect(delays[i]).toBe(500);
        });
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("delays equal the reference model", () => {
    fc.assert(
      fc.property(clockStartArb, runsArb, (start, runs) => {
        const { delays, uptimes } = drive(start, runs);
        const expected: number[] = [];
        let prev: number | null = null;
        for (const uptime of uptimes) {
          prev = model(prev, uptime);
          expected.push(prev);
        }
        expect(delays).toEqual(expected);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
