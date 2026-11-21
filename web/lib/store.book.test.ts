// Order book and ticket slices of the Web UI store (Task 8.3, Req 27.1, 30.1).
import { describe, expect, test } from "bun:test";
import type { Event } from "../../shared/protocol/index";
import {
  applyEvent,
  initialState,
  prefillTicketFromBook,
  withBookCursorMoved,
  withSymbol,
} from "./store";

function bookEvent(symbol: string, asks: string[], bids: string[], ts = 1): Event {
  return {
    type: "book",
    venue: "replay",
    symbol,
    asks: asks.map((price) => ({ price, qty: "10" })),
    bids: bids.map((price) => ({ price, qty: "20" })),
    spread: "100",
    imbalance_bps: 250,
    synthetic: false,
    ts,
  };
}

describe("book events", () => {
  test("replace the book of that symbol only", () => {
    let state = applyEvent(initialState(), bookEvent("BTC-USD", ["101", "102"], ["100"]));
    state = applyEvent(state, bookEvent("ETH-USD", ["5"], ["4"]));
    state = applyEvent(state, bookEvent("BTC-USD", ["201"], ["200", "199"], 2));
    const btc = state.book["BTC-USD"];
    expect(btc?.asks.map((l) => l.price)).toEqual(["201"]);
    expect(btc?.bids.map((l) => l.price)).toEqual(["200", "199"]);
    expect(btc?.spread).toBe("100");
    expect(btc?.imbalanceBps).toBe(250);
    expect(btc?.ts).toBe(2);
    expect(state.book["ETH-USD"]?.asks[0]?.price).toBe("5");
  });
});

describe("prefillTicketFromBook", () => {
  test("sets symbol and limit price, keeps other fields", () => {
    const state = prefillTicketFromBook(initialState(), "SOL-USD", "15025");
    expect(state.ticket).toEqual({ symbol: "SOL-USD", side: null, price: "15025", qty: null });
  });
});

describe("book cursor", () => {
  const base = applyEvent(initialState(), bookEvent("BTC-USD", ["101", "102"], ["100", "99"]));

  test("moves over asks then bids and clamps", () => {
    let s = withBookCursorMoved(base, "up");
    expect(s.bookCursor).toEqual({ side: "ask", index: 1 });
    s = withBookCursorMoved(s, "up");
    s = withBookCursorMoved(s, "up");
    expect(s.bookCursor).toEqual({ side: "ask", index: 0 });
    for (let i = 0; i < 10; i += 1) s = withBookCursorMoved(s, "down");
    expect(s.bookCursor).toEqual({ side: "bid", index: 1 });
  });

  test("no book means no cursor", () => {
    expect(withBookCursorMoved(initialState(), "down").bookCursor).toBeNull();
  });

  test("changing the symbol clears the cursor", () => {
    const moved = withBookCursorMoved(base, "up");
    expect(withSymbol(moved, "ETH-USD").bookCursor).toBeNull();
  });
});
