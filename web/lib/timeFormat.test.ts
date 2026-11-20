// Local time display (chart-and-tape-fix Req 2.13, 3.16; design D7; Property 13).
// Zones are pinned through the `timeZone` option so the tests do not depend on the machine's zone.
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { Bar } from "../../shared/protocol/index";
import { barsToCandles } from "./chartData";
import {
  CLOCK_PLACEHOLDER,
  TICK_DAY_OF_MONTH,
  TICK_MONTH,
  TICK_TIME,
  TICK_TIME_WITH_SECONDS,
  TICK_YEAR,
  TIME_PLACEHOLDER,
  formatChartTime,
  formatClock,
  tickMarkLabel,
} from "./timeFormat";

const ZONES = ["UTC", "Asia/Kolkata", "America/New_York"] as const;
const LOCALE = "en-US";

/** 2023-11-14 22:13:20 UTC. */
const SAMPLE_S = 1_700_000_000;

describe("formatClock", () => {
  test("formats HH:MM:SS in the pinned zone", () => {
    const ms = Date.UTC(2026, 0, 2, 3, 4, 5, 999);
    expect(formatClock(ms, { timeZone: "UTC" })).toBe("03:04:05");
    expect(formatClock(0, { timeZone: "UTC" })).toBe("00:00:00");
  });

  test("invalid input gives a placeholder", () => {
    expect(formatClock(Number.NaN, { timeZone: "UTC" })).toBe(CLOCK_PLACEHOLDER);
    expect(formatClock(8.64e15 + 1, { timeZone: "UTC" })).toBe(CLOCK_PLACEHOLDER);
    expect(formatClock(Number.NaN)).toBe("--:--:--");
  });

  test("an unknown zone gives a placeholder instead of throwing", () => {
    expect(formatClock(0, { timeZone: "Not/AZone" })).toBe(CLOCK_PLACEHOLDER);
  });
});

describe("formatChartTime", () => {
  test("shows minutes and the zone name in UTC", () => {
    expect(formatChartTime(SAMPLE_S, { timeZone: "UTC", locale: LOCALE })).toBe("2023-11-14 22:13 UTC");
    expect(formatChartTime(0, { timeZone: "UTC", locale: LOCALE })).toBe("1970-01-01 00:00 UTC");
  });

  test("shows a dash for an invalid time", () => {
    expect(formatChartTime(Number.NaN, { timeZone: "UTC" })).toBe(TIME_PLACEHOLDER);
    expect(formatChartTime(Number.POSITIVE_INFINITY, { timeZone: "UTC" })).toBe("—");
  });
});

describe("the same instant in different zones", () => {
  test("renders differently in Kolkata and New York", () => {
    const kolkata = { timeZone: "Asia/Kolkata", locale: LOCALE };
    const newYork = { timeZone: "America/New_York", locale: LOCALE };
    expect(formatClock(SAMPLE_S * 1000, kolkata)).toBe("03:43:20");
    expect(formatClock(SAMPLE_S * 1000, newYork)).toBe("17:13:20");
    expect(formatChartTime(SAMPLE_S, kolkata).startsWith("2023-11-15 03:43 ")).toBe(true);
    expect(formatChartTime(SAMPLE_S, newYork)).toBe("2023-11-14 17:13 EST");
    expect(formatChartTime(SAMPLE_S, kolkata)).not.toBe(formatChartTime(SAMPLE_S, newYork));
  });

  test("a 1d candle opening at 00:00 UTC shows as 05:30 in Kolkata", () => {
    const open = Date.UTC(2024, 0, 1) / 1000;
    expect(tickMarkLabel(open, TICK_TIME, { timeZone: "Asia/Kolkata", locale: LOCALE })).toBe("05:30");
    expect(tickMarkLabel(open, TICK_TIME, { timeZone: "UTC", locale: LOCALE })).toBe("00:00");
  });

  test("New York follows daylight saving: the same UTC hour shifts by one hour", () => {
    const newYork = { timeZone: "America/New_York", locale: LOCALE };
    const winter = Date.UTC(2024, 0, 15, 12) / 1000;
    const summer = Date.UTC(2024, 6, 15, 12) / 1000;
    expect(formatChartTime(winter, newYork)).toBe("2024-01-15 07:00 EST");
    expect(formatChartTime(summer, newYork)).toBe("2024-07-15 08:00 EDT");
  });
});

