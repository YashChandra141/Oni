import { describe, expect, test } from "bun:test";
import { MemoryJournalStore } from "./memory.ts";
import { JournalQueue } from "./queue.ts";
import type { JournalRecord } from "./store.ts";

let n = 0;
function order(orderId = `o${++n}`): JournalRecord {
  n += 1;
  return {
    type: "order",
    record_id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    session_id: "s1",
    account_id: "guest",
    ts: BigInt(n),
    order_id: orderId,
    source: "web",
    symbol: "BTC-USD",
    side: "buy",
    kind: "market",
    qty: 1n,
    price: null,
  };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i += 1) await tick();
  expect(cond()).toBe(true);
}

function logger() {
  const lines: { level: string; line: string }[] = [];
  return {
    lines,
    info: (line: string) => lines.push({ level: "info", line }),
    warn: (line: string) => lines.push({ level: "warn", line }),
    error: (line: string) => lines.push({ level: "error", line }),
  };
}

const classify = (err: unknown) => (err instanceof Error && err.name === "Poison" ? ("poison" as const) : ("unreachable" as const));

describe("JournalQueue", () => {
  test("writes enqueued records in order and reports up", async () => {
    const store = new MemoryJournalStore();
    const q = new JournalQueue({ store, classify, logger: logger(), sleep: tick, migrated: true });
    const recs = [order(), order(), order()];
    for (const r of recs) q.enqueue(r);
    await q.flush(2_000);
    expect(store.rows.map((r) => r.record_id)).toEqual(recs.map((r) => r.record_id));
    expect(q.status()).toBe("up");
  });

  test("drops the oldest when full and logs the drop count once per interval", async () => {
    const store = new MemoryJournalStore();
    const log = logger();
    const q = new JournalQueue({ store, classify, logger: log, sleep: tick, maxQueue: 3, now: () => 1_000 });
    const recs = [order(), order(), order(), order(), order()];
    for (const r of recs) q.enqueue(r);
    expect(q.stats()).toEqual({ queued: 3, dropped: 2, poisoned: 0 });
    expect(log.lines.filter((l) => l.level === "warn")).toHaveLength(1);
    q.setMigrated(true);
    await q.flush(2_000);
    expect(store.rows.map((r) => r.record_id)).toEqual(recs.slice(2).map((r) => r.record_id));
  });

  test("holds records and stays down until setMigrated(true)", async () => {
    const store = new MemoryJournalStore();
    const q = new JournalQueue({ store, classify, logger: logger(), sleep: tick });
    q.enqueue(order());
    await tick();
    await tick();
    expect(store.calls.insertBatch).toBe(0);
    expect(q.status()).toBe("down");
    q.setMigrated(true);
    await until(() => store.rows.length === 1);
    expect(q.status()).toBe("up");
  });

  test("keeps records through an unreachable store and writes them after recovery", async () => {
    const store = new MemoryJournalStore();
    store.inject({ failNext: 2 });
    const q = new JournalQueue({ store, classify, logger: logger(), sleep: tick, migrated: true });
    q.enqueue(order());
    await until(() => store.rows.length === 1);
    expect(store.rows).toHaveLength(1);
    await until(() => q.status() === "up");
  });

  test("retries a poison batch one record at a time and drops only the bad record", async () => {
    class PoisonStore extends MemoryJournalStore {
      override async insertBatch(records: readonly JournalRecord[]): Promise<void> {
        if (records.some((r) => r.type === "order" && r.order_id === "bad")) {
          throw Object.assign(new Error("value out of range"), { name: "Poison" });
        }
        return super.insertBatch(records);
      }
    }
    const store = new PoisonStore();
    const log = logger();
    const q = new JournalQueue({ store, classify, logger: log, sleep: tick });
    const good1 = order("g1");
    const bad = order("bad");
    const good2 = order("g2");
    // Held until migrated, so the three records go out as one batch.
    q.enqueue(good1);
    q.enqueue(bad);
    q.enqueue(good2);
    q.setMigrated(true);
    await q.flush(2_000);
    expect(store.rows.map((r) => r.record_id)).toEqual([good1.record_id, good2.record_id]);
    expect(q.stats().poisoned).toBe(1);
    expect(log.lines.some((l) => l.line.includes(bad.record_id))).toBe(true);
  });
});
