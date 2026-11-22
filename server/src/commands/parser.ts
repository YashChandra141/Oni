// Command_Parser (design §3 "Command_Parser and Command_Formatter", Req 4.3, 4.4, 21.1–21.5).
//
// Pure: no I/O, no clock, no randomness. The only outside input is `ctx.positionLots`, which
// resolves `<percent>%` amounts against the requester's own account position.
//
// Grammar (keywords case-insensitive, tokens separated by whitespace):
//   command  := order | "CANCEL" "ALL" | "FLAT"
//   order    := side symbol amount [ ("LMT" | "STP") price ]
//   side     := "BUY" | "SELL"
//   symbol   := "BTC" | "ETH" | "SOL" | "BTC-USD" | "ETH-USD" | "SOL-USD"
//   amount   := decimal | percent "%"      percent in (0, 100]
//   decimal  := digits [ "." digits ]
//
// Errors carry `position`, the character offset (UTF-16 index into `text`) of the first invalid
// token. A token that is missing at the end of the input is reported at `text.length`.
// Error messages quote at most MAX_ECHO characters of the offending token and never anything
// else from the input.
//
// Decimals become Ticks and Lots with string arithmetic on the instrument's decimals, never
// floats (Req 4.3). A value with more decimals than the instrument has is a parse error that
// names the value (Req 4.4); since tick and lot sizes are 10^-decimals, that is exactly "not a
// whole multiple of the tick or lot size".
//
// A percent amount is resolved at parse time: floor(|position| × percent / 100) lots, side as
// typed, 0 lots is an error. It is a market order only (LMT/STP after a percent is an error).

import { type InstrumentInfo, I64_MAX, type Side } from "../protocol.ts";
import { INSTRUMENTS } from "../instruments.ts";
import type { RiskOrderKind } from "../risk/risk.ts";

/** Longest piece of user input an error message may quote. */
export const MAX_ECHO = 32;

/** Longest accepted command text, in characters. */
export const MAX_COMMAND_LENGTH = 256;

export type ParsedOrderType = RiskOrderKind;

export type AmountSource = "absolute" | { readonly percent: string };

export type ParsedCommand =
  | {
      readonly kind: "place";
      readonly side: Side;
      /** Full symbol, e.g. `BTC-USD`. */
      readonly symbol: string;
      /** Lots, positive. */
      readonly qty: bigint;
      /** market, limit price (ticks), or stop stopPrice (ticks). */
      readonly order: ParsedOrderType;
      /** How the amount was typed. A percent is already resolved into `qty`. */
      readonly source: AmountSource;
    }
  | {
      /** `BUY|SELL <symbol> <qty> TWAP <slices> <seconds>` (Req 17.1, 17.12, 17.13). */
      readonly kind: "twap";
      readonly side: Side;
      readonly symbol: string;
      /** Total lots, positive, at least `slices`. */
      readonly totalQty: bigint;
      readonly slices: number;
      readonly intervalS: number;
    }
  | { readonly kind: "cancel_all" }
  | { readonly kind: "flatten_all" };

/** TWAP bounds (design: Router, TWAP, and Risk). */
export const TWAP_MIN_SLICES = 2;
export const TWAP_MAX_SLICES = 20;
export const TWAP_MIN_INTERVAL_S = 5;
export const TWAP_MAX_INTERVAL_S = 3_600;

export interface ParseError {
  readonly message: string;
  /** Character offset of the first invalid token. */
  readonly position: number;
}

export type ParseResult =
  | { readonly ok: true; readonly command: ParsedCommand }
  | { readonly ok: false; readonly error: ParseError };

export interface ParseContext {
  /** Signed position of the requester's account in `symbol` (full symbol), in lots. */
  positionLots(symbol: string): bigint;
}

export interface Token {
  readonly text: string;
  /** Offset of the first character of the token in the input. */
  readonly start: number;
}

/** Splits on whitespace and records each token's offset. */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const re = /\S+/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    tokens.push({ text: m[0], start: m.index });
  }
  return tokens;
}

/** Quotes a token for an error message, capped at MAX_ECHO characters. */
function quote(token: string): string {
  return token.length > MAX_ECHO ? `'${token.slice(0, MAX_ECHO)}...'` : `'${token}'`;
}

type Failure = Extract<ParseResult, { ok: false }>;

function fail(message: string, position: number): Failure {
  return { ok: false, error: { message, position } };
}