describe("tickMarkLabel", () => {
  const utc = { timeZone: "UTC", locale: LOCALE };
  test("labels each tick type", () => {
    expect(tickMarkLabel(SAMPLE_S, TICK_YEAR, utc)).toBe("2023");
    expect(tickMarkLabel(SAMPLE_S, TICK_MONTH, utc)).toBe("Nov");
    expect(tickMarkLabel(SAMPLE_S, TICK_DAY_OF_MONTH, utc)).toBe("14");
    expect(tickMarkLabel(SAMPLE_S, TICK_TIME, utc)).toBe("22:13");
    expect(tickMarkLabel(SAMPLE_S, TICK_TIME_WITH_SECONDS, utc)).toBe("22:13:20");
  });

  test("uses the zone's calendar day, not the UTC day", () => {
    // 22:13 UTC on Nov 14 is already Nov 15 in Kolkata.
    expect(tickMarkLabel(SAMPLE_S, TICK_DAY_OF_MONTH, { timeZone: "Asia/Kolkata", locale: LOCALE })).toBe("15");
  });

  test("invalid input gives a dash", () => {
    expect(tickMarkLabel(Number.NaN, TICK_TIME, utc)).toBe(TIME_PLACEHOLDER);
  });
});

// ---------------------------------------------------------------------------------------------
// Property 13: local time display

/** Epoch ms near the 2024 US and India-adjacent DST changes, and anywhere in 1970..2096. */
const epochMs = fc.oneof(
  fc.integer({ min: 0, max: 4_000_000_000_000 }),
  // US spring forward 2024-03-10 07:00Z and fall back 2024-11-03 06:00Z, within +-3 hours.
  fc.integer({ min: -10_800_000, max: 10_800_000 }).map((d) => Date.UTC(2024, 2, 10, 7) + d),
  fc.integer({ min: -10_800_000, max: 10_800_000 }).map((d) => Date.UTC(2024, 10, 3, 6) + d),
);
const zone = fc.constantFrom(...ZONES);

/** Reference text built straight from Intl, independent of timeFormat.ts. */
function referenceClock(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ms));
}

function referenceChart(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat(LOCALE, {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(new Date(ms));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ${get("timeZoneName")}`;
}

describe("Property 13: local time display", () => {
  test("formatClock equals Intl.DateTimeFormat in the zone", () => {
    fc.assert(
      fc.property(epochMs, zone, (ms, timeZone) => {
        expect(formatClock(ms, { timeZone, locale: LOCALE })).toBe(referenceClock(ms, timeZone));
      }),
      { numRuns: 300 },
    );
  });

  test("formatChartTime equals Intl.DateTimeFormat in the zone", () => {
    fc.assert(
      fc.property(epochMs, zone, (ms, timeZone) => {
        const seconds = Math.floor(ms / 1000);
        expect(formatChartTime(seconds, { timeZone, locale: LOCALE })).toBe(
          referenceChart(seconds * 1000, timeZone),
        );
      }),
      { numRuns: 300 },
    );
  });

  test("UTC output matches the ISO string", () => {
    fc.assert(
      fc.property(epochMs, (ms) => {
        const seconds = Math.floor(ms / 1000);
        const iso = new Date(seconds * 1000).toISOString();
        expect(formatChartTime(seconds, { timeZone: "UTC", locale: LOCALE })).toBe(
          `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`,
        );
        expect(formatClock(ms, { timeZone: "UTC", locale: LOCALE })).toBe(
          new Date(ms).toISOString().slice(11, 19),
        );
      }),
      { numRuns: 200 },
    );
  });

  test("tick labels equal Intl.DateTimeFormat in the zone", () => {
    fc.assert(
      fc.property(epochMs, zone, (ms, timeZone) => {
        const seconds = Math.floor(ms / 1000);
        const date = new Date(seconds * 1000);
        const intl = (options: Intl.DateTimeFormatOptions) =>
          new Intl.DateTimeFormat(LOCALE, { timeZone, ...options }).format(date);
        const opts = { timeZone, locale: LOCALE };
        expect(tickMarkLabel(seconds, TICK_YEAR, opts)).toBe(intl({ year: "numeric" }));
        expect(tickMarkLabel(seconds, TICK_MONTH, opts)).toBe(intl({ month: "short" }));
        expect(tickMarkLabel(seconds, TICK_DAY_OF_MONTH, opts)).toBe(intl({ day: "numeric" }));
        expect(tickMarkLabel(seconds, TICK_TIME, opts)).toBe(
          intl({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
        );
      }),
      { numRuns: 200 },
    );
  });

  test("formatting leaves the UTC data unchanged", () => {
    const bars: readonly Bar[] = Object.freeze([
      { t: 1_700_000_000_000, open: "6400000", high: "6410000", low: "6390000", close: "6405000", volume: "100000000" },
      { t: 1_700_000_060_000, open: "6405000", high: "6420000", low: "6400000", close: "6415000", volume: "200000000" },
    ]);
    const before = JSON.stringify(barsToCandles(bars, 2));
    fc.assert(
      fc.property(zone, (timeZone) => {
        for (const b of bars) {
          formatClock(b.t, { timeZone });
          formatChartTime(b.t / 1000, { timeZone });
        }
        expect(JSON.stringify(barsToCandles(bars, 2))).toBe(before);
        expect(barsToCandles(bars, 2).map((c) => c.time as number)).toEqual(
          bars.map((b) => Math.floor(b.t / 1000)),
        );
      }),
      { numRuns: 30 },
    );
  });
});
