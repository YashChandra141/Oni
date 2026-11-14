// Journal store interface, record and row types, and the pure merge (design Decisions J4, J6,
// Req 20). The store has no migrate(): Prisma Migrate applies the schema (Decision J5).
//
// Prices, quantities, money, and times are bigint here, stored as Postgres BIGINT (Req 20.22).
// `ts` is the server's Date.now() at enqueue (epoch ms); a fill keeps the engine time in
// `market_ts`. `seq` comes from one shared sequence, so it follows enqueue order across tables.

export type JournalKind = "order" | "fill" | "rejection";

/** Where an order came from. `engine` marks a rejection that the engine itself produced. */
export type JournalSource = "web" | "tui" | "mcp" | "llm" | "engine";

interface RecordBase {
  /** UUID, unique per record. Inserts are idempotent on it (Req 20.12). */
  readonly record_id: string;
  readonly session_id: string;
  /** "guest" or "w_<address>" (Req 20.27). */
  readonly account_id: string;
  /** Epoch ms at enqueue. */
  readonly ts: bigint;
}

export interface OrderRecord extends RecordBase {
  readonly type: "order";
  readonly order_id: string;
  readonly source: JournalSource;
  readonly symbol: string;
  readonly side: string;
  /** market | limit | stop */
  readonly kind: string;
  /** Lots. */
  readonly qty: bigint;
  /** Ticks (limit or stop price); null for a market order. */
  readonly price: bigint | null;
}

export interface FillRecord extends RecordBase {
  readonly type: "fill";
  /** Engine (market) time of the fill. */
  readonly market_ts: bigint;
  readonly order_id: string;
  readonly symbol: string;
  readonly side: string;
  readonly price: bigint;
  readonly qty: bigint;
  readonly fee: bigint;
  readonly remaining: bigint;
}

export interface RejectionRecord extends RecordBase {
  readonly type: "rejection";
  readonly order_id: string;
  readonly source: JournalSource;
  readonly reason: string;
  readonly detail: string | null;
}

export type JournalRecord = OrderRecord | FillRecord | RejectionRecord;

/** A stored record: the record plus its `seq`. */
export type OrderRow = OrderRecord & { readonly seq: bigint };
export type FillRow = FillRecord & { readonly seq: bigint };
export type RejectionRow = RejectionRecord & { readonly seq: bigint };
export type JournalRow = OrderRow | FillRow | RejectionRow;

export interface ListQuery {
  readonly account: string;
  /** A Session_Id, or "all" for every session. */
  readonly session: string;
  /** 1..5000. */
  readonly limit: number;
}

export interface JournalStore {
  /** Idempotent on `record_id`. Rejects if the database is unreachable or a record is invalid. */
  insertBatch(records: readonly JournalRecord[]): Promise<void>;
  /** Most recent `limit` orders of the account, ascending by (ts, seq). */
  listOrders(q: ListQuery): Promise<OrderRow[]>;
  /** Most recent `limit` records of all kinds of the account, ascending by (ts, seq). */
  listJournal(q: ListQuery): Promise<JournalRow[]>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export const JOURNAL_DEFAULT_LIMIT = 500;
export const JOURNAL_MAX_LIMIT = 5000;

/** Ascending order by (ts, seq). */
export function compareRows(a: { ts: bigint; seq: bigint }, b: { ts: bigint; seq: bigint }): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  if (a.seq !== b.seq) return a.seq < b.seq ? -1 : 1;
  return 0;
}

/**
 * Merges per-table results into the most recent `limit` rows, sorted ascending by (ts, seq)
 * (Req 20.7, 20.24). Pure; does not modify its input.
 */
export function mergeJournal<T extends { ts: bigint; seq: bigint }>(
  parts: readonly (readonly T[])[],
  limit: number,
): T[] {
  const all: T[] = [];
  for (const part of parts) for (const row of part) all.push(row);
  all.sort(compareRows);
  if (limit <= 0) return [];
  return all.length > limit ? all.slice(all.length - limit) : all;
}
