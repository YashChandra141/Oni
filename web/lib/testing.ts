// Test doubles for socket.ts: a manual scheduler and a fake WebSocket. Used only by tests.

import type { WebSocketLike } from "./socket";

/** A tiny fake clock. Timers run only when a test calls `advance`. */
export class ManualScheduler {
  /** Milliseconds elapsed on the fake clock. */
  now = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { readonly at: number; readonly fn: () => void }>();

  readonly setTimer = (fn: () => void, ms: number): unknown => {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { at: this.now + ms, fn });
    return id;
  };

  readonly clearTimer = (handle: unknown): void => {
    if (typeof handle === "number") this.timers.delete(handle);
  };

  /** Number of timers that have not fired or been cleared. */
  get pending(): number {
    return this.timers.size;
  }

  /** Moves the clock forward `ms`, running every timer that comes due, in time order. */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      let nextId: number | null = null;
      let nextAt = Infinity;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && timer.at < nextAt) {
          nextId = id;
          nextAt = timer.at;
        }
      }
      if (nextId === null) break;
      const timer = this.timers.get(nextId);
      this.timers.delete(nextId);
      this.now = nextAt;
      timer?.fn();
    }
    this.now = target;
  }
}

export class FakeWebSocket implements WebSocketLike {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: { readonly code?: number; readonly reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  /** Text frames passed to `send`, in order. */
  readonly sent: string[] = [];
  closeCalls = 0;

  constructor(readonly url: string) {}

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("fake socket is not open");
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = 3;
  }

  /** The frames passed to `send`, parsed. */
  sentMessages(): unknown[] {
    return this.sent.map((text) => JSON.parse(text) as unknown);
  }

  // Test controls: what the network does to this socket.

  /** The handshake succeeds. */
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  /** The server sends a frame. Pass a string for a text frame. */
  receive(data: unknown): void {
    this.onmessage?.({ data });
  }

  /** The connection fails or drops. */
  fail(reason = "", code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

/** Creates `FakeWebSocket`s and remembers them. */
export class FakeNetwork {
  readonly sockets: FakeWebSocket[] = [];

  readonly create = (url: string): WebSocketLike => {
    const socket = new FakeWebSocket(url);
    this.sockets.push(socket);
    return socket;
  };

  /** The most recently created socket. */
  get last(): FakeWebSocket {
    const socket = this.sockets[this.sockets.length - 1];
    if (socket === undefined) throw new Error("no socket has been created");
    return socket;
  }
}