/** The short names from the instrument list, for error messages. */
const SHORT_SYMBOLS = INSTRUMENTS.map((i) => i.short).join(", ");

/** Resolves a short (`BTC`) or full (`BTC-USD`) symbol, case-insensitively. */
export function resolveSymbol(token: string): InstrumentInfo | undefined {
  const upper = token.toUpperCase();
  return INSTRUMENTS.find((i) => i.symbol === upper || i.short === upper);
}

const DECIMAL_RE = /^\d+(?:\.\d+)?$/;

/**
 * Converts a plain decimal string into integer units of 10^-decimals, with string arithmetic.
 * `format`: the text is not `digits[.digits]`. `precision`: more than `decimals` fraction digits.
 */
export function decimalToUnits(text: string, decimals: number): { units: bigint } | { error: "format" | "precision" } {
  if (!DECIMAL_RE.test(text)) return { error: "format" };
  const dot = text.indexOf(".");
  const whole = dot < 0 ? text : text.slice(0, dot);
  const frac = dot < 0 ? "" : text.slice(dot + 1);
  if (frac.length > decimals) return { error: "precision" };
  return { units: BigInt(whole + frac.padEnd(decimals, "0")) };
}

/** Parses an amount or price token into units, or returns a ParseResult failure. */
function parseUnits(
  token: Token,
  decimals: number,
  what: "amount" | "price",
): { units: bigint } | Failure {
  const parsed = decimalToUnits(token.text, decimals);
  if ("error" in parsed) {
    const message =
      parsed.error === "format"
        ? `invalid ${what} ${quote(token.text)}`
        : `${what} ${quote(token.text)} has more than ${decimals} decimal places`;
    return fail(message, token.start);
  }
  if (parsed.units <= 0n) return fail(`${what} ${quote(token.text)} must be greater than zero`, token.start);
  if (parsed.units > I64_MAX) return fail(`${what} ${quote(token.text)} is too large`, token.start);
  return { units: parsed.units };
}

/** floor(|position| × percent / 100) in lots. `percent` is `digits[.digits]`, already range-checked. */
function percentOfPosition(position: bigint, percent: string): bigint {
  const dot = percent.indexOf(".");
  const frac = dot < 0 ? "" : percent.slice(dot + 1);
  const scaled = BigInt((dot < 0 ? percent : percent.slice(0, dot)) + frac);
  const abs = position < 0n ? -position : position;
  return (abs * scaled) / (100n * 10n ** BigInt(frac.length));
}

/** True when `percent` (`digits[.digits]`) is in (0, 100]. */
function percentInRange(percent: string): boolean {
  const dot = percent.indexOf(".");
  const frac = dot < 0 ? "" : percent.slice(dot + 1);
  const scaled = BigInt((dot < 0 ? percent : percent.slice(0, dot)) + frac);
  const hundred = 100n * 10n ** BigInt(frac.length);
  return scaled > 0n && scaled <= hundred;
}

export function parseCommand(text: string, ctx: ParseContext): ParseResult {
  if (text.length > MAX_COMMAND_LENGTH) {
    return fail(`command is longer than ${MAX_COMMAND_LENGTH} characters`, MAX_COMMAND_LENGTH);
  }
  const tokens = tokenize(text);
  const first = tokens[0];
  if (first === undefined) return fail("empty command", 0);
  const end = text.length;

  switch (first.text.toUpperCase()) {
    case "BUY":
      return parseOrder("buy", tokens, end, ctx);
    case "SELL":
      return parseOrder("sell", tokens, end, ctx);
    case "CANCEL": {
      const all = tokens[1];
      if (all === undefined) return fail("expected ALL after CANCEL", end);
      if (all.text.toUpperCase() !== "ALL") return fail(`expected ALL, got ${quote(all.text)}`, all.start);
      return noExtra(tokens, 2) ?? { ok: true, command: { kind: "cancel_all" } };
    }
    case "FLAT":
      return noExtra(tokens, 1) ?? { ok: true, command: { kind: "flatten_all" } };
    default:
      return fail(`unknown command ${quote(first.text)}; expected BUY, SELL, CANCEL ALL, or FLAT`, first.start);
  }
}

/** A failure for the first token at or after `index`, or null when there is none. */
function noExtra(tokens: Token[], index: number): Failure | null {
  const extra = tokens[index];
  if (extra === undefined) return null;
  return fail(`unexpected ${quote(extra.text)}`, extra.start);
}

