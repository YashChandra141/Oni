// In-memory JournalStore (design Decision J6): one `seq` counter, `record_id` dedupe, and a
// fault-injection hook. Used by tests (P26, P27) and when DATABASE_URL is unset outside
// production (Req 16.6).

import {
  type FillRow,
  type JournalRecord,
  type JournalRow,
  type JournalStore,
  type ListQuery,
  type OrderRow,
  type RejectionRow,
  mergeJournal,
} from "./store.ts";

/** Thrown by an injected fault. The queue's classifier treats it as unreachable unless told otherwise. */
export class InjectedFault extends Error {
  constructor(message = "injected journal fault") {
    super(message);
    this.name = "InjectedFault";
  }
}

export interface FaultPlan {
  /** Fail the next `failNext` store calls (insertBatch, list*, ping) without any effect. */
  failNext?: number;
  /** After the next `insertBatch` commits, throw (the commit is kept, so a retry must dedupe). */
  commitThenThrow?: number;
}

export class MemoryJournalStore implements JournalStore {
  readonly #rows: JournalRow[] = [];
  readonly #ids = new Set<string>();
  #seq = 0n;
  #failNext = 0;
  #commitThenThrow = 0;
  #closed = false;
  /** Number of calls to each method, for tests. */
  readonly calls = { insertBatch: 0, listOrders: 0, listJournal: 0, ping: 0 };

  /** Replaces the pending fault plan. */
  inject(plan: FaultPlan): void {
    this.#failNext = plan.failNext ?? 0;
    this.#commitThenThrow = plan.commitThenThrow ?? 0;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** All stored rows in insertion order (for tests). */
  get rows(): readonly JournalRow[] {
    return this.#rows;
  }

  #maybeFail(): void {
    if (this.#failNext > 0) {
      this.#failNext -= 1;
      throw new InjectedFault();
    }
  }

  async insertBatch(records: readonly JournalRecord[]): Promise<void> {
    this.calls.insertBatch += 1;
    this.#maybeFail();
    // Atomic: validate nothing, then commit every unseen record in order.
    for (const record of records) {
      if (this.#ids.has(record.record_id)) continue;
      this.#ids.add(record.record_id);
      this.#seq += 1n;
      this.#rows.push({ ...record, seq: this.#seq } as JournalRow);
    }
    if (this.#commitThenThrow > 0) {
      this.#commitThenThrow -= 1;
      throw new InjectedFault("injected journal fault after commit");
    }
  }

  async listOrders(q: ListQuery): Promise<OrderRow[]> {
    this.calls.listOrders += 1;
    this.#maybeFail();
    return mergeJournal([this.#select(q).filter((r): r is OrderRow => r.type === "order")], q.limit);
  }

  async listJournal(q: ListQuery): Promise<JournalRow[]> {
    this.calls.listJournal += 1;
    this.#maybeFail();
    const rows = this.#select(q);
    return mergeJournal(
      [
        rows.filter((r): r is OrderRow => r.type === "order"),
        rows.filter((r): r is FillRow => r.type === "fill"),
        rows.filter((r): r is RejectionRow => r.type === "rejection"),
      ],
      q.limit,
    );
  }

  #select(q: ListQuery): JournalRow[] {
    return this.#rows.filter((r) => r.account_id === q.account && (q.session === "all" || r.session_id === q.session));
  }

  async ping(): Promise<void> {
    this.calls.ping += 1;
    this.#maybeFail();
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}
