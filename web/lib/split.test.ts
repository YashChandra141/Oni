import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { applyDrag, clampSizes, parseStored } from "./split";

const sum = (a: readonly number[]) => a.reduce((x, y) => x + y, 0);

describe("clampSizes", () => {
  test("raises small panes and keeps the sum at 100", () => {
    const out = clampSizes([5, 70, 25], [12, 30, 14]);
    expect(out[0]!).toBeGreaterThanOrEqual(12);
    expect(sum(out)).toBeCloseTo(100, 6);
  });
});

describe("applyDrag", () => {
  test("moves the gutter", () => {
    expect(applyDrag([20, 60, 20], 0, 5, [12, 30, 14])).toEqual([25, 55, 20]);
  });
  test("stops at the minimum", () => {
    expect(applyDrag([20, 60, 20], 0, -50, [12, 30, 14])).toEqual([12, 68, 20]);
    expect(applyDrag([20, 60, 20], 1, 50, [12, 30, 14])).toEqual([20, 66, 14]);
  });
  test("keeps the sum and the minimums for any delta", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1 }), fc.double({ min: -200, max: 200, noNaN: true }), (i, d) => {
        const min = [12, 30, 14];
        const out = applyDrag([20, 60, 20], i, d, min);
        expect(sum(out)).toBeCloseTo(100, 6);
        out.forEach((s, k) => expect(s).toBeGreaterThanOrEqual(min[k]! - 1e-9));
      }),
    );
  });
});

describe("parseStored", () => {
  test("accepts a valid array", () => {
    expect(parseStored("[20,60,20]", 3)).toEqual([20, 60, 20]);
  });
  test("rejects bad input", () => {
    expect(parseStored(null, 3)).toBeNull();
    expect(parseStored("nope", 3)).toBeNull();
    expect(parseStored("[20,60,20]", 2)).toBeNull();
    expect(parseStored("[20,60,30]", 3)).toBeNull();
    expect(parseStored('[20,"60",20]', 3)).toBeNull();
    expect(parseStored("[-20,100,20]", 3)).toBeNull();
  });
});
