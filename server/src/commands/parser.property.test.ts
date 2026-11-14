// Properties P20, P21, P22 for the Command_Parser and Command_Formatter (Req 21.7, 21.8, 21.9),
// plus a few unit cases that parser.test.ts does not cover.
//
// The grammar oracle below is written independently of parser.ts: it only answers "is this text
// well-formed?" and shares no code with the parser.
//
// Oracle grammar (keywords and symbols compared case-insensitively, tokens split on /\s+/):
//   text    := ws* command ws*                       and text.length <= 256
//   command := "FLAT"
//            | "CANCEL" "ALL"
//            | ("BUY"|"SELL") symbol amount [ ("LMT"|"STP") price ]   (no tail after a percent)
//   symbol  := BTC | ETH | SOL | BTC-USD | ETH-USD | SOL-USD
//   amount  := D[.D]       value > 0, <= 8 fraction digits, units <= 2^63-1
//            | D[.D] "%"   value in (0, 100], and floor(POSITION * value / 100) >= 1 lot
//   price   := D[.D]       value > 0, <= 2 fraction digits, units <= 2^63-1
//   D       := one or more ASCII digits
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { formatCommand, normalizeSource } from "./formatter.ts";
import { type ParseContext, type ParsedCommand, parseCommand } from "./parser.ts";

const NUM_RUNS = 400;
const POSITION = 10n ** 12n; // lots; the fake position for every symbol
const CTX: ParseContext = { positionLots: () => POSITION };
const I64 = 9223372036854775807n;
const SYMBOLS = ["BTC", "ETH", "SOL"] as const;
const QTY_DECIMALS = 8;
const PRICE_DECIMALS = 2;

// ---------------------------------------------------------------------------------------------
// Independent oracle
// ---------------------------------------------------------------------------------------------

const DIGITS = /^[0-9]+(\.[0-9]+)?$/;

/** Decimal text to integer units, or null when it is not D[.D] or has too many fraction digits. */
function oracleUnits(text: string, decimals: number): bigint | null {
  if (!DIGITS.test(text)) return null;
  const [whole = "", frac = ""] = text.split(".");
  if (frac.length > decimals) return null;
  return BigInt(whole + frac.padEnd(decimals, "0"));
}

function oracleAccepts(text: string): boolean {
  if (text.length > 256) return false;
  const t = text.split(/\s+/).filter((x) => x.length > 0);
  const head = t[0]?.toUpperCase();
  if (head === "FLAT") return t.length === 1;
  if (head === "CANCEL") return t.length === 2 && t[1]?.toUpperCase() === "ALL";
  if (head !== "BUY" && head !== "SELL") return false;
  if (t.length < 3) return false;
  const sym = (t[1] ?? "").toUpperCase().replace(/-USD$/, "");
  if (!(SYMBOLS as readonly string[]).includes(sym)) return false;
  const amount = t[2] ?? "";
  if (amount.endsWith("%")) {
    const body = amount.slice(0, -1);
    if (!DIGITS.test(body)) return false;
    const [whole = "", frac = ""] = body.split(".");
    const scaled = BigInt(whole + frac);
    const den = 100n * 10n ** BigInt(frac.length);
    if (scaled <= 0n || scaled > den) return false;
    if ((POSITION * scaled) / den < 1n) return false;
    return t.length === 3;
  }
  const qty = oracleUnits(amount, QTY_DECIMALS);
  if (qty === null || qty <= 0n || qty > I64) return false;
  if (t.length === 3) return true;
  const kind = (t[3] ?? "").toUpperCase();
  if (kind !== "LMT" && kind !== "STP") return false;
  if (t.length !== 5) return false;
  const price = oracleUnits(t[4] ?? "", PRICE_DECIMALS);
  return price !== null && price > 0n && price <= I64;
}

// ---------------------------------------------------------------------------------------------
// Generators for well-formed commands
// ---------------------------------------------------------------------------------------------

