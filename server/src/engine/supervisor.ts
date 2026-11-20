// Engine_Supervisor (design §3, Req 15): spawns the engine sidecar, writes Commands to its
// stdin, reads Events from its stdout, forwards its stderr to the log, and restarts it with
// backoff after every exit.
//
// Everything with side effects is injected (spawn, timers, clock, logger, UUIDs), so the
// supervisor is unit-tested with a fake process (supervisor.test.ts). The real engine is
// exercised in the Task 3.6 integration test.
//
// Command split (Req 18.3, trading-safety rule 2):
// - `sendControl(cmd)` accepts only Subscribe, Unsubscribe, StartReplay, and Ping. It throws
//   on any other Command at runtime, so a cast cannot smuggle an order command through it.
// - `createOrderSender()` returns the only handle that can write PlaceOrder, Cancel,
//   CancelAll, and ResetAccount. It can be created once per supervisor. ONLY `router.ts` may
//   hold it: main.ts creates it and passes it straight to the Router. A test in Task 11.2
//   checks that no other module uses it.
// - The raw writer is private. The engine's stdin is never exposed, and the engine is spawned
//   with its own stdin pipe, so the only way to reach the engine is through this module
//   (Req 18.4).
//
// Lifecycle:
// - `start()` spawns the engine, marks the backoff as started, and generates a new Session_Id
//   (Req 20.18). It then sends StartReplay (replay mode) and resends every active
//   subscription from the subscription provider (Req 15.4), emits `account_reset` if this is
//   not the first start (Req 15.7), and emits `engine_up`.
// - On exit: mark the engine down, emit `engine_down`, call the clear-account hooks
//   (Req 15.7), and schedule a restart after `backoff.onExit()` (Req 15.2, 15.3).
// - Paper_Account state is NOT restored from the Journal after a restart (Req 15.8): a new
//   engine starts with a flat account, and nothing here replays journaled orders or fills.
// - `stop()` cancels a pending restart, kills the process, and resolves after it has exited.

import { redactSecrets, type Config, type SecretSource } from "../config.ts";
import { CommandSchema, parseEventLine, type Command, type Event, type Timeframe } from "../protocol.ts";
import { Backoff } from "./backoff.ts";
import { createEngineStdoutSplitter, LineSplitter, MAX_EVENT_LINE_BYTES } from "./lines.ts";

// ---------------------------------------------------------------------------------------------
// Command classes
// ---------------------------------------------------------------------------------------------

/**
 * Every Command variant, classed as control or order. `satisfies` makes this fail to compile
 * when a Command variant is added to the protocol without being classed here.
 */
const COMMAND_CLASS = {
  subscribe: "control",
  unsubscribe: "control",
  start_replay: "control",
  ping: "control",
  place_order: "order",
  cancel: "order",
  cancel_all: "order",
  reset_account: "order",
} as const satisfies Record<Command["type"], "control" | "order">;

type CommandClass = typeof COMMAND_CLASS;
type TypesOfClass<C extends "control" | "order"> = {
  [K in keyof CommandClass]: CommandClass[K] extends C ? K : never;
}[keyof CommandClass];

/** Commands any server module may send through `sendControl`. */
export type ControlCommand = Extract<Command, { type: TypesOfClass<"control"> }>;
/** Commands only the Router may send, through the order sender (Req 18.3). */
export type OrderCommand = Extract<Command, { type: TypesOfClass<"order"> }>;

function commandClass(cmd: unknown): "control" | "order" | null {
  if (typeof cmd !== "object" || cmd === null) return null;
  const type: unknown = (cmd as { type?: unknown }).type;
  if (typeof type !== "string" || !Object.hasOwn(COMMAND_CLASS, type)) return null;
  return COMMAND_CLASS[type as keyof CommandClass];
}

export function isControlCommand(cmd: unknown): cmd is ControlCommand {
  return commandClass(cmd) === "control";
}

export function isOrderCommand(cmd: unknown): cmd is OrderCommand {
  return commandClass(cmd) === "order";
}

/** One engine stdin line: the Command as single-line JSON plus `\n` (Req 2.1, 3.1). */
export function encodeCommand(cmd: Command): string {
  // JSON.stringify escapes control characters, so the output never contains a raw newline.
  return `${JSON.stringify(cmd)}\n`;
}

// ---------------------------------------------------------------------------------------------
// Injected dependencies
// ---------------------------------------------------------------------------------------------

/** Writable end of the engine's stdin. Bun's `FileSink` satisfies it. */
export interface EngineStdin {
  write(chunk: string): unknown;
  flush?(): unknown;
}

