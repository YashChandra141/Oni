// Client-measured latency (Task 14.11, Req 29.x): a ping every 2 s, the median of the last 10
// round trips, halved. Pure tracker plus a tiny external store for React.

export const LATENCY_PING_MS = 2_000;
export const LATENCY_WINDOW = 10;
/** Target one-way latency in ms; green at or below, amber up to 2x, red above. */
export const LATENCY_TARGET_MS = 50;
/** Ping ids used here start high so they never collide with the socket's own keep-alive ids. */
export const LATENCY_ID_BASE = 1_000_000_000;

export type LatencyLevel = "good" | "warn" | "bad" | "unknown";

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const hi = sorted[mid];
  const lo = sorted[mid - 1];
  if (hi === undefined) return null;
  if (sorted.length % 2 === 1 || lo === undefined) return hi;
  return (lo + hi) / 2;
}

/** One-way latency in whole ms (median RTT / 2), or null when there is no sample. */
export function oneWayMs(rtts: readonly number[]): number | null {
  const m = median(rtts.slice(-LATENCY_WINDOW));
  return m === null ? null : Math.round(m / 2);
}

export function latencyLevel(ms: number | null): LatencyLevel {
  if (ms === null) return "unknown";
  if (ms <= LATENCY_TARGET_MS) return "good";
  if (ms <= LATENCY_TARGET_MS * 2) return "warn";
  return "bad";
}

export function formatLatency(ms: number | null): string {
  return ms === null ? "–" : `${ms} ms`;
}

// ---------------------------------------------------------------------------------------------
// Module singleton

let nextId = LATENCY_ID_BASE;
const sentAt = new Map<number, number>();
let rtts: readonly number[] = [];
let snapshot: number | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** Allocates a ping id and remembers when it was sent. */
export function beginPing(now: number = performance.now()): number {
  nextId += 1;
  sentAt.set(nextId, now);
  // Drop pings that never got an answer.
  if (sentAt.size > LATENCY_WINDOW * 2) {
    const oldest = sentAt.keys().next();
    if (!oldest.done) sentAt.delete(oldest.value);
  }
  return nextId;
}

/** Call with the id of every `pong` the client receives. Ids that are not ours are ignored. */
export function recordPong(id: number, now: number = performance.now()): void {
  const start = sentAt.get(id);
  if (start === undefined) return;
  sentAt.delete(id);
  rtts = [...rtts, Math.max(0, now - start)].slice(-LATENCY_WINDOW);
  const next = oneWayMs(rtts);
  if (next !== snapshot) {
    snapshot = next;
    emit();
  }
}

/** Forgets all samples (on disconnect). */
export function resetLatency(): void {
  sentAt.clear();
  rtts = [];
  if (snapshot !== null) {
    snapshot = null;
    emit();
  }
}

export function subscribeLatency(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getLatencySnapshot(): number | null {
  return snapshot;
}
