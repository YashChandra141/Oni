import { describe, expect, test } from "bun:test";
import { InjectedFault, MemoryJournalStore } from "./memory.ts";
import type { JournalRecord } from "./store.ts";

let n = 0;
function order(over: Partial<{ account_id: string; session_id: string; ts: bigint; record_id: string }> = {}): JournalRecord {
  n += 1;
  return {
    type: "order",
    record_id: over.record_id ?? `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    session_id: over.session_id ?? "s1",
    account_id: over.account_id ?? "guest",
    ts: over.ts ?? BigInt(n),
    order_id: `o${n}`,
    source: "web",
    symbol: "BTC-USD",
    side: "buy",
    kind: "market",
    qty: 1n,
    price: null,
  };
}

function fill(over: Partial<{ ts: bigint }> = {}): JournalRecord {
  n += 1;
  return {
    type: "fill",
    record_id: `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`,
    session_id: "s1",
    account_id: "guest",
    ts: over.ts ?? BigInt(n),
    market_ts: 0n,
    order_id: "o",
    symbol: "BTC-USD",
    side: "buy",
    price: 1n,
    qty: 1n,
    fee: 0n,
    remaining: 0n,
  };
}

describe("MemoryJournalStore", () => {
  test("one seq counter across kinds, in insert order", async () => {
    const s = new MemoryJournalStore();
    await s.insertBatch([order(), fill(), order()]);
    expect(s.rows.map((r) => r.seq)).toEqual([1n, 2n, 3n]);
  });

  test("dedupes on record_id", async () => {
    const s = new MemoryJournalStore();
    const rec = order();
    await s.insertBatch([rec]);
    await s.insertBatch([rec, rec]);
    expect(s.rows).toHaveLength(1);
  });

  test("scopes by account and session, orders kind filter, and limit", async () => {
    const s = new MemoryJournalStore();
    await s.insertBatch([
      order({ account_id: "a", session_id: "s1" }),
      order({ account_id: "a", session_id: "s2" }),
      order({ account_id: "b", session_id: "s1" }),
      fill(),
    ]);
    expect(await s.listOrders({ account: "a", session: "all", limit: 10 })).toHaveLength(2);
    expect(await s.listOrders({ account: "a", session: "s1", limit: 10 })).toHaveLength(1);
    expect(await s.listJournal({ account: "guest", session: "all", limit: 10 })).toHaveLength(1);
    expect(await s.listOrders({ account: "a", session: "all", limit: 1 })).toHaveLength(1);
  });

  test("failNext fails without effect, then recovers", async () => {
    const s = new MemoryJournalStore();
    s.inject({ failNext: 1 });
    await expect(s.insertBatch([order()])).rejects.toBeInstanceOf(InjectedFault);
    expect(s.rows).toHaveLength(0);
    await s.insertBatch([order()]);
    expect(s.rows).toHaveLength(1);
  });

  test("commitThenThrow keeps the commit, so a retry dedupes", async () => {
    const s = new MemoryJournalStore();
    s.inject({ commitThenThrow: 1 });
    const rec = order();
    await expect(s.insertBatch([rec])).rejects.toBeInstanceOf(InjectedFault);
    expect(s.rows).toHaveLength(1);
    await s.insertBatch([rec]);
    expect(s.rows).toHaveLength(1);
  });
});
