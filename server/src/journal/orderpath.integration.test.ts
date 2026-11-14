// Order-path integration (Task 11.5; Req 19.7, 20.1, 20.2, 20.3, 20.8, 20.9, 41.7): the real
// Router, Risk_Engine, AccountState, Journal_Queue, and journal REST routes wired by `createApp`,
// with a fake engine sender and a fake supervisor that stands in for the engine's stdout.
//   order -> fill -> journal records   (memory store always, Postgres when TEST_DATABASE_URL is set)
//   oversized order -> rejected with a reason -> rejection record
//   orders keep filling while the store fails (fault injection), and the records arrive after it recovers
// The Postgres run expects the Migrations already applied and refuses to run when
// TEST_DATABASE_URL equals DATABASE_URL or DIRECT_URL.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../config.ts";
import type { OrderCommand } from "../engine/supervisor.ts";
import { FakeSupervisor } from "../gateway/testing.ts";
import { createApp } from "../main.ts";
import { type OrderOrigin, type RouterSender, type SubmitOrder } from "../router.ts";
import { classifyPrismaError } from "./classify.ts";
import { MemoryJournalStore } from "./memory.ts";
import { type PgHarness, openPgHarness, pgEnabled } from "./pg.testing.ts";
import { JournalQueue } from "./queue.ts";
import type { JournalRow, JournalStore } from "./store.ts";

const START_MS = 1_700_000_000_000;
const GUEST_ORIGIN: OrderOrigin = {
  connectionId: "c1",
  session: { accountId: "guest", address: null, jti: null, exp: null },
  source: "web",
};
const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const sleepBriefly = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 2));

/** 0.1 BTC limit buy at $64,000.00 (6,400,000 ticks, 10,000,000 lots). */
const SMALL: SubmitOrder = { symbol: "BTC-USD", side: "buy", qty: 10_000_000n, kind: { type: "limit", price: 6_400_000n } };
/** 5 BTC at $64,000.00 = $320,000, above the $250,000 maximum order value. */
const OVERSIZED: SubmitOrder = { symbol: "BTC-USD", side: "buy", qty: 500_000_000n, kind: { type: "limit", price: 6_400_000n } };

async function eventually(cond: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  return cond();
}

function wire(store: JournalStore, sessionId: string) {
  const result = loadConfig({ ALLOWED_ORIGINS: "http://localhost:3000" });
  if (!result.ok) throw result.error;
  const clock = { ms: START_MS };
  const supervisor = new FakeSupervisor();
  supervisor.sessionId = sessionId;
  const sent: OrderCommand[] = [];
  const sender: RouterSender = {
    send: (cmd) => {
      sent.push(cmd);
      return true;
    },
  };
  const queue = new JournalQueue({ store, classify: classifyPrismaError, logger: quiet, sleep: sleepBriefly, migrated: true });
  const app = createApp({
    config: result.config,
    supervisor,
    orderSender: sender,
    journalQueue: queue,
    journalStore: store,
    logger: quiet,
    now: () => clock.ms,
  });
  // A last trade price, so limit orders pass the price band.
  supervisor.emitEvent({ type: "trade", symbol: "BTC-USD", price: "6400000", qty: "1", side: "buy", ts: START_MS });
  expect(app.market.lastTrade("BTC-USD")).not.toBeNull();

  const fakeServer = { requestIP: () => null } as unknown as Parameters<typeof app.fetch>[1];
  const get = async (path: string): Promise<Response> => {
    const res = await app.fetch(new Request(`http://localhost${path}`), fakeServer);
    if (res === undefined) throw new Error("no response");
    return res;
  };
  const list = (): Promise<JournalRow[]> => store.listJournal({ account: "guest", session: sessionId, limit: 500 });
  const fill = (orderId: string, remaining = "0") => {
    clock.ms += 10;
    supervisor.emitEvent({ type: "order_ack", account_id: "guest", order_id: orderId, status: "accepted" });
    supervisor.emitEvent({
      type: "fill",
      account_id: "guest",
      order_id: orderId,
      symbol: "BTC-USD",
      side: "buy",
      price: "6400000",
      qty: "10000000",
      fee: "2560",
      remaining,
      ts: clock.ms - 3,
    });
  };
  return { app, queue, supervisor, sent, clock, get, list, fill };
}

