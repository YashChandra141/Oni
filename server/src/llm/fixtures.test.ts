// Fixture-driven LLM_Order_Parser tests (Task 13.3, Req 23.3, 23.4, 23.5). A mock provider
// returns each fixture's canned output; nothing contacts a model or the network.
import { describe, expect, test } from "bun:test";
import { parseCommand } from "../commands/parser.ts";
import { INVALID_FIXTURES, VALID_FIXTURES } from "./fixtures.ts";
import { LlmOrderParser } from "./parser.ts";
import { LlmBadOutput, LlmRefused, LlmTimeout, LlmUnavailable, type LlmProvider } from "./provider.ts";

function parserFor(provider: LlmProvider, positionLots: Readonly<Record<string, bigint>> = {}, timeoutMs?: number) {
  return new LlmOrderParser({
    provider,
    positionLots: (account, symbol) => (account === "w_alice" ? (positionLots[symbol] ?? 0n) : 0n),
    lastPrice: (symbol) => (symbol === "BTC-USD" ? 6_400_000n : null),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

const mock = (output: unknown, seen?: string[]): LlmProvider => ({
  interpret: async (text) => {
    seen?.push(text);
    return output;
  },
});

describe("valid prompt fixtures", () => {
  for (const f of VALID_FIXTURES) {
    test(f.name, async () => {
      const seen: string[] = [];
      const result = await parserFor(mock(f.output, seen), f.positionLots).parse(f.input, f.account ?? "guest");
      expect(seen).toEqual([f.input]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.text).toBe(f.text);
      expect(result.command.kind).toBe(f.kind);
      // Same ParsedCommand as typing the canonical text (Req 23.3).
      const typed = parseCommand(f.text, {
        positionLots: (symbol) => (f.account === "w_alice" ? (f.positionLots?.[symbol] ?? 0n) : 0n),
      });
      expect(typed.ok).toBe(true);
      if (typed.ok) expect(result.command).toEqual(typed.command);
    });
  }
});

describe("invalid prompt fixtures give an error and no command (Req 23.4)", () => {
  for (const f of INVALID_FIXTURES) {
    test(f.name, async () => {
      const result = await parserFor(mock(f.output)).parse(f.input, "guest");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.kind).toBe("error");
      expect(result.message.length).toBeGreaterThan(0);
      // Errors never quote model output or account ids.
      expect(result.message).not.toContain("w_victim");
    });
  }
});

describe("provider failures give an error and no command (Req 23.5)", () => {
  const errors: [string, () => Promise<unknown>][] = [
    ["timeout error", () => Promise.reject(new LlmTimeout())],
    ["unavailable", () => Promise.reject(new LlmUnavailable("The language model service failed (HTTP 500)", 500))],
    ["refusal", () => Promise.reject(new LlmRefused())],
    ["bad output", () => Promise.reject(new LlmBadOutput())],
    ["untyped error", () => Promise.reject(new Error("boom sk-secret"))],
  ];
  for (const [name, fail] of errors) {
    test(name, async () => {
      const result = await parserFor({ interpret: fail }).parse("buy 1 btc", "guest");
      expect(result).toMatchObject({ ok: false, kind: "error" });
      if (!result.ok) expect(result.message).not.toContain("sk-secret");
    });
  }

  test("a provider that never answers is cut off at the deadline and its signal is aborted", async () => {
    let signal: AbortSignal | undefined;
    const hang: LlmProvider = {
      interpret: (_t, _c, s) => {
        signal = s;
        return new Promise(() => {});
      },
    };
    const result = await parserFor(hang, {}, 20).parse("buy 1 btc", "guest");
    expect(result).toMatchObject({ ok: false, kind: "error" });
    expect(signal?.aborted).toBe(true);
  });

  test("a late answer after the deadline is ignored", async () => {
    const slow: LlmProvider = {
      interpret: () => new Promise((resolve) => setTimeout(() => resolve(VALID_FIXTURES[1]?.output), 80)),
    };
    const result = await parserFor(slow, {}, 10).parse("sell 2 eth", "guest");
    expect(result).toMatchObject({ ok: false, kind: "error" });
  });
});
