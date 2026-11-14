// TerminalClient unit tests (Task 14.1, Req 24.2-24.6). Fake fetch and fake WebSocket only.

import { describe, expect, test } from "bun:test";
import { TerminalClient, TerminalError, normalizeBaseUrl, wsUrlFor } from "./client.ts";
import { type ServerScript, event, fakeFetch, fakeWebSocket, json, previewReply } from "./testing.ts";

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

const FILL = {
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
};

async function rejection(p: Promise<unknown>): Promise<TerminalError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof TerminalError) return err;
    throw err;
  }
  throw new Error("expected a rejection");
}

let ids = 0;
const nextId = () => `r${++ids}`;

function wsClient(script: ServerScript, extra: { accountId?: string; greet?: boolean; timeouts?: number } = {}) {
  const ws = fakeWebSocket(script, {
    ...(extra.accountId === undefined ? {} : { accountId: extra.accountId }),
    ...(extra.greet === undefined ? {} : { greet: extra.greet }),
  });
  const t = extra.timeouts ?? 200;
  const client = new TerminalClient({
    baseUrl: BASE,
    WebSocket: ws.WebSocket,
    fetch: async () => json({}),
    randomId: nextId,
    connectTimeoutMs: t,
    previewTimeoutMs: t,
    placeTimeoutMs: t,
    settleMs: 30,
  });
  return { client, ...ws };
}

/** Answers command_text with a preview and confirm with `onConfirm`. */
function orderScript(onConfirm: ServerScript): ServerScript {
  return (ws, msg) => {
    if (msg.type === "command_text") ws.receive(previewReply(msg.request_id));
    else if (msg.type === "confirm") onConfirm(ws, msg);
  };
}

describe("URLs", () => {
  test("ws URL follows the base scheme and appends /ws", () => {
    expect(wsUrlFor("http://localhost:8080")).toBe("ws://localhost:8080/ws");
    expect(wsUrlFor("https://oni.example.com/")).toBe("wss://oni.example.com/ws");
    expect(wsUrlFor("https://oni.example.com/base/")).toBe("wss://oni.example.com/base/ws");
  });

  test("base URL must be http or https", () => {
    expect(() => normalizeBaseUrl("ftp://x")).toThrow(TypeError);
    expect(() => normalizeBaseUrl("not a url")).toThrow(TypeError);
  });
});

describe("REST", () => {
  test("quote, candles, and positions use the server's paths and query strings", async () => {
    const { fetch, calls } = fakeFetch((url) => {
      if (url.includes("/quote/")) return json(QUOTE);
      if (url.includes("/candles/")) return json({ symbol: "ETH-USD", timeframe: "5m", bars: [] });
      return json([{ symbol: "BTC-USD", qty: "1000000", avg_entry: "6400000", realized: "0", unrealized: "-5" }]);
    });
    const client = new TerminalClient({ baseUrl: `${BASE}/`, fetch });

    const quote = await client.quote("BTC-USD");
    const candles = await client.candles("ETH-USD", "5m", 50);
    const positions = await client.positions();

    expect(calls.map((c) => c.url)).toEqual([
      `${BASE}/quote/BTC-USD`,
      `${BASE}/candles/ETH-USD?timeframe=5m&limit=50`,
      `${BASE}/positions`,
    ]);
    // Without a token there is no Authorization header (guest account, Req 20.28).
    expect(calls.every((c) => c.headers.authorization === undefined)).toBe(true);
    // Decimal strings stay strings.
    expect(quote.last?.price).toBe("6400000");
    expect(candles.bars).toEqual([]);
    expect(positions[0]?.unrealized).toBe("-5");
  });

  test("a token from the hook goes in the Authorization header", async () => {
    const { fetch, calls } = fakeFetch(() => json([]));
    const client = new TerminalClient({ baseUrl: BASE, fetch, token: () => "tok" });
    await client.positions();
    expect(calls[0]?.headers.authorization).toBe("Bearer tok");
  });

  test("HTTP errors carry the status and the server's error code", async () => {
    const { fetch } = fakeFetch(() => json({ error: "no_data" }, 404));
    const err = await rejection(new TerminalClient({ baseUrl: BASE, fetch }).quote("SOL-USD"));
    expect(err.kind).toBe("http");
    expect(err.status).toBe(404);
    expect(err.code).toBe("no_data");
  });

  test("401 is unauthorized", async () => {
    const { fetch } = fakeFetch(() => json({ error: "invalid_token" }, 401));
    const err = await rejection(new TerminalClient({ baseUrl: BASE, fetch, token: () => "secret-token" }).positions());
    expect(err.kind).toBe("unauthorized");
    expect(err.message).not.toContain("secret-token");
  });

  test("a network failure is unavailable and does not quote the underlying error", async () => {
    const fetch = async (): Promise<Response> => {
      throw new Error("connect ECONNREFUSED password=hunter2");
    };
    const err = await rejection(new TerminalClient({ baseUrl: BASE, fetch }).positions());
    expect(err.kind).toBe("unavailable");
    expect(err.message).not.toContain("hunter2");
  });

  test("a response that does not match the schema is a protocol error", async () => {
    // Numbers instead of decimal strings are rejected.
    const { fetch } = fakeFetch(() => json({ ...QUOTE, last: { ...QUOTE.last, price: 6400000 } }));
    const err = await rejection(new TerminalClient({ baseUrl: BASE, fetch }).quote("BTC-USD"));
    expect(err.kind).toBe("protocol");
  });
});