/** The scenarios that hold for every store. */
function suite(name: string, open: () => Promise<{ store: JournalStore; sessionId: string }>): void {
  describe(`order path: ${name}`, () => {
    test("order -> fill -> journal records, scoped to the account and the engine run (Req 20.1, 20.2, 20.18)", async () => {
      const { store, sessionId } = await open();
      const w = wire(store, sessionId);
      const placed = w.app.router.submit(SMALL, GUEST_ORIGIN);
      expect(placed.ok).toBe(true);
      if (!placed.ok) return;
      expect(w.sent).toHaveLength(1);
      expect(w.sent[0]).toMatchObject({ type: "place_order", account_id: "guest", order_id: placed.orderId, qty: "10000000" });
      const orderTs = BigInt(START_MS);

      w.fill(placed.orderId);
      const fillTs = BigInt(w.clock.ms);

      expect(await eventually(async () => (await w.list()).length === 2)).toBe(true);
      const rows = await w.list();
      expect(rows[0]).toMatchObject({
        type: "order",
        session_id: sessionId,
        account_id: "guest",
        ts: orderTs,
        order_id: placed.orderId,
        source: "web",
        symbol: "BTC-USD",
        side: "buy",
        kind: "limit",
        qty: 10_000_000n,
        price: 6_400_000n,
      });
      expect(rows[1]).toMatchObject({
        type: "fill",
        session_id: sessionId,
        account_id: "guest",
        ts: fillTs,
        market_ts: fillTs - 3n,
        order_id: placed.orderId,
        symbol: "BTC-USD",
        side: "buy",
        price: 6_400_000n,
        qty: 10_000_000n,
        fee: 2_560n,
        remaining: 0n,
      });
      expect((rows[0]?.seq ?? 0n) < (rows[1]?.seq ?? 0n)).toBe(true);

      // The REST view shows the same two records, with bigint as decimal strings.
      const res = await w.get("/journal");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { type: string; qty: string; order_id: string }[];
      expect(body.map((r) => r.type)).toEqual(["order", "fill"]);
      expect(body.every((r) => r.order_id === placed.orderId && r.qty === "10000000")).toBe(true);
      const orders = (await (await w.get("/orders")).json()) as { type: string }[];
      expect(orders.map((r) => r.type)).toEqual(["order"]);
      await w.queue.flush(2_000);
    });

    test("an oversized order is rejected with a reason, never sent, and journaled (Req 19.7, 20.3)", async () => {
      const { store, sessionId } = await open();
      const w = wire(store, sessionId);
      const result = w.app.router.submit(OVERSIZED, GUEST_ORIGIN);
      expect(result).toMatchObject({ ok: false, reason: "max_order_value" });
      expect(w.sent).toEqual([]);

      expect(await eventually(async () => (await w.list()).length === 1)).toBe(true);
      const [row] = await w.list();
      expect(row).toMatchObject({
        type: "rejection",
        session_id: sessionId,
        account_id: "guest",
        order_id: result.orderId,
        source: "web",
        reason: "max_order_value",
      });
      await w.queue.flush(2_000);
    });

    test("an engine rejection is journaled with source engine (Req 20.3)", async () => {
      const { store, sessionId } = await open();
      const w = wire(store, sessionId);
      w.supervisor.emitEvent({ type: "order_rejected", account_id: "guest", order_id: "o_engine_1", reason: "account_limit" });
      expect(await eventually(async () => (await w.list()).length === 1)).toBe(true);
      expect((await w.list())[0]).toMatchObject({
        type: "rejection",
        account_id: "guest",
        order_id: "o_engine_1",
        source: "engine",
        reason: "account_limit",
      });
      await w.queue.flush(2_000);
    });
  });
}

