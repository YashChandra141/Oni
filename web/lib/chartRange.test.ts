// Zoom and pan range math (Task 5.4, Req 29.1, 29.2).
import { describe, expect, test } from "bun:test";
import {
  INITIAL_VISIBLE_BARS,
  MAX_VISIBLE_BARS,
  MIN_VISIBLE_BARS,
  PAN_FRACTION,
  RIGHT_PADDING_BARS,
  ZOOM_IN_FACTOR,
  ZOOM_OUT_FACTOR,
  initialVisibleRange,
  panRange,
  zoomRange,
} from "./chartRange";

const width = (r: { from: number; to: number }) => r.to - r.from;
const center = (r: { from: number; to: number }) => r.from + (r.to - r.from) / 2;

describe("zoomRange", () => {
  test("a factor above 1 zooms in around the centre", () => {
    expect(zoomRange({ from: 0, to: 100 }, 2)).toEqual({ from: 25, to: 75 });
    expect(zoomRange({ from: 0, to: 100 }, ZOOM_IN_FACTOR)).toEqual({ from: 10, to: 90 });
  });

  test("a factor below 1 zooms out around the centre", () => {
    expect(zoomRange({ from: 0, to: 100 }, 0.5)).toEqual({ from: -50, to: 150 });
  });

  test("the centre stays put for any factor", () => {
    for (const factor of [0.4, 0.8, 1.25, 3]) {
      const next = zoomRange({ from: 40, to: 140 }, factor);
      expect(center(next)).toBeCloseTo(90, 9);
    }
  });

  test("zoom in then zoom out returns to the same width", () => {
    const start = { from: 380, to: 500 };
    const back = zoomRange(zoomRange(start, ZOOM_IN_FACTOR), ZOOM_OUT_FACTOR);
    expect(width(back)).toBeCloseTo(width(start), 9);
    expect(center(back)).toBeCloseTo(center(start), 9);
  });

  test("zooming in stops at the minimum width", () => {
    let range = { from: 0, to: 100 };
    for (let i = 0; i < 60; i += 1) range = zoomRange(range, ZOOM_IN_FACTOR);
    expect(width(range)).toBeCloseTo(MIN_VISIBLE_BARS, 9);
  });

  test("zooming out stops at the maximum width", () => {
    let range = { from: 0, to: 100 };
    for (let i = 0; i < 80; i += 1) range = zoomRange(range, ZOOM_OUT_FACTOR);
    expect(width(range)).toBeCloseTo(MAX_VISIBLE_BARS, 6);
  });

  test("a range already narrower than the minimum does not widen when zooming in", () => {
    expect(zoomRange({ from: 0, to: 4 }, 2)).toEqual({ from: 0, to: 4 });
  });

  test("a range already wider than the maximum does not narrow when zooming out", () => {
    const wide = { from: 0, to: MAX_VISIBLE_BARS * 2 };
    expect(zoomRange(wide, 0.5)).toEqual(wide);
  });

  test("a factor of 1 keeps the width", () => {
    expect(zoomRange({ from: 10, to: 60 }, 1)).toEqual({ from: 10, to: 60 });
  });

  test("an unusable range or factor returns the range unchanged", () => {
    const range = { from: 10, to: 60 };
    expect(zoomRange(range, 0)).toBe(range);
    expect(zoomRange(range, -2)).toBe(range);
    expect(zoomRange(range, Number.NaN)).toBe(range);
    const empty = { from: 5, to: 5 };
    expect(zoomRange(empty, 2)).toBe(empty);
    const reversed = { from: 9, to: 3 };
    expect(zoomRange(reversed, 2)).toBe(reversed);
    const nan = { from: Number.NaN, to: 3 };
    expect(zoomRange(nan, 2)).toBe(nan);
  });
});

describe("panRange", () => {
  test("a positive fraction moves forward, a negative one back", () => {
    expect(panRange({ from: 0, to: 100 }, 0.2)).toEqual({ from: 20, to: 120 });
    expect(panRange({ from: 0, to: 100 }, -0.2)).toEqual({ from: -20, to: 80 });
  });

  test("the width never changes", () => {
    for (const fraction of [-1, -PAN_FRACTION, 0, PAN_FRACTION, 0.75]) {
      const next = panRange({ from: 12, to: 62 }, fraction);
      expect(width(next)).toBeCloseTo(50, 9);
    }
  });

  test("pan forward then back returns to the start", () => {
    const start = { from: 380, to: 500 };
    const back = panRange(panRange(start, PAN_FRACTION), -PAN_FRACTION);
    expect(back.from).toBeCloseTo(start.from, 9);
    expect(back.to).toBeCloseTo(start.to, 9);
  });

  test("an unusable range or fraction returns the range unchanged", () => {
    const range = { from: 10, to: 60 };
    expect(panRange(range, Number.NaN)).toBe(range);
    expect(panRange(range, Number.POSITIVE_INFINITY)).toBe(range);
    const empty = { from: 5, to: 5 };
    expect(panRange(empty, 0.2)).toBe(empty);
  });
});

describe("initialVisibleRange", () => {
  test("returns null when every bar fits", () => {
    expect(initialVisibleRange(0)).toBeNull();
    expect(initialVisibleRange(50)).toBeNull();
    expect(initialVisibleRange(INITIAL_VISIBLE_BARS)).toBeNull();
  });

  test("shows the last bars plus right padding", () => {
    expect(initialVisibleRange(500)).toEqual({
      from: 500 - INITIAL_VISIBLE_BARS,
      to: 499 + RIGHT_PADDING_BARS,
    });
  });

  test("one bar more than the visible count is the first case that needs a window", () => {
    expect(initialVisibleRange(INITIAL_VISIBLE_BARS + 1)).toEqual({
      from: 1,
      to: INITIAL_VISIBLE_BARS + RIGHT_PADDING_BARS,
    });
  });

  test("honours a custom visible count", () => {
    expect(initialVisibleRange(30, 10)).toEqual({ from: 20, to: 29 + RIGHT_PADDING_BARS });
  });

  test("a non-integer count gives null", () => {
    expect(initialVisibleRange(Number.NaN)).toBeNull();
    expect(initialVisibleRange(200.5)).toBeNull();
  });
});
