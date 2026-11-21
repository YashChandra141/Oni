// MCP tool tests (Task 14.1, Req 24.1-24.7): argument validation, result shapes, and safe
// error results. The tools run against a real TerminalClient over a fake fetch and a fake
// WebSocket. main.ts is not imported (it would start a stdio server).

import { describe, expect, test } from "bun:test";
import { TerminalClient } from "./client.ts";
import { type ServerScript, event, fakeFetch, fakeWebSocket, json, previewReply } from "./testing.ts";
import { type ToolDef, type ToolResult, createTools, failureResult } from "./tools.ts";

const BASE = "http://localhost:8080";

const QUOTE = {
  symbol: "BTC-USD",
  last: { price: "6400000", qty: "1000000", side: "buy", ts: 1_700_000_000_000 },
  book: {
    bid: { price: "6399900", qty: "50000000" },
    ask: { price: "6400100", qty: "25000000" },
    spread: "200",
    imbalance_bps: 3333,
    ts: 1_700_000_000_000,
  },
};

const BARS = {
  symbol: "ETH-USD",
  timeframe: "5m",
  bars: [{ t: 1_700_000_100_000, open: "350000", high: "351000", low: "349000", close: "350500", volume: "100000000" }],
};

function setup(route: (url: string) => Response = () => json({}), script: ServerScript = () => {}) {
  const http = fakeFetch(route);
  const ws = fakeWebSocket(script);
  let n = 0;
  const client = new TerminalClient({
    baseUrl: BASE,
    fetch: http.fetch,
    WebSocket: ws.WebSocket,
    randomId: () => `r${++n}`,
    previewTimeoutMs: 100,
    placeTimeoutMs: 100,
    settleMs: 20,
  });
  const tools = new Map(createTools(client).map((t) => [t.name, t] as const));
  const get = (name: string): ToolDef => {
    const t = tools.get(name);
    if (t === undefined) throw new Error(`missing tool ${name}`);
    return t;
  };
  return { get, tools, calls: http.calls, sockets: ws.sockets };
}

function text(result: ToolResult): string {
  return result.content.map((c) => c.text).join("\n");
}

/** No stack frames or error class dumps in a tool result. */
function expectNoStack(result: ToolResult): void {
  const t = text(result);
  expect(t).not.toMatch(/\n\s+at\s/);
  expect(t).not.toContain(".ts:");
}

describe("tool list", () => {
  test("exposes exactly the five tools, all described as paper trading (Req 24.1)", () => {
    const { tools } = setup();
    expect([...tools.keys()]).toEqual(["get_quote", "get_candles", "get_positions", "preview_order", "place_paper_order"]);
    for (const tool of tools.values()) expect(tool.description).toContain("PAPER");
    expect(tools.get("place_paper_order")?.description).toContain("risk checks");
  });
});