describe("preview", () => {
  test("sends command_text and resolves on the matching preview", async () => {
    const { client, sockets } = wsClient((ws, msg) => {
      if (msg.type !== "command_text") return;
      ws.receive(previewReply("someone-else", "px")); // not ours
      ws.receive(previewReply(msg.request_id, "p7"));
    });
    const preview = await client.preview("buy btc 0.01");
    expect(preview.preview_id).toBe("p7");
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.url).toBe("ws://localhost:8080/ws");
    const sent = sockets[0]?.sent ?? [];
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "command_text", text: "buy btc 0.01" });
    // Nothing is confirmed (Req 24.5).
    expect(sent.some((m) => m.type === "confirm")).toBe(false);
  });

  test("rejects on the matching parse_error with its position", async () => {
    const { client } = wsClient((ws, msg) => {
      if (msg.type === "command_text") {
        ws.receive({ type: "parse_error", request_id: msg.request_id, message: "unknown symbol 'DOGE'", position: 4 });
      }
    });
    const err = await rejection(client.preview("BUY DOGE 1"));
    expect(err.kind).toBe("parse_error");
    expect(err.message).toContain("unknown symbol");
    expect(err.message).toContain("4");
  });

  test("llm_disabled notice rejects a plain-English preview", async () => {
    const { client } = wsClient((ws, msg) => {
      if (msg.type === "command_text") {
        ws.receive({ type: "notice", kind: "llm_disabled", message: "Plain-English orders are disabled." });
      }
    });
    const err = await rejection(client.preview("? buy a little bitcoin"));
    expect(err.kind).toBe("llm_disabled");
  });

  test("times out when no matching reply arrives", async () => {
    const { client } = wsClient((ws, msg) => {
      if (msg.type === "command_text") ws.receive(previewReply("other"));
    }, { timeouts: 40 });
    const err = await rejection(client.preview("BUY BTC 0.01"));
    expect(err.kind).toBe("timeout");
  });

  test("times out when the server never sends Hello", async () => {
    const { client } = wsClient(() => {}, { greet: false, timeouts: 40 });
    const err = await rejection(client.preview("BUY BTC 0.01"));
    expect(err.kind).toBe("timeout");
  });

  test("reconnects on the next call after the socket closed", async () => {
    const { client, sockets } = wsClient((ws, msg) => {
      if (msg.type === "command_text") ws.receive(previewReply(msg.request_id));
    });
    await client.preview("BUY BTC 0.01");
    sockets[0]?.serverClose();
    await client.preview("BUY BTC 0.01");
    expect(sockets).toHaveLength(2);
  });

  test("a close during the request rejects as unavailable", async () => {
    const { client } = wsClient((ws, msg) => {
      if (msg.type === "command_text") ws.serverClose();
    });
    const err = await rejection(client.preview("BUY BTC 0.01"));
    expect(err.kind).toBe("unavailable");
  });
});

