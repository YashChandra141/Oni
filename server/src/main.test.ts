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
    expect(await res.json()).toEqual({ ok: true, engine: "running", db: "up", session_id: "session-1" });
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
      ws.send(JSON.stringify({ type: "subscribe", symbol: "BTC-USD", timeframe: "1m" }));
      ws.send(JSON.stringify({ type: "ping", id: 1 }));
      expect(await next()).toEqual({ type: "pong", id: 1 }); // messages are handled in order
      expect(supervisor.sent).toContainEqual({ type: "subscribe", symbol: "BTC-USD", timeframe: "1m" });

      const trade = { type: "trade", symbol: "BTC-USD", price: "100", qty: "1", side: "buy", ts: 1 } as const;
      supervisor.emitEvent(trade);
      expect(await next()).toEqual({ type: "event", event: trade });

      ws.send("garbage");
      const err = await next();
      expect(err.type === "event" && err.event.type === "error" && err.event.code).toBe("invalid_message");
      expect(ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      ws.close();
    }
  });
});