/** Parses a whole-number token in [min, max]. */
function parseBounded(token: Token | undefined, what: string, min: number, max: number, end: number): { value: number } | Failure {
  if (token === undefined) return fail(`expected ${what}`, end);
  if (!/^\d{1,9}$/.test(token.text)) return fail(`invalid ${what} ${quote(token.text)}`, token.start);
  const value = Number(token.text);
  if (value < min || value > max) return fail(`${what} ${quote(token.text)} must be from ${min} to ${max}`, token.start);
  return { value };
}

function parseTwap(side: Side, symbol: string, qty: bigint, tokens: Token[], end: number): ParseResult {
  const slices = parseBounded(tokens[4], "slices", TWAP_MIN_SLICES, TWAP_MAX_SLICES, end);
  if ("ok" in slices) return slices;
  const seconds = parseBounded(tokens[5], "seconds", TWAP_MIN_INTERVAL_S, TWAP_MAX_INTERVAL_S, end);
  if ("ok" in seconds) return seconds;
  const extra = noExtra(tokens, 6);
  if (extra !== null) return extra;
  if (qty < BigInt(slices.value)) {
    const amountToken = tokens[2];
    return fail(`amount must be at least ${slices.value} lots so every slice is one lot`, amountToken === undefined ? end : amountToken.start);
  }
  return { ok: true, command: { kind: "twap", side, symbol, totalQty: qty, slices: slices.value, intervalS: seconds.value } };
}

function parseOrder(side: Side, tokens: Token[], end: number, ctx: ParseContext): ParseResult {
  const symbolToken = tokens[1];
  if (symbolToken === undefined) return fail(`expected a symbol (${SHORT_SYMBOLS})`, end);
  const instrument = resolveSymbol(symbolToken.text);
  if (instrument === undefined) {
    return fail(`unknown symbol ${quote(symbolToken.text)}; expected ${SHORT_SYMBOLS}`, symbolToken.start);
  }

  const amountToken = tokens[2];
  if (amountToken === undefined) return fail("expected an amount", end);
  const isPercent = amountToken.text.endsWith("%");

  let qty: bigint;
  let source: AmountSource;
  if (isPercent) {
    const percent = amountToken.text.slice(0, -1);
    if (!DECIMAL_RE.test(percent)) return fail(`invalid percent ${quote(amountToken.text)}`, amountToken.start);
    if (!percentInRange(percent)) {
      return fail(`percent ${quote(amountToken.text)} must be greater than 0 and at most 100`, amountToken.start);
    }
    const position = ctx.positionLots(instrument.symbol);
    if (position === 0n) return fail(`no open ${instrument.symbol} position for ${quote(amountToken.text)}`, amountToken.start);
    qty = percentOfPosition(position, percent);
    if (qty <= 0n) return fail(`${quote(amountToken.text)} of the position rounds down to zero lots`, amountToken.start);
    source = { percent };
  } else {
    const amount = parseUnits(amountToken, instrument.qty_decimals, "amount");
    if ("ok" in amount) return amount;
    qty = amount.units;
    source = "absolute";
  }

  const typeToken = tokens[3];
  if (typeToken === undefined) {
    return { ok: true, command: { kind: "place", side, symbol: instrument.symbol, qty, order: { type: "market" }, source } };
  }
  const typeWord = typeToken.text.toUpperCase();
  if (typeWord === "TWAP") {
    if (isPercent) return fail("a percent amount is a market order; TWAP is not allowed", typeToken.start);
    return parseTwap(side, instrument.symbol, qty, tokens, end);
  }
  if (typeWord !== "LMT" && typeWord !== "STP") {
    return fail(`expected LMT or STP, got ${quote(typeToken.text)}`, typeToken.start);
  }
  if (isPercent) {
    return fail(`a percent amount is a market order; ${typeWord} is not allowed`, typeToken.start);
  }
  const priceToken = tokens[4];
  if (priceToken === undefined) return fail(`expected a price after ${typeWord}`, end);
  const price = parseUnits(priceToken, instrument.price_decimals, "price");
  if ("ok" in price) return price;
  const extra = noExtra(tokens, 5);
  if (extra !== null) return extra;

  const order: ParsedOrderType =
    typeWord === "LMT" ? { type: "limit", price: price.units } : { type: "stop", stopPrice: price.units };
  return { ok: true, command: { kind: "place", side, symbol: instrument.symbol, qty, order, source } };
}
