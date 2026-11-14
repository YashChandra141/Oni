// Task 3.6 integration test: the real engine binary under a real EngineSupervisor and a real
// Bun.serve server on 127.0.0.1 (Req 15.1, 15.2).
//
// Heartbeats are not forwarded to clients (gateway design, Task 3.5), so "the engine is alive
// and talking to the server" is checked through these signals:
//   (a) the supervisor's `onEvent` gets a real `heartbeat` from the engine, and a Ping sent on
//       stdin comes back as a Pong;
//   (b) a WS client gets `Hello { engine_running: true }` and `/health` says engine "running";
//   (c) after the test kills the engine, the client gets `engine_down`, `account_reset`, and
//       `engine_up` notices in that order, and `/health` is "running" with a new session_id.
//
// Killing the engine: the test passes `startServer` its own EngineSupervisor whose `spawn`
// wraps the production `spawnEngineProcess` and records each EngineProcess handle it returns.
// `kill()` on that handle is exactly what the supervisor itself would call. No test-only
// accessor was added to production code.
//
// The engine must be built first: `cargo build --manifest-path rust/Cargo.toml -p engine`.
// Without the binary the test is skipped. Real timers throughout; every wait is a promise that
// resolves on the awaited event, with a timeout of at most 10 s.

import { afterAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { loadConfig } from "../config.ts";
import { type EngineProcess, EngineSupervisor, spawnEngineProcess } from "../engine/supervisor.ts";
import { memoryLogger } from "../gateway/testing.ts";
import { REPO_ROOT, type RunningServer, startServer } from "../main.ts";
import type { Event, ServerMessage } from "../protocol.ts";

import { ENGINE_PATH, ENGINE_READY, warnIfSkipped } from "./engineBinary.ts";

const HAVE_ENGINE = ENGINE_READY;
warnIfSkipped("engine.integration.test.ts");

/** Upper bound for any single wait (task 3.6). */
const WAIT_MS = 10_000;
/**
 * The engine's first heartbeat tick fires at once, but the first spawn of a freshly built
 * binary on Windows took ~3.6 s here (process start, likely an antivirus scan); later spawns
 * heartbeat within ~50 ms. So this wait uses the full cap.
 */
const FIRST_HEARTBEAT_MS = WAIT_MS;
const TEST_TIMEOUT_MS = 30_000;

const logs = memoryLogger();

function logTail(): string {
  const tail = logs.lines.slice(-15);
  return tail.length === 0 ? "(no server log lines)" : tail.join("\n");
}

/** Races `promise` against a timer; the timeout error carries the last server log lines. */
function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms waiting for ${label}\n${logTail()}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Resolves with the first engine event matching `pred` seen by the supervisor from now on. */
function nextEngineEvent<T extends Event>(
  supervisor: EngineSupervisor,
  pred: (e: Event) => e is T,
  label: string,
  ms = WAIT_MS,
): Promise<T> {
  let unlisten = (): void => {};
  const seen = new Promise<T>((resolveSeen) => {
    unlisten = supervisor.onEvent((e) => {
      if (pred(e)) resolveSeen(e);
    });
  });
  return within(seen, ms, label).finally(() => unlisten());
}

const isHeartbeat = (e: Event): e is Extract<Event, { type: "heartbeat" }> => e.type === "heartbeat";
const isPong =
  (id: number) =>
  (e: Event): e is Extract<Event, { type: "pong" }> =>
    e.type === "pong" && e.id === id;

/** WebSocket messages in arrival order; `next(pred)` skips non-matching messages. */
class Inbox {
  readonly #queue: ServerMessage[] = [];
  #waiter: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void } | null = null;

  push(message: ServerMessage): void {
    const waiter = this.#waiter;
    if (waiter === null) {
      this.#queue.push(message);
    } else if (waiter.pred(message)) {
      this.#waiter = null;
      waiter.resolve(message);
    }
  }

  next(pred: (m: ServerMessage) => boolean, label: string, ms = WAIT_MS): Promise<ServerMessage> {
    for (let m = this.#queue.shift(); m !== undefined; m = this.#queue.shift()) {
      if (pred(m)) return Promise.resolve(m);
    }
    const arrived = new Promise<ServerMessage>((resolveArrived) => {
      this.#waiter = { pred, resolve: resolveArrived };
    });
    return within(arrived, ms, label).finally(() => {
      this.#waiter = null;
    });
  }
}

const isNotice = (m: ServerMessage): boolean => m.type === "notice";
const noticeKind = (m: ServerMessage): string | null => (m.type === "notice" ? m.kind : null);

interface Health {
  readonly ok: boolean;
  readonly engine: string;
  readonly session_id: string | null;
}

async function health(base: string): Promise<Health> {
  const res = await within(fetch(`http://${base}/health`), WAIT_MS, "GET /health");
  expect(res.status).toBe(200);
  return (await res.json()) as Health;
}

async function connect(base: string): Promise<{ ws: WebSocket; inbox: Inbox }> {
  const ws = new WebSocket(`ws://${base}/ws`);
  const inbox = new Inbox();
  ws.addEventListener("message", (e) => inbox.push(JSON.parse(String(e.data)) as ServerMessage));
  const opened = new Promise<void>((resolveOpen, reject) => {
    ws.addEventListener("open", () => resolveOpen(), { once: true });
    ws.addEventListener("error", () => reject(new Error("websocket error")), { once: true });
  });
  await within(opened, WAIT_MS, "the WebSocket to open");
  return { ws, inbox };
}

const ms = (from: number, to: number): number => Math.round(to - from);

if (!HAVE_ENGINE) {
  test.skip(`engine integration: no current engine binary at ${ENGINE_PATH}; run \`cargo build --manifest-path rust/Cargo.toml -p engine\` first`, () => {});
} else {
  describe("engine integration (real engine binary)", () => {
    /** Every engine process the supervisor started, oldest first. */
    const procs: EngineProcess[] = [];
    let supervisor: EngineSupervisor | undefined;
    let running: RunningServer | undefined;
    let client: WebSocket | undefined;

    afterAll(async () => {
      client?.close();
      await within(running?.stop() ?? Promise.resolve(), 4_000, "the server and engine to stop");
      // No engine process may be left running: every handle's `exited` must have resolved.
      const exits = await within(Promise.all(procs.map((p) => p.exited)), 4_000, "every engine process to exit");
      expect(exits).toHaveLength(procs.length);
      expect(supervisor?.running ?? false).toBe(false);
    });

    test(
      "a real engine heartbeats to the server, and a killed engine is restarted (Req 15.1, 15.2)",
      async () => {
        const result = loadConfig({
          DATA_MODE: "replay",
          ENGINE_PATH,
          ALLOWED_ORIGINS: "http://localhost:3000",
          NODE_ENV: "test",
        });
        if (!result.ok) throw result.error;
        const { config } = result;

        // Default Backoff: the first restart waits 500 ms (Req 15.2).
        const sup = new EngineSupervisor({
          config,
          fixturesDir: resolve(REPO_ROOT, "fixtures"),
          spawn: (request) => {
            const proc = spawnEngineProcess(request);
            procs.push(proc);
            return proc;
          },
          logger: logs,
        });
        supervisor = sup;

        // (a) Listen before start so the first heartbeat cannot be missed.
        const firstHeartbeat = nextEngineEvent(sup, isHeartbeat, "the first engine heartbeat", FIRST_HEARTBEAT_MS);
        const t0 = performance.now();
        running = startServer({ config, port: 0, hostname: "127.0.0.1", supervisor: sup, logger: logs });
        const base = `127.0.0.1:${running.port}`;

        // Req 15.1: the supervisor spawned the engine from ENGINE_PATH.
        expect(procs).toHaveLength(1);
        expect(sup.running).toBe(true);
        await firstHeartbeat;
        const tHeartbeat = performance.now();

        // stdin works too: a Ping written by the supervisor comes back as a Pong.
        const pong = nextEngineEvent(sup, isPong(41), "pong 41");
        expect(sup.sendControl({ type: "ping", id: 41 })).toBe(true);
        await pong;

        // (b) The client connects after start, so it sees Hello, not the first engine_up.
        const { ws, inbox } = await connect(base);
        client = ws;
        const hello = await inbox.next(() => true, "hello");
        expect(hello.type).toBe("hello");
        expect(hello.type === "hello" && hello.engine_running).toBe(true);
        expect(hello.type === "hello" && hello.protocol_version).toBe(2);
        // Req 1.8: a guest Session follows Hello (every connection is guest until Task 19).
        expect(await inbox.next(() => true, "session")).toEqual({ type: "session", account_id: "guest", address: null });

        const before = await health(base);
        expect(before.engine).toBe("running");
        expect(before.session_id).not.toBeNull();
        expect(before.session_id).toBe(sup.sessionId);

        // (c) Kill the engine through the handle the supervisor holds.
        const first = procs[0];
        if (first === undefined) throw new Error("no engine process was recorded");
        const tKill = performance.now();
        first.kill();

        const down = await inbox.next(isNotice, "the engine_down notice");
        expect(noticeKind(down)).toBe("engine_down");
        const tDown = performance.now();
        await within(first.exited, WAIT_MS, "the killed engine to exit");

        // Req 15.2 (and 15.7): restarted after the backoff, with a fresh paper account.
        const reset = await inbox.next(isNotice, "the account_reset notice");
        expect(noticeKind(reset)).toBe("account_reset");
        const up = await inbox.next(isNotice, "the engine_up notice");
        expect(noticeKind(up)).toBe("engine_up");
        const tUp = performance.now();

        expect(procs).toHaveLength(2);
        const second = procs[1];
        expect(second?.pid).toBeDefined();
        expect(second?.pid).not.toBe(first.pid);

        // The new engine talks to the server; output from the old one is dropped by generation.
        await nextEngineEvent(sup, isHeartbeat, "a heartbeat from the restarted engine");
        const tHeartbeat2 = performance.now();

        const after = await health(base);
        expect(after.engine).toBe("running");
        expect(after.session_id).not.toBeNull();
        expect(after.session_id).not.toBe(before.session_id);

        console.log(
          `[engine.integration] first heartbeat ${ms(t0, tHeartbeat)} ms after start; ` +
            `engine_down ${ms(tKill, tDown)} ms after kill; engine_up ${ms(tKill, tUp)} ms after kill; ` +
            `heartbeat from the new engine ${ms(tKill, tHeartbeat2)} ms after kill`,
        );
      },
      TEST_TIMEOUT_MS,
    );
  });
}
