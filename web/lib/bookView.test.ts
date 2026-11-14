// Pure order book and tape helpers (Task 8.3, Req 27.1, 27.2, 30.1).
import { describe, expect, test } from "bun:test";
import {
  bookKeyAction,
  depthFractions,
  formatTimeUtc,
  layoutBook,
  levelAtCursor,
  moveBookCursor,
} from "./bookView";

const lv = (price: string, qty: string) => ({ price, qty });

describe("depthFractions", () => {
  test("largest level is 1000 and others are proportional", () => {
    expect(depthFractions([lv("1", "50"), lv("2", "100"), lv("3", "25")])).toEqual([500, 1000, 250]);
  });

  test("zero quantity is 0, all zero gives zeros, empty gives empty", () => {
    expect(depthFractions([lv("1", "0"), lv("2", "10")])).toEqual([0, 1000]);
    expect(depthFractions([lv("1", "0")])).toEqual([0]);
    expect(depthFractions([])).toEqual([]);
  });

  test("is exact beyond 2^53", () => {
    const big = "90071992547409930000";
    const half = "45035996273704965000";
    expect(depthFractions([lv("1", big), lv("2", half)])).toEqual([1000, 500]);
  });
});

describe("layoutBook", () => {
  const book = {
    asks: [lv("101", "1"), lv("102", "1"), lv("103", "1")],
    bids: [lv("100", "1"), lv("99", "1"), lv("98", "1")],
  };

  test("reverses asks so the best ask is last, keeps bids best first", () => {
    const layout = layoutBook(book, 10);
    expect(layout.asks.map((l) => l.price)).toEqual(["103", "102", "101"]);
    expect(layout.bids.map((l) => l.price)).toEqual(["100", "99", "98"]);
  });

  test("keeps the best maxLevels of each side", () => {
    const layout = layoutBook(book, 2);
    expect(layout.asks.map((l) => l.price)).toEqual(["102", "101"]);
    expect(layout.bids.map((l) => l.price)).toEqual(["100", "99"]);
  });

  test("undefined book is empty", () => {
    expect(layoutBook(undefined)).toEqual({ asks: [], bids: [] });
  });
});

describe("moveBookCursor", () => {
  test("starts at best ask on Up and best bid on Down", () => {
    expect(moveBookCursor(null, 3, 3, "up")).toEqual({ side: "ask", index: 2 });
    expect(moveBookCursor(null, 3, 3, "down")).toEqual({ side: "bid", index: 0 });
  });

  test("walks asks then bids", () => {
    expect(moveBookCursor({ side: "ask", index: 2 }, 3, 3, "down")).toEqual({ side: "bid", index: 0 });
    expect(moveBookCursor({ side: "bid", index: 0 }, 3, 3, "up")).toEqual({ side: "ask", index: 2 });
    expect(moveBookCursor({ side: "ask", index: 1 }, 3, 3, "up")).toEqual({ side: "ask", index: 0 });
  });

  test("clamps at both ends", () => {
    const top = { side: "ask", index: 0 } as const;
    const bottom = { side: "bid", index: 2 } as const;
    expect(moveBookCursor(top, 3, 3, "up")).toBe(top);
    expect(moveBookCursor(bottom, 3, 3, "down")).toBe(bottom);
  });

  test("handles one empty side and an empty book", () => {
    expect(moveBookCursor(null, 0, 2, "up")).toEqual({ side: "bid", index: 0 });
    expect(moveBookCursor(null, 2, 0, "down")).toEqual({ side: "ask", index: 1 });
    expect(moveBookCursor(null, 0, 0, "down")).toBeNull();
  });
});

describe("levelAtCursor", () => {
  const layout = { asks: [lv("102", "1"), lv("101", "1")], bids: [lv("100", "1")] };
  test("finds the displayed level or null", () => {
    expect(levelAtCursor(layout, { side: "ask", index: 1 })?.price).toBe("101");
    expect(levelAtCursor(layout, { side: "bid", index: 0 })?.price).toBe("100");
    expect(levelAtCursor(layout, { side: "bid", index: 5 })).toBeNull();
    expect(levelAtCursor(layout, null)).toBeNull();
  });
});

describe("formatTimeUtc", () => {
  test("formats HH:MM:SS in UTC", () => {
    expect(formatTimeUtc(Date.UTC(2026, 0, 2, 3, 4, 5, 999))).toBe("03:04:05");
    expect(formatTimeUtc(0)).toBe("00:00:00");
  });
  test("invalid input gives a placeholder", () => {
    expect(formatTimeUtc(Number.NaN)).toBe("--:--:--");
    expect(formatTimeUtc(8.64e15 + 1)).toBe("--:--:--");
  });
});

describe("bookKeyAction", () => {
  test("maps Up, Down, Enter through the book context", () => {
    expect(bookKeyAction({ key: "ArrowUp" }, false)).toBe("up");
    expect(bookKeyAction({ key: "ArrowDown" }, false)).toBe("down");
    expect(bookKeyAction({ key: "Enter" }, false)).toBe("prefill");
  });
  test("ignores other keys, modifiers, and text inputs", () => {
    expect(bookKeyAction({ key: "Tab" }, false)).toBeNull();
    expect(bookKeyAction({ key: "b" }, false)).toBeNull();
    expect(bookKeyAction({ key: "ArrowUp", ctrlKey: true }, false)).toBeNull();
    expect(bookKeyAction({ key: "Enter" }, true)).toBeNull();
  });
});
