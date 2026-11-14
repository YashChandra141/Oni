// Journal_Queue and Journal_Writer (design Decision J4, Req 20.1-20.3, 20.8-20.12, 20.17).
//
// `enqueue` is synchronous, O(1) amortized, never throws, and never awaits the database, so an
// order never waits on Neon. One background loop drains the queue in batches of at most 500:
//   - until `setMigrated(true)` the loop takes nothing and the status is `down` (Req 20.17);
//   - an unreachable error keeps the batch, sets `down`, and waits `backoff.next()` (Req 20.10);
//   - a poison error (deterministic data error) retries the batch one record at a time and drops
//     each record that still fails, with one redacted log line;
//   - while `down` with an empty queue the loop only calls `store.ping()`, so a healthy database
//     is never probed (it would keep Neon's compute awake).
// The batch in flight is held apart from the waiting records, so memory stays bounded.

import { Backoff } from "../engine/backoff.ts";
import type { JournalRecord, JournalStore } from "./store.ts";

export const JOURNAL_QUEUE_MAX = 10_000;
export const JOURNAL_BATCH_MAX = 500;
/** At most one "dropped N records" log line per this many ms (Req 20.11). */
export const DROP_LOG_INTERVAL_MS = 10_000;

export type JournalStatus = "up" | "down";
export type ErrorClass = "poison" | "unreachable";

export interface QueueLogger {
  info(line: string): void;
  warn(line: string): void;
  error(line: string): void;
}

export interface JournalQueueOptions {
  readonly store: JournalStore;
  /** Pure classifier (see classify.ts). Anything it does not call poison counts as unreachable. */
  readonly classify: (err: unknown) => ErrorClass;
  readonly logger?: QueueLogger;
  /** Scrubs secrets from text before it is logged. Defaults to identity. */
  readonly redact?: (text: string) => string;
  readonly maxQueue?: number;
  readonly batchMax?: number;
  readonly backoff?: Backoff;
  /** Wall clock in epoch ms, for the drop log interval. */
  readonly now?: () => number;
  /** Resolves after `ms`. Tests inject an instant version. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** When true (default false) the writer starts already migrated, for stores with no schema step. */
  readonly migrated?: boolean;
}

export interface JournalQueueStats {
  readonly queued: number;
  readonly dropped: number;
  readonly poisoned: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const handle = setTimeout(resolve, ms);
    (handle as { unref?: () => void }).unref?.();
  });

function errorLabel(err: unknown): string {
  if (typeof err !== "object" || err === null) return "unknown";
  const name = (err as { name?: unknown }).name;
  const code = (err as { code?: unknown }).code;
  const parts = [typeof name === "string" ? name : "Error"];
  if (typeof code === "string" || typeof code === "number") parts.push(String(code));
  return parts.join(" ");
}

export class JournalQueue {
  readonly #store: JournalStore;
  readonly #classify: (err: unknown) => ErrorClass;
  readonly #log: QueueLogger;
  readonly #redact: (text: string) => string;
  readonly #max: number;
  readonly #batchMax: number;
  readonly #backoff: Backoff;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;

  #items: JournalRecord[] = [];
  #head = 0;
  #inflight: JournalRecord[] = [];
  #status: JournalStatus = "down";
  #migrated = false;
  #stopped = false;
  #running = false;
  #wake: (() => void) | null = null;
  #idleWaiters: (() => void)[] = [];

  #dropped = 0;
  #droppedUnlogged = 0;
  #lastDropLog = Number.NEGATIVE_INFINITY;
  #poisoned = 0;

  constructor(options: JournalQueueOptions) {
    this.#store = options.store;
    this.#classify = options.classify;
    this.#log = options.logger ?? console;
    this.#redact = options.redact ?? ((text) => text);
    this.#max = options.maxQueue ?? JOURNAL_QUEUE_MAX;
    this.#batchMax = options.batchMax ?? JOURNAL_BATCH_MAX;
    this.#backoff = options.backoff ?? new Backoff();
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
    if (options.migrated === true) this.setMigrated(true);
  }

  /** Journal_Status (Req 17.8): read from memory, never queries the database. */
  status(): JournalStatus {
    return this.#status;
  }