/** A running engine process. The default wraps a `Bun.spawn` Subprocess. */
export interface EngineProcess {
  readonly pid?: number;
  readonly stdin: EngineStdin;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  /** Resolves with the exit code when the process has exited. */
  readonly exited: Promise<number | null>;
  kill(): void;
}

export interface EngineSpawnRequest {
  readonly enginePath: string;
  readonly mode: "replay" | "live";
  readonly fixturesDir: string;
  /** Live venue, passed as `--venue`. The engine uses it only in live mode (Req 44.1). */
  readonly venue: "coinbase" | "backpack";
}

/** Starts an engine process. May throw (for example when ENGINE_PATH does not exist). */
export type SpawnEngine = (request: EngineSpawnRequest) => EngineProcess;

export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface Logger {
  info(line: string): void;
  warn(line: string): void;
  error(line: string): void;
}

export interface EngineSubscription {
  readonly symbol: string;
  readonly timeframe: Timeframe;
}

/** Returns every active subscription. The gateway supplies it (Task 3.5). */
export type SubscriptionProvider = () => Iterable<EngineSubscription>;

export type SupervisorConfig = Pick<Config, "enginePath" | "dataMode" | "liveVenue" | "replayFixture" | "replaySpeed"> &
  SecretSource;

export interface EngineSupervisorOptions {
  /** A `Config` works here. The secrets are used only to redact engine output. */
  readonly config: SupervisorConfig;
  /** Directory of replay fixtures passed as `--fixtures`. Defaults to `fixtures`. */
  readonly fixturesDir?: string;
  /** Defaults to `spawnEngineProcess` (Bun.spawn). */
  readonly spawn?: SpawnEngine;
  /** Defaults to the global setTimeout and clearTimeout. */
  readonly timers?: Timers;
  /** Monotonic clock in ms for the default Backoff. Defaults to `performance.now`. */
  readonly now?: () => number;
  /** Defaults to `new Backoff({ now })`. */
  readonly backoff?: Backoff;
  /** Defaults to console. */
  readonly logger?: Logger;
  /** Session_Id generator. Defaults to `crypto.randomUUID`. */
  readonly randomUUID?: () => string;
  /** Active subscriptions to resend on every start. Can also be set later. */
  readonly subscriptions?: SubscriptionProvider;
}

// ---------------------------------------------------------------------------------------------
// Default spawn
// ---------------------------------------------------------------------------------------------

/** The engine command line from design §3: `engine run --mode <mode> --fixtures <dir> --venue <venue>`. */
export function engineArgv(request: EngineSpawnRequest): string[] {
  return [
    request.enginePath,
    "run",
    "--mode",
    request.mode,
    "--fixtures",
    request.fixturesDir,
    "--venue",
    request.venue,
  ];
}

/** Variables the engine never needs. They are removed from its environment (least privilege). */
export const ENGINE_ENV_DENYLIST = ["OPENAI_API_KEY", "DATABASE_URL", "DIRECT_URL", "TEST_DATABASE_URL"] as const;

/** The server environment without secrets, for the engine child process (trading-safety rule 6). */
export function engineEnv(source: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  const denied = new Set<string>(ENGINE_ENV_DENYLIST);
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && !denied.has(key.toUpperCase())) env[key] = value;
  }
  return env;
}

export const spawnEngineProcess: SpawnEngine = (request) => {
  const proc = Bun.spawn(engineArgv(request), {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: engineEnv(),
  });
  return {
    pid: proc.pid,
    stdin: proc.stdin,
    stdout: proc.stdout,
    stderr: proc.stderr,
    exited: proc.exited,
    kill: () => proc.kill(),
  };
};

const realTimers: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const consoleLogger: Logger = {
  info: (line) => console.log(line),
  warn: (line) => console.warn(line),
  error: (line) => console.error(line),
};

// ---------------------------------------------------------------------------------------------
// Supervisor
// ---------------------------------------------------------------------------------------------

/** Lifecycle notices, forwarded by the gateway as `ServerMessage::Notice`. */
export interface EngineNotice {
  readonly kind: "engine_up" | "engine_down" | "account_reset";
  readonly message: string;
}

/** For `/health` (Req 17.5) and the Router's `engine_unavailable` check (Req 15.5). */
export interface EngineStatus {
  readonly running: boolean;
  /** Session_Id of the latest engine start; kept after an exit until the next start. */
  readonly sessionId: string | null;
}