// -------------------------------------------------------------------------------------------
// Memory store
// -------------------------------------------------------------------------------------------

suite("MemoryJournalStore", async () => ({ store: new MemoryJournalStore(), sessionId: "session-1" }));

describe("order path: orders keep filling while the store is failing (Req 20.8, 20.9)", () => {
  test("orders are accepted and fill with the store down; records are written once it recovers, in order", async () => {
    const store = new MemoryJournalStore();
    const w = wire(store, "session-fail");
    store.inject({ failNext: 1_000_000 });

    const first = w.app.router.submit(SMALL, GUEST_ORIGIN);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    w.fill(first.orderId);
    w.supervisor.emitEvent({ type: "position", account_id: "guest", symbol: "BTC-USD", qty: "10000000", avg_entry: "6400000", realized: "0", unrealized: "0" });

    // The writer notices the failure and reports the Journal down.
    expect(await eventually(() => w.queue.status() === "down", 5_000)).toBe(true);

    // Trading is unaffected: the second order is approved, sent, and filled.
    const second = w.app.router.submit(SMALL, GUEST_ORIGIN);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    w.fill(second.orderId);
    w.supervisor.emitEvent({ type: "position", account_id: "guest", symbol: "BTC-USD", qty: "20000000", avg_entry: "6400000", realized: "0", unrealized: "0" });

    expect(w.sent.map((c) => c.type)).toEqual(["place_order", "place_order"]);
    expect(w.app.accounts.positionLots("guest", "BTC-USD")).toBe(20_000_000n);
    expect(store.rows).toHaveLength(0);
    expect(w.queue.stats().queued).toBe(4);

    // The read endpoints say 503 while the Journal is down (Req 20.13).
    expect((await w.get("/orders")).status).toBe(503);
    expect((await w.get("/journal")).status).toBe(503);

    // The database recovers: every record is written once, in enqueue order.
    store.inject({});
    expect(await eventually(() => store.rows.length === 4, 5_000)).toBe(true);
    expect(store.rows.map((r) => r.type)).toEqual(["order", "fill", "order", "fill"]);
    expect(new Set(store.rows.map((r) => r.record_id)).size).toBe(4);
    expect(await eventually(() => w.queue.status() === "up", 5_000)).toBe(true);
    expect((await w.get("/journal")).status).toBe(200);
    await w.queue.flush(2_000);
  });

  test("a commit-then-throw store write is retried without duplicates", async () => {
    const store = new MemoryJournalStore();
    const w = wire(store, "session-commit");
    store.inject({ commitThenThrow: 2 });
    const placed = w.app.router.submit(SMALL, GUEST_ORIGIN);
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;
    w.fill(placed.orderId);
    expect(await eventually(() => w.queue.stats().queued === 0 && w.queue.status() === "up", 5_000)).toBe(true);
    expect(store.rows.map((r) => r.type)).toEqual(["order", "fill"]);
    await w.queue.flush(2_000);
  });
});

// -------------------------------------------------------------------------------------------
// Postgres (TEST_DATABASE_URL)
// -------------------------------------------------------------------------------------------

describe.skipIf(!pgEnabled)("order path on Postgres", () => {
  let pg: PgHarness | undefined;

  beforeAll(async () => {
    pg = await openPgHarness(); // throws when the URL equals DATABASE_URL or DIRECT_URL
  });
  beforeEach(async () => {
    await pg?.clear();
  });
  afterAll(async () => {
    await pg?.close();
  });

  suite("PrismaJournalStore", async () => {
    if (pg === undefined) throw new Error("Postgres harness is not open");
    return { store: pg.store, sessionId: `it-${crypto.randomUUID()}` };
  });
});
