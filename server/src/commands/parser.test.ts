// Command_Parser unit tests (Req 4.3, 4.4, 21.1–21.5). The property tests P20–P22 are Task 12.2.
import { describe, expect, test } from "bun:test";
import { MAX_COMMAND_LENGTH, MAX_ECHO, type ParseContext, type ParseResult, parseCommand, tokenize } from "./parser.ts";

function ctxWith(positions: Record<string, bigint> = {}): ParseContext {
  return { positionLots: (symbol) => positions[symbol] ?? 0n };
}

const FLAT_CTX = ctxWith();

function ok(text: string, ctx: ParseContext = FLAT_CTX) {
  const result = parseCommand(text, ctx);
  if (!result.ok) throw new Error(`expected ok for "${text}", got: ${result.error.message} @${result.error.position}`);
  return result.command;
}

function err(text: string, ctx: ParseContext = FLAT_CTX): { message: string; position: number } {
  const result: ParseResult = parseCommand(text, ctx);
  if (result.ok) throw new Error(`expected an error for "${text}"`);
  return result.error;
}

describe("tokenize", () => {
  test("splits on whitespace and records offsets", () => {
    expect(tokenize("  BUY  BTC\t0.1 ")).toEqual([
      { text: "BUY", start: 2 },
      { text: "BTC", start: 7 },
      { text: "0.1", start: 11 },
    ]);
  });

  test("empty and blank input give no tokens", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize(" \t ")).toEqual([]);
  });
});

describe("grammar forms (Req 21.1, 21.2)", () => {
  test("market order", () => {
    expect(ok("BUY BTC 0.1")).toEqual({
      kind: "place",
      side: "buy",
      symbol: "BTC-USD",
      qty: 10_000_000n,
      order: { type: "market" },
      source: "absolute",
    });
  });

  test("limit order with the price in ticks", () => {
    expect(ok("BUY BTC 0.1 LMT 64000")).toEqual({
      kind: "place",
      side: "buy",
      symbol: "BTC-USD",
      qty: 10_000_000n,
      order: { type: "limit", price: 6_400_000n },
      source: "absolute",
    });
  });

  test("stop order with a fractional price", () => {
    expect(ok("SELL ETH 2 STP 3000.5")).toEqual({
      kind: "place",
      side: "sell",
      symbol: "ETH-USD",
      qty: 200_000_000n,
      order: { type: "stop", stopPrice: 300_050n },
      source: "absolute",
    });
  });

  test("CANCEL ALL and FLAT", () => {
    expect(ok("CANCEL ALL")).toEqual({ kind: "cancel_all" });
    expect(ok("FLAT")).toEqual({ kind: "flatten_all" });
  });

  test("keywords and symbols are case-insensitive, whitespace is flexible", () => {
    expect(ok("  sell   sol-usd  1.5  lmt  150.25 ")).toEqual({
      kind: "place",
      side: "sell",
      symbol: "SOL-USD",
      qty: 150_000_000n,
      order: { type: "limit", price: 15_025n },
      source: "absolute",
    });
    expect(ok("Cancel All")).toEqual({ kind: "cancel_all" });
    expect(ok("flat")).toEqual({ kind: "flatten_all" });
  });

  test("short and full symbols resolve to the same instrument (Req 21.4)", () => {
    for (const short of ["BTC", "ETH", "SOL"]) {
      expect(ok(`BUY ${short} 1`)).toEqual(ok(`BUY ${short}-USD 1`));
    }
  });
});

describe("decimal precision (Req 4.3, 4.4)", () => {
  test("uses the instrument's decimals with exact string arithmetic", () => {
    const cmd = ok("BUY BTC 0.00000001 LMT 0.01");
    expect(cmd).toMatchObject({ qty: 1n, order: { type: "limit", price: 1n } });
    expect(ok("BUY BTC 92233720368.54775807")).toMatchObject({ qty: 9_223_372_036_854_775_807n });
  });

  test("too many quantity decimals is an error that names the value", () => {
    const e = err("BUY BTC 0.123456789");
    expect(e.position).toBe(8);
    expect(e.message).toContain("0.123456789");
  });

  test("too many price decimals is an error that names the value", () => {
    const e = err("BUY BTC 1 LMT 64000.001");
    expect(e.position).toBe(14);
    expect(e.message).toContain("64000.001");
  });

  test("zero, malformed, and oversized amounts are errors at the token", () => {
    expect(err("BUY BTC 0").position).toBe(8);
    expect(err("BUY BTC 0.00").position).toBe(8);
    expect(err("BUY BTC abc").position).toBe(8);
    expect(err("BUY BTC -1").position).toBe(8);
    expect(err("BUY BTC .5").position).toBe(8);
    expect(err("BUY BTC 1. ").position).toBe(8);
    expect(err("BUY BTC 92233720368.54775808").position).toBe(8);
    expect(err("BUY BTC 1 LMT 0").position).toBe(14);
  });
});