/** The order capability held only by `router.ts` (Req 18.3). */
export interface OrderSender {
  /** Writes an order Command. Returns false while the engine is down. Never throws for that. */
  send(cmd: OrderCommand): boolean;
}

/** Longest part of a rejected stdout line that is written to the log. */
export const MAX_LOGGED_LINE_CHARS = 200;

type State = "idle" | "running" | "waiting" | "stopping" | "stopped";
type Listener<T> = (value: T) => void;

export class EngineSupervisor {
  readonly #config: SupervisorConfig;
  readonly #fixturesDir: string;
  readonly #spawn: SpawnEngine;
  readonly #timers: Timers;
  readonly #backoff: Backoff;
  readonly #log: Logger;
  readonly #randomUUID: () => string;
  #subscriptions: SubscriptionProvider;

  #state: State = "idle";
  #proc: EngineProcess | null = null;
  /** Successful spawns so far. Output from an older generation is dropped. */
  #generation = 0;
  #sessionId: string | null = null;
  #restartTimer: { handle: unknown } | null = null;
  #stopWaiters: (() => void)[] = [];
  #orderSenderCreated = false;

  readonly #eventListeners = new Set<Listener<Event>>();
  readonly #noticeListeners = new Set<Listener<EngineNotice>>();
  readonly #statusListeners = new Set<Listener<EngineStatus>>();
  readonly #clearAccountListeners = new Set<Listener<void>>();

  constructor(options: EngineSupervisorOptions) {
    this.#config = options.config;
    this.#fixturesDir = options.fixturesDir ?? "fixtures";
    this.#spawn = options.spawn ?? spawnEngineProcess;
    this.#timers = options.timers ?? realTimers;
    this.#backoff = options.backoff ?? new Backoff(options.now === undefined ? {} : { now: options.now });
    this.#log = options.logger ?? consoleLogger;
    this.#randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
    this.#subscriptions = options.subscriptions ?? (() => []);
  }

  /** Whether an engine process is running. */
  get running(): boolean {
    return this.#proc !== null;
  }

  /** Session_Id of the latest engine start (Req 20.18), or null before the first start. */
  get sessionId(): string | null {
    return this.#sessionId;
  }

