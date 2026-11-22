// Per-connection event batcher and coalescer (Req 34.1 to 34.7). Pure: the timer and the
// sink are injected, so it needs no socket and no real clock.

/** Structural view of an engine event; extra fields are carried through untouched. */
export interface BatchEvent {
  readonly type: string;
  readonly venue?: string;
  readonly symbol?: string;
  readonly timeframe?: string;
  readonly snapshot?: boolean;
  readonly bars?: ReadonlyArray<{ readonly t: number }>;
  readonly [key: string]: unknown;
}

export interface BatcherTimer {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Runs `fn` after the current synchronous work (microtask). */
  defer(fn: () => void): void;
}

export interface BatchSink {
  /** `json` is a complete `event_batch` ServerMessage; `compress` is false for batches under 1 KB. */
  send(json: string, compress: boolean): void;
}

export const FLUSH_WINDOW_MS = 10;
export const MAX_BATCH_EVENTS = 200;
export const MAX_BATCH_BYTES = 256 * 1024;
export const COMPRESS_MIN_BYTES = 1024;

const URGENT_TYPES: ReadonlySet<string> = new Set([
  "order_ack",
  "order_rejected",
  "fill",
  "position",
  "balance",
  "notice",
]);

export const defaultTimer: BatcherTimer = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  defer: (fn) => queueMicrotask(fn),
};

export function isUrgent(e: BatchEvent): boolean {
  return URGENT_TYPES.has(e.type);
}

/** Coalescing key, or null when the event is never coalesced. */
export function coalesceKey(e: BatchEvent): string | null {
  const v = e.venue ?? "";
  const s = e.symbol ?? "";
  switch (e.type) {
    case "book":
      return `book:${v}:${s}`;
    case "indicators":
      return `ind:${v}:${s}:${e.timeframe ?? ""}`;
    case "ticker24h":
      return `tick:${v}:${s}`;
    case "candle": {
      if (e.snapshot === true) return null;
      const last = e.bars?.[e.bars.length - 1];
      if (last === undefined) return null;
      return `candle:${v}:${s}:${e.timeframe ?? ""}:${last.t}`;
    }
    default:
      return null;
  }
}

/** Newest event of a key replaces older ones and takes its own position. */
export function coalesce(events: ReadonlyArray<BatchEvent>): BatchEvent[] {
  const lastIndex = new Map<string, number>();
  events.forEach((e, i) => {
    const k = coalesceKey(e);
    if (k !== null) lastIndex.set(k, i);
  });
  return events.filter((e, i) => {
    const k = coalesceKey(e);
    return k === null || lastIndex.get(k) === i;
  });
}

const encoder = new TextEncoder();

interface Encoded {
  readonly json: string;
  readonly bytes: number;
}

/** Splits into batches of at most `maxEvents` events and `maxBytes` bytes, keeping order. */
export function splitBatches(
  events: ReadonlyArray<BatchEvent>,
  maxEvents: number = MAX_BATCH_EVENTS,
  maxBytes: number = MAX_BATCH_BYTES,
): Encoded[][] {
  const out: Encoded[][] = [];
  let cur: Encoded[] = [];
  let curBytes = 0;
  for (const e of events) {
    const json = JSON.stringify(e);
    const bytes = encoder.encode(json).length;
    if (cur.length > 0 && (cur.length >= maxEvents || curBytes + bytes + 1 > maxBytes)) {
      out.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push({ json, bytes });
    curBytes += bytes + 1;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

export class EventBatcher {
  private queue: BatchEvent[] = [];
  private handle: unknown = null;
  private urgentScheduled = false;
  private closed = false;

  constructor(
    private readonly sink: BatchSink,
    private readonly timer: BatcherTimer = defaultTimer,
  ) {}

  get pending(): number {
    return this.queue.length;
  }

  push(event: BatchEvent): void {
    if (this.closed) return;
    this.queue.push(event);
    if (isUrgent(event)) {
      // Everything queued before it goes out first, in order.
      if (!this.urgentScheduled) {
        this.urgentScheduled = true;
        this.timer.defer(() => {
          this.urgentScheduled = false;
          this.flush();
        });
      }
      return;
    }
    if (this.handle === null && !this.urgentScheduled) {
      this.handle = this.timer.setTimeout(() => {
        this.handle = null;
        this.flush();
      }, FLUSH_WINDOW_MS);
    }
  }

  flush(): void {
    if (this.handle !== null) {
      this.timer.clearTimeout(this.handle);
      this.handle = null;
    }
    if (this.queue.length === 0) return;
    const events = coalesce(this.queue);
    this.queue = [];
    for (const batch of splitBatches(events)) {
      const bytes = batch.reduce((n, e) => n + e.bytes + 1, 0);
      const json = `{"type":"event_batch","events":[${batch.map((e) => e.json).join(",")}]}`;
      this.sink.send(json, bytes >= COMPRESS_MIN_BYTES);
    }
  }

  /** Drops queued events without sending (disconnect). */
  close(): void {
    this.closed = true;
    if (this.handle !== null) this.timer.clearTimeout(this.handle);
    this.handle = null;
    this.queue = [];
  }
}