const flags = fc.array(fc.boolean(), { minLength: 8, maxLength: 8 });

function applyCase(word: string, f: boolean[]): string {
  return [...word].map((c, i) => (f[i] ? c.toLowerCase() : c.toUpperCase())).join("");
}

/** Renders integer units as a decimal with between "needed" and `decimals` fraction digits. */
function renderDecimal(units: bigint, decimals: number, keepRaw: number): string {
  const s = units.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals);
  const needed = frac.replace(/0+$/, "").length;
  const keep = Math.max(needed, Math.min(keepRaw, decimals));
  return keep === 0 ? whole : `${whole}.${frac.slice(0, keep)}`;
}

/** Renders hundredths of a percent as "12.34", "12.3", or "12". */
function renderPercent(hundredths: bigint, style: number): string {
  const whole = hundredths / 100n;
  const frac = (hundredths % 100n).toString().padStart(2, "0");
  if (style === 0) return `${whole}.${frac}`;
  const trimmed = frac.replace(/0+$/, "");
  return trimmed === "" ? `${whole}` : `${whole}.${trimmed}`;
}

interface Expected {
  readonly side: "buy" | "sell";
  readonly symbol: string;
  readonly qty: bigint;
  readonly order: { type: "market" } | { type: "limit"; price: bigint } | { type: "stop"; stopPrice: bigint };
}

type WellFormed =
  | { readonly tokens: string[]; readonly expected: Expected }
  | { readonly tokens: string[]; readonly expected: "cancel_all" | "flatten_all" };

const lots = fc.oneof(fc.bigInt({ min: 1n, max: 1000n }), fc.bigInt({ min: 1n, max: 10n ** 12n }));
const ticks = fc.oneof(fc.bigInt({ min: 1n, max: 1000n }), fc.bigInt({ min: 1n, max: 10n ** 10n }));
const keepDigits = fc.nat({ max: 8 });

const absoluteAmount = fc.record({
  mode: fc.constant("abs" as const),
  qty: lots,
  keep: keepDigits,
  type: fc.constantFrom("market", "limit", "stop"),
  price: ticks,
  priceKeep: keepDigits,
  typeFlags: flags,
});
const percentAmount = fc.record({
  mode: fc.constant("pct" as const),
  hundredths: fc.bigInt({ min: 1n, max: 10000n }),
  style: fc.constantFrom(0, 1),
});

const placeArb = fc
  .record({
    buy: fc.boolean(),
    sideFlags: flags,
    sym: fc.nat({ max: 2 }),
    full: fc.boolean(),
    symFlags: flags,
    amount: fc.oneof(absoluteAmount, percentAmount),
  })
  .map((r): WellFormed => {
    const short = SYMBOLS[r.sym] as string;
    const symbol = `${short}-USD`;
    const side = r.buy ? "buy" : "sell";
    const head = [applyCase(r.buy ? "BUY" : "SELL", r.sideFlags), applyCase(r.full ? symbol : short, r.symFlags)];
    if (r.amount.mode === "pct") {
      const qty = (POSITION * r.amount.hundredths) / 10000n;
      return {
        tokens: [...head, `${renderPercent(r.amount.hundredths, r.amount.style)}%`],
        expected: { side, symbol, qty, order: { type: "market" } },
      };
    }
    const a = r.amount;
    const qtyText = renderDecimal(a.qty, QTY_DECIMALS, a.keep);
    if (a.type === "market") {
      return { tokens: [...head, qtyText], expected: { side, symbol, qty: a.qty, order: { type: "market" } } };
    }
    const word = applyCase(a.type === "limit" ? "LMT" : "STP", a.typeFlags);
    const priceText = renderDecimal(a.price, PRICE_DECIMALS, a.priceKeep);
    return {
      tokens: [...head, qtyText, word, priceText],
      expected: {
        side,
        symbol,
        qty: a.qty,
        order: a.type === "limit" ? { type: "limit", price: a.price } : { type: "stop", stopPrice: a.price },
      },
    };
  });

