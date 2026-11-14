// Task 4.6 demo test: the real engine under `startServer` in replay mode streams candles to a
// WebSocket client (Req 6.1, 6.3, 8.2, 8.7, 8.8, 9.8, 15.4, 17.6).
//
// Setup: DATA_MODE=replay, REPLAY_FIXTURE=demo.jsonl, REPLAY_SPEED=50. The supervisor sends
// `StartReplay` right after the engine starts. The engine reads the ~6 MB fixture on a blocking
// thread, so a client that subscribes before the load has finished gets an empty snapshot and
// live updates start once the replay runs. The waits below allow for that.
//
// Checks, for one client subscribed to BTC-USD 1m:
//   - the first BTC-USD 1m Candle it receives is the snapshot (`snapshot: true`);
//   - live `snapshot: false` Candles follow, each with one 1m-aligned bar and valid OHLC;
//   - BTC-USD Trades arrive on the market topic;
//   - no ETH-USD Trade arrives, although the engine emitted some (seen by the supervisor);
//   - the server's MarketState was fed: last trade and cached candles for BTC-USD.
// Cleanup stops the server and checks that every engine process has exited.
//
// The engine must be built first: `cargo build --manifest-path rust/Cargo.toml -p engine`.
// Without the binary the test is skipped. Every wait resolves on the awaited event and times out
// after at most 10 s; the whole test is capped at 30 s.

import { afterAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { loadConfig } from "../config.ts";
import { type EngineProcess, EngineSupervisor, spawnEngineProcess } from "../engine/supervisor.ts";
import { memoryLogger } from "../gateway/testing.ts";
import { REPO_ROOT, type RunningServer, resolveFromRoot, startServer } from "../main.ts";
import type { Bar, Event, ServerMessage } from "../protocol.ts";

const ENGINE_PATH = resolve(REPO_ROOT, "rust", "target", "debug", process.platform === "win32" ? "engine.exe" : "engine");
const HAVE_ENGINE = await Bun.file(ENGINE_PATH).exists();

const WAIT_MS = 10_000;
const TEST_TIMEOUT_MS = 30_000;
/** Live candle updates and BTC trades to wait for. */
const WANT_LIVE = 5;
const WANT_TRADES = 5;
/** ETH trades the engine must have emitted before the "not delivered" check means anything. */
const WANT_ENGINE_ETH_TRADES = 3;

const logs = memoryLogger();

function logTail(): string {
  const tail = logs.lines.slice(-15);
  return tail.length === 0 ? "(no server log lines)" : tail.join("\n");
}

function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms waiting for ${label}\n${logTail()}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Items in arrival order with their arrival time; `until(cond)` resolves once `cond()` holds. */
class Recorder<T> {
  readonly items: { at: number; value: T }[] = [];
  readonly #checks = new Set<() => void>();

  push(value: T): void {
    this.items.push({ at: performance.now(), value });
    for (const check of [...this.#checks]) check();
  }

  until(cond: () => boolean, label: string, ms = WAIT_MS): Promise<void> {
    if (cond()) return Promise.resolve();
    let check = (): void => {};
    const met = new Promise<void>((resolveMet) => {
      check = () => {
        if (cond()) resolveMet();
      };
      this.#checks.add(check);
    });
    return within(met, ms, label).finally(() => this.#checks.delete(check));
  }
}

type CandleEvent = Extract<Event, { type: "candle" }>;
type TradeEvent = Extract<Event, { type: "trade" }>;

const eventOf = (m: ServerMessage): Event | null => (m.type === "event" ? m.event : null);

function btcCandle(m: ServerMessage): CandleEvent | null {
  const e = eventOf(m);
  return e?.type === "candle" && e.symbol === "BTC-USD" && e.timeframe === "1m" ? e : null;
}

function tradeOf(m: ServerMessage, symbol: string): TradeEvent | null {
  const e = eventOf(m);
  return e?.type === "trade" && e.symbol === symbol ? e : null;
}

/** low ≤ open, close ≤ high, volume ≥ 0, and `t` on a UTC minute (Req 8.2, 8.4). */
function expectValidBar(bar: Bar): void {
  const open = BigInt(bar.open);
  const high = BigInt(bar.high);
  const low = BigInt(bar.low);
  const close = BigInt(bar.close);
  const volume = BigInt(bar.volume);
  expect(low <= open && open <= high).toBe(true);
  expect(low <= close && close <= high).toBe(true);
  expect(low > 0n).toBe(true);
  expect(volume >= 0n).toBe(true);
  expect(bar.t % 60_000).toBe(0);
}

const ms = (from: number, to: number): number => Math.round(to - from);

if (!HAVE_ENGINE) {
  test.skip(`replay demo: no engine binary at ${ENGINE_PATH}; run \`cargo build --manifest-path rust/Cargo.toml -p engine\` first`, () => {});
} else {
  describe("replay demo (real engine binary)", () => {
    const procs: EngineProcess[] = [];
    let supervisor: EngineSupervisor | undefined;
    let running: RunningServer | undefined;
    let client: WebSocket | undefined;

    afterAll(async () => {
      client?.close();
      await within(running?.stop() ?? Promise.resolve(), 4_000, "the server and engine to stop");
      const exits = await within(Promise.all(procs.map((p) => p.exited)), 4_000, "every engine process to exit");
      expect(exits).toHaveLength(procs.length);
      expect(supervisor?.running ?? false).toBe(false);
    });

    test(
      "WS subscribe to BTC-USD 1m streams a snapshot, live candles, and BTC trades only",
      async () => {
        const result = loadConfig({
          DATA_MODE: "replay",
          REPLAY_FIXTURE: "demo.jsonl",
          REPLAY_SPEED: "50",
          ENGINE_PATH,
          ALLOWED_ORIGINS: "http://localhost:3000",
          NODE_ENV: "test",
        });
        if (!result.ok) throw result.error;
        const { config } = result;
        expect(config.replaySpeed).toBe(50);

        // Same fixtures directory as startServer's default supervisor: <repo>/fixtures.
        const fixturesDir = resolveFromRoot("fixtures");
        expect(await Bun.file(resolve(fixturesDir, "demo.jsonl")).exists()).toBe(true);

        const sup = new EngineSupervisor({
          config,
          fixturesDir,
          spawn: (request) => {
            const proc = spawnEngineProcess(request);
            procs.push(proc);
            return proc;
          },
          logger: logs,
        });
        supervisor = sup;

        // Every engine event, as the supervisor sees it (before the gateway filters by topic).
        const engineEvents = new Recorder<Event>();
        sup.onEvent((e) => engineEvents.push(e));

        const t0 = performance.now();
        running = startServer({ config, port: 0, hostname: "127.0.0.1", supervisor: sup, logger: logs });
        const base = `127.0.0.1:${running.port}`;
        expect(procs).toHaveLength(1);

        const inbox = new Recorder<ServerMessage>();
        const ws = new WebSocket(`ws://${base}/ws`);
        client = ws;
        ws.addEventListener("message", (e) => inbox.push(JSON.parse(String(e.data)) as ServerMessage));
        const opened = new Promise<void>((resolveOpen, reject) => {
          ws.addEventListener("open", () => resolveOpen(), { once: true });
          ws.addEventListener("error", () => reject(new Error("websocket error")), { once: true });
        });
        await within(opened, WAIT_MS, "the WebSocket to open");
        await inbox.until(() => inbox.items.length >= 2, "hello and session");
        const hello = inbox.items[0]?.value;
        expect(hello?.type === "hello" && hello.data_mode).toBe("replay");
        expect(hello?.type === "hello" && hello.venue).toBeNull();
        expect(inbox.items[1]?.value).toEqual({ type: "session", account_id: "guest", address: null });

        const subscribedAt = inbox.items.length;
        const tSubscribe = performance.now();
        ws.send(JSON.stringify({ type: "subscribe", symbol: "BTC-USD", timeframe: "1m" }));

        const afterSubscribe = () => inbox.items.slice(subscribedAt);
        const candles = () =>
          afterSubscribe().flatMap(({ at, value }) => {
            const c = btcCandle(value);
            return c === null ? [] : [{ at, candle: c }];
          });
        const live = () => candles().filter((c) => !c.candle.snapshot);
        const btcTrades = () => afterSubscribe().filter(({ value }) => tradeOf(value, "BTC-USD") !== null);

        // 1. The snapshot comes first (Req 8.7).
        await inbox.until(() => candles().length > 0, "the BTC-USD 1m snapshot");
        const first = candles()[0];
        if (first === undefined) throw new Error("no candle recorded");
        expect(first.candle.snapshot).toBe(true);
        expect(first.candle.bars.length).toBeLessThanOrEqual(500);
        for (const bar of first.candle.bars) expectValidBar(bar);
        const tSnapshot = first.at;

        // 2. Live updates follow once the replay runs (Req 8.8), each one bar with valid OHLC.
        await inbox.until(() => live().length >= WANT_LIVE, `${WANT_LIVE} live BTC-USD 1m candles`);
        const tFirstLive = live()[0]?.at ?? Number.NaN;
        for (const { candle } of live()) {
          expect(candle.bars).toHaveLength(1);
          for (const bar of candle.bars) expectValidBar(bar);
        }
        // Only one snapshot: everything after the first candle is live.
        expect(candles().filter((c) => c.candle.snapshot)).toHaveLength(1);

        // 3. BTC-USD trades on the market topic (Req 9.8, 17.6).
        await inbox.until(() => btcTrades().length >= WANT_TRADES, `${WANT_TRADES} BTC-USD trades`);

        // 4. The engine emitted ETH-USD trades, but none reached this client. A ping round trip
        //    after the engine events were seen flushes anything published before it.
        const engineEth = () => engineEvents.items.filter(({ value }) => value.type === "trade" && value.symbol === "ETH-USD");
        await engineEvents.until(
          () => engineEth().length >= WANT_ENGINE_ETH_TRADES,
          `${WANT_ENGINE_ETH_TRADES} ETH-USD trades from the engine`,
        );
        ws.send(JSON.stringify({ type: "ping", id: 46 }));
        await inbox.until(
          () => afterSubscribe().some(({ value }) => value.type === "pong" && value.id === 46),
          "pong 46",
        );
        const ethDelivered = inbox.items.filter(({ value }) => tradeOf(value, "ETH-USD") !== null);
        expect(ethDelivered).toHaveLength(0);
        // Nothing else for other symbols either.
        const foreign = inbox.items.filter(({ value }) => {
          const e = eventOf(value);
          return e !== null && "symbol" in e && e.symbol !== "BTC-USD";
        });
        expect(foreign).toHaveLength(0);

        // 5. The server's MarketState was fed from the same events.
        const market = running.market;
        expect(market.quote("BTC-USD")?.last).not.toBeNull();
        expect(market.quote("ETH-USD")?.last).not.toBeNull(); // trades are cached for every symbol
        const cached = market.candles("BTC-USD", "1m");
        expect(cached).not.toBeNull();
        expect(cached?.length ?? 0).toBeGreaterThan(0);
        const lastLive = live().at(-1)?.candle.bars[0];
        // The cache holds at least the bar of the newest live update this client saw.
        expect(cached?.some((b) => b.t === lastLive?.t)).toBe(true);

        const tDone = performance.now();
        const engineBtc = engineEvents.items.filter(({ value }) => value.type === "trade" && value.symbol === "BTC-USD");
        console.log(
          `[replay.integration] snapshot ${ms(tSubscribe, tSnapshot)} ms after subscribe ` +
            `(${first.candle.bars.length} bars, ${ms(t0, tSnapshot)} ms after start); ` +
            `first live candle ${ms(tSubscribe, tFirstLive)} ms after subscribe; ` +
            `client got ${live().length} live candles and ${btcTrades().length} BTC-USD trades; ` +
            `engine emitted ${engineBtc.length} BTC-USD and ${engineEth().length} ETH-USD trades; ` +
            `ETH-USD trades delivered to the client: ${ethDelivered.length}; total ${ms(t0, tDone)} ms`,
        );
      },
      TEST_TIMEOUT_MS,
    );
  });
}
