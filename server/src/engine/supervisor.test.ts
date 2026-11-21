// Unit tests for the Engine_Supervisor (Req 15.1, 15.4, 15.6, 15.7, 15.8, 18.3, 18.4) with a fake
// engine process. The real engine is spawned only in the Task 3.6 integration test.
import { describe, expect, test } from "bun:test";
import type { SecretSource } from "../config.ts";
import type { Command, Event } from "../protocol.ts";
import { Backoff } from "./backoff.ts";
import { MAX_EVENT_LINE_BYTES } from "./lines.ts";
import {
  type ControlCommand,
  type EngineNotice,
  type EngineProcess,
  type EngineSpawnRequest,
  type EngineStatus,
  type EngineStdin,
  EngineSupervisor,
  type OrderCommand,
  type Timers,
  encodeCommand,
  engineArgv,
  engineEnv,
} from "./supervisor.ts";

const enc = new TextEncoder();

const API_KEY = "sk-test-key-123";
const SECRETS: SecretSource = {
  openaiApiKey: API_KEY,
};

/** A controllable engine process: stdout/stderr streams, a stdin sink, and an exit promise. */
class FakeEngine implements EngineProcess {
  readonly pid = 4242;
  readonly written: string[] = [];
  readonly stdin: EngineStdin;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number | null>;
  killed = false;
  private outCtl!: ReadableStreamDefaultController<Uint8Array>;
  private errCtl!: ReadableStreamDefaultController<Uint8Array>;
  private resolveExit!: (code: number) => void;
  private done = false;

  constructor() {
    this.stdin = {
      write: (chunk: string) => {
        if (this.done) throw new Error("EPIPE");
        this.written.push(chunk);
        return chunk.length;
      },
      flush: () => 0,
    };
    this.stdout = new ReadableStream<Uint8Array>({ start: (c) => void (this.outCtl = c) });
    this.stderr = new ReadableStream<Uint8Array>({ start: (c) => void (this.errCtl = c) });
    this.exited = new Promise((resolve) => (this.resolveExit = resolve));
  }

  out(text: string): void {
    this.outCtl.enqueue(enc.encode(text));
  }

  err(text: string): void {
    this.errCtl.enqueue(enc.encode(text));
  }

  /** Exits. With `closeStreams = false` the output pipes stay open, as with buffered output. */
  exit(code = 1, closeStreams = true): void {
    if (this.done) return;
    this.done = true;
    if (closeStreams) {
      this.outCtl.close();
      this.errCtl.close();
    }
    this.resolveExit(code);
  }

  kill(): void {
    this.killed = true;
    this.exit(143);
  }

  commands(): Command[] {
    return this.written.map((line) => JSON.parse(line) as Command);
  }
}