const cancelArb = fc
  .tuple(flags, flags)
  .map(([a, b]): WellFormed => ({ tokens: [applyCase("CANCEL", a), applyCase("ALL", b)], expected: "cancel_all" }));
const flatArb = flags.map((a): WellFormed => ({ tokens: [applyCase("FLAT", a)], expected: "flatten_all" }));

const wellFormed = fc.oneof({ weight: 6, arbitrary: placeArb }, cancelArb, flatArb);

const gap = fc.array(fc.constantFrom(" ", "\t"), { minLength: 1, maxLength: 3 }).map((a) => a.join(""));
const edge = fc.array(fc.constantFrom(" ", "\t"), { minLength: 0, maxLength: 3 }).map((a) => a.join(""));

/** A well-formed command rendered with random legal whitespace. */
const wellFormedText = fc
  .tuple(wellFormed, edge, edge, fc.array(gap, { minLength: 5, maxLength: 5 }))
  .map(([wf, lead, trail, gaps]) => {
    const body = wf.tokens.map((tok, i) => (i === 0 ? tok : `${gaps[i - 1]}${tok}`)).join("");
    return { wf, text: `${lead}${body}${trail}` };
  });

// ---------------------------------------------------------------------------------------------
// P20
// ---------------------------------------------------------------------------------------------

