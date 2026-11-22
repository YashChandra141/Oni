// Latency_Histogram (oni-terminal-v2 design "Latency_Histogram and /health", Req 33).
//
// A rolling window of the last WINDOW samples over fixed log-linear buckets (8 sub-buckets per
// power of two, microsecond units). `record` is O(1): it adds the new sample's bucket and
// removes the evicted sample's bucket. Quantile queries scan the fixed bucket array (232
// entries), never the samples, and return the bucket midpoint (relative error under 7 percent).
// Memory is fixed: one Uint32Array of buckets and one Int32Array ring per histogram.

import type { HealthLatency, LatencySummary } from "../protocol.ts";

/** Samples kept per stage. */
export const WINDOW = 2048;

const SUB_BITS = 3;
const SUB = 1 << SUB_BITS; // 8
const MAX_US = 0x7fff_ffff;
// Values below SUB map to their own bucket; above, (octave - SUB_BITS + 1) * SUB + sub.
const BUCKETS = (31 - SUB_BITS + 1) * SUB; // octaves 3..30 plus the linear head

function bucketOf(us: number): number {
  if (us < SUB) return us;
  const octave = 31 - Math.clz32(us);
  const sub = (us >>> (octave - SUB_BITS)) & (SUB - 1);
  return (octave - SUB_BITS + 1) * SUB + sub;
}

/** Midpoint, in microseconds, of a bucket. */
function bucketValue(index: number): number {
  if (index < SUB) return index;
  const octave = Math.floor(index / SUB) + SUB_BITS - 1;
  const sub = index % SUB;
  const width = 2 ** (octave - SUB_BITS);
  return Math.round((SUB + sub) * width + width / 2);
}

export class Histogram {
  readonly #buckets = new Uint32Array(BUCKETS);
  readonly #ring = new Int32Array(WINDOW);
  #next = 0;
  #count = 0;

  /** Number of samples currently in the window. */
  get count(): number {
    return this.#count;
  }

  /** Records one sample in microseconds. Negative, NaN, and infinite values are ignored. */
  record(us: number): void {
    if (!Number.isFinite(us) || us < 0) return;
    const clamped = Math.min(Math.floor(us), MAX_US);
    const slot = this.#next;
    if (this.#count === WINDOW) {
      const old = bucketOf(this.#ring[slot] ?? 0);
      this.#buckets[old] = (this.#buckets[old] ?? 0) - 1;
    } else {
      this.#count += 1;
    }
    this.#ring[slot] = clamped;
    const b = bucketOf(clamped);
    this.#buckets[b] = (this.#buckets[b] ?? 0) + 1;
    this.#next = slot + 1 === WINDOW ? 0 : slot + 1;
  }

  /** The q-quantile (0 to 1) in microseconds, or null when empty. */
  quantile(q: number): number | null {
    if (this.#count === 0) return null;
    const rank = Math.min(this.#count, Math.max(1, Math.ceil(q * this.#count)));
    let seen = 0;
    for (let i = 0; i < BUCKETS; i++) {
      seen += this.#buckets[i] ?? 0;
      if (seen >= rank) return bucketValue(i);
    }
    return null;
  }

  p50(): number | null {
    return this.quantile(0.5);
  }

  p95(): number | null {
    return this.quantile(0.95);
  }

  p99(): number | null {
    return this.quantile(0.99);
  }

  summary(): LatencySummary {
    return { count: this.#count, p50_us: this.p50(), p95_us: this.p95() };
  }

  reset(): void {
    this.#buckets.fill(0);
    this.#ring.fill(0);
    this.#next = 0;
    this.#count = 0;
  }
}

/** One histogram per measured stage (design: protocol `HealthLatency`). */
export const latency = {
  /** Engine `emit_us` to server receipt of the line (Req 33.1). */
  emit_to_write: new Histogram(),
  /** Command text received to Preview sent (Req 33.3). */
  command_to_preview: new Histogram(),
  /** Confirm received to OrderAck sent (Req 33.4). */
  confirm_to_ack: new Histogram(),
  /** Server receipt of an event line to the client send (Req 33.5). */
  receipt_to_client: new Histogram(),
} as const satisfies Record<keyof HealthLatency, Histogram>;

/** Server wall clock in microseconds, comparable with the engine's `SystemTime` on one host. */
export function nowUs(): number {
  return (performance.timeOrigin + performance.now()) * 1000;
}

/** Summary of every stage for `/health` and Hello. */
export function latencySummary(): HealthLatency {
  return {
    emit_to_write: latency.emit_to_write.summary(),
    command_to_preview: latency.command_to_preview.summary(),
    confirm_to_ack: latency.confirm_to_ack.summary(),
    receipt_to_client: latency.receipt_to_client.summary(),
  };
}
