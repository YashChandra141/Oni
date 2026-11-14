// Property P26 — validates Req 20.12
//
// For random enqueue, yield, and fault sequences against a MemoryJournalStore with fault
// injection (fail the next n calls, commit then throw) and a small queue bound, after the queue
// drains the store holds every enqueued record that the queue did not drop, exactly once, in
// enqueue order (seq order matches), and the dropped count equals the oldest overflow.
//
// Two modes:
//   gated       the writer is held by the setMigrated gate while everything is enqueued, so the
//               drops are deterministic: exactly the oldest `n - bound` records.
//   interleaved the writer runs between enqueues, so what it takes before a drop is timing
//               dependent. The checks that remain: the store holds a subsequence of the enqueued
//               records, once each, in order; stored + dropped = enqueued; and the newest
//               `bound` records are never dropped.
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { waitUntil } from "../gateway/testing.ts";
import { MemoryJournalStore } from "./memory.ts";
import { JournalQueue } from "./queue.ts";
import type { JournalRecord } from "./store.ts";

type Op =
  | { readonly t: "enqueue"; readonly kind: "order" | "fill" | "rejection" }
  | { readonly t: "yield" }
  | { readonly t: "fail"; readonly n: number }
  | { readonly t: "commitThrow"; readonly n: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom<"order" | "fill" | "rejection">("order", "fill", "rejection").map((kind): Op => ({ t: "enqueue", kind })) },
  { weight: 2, arbitrary: fc.constant<Op>({ t: "yield" }) },
  { weight: 1, arbitrary: fc.integer({ min: 1, max: 3 }).map((n): Op => ({ t: "fail", n })) },
  { weight: 1, arbitrary: fc.integer({ min: 1, max: 2 }).map((n): Op => ({ t: "commitThrow", n })) },
);

function makeRecord(i: number, kind: "order" | "fill" | "rejection"): JournalRecord {
  const base = {
    record_id: `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`,
    session_id: "s1",
    account_id: "guest",
    ts: BigInt(i),
    order_id: `o${i}`,
  };
  switch (kind) {
    case "order":
      return { ...base, type: "order", source: "web", symbol: "BTC-USD", side: "buy", kind: "market", qty: 1n, price: null };
    case "fill":
      return {
        ...base,
        type: "fill",
        market_ts: BigInt(i),
        symbol: "BTC-USD",
        side: "buy",
        price: 100n,
        qty: 1n,
        fee: 1n,
        remaining: 0n,
      };
    case "rejection":
      return { ...base, type: "rejection", source: "web", reason: "max_order_value", detail: null };
  }
}

const quiet = { info: () => {}, warn: () => {}, error: () => {} };
// A fault is an unreachable error, so the writer keeps the batch and retries.
const classify = (): "unreachable" => "unreachable";
const instantSleep = (): Promise<void> => Promise.resolve();
const macrotask = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface RunResult {
  readonly store: MemoryJournalStore;
  readonly queue: JournalQueue;
  readonly enqueued: JournalRecord[];
}

async function run(ops: readonly Op[], bound: number, gated: boolean): Promise<RunResult> {
  const store = new MemoryJournalStore();
  const queue = new JournalQueue({
    store,
    classify,
    logger: quiet,
    sleep: instantSleep,
    maxQueue: bound,
    now: () => 0,
    migrated: !gated,
  });
  const enqueued: JournalRecord[] = [];
  const plan = { failNext: 0, commitThenThrow: 0 };
  for (const op of ops) {
    switch (op.t) {
      case "enqueue": {
        const record = makeRecord(enqueued.length, op.kind);
        enqueued.push(record);
        queue.enqueue(record);
        break;
      }
      case "yield":
        await macrotask();
        break;
      case "fail":
        plan.failNext += op.n;
        store.inject({ ...plan });
        break;
      case "commitThrow":
        plan.commitThenThrow += op.n;
        store.inject({ ...plan });
        break;
    }
  }
  if (gated) {
    // Nothing may have been written while the gate was closed.
    expect(store.calls.insertBatch).toBe(0);
    expect(queue.stats().queued).toBe(Math.min(enqueued.length, bound));
    queue.setMigrated(true);
  }
  const drained = await waitUntil(() => queue.stats().queued === 0 && queue.status() === "up", 2_000);
  expect(drained).toBe(true);
  await queue.flush(1_000);
  return { store, queue, enqueued };
}

function checkCommon({ store, queue, enqueued }: RunResult, bound: number): void {
  const ids = store.rows.map((r) => r.record_id);
  // Exactly once (the retry after a commit-then-throw is deduplicated by record_id).
  expect(new Set(ids).size).toBe(ids.length);
  // Enqueue order: record index strictly increases, and seq follows the store's insertion order.
  const index = new Map(enqueued.map((r, i) => [r.record_id, i]));
  const positions = ids.map((id) => index.get(id) ?? -1);
  expect(positions.every((p) => p >= 0)).toBe(true);
  for (let k = 1; k < positions.length; k += 1) expect(positions[k] ?? -1).toBeGreaterThan(positions[k - 1] ?? Number.POSITIVE_INFINITY);
  for (let k = 1; k < store.rows.length; k += 1) {
    expect(store.rows[k]?.seq ?? 0n).toBeGreaterThan(store.rows[k - 1]?.seq ?? 0n);
  }
  // Accounting: stored + dropped = enqueued.
  const { dropped, queued } = queue.stats();
  expect(queued).toBe(0);
  expect(ids.length + dropped).toBe(enqueued.length);
  // The newest `bound` records are never dropped.
  const newest = enqueued.slice(-bound).map((r) => r.record_id);
  for (const id of newest) expect(ids).toContain(id);
}

describe("P26 journal queue drains exactly once, in order, minus drops (Req 20.12)", () => {
  test("gated: the store holds exactly the newest `bound` records and dropped = overflow", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { maxLength: 40 }), fc.integer({ min: 1, max: 6 }), async (ops, bound) => {
        const result = await run(ops, bound, true);
        checkCommon(result, bound);
        const n = result.enqueued.length;
        expect(result.queue.stats().dropped).toBe(Math.max(0, n - bound));
        expect(result.store.rows.map((r) => r.record_id)).toEqual(result.enqueued.slice(-bound).map((r) => r.record_id));
      }),
      { numRuns: 100 },
    );
  }, 60_000);

  test("interleaved: stored records are an in-order subsequence of the enqueued ones, once each", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { maxLength: 40 }), fc.integer({ min: 1, max: 6 }), async (ops, bound) => {
        const result = await run(ops, bound, false);
        checkCommon(result, bound);
      }),
      { numRuns: 100 },
    );
  }, 60_000);
});
