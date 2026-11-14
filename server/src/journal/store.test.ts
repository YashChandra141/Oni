import { describe, expect, test } from "bun:test";
import { compareRows, mergeJournal } from "./store.ts";

const row = (ts: number, seq: number) => ({ ts: BigInt(ts), seq: BigInt(seq) });

describe("mergeJournal", () => {
  test("sorts ascending by (ts, seq) across parts", () => {
    const merged = mergeJournal([[row(2, 3), row(1, 1)], [row(2, 2)], [row(3, 4)]], 10);
    expect(merged.map((r) => [r.ts, r.seq])).toEqual([
      [1n, 1n],
      [2n, 2n],
      [2n, 3n],
      [3n, 4n],
    ]);
  });

  test("keeps the most recent `limit` rows", () => {
    const merged = mergeJournal([[row(1, 1), row(2, 2)], [row(3, 3), row(4, 4)]], 2);
    expect(merged.map((r) => r.seq)).toEqual([3n, 4n]);
  });

  test("ties on ts break by seq", () => {
    expect([row(5, 2), row(5, 1)].sort(compareRows).map((r) => r.seq)).toEqual([1n, 2n]);
  });

  test("does not modify its input and handles limit 0", () => {
    const part = [row(2, 2), row(1, 1)];
    expect(mergeJournal([part], 0)).toEqual([]);
    expect(part.map((r) => r.seq)).toEqual([2n, 1n]);
  });
});
