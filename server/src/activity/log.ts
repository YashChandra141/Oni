// Activity_Log (oni-terminal-v2 Req 2.1 to 2.5, 2.16, 2.18): a bounded in-memory store of the
// orders, fills, and rejections of the current engine run. Nothing is written to disk.
//
// - At most MAX_RECORDS_PER_ACCOUNT records per account: past the bound the account's oldest
//   record is dropped (Req 2.4).
// - At most MAX_ACCOUNTS accounts: past the bound the least recently appended account is
//   dropped whole (Req 2.5).
// - Listings are newest first, `limit` 1 to 1,000, default 500.
// Pure: no I/O, no timers. Bounds are injectable for tests.

import type { AccountId, Side } from "../protocol.ts";

export const MAX_RECORDS_PER_ACCOUNT = 1_000;
export const MAX_ACCOUNTS = 1_000;
export const MAX_LIST_LIMIT = 1_000;
export const DEFAULT_LIST_LIMIT = 500;

export type ActivityOrderKind = "market" | "limit" | "stop";

interface ActivityBase {
  readonly accountId: AccountId;
  readonly orderId: string;
  readonly symbol: string | null;
  /** Epoch milliseconds. */
  readonly ts: number;
  /** Assigned by the log: process-wide, strictly increasing in append order. */
  readonly seq: number;
}

export interface ActivityOrder extends ActivityBase {
  readonly kind: "order";
  readonly venue: string;
  readonly symbol: string;
  readonly side: Side;
  readonly qty: bigint;
  readonly orderKind: ActivityOrderKind;
  /** Limit or stop price in ticks; null for a market order. */
  readonly price: bigint | null;
  readonly source: string;
}

export interface ActivityFill extends ActivityBase {
  readonly kind: "fill";
  readonly venue: string;
  readonly symbol: string;
  readonly side: Side;
  readonly price: bigint;
  readonly qty: bigint;
  readonly fee: bigint;
  readonly remaining: bigint;
}

export interface ActivityRejection extends ActivityBase {
  readonly kind: "rejection";
  readonly venue?: string;
  readonly reason: string;
  readonly side: Side | null;
  readonly qty: bigint | null;
  readonly orderKind: ActivityOrderKind | null;
  readonly price: bigint | null;
  readonly source: string | null;
}

export type ActivityRecord = ActivityOrder | ActivityFill | ActivityRejection;

/** A record as the caller supplies it: the log assigns `seq`. */
export type ActivityInput = ActivityRecord extends infer R ? (R extends ActivityRecord ? Omit<R, "seq"> : never) : never;

export interface ActivityLogOptions {
  readonly maxRecordsPerAccount?: number;
  readonly maxAccounts?: number;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new RangeError(`limit must be an integer from 1 to ${MAX_LIST_LIMIT}`);
  }
  return limit;
}

export class ActivityLog {
  /** Map order is recency of append: the first key is the least recently appended account. */
  readonly #accounts = new Map<AccountId, ActivityRecord[]>();
  readonly #maxRecords: number;
  readonly #maxAccounts: number;
  #seq = 0;

  constructor(options: ActivityLogOptions = {}) {
    this.#maxRecords = options.maxRecordsPerAccount ?? MAX_RECORDS_PER_ACCOUNT;
    this.#maxAccounts = options.maxAccounts ?? MAX_ACCOUNTS;
  }

  /** Appends a record and returns it with its `seq`. Synchronous; never throws on a full log. */
  append(record: ActivityInput): ActivityRecord {
    const stored = { ...record, seq: ++this.#seq } as ActivityRecord;
    let list = this.#accounts.get(stored.accountId);
    if (list === undefined) {
      list = [];
      while (this.#accounts.size >= this.#maxAccounts) {
        const oldest = this.#accounts.keys().next();
        if (oldest.done) break;
        this.#accounts.delete(oldest.value);
      }
    } else {
      this.#accounts.delete(stored.accountId); // re-insert below to mark it most recent
    }
    this.#accounts.set(stored.accountId, list);
    list.push(stored);
    if (list.length > this.#maxRecords) list.splice(0, list.length - this.#maxRecords);
    return stored;
  }

  /** Order records of the account, newest first. Throws RangeError for a limit outside 1..1000. */
  listOrders(account: AccountId, limit?: number): ActivityOrder[] {
    return this.#list(account, limit, (r): r is ActivityOrder => r.kind === "order");
  }

  /** Orders, fills, and rejections of the account, newest first. */
  listActivity(account: AccountId, limit?: number): ActivityRecord[] {
    return this.#list(account, limit, (r): r is ActivityRecord => true);
  }

  clear(): void {
    this.#accounts.clear();
  }

  accountCount(): number {
    return this.#accounts.size;
  }

  recordCount(account: AccountId): number {
    return this.#accounts.get(account)?.length ?? 0;
  }

  #list<T extends ActivityRecord>(
    account: AccountId,
    limit: number | undefined,
    keep: (r: ActivityRecord) => r is T,
  ): T[] {
    const max = clampLimit(limit);
    const list = this.#accounts.get(account);
    const out: T[] = [];
    if (list === undefined) return out;
    for (let i = list.length - 1; i >= 0 && out.length < max; i--) {
      const r = list[i];
      if (r !== undefined && keep(r)) out.push(r);
    }
    return out;
  }
}