describe("place", () => {
  test("confirms the returned preview_id and reports the fill", async () => {
    const { client, sockets } = wsClient(
      orderScript((ws) => {
        // Another account's events are ignored.
        ws.receive(event({ type: "order_ack", account_id: "w_other", order_id: "x9", status: "accepted" }));
        ws.receive(event({ type: "order_ack", account_id: "guest", order_id: "o1", status: "accepted" }));
        ws.receive(event(FILL));
        ws.receive(event({ type: "order_ack", account_id: "guest", order_id: "o1", status: "filled" }));
      }),
    );
    const outcome = await client.place("BUY BTC 0.01");

    const sent = sockets[0]?.sent ?? [];
    expect(sent.map((m) => m.type)).toEqual(["command_text", "confirm"]);
    expect(sent[1]).toMatchObject({ type: "confirm", preview_id: "p1" });
    // No account field is ever sent (trading-safety rule 10).
    expect(JSON.stringify(sent)).not.toContain("account");

    expect(outcome.status).toBe("filled");
    expect(outcome.order_id).toBe("o1");
    expect(outcome.reason).toBeNull();
    expect(outcome.fills).toHaveLength(1);
    expect(outcome.fills[0]?.price).toBe("6400100");
    expect(outcome.command).toBe("BUY BTC-USD 0.01");
  });

  test("reports the Router or Risk_Engine rejection reason", async () => {
    const { client } = wsClient(
      orderScript((ws) => {
        ws.receive(event({ type: "order_rejected", account_id: "guest", order_id: "o2", reason: "max_order_value" }));
      }),
    );
    const outcome = await client.place("BUY BTC 100");
    expect(outcome.status).toBe("rejected");
    expect(outcome.reason).toBe("max_order_value");
    expect(outcome.order_id).toBe("o2");
  });

  test("a confirm Error event is a rejection with its message", async () => {
    const { client } = wsClient(
      orderScript((ws) => {
        ws.receive(event({ type: "error", code: "invalid_command", message: "confirm rejected: expired" }));
      }),
    );
    const outcome = await client.place("BUY BTC 0.01");
    expect(outcome.status).toBe("rejected");
    expect(outcome.reason).toBe("confirm rejected: expired");
  });

  test("an accepted order without fills is open after the settle window", async () => {
    const { client } = wsClient(
      orderScript((ws) => {
        ws.receive(event({ type: "order_ack", account_id: "guest", order_id: "o3", status: "accepted" }));
      }),
    );
    const outcome = await client.place("BUY BTC 0.01 LMT 60000");
    expect(outcome.status).toBe("open");
    expect(outcome.order_id).toBe("o3");
  });

  test("uses the session's account for correlation", async () => {
    const { client } = wsClient(
      orderScript((ws) => {
        ws.receive(event({ type: "order_rejected", account_id: "guest", order_id: "g1", reason: "rate_limit" }));
        ws.receive(event({ type: "order_ack", account_id: "w_abc", order_id: "o4", status: "accepted" }));
        ws.receive(event({ ...FILL, account_id: "w_abc", order_id: "o4" }));
      }),
      { accountId: "w_abc" },
    );
    const outcome = await client.place("BUY BTC 0.01");
    expect(outcome.status).toBe("filled");
    expect(outcome.order_id).toBe("o4");
  });

  test("times out when no outcome arrives", async () => {
    const { client } = wsClient(orderScript(() => {}), { timeouts: 40 });
    const err = await rejection(client.place("BUY BTC 0.01"));
    expect(err.kind).toBe("timeout");
  });

  test("a parse error stops before any confirm", async () => {
    const { client, sockets } = wsClient((ws, msg) => {
      if (msg.type === "command_text") {
        ws.receive({ type: "parse_error", request_id: msg.request_id, message: "expected a quantity", position: 8 });
      }
    });
    const err = await rejection(client.place("BUY BTC"));
    expect(err.kind).toBe("parse_error");
    expect(sockets[0]?.sent.some((m) => m.type === "confirm")).toBe(false);
  });
});

describe("token hook (Task 14.3 groundwork)", () => {
  test("sends Authenticate after Hello and waits for the new Session", async () => {
    const ws = fakeWebSocket((sock, msg) => {
      if (msg.type === "authenticate") sock.receive({ type: "session", account_id: "w_abc", address: "abc" });
      if (msg.type === "command_text") sock.receive(previewReply(msg.request_id));
    });
    const client = new TerminalClient({ baseUrl: BASE, WebSocket: ws.WebSocket, token: () => "tok", randomId: nextId });
    await client.preview("BUY BTC 0.01");
    expect(ws.sockets[0]?.sent.map((m) => m.type)).toEqual(["authenticate", "command_text"]);
  });

  test("auth_failed rejects as unauthorized without echoing the token", async () => {
    const ws = fakeWebSocket((sock, msg) => {
      if (msg.type === "authenticate") {
        sock.receive({ type: "session", account_id: "guest", address: null });
        sock.receive({ type: "notice", kind: "auth_failed", message: "Sign-in failed; you are on the guest account." });
      }
    });
    // The two guest Sessions (after Hello, and after the failed Authenticate) must not make
    // the connection ready; the notice decides.
    const client = new TerminalClient({
      baseUrl: BASE,
      WebSocket: ws.WebSocket,
      token: () => "secret-token",
      randomId: nextId,
      connectTimeoutMs: 100,
    });
    const err = await rejection(client.preview("BUY BTC 0.01"));
    expect(err.kind).toBe("unauthorized");
    expect(err.message).not.toContain("secret-token");
    expect(ws.sockets[0]?.sent.some((m) => m.type === "command_text")).toBe(false);
  });
});
