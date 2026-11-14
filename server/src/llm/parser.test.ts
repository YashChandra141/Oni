// LLM_Order_Parser unit tests (Req 23.2, 23.3, 23.4, 23.5, 23.6, 23.7, Task 13.2).
// A mock provider stands in for OpenAI. Prompt-fixture tests are Task 13.3.

import { describe, expect, test } from "bun:test";
import { formatCommand } from "../commands/formatter.ts";
import { LlmOrderParser, type LlmParseResult, intentToCommandText } from "./parser.ts";
import { type LlmContext, type LlmProvider, LlmUnavailable } from "./provider.ts";

const NONE = { amount: null, order_type: null, price: null, side: null, symbol: null };

function provider(result: unknown | (() => Promise<unknown>), seen?: LlmContext[]): LlmProvider {
  return {
    interpret: async (_text, context) => {
      seen?.push(context);
      return typeof result === "function" ? (result as () => Promise<unknown>)() : result;
    },
  };
}

function parser(p: LlmProvider | null, opts: { timeoutMs?: number; positions?: Record<string, bigint> } = {}) {
  return new LlmOrderParser({
    provider: p,
    positionLots: (account, symbol) => (account === "w_alice" ? (opts.positions?.[symbol] ?? 0n) : 0n),
    lastPrice: (symbol) => (symbol === "BTC-USD" ? 6_400_000n : null),
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
  });
}

function expectError(result: LlmParseResult): string {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.kind).toBe("error");
  return result.message;
}

describe("LlmOrderParser", () => {
  test("without a provider it is disabled and never calls anything (Req 23.7)", async () => {
    const p = parser(null);
    expect(p.enabled).toBe(false);
    const result = await p.parse("buy some bitcoin", "guest");
    expect(result).toMatchObject({ ok: false, kind: "disabled" });
    if (!result.ok) expect(result.message.toLowerCase()).toContain("disabled");
  });

  test("a valid limit intent becomes the same command as typing it (Req 23.3)", async () => {
    const intent = {
      action: "place",
      side: "buy",
      symbol: "BTC",
      amount: { absolute: "0.1" },
      order_type: "limit",
      price: { absolute: "64000" },
    };
    const result = await parser(provider(intent)).parse("buy 0.1 btc at 64000", "guest");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe("BUY BTC-USD 0.1 LMT 64000.00");
    expect(formatCommand(result.command)).toBe(result.text);
    expect(result.command).toMatchObject({
      kind: "place",
      side: "buy",
      symbol: "BTC-USD",
      qty: 10_000_000n,
      order: { type: "limit", price: 6_400_000n },
    });
  });

  test("a percent amount resolves against the caller's own account, not a model field", async () => {
    const intent = { ...NONE, action: "place", side: "sell", symbol: "BTC-USD", amount: { percent_of_position: 50 }, order_type: "market" };
    const p = parser(provider(intent), { positions: { "BTC-USD": 200_000_000n } });
    const alice = await p.parse("sell half", "w_alice");
    expect(alice.ok && alice.command.kind === "place" ? alice.command.qty : null).toBe(100_000_000n);
    // Another account is flat, so the percent cannot resolve.
    expectError(await p.parse("sell half", "guest"));
  });

  test("a relative price is computed from the last price with whole-number math", async () => {
    const intent = {
      action: "place",
      side: "buy",
      symbol: "BTC-USD",
      amount: { absolute: "1" },
      order_type: "limit",
      price: { relative_to_last_pct: -1 },
    };
    const result = await parser(provider(intent)).parse("buy 1% below market", "guest");
    expect(result.ok && result.text).toBe("BUY BTC-USD 1 LMT 63360.00");
  });

  test("a relative price without a last price is an error", async () => {
    const intent = {
      action: "place",
      side: "buy",
      symbol: "ETH-USD",
      amount: { absolute: "1" },
      order_type: "limit",
      price: { relative_to_last_pct: 1 },
    };
    expectError(await parser(provider(intent)).parse("x", "guest"));
  });

  test("cancel_all and flatten map to the fixed commands", async () => {
    const cancel = await parser(provider({ ...NONE, action: "cancel_all" })).parse("cancel everything", "guest");
    expect(cancel.ok && cancel.command.kind).toBe("cancel_all");
    const flat = await parser(provider({ ...NONE, action: "flatten" })).parse("close it all", "guest");
    expect(flat.ok && flat.command.kind).toBe("flatten_all");
  });

  test("extra fields, such as an account id, fail validation and create no command (Req 23.4)", async () => {
    const intent = { ...NONE, action: "flatten", account_id: "w_victim" };
    expectError(await parser(provider(intent)).parse("flatten", "guest"));
  });

  test("invalid shapes, unclear intent, and unparseable orders create no command (Req 23.4)", async () => {
    const bad: unknown[] = [
      null,
      "BUY BTC 1",
      { action: "place" },
      { ...NONE, action: "unclear" },
      { ...NONE, action: "place", side: "buy", symbol: "DOGE-USD", amount: { absolute: "1" }, order_type: "market" },
      { ...NONE, action: "place", side: "buy", symbol: "BTC-USD", amount: { absolute: "0.000000001" }, order_type: "market" },
      { ...NONE, action: "place", side: "buy", symbol: "BTC-USD", amount: { absolute: "1" }, order_type: "limit" },
      { ...NONE, action: "place", side: "buy", symbol: "BTC-USD", amount: { absolute: "1" }, order_type: "market", price: { absolute: "5" } },
    ];
    for (const value of bad) expectError(await parser(provider(value)).parse("x", "guest"));
  });

  test("a provider error is an error result with a safe message (Req 23.5)", async () => {
    const failing = provider(() => Promise.reject(new LlmUnavailable("The language model service is rate limited (HTTP 429)", 429)));
    expect(expectError(await parser(failing).parse("x", "guest"))).toContain("rate limited");
    const odd = provider(() => Promise.reject(new Error("sk-secret-key leaked")));
    expect(expectError(await parser(odd).parse("x", "guest"))).not.toContain("sk-secret");
  });

  test("no answer within the time limit is an error (Req 23.5)", async () => {
    const hang = provider(() => new Promise(() => {}));
    expectError(await parser(hang, { timeoutMs: 20 }).parse("x", "guest"));
  });

  test("the context carries symbols, the caller's positions, and last prices", async () => {
    const seen: LlmContext[] = [];
    const p = parser(provider({ ...NONE, action: "unclear" }, seen), { positions: { "BTC-USD": 150_000_000n } });
    await p.parse("x", "w_alice");
    expect(seen[0]?.symbols).toEqual(["BTC-USD", "ETH-USD", "SOL-USD"]);
    expect(seen[0]?.positions["BTC-USD"]).toBe("1.5");
    expect(seen[0]?.lastPrices).toEqual({ "BTC-USD": "64000.00" });
  });

  test("empty text after the ? is an error without calling the provider", async () => {
    let calls = 0;
    const p = parser({ interpret: async () => (calls++, {}) });
    expectError(await p.parse("   ", "guest"));
    expect(calls).toBe(0);
  });
});

describe("intentToCommandText", () => {
  test("keeps percent text free of exponent notation", () => {
    const result = intentToCommandText(
      { ...NONE, action: "place", side: "sell", symbol: "ETH", amount: { percent_of_position: 0.00001 }, order_type: "market" },
      () => null,
    );
    expect(result).toEqual({ ok: true, text: "SELL ETH-USD 0%" });
  });
});
