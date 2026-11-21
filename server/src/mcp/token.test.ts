// TERMINAL_TOKEN tests (Task 14.3, Req 24.4, 24.9-24.11). Fake WebSocket and fetch only: the
// mock server side records every client message and REST header. No network.

import { afterEach, describe, expect, test } from "bun:test";
import { TerminalClient } from "./client.ts";
import { parseMcpEnv } from "./main.ts";
import { event, fakeFetch, fakeWebSocket, json, previewReply, session } from "./testing.ts";
import { createTools } from "./tools.ts";

const BASE = "http://localhost:8080";
const TOKEN = "sekret.Tok3n-value_ABC123";

let ids = 0;
const nextId = () => `t${++ids}`;

const origError = console.error;
const origLog = console.log;
const origWarn = console.warn;
afterEach(() => {
  console.error = origError;
  console.log = origLog;
  console.warn = origWarn;
});

/** Captures everything written through console.* while `fn` runs. */
async function captureLogs<T>(fn: () => Promise<T>): Promise<{ value: T; logs: string }> {
  const lines: string[] = [];
  const push = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  console.error = push;
  console.log = push;
  console.warn = push;
  try {
    return { value: await fn(), logs: lines.join("\n") };
  } finally {
    console.error = origError;
    console.log = origLog;
    console.warn = origWarn;
  }
}

describe("parseMcpEnv TERMINAL_TOKEN (Req 24.9, 24.10)", () => {
  test("unset, empty, blank, and an unexpanded placeholder mean guest", () => {
    for (const v of [undefined, "", "   ", "${TERMINAL_TOKEN}"]) {
      const r = parseMcpEnv({ TERMINAL_TOKEN: v });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.env.TERMINAL_TOKEN).toBeUndefined();
    }
  });

  test("a set token is kept", () => {
    const r = parseMcpEnv({ TERMINAL_TOKEN: TOKEN });
    expect(r.ok && r.env.TERMINAL_TOKEN).toBe(TOKEN);
  });

  test("an invalid token names the variable and never the value (Req 24.11)", () => {
    const bad = "has space inside";
    const r = parseMcpEnv({ TERMINAL_TOKEN: bad });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.variables).toEqual(["TERMINAL_TOKEN"]);
      expect(JSON.stringify(r)).not.toContain("space");
    }
  });
});

describe("WebSocket sign-in (Req 24.9, 24.10)", () => {
  test("sends Authenticate with the token after every connect, including a reconnect", async () => {
    const ws = fakeWebSocket((sock, msg) => {
      if (msg.type === "authenticate") sock.receive(session("w_abc", "abc"));
      if (msg.type === "command_text") sock.receive(previewReply(msg.request_id));
    });
    const client = new TerminalClient({ baseUrl: BASE, WebSocket: ws.WebSocket, token: () => TOKEN, randomId: nextId });
    await client.preview("BUY BTC 0.01");
    ws.sockets[0]?.serverClose();
    await client.preview("BUY BTC 0.01");
    expect(ws.sockets).toHaveLength(2);
    for (const sock of ws.sockets) {
      expect(sock.sent[0]).toEqual({ type: "authenticate", token: TOKEN });
      expect(sock.sent.map((m) => m.type)).toEqual(["authenticate", "command_text"]);
    }
  });

  test("without a token nothing is sent but the command, and no account field either", async () => {
    const ws = fakeWebSocket((sock, msg) => {
      if (msg.type === "command_text") sock.receive(previewReply(msg.request_id));
    });
    const client = new TerminalClient({ baseUrl: BASE, WebSocket: ws.WebSocket, randomId: nextId });
    await client.preview("BUY BTC 0.01");
    expect(ws.sockets[0]?.sent.map((m) => m.type)).toEqual(["command_text"]);
    expect(JSON.stringify(ws.sockets[0]?.sent)).not.toContain("account");
  });

  test("an empty token string is treated as guest", async () => {
    const ws = fakeWebSocket((sock, msg) => {
      if (msg.type === "command_text") sock.receive(previewReply(msg.request_id));
    });
    const client = new TerminalClient({ baseUrl: BASE, WebSocket: ws.WebSocket, token: () => "", randomId: nextId });
    await client.preview("BUY BTC 0.01");
    expect(ws.sockets[0]?.sent.map((m) => m.type)).toEqual(["command_text"]);
  });
});

