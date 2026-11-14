// Postgres-only journal tests (Task 11.5; Req 20.4, 20.12, 20.22, 20.23). They run only when
// TEST_DATABASE_URL is set, expect the Migrations already applied (`prisma migrate deploy`), and
// refuse to run when TEST_DATABASE_URL equals DATABASE_URL or DIRECT_URL. Tables are emptied
// between cases with a `$executeRaw` tagged template. The generated client loads only through
// dynamic imports in pg.testing.ts, so the file loads without `prisma generate` when skipped.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { classifyPrismaError } from "./classify.ts";
import { type PgHarness, openPgHarness, pgEnabled } from "./pg.testing.ts";
import { I64_MAX, I64_MIN } from "../protocol.ts";
import type { FillRecord, JournalRecord, OrderRecord, RejectionRecord } from "./store.ts";

const uuid = (i: number): string => `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;

function order(i: number, over: Partial<OrderRecord> = {}): OrderRecord {
  return {
    type: "order",
    record_id: uuid(i),
    session_id: "s1",
    account_id: "guest",
    ts: 10n,
    order_id: `o${i}`,
    source: "web",
    symbol: "BTC-USD",
    side: "buy",
    kind: "limit",
    qty: 5n,
    price: 100n,
    ...over,
  };
}

function fill(i: number, over: Partial<FillRecord> = {}): FillRecord {
  return {
    type: "fill",
    record_id: uuid(i),
    session_id: "s1",
    account_id: "guest",
    ts: 10n,
    market_ts: 9n,
    order_id: `o${i}`,
    symbol: "BTC-USD",
    side: "buy",
    price: 100n,
    qty: 5n,
    fee: 1n,
    remaining: 0n,
    ...over,
  };
}

function rejection(i: number, over: Partial<RejectionRecord> = {}): RejectionRecord {
  return {
    type: "rejection",
    record_id: uuid(i),
    session_id: "s1",
    account_id: "guest",
    ts: 10n,
    order_id: `o${i}`,
    source: "engine",
    reason: "kill_switch",
    detail: null,
    ...over,
  };
}

describe.skipIf(!pgEnabled)("PrismaJournalStore on Postgres", () => {
  let pg: PgHarness;

  beforeAll(async () => {
    pg = await openPgHarness(); // throws when the URL equals DATABASE_URL or DIRECT_URL
    await pg.store.ping();
  });

  beforeEach(async () => {
    await pg.clear();
  });

  afterAll(async () => {
    await pg?.close();
  });

  const q = { account: "guest", session: "all", limit: 5000 } as const;

  test("every BIGINT field round-trips at the i64 minimum and maximum (Req 20.22, 20.23)", async () => {
    const o = order(1, { ts: I64_MIN, qty: I64_MAX, price: I64_MIN });
    const f = fill(2, { ts: I64_MAX, market_ts: I64_MIN, price: I64_MAX, qty: I64_MIN, fee: I64_MAX, remaining: I64_MIN });
    const r = rejection(3, { ts: I64_MIN });
    await pg.store.insertBatch([o, f, r]);

    const rows = await pg.store.listJournal(q);
    const strip = (row: (typeof rows)[number]): JournalRecord => {
      const { seq: _seq, ...rest } = row;
      return rest as JournalRecord;
    };
    // Ascending (ts, seq): the rejection (ts MIN, seq 3) follows the order (ts MIN, seq 1).
    expect(rows.map(strip)).toEqual([o, r, f]);

    // The column holds the exact integer, not a rounded double.
    const stored = await pg.raw.$queryRaw<{ ts: string; qty: string; price: string }[]>`SELECT ts::text AS ts, qty::text AS qty, price::text AS price FROM orders`;
    expect(stored).toEqual([{ ts: I64_MIN.toString(), qty: I64_MAX.toString(), price: I64_MIN.toString() }]);
    const storedFill = await pg.raw.$queryRaw<
      { ts: string; market_ts: string; price: string; qty: string; fee: string; remaining: string }[]
    >`SELECT ts::text AS ts, market_ts::text AS market_ts, price::text AS price, qty::text AS qty, fee::text AS fee, remaining::text AS remaining FROM fills`;
    expect(storedFill).toEqual([
      {
        ts: I64_MAX.toString(),
        market_ts: I64_MIN.toString(),
        price: I64_MAX.toString(),
        qty: I64_MIN.toString(),
        fee: I64_MAX.toString(),
        remaining: I64_MIN.toString(),
      },
    ]);
    const storedRejection = await pg.raw.$queryRaw<{ ts: string }[]>`SELECT ts::text AS ts FROM rejections`;
    expect(storedRejection).toEqual([{ ts: I64_MIN.toString() }]);
  });

  test("a retried batch is stored once: skipDuplicates keeps the first row and its seq (Req 20.12)", async () => {
    const batch: JournalRecord[] = [order(1), fill(2), rejection(3)];
    await pg.store.insertBatch(batch);
    const before = await pg.store.listJournal(q);

    // The retry repeats the whole batch and adds one new record.
    await pg.store.insertBatch([...batch, order(4)]);
    const after = await pg.store.listJournal(q);

    expect(after).toHaveLength(4);
    expect(after.filter((row) => row.record_id !== uuid(4))).toEqual(before);

    const counts = await pg.raw.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM orders`;
    expect(counts).toEqual([{ n: 2 }]);
  });

  test("seq follows enqueue order across the three tables (Req 20.7)", async () => {
    const batch: JournalRecord[] = [order(1), fill(2), rejection(3), order(4), rejection(5), fill(6)];
    // Same ts for all, so the listing order is the seq order.
    await pg.store.insertBatch(batch);
    const rows = await pg.store.listJournal(q);
    expect(rows.map((row) => row.record_id)).toEqual(batch.map((r) => r.record_id));
    for (let k = 1; k < rows.length; k += 1) expect(rows[k]?.seq ?? 0n).toBeGreaterThan(rows[k - 1]?.seq ?? 0n);

    // Across batches too: a later batch gets larger seq values.
    await pg.store.insertBatch([fill(7), order(8)]);
    const more = await pg.store.listJournal(q);
    expect(more.map((row) => row.record_id)).toEqual([...batch, fill(7), order(8)].map((r) => r.record_id));
  });

  test("an account, session, and limit scope every listing (Req 20.30, 20.31)", async () => {
    await pg.store.insertBatch([
      order(1, { account_id: "guest", session_id: "s1", ts: 1n }),
      order(2, { account_id: "w_Aaa111", session_id: "s1", ts: 2n }),
      order(3, { account_id: "w_Aaa111", session_id: "s2", ts: 3n }),
      fill(4, { account_id: "w_Aaa111", session_id: "s2", ts: 4n }),
    ]);
    const all = await pg.store.listJournal({ account: "w_Aaa111", session: "all", limit: 5000 });
    expect(all.map((r) => r.record_id)).toEqual([uuid(2), uuid(3), uuid(4)]);
    const s2 = await pg.store.listJournal({ account: "w_Aaa111", session: "s2", limit: 5000 });
    expect(s2.map((r) => r.record_id)).toEqual([uuid(3), uuid(4)]);
    const last = await pg.store.listJournal({ account: "w_Aaa111", session: "all", limit: 1 });
    expect(last.map((r) => r.record_id)).toEqual([uuid(4)]);
    const orders = await pg.store.listOrders({ account: "w_Aaa111", session: "all", limit: 5000 });
    expect(orders.map((r) => r.record_id)).toEqual([uuid(2), uuid(3)]);
    expect(await pg.store.listJournal({ account: "w_Nobody", session: "all", limit: 5000 })).toEqual([]);
  });

  // Task 11.5 follow-up from classify.ts: which error does a value outside i64 raise through the
  // pg adapter? The writer must treat it as poison (drop the record), not retry it forever.
  test("a BIGINT value outside i64 is rejected and classified as poison", async () => {
    const bad = order(1, { qty: I64_MAX + 1n });
    let caught: unknown;
    try {
      await pg.store.insertBatch([bad]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(classifyPrismaError(caught)).toBe("poison");
    expect(await pg.store.listJournal(q)).toEqual([]);
  });

  test("ping succeeds against a reachable database", async () => {
    await expect(pg.store.ping()).resolves.toBeUndefined();
  });
});
