// REST behaviour around the Journal (Task 11.5; Req 16.4, 17.5, 17.8, 20.13, 20.14, 20.19-20.21,
// 20.24-20.26): /health never touches the store; /orders and /journal honour the default and
// maximum limit and answer 400 and 503 as specified; connection strings and their passwords stay
// out of logs and responses. routes.test.ts covers the per-route scoping and the 401 path.
import { describe, expect, test } from "bun:test";
import type { TokenVerifier } from "../auth/bearer.ts";
import { redactSecrets } from "../config.ts";
import { createHttpApp } from "../http.ts";
import { MemoryJournalStore } from "./memory.ts";
import { JournalQueue } from "./queue.ts";
import { createJournalRoutes } from "./routes.ts";
import type { JournalRecord, JournalRow, JournalStore, ListQuery } from "./store.ts";

const DATABASE_URL = "postgresql://u:fakepw@db.example.neon.tech/x";
const DIRECT_URL = "postgresql://d:fakepw2@db.example.neon.tech/y";
const SOURCE = { openaiApiKey: undefined, databaseUrl: DATABASE_URL, directUrl: DIRECT_URL, sessionSecret: undefined } as const;

const tokens: TokenVerifier = { verify: async () => ({ ok: false, reason: "malformed" }) };

function order(i: number, account = "guest", session = "s1"): JournalRecord {
  return {
    type: "order",
    record_id: `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`,
    session_id: session,
    account_id: account,
    ts: BigInt(i),
    order_id: `o${i}`,
    source: "web",
    symbol: "BTC-USD",
    side: "buy",
    kind: "market",
    qty: 1n,
    price: null,
  };
}

/** A store that counts every call and can be told to fail. */
class SpyStore implements JournalStore {
  readonly calls: string[] = [];
  readonly queries: ListQuery[] = [];
  failWith: Error | null = null;
  async insertBatch(): Promise<void> {
    this.calls.push("insertBatch");
  }
  async listOrders(q: ListQuery): Promise<never[]> {
    this.calls.push("listOrders");
    this.queries.push(q);
    if (this.failWith !== null) throw this.failWith;
    return [];
  }
  async listJournal(q: ListQuery): Promise<JournalRow[]> {
    this.calls.push("listJournal");
    this.queries.push(q);
    if (this.failWith !== null) throw this.failWith;
    return [];
  }
  async ping(): Promise<void> {
    this.calls.push("ping");
  }
  async close(): Promise<void> {
    this.calls.push("close");
  }
}

function build(store: Pick<JournalStore, "listOrders" | "listJournal">, status: { value: "up" | "down" }, marked: { n: number }) {
  const routes = createJournalRoutes({
    tokens,
    store,
    status: () => status.value,
    markUnreachable: () => void (marked.n += 1),
    sessionId: () => "s1",
    accounts: { positions: () => [] },
    market: { quote: () => null, candles: () => null },
    queryTimeoutMs: 50,
  });
  return createHttpApp({ engine: { running: true, sessionId: "s1" }, journalStatus: () => status.value, state: routes });
}

describe("/health (Req 17.5, 17.8)", () => {
  test("reports db up or down from memory and never calls the store", async () => {
    const store = new SpyStore();
    const status = { value: "up" as "up" | "down" };
    const app = build(store, status, { n: 0 });
    for (let i = 0; i < 3; i += 1) {
      expect(await (await app.request("/health")).json()).toMatchObject({ ok: true, db: "up" });
    }
    status.value = "down";
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ db: "down" });
    expect(store.calls).toEqual([]);
  });

  test("a real queue reports its own status without probing the store", async () => {
    const store = new SpyStore();
    const queue = new JournalQueue({ store, classify: () => "unreachable", logger: { info() {}, warn() {}, error() {} }, migrated: false });
    const app = createHttpApp({ engine: { running: true, sessionId: null }, journalStatus: () => queue.status() });
    expect(await (await app.request("/health")).json()).toMatchObject({ db: "down" });
    queue.setMigrated(true);
    expect(await (await app.request("/health")).json()).toMatchObject({ db: "up" });
    await queue.flush(100);
    // setMigrated(true) with an empty queue does not write; /health did not either.
    expect(store.calls.filter((c) => c !== "ping")).toEqual([]);
  });
});

