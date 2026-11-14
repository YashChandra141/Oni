// MCP end-to-end tests (Task 14.2, Req 24.1-24.8).
//
// A real MCP Client and McpServer (SDK in-memory transport) with the five tools registered the way
// main.ts does, a real TerminalClient, and a mock Oni server on 127.0.0.1 (random port): REST
// routes plus a WebSocket that speaks the Hello/Session/Preview/Confirm protocol. Nothing leaves
// the machine: no Coinbase, no Backpack, no real network.
//
// Also checks that `.kiro/settings/mcp.json` registers the server and holds no secret.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClientMessage } from "../protocol.ts";
import { TerminalClient } from "./client.ts";
import { HELLO, event, json, previewReply, session } from "./testing.ts";
import { createTools } from "./tools.ts";

const received: ClientMessage[] = [];
const restPaths: string[] = [];
let mock: ReturnType<typeof Bun.serve>;
let terminal: TerminalClient;
let mcp: Client;
let mcpServer: McpServer;

function reply(ws: { send(data: string): void }, msg: unknown): void {
  ws.send(JSON.stringify(msg));
}

beforeAll(async () => {
  mock = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        if (server.upgrade(req)) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      restPaths.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/quote/BTC-USD") {
        return json({
          symbol: "BTC-USD",
          last: { price: "6400000", qty: "1000000", side: "buy", ts: 1_700_000_000_000 },
          book: {
            bid: { price: "6399900", qty: "50000000" },
            ask: { price: "6400100", qty: "25000000" },
            spread: "200",
            imbalance_bps: 3333,
            ts: 1_700_000_000_000,
          },
        });
      }
      if (url.pathname === "/candles/ETH-USD") {
        return json({
          symbol: "ETH-USD",
          timeframe: "5m",
          bars: [
            { t: 1_700_000_100_000, open: "350000", high: "351000", low: "349000", close: "350500", volume: "100000000" },
          ],
        });
      }
      if (url.pathname === "/positions") {
        return json([
          { symbol: "BTC-USD", qty: "1000000", avg_entry: "6400000", realized: "0", unrealized: "0" },
        ]);
      }
      return json({ error: "not_found" }, 404);
    },
    websocket: {
      open(ws) {
        reply(ws, HELLO);
        reply(ws, session("guest"));
      },
      message(ws, data) {
        const msg = JSON.parse(String(data)) as ClientMessage;
        received.push(msg);
        if (msg.type === "command_text") {
          reply(ws, previewReply(msg.request_id, msg.text.includes("9") ? "p-reject" : "p-fill"));
        } else if (msg.type === "confirm") {
          if (msg.preview_id === "p-reject") {
            reply(ws, event({ type: "order_rejected", account_id: "guest", order_id: "o2", reason: "max_order_value" }));
          } else {
            reply(ws, event({ type: "order_ack", account_id: "guest", order_id: "o1", status: "accepted" }));
            reply(
              ws,
              event({
                type: "fill",
                account_id: "guest",
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
        }
      },
    },
  });

  terminal = new TerminalClient({
    baseUrl: `http://127.0.0.1:${mock.port}`,
    previewTimeoutMs: 2000,
    placeTimeoutMs: 2000,
    settleMs: 50,
  });
  mcpServer = new McpServer({ name: "oni-terminal", version: "test" });
  for (const tool of createTools(terminal)) {
    mcpServer.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputShape },
      (args: unknown) => tool.run(args),
    );
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverSide);
  mcp = new Client({ name: "test-client", version: "0" });
  await mcp.connect(clientSide);
});

afterAll(async () => {
  terminal.close();
  await mcp.close();
  await mcpServer.close();
  await mock.stop(true);
});

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = (await mcp.callTool({ name, arguments: args })) as {
    content: { type: string; text: string }[];
    isError?: boolean;
  };
  const text = result.content.map((c) => c.text).join("\n");
  return { isError: result.isError === true, text };
}

