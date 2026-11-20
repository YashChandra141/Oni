// Pure order book and tape helpers (Task 8.3, Req 27.1, 27.2, 30.1).
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { ServerMessage } from "../../shared/protocol/index";
import { applyServerMessage, initialState, type TapeEntry, type TerminalState } from "./store";
import {
  TAPE_ROWS,
  bookKeyAction,
  depthFractions,
  formatTimeUtc,
  layoutBook,
  levelAtCursor,
  moveBookCursor,
  tapeRows,
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

// Bug condition exploration (chart-and-tape-fix Task 1.8, Property 7). Expected to FAIL on
// unfixed code: TradesTape keys rows by `${ts}-${index}`, so every row key shifts on a new trade.
// Requirements 1.10, 2.11.
describe("Property 7: bounded tape with stable keys", () => {
  /** The ONE place that holds the tape row key rule. Task 6.3/8.4: swap for the stable store id. */
  const rowKey = (entry: TapeEntry, _index: number): string => String(entry.id);

  /** The rows TradesTape renders for the selected symbol, with their keys. */
  function shownRows(state: TerminalState): { entry: TapeEntry; key: string }[] {
    return state.tape
      .filter((t) => t.symbol === state.selection.symbol)
      .slice(0, TAPE_ROWS)
      .map((entry, index) => ({ entry, key: rowKey(entry, index) }));
  }

  const tradeMsg = (symbol: string, ts: number, price: number): ServerMessage =>
    ({
      type: "event",
      event: { type: "trade", symbol, price: String(price), qty: "1000000", side: "buy", ts },
    }) as ServerMessage;

  const symbols = ["BTC-USD", "ETH-USD"];

  test("existing row keys stay, the new row is on top, and at most 50 rows show", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.constantFrom(...symbols), fc.integer({ min: 1, max: 5000 })), {
          minLength: 1,
          maxLength: 120,
        }),
        fc.integer({ min: 1, max: 5000 }),
        (seq, lastGap) => {
          let state = initialState();
          let ts = 1_000;
          let price = 6_400_000;
          for (const [symbol, gap] of seq) {
            ts += gap;
            price += 1;
            state = applyServerMessage(state, tradeMsg(symbol, ts, price));
          }
          // Make sure at least one row of the selected symbol exists.
          ts += 1;
          state = applyServerMessage(state, tradeMsg(state.selection.symbol, ts, ++price));
          const before = shownRows(state);
          expect(before.length).toBeLessThanOrEqual(TAPE_ROWS);

          ts += lastGap;
          state = applyServerMessage(state, tradeMsg(state.selection.symbol, ts, ++price));
          const after = shownRows(state);

          expect(after.length).toBeLessThanOrEqual(TAPE_ROWS);
          // Newest first: the new trade is the top row.
          expect(after[0]?.entry.ts).toBe(ts);
          // Rows already shown keep their keys.
          const afterKeys = new Map(after.map((row) => [row.entry, row.key]));
          for (const row of before) {
            const key = afterKeys.get(row.entry);
            if (key !== undefined) expect(key).toBe(row.key);
          }
          // Newest first order by ts.
          for (let i = 1; i < after.length; i += 1) {
            expect(after[i - 1]!.entry.ts).toBeGreaterThanOrEqual(after[i]!.entry.ts);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// Task 6.7, Property 7: bounded tape with stable keys. Validates: Requirements 2.11
describe("Property 7 (fix check): tapeRows is bounded with stable ids", () => {
  const syms = ["BTC-USD", "ETH-USD", "SOL-USD"];
  const trade = (symbol: string, ts: number): ServerMessage =>
    ({
      type: "event",
      event: { type: "trade", symbol, price: "6400000", qty: "1000000", side: "buy", ts },
    }) as ServerMessage;

  test("store holds at most 200 newest first, ids unique, decreasing, stable; rows <= 50", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...syms), { minLength: 1, maxLength: 400 }),
        fc.constantFrom(...syms),
        fc.constantFrom(...syms),
        (seq, selected, extraSymbol) => {
          let state = initialState();
          let ts = 1_000;
          const seen = new Map<number, TapeEntry>();
          for (const symbol of seq) {
            ts += 1;
            state = applyServerMessage(state, trade(symbol, ts));
            expect(state.tape.length).toBeLessThanOrEqual(200);
            for (let i = 0; i < state.tape.length; i += 1) {
              const entry = state.tape[i]!;
              if (i > 0) expect(state.tape[i - 1]!.id).toBeGreaterThan(entry.id);
              const prior = seen.get(entry.id);
              if (prior !== undefined) expect(prior).toBe(entry);
              seen.set(entry.id, entry);
            }
            expect(state.tape[0]!.ts).toBe(ts);
          }
          const previous = tapeRows(state.tape, selected);
          expect(previous.length).toBeLessThanOrEqual(TAPE_ROWS);
          expect(previous.every((e) => e.symbol === selected)).toBe(true);

          // Interleave a trade of another symbol, then one of the selected symbol.
          ts += 1;
          state = applyServerMessage(state, trade(extraSymbol, ts));
          ts += 1;
          state = applyServerMessage(state, trade(selected, ts));
          const created = state.tape[0]!;
          const after = tapeRows(state.tape, selected);
          const alsoOther = extraSymbol === selected ? 1 : 0;
          // The extra trade of the selected symbol (if same) sits right below `created`.
          const expected = (
            alsoOther === 1 ? [created, state.tape[1]!, ...previous] : [created, ...previous]
          )
            .slice(0, TAPE_ROWS)
            .map((e) => e.id);
          expect(after.map((e) => e.id)).toEqual(expected);
          expect(after.length).toBeLessThanOrEqual(TAPE_ROWS);
          expect(after.every((e) => e.symbol === selected)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});
