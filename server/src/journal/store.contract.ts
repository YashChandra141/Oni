// Shared JournalStore contract (Property P27, Req 20.23, 20.30). Not a test file itself: the
// store tests call `runJournalContract(name, makeStore)` for MemoryJournalStore (always) and for
// PrismaJournalStore (only when TEST_DATABASE_URL is set).
//
// Each property run inserts generated records (several accounts and sessions, i64 min/max in
// every BIGINT field, colliding timestamps) in generated batches, then checks `listOrders` and
// `listJournal` against a model: account scoping, session filtering ("all" or one session),
// `limit`, ascending (ts, seq) order, an exact BigInt round trip, and idempotent re-insert.
//
// The model orders records by (ts, insertion index). That equals (ts, seq) because `seq` follows
// enqueue order across the three tables (Decision J5); the contract also checks that directly.
import { expect, describe, test } from "bun:test";
import fc from "fast-check";
import { I64_MAX, I64_MIN } from "../protocol.ts";
import type { JournalRecord, JournalRow, JournalSource, JournalStore } from "./store.ts";

export interface JournalContractTarget {
  readonly store: JournalStore;
  /** Called after each property run. */
  dispose(): Promise<void>;
}

/**
 * Returns an EMPTY store for one property run. The Postgres factory truncates the tables first
 * and shares one client; the memory factory returns a new store.
 */
export type MakeContractStore = () => Promise<JournalContractTarget> | JournalContractTarget;

export interface ContractOptions {
  readonly numRuns?: number;
  readonly timeoutMs?: number;
}

export const CONTRACT_ACCOUNTS = ["guest", "w_Aaa111", "w_Bbb222"] as const;
export const CONTRACT_SESSIONS = ["s1", "s2"] as const;