describe("get_quote", () => {
  test("resolves a short symbol and formats prices as decimals (Req 24.2)", async () => {
    const { get, calls } = setup(() => json(QUOTE));
    const result = await get("get_quote").run({ symbol: "btc" });
    expect(result.isError).toBeUndefined();
    expect(calls[0]?.url).toBe(`${BASE}/quote/BTC-USD`);
    const body = JSON.parse(text(result));
    expect(body.best_bid).toEqual({ price: "63999.00", qty: "0.50000000" });
    expect(body.best_ask).toEqual({ price: "64001.00", qty: "0.25000000" });
    expect(body.last.price).toBe("64000.00");
  });

  test("an unknown symbol is an argument error that does not echo the value (Req 24.7)", async () => {
    const { get, calls } = setup(() => json(QUOTE));
    const result = await get("get_quote").run({ symbol: "DOGEZ" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Invalid arguments: symbol");
    expect(text(result)).not.toContain("DOGEZ");
    expect(calls).toHaveLength(0);
  });

  test("a missing symbol is an argument error", async () => {
    const { get } = setup();
    const result = await get("get_quote").run({});
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("symbol");
  });

  test("no_data becomes a short hint", async () => {
    const { get } = setup(() => json({ error: "no_data" }, 404));
    const result = await get("get_quote").run({ symbol: "SOL" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("No market data");
  });
});

describe("get_candles", () => {
  test("defaults limit to 100 and passes the timeframe (Req 24.3)", async () => {
    const { get, calls } = setup(() => json(BARS));
    const result = await get("get_candles").run({ symbol: "eth-usd", timeframe: "5m" });
    expect(result.isError).toBeUndefined();
    expect(calls[0]?.url).toBe(`${BASE}/candles/ETH-USD?timeframe=5m&limit=100`);
    const body = JSON.parse(text(result));
    expect(body.bars[0]).toMatchObject({ open: "3500.00", close: "3505.00", volume: "1.00000000" });
  });

  test("rejects a bad timeframe and an out-of-range limit", async () => {
    const { get, calls } = setup(() => json(BARS));
    for (const args of [
      { symbol: "ETH", timeframe: "2m" },
      { symbol: "ETH", timeframe: "1m", limit: 0 },
      { symbol: "ETH", timeframe: "1m", limit: 501 },
      { symbol: "ETH", timeframe: "1m", limit: 1.5 },
    ]) {
      const result = await get("get_candles").run(args);
      expect(result.isError).toBe(true);
      expect(text(result)).toStartWith("Invalid arguments:");
    }
    expect(calls).toHaveLength(0);
  });
});

describe("get_positions", () => {
  test("returns the account's positions with exact decimals (Req 24.4)", async () => {
    const { get, calls } = setup(() =>
      json([{ symbol: "BTC-USD", qty: "1000000", avg_entry: "6400000", realized: "-64001000000", unrealized: "0" }]),
    );
    const result = await get("get_positions").run({});
    expect(calls[0]?.url).toBe(`${BASE}/positions`);
    const body = JSON.parse(text(result));
    expect(body.positions[0]).toEqual({
      symbol: "BTC-USD",
      qty: "0.01000000",
      avg_entry: "64000.00",
      realized_pnl_usd: "-6.4001000000",
      unrealized_pnl_usd: "0.0000000000",
    });
  });

  test("an unreachable server is an error without the underlying message", async () => {
    const { get } = setup(() => {
      throw new Error("ECONNREFUSED OPENAI_API_KEY=sk-secret-value");
    });
    const result = await get("get_positions").run({});
    expect(result.isError).toBe(true);
    expect(text(result)).not.toContain("sk-secret-value");
    expectNoStack(result);
  });
});

describe("preview_order", () => {
  test("returns the preview and places nothing (Req 24.5)", async () => {
    const { get, sockets } = setup(undefined, (ws, msg) => {
      if (msg.type === "command_text") ws.receive(previewReply(msg.request_id));
    });
    const result = await get("preview_order").run({ command: "buy btc 0.01" });
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(text(result));
    expect(body).toMatchObject({ paper: true, placed: false, preview: "BUY BTC-USD 0.01" });
    expect(body.order).toEqual({ type: "market", side: "buy", symbol: "BTC-USD", qty: "0.01000000" });
    expect(sockets[0]?.sent.map((m) => m.type)).toEqual(["command_text"]);
  });

  test("rejects an empty, blank, too long, or non-string command (Req 24.7)", async () => {
    const { get, sockets } = setup();
    for (const args of [{ command: "" }, { command: "   " }, { command: "B".repeat(257) }, { command: 42 }, {}]) {
      const result = await get("preview_order").run(args);
      expect(result.isError).toBe(true);
      expect(text(result)).toStartWith("Invalid arguments: command");
    }
    expect(sockets).toHaveLength(0);
  });

  test("a parse error is an error result with the server's message", async () => {
    const { get } = setup(undefined, (ws, msg) => {
      if (msg.type === "command_text") {
        ws.receive({ type: "parse_error", request_id: msg.request_id, message: "expected a quantity", position: 8 });
      }
    });
    const result = await get("preview_order").run({ command: "BUY BTC" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("expected a quantity");
    expectNoStack(result);
  });

  test("plain English while the LLM is disabled is an error result", async () => {
    const { get } = setup(undefined, (ws, msg) => {
      if (msg.type === "command_text") {
        ws.receive({ type: "notice", kind: "llm_disabled", message: "Plain-English orders are disabled." });
      }
    });
    const result = await get("preview_order").run({ command: "? buy some sol" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("plain-English orders are disabled");
  });
});

describe("place_paper_order", () => {
  test("confirms and returns the fill (Req 24.6)", async () => {
    const { get, sockets } = setup(undefined, (ws, msg) => {
      if (msg.type === "command_text") ws.receive(previewReply(msg.request_id));
      if (msg.type === "confirm") {
        ws.receive(event({ type: "order_ack", account_id: "guest", venue: "replay", order_id: "o1", status: "accepted" }));
        ws.receive(
          event({
            type: "fill",
            account_id: "guest",
            venue: "replay",
            order_id: "o1",
            symbol: "BTC-USD",
            side: "buy",
            price: "6400100",
            qty: "1000000",
            fee: "6400100000",
            remaining: "0",
            ts: 1_700_000_000_500,
          }),
        );
      }
    });
    const result = await get("place_paper_order").run({ command: "BUY BTC 0.01" });
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(text(result));
    expect(body).toMatchObject({ paper: true, status: "filled", order_id: "o1" });
    expect(body.fills[0]).toMatchObject({ price: "64001.00", qty: "0.01000000", fee_usd: "0.6400100000" });
    expect(sockets[0]?.sent[1]).toMatchObject({ type: "confirm", preview_id: "p1" });
  });

  test("a risk rejection is an error result naming the reason", async () => {
    const { get } = setup(undefined, (ws, msg) => {
      if (msg.type === "command_text") ws.receive(previewReply(msg.request_id));
      if (msg.type === "confirm") {
        ws.receive(event({ type: "order_rejected", account_id: "guest", venue: "replay", order_id: "o2", reason: "kill_switch" }));
      }
    });
    const result = await get("place_paper_order").run({ command: "BUY BTC 0.01" });
    expect(result.isError).toBe(true);
    expect(text(result)).toStartWith("Paper order rejected: kill_switch");
    expectNoStack(result);
  });

  test("a timeout is an error result", async () => {
    const { get } = setup(undefined, (ws, msg) => {
      if (msg.type === "command_text") ws.receive(previewReply(msg.request_id));
    });
    const result = await get("place_paper_order").run({ command: "BUY BTC 0.01" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("timeout");
    expectNoStack(result);
  });

  test("ignores any account field in the arguments (trading-safety rule 10)", async () => {
    const { get, sockets } = setup(undefined, (ws, msg) => {
      if (msg.type === "command_text") ws.receive(previewReply(msg.request_id));
      if (msg.type === "confirm") {
        ws.receive(event({ type: "order_rejected", account_id: "guest", venue: "replay", order_id: "o3", reason: "price_band" }));
      }
    });
    await get("place_paper_order").run({ command: "BUY BTC 0.01", account_id: "w_victim" });
    expect(JSON.stringify(sockets[0]?.sent)).not.toContain("w_victim");
  });
});

describe("failureResult", () => {
  test("hides the message of unexpected errors", () => {
    const err = new Error("boom: SESSION_SECRET=abc");
    const result = failureResult(err);
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Error (internal): the MCP tool failed unexpectedly");
  });
});