  stats(): JournalQueueStats {
    return { queued: this.#size() + this.#inflight.length, dropped: this.#dropped, poisoned: this.#poisoned };
  }

  /** Called by the Start_Script: true once migrations succeeded, false when a deploy failed. */
  setMigrated(ok: boolean): void {
    this.#migrated = ok;
    this.#status = ok ? "up" : "down";
    if (ok) this.#backoff.reset();
    this.#ensureRunning();
    this.#poke();
  }

  /** A read query failed to reach the database (Req 20.14): status `down`, and the writer probes. */
  markUnreachable(): void {
    if (!this.#migrated) return;
    this.#status = "down";
    this.#ensureRunning();
    this.#poke();
  }

  /** Never throws and never awaits. Drops the oldest waiting record when the queue is full. */
  enqueue(record: JournalRecord): void {
    try {
      if (this.#size() >= this.#max) {
        this.#head += 1;
        this.#dropped += 1;
        this.#droppedUnlogged += 1;
        this.#logDrops();
        this.#compact();
      }
      this.#items.push(record);
      this.#ensureRunning();
      this.#poke();
    } catch {
      // Unreachable in practice; the order path must never see a journal error (Req 20.8).
    }
  }

  /**
   * Waits until every record is written or `deadlineMs` passes, then stops the writer.
   * Logs the number of records left behind.
   */
  async flush(deadlineMs: number): Promise<void> {
    if (this.#size() + this.#inflight.length > 0 && this.#migrated) {
      this.#ensureRunning();
      this.#poke();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, deadlineMs);
        (timer as { unref?: () => void }).unref?.();
      });
      const drained = new Promise<void>((resolve) => {
        this.#idleWaiters.push(resolve);
      });
      await Promise.race([drained, timeout]);
      if (timer !== undefined) clearTimeout(timer);
    }
    this.#stopped = true;
    this.#poke();
    const left = this.#size() + this.#inflight.length;
    if (left > 0) this.#log.warn(`[journal] ${left} records were not written before shutdown`);
  }

  // -------------------------------------------------------------------------------------------

  #size(): number {
    return this.#items.length - this.#head;
  }

  #logDrops(): void {
    const t = this.#now();
    if (t - this.#lastDropLog >= DROP_LOG_INTERVAL_MS) {
      this.#log.warn(`[journal] queue full: dropped ${this.#droppedUnlogged} oldest records`);
      this.#droppedUnlogged = 0;
      this.#lastDropLog = t;
    }
  }

  #take(): JournalRecord[] {
    const end = Math.min(this.#items.length, this.#head + this.#batchMax);
    const batch = this.#items.slice(this.#head, end);
    this.#head = end;
    this.#compact();
    return batch;
  }

  /** Releases the consumed prefix once it is large, so memory stays bounded. */
  #compact(): void {
    if (this.#head >= 1024 && this.#head * 2 >= this.#items.length) {
      this.#items = this.#items.slice(this.#head);
      this.#head = 0;
    }
  }

  #poke(): void {
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }

  #waitWake(): Promise<void> {
    return new Promise((resolve) => {
      this.#wake = resolve;
    });
  }

  #ensureRunning(): void {
    if (this.#running || this.#stopped || !this.#migrated) return;
    this.#running = true;
    void this.#run().finally(() => {
      this.#running = false;
    });
  }

  #markDown(err: unknown): void {
    this.#status = "down";
    this.#log.error(`[journal] write failed (${this.#redact(errorLabel(err))}); retrying with backoff`);
  }

  #markUp(): void {
    this.#status = "up";
    this.#backoff.reset();
  }

  async #run(): Promise<void> {
    while (!this.#stopped) {
      if (!this.#migrated) {
        await this.#waitWake();
        continue;
      }
      if (this.#inflight.length === 0 && this.#size() === 0) {
        this.#resolveIdle();
        if (this.#status === "down") {
          await this.#probe();
        } else {
          await this.#waitWake();
        }
        continue;
      }
      if (this.#inflight.length === 0) this.#inflight = this.#take();
      await this.#writeInflight();
    }
    this.#resolveIdle();
  }

  #resolveIdle(): void {
    const waiters = this.#idleWaiters;
    this.#idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  async #probe(): Promise<void> {
    try {
      await this.#store.ping();
      this.#markUp();
    } catch (err) {
      this.#markDown(err);
      await this.#sleep(this.#backoff.next());
    }
  }

  async #writeInflight(): Promise<void> {
    try {
      await this.#store.insertBatch(this.#inflight);
      this.#inflight = [];
      this.#markUp();
      return;
    } catch (err) {
      if (this.#classify(err) !== "poison") {
        this.#markDown(err);
        await this.#sleep(this.#backoff.next());
        return;
      }
    }
    await this.#writeOneByOne();
  }

  /** A deterministic data error: find and drop the bad records, keep the rest (design J4). */
  async #writeOneByOne(): Promise<void> {
    while (this.#inflight.length > 0) {
      const record = this.#inflight[0];
      if (record === undefined) break;
      try {
        await this.#store.insertBatch([record]);
        this.#inflight.shift();
        this.#markUp();
      } catch (err) {
        if (this.#classify(err) === "poison") {
          this.#inflight.shift();
          this.#poisoned += 1;
          this.#log.error(
            `[journal] dropped poison record ${record.record_id} (${this.#redact(errorLabel(err))})`,
          );
        } else {
          this.#markDown(err);
          await this.#sleep(this.#backoff.next());
          return;
        }
      }
    }
  }
}
