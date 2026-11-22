// Pure order entry helpers (Task 12.3, Req 28, 30.2, 31.3).
import { describe, expect, test } from "bun:test";
import {
  MAX_HISTORY,
  addUnits,
  cancelAllMessage,
  cancelMessage,
  commandTextMessage,
  confirmMessage,
  discardMessage,
  flattenAllMessage,
  formatMoney,
  historyStep,
  nextRequestId,
  parseDecimalUnits,
  pnlClass,
  previewActionLabel,
  previewDeadline,
  previewSecondsLeft,
  pushHistory,
  realizedTotal,
  rejectionText,
  sumMoney,
  ticketToCommandText,
  unrealizedTotal,
} from "./orderEntry";

describe("ticketToCommandText", () => {
  test("limit order uses the canonical form of the server formatter", () => {
    const result = ticketToCommandText({ symbol: "BTC-USD", price: "6400000", qty: "10000000" }, "buy");
    expect(result).toEqual({ ok: true, text: "BUY BTC-USD 0.1 LMT 64000.00" });
  });

  test("a ticket with no price is a market order", () => {
    expect(ticketToCommandText({ symbol: "BTC-USD", price: null, qty: "10000000" }, "buy")).toEqual({
      ok: true,
      text: "BUY BTC-USD 0.1",
    });
    expect(ticketToCommandText({ symbol: "ETH-USD", price: null, qty: "100000000" }, "sell")).toEqual({
      ok: true,
      text: "SELL ETH-USD 1",
    });
  });

  test("trims trailing zeros of the quantity and keeps the price decimals", () => {
    expect(ticketToCommandText({ symbol: "SOL-USD", price: "15025", qty: "25000000000" }, "sell")).toEqual({
      ok: true,
      text: "SELL SOL-USD 250 LMT 150.25",
    });
    expect(ticketToCommandText({ symbol: "SOL-USD", price: null, qty: "1" }, "buy")).toEqual({
      ok: true,
      text: "BUY SOL-USD 0.00000001",
    });
  });

  test("uses the instrument decimals it is given", () => {
    const result = ticketToCommandText(
      { symbol: "BTC-USD", price: "64000", qty: "25" },
      "buy",
      { priceDecimals: 1, qtyDecimals: 1 },
    );
    expect(result).toEqual({ ok: true, text: "BUY BTC-USD 2.5 LMT 6400.0" });
  });

  test("rejects incomplete or invalid tickets", () => {
    const bad = [
      { symbol: "BTC-USD", price: null, qty: null },
      { symbol: "BTC-USD", price: null, qty: "0" },
      { symbol: "BTC-USD", price: null, qty: "-5" },
      { symbol: "BTC-USD", price: null, qty: "1.5" },
      { symbol: "BTC-USD", price: "0", qty: "10" },
      { symbol: "BTC-USD", price: "abc", qty: "10" },
      { symbol: "BTC-USD", price: "-1", qty: "10" },
      { symbol: "", price: null, qty: "10" },
      { symbol: "btc", price: null, qty: "10" },
      { symbol: "BTC-USD", price: null, qty: "9223372036854775808" },
    ];
    for (const ticket of bad) expect(ticketToCommandText(ticket, "buy").ok).toBe(false);
  });
});

describe("parseDecimalUnits", () => {
  test("converts typed decimals to integer units", () => {
    expect(parseDecimalUnits("0.1", 8)).toBe("10000000");
    expect(parseDecimalUnits("1", 8)).toBe("100000000");
    expect(parseDecimalUnits(" 2.50 ", 2)).toBe("250");
    expect(parseDecimalUnits("0.00000001", 8)).toBe("1");
  });

  test("rejects too many decimals, zero, signs, and non-numbers", () => {
    for (const text of ["0.000000001", "0", "0.00", "-1", ".5", "1.", "abc", "", "1e3", "1,5"]) {
      expect(parseDecimalUnits(text, 8)).toBeNull();
    }
    expect(parseDecimalUnits("1.5", 0)).toBeNull();
  });
});