describe("percent amounts (Req 21.3)", () => {
  const long = ctxWith({ "BTC-USD": 200_000_000n }); // 2 BTC long
  const short = ctxWith({ "BTC-USD": -300n });

  test("floor(|position| x percent / 100) lots, with the side as typed", () => {
    expect(ok("SELL BTC 50%", long)).toMatchObject({ side: "sell", symbol: "BTC-USD", qty: 100_000_000n, order: { type: "market" }, source: { percent: "50" } });
    expect(ok("buy btc 33.5%", long)).toMatchObject({ side: "buy", qty: 67_000_000n, source: { percent: "33.5" } });
    expect(ok("SELL BTC 100%", long)).toMatchObject({ qty: 200_000_000n });
  });

  test("a short position uses its absolute size", () => {
    expect(ok("BUY BTC 50%", short)).toMatchObject({ side: "buy", qty: 150n });
    expect(ok("BUY BTC 1%", short)).toMatchObject({ qty: 3n });
  });

  test("rounds down to a whole lot", () => {
    expect(ok("SELL BTC 50%", ctxWith({ "BTC-USD": 7n }))).toMatchObject({ qty: 3n });
  });

  test("a flat position is an error at the amount", () => {
    const e = err("SELL BTC 50%");
    expect(e.position).toBe(9);
    expect(e.message).toContain("50%");
  });

  test("an amount that rounds to zero lots is an error", () => {
    expect(err("SELL BTC 1%", ctxWith({ "BTC-USD": 50n })).position).toBe(9);
  });

  test("percent outside (0, 100] or malformed is an error", () => {
    expect(err("SELL BTC 101%", long).position).toBe(9);
    expect(err("SELL BTC 0%", long).position).toBe(9);
    expect(err("SELL BTC 0.0%", long).position).toBe(9);
    expect(err("SELL BTC %", long).position).toBe(9);
    expect(err("SELL BTC -5%", long).position).toBe(9);
    expect(err("SELL BTC 5%%", long).position).toBe(9);
  });

  test("a percent amount cannot take LMT or STP", () => {
    expect(err("SELL BTC 50% LMT 64000", long).position).toBe(13);
    expect(err("SELL BTC 50% stp 64000", long).position).toBe(13);
  });

  test("the position is read for the typed symbol only", () => {
    const seen: string[] = [];
    parseCommand("SELL ETH 10%", {
      positionLots: (s) => {
        seen.push(s);
        return 0n;
      },
    });
    expect(seen).toEqual(["ETH-USD"]);
  });
});

describe("malformed input (Req 21.5)", () => {
  test("empty and blank text: position 0", () => {
    expect(err("")).toEqual({ message: "empty command", position: 0 });
    expect(err("   ").position).toBe(0);
  });

  test("unknown first word", () => {
    expect(err("HOLD BTC 1").position).toBe(0);
    expect(err("  HOLD BTC 1").position).toBe(2);
  });

  test("a missing token is reported at the end of the text", () => {
    expect(err("BUY").position).toBe(3);
    expect(err("BUY BTC").position).toBe(7);
    expect(err("BUY BTC 0.1 LMT").position).toBe(15);
    expect(err("CANCEL").position).toBe(6);
  });

  test("unknown symbol", () => {
    const e = err("BUY NOPE 1");
    expect(e.position).toBe(4);
    expect(e.message).toContain("NOPE");
  });

  test("bad order type word", () => {
    expect(err("BUY BTC 1 FOO").position).toBe(10);
    expect(err("BUY BTC 1 FOO 5").position).toBe(10);
  });

  test("extra tokens are reported at the first extra token", () => {
    expect(err("BUY BTC 1 LMT 5 extra").position).toBe(16);
    expect(err("CANCEL ALL now").position).toBe(11);
    expect(err("FLAT now").position).toBe(5);
  });

  test("CANCEL needs ALL", () => {
    expect(err("CANCEL FOO").position).toBe(7);
  });

  test("an error offset counts from the original text, with leading whitespace", () => {
    expect(err("  BUY BTC x").position).toBe(10);
  });

  test("a failed parse never returns a command", () => {
    for (const text of ["", "BUY", "BUY BTC 0", "FLAT x", "?BUY BTC 1", "BUY BTC 1 LMT"]) {
      expect(parseCommand(text, FLAT_CTX).ok).toBe(false);
    }
  });
});

describe("error messages echo little input", () => {
  test("a long offending token is capped", () => {
    const long = "x".repeat(200);
    for (const text of [`${long} BTC 1`, `BUY ${long} 1`, `BUY BTC ${long}`, `BUY BTC 1 ${long}`, `CANCEL ${long}`]) {
      const e = err(text);
      expect(e.message).not.toContain("x".repeat(MAX_ECHO + 1));
      expect(e.message.length).toBeLessThan(120);
    }
  });

  test("text over the length limit is rejected at the limit", () => {
    const e = err(`BUY BTC 1 ${" ".repeat(MAX_COMMAND_LENGTH)}`);
    expect(e.position).toBe(MAX_COMMAND_LENGTH);
    expect(e.message).not.toContain("BUY");
  });
});