describe("REST Bearer (Req 24.4, 24.9, 24.10)", () => {
  test("sends Authorization: Bearer with the token on every request", async () => {
    const { fetch, calls } = fakeFetch(() => json([]));
    const client = new TerminalClient({ baseUrl: BASE, fetch, token: () => TOKEN });
    await client.positions();
    await client.positions();
    expect(calls.map((c) => c.headers.authorization)).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
  });

  test("sends no Authorization header without a token", async () => {
    const { fetch, calls } = fakeFetch(() => json([]));
    await new TerminalClient({ baseUrl: BASE, fetch }).positions();
    expect(calls[0]?.headers.authorization).toBeUndefined();
  });
});

describe("rejected token gives a tool error without the token (Req 24.11)", () => {
  const positions = (tools: ReturnType<typeof createTools>) => tools.find((t) => t.name === "get_positions");
  const place = (tools: ReturnType<typeof createTools>) => tools.find((t) => t.name === "place_paper_order");

  test("401 on REST", async () => {
    const { fetch } = fakeFetch(() => json({ error: "invalid_token" }, 401));
    const client = new TerminalClient({ baseUrl: BASE, fetch, token: () => TOKEN });
    const { value, logs } = await captureLogs(() => positions(createTools(client))!.run({}));
    expect(value.isError).toBe(true);
    const text = JSON.stringify(value);
    expect(text).toContain("terminal token rejected");
    expect(text).not.toContain(TOKEN);
    expect(logs).not.toContain(TOKEN);
  });

  test("auth_failed notice on the WebSocket", async () => {
    const ws = fakeWebSocket((sock, msg) => {
      if (msg.type === "authenticate") {
        sock.receive(session("guest"));
        sock.receive({ type: "notice", kind: "auth_failed", message: "Sign-in failed; you are on the guest account." });
      }
    });
    const client = new TerminalClient({
      baseUrl: BASE,
      WebSocket: ws.WebSocket,
      token: () => TOKEN,
      randomId: nextId,
      connectTimeoutMs: 200,
    });
    const { value, logs } = await captureLogs(() => place(createTools(client))!.run({ command: "BUY BTC 0.01" }));
    expect(value.isError).toBe(true);
    const text = JSON.stringify(value);
    expect(text).toContain("terminal token rejected");
    expect(text).not.toContain(TOKEN);
    expect(logs).not.toContain(TOKEN);
    expect(ws.sockets[0]?.sent.some((m) => m.type === "command_text")).toBe(false);
  });
});

describe("tool results never contain the token (Req 24.11)", () => {
  test("a successful signed-in order and positions call", async () => {
    const ws = fakeWebSocket((sock, msg) => {
      if (msg.type === "authenticate") sock.receive(session("w_abc", "abc"));
      if (msg.type === "command_text") sock.receive(previewReply(msg.request_id));
      if (msg.type === "confirm") {
        sock.receive(event({ type: "order_ack", account_id: "w_abc", venue: "replay", order_id: "o1", status: "accepted" }));
        sock.receive(
          event({
            type: "fill",
            account_id: "w_abc",
            venue: "replay",
            order_id: "o1",
            symbol: "BTC-USD",
            side: "buy",
            price: "6400100",
            qty: "1000000",
            fee: "1",
            remaining: "0",
            ts: 1_700_000_000_500,
          }),
        );
      }
    });
    const { fetch } = fakeFetch(() =>
      json([{ symbol: "BTC-USD", qty: "1000000", avg_entry: "6400000", realized: "0", unrealized: "0" }]),
    );
    const client = new TerminalClient({
      baseUrl: BASE,
      WebSocket: ws.WebSocket,
      fetch,
      token: () => TOKEN,
      randomId: nextId,
      settleMs: 20,
    });
    const tools = createTools(client);
    const { value, logs } = await captureLogs(async () => [
      await tools.find((t) => t.name === "place_paper_order")!.run({ command: "BUY BTC 0.01" }),
      await tools.find((t) => t.name === "get_positions")!.run({}),
      await tools.find((t) => t.name === "get_quote")!.run({ symbol: "NOPE" }),
    ]);
    expect(value[0]?.isError).toBeFalsy();
    expect(value[1]?.isError).toBeFalsy();
    expect(JSON.stringify(value)).not.toContain(TOKEN);
    expect(logs).not.toContain(TOKEN);
  });
});