  get status(): EngineStatus {
    return { running: this.running, sessionId: this.#sessionId };
  }

  /** Sets the source of active subscriptions resent on every start (Req 15.4). */
  setSubscriptionProvider(provider: SubscriptionProvider): void {
    this.#subscriptions = provider;
  }

  onEvent(listener: Listener<Event>): () => void {
    return subscribe(this.#eventListeners, listener);
  }

  onNotice(listener: Listener<EngineNotice>): () => void {
    return subscribe(this.#noticeListeners, listener);
  }

  onStatus(listener: Listener<EngineStatus>): () => void {
    return subscribe(this.#statusListeners, listener);
  }

  /** Called on every engine exit: cached Positions and open orders are void (Req 15.7). */
  onClearAccount(listener: () => void): () => void {
    return subscribe(this.#clearAccountListeners, listener);
  }

  /** Spawns the engine (Req 15.1). Does nothing if it is already running or restarting. */
  start(): void {
    if (this.#state !== "idle" && this.#state !== "stopped") return;
    this.#spawnNow();
  }

  /** Cancels a pending restart, kills the engine, and resolves once it has exited. */
  stop(): Promise<void> {
    switch (this.#state) {
      case "idle":
      case "stopped":
        this.#state = "stopped";
        return Promise.resolve();
      case "waiting":
        this.#cancelRestart();
        this.#state = "stopped";
        this.#log.info("[supervisor] stopped; pending engine restart canceled");
        return Promise.resolve();
      case "stopping":
        return this.#waitForStop();
      case "running": {
        this.#state = "stopping";
        const stopped = this.#waitForStop();
        try {
          this.#proc?.kill();
        } catch (err) {
          this.#log.error(`[supervisor] failed to kill the engine: ${this.#redact(errorText(err))}`);
        }
        return stopped;
      }
    }
  }

  /**
   * Writes a control Command (Subscribe, Unsubscribe, StartReplay, Ping). Returns false while
   * the engine is down. Throws TypeError for any other Command: order Commands go only
   * through the Router's order sender (Req 18.3).
   */
  sendControl(cmd: ControlCommand): boolean {
    if (!isControlCommand(cmd)) {
      throw new TypeError(
        "sendControl accepts only subscribe, unsubscribe, start_replay, and ping; order commands go through the Router (Req 18.3)",
      );
    }
    return this.#write(cmd);
  }

  /**
   * Creates the order capability. Call once, in main.ts, and hand the result to the Router.
   * ONLY router.ts may use it (Req 18.3, trading-safety rule 2). A second call throws.
   */
  createOrderSender(): OrderSender {
    if (this.#orderSenderCreated) {
      throw new Error("the order sender already exists; only router.ts may hold it (Req 18.3)");
    }
    this.#orderSenderCreated = true;
    return Object.freeze({
      send: (cmd: OrderCommand): boolean => {
        if (!isOrderCommand(cmd)) throw new TypeError("the order sender accepts only order commands");
        return this.#write(cmd);
      },
    });
  }

  // -------------------------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------------------------

  #spawnNow(): void {
    this.#restartTimer = null;
    const request: EngineSpawnRequest = {
      enginePath: this.#config.enginePath,
      mode: this.#config.dataMode,
      fixturesDir: this.#fixturesDir,
      venue: this.#config.liveVenue,
    };
    let proc: EngineProcess;
    try {
      proc = this.#spawn(request);
    } catch (err) {
      this.#log.error(`[supervisor] failed to start the engine: ${this.#redact(errorText(err))}`);
      this.#scheduleRestart();
      return;
    }

    this.#generation += 1;
    const generation = this.#generation;
    this.#proc = proc;
    this.#state = "running";
    this.#sessionId = this.#randomUUID();
    this.#backoff.markStarted();

    void this.#pumpStdout(proc.stdout, generation);
    void this.#pumpStderr(proc.stderr);
    void proc.exited.then(
      (code) => this.#handleExit(proc, code),
      (err: unknown) => {
        this.#log.error(`[supervisor] waiting for the engine failed: ${this.#redact(errorText(err))}`);
        this.#handleExit(proc, null);
      },
    );

    const pid = proc.pid === undefined ? "" : ` pid ${proc.pid}`;
    this.#log.info(`[supervisor] engine started${pid}, session ${this.#sessionId}`);
    this.#emitStatus();

    // Replay first, then every active subscription (Req 15.4). The engine loads the fixture in
    // the background; a Subscribe that arrives before the load finishes gets an empty snapshot,
    // and live Candle events follow once the replay runs.
    if (this.#config.dataMode === "replay") {
      this.#write({ type: "start_replay", fixture: this.#config.replayFixture, speed: this.#config.replaySpeed });
    }
    for (const sub of this.#activeSubscriptions()) {
      this.#write({ type: "subscribe", symbol: sub.symbol, timeframe: sub.timeframe });
    }

    // Req 15.7: a new engine process means a fresh paper account. Clients are told only after
    // a restart, never on the first start. Req 15.8: nothing is restored from the Journal.
    if (generation > 1) {
      this.#emitNotice({ kind: "account_reset", message: "The engine restarted; the paper account was reset." });
    }
    this.#emitNotice({ kind: "engine_up", message: "The engine is running." });
  }

  #handleExit(proc: EngineProcess, code: number | null): void {
    if (proc !== this.#proc) return;
    this.#proc = null;
    this.#log.warn(`[supervisor] engine exited with code ${code === null ? "unknown" : code}`);
    this.#emitStatus();
    this.#emitNotice({ kind: "engine_down", message: "The engine stopped." });
    for (const listener of this.#clearAccountListeners) this.#call(listener, undefined);

    if (this.#state === "stopping") {
      this.#state = "stopped";
      const waiters = this.#stopWaiters;
      this.#stopWaiters = [];
      for (const resolve of waiters) resolve();
      return;
    }
    this.#scheduleRestart();
  }

  #scheduleRestart(): void {
    const delay = this.#backoff.onExit();
    this.#state = "waiting";
    this.#log.info(`[supervisor] restarting the engine in ${delay} ms`);
    const timer = {
      handle: this.#timers.setTimeout(() => {
        if (this.#restartTimer !== timer || this.#state !== "waiting") return;
        this.#spawnNow();
      }, delay),
    };
    this.#restartTimer = timer;
  }

  #cancelRestart(): void {
    if (this.#restartTimer !== null) {
      this.#timers.clearTimeout(this.#restartTimer.handle);
      this.#restartTimer = null;
    }
  }

  #waitForStop(): Promise<void> {
    return new Promise((resolve) => this.#stopWaiters.push(resolve));
  }

  #activeSubscriptions(): EngineSubscription[] {
    try {
      return [...this.#subscriptions()];
    } catch (err) {
      this.#log.error(`[supervisor] reading active subscriptions failed: ${this.#redact(errorText(err))}`);
      return [];
    }
  }

  // -------------------------------------------------------------------------------------------
  // stdin
  // -------------------------------------------------------------------------------------------

  /** Validates and writes one Command. Returns false, without throwing, while the engine is down. */
  #write(cmd: Command): boolean {
    const proc = this.#proc;
    if (proc === null || this.#state !== "running") return false;
    const parsed = CommandSchema.safeParse(cmd);
    if (!parsed.success) {
      this.#log.error(`[supervisor] refused to send an invalid ${String(cmd.type)} command`);
      return false;
    }
    try {
      this.#catchAsync(proc.stdin.write(encodeCommand(parsed.data)));
      this.#catchAsync(proc.stdin.flush?.());
    } catch (err) {
      this.#log.error(`[supervisor] writing to engine stdin failed: ${this.#redact(errorText(err))}`);
      return false;
    }
    return true;
  }

  #catchAsync(result: unknown): void {
    if (result instanceof Promise) {
      result.catch((err: unknown) => {
        this.#log.error(`[supervisor] writing to engine stdin failed: ${this.#redact(errorText(err))}`);
      });
    }
  }

  // -------------------------------------------------------------------------------------------
  // stdout and stderr
  // -------------------------------------------------------------------------------------------

  async #pumpStdout(stream: ReadableStream<Uint8Array>, generation: number): Promise<void> {
    // Engine stdout carries Events, which may be larger than a stdin Command (maxBytes:
    // MAX_EVENT_LINE_BYTES, applied by the factory).
    const splitter = createEngineStdoutSplitter((bytes) =>
      this.#log.warn(`[engine] dropped an oversized stdout line (${bytes} bytes, limit ${MAX_EVENT_LINE_BYTES})`),
    );
    const handle = (lines: string[]) => {
      for (const line of lines) this.#handleStdoutLine(line, generation);
    };
    try {
      await readChunks(stream, (chunk) => handle(splitter.push(chunk)));
    } catch (err) {
      this.#log.error(`[supervisor] reading engine stdout failed: ${this.#redact(errorText(err))}`);
    }
    handle(splitter.flush());
  }

  #handleStdoutLine(line: string, generation: number): void {
    // Late output from an engine that has already been replaced is dropped.
    if (generation !== this.#generation) return;
    const result = parseEventLine(line);
    if (!result.ok) {
      const shown = JSON.stringify(truncate(this.#redact(line), MAX_LOGGED_LINE_CHARS));
      this.#log.warn(`[engine] dropped an invalid stdout line (${result.code}: ${result.message}): ${shown}`);
      return;
    }
    for (const listener of this.#eventListeners) this.#call(listener, result.value);
  }

  async #pumpStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    const splitter = new LineSplitter({
      onOversized: (bytes) => this.#log.warn(`[engine] dropped an oversized stderr line (${bytes} bytes)`),
    });
    // Req 15.6: engine logs go to the server log, prefixed and redacted (Req 16.4).
    const forward = (lines: string[]) => {
      for (const line of lines) this.#log.info(`[engine] ${this.#redact(line)}`);
    };
    try {
      await readChunks(stream, (chunk) => forward(splitter.push(chunk)));
    } catch (err) {
      this.#log.error(`[supervisor] reading engine stderr failed: ${this.#redact(errorText(err))}`);
    }
    forward(splitter.flush());
  }

  // -------------------------------------------------------------------------------------------
  // Listeners and helpers
  // -------------------------------------------------------------------------------------------

  #emitStatus(): void {
    const status = this.status;
    for (const listener of this.#statusListeners) this.#call(listener, status);
  }

  #emitNotice(notice: EngineNotice): void {
    for (const listener of this.#noticeListeners) this.#call(listener, notice);
  }

  /** A throwing listener is logged and does not stop the others or the stream readers. */
  #call<T>(listener: Listener<T>, value: T): void {
    try {
      listener(value);
    } catch (err) {
      this.#log.error(`[supervisor] a listener threw: ${this.#redact(errorText(err))}`);
    }
  }

  #redact(text: string): string {
    return redactSecrets(text, this.#config);
  }
}

function subscribe<T>(set: Set<Listener<T>>, listener: Listener<T>): () => void {
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

async function readChunks(stream: ReadableStream<Uint8Array>, onChunk: (chunk: Uint8Array) => void): Promise<void> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      onChunk(value);
    }
  } finally {
    reader.releaseLock();
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… (${text.length} chars)`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