describe("/orders and /journal limits (Req 20.24-20.26)", () => {
  test("the default limit is 500 and the largest allowed limit is 5000", async () => {
    const store = new SpyStore();
    const app = build(store, { value: "up" }, { n: 0 });
    for (const path of ["/orders", "/journal"]) {
      expect((await app.request(path)).status).toBe(200);
      expect((await app.request(`${path}?limit=5000`)).status).toBe(200);
      expect((await app.request(`${path}?limit=1`)).status).toBe(200);
    }
    expect(store.queries.map((q) => q.limit)).toEqual([500, 5000, 1, 500, 5000, 1]);
    expect(store.queries.every((q) => q.account === "guest" && q.session === "s1")).toBe(true);
  });

  test("session=all passes through as every session", async () => {
    const store = new SpyStore();
    const app = build(store, { value: "up" }, { n: 0 });
    await app.request("/orders?session=all");
    expect(store.queries[0]?.session).toBe("all");
  });

  test("a real store returns the most recent 500 by default and 5000 at most, oldest first", async () => {
    const store = new MemoryJournalStore();
    const records: JournalRecord[] = [];
    for (let i = 1; i <= 5_100; i += 1) records.push(order(i));
    await store.insertBatch(records);
    const app = build(store, { value: "up" }, { n: 0 });

    const dflt = (await (await app.request("/orders")).json()) as { ts: string }[];
    expect(dflt).toHaveLength(500);
    expect(dflt[0]?.ts).toBe("4601");
    expect(dflt.at(-1)?.ts).toBe("5100");

    const max = (await (await app.request("/journal?limit=5000")).json()) as { ts: string }[];
    expect(max).toHaveLength(5_000);
    expect(max[0]?.ts).toBe("101");
    expect(max.at(-1)?.ts).toBe("5100");
  });

  test("400 for a bad session or a bad limit, with no store call, even while the Journal is down", async () => {
    const store = new SpyStore();
    const status = { value: "up" as "up" | "down" };
    const app = build(store, status, { n: 0 });
    const bad = ["session=s1", "session=", "session=ALL", "limit=0", "limit=5001", "limit=-1", "limit=1.5", "limit=1e3", "limit=abc", "limit=", "limit=000001"];
    for (const query of bad) {
      for (const path of ["/orders", "/journal"]) {
        const res = await app.request(`${path}?${query}`);
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toBe("invalid_query");
      }
    }
    status.value = "down";
    expect((await app.request("/orders?limit=0")).status).toBe(400);
    expect(store.calls).toEqual([]);
  });
});

describe("503 journal_unavailable (Req 20.13, 20.14)", () => {
  test("503 while the status is down, without a store call and without marking again", async () => {
    const store = new SpyStore();
    const marked = { n: 0 };
    const app = build(store, { value: "down" }, marked);
    for (const path of ["/orders", "/journal", "/orders?session=all&limit=10"]) {
      const res = await app.request(path);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "journal_unavailable" });
    }
    expect(store.calls).toEqual([]);
    expect(marked.n).toBe(0);
  });

  test("503 and a down mark when the query fails", async () => {
    const store = new SpyStore();
    store.failWith = new Error("connect ECONNREFUSED");
    const marked = { n: 0 };
    const app = build(store, { value: "up" }, marked);
    expect((await app.request("/orders")).status).toBe(503);
    expect((await app.request("/journal")).status).toBe(503);
    expect(marked.n).toBe(2);
  });

  test("503 and a down mark when the query is slower than the limit", async () => {
    const store = new SpyStore();
    store.listJournal = () => new Promise<JournalRow[]>(() => {});
    const marked = { n: 0 };
    const app = build(store, { value: "up" }, marked);
    expect((await app.request("/journal")).status).toBe(503);
    expect(marked.n).toBe(1);
  });
});

describe("secrets stay out of logs and responses (Req 16.4)", () => {
  const SECRETS = [DATABASE_URL, DIRECT_URL, "fakepw", "fakepw2"];
  const clean = (text: string): void => {
    for (const secret of SECRETS) expect(text).not.toContain(secret);
  };

  test("a failing query that quotes the connection string gives a plain 503", async () => {
    const store = new SpyStore();
    store.failWith = new Error(`getaddrinfo failed for ${DATABASE_URL} (password fakepw)`);
    const app = build(store, { value: "up" }, { n: 0 });
    for (const path of ["/orders", "/journal"]) {
      const res = await app.request(path);
      expect(res.status).toBe(503);
      clean(await res.text());
    }
  });

  test("the writer's log lines are free of the URLs and passwords, even when the error name quotes them", async () => {
    class LeakyStore extends MemoryJournalStore {
      override async insertBatch(): Promise<void> {
        throw Object.assign(new Error(`cannot connect to ${DATABASE_URL}`), { name: `Err(${DIRECT_URL})`, code: "P1001" });
      }
    }
    const lines: string[] = [];
    const push = (line: string): void => void lines.push(line);
    const queue = new JournalQueue({
      store: new LeakyStore(),
      classify: () => "unreachable",
      logger: { info: push, warn: push, error: push },
      redact: (text) => redactSecrets(text, SOURCE),
      sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 1)),
      migrated: true,
    });
    queue.enqueue(order(1));
    for (let i = 0; i < 50 && lines.length === 0; i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 2));
    await queue.flush(20);
    expect(lines.length).toBeGreaterThan(0);
    clean(lines.join("\n"));
    expect(lines.some((l) => l.includes("[redacted]"))).toBe(true);
    expect(queue.status()).toBe("down");
  });

  test("the 400 and 401 bodies carry no connection details", async () => {
    const store = new SpyStore();
    const app = build(store, { value: "up" }, { n: 0 });
    clean(await (await app.request("/orders?limit=abc")).text());
    clean(await (await app.request("/orders", { headers: { authorization: `Bearer ${DATABASE_URL}` } })).text());
    clean(await (await app.request("/health")).text());
  });
});
