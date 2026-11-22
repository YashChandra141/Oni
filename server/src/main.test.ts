// End-to-end check of the Bun.serve wiring on 127.0.0.1 with a free port and a fake supervisor
// (no engine is spawned). Req 17.1, 17.2, 17.5, 17.6.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { loadConfig } from "./config.ts";
import { FakeSupervisor } from "./gateway/testing.ts";
import { type RunningServer, startServer } from "./main.ts";
import type { ServerMessage } from "./protocol.ts";

const supervisor = new FakeSupervisor();
let running: RunningServer;
let base: string;

beforeAll(() => {
  const result = loadConfig({ ALLOWED_ORIGINS: "http://localhost:3000" });
  if (!result.ok) throw result.error;
  const silent = { info: () => {}, warn: () => {}, error: () => {} };
  running = startServer({ config: result.config, port: 0, hostname: "127.0.0.1", supervisor, logger: silent });
  base = `127.0.0.1:${running.port}`;
});

afterAll(async () => {
  await running.stop();
});

/** A WebSocket client whose messages can be awaited in order. */
async function connect(): Promise<{ ws: WebSocket; next: () => Promise<ServerMessage> }> {
  const ws = new WebSocket(`ws://${base}/ws`);
  const queue: ServerMessage[] = [];
  const waiters: ((m: ServerMessage) => void)[] = [];
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(String(e.data)) as ServerMessage;
    const waiter = waiters.shift();
    if (waiter === undefined) queue.push(msg);
    else waiter(msg);
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("websocket error")), { once: true });
  });
  const next = () => {
    const queued = queue.shift();
    return queued === undefined ? new Promise<ServerMessage>((resolve) => waiters.push(resolve)) : Promise.resolve(queued);
  };
  return { ws, next };
}

describe("startServer", () => {
  test("starts the supervisor and serves /health", async () => {
    expect(supervisor.started).toBe(1);
    const res = await fetch(`http://${base}/health`);
    expect(res.status).toBe(200);
    // oni-terminal-v2 Req 1.9: no db field; one venue entry (replay) and a summary per latency stage.
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      engine: "running",
      session_id: "session-1",
      venues: [{ venue: "replay", status: "connected" }],
    });
    expect("db" in body).toBe(false);
    expect(Object.keys(body.latency as object).sort()).toEqual([
      "command_to_preview",
      "confirm_to_ack",
      "emit_to_write",
      "receipt_to_client",
    ]);
  });

  test("engine Fill and OrderRejected events reach the Activity_Log; a new engine session clears it (Req 2.1, 2.2)", async () => {
    // A Router order record, so the engine rejection can inherit its source.
    running.activity.append({
      kind: "order",
      venue: "replay",
      accountId: "guest",
      orderId: "o_r",
      symbol: "BTC-USD",
      side: "buy",
      qty: 5n,
      orderKind: "market",
      price: null,
      source: "tui",
      ts: 1,
    });
    supervisor.emitEvent({
      type: "fill",
      account_id: "guest",
      venue: "replay",
      order_id: "o_f",
      symbol: "BTC-USD",
      side: "sell",
      price: "6400000",
      qty: "10",
      fee: "3",
      remaining: "0",
      ts: 2,
    });
    supervisor.emitEvent({
      type: "order_rejected",
      account_id: "guest",
      venue: "replay",
      order_id: "o_r",
      reason: "insufficient_balance",
    });

    const rows = (await (await fetch(`http://${base}/journal`)).json()) as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ type: "rejection", order_id: "o_r", reason: "insufficient_balance", source: "tui", venue: "replay", qty: "5" });
    expect(rows[1]).toMatchObject({ type: "fill", order_id: "o_f", venue: "replay", price: "6400000", fee: "3" });
    expect(rows[2]).toMatchObject({ type: "order", order_id: "o_r" });

    supervisor.emitSessionStart("session-2");
    expect(await (await fetch(`http://${base}/journal`)).json()).toEqual([]);
  });

  test("an Authorization header that is not a valid token gets 401 on /orders but not on /health", async () => {
    const headers = { Authorization: "Bearer nope" };
    expect((await fetch(`http://${base}/orders`, { headers })).status).toBe(401);
    expect((await fetch(`http://${base}/health`, { headers })).status).toBe(200);
  });

  test("rejects a /ws upgrade from a foreign Origin with 403 (Req 17.2)", async () => {
    const res = await fetch(`http://${base}/ws`, {
      headers: { Origin: "https://evil.example", Connection: "Upgrade", Upgrade: "websocket" },
    });
    expect(res.status).toBe(403);
  });

  test("answers a plain GET /ws with 426", async () => {
    const res = await fetch(`http://${base}/ws`);
    expect(res.status).toBe(426);
  });

  test("order actions reach the Router; a supervisor without an order sender gives engine_unavailable (Req 15.5, 18.1)", async () => {
    const { ws, next } = await connect();
    try {
      await next(); // hello
      await next(); // session
      ws.send(JSON.stringify({ type: "cancel_all", request_id: "r1", account_id: "w_victim" }));
      const msg = await next();
      expect(msg.type === "event" && msg.event.type === "error" && msg.event.code).toBe("invalid_command");
      expect(msg.type === "event" && msg.event.type === "error" && msg.event.message).toBe(
        "cancel all rejected: engine_unavailable",
      );
      expect(running.router).toBeDefined();
    } finally {
      ws.close();
    }
  });

  test("a client without Origin gets Hello, a guest Session, and subscribed market events (Req 1.8, 17.1, 17.6)", async () => {
    const { ws, next } = await connect();
    try {
      expect((await next()).type).toBe("hello");
      expect(await next()).toEqual({ type: "session", account_id: "guest", address: null });
      ws.send(JSON.stringify({ type: "subscribe", venue: "replay", symbol: "BTC-USD", timeframe: "1m" }));
      ws.send(JSON.stringify({ type: "ping", id: 1 }));
      expect(await next()).toEqual({ type: "pong", id: 1 }); // messages are handled in order
      expect(supervisor.sent).toContainEqual({ type: "subscribe", venue: "replay", symbol: "BTC-USD", timeframe: "1m" });

      const trade = {
        type: "trade",
        venue: "replay",
        symbol: "BTC-USD",
        price: "100",
        qty: "1",
        side: "buy",
        synthetic: false,
        ts: 1,
      } as const;
      supervisor.emitEvent(trade);
      // Events reach a client inside an event_batch, after the 10 ms flush window (Req 34).
      expect(await next()).toEqual({ type: "event_batch", events: [trade] });

      ws.send("garbage");
      const err = await next();
      expect(err.type === "event" && err.event.type === "error" && err.event.code).toBe("invalid_message");
      expect(ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      ws.close();
    }
  });
});
