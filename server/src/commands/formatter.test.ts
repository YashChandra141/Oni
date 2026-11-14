// Command_Formatter unit tests (Req 21.6). The round-trip property P22 is Task 12.2.
import { describe, expect, test } from "bun:test";
import { formatCommand, normalizeSource, unitsToFixed, unitsToTrimmed } from "./formatter.ts";
import { type ParsedCommand, parseCommand } from "./parser.ts";

const ctx = { positionLots: (symbol: string) => (symbol === "BTC-USD" ? 200_000_000n : 0n) };

function parsed(text: string): ParsedCommand {
  const r = parseCommand(text, ctx);
  if (!r.ok) throw new Error(`parse failed for "${text}": ${r.error.message}`);
  return r.command;
}

describe("unit formatting", () => {
  test("unitsToFixed keeps every decimal", () => {
    expect(unitsToFixed(6_400_000n, 2)).toBe("64000.00");
    expect(unitsToFixed(1n, 2)).toBe("0.01");
    expect(unitsToFixed(0n, 2)).toBe("0.00");
    expect(unitsToFixed(5n, 0)).toBe("5");
  });

  test("unitsToTrimmed drops trailing fraction zeros and a bare point", () => {
    expect(unitsToTrimmed(10_000_000n, 8)).toBe("0.1");
    expect(unitsToTrimmed(1n, 8)).toBe("0.00000001");
    expect(unitsToTrimmed(250_000_000n, 8)).toBe("2.5");
    expect(unitsToTrimmed(100_000_000n, 8)).toBe("1");
    expect(unitsToTrimmed(10_000_000_000n, 8)).toBe("100");
  });
});

describe("canonical text", () => {
  test("matches the design example", () => {
    expect(formatCommand(parsed("buy btc 0.1 lmt 64000"))).toBe("BUY BTC-USD 0.1 LMT 64000.00");
  });

  test("market, limit, and stop orders", () => {
    expect(formatCommand(parsed("sell sol 1.50"))).toBe("SELL SOL-USD 1.5");
    expect(formatCommand(parsed("SELL ETH 2 STP 3000.5"))).toBe("SELL ETH-USD 2 STP 3000.50");
    expect(formatCommand(parsed("BUY BTC 0.00000001 LMT 0.01"))).toBe("BUY BTC-USD 0.00000001 LMT 0.01");
  });

  test("CANCEL ALL and FLAT", () => {
    expect(formatCommand({ kind: "cancel_all" })).toBe("CANCEL ALL");
    expect(formatCommand({ kind: "flatten_all" })).toBe("FLAT");
  });

  test("a percent amount prints the resolved quantity", () => {
    expect(formatCommand(parsed("SELL BTC 50%"))).toBe("SELL BTC-USD 1");
  });

  test("an unknown symbol is refused", () => {
    expect(() =>
      formatCommand({ kind: "place", side: "buy", symbol: "XRP-USD", qty: 1n, order: { type: "market" }, source: "absolute" }),
    ).toThrow(RangeError);
  });
});

describe("round trips (Req 21.9)", () => {
  const texts = [
    "BUY BTC 0.1",
    "sell eth-usd 12.34567891 lmt 3000.5",
    "BUY SOL 100 STP 150.25",
    "SELL BTC 0.00000001 LMT 0.01",
    "BUY BTC 92233720368.54775807",
    "CANCEL ALL",
    "flat",
  ];

  test("parse(format(c)) equals c, and format is stable", () => {
    for (const text of texts) {
      const c = parsed(text);
      const formatted = formatCommand(c);
      expect(parsed(formatted)).toEqual(c);
      expect(formatCommand(parsed(formatted))).toBe(formatted);
    }
  });

  test("a percent command round-trips as its resolved absolute form", () => {
    const c = parsed("SELL BTC 33.5%");
    expect(c).toMatchObject({ source: { percent: "33.5" } });
    expect(parsed(formatCommand(c))).toEqual(normalizeSource(c));
  });
});