/** A UUID text for record number `i`, valid for a Postgres UUID column. */
export function recordUuid(i: number): string {
  return `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
}

const anyI64: fc.Arbitrary<bigint> = fc.oneof(
  { weight: 4, arbitrary: fc.bigInt({ min: -1_000n, max: 1_000n }) },
  { weight: 2, arbitrary: fc.constantFrom(I64_MIN, I64_MAX, 0n, I64_MIN + 1n, I64_MAX - 1n) },
  { weight: 1, arbitrary: fc.bigInt({ min: I64_MIN, max: I64_MAX }) },
);

// Few distinct ts values so (ts, seq) tie-breaking is exercised; the i64 extremes sort first and last.
const tsArb: fc.Arbitrary<bigint> = fc.oneof(
  { weight: 6, arbitrary: fc.bigInt({ min: 0n, max: 4n }) },
  { weight: 1, arbitrary: fc.constantFrom(I64_MIN, I64_MAX) },
);

const accountArb = fc.constantFrom(...CONTRACT_ACCOUNTS);
const sessionArb = fc.constantFrom(...CONTRACT_SESSIONS);
const orderIdArb = fc.constantFrom("o_1", "o_2", "o_3");
const symbolArb = fc.constantFrom("BTC-USD", "ETH-USD", "SOL-USD");
const sideArb = fc.constantFrom("buy", "sell");
const sourceArb: fc.Arbitrary<JournalSource> = fc.constantFrom<JournalSource[]>("web", "tui", "mcp", "llm");

const orderArb: fc.Arbitrary<JournalRecord> = fc.record({
  type: fc.constant("order" as const),
  record_id: fc.constant(""),
  session_id: sessionArb,
  account_id: accountArb,
  ts: tsArb,
  order_id: orderIdArb,
  source: sourceArb,
  symbol: symbolArb,
  side: sideArb,
  kind: fc.constantFrom("market", "limit", "stop"),
  qty: anyI64,
  price: fc.option(anyI64, { nil: null }),
});

const fillArb: fc.Arbitrary<JournalRecord> = fc.record({
  type: fc.constant("fill" as const),
  record_id: fc.constant(""),
  session_id: sessionArb,
  account_id: accountArb,
  ts: tsArb,
  market_ts: anyI64,
  order_id: orderIdArb,
  symbol: symbolArb,
  side: sideArb,
  price: anyI64,
  qty: anyI64,
  fee: anyI64,
  remaining: anyI64,
});

const rejectionArb: fc.Arbitrary<JournalRecord> = fc.record({
  type: fc.constant("rejection" as const),
  record_id: fc.constant(""),
  session_id: sessionArb,
  account_id: accountArb,
  ts: tsArb,
  order_id: orderIdArb,
  source: fc.constantFrom<JournalSource[]>("web", "tui", "mcp", "llm", "engine"),
  reason: fc.constantFrom("max_order_value", "kill_switch", "price_band", "account_limit"),
  detail: fc.option(fc.constantFrom("buy BTC-USD market", "sell ETH-USD limit"), { nil: null }),
});

const recordsArb: fc.Arbitrary<JournalRecord[]> = fc.array(fc.oneof(orderArb, fillArb, rejectionArb), { maxLength: 12 });

function stripSeq(row: JournalRow): JournalRecord {
  const { seq: _seq, ...rest } = row;
  return rest as JournalRecord;
}

function byTsThenIndex(a: { r: JournalRecord; i: number }, b: { r: JournalRecord; i: number }): number {
  if (a.r.ts !== b.r.ts) return a.r.ts < b.r.ts ? -1 : 1;
  return a.i - b.i;
}

/** Splits `items` into consecutive batches of `size` (at least 1). */
function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function runJournalContract(name: string, makeStore: MakeContractStore, options: ContractOptions = {}): void {
  const numRuns = options.numRuns ?? 100;
  describe(`${name}: JournalStore contract`, () => {
    test(
      "P27 listings are account scoped, session filtered, limited, (ts, seq) ordered, and round trip exactly (Req 20.23, 20.30)",
      async () => {
        await fc.assert(
          fc.asyncProperty(
            recordsArb,
            fc.integer({ min: 1, max: 5 }),
            fc.integer({ min: 1, max: 8 }),
            async (generated, batchSize, limit) => {
              const records = generated.map((r, i): JournalRecord => ({ ...r, record_id: recordUuid(i) }));
              const target = await makeStore();
              try {
                const { store } = target;
                for (const batch of chunks(records, batchSize)) await store.insertBatch(batch);
                // A retried batch changes nothing (Req 20.12: idempotent on record_id).
                const first = records.slice(0, batchSize);
                await store.insertBatch(first);

                const indexed = records.map((r, i) => ({ r, i }));
                const seqById = new Map<string, bigint>();

                for (const account of [...CONTRACT_ACCOUNTS, "w_NoSuchAccount"]) {
                  for (const session of ["all", ...CONTRACT_SESSIONS, "s_none"]) {
                    const mine = indexed
                      .filter(({ r }) => r.account_id === account && (session === "all" || r.session_id === session))
                      .sort(byTsThenIndex);
                    for (const lim of [limit, 5000]) {
                      const wantJournal = mine.slice(-lim).map(({ r }) => r);
                      const wantOrders = mine.filter(({ r }) => r.type === "order").slice(-lim).map(({ r }) => r);

                      const journal = await store.listJournal({ account, session, limit: lim });
                      expect(journal.map((row) => row.record_id)).toEqual(wantJournal.map((r) => r.record_id));
                      expect(journal.map(stripSeq)).toEqual(wantJournal);
                      for (const row of journal) {
                        expect(row.account_id).toBe(account);
                        if (session !== "all") expect(row.session_id).toBe(session);
                      }

                      const orders = await store.listOrders({ account, session, limit: lim });
                      expect(orders.map((row) => row.record_id)).toEqual(wantOrders.map((r) => r.record_id));
                      expect(orders.map(stripSeq)).toEqual(wantOrders);
                      for (const row of orders) expect(row.type).toBe("order");

                      if (session === "all" && lim === 5000) for (const row of journal) seqById.set(row.record_id, row.seq);
                    }
                  }
                }

                // seq follows enqueue order across the three tables.
                let previous: bigint | undefined;
                for (const r of records) {
                  const seq = seqById.get(r.record_id);
                  expect(seq).toBeDefined();
                  if (seq === undefined) continue;
                  if (previous !== undefined) expect(seq).toBeGreaterThan(previous);
                  previous = seq;
                }
              } finally {
                await target.dispose();
              }
            },
          ),
          { numRuns },
        );
      },
      options.timeoutMs ?? 60_000,
    );
  });
}
