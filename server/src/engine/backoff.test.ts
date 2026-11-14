// Unit tests for the restart backoff (Req 15.2, 15.3). The P25 property test is in Task 3.3.
import { describe, expect, test } from "bun:test";
import { BACKOFF_INITIAL_MS, BACKOFF_MAX_MS, BACKOFF_RESET_AFTER_MS, Backoff } from "./backoff.ts";

/** A clock the test moves by hand. */
function fakeClock(start = 1_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("Backoff", () => {
  test("uses the delays from Req 15.2 and 15.3", () => {
    expect(BACKOFF_INITIAL_MS).toBe(500);
    expect(BACKOFF_MAX_MS).toBe(30_000);
    expect(BACKOFF_RESET_AFTER_MS).toBe(60_000);
  });

  test("doubles from 500 ms and caps at 30 s (Req 15.2)", () => {
    const backoff = new Backoff({ now: fakeClock().now });
    const delays = Array.from({ length: 10 }, () => backoff.next());
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000, 30_000]);
  });

  test("reset() starts the sequence again", () => {
    const backoff = new Backoff({ now: fakeClock().now });
    backoff.next();
    backoff.next();
    backoff.reset();
    expect(backoff.next()).toBe(500);
    expect(backoff.next()).toBe(1000);
  });

  test("quick consecutive exits keep doubling", () => {
    const clock = fakeClock();
    const backoff = new Backoff({ now: clock.now });
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      backoff.markStarted();
      clock.advance(1_000);
      delays.push(backoff.onExit());
    }
    expect(delays).toEqual([500, 1000, 2000, 4000]);
  });

  test("an exit after 60 s of uptime restarts at 500 ms (Req 15.3)", () => {
    const clock = fakeClock();
    const backoff = new Backoff({ now: clock.now });
    for (let i = 0; i < 8; i++) backoff.next(); // now at the 30 s cap
    backoff.markStarted();
    clock.advance(60_000);
    expect(backoff.onExit()).toBe(500);
    // The next quick exit continues from there.
    backoff.markStarted();
    clock.advance(10);
    expect(backoff.onExit()).toBe(1000);
  });

  test("an exit just under 60 s of uptime keeps doubling", () => {
    const clock = fakeClock();
    const backoff = new Backoff({ now: clock.now });
    backoff.next();
    backoff.next(); // next is 2000
    backoff.markStarted();
    clock.advance(59_999);
    expect(backoff.onExit()).toBe(2000);
  });

  test("uptime is measured from the latest markStarted()", () => {
    const clock = fakeClock();
    const backoff = new Backoff({ now: clock.now });
    backoff.next(); // next is 1000
    backoff.markStarted();
    clock.advance(50_000);
    backoff.markStarted(); // restarted without an exit in between
    clock.advance(50_000);
    expect(backoff.onExit()).toBe(1000);
  });

  test("onExit without markStarted counts as zero uptime", () => {
    const clock = fakeClock();
    const backoff = new Backoff({ now: clock.now });
    backoff.markStarted();
    clock.advance(1_000);
    expect(backoff.onExit()).toBe(500);
    clock.advance(120_000); // time passes while waiting, but no new start
    expect(backoff.onExit()).toBe(1000);
  });

  test("rejects inconsistent options", () => {
    expect(() => new Backoff({ initialMs: 0 })).toThrow(RangeError);
    expect(() => new Backoff({ initialMs: 1000, maxMs: 500 })).toThrow(RangeError);
  });
});