describe("P20: well-formed commands always parse (Req 21.7)", () => {
  // Property P20 — validates Req 21.7
  test("parse succeeds and the parsed fields equal the generated values", () => {
    fc.assert(
      fc.property(wellFormedText, ({ wf, text }) => {
        const r = parseCommand(text, CTX);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        if (wf.expected === "cancel_all") {
          expect(r.command).toEqual({ kind: "cancel_all" });
        } else if (wf.expected === "flatten_all") {
          expect(r.command).toEqual({ kind: "flatten_all" });
        } else {
          expect(r.command).toMatchObject({
            kind: "place",
            side: wf.expected.side,
            symbol: wf.expected.symbol,
            qty: wf.expected.qty,
            order: wf.expected.order,
          });
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("the oracle agrees that every generated command is well-formed", () => {
    fc.assert(
      fc.property(wellFormedText, ({ text }) => {
        expect(oracleAccepts(text)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------------------------
// P21
// ---------------------------------------------------------------------------------------------

function expectRejected(text: string): void {
  const r = parseCommand(text, CTX);
  expect(r.ok).toBe(false);
  expect("command" in r).toBe(false);
  if (r.ok) return;
  expect(Number.isInteger(r.error.position)).toBe(true);
  expect(r.error.position).toBeGreaterThanOrEqual(0);
  expect(r.error.position).toBeLessThanOrEqual(text.length);
  expect(r.error.message.length).toBeGreaterThan(0);
  expect(r.error.message.length).toBeLessThanOrEqual(100);
}

const JUNK = [
  "x", "1e5", "-1", "+1", "0x10", "1,5", "BTC-EUR", "%", "LMT", "BUY", "1.", "..", ".5", "１２", "?", "50%%", "ALL",
];
const BAD_AMOUNTS = ["0", "0.0", "-1", "-0.5", "0%", "-5%", "101%", "100.01%", "0.00%", "%", "1%%"];

const mutationOp = fc.oneof(
  fc.record({ op: fc.constant("drop" as const), i: fc.nat() }),
  fc.record({ op: fc.constant("dup" as const), i: fc.nat() }),
  fc.record({ op: fc.constant("swap" as const), i: fc.nat(), j: fc.nat() }),
  fc.record({ op: fc.constant("junk" as const), i: fc.nat(), junk: fc.constantFrom(...JUNK) }),
  fc.record({ op: fc.constant("extraDecimal" as const), which: fc.constantFrom(2, 4) }),
  fc.record({ op: fc.constant("badAmount" as const), bad: fc.constantFrom(...BAD_AMOUNTS) }),
  fc.record({
    op: fc.constant("percentWithType" as const),
    pct: fc.constantFrom("50%", "100%", "1%"),
    kind: fc.constantFrom("LMT", "STP", "lmt"),
  }),
);

type MutationOp = typeof mutationOp extends fc.Arbitrary<infer T> ? T : never;

function mutate(tokens: string[], m: MutationOp): string[] {
  const out = [...tokens];
  const at = (n: number): number => n % out.length;
  switch (m.op) {
    case "drop":
      out.splice(at(m.i), 1);
      return out;
    case "dup": {
      const i = at(m.i);
      out.splice(i, 0, out[i] as string);
      return out;
    }
    case "swap": {
      const i = at(m.i);
      const j = at(m.j);
      [out[i], out[j]] = [out[j] as string, out[i] as string];
      return out;
    }
    case "junk":
      out[at(m.i)] = m.junk;
      return out;
    case "extraDecimal": {
      const tok = out[m.which];
      if (tok === undefined) return out;
      out[m.which] = tok.includes(".") ? `${tok}123456789` : `${tok}.123456789`;
      return out;
    }
    case "badAmount":
      if (out.length > 2) out[2] = m.bad;
      return out;
    case "percentWithType":
      return [out[0] ?? "BUY", out[1] ?? "BTC", m.pct, m.kind, "100"];
  }
}

const mutatedText = fc
  .tuple(wellFormed, mutationOp)
  .map(([wf, m]) => mutate(wf.tokens, m).join(" "))
  .filter((s) => !oracleAccepts(s));

const vocabulary = [
  "BUY", "sell", "BTC", "eth-usd", "SOL", "XRP", "1", "0.5", "10%", "100%", "101%", "LMT", "stp", "64000.00",
  "ALL", "CANCEL", "FLAT", "-1", "1e3", "%", ".", "1.", "0", "0.123456789", "",
];
const vocabularyText = fc
  .array(fc.constantFrom(...vocabulary), { maxLength: 7 })
  .map((a) => a.join(" "))
  .filter((s) => !oracleAccepts(s));

const unicodeText = fc.string({ unit: "binary", maxLength: 40 }).filter((s) => !oracleAccepts(s));

describe("P21: malformed strings give a parse error and no order (Req 21.8)", () => {
  // Property P21 — validates Req 21.8
  test("arbitrary unicode strings the oracle rejects", () => {
    fc.assert(
      fc.property(unicodeText, (s) => {
        expectRejected(s);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Property P21 — validates Req 21.8
  test("random token sequences the oracle rejects", () => {
    fc.assert(
      fc.property(vocabularyText, (s) => {
        expectRejected(s);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Property P21 — validates Req 21.8
  test("mutations of well-formed strings the oracle rejects", () => {
    fc.assert(
      fc.property(mutatedText, (s) => {
        expectRejected(s);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------------------------
// P22
// ---------------------------------------------------------------------------------------------

const parsedPlace = fc
  .record({
    side: fc.constantFrom("buy" as const, "sell" as const),
    sym: fc.nat({ max: 2 }),
    qty: fc.oneof(fc.bigInt({ min: 1n, max: 1000n }), fc.bigInt({ min: 1n, max: 10n ** 15n })),
    price: fc.oneof(fc.bigInt({ min: 1n, max: 1000n }), fc.bigInt({ min: 1n, max: 10n ** 12n })),
    type: fc.constantFrom("market", "limit", "stop"),
    percent: fc.option(fc.constantFrom("1", "33.5", "100", "0.01"), { nil: undefined }),
  })
  .map((r): ParsedCommand => {
    const order =
      r.type === "market"
        ? ({ type: "market" } as const)
        : r.type === "limit"
          ? ({ type: "limit", price: r.price } as const)
          : ({ type: "stop", stopPrice: r.price } as const);
    // A percent source only comes from a market order (the parser forbids LMT/STP with a percent).
    const source = r.percent !== undefined && r.type === "market" ? { percent: r.percent } : "absolute";
    return { kind: "place", side: r.side, symbol: `${SYMBOLS[r.sym]}-USD`, qty: r.qty, order, source };
  });

const parsedCommand = fc.oneof(
  { weight: 6, arbitrary: parsedPlace },
  fc.constant<ParsedCommand>({ kind: "cancel_all" }),
  fc.constant<ParsedCommand>({ kind: "flatten_all" }),
);

describe("P22: format then parse round-trips (Req 21.9)", () => {
  // Property P22 — validates Req 21.9
  test("parse(format(c)) equals c (percent sources compared through normalizeSource)", () => {
    fc.assert(
      fc.property(parsedCommand, (c) => {
        const r = parseCommand(formatCommand(c), { positionLots: () => 0n });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.command).toEqual(normalizeSource(c));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Property P22 — validates Req 21.9
  test("format output is already canonical: format(parse(format(c))) === format(c)", () => {
    fc.assert(
      fc.property(parsedCommand, (c) => {
        const text = formatCommand(c);
        const r = parseCommand(text, { positionLots: () => 0n });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(formatCommand(r.command)).toBe(text);
        expect(oracleAccepts(text)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Property P22 — validates Req 21.9
  test("parse(format(parse(t))) equals parse(t) for generated well-formed text t", () => {
    fc.assert(
      fc.property(wellFormedText, ({ text }) => {
        const first = parseCommand(text, CTX);
        expect(first.ok).toBe(true);
        if (!first.ok) return;
        const second = parseCommand(formatCommand(first.command), { positionLots: () => 0n });
        expect(second.ok).toBe(true);
        if (!second.ok) return;
        expect(second.command).toEqual(normalizeSource(first.command));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Extra unit cases not covered by parser.test.ts
// ---------------------------------------------------------------------------------------------

describe("extra parser unit cases", () => {
  const ctx: ParseContext = { positionLots: () => 0n };
  const okCmd = (text: string): ParsedCommand => {
    const r = parseCommand(text, ctx);
    if (!r.ok) throw new Error(`expected ok for "${text}": ${r.error.message}`);
    return r.command;
  };
  const errPos = (text: string): number => {
    const r = parseCommand(text, ctx);
    if (r.ok) throw new Error(`expected an error for "${text}"`);
    return r.error.position;
  };

  test("leading zeros are accepted as plain digits", () => {
    expect(okCmd("BUY BTC 007")).toMatchObject({ qty: 700_000_000n });
  });

  test("non-plain number syntax is rejected at the token", () => {
    expect(errPos("BUY BTC 1.")).toBe(8);
    expect(errPos("BUY BTC .5")).toBe(8);
    expect(errPos("BUY BTC +1")).toBe(8);
    expect(errPos("BUY BTC 1e3")).toBe(8);
    expect(errPos("BUY BTC 1,5")).toBe(8);
    expect(errPos("BUY BTC １")).toBe(8); // full-width digit
    expect(errPos("BUY BTC 50%%")).toBe(8);
  });

  test("a zero price is rejected at the price token", () => {
    expect(errPos("BUY BTC 1 LMT 0")).toBe(14);
    expect(errPos("BUY BTC 1 STP 0.00")).toBe(14);
  });

  test("the i64 boundary for quantity", () => {
    expect(okCmd("BUY BTC 92233720368.54775807")).toMatchObject({ qty: 9223372036854775807n });
    expect(errPos("BUY BTC 92233720368.54775808")).toBe(8);
  });

  test("Unicode whitespace separates tokens", () => {
    expect(okCmd("BUY\u00a0BTC\u00a01")).toMatchObject({ side: "buy", symbol: "BTC-USD", qty: 100_000_000n });
  });

  test("a price token ending in % is not a price", () => {
    expect(errPos("BUY BTC 1 LMT 5%")).toBe(14);
  });
});
