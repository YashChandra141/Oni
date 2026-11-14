// Req 33.2: reconnect delays start at 250 ms, double, and stop at 10 s.
import { describe, expect, test } from "bun:test";
import {
  INITIAL_BACKOFF_MS,
  MAX_BACKOFF_MS,
  createBackoff,
  nextDelay,
  resetBackoff,
  type Backoff,
} from "./backoff";

function delays(count: number, start: Backoff = createBackoff()): number[] {
  const out: number[] = [];
  let backoff = start;
  for (let i = 0; i < count; i += 1) {
    const step = nextDelay(backoff);
    out.push(step.delayMs);
    backoff = step.backoff;
  }
  return out;
}

describe("backoff", () => {
  test("constants", () => {
    expect(INITIAL_BACKOFF_MS).toBe(250);
    expect(MAX_BACKOFF_MS).toBe(10_000);
  });

  test("doubles from 250 ms and caps at 10 s", () => {
    expect(delays(9)).toEqual([250, 500, 1000, 2000, 4000, 8000, 10_000, 10_000, 10_000]);
  });

  test("never exceeds the cap", () => {
    for (const delay of delays(200)) expect(delay).toBeLessThanOrEqual(MAX_BACKOFF_MS);
  });

  test("nextDelay does not change the backoff it was given", () => {
    const start = createBackoff();
    nextDelay(start);
    expect(start.nextMs).toBe(250);
  });

  test("reset starts over", () => {
    let backoff = createBackoff();
    for (let i = 0; i < 5; i += 1) backoff = nextDelay(backoff).backoff;
    expect(backoff.nextMs).toBe(8000);
    expect(delays(2, resetBackoff())).toEqual([250, 500]);
  });
});
