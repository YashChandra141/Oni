// Req 27.3, 27.4: watchlist cycling, keys, and price direction.
import { describe, expect, test } from "bun:test";
import { initialState, withSymbol } from "./store";
import { displayVenue } from "./status";
import {
  DEFAULT_WATCHLIST,
  changeIndicator,
  nextSymbol,
  prevSymbol,
  symbolForKey,
  watchlistSymbols,
} from "./watchlist";

const LIST = DEFAULT_WATCHLIST;

describe("nextSymbol / prevSymbol", () => {
  test("wrap around", () => {
    expect(nextSymbol("BTC-USD", LIST)).toBe("ETH-USD");
    expect(nextSymbol("SOL-USD", LIST)).toBe("BTC-USD");
    expect(prevSymbol("ETH-USD", LIST)).toBe("BTC-USD");
    expect(prevSymbol("BTC-USD", LIST)).toBe("SOL-USD");
  });

  test("unknown current and empty list", () => {
    expect(nextSymbol("X", LIST)).toBe("BTC-USD");
    expect(prevSymbol("X", LIST)).toBe("SOL-USD");
    expect(nextSymbol("X", [])).toBe("X");
  });
});

describe("watchlistSymbols", () => {
  test("defaults when no instruments", () => {
    expect(watchlistSymbols({})).toEqual(["BTC-USD", "ETH-USD", "SOL-USD"]);
    expect(watchlistSymbols({ "ETH-USD": 1 })).toEqual(["ETH-USD"]);
  });
});

describe("symbolForKey", () => {
  test("Tab and Shift+Tab", () => {
    expect(symbolForKey({ key: "Tab" }, "BTC-USD", LIST)).toBe("ETH-USD");
    expect(symbolForKey({ key: "Tab", shiftKey: true }, "BTC-USD", LIST)).toBe("SOL-USD");
  });

  test("other keys give null", () => {
    expect(symbolForKey({ key: "a" }, "BTC-USD", LIST)).toBeNull();
    expect(symbolForKey({ key: "ArrowDown" }, "BTC-USD", LIST)).toBeNull();
  });

  test("ignored in inputs and with modifiers", () => {
    expect(symbolForKey({ key: "Tab", target: { tagName: "INPUT" } }, "BTC-USD", LIST)).toBeNull();
    expect(symbolForKey({ key: "Tab", ctrlKey: true }, "BTC-USD", LIST)).toBeNull();
    expect(symbolForKey({ key: "Tab", defaultPrevented: true }, "BTC-USD", LIST)).toBeNull();
  });
});

describe("displayVenue", () => {
  const base = { protocolVersion: 2, engineRunning: true } as const;
  test("labels", () => {
    expect(displayVenue({ ...base, dataMode: "replay", venue: null })).toBe("REPLAY");
    expect(displayVenue({ ...base, dataMode: "live", venue: "backpack" })).toBe("LIVE · Backpack (USDC)");
    expect(displayVenue({ ...base, dataMode: "live", venue: "coinbase" })).toBe("LIVE · Coinbase");
    expect(displayVenue({ ...base, dataMode: "live", venue: null })).toBe("LIVE");
  });
});

describe("changeIndicator", () => {
  test("direction by BigInt comparison", () => {
    expect(changeIndicator("100", "101")).toBe("up");
    expect(changeIndicator("9007199254740993", "9007199254740992")).toBe("down");
    expect(changeIndicator("5", "5")).toBe("flat");
    expect(changeIndicator(undefined, "5")).toBe("flat");
    expect(changeIndicator("x", "5")).toBe("flat");
  });
});

describe("store symbol switch", () => {
  test("changes the selection and clears the book cursor", () => {
    const state = { ...initialState(), bookCursor: { side: "bid", index: 2 } as const };
    const next = withSymbol(state, "ETH-USD");
    expect(next.selection.symbol).toBe("ETH-USD");
    expect(next.bookCursor).toBeNull();
  });

  test("selecting the same symbol keeps the state", () => {
    const state = initialState();
    expect(withSymbol(state, state.selection.symbol)).toBe(state);
  });
});
