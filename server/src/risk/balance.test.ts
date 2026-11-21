// Replays shared/balance-vectors.json (written by the Rust test `writes_golden_vectors`)
// against the TS mirror. Skips when the file has not been generated yet.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { instrumentBySymbol } from "../instruments.ts";
import { equity, freeBalance, requiredFunds, BalanceError } from "./balance.ts";

const PATH = new URL("../../../shared/balance-vectors.json", import.meta.url);

const Vectors = z.object({
  required_funds: z.array(
    z.object({
      symbol: z.string(),
      side: z.enum(["buy", "sell"]),
      qty: z.string(),
      reference: z.string(),
      pos: z.string(),
      basis: z.string(),
      fee_bps: z.number(),
      slippage_bps: z.number(),
      expected: z.string(),
    }),
  ),
  free_balance: z.array(
    z.object({ paper: z.string(), short_basis: z.string(), reserved: z.string(), expected: z.string() }),
  ),
  equity: z.array(
    z.object({
      paper: z.string(),
      holdings: z.array(z.object({ symbol: z.string(), mark: z.string(), pos: z.string() })),
      expected: z.string(),
    }),
  ),
});

function run(f: () => bigint): string {
  try {
    return f().toString();
  } catch (e) {
    if (e instanceof BalanceError) return e.code;
    throw e;
  }
}

describe.skipIf(!existsSync(PATH))("balance golden vectors", () => {
  const v = Vectors.parse(JSON.parse(readFileSync(PATH, "utf8")));
  test("required_funds matches Rust", () => {
    for (const t of v.required_funds) {
      const instrument = instrumentBySymbol(t.symbol);
      if (instrument === undefined) throw new Error(`unknown symbol ${t.symbol}`);
      const got = run(() =>
        requiredFunds({
          instrument,
          side: t.side,
          qty: BigInt(t.qty),
          reference: BigInt(t.reference),
          pos: BigInt(t.pos),
          basis: BigInt(t.basis),
          feeBps: BigInt(t.fee_bps),
          slippageBps: BigInt(t.slippage_bps),
        }),
      );
      expect(got).toBe(t.expected);
    }
  });
  test("free_balance matches Rust", () => {
    for (const t of v.free_balance) {
      expect(run(() => freeBalance(BigInt(t.paper), BigInt(t.short_basis), BigInt(t.reserved)))).toBe(t.expected);
    }
  });
  test("equity matches Rust", () => {
    for (const t of v.equity) {
      const holdings = t.holdings.map((h) => {
        const instrument = instrumentBySymbol(h.symbol);
        if (instrument === undefined) throw new Error(`unknown symbol ${h.symbol}`);
        return { instrument, mark: BigInt(h.mark), pos: BigInt(h.pos) };
      });
      expect(run(() => equity(BigInt(t.paper), holdings))).toBe(t.expected);
    }
  });
});
