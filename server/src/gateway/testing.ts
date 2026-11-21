// Test doubles for the gateway: a supervisor that records control commands and lets a test
// push engine events and notices, and a socket that records what it was sent. Used only by
// *.test.ts files.

import type {
  ControlCommand,
  EngineNotice,
  Logger,
  SubscriptionProvider,
} from "../engine/supervisor.ts";
import { isControlCommand } from "../engine/supervisor.ts";
import type { Event, ServerMessage } from "../protocol.ts";
import type { ClientData, GatewaySocket, GatewaySupervisor, Publisher } from "./ws.ts";

export class FakeSupervisor implements GatewaySupervisor {
  running = true;
  sessionId: string | null = "session-1";
  /** Every Command passed to sendControl, valid or not. */
  readonly sent: unknown[] = [];
  provider: SubscriptionProvider = () => [];
  started = 0;
  stopped = 0;
  readonly #events = new Set<(e: Event) => void>();
  readonly #notices = new Set<(n: EngineNotice) => void>();
  readonly #clears = new Set<() => void>();
  readonly #sessionStarts = new Set<(sessionId: string) => void>();

  sendControl(cmd: ControlCommand): boolean {
    this.sent.push(cmd);
    if (!isControlCommand(cmd)) throw new TypeError("not a control command");
    return this.running;
  }

  setSubscriptionProvider(provider: SubscriptionProvider): void {
    this.provider = provider;
  }

  onEvent(listener: (e: Event) => void): () => void {
    this.#events.add(listener);
    return () => this.#events.delete(listener);
  }

  onNotice(listener: (n: EngineNotice) => void): () => void {
    this.#notices.add(listener);
    return () => this.#notices.delete(listener);
  }

  onClearAccount(listener: () => void): () => void {
    this.#clears.add(listener);
    return () => this.#clears.delete(listener);
  }

  onSessionStart(listener: (sessionId: string) => void): () => void {
    this.#sessionStarts.add(listener);
    return () => this.#sessionStarts.delete(listener);
  }

  /** Like the real supervisor: each start is a new engine session. */
  start(): void {
    this.started += 1;
    if (this.sessionId !== null) this.emitSessionStart(this.sessionId);
  }

  /** Simulates an engine (re)start with a new Session_Id. */
  emitSessionStart(sessionId: string): void {
    this.sessionId = sessionId;
    for (const l of this.#sessionStarts) l(sessionId);
  }

  stop(): Promise<void> {
    this.stopped += 1;
    return Promise.resolve();
  }

  emitEvent(event: Event): void {
    for (const l of this.#events) l(event);
  }

  emitNotice(notice: EngineNotice): void {
    for (const l of this.#notices) l(notice);
  }

  emitClearAccount(): void {
    for (const l of this.#clears) l();
  }
}

export class FakeSocket implements GatewaySocket {
  readonly data: ClientData = {};
  readonly sent: string[] = [];
  readonly topics = new Set<string>();
  closed = false;

  send(data: string): number {
    this.sent.push(data);
    return data.length;
  }

  subscribe(topic: string): void {
    this.topics.add(topic);
  }

  unsubscribe(topic: string): void {
    this.topics.delete(topic);
  }

  messages(): ServerMessage[] {
    return this.sent.map((s) => JSON.parse(s) as ServerMessage);
  }

  last(): ServerMessage | undefined {
    return this.messages().at(-1);
  }
}

/** Delivers published messages to the FakeSockets subscribed to the topic, like Bun's server. */
export class FakePublisher implements Publisher {
  readonly published: { topic: string; message: ServerMessage }[] = [];
  readonly sockets = new Set<FakeSocket>();

  publish(topic: string, data: string): number {
    this.published.push({ topic, message: JSON.parse(data) as ServerMessage });
    for (const ws of this.sockets) if (ws.topics.has(topic)) ws.send(data);
    return data.length;
  }
}

/** A logger that keeps its lines in memory instead of printing them. */
export function memoryLogger(): Logger & { readonly lines: string[] } {
  const lines: string[] = [];
  const push = (line: string) => void lines.push(line);
  return { lines, info: push, warn: push, error: push };
}

/**
 * Lets pending async work (token verification with WebCrypto) finish without a wall-clock wait:
 * several microtask turns, then a few macrotask turns.
 */
export async function settle(turns = 5): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  for (let i = 0; i < turns; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** Polls (macrotask turns) until `done()` is true, up to `maxTurns` turns. Returns whether it held. */
export async function waitUntil(done: () => boolean, maxTurns = 200): Promise<boolean> {
  for (let i = 0; i < maxTurns; i++) {
    if (done()) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return done();
}