describe("MCP end to end (Req 24)", () => {
  test("lists the five tools (Req 24.1)", async () => {
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["get_candles", "get_positions", "get_quote", "place_paper_order", "preview_order"].sort(),
    );
  });

  test("get_quote returns bid, ask, and last (Req 24.2)", async () => {
    const r = await call("get_quote", { symbol: "btc" });
    expect(r.isError).toBe(false);
    const body = JSON.parse(r.text);
    expect(body.best_bid.price).toBe("63999.00");
    expect(body.best_ask.price).toBe("64001.00");
    expect(body.last.price).toBe("64000.00");
  });

  test("get_candles returns bars (Req 24.3)", async () => {
    const r = await call("get_candles", { symbol: "ETH", timeframe: "5m", limit: 10 });
    expect(r.isError).toBe(false);
    expect(restPaths).toContain("/candles/ETH-USD?timeframe=5m&limit=10");
    expect(JSON.parse(r.text).bars[0]).toMatchObject({ open: "3500.00", close: "3505.00" });
  });

  test("get_positions returns the account positions (Req 24.4)", async () => {
    const r = await call("get_positions");
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text).positions[0]).toMatchObject({ symbol: "BTC-USD", qty: "0.01000000" });
  });

  test("preview_order previews and sends no confirm (Req 24.5)", async () => {
    received.length = 0;
    const r = await call("preview_order", { command: "BUY BTC 0.01" });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text)).toMatchObject({ placed: false, preview: "BUY BTC-USD 0.01" });
    expect(received.map((m) => m.type)).toEqual(["command_text"]);
  });

  test("place_paper_order goes over the WebSocket protocol: command_text, then confirm (Req 24.6)", async () => {
    received.length = 0;
    const r = await call("place_paper_order", { command: "BUY BTC 0.01" });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text)).toMatchObject({ status: "filled", order_id: "o1" });
    expect(received.map((m) => m.type)).toEqual(["command_text", "confirm"]);
    expect(received[1]).toMatchObject({ type: "confirm", preview_id: "p-fill" });
    // No account field is ever sent (trading-safety rule 10).
    expect(JSON.stringify(received)).not.toContain("account");
  });

  test("place_paper_order surfaces a router rejection as a tool error", async () => {
    const r = await call("place_paper_order", { command: "BUY BTC 9" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("max_order_value");
  });

  test("invalid arguments return a tool error and reach no server (Req 24.7)", async () => {
    restPaths.length = 0;
    received.length = 0;
    for (const [name, args] of [
      ["get_quote", { symbol: "NOPE" }],
      ["get_candles", { symbol: "BTC", timeframe: "2m" }],
      ["get_candles", { symbol: "BTC", timeframe: "1m", limit: 0 }],
      ["preview_order", { command: "" }],
      ["place_paper_order", {}],
    ] as const) {
      const r = await call(name, args);
      expect(r.isError).toBe(true);
    }
    expect(restPaths).toHaveLength(0);
    expect(received).toHaveLength(0);
  });
});

describe(".kiro/settings/mcp.json (Req 24.8)", () => {
  const path = join(import.meta.dir, "..", "..", "..", ".kiro", "settings", "mcp.json");

  async function load(): Promise<{ mcpServers: Record<string, Record<string, unknown>> }> {
    return JSON.parse(await Bun.file(path).text());
  }

  test("registers oni-terminal to run the MCP entry point with bun", async () => {
    const cfg = await load();
    const entry = cfg.mcpServers["oni-terminal"];
    expect(entry).toBeDefined();
    expect(entry?.command).toBe("bun");
    const args = entry?.args as string[];
    expect(args.join(" ")).toContain("server/src/mcp/main.ts");
    expect(await Bun.file(join(import.meta.dir, "main.ts")).exists()).toBe(true);
  });

  test("holds no token or secret", async () => {
    const raw = await Bun.file(path).text();
    const cfg = await load();
    const env = (cfg.mcpServers["oni-terminal"]?.env ?? {}) as Record<string, string>;
    for (const [key, value] of Object.entries(env)) {
      expect(key).not.toMatch(/token|secret|key|password|database/i);
      expect(value).not.toMatch(/^[A-Za-z0-9_\-+/=.]{32,}$/);
      expect(value).not.toMatch(/bearer|postgres(ql)?:\/\//i);
    }
    expect(raw).not.toMatch(/TERMINAL_TOKEN|SESSION_SECRET|OPENAI_API_KEY|DATABASE_URL|DIRECT_URL/);
    expect(raw).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
  });
});