/** Timers the test runs by hand. */
class FakeTimers implements Timers {
  private nextId = 1;
  pending: { id: number; ms: number; fn: () => void }[] = [];

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.pending.push({ id, ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.pending = this.pending.filter((t) => t.id !== handle);
  }

  /** Runs the oldest pending timer and returns its delay. */
  runNext(): number {
    const timer = this.pending.shift();
    if (timer === undefined) throw new Error("no pending timer");
    timer.fn();
    return timer.ms;
  }
}

/** Lets stream reads and the exit promise settle. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function harness(
  options: {
    dataMode?: "replay" | "live";
    liveVenue?: "coinbase" | "backpack";
    spawnFailures?: number;
    replaySpeed?: number;
  } = {},
) {
  const engines: FakeEngine[] = [];
  const requests: EngineSpawnRequest[] = [];
  const timers = new FakeTimers();
  const clock = { t: 1_000 };
  const logs: { level: "info" | "warn" | "error"; line: string }[] = [];
  let failures = options.spawnFailures ?? 0;

  const sup = new EngineSupervisor({
    config: {
      enginePath: "/opt/engine",
      dataMode: options.dataMode ?? "replay",
      liveVenue: options.liveVenue ?? "backpack",
      replayFixture: "demo.jsonl",
      replaySpeed: options.replaySpeed ?? 1,
      ...SECRETS,
    },
    fixturesDir: "/data/fixtures",
    spawn: (request) => {
      requests.push(request);
      if (failures > 0) {
        failures -= 1;
        throw new Error(`spawn failed near ${SECRETS.openaiApiKey}`);
      }
      const engine = new FakeEngine();
      engines.push(engine);
      return engine;
    },
    timers,
    backoff: new Backoff({ now: () => clock.t }),
    logger: {
      info: (line) => logs.push({ level: "info", line }),
      warn: (line) => logs.push({ level: "warn", line }),
      error: (line) => logs.push({ level: "error", line }),
    },
  });

  const events: Event[] = [];
  const notices: EngineNotice[] = [];
  const statuses: EngineStatus[] = [];
  let clears = 0;
  sup.onEvent((e) => events.push(e));
  sup.onNotice((n) => notices.push(n));
  sup.onStatus((s) => statuses.push(s));
  sup.onClearAccount(() => {
    clears += 1;
  });

  const latest = (): FakeEngine => {
    const engine = engines.at(-1);
    if (engine === undefined) throw new Error("no engine spawned");
    return engine;
  };

  return { sup, engines, requests, timers, clock, logs, events, notices, statuses, clears: () => clears, latest };
}

const PLACE: OrderCommand = {
  type: "place_order",
  account_id: "guest",
  venue: "replay",
  order_id: "o_1_abc",
  symbol: "BTC-USD",
  side: "buy",
  qty: "10",
  kind: { type: "market" },
};

describe("engine command line and environment", () => {
  test("spawns `engine run --mode <mode> --fixtures <dir> --venue <venue>` (Req 15.1, 44.1)", () => {
    expect(engineArgv({ enginePath: "/opt/engine", mode: "live", fixturesDir: "fx", venue: "coinbase" })).toEqual([
      "/opt/engine",
      "run",
      "--mode",
      "live",
      "--fixtures",
      "fx",
      "--venue",
      "coinbase",
    ]);
    const h = harness();
    h.sup.start();
    expect(h.requests).toEqual([
      { enginePath: "/opt/engine", mode: "replay", fixturesDir: "/data/fixtures", venue: "backpack" },
    ]);
  });

  test("passes LIVE_VENUE from the config as the venue", () => {
    const h = harness({ dataMode: "live", liveVenue: "coinbase" });
    h.sup.start();
    expect(h.requests[0]?.venue).toBe("coinbase");
  });

  test("the engine environment has no secrets", () => {
    const env = engineEnv({ PATH: "/bin", OPENAI_API_KEY: "k" });
    expect(env).toEqual({ PATH: "/bin" });
  });

  test("encodeCommand writes one JSON line", () => {
    expect(encodeCommand({ type: "ping", id: 7 })).toBe('{"type":"ping","id":7}\n');
  });
});

describe("EngineSupervisor stdout and stderr", () => {
  test("valid event lines reach listeners and invalid lines are dropped", async () => {
    const h = harness();
    h.sup.start();
    const engine = h.latest();
    engine.out('{"type":"heartbeat","ts":1}\nnot json\n{"type":"nope"}\n{"type":"po');
    engine.out('ng","id":3}\r\n');
    engine.out(`{"bad":"${SECRETS.openaiApiKey}${"x".repeat(1_000)}"}\n`);
    await tick();

    expect(h.events).toEqual([
      { type: "heartbeat", ts: 1 },
      { type: "pong", id: 3 },
    ]);
    const dropped = h.logs.filter((l) => l.line.includes("dropped an invalid stdout line"));
    expect(dropped).toHaveLength(3);
    expect(dropped[0]?.line).toContain("invalid_json");
    expect(dropped[1]?.line).toContain("invalid_message");
    // Redacted, then truncated.
    expect(dropped[2]?.line).toContain("[redacted]");
    expect(dropped[2]?.line).not.toContain(SECRETS.openaiApiKey ?? "");
    expect(dropped[2]?.line).not.toContain("x".repeat(250));
    expect(dropped[2]?.line).toMatch(/… \(\d+ chars\)"$/);
  });

  test("oversized stdout lines are logged and dropped", async () => {
    const h = harness();
    h.sup.start();
    // Just over the engine-stdout limit (512 KiB, fix task 5.1; the stdin limit stays 64 KiB).
    h.latest().out(`${"y".repeat(MAX_EVENT_LINE_BYTES + 1)}\n{"type":"heartbeat","ts":2}\n`);
    await tick();
    expect(h.events).toEqual([{ type: "heartbeat", ts: 2 }]);
    expect(h.logs.some((l) => l.level === "warn" && l.line.includes("oversized stdout line"))).toBe(true);
  });

  test("stderr is forwarded with the [engine] prefix and redacted (Req 15.6, 16.4)", async () => {
    const h = harness();
    h.sup.start();
    h.latest().err(`INFO engine starting\nWARN connect ${SECRETS.openaiApiKey} failed\nlast line`);
    h.latest().exit(0);
    await tick();
    const lines = h.logs.filter((l) => l.line.startsWith("[engine]")).map((l) => l.line);
    expect(lines).toEqual(["[engine] INFO engine starting", "[engine] WARN connect [redacted] failed", "[engine] last line"]);
    expect(h.logs.some((l) => l.line.includes(API_KEY))).toBe(false);
  });
});

describe("EngineSupervisor stdin", () => {
  test("send returns false while the engine is down", async () => {
    const h = harness();
    const orders = h.sup.createOrderSender();
    expect(h.sup.sendControl({ type: "ping", id: 1 })).toBe(false);
    expect(orders.send(PLACE)).toBe(false);

    h.sup.start();
    expect(h.sup.sendControl({ type: "ping", id: 2 })).toBe(true);
    expect(orders.send(PLACE)).toBe(true);
    expect(h.latest().written.slice(-2)).toEqual([encodeCommand({ type: "ping", id: 2 }), encodeCommand(PLACE)]);

    h.latest().exit(1);
    await tick();
    expect(h.sup.running).toBe(false);
    expect(h.sup.sendControl({ type: "ping", id: 3 })).toBe(false);
    expect(orders.send(PLACE)).toBe(false);
  });

  test("sendControl rejects PlaceOrder and other order commands (Req 18.3)", () => {
    const h = harness();
    h.sup.start();
    const before = h.latest().written.length;
    for (const cmd of [
      PLACE,
      { type: "cancel", account_id: "guest", order_id: "o_1" },
      { type: "cancel_all", account_id: "guest" },
      { type: "reset_account", account_id: "guest" },
    ]) {
      expect(() => h.sup.sendControl(cmd as unknown as ControlCommand)).toThrow(TypeError);
    }
    expect(h.latest().written.length).toBe(before);
  });

  test("only one order sender can be created", () => {
    const h = harness();
    h.sup.createOrderSender();
    expect(() => h.sup.createOrderSender()).toThrow();
  });

  test("StartReplay is sent first, then the resent subscriptions (Req 15.4)", async () => {
    const h = harness();
    h.sup.setSubscriptionProvider(() => [
      { venue: "replay", symbol: "BTC-USD", timeframe: "1m" },
      { venue: "coinbase", symbol: "ETH-USD", timeframe: "1h" },
    ]);
    const expected: Command[] = [
      { type: "start_replay", fixture: "demo.jsonl", speed: 1 },
      { type: "subscribe", venue: "replay", symbol: "BTC-USD", timeframe: "1m" },
      { type: "subscribe", venue: "coinbase", symbol: "ETH-USD", timeframe: "1h" },
    ];
    h.sup.start();
    expect(h.latest().commands()).toEqual(expected);

    // After a restart the new engine gets the same sequence.
    h.latest().exit(1);
    await tick();
    h.timers.runNext();
    expect(h.engines).toHaveLength(2);
    expect(h.latest().commands()).toEqual(expected);
  });

  test("StartReplay carries the configured REPLAY_SPEED", () => {
    const h = harness({ replaySpeed: 50 });
    h.sup.start();
    expect(h.latest().commands()).toEqual([{ type: "start_replay", fixture: "demo.jsonl", speed: 50 }]);
  });

  test("live mode sends no StartReplay", () => {
    const h = harness({ dataMode: "live" });
    h.sup.setSubscriptionProvider(() => [{ venue: "backpack", symbol: "SOL-USD", timeframe: "5m" }]);
    h.sup.start();
    expect(h.latest().commands()).toEqual([
      { type: "subscribe", venue: "backpack", symbol: "SOL-USD", timeframe: "5m" },
    ]);
  });
});

describe("EngineSupervisor lifecycle", () => {
  test("restart delays follow the backoff (Req 15.2, 15.3)", async () => {
    const h = harness();
    h.sup.start();
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      h.clock.t += 100;
      h.latest().exit(1);
      await tick();
      expect(h.timers.pending).toHaveLength(1);
      delays.push(h.timers.runNext());
    }
    expect(delays).toEqual([500, 1000, 2000, 4000]);
    expect(h.engines).toHaveLength(5);

    // 60 s of uptime resets the delay.
    h.clock.t += 60_000;
    h.latest().exit(1);
    await tick();
    expect(h.timers.runNext()).toBe(500);
  });

  test("a failed spawn is logged (redacted) and retried with backoff", () => {
    const h = harness({ spawnFailures: 2 });
    h.sup.start();
    expect(h.sup.running).toBe(false);
    expect(h.timers.runNext()).toBe(500);
    expect(h.timers.runNext()).toBe(1000);
    expect(h.sup.running).toBe(true);
    const errors = h.logs.filter((l) => l.level === "error");
    expect(errors).toHaveLength(2);
    expect(errors.some((l) => l.line.includes(API_KEY))).toBe(false);
  });

  test("account_reset is sent only on restart (Req 15.7)", async () => {
    const h = harness();
    h.sup.start();
    expect(h.notices.map((n) => n.kind)).toEqual(["engine_up"]);
    expect(h.clears()).toBe(0);

    h.latest().exit(1);
    await tick();
    expect(h.notices.map((n) => n.kind)).toEqual(["engine_up", "engine_down"]);
    expect(h.clears()).toBe(1);

    h.timers.runNext();
    expect(h.notices.map((n) => n.kind)).toEqual(["engine_up", "engine_down", "account_reset", "engine_up"]);
  });

  test("sessionId changes on each start and survives the exit (Req 20.18)", async () => {
    const h = harness();
    expect(h.sup.sessionId).toBeNull();
    h.sup.start();
    const first = h.sup.sessionId;
    expect(first).toMatch(/^[0-9a-f-]{36}$/);

    h.latest().exit(1);
    await tick();
    expect(h.sup.sessionId).toBe(first);

    h.timers.runNext();
    expect(h.sup.sessionId).not.toBe(first);
    expect(h.sup.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("status listeners and `running` track the engine", async () => {
    const h = harness();
    expect(h.sup.running).toBe(false);
    h.sup.start();
    expect(h.sup.running).toBe(true);
    h.latest().exit(1);
    await tick();
    expect(h.statuses.map((s) => s.running)).toEqual([true, false]);
  });

  test("output from a replaced engine is dropped", async () => {
    const h = harness();
    h.sup.start();
    const old = h.latest();
    old.exit(1, false);
    await tick();
    // Late output before the restart still belongs to the current generation.
    old.out('{"type":"heartbeat","ts":8}\n');
    await tick();
    h.timers.runNext();
    old.out('{"type":"heartbeat","ts":7}\n');
    h.latest().out('{"type":"heartbeat","ts":9}\n');
    await tick();
    expect(h.events).toEqual([
      { type: "heartbeat", ts: 8 },
      { type: "heartbeat", ts: 9 },
    ]);
  });

  test("stop cancels the pending restart", async () => {
    const h = harness();
    h.sup.start();
    h.latest().exit(1);
    await tick();
    expect(h.timers.pending).toHaveLength(1);

    await h.sup.stop();
    expect(h.timers.pending).toHaveLength(0);
    expect(h.engines).toHaveLength(1);
    expect(h.sup.running).toBe(false);
  });

  test("stop kills a running engine, resolves after exit, and schedules no restart", async () => {
    const h = harness();
    h.sup.start();
    const stopped = h.sup.stop();
    expect(h.latest().killed).toBe(true);
    await stopped;
    expect(h.sup.running).toBe(false);
    expect(h.timers.pending).toHaveLength(0);
    expect(h.notices.at(-1)?.kind).toBe("engine_down");
    // A later start spawns a new engine, which is a restart of the paper account.
    h.sup.start();
    expect(h.engines).toHaveLength(2);
    expect(h.notices.slice(-2).map((n) => n.kind)).toEqual(["account_reset", "engine_up"]);
  });
});
