// Command_Formatter (design §3, Req 21.6). Pure.
//
// Canonical form (ONE per command, so `parse(format(c))` returns `c`, Req 21.9):
//   BUY|SELL <FULL-SYMBOL> <qty> [LMT <price> | STP <price>]
//   BUY|SELL <FULL-SYMBOL> <qty> TWAP <slices> <seconds>
//   CANCEL ALL
//   FLAT
// - Keywords are upper case. The symbol is the full symbol (`BTC-USD`), never the short name.
// - `qty` is the decimal of the lot count with the instrument's qty decimals, trailing zeros
//   trimmed, and no decimal point when the fraction is empty: `0.1`, `1`, `0.00000001`, `2.5`.
// - `price` always has exactly the instrument's price decimals: `64000.00`.
// - Single spaces between tokens, no leading or trailing space.
//
// A percent amount is resolved when it is parsed, so the formatter prints the resolved absolute
// qty and drops `source`. P22's round trip therefore holds over the resolved command: for any
// parsed `c`, `parse(format(c))` equals `c` in every field except `source`, which is "absolute"
// after the round trip. `normalizeSource(c)` gives the comparable form.

import { instrumentBySymbol } from "../instruments.ts";
import type { ParsedCommand } from "./parser.ts";

/** Formats integer `units` as a decimal with exactly `decimals` fraction digits. */
export function unitsToFixed(units: bigint, decimals: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const frac = digits.slice(digits.length - decimals);
  return `${negative ? "-" : ""}${whole}${decimals === 0 ? "" : `.${frac}`}`;
}

/** Like `unitsToFixed`, with trailing fraction zeros (and a bare decimal point) removed. */
export function unitsToTrimmed(units: bigint, decimals: number): string {
  const fixed = unitsToFixed(units, decimals);
  if (decimals === 0) return fixed;
  return fixed.replace(/0+$/, "").replace(/\.$/, "");
}

/** The command as `parseCommand` returns it after a format/parse round trip (`source` is "absolute"). */
export function normalizeSource(command: ParsedCommand): ParsedCommand {
  return command.kind === "place" ? { ...command, source: "absolute" } : command;
}

export function formatCommand(command: ParsedCommand): string {
  switch (command.kind) {
    case "cancel_all":
      return "CANCEL ALL";
    case "flatten_all":
      return "FLAT";
    case "twap": {
      const instrument = instrumentBySymbol(command.symbol);
      if (instrument === undefined) throw new RangeError("unknown symbol");
      return `${command.side === "buy" ? "BUY" : "SELL"} ${command.symbol} ${unitsToTrimmed(command.totalQty, instrument.qty_decimals)} TWAP ${command.slices} ${command.intervalS}`;
    }
    case "place": {
      const instrument = instrumentBySymbol(command.symbol);
      if (instrument === undefined) throw new RangeError("unknown symbol");
      const head = `${command.side === "buy" ? "BUY" : "SELL"} ${command.symbol} ${unitsToTrimmed(command.qty, instrument.qty_decimals)}`;
      switch (command.order.type) {
        case "market":
          return head;
        case "limit":
          return `${head} LMT ${unitsToFixed(command.order.price, instrument.price_decimals)}`;
        case "stop":
          return `${head} STP ${unitsToFixed(command.order.stopPrice, instrument.price_decimals)}`;
      }
    }
  }
}