describe("command history", () => {
  test("pushHistory skips blank text and consecutive duplicates", () => {
    let history: readonly string[] = [];
    history = pushHistory(history, "BUY BTC 1");
    history = pushHistory(history, "BUY BTC 1");
    history = pushHistory(history, "   ");
    history = pushHistory(history, "FLAT");
    history = pushHistory(history, "BUY BTC 1");
    expect(history).toEqual(["BUY BTC 1", "FLAT", "BUY BTC 1"]);
  });

  test("pushHistory keeps the last 50 entries", () => {
    let history: readonly string[] = [];
    for (let i = 0; i < 60; i += 1) history = pushHistory(history, `c${i}`);
    expect(history.length).toBe(MAX_HISTORY);
    expect(history[0]).toBe("c10");
    expect(history[history.length - 1]).toBe("c59");
  });

  test("historyStep walks back from the newest entry and forward to the draft", () => {
    const history = ["a", "b", "c"];
    expect(historyStep(history, null, "prev")).toEqual({ index: 2, text: "c" });
    expect(historyStep(history, 2, "prev")).toEqual({ index: 1, text: "b" });
    expect(historyStep(history, 0, "prev")).toEqual({ index: 0, text: "a" });
    expect(historyStep(history, 0, "next")).toEqual({ index: 1, text: "b" });
    expect(historyStep(history, 2, "next")).toEqual({ index: null, text: null });
    expect(historyStep(history, null, "next")).toEqual({ index: null, text: null });
  });

  test("historyStep with an empty history does nothing", () => {
    expect(historyStep([], null, "prev")).toEqual({ index: null, text: null });
    expect(historyStep([], null, "next")).toEqual({ index: null, text: null });
  });
});

describe("preview countdown", () => {
  test("trusts expires_at inside the server TTL", () => {
    expect(previewDeadline(1_060_000, 1_000_000)).toBe(1_060_000);
  });

  test("falls back to 60 s from first sight when the clocks disagree", () => {
    expect(previewDeadline(1_000_000 - 10, 1_000_000)).toBe(1_060_000);
    expect(previewDeadline(1_000_000 + 3_600_000, 1_000_000)).toBe(1_060_000);
  });

  test("previewSecondsLeft rounds up and stops at 0", () => {
    expect(previewSecondsLeft(11_500, 10_000)).toBe(2);
    expect(previewSecondsLeft(10_000, 10_000)).toBe(0);
    expect(previewSecondsLeft(9_000, 10_000)).toBe(0);
  });

  test("labels follow the action", () => {
    expect(previewActionLabel({ type: "place" })).toBe("PLACE PAPER ORDER");
    expect(previewActionLabel({ type: "cancel_all" })).toBe("CANCEL ALL OPEN ORDERS");
    expect(previewActionLabel({ type: "flatten_all" })).toBe("FLATTEN ALL POSITIONS");
  });
});

describe("P&L", () => {
  test("totals sum with BigInt", () => {
    expect(unrealizedTotal({ A: { unrealized: "5" }, B: { unrealized: "-2" } })).toBe("3");
    expect(unrealizedTotal({})).toBe("0");
    expect(realizedTotal({ A: { realized: "9007199254740993" }, B: { realized: "1" } })).toBe(
      "9007199254740994",
    );
    expect(sumMoney(["1", "x", "-4"])).toBe("-3");
    expect(addUnits("7", "-10")).toBe("-3");
  });

  test("formatMoney shows 2 places, truncating toward zero", () => {
    expect(formatMoney("123456789012")).toBe("12.34");
    expect(formatMoney("-5000000000")).toBe("-0.50");
    expect(formatMoney("-1")).toBe("0.00");
    expect(formatMoney("0")).toBe("0.00");
    expect(formatMoney(undefined)).toBe("—");
    expect(formatMoney("abc")).toBe("—");
  });

  test("pnlClass colors gains and losses", () => {
    expect(pnlClass("10")).toBe("text-buy");
    expect(pnlClass("-10")).toBe("text-sell");
    expect(pnlClass("0")).toBe("text-phosphor-dim");
  });

  test("rejectionText reads reason codes as words", () => {
    expect(rejectionText("max_order_value")).toBe("max order value");
  });
});

describe("messages", () => {
  test("builders produce the wire shapes", () => {
    expect(commandTextMessage("r1", "FLAT")).toEqual({
      type: "command_text",
      request_id: "r1",
      text: "FLAT",
      venue: null,
    });
    expect(commandTextMessage("r1", "FLAT", "coinbase")).toEqual({
      type: "command_text",
      request_id: "r1",
      text: "FLAT",
      venue: "coinbase",
    });
    expect(confirmMessage("r2", "p1")).toEqual({ type: "confirm", request_id: "r2", preview_id: "p1" });
    expect(discardMessage("p1")).toEqual({ type: "discard", preview_id: "p1" });
    expect(cancelMessage("r3", "o-1")).toEqual({ type: "cancel", request_id: "r3", order_id: "o-1" });
    expect(cancelAllMessage("r4")).toEqual({ type: "cancel_all", request_id: "r4" });
    expect(flattenAllMessage("r5")).toEqual({ type: "flatten_all", request_id: "r5" });
  });

  test("request ids are unique", () => {
    const ids = new Set(Array.from({ length: 100 }, () => nextRequestId()));
    expect(ids.size).toBe(100);
  });
});
