import { describe, expect, test } from "bun:test";
import type { TokenVerifier } from "../auth/bearer.ts";
import { MemoryJournalStore } from "./memory.ts";
import { createJournalRoutes, parseJournalQuery } from "./routes.ts";
import type { JournalRecord } from "./store.ts";

let n = 0;
function order(account: string, session: string): JournalRecord {
  n += 1;
  return {
    type: "order",
    record_id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    session_id: session,
    account_id: account,
    ts: BigInt(n),
    order_id: `o${n}`,
    source: "web",
    symbol: "BTC-USD",
    side: "buy",
    kind: "market",
    qty: 1n,
    price: null,
  };
}

const tokens: TokenVerifier = {
  verify: async (token) =>
    token === "good"
      ? { ok: true, claims: { address: "ABC", accountId: "w_ABC", jti: "j", iat: 0, exp: 9_999_999_999 } }
      : { ok: false, reason: "bad_mac" },
};

async function setup(opts: { status?: "up" | "down"; store?: MemoryJournalStore; sessionId?: string | null } = {}) {
  const store = opts.store ?? new MemoryJournalStore();
  await store.insertBatch([order("guest", "s1"), order("w_ABC", "s1"), order("w_ABC", "s0"), order("w_ABC", "s1")]);
  let down = 0;
  const app = createJournalRoutes({
    tokens,
    store,
    status: () => opts.status ?? "up",
    markUnreachable: () => void (down += 1),
    sessionId: () => (opts.sessionId === undefined ? "s1" : opts.sessionId),
    accounts: { positions: () => [{ symbol: "BTC-USD", qty: 5n, avgEntry: 100n, realized: 0n, unrealized: -3n }] },
    market: { quote: () => null, candles: () => null },
    queryTimeoutMs: 50,
  });
  return { app, store, downCount: () => down };
}

describe("parseJournalQuery", () => {
  test("accepts omitted params with the default limit 500", () => {
    expect(parseJournalQuery({})).toEqual({ ok: true, session: undefined, limit: 500 });
  });
  test("accepts session=all and limit 1 and 5000", () => {
    expect(parseJournalQuery({ session: "all", limit: "5000" })).toEqual({ ok: true, session: "all", limit: 5000 });
    expect(parseJournalQuery({ limit: "1" })).toMatchObject({ ok: true, limit: 1 });
  });
  test("rejects other sessions and bad limits", () => {
    for (const q of [{ session: "s1" }, { limit: "0" }, { limit: "5001" }, { limit: "1.5" }, { limit: "-1" }, { limit: "abc" }, { limit: "" }]) {
      expect(parseJournalQuery(q).ok).toBe(false);
    }
  });
});

describe("journal routes", () => {
  test("guest sees only its own current-session orders, with bigint as strings", async () => {
    const { app } = await setup();
    const res = await app.request("/orders");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { account_id: string; qty: string; ts: string }[];
    expect(body).toHaveLength(1);
    expect(body[0]?.account_id).toBe("guest");
    expect(body[0]?.qty).toBe("1");
    expect(typeof body[0]?.ts).toBe("string");
  });

  test("a valid bearer scopes to the wallet account; session=all widens to all sessions", async () => {
    const { app } = await setup();
    const headers = { authorization: "Bearer good" };
    expect(((await (await app.request("/orders", { headers })).json()) as unknown[]).length).toBe(2);
    expect(((await (await app.request("/journal?session=all", { headers })).json()) as unknown[]).length).toBe(3);
    expect(((await (await app.request("/orders?limit=1", { headers })).json()) as unknown[]).length).toBe(1);
  });

  test("a bad token is 401 before query validation", async () => {
    const { app } = await setup();
    const res = await app.request("/orders?limit=abc", { headers: { authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
  });

  test("bad session or limit is 400", async () => {
    const { app } = await setup();
    expect((await app.request("/journal?session=s1")).status).toBe(400);
    expect((await app.request("/orders?limit=5001")).status).toBe(400);
  });

  test("503 journal_unavailable while down, without querying the store", async () => {
    const { app, store } = await setup({ status: "down" });
    const res = await app.request("/orders");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "journal_unavailable" });
    expect(store.calls.listOrders).toBe(0);
  });

  test("503 and markUnreachable when the query fails", async () => {
    const store = new MemoryJournalStore();
    const { app, downCount } = await setup({ store });
    store.inject({ failNext: 1 });
    expect((await app.request("/journal")).status).toBe(503);
    expect(downCount()).toBe(1);
  });

  test("503 when the query takes longer than the limit", async () => {
    const store = new MemoryJournalStore();
    store.listOrders = () => new Promise(() => {});
    const { app, downCount } = await setup({ store });
    expect((await app.request("/orders")).status).toBe(503);
    expect(downCount()).toBe(1);
  });

  test("/positions is bearer-scoped and serializes bigint as strings", async () => {
    const { app } = await setup();
    const res = await app.request("/positions");
    expect(await res.json()).toEqual([{ symbol: "BTC-USD", qty: "5", avg_entry: "100", realized: "0", unrealized: "-3" }]);
    expect((await app.request("/positions", { headers: { authorization: "Bearer nope" } })).status).toBe(401);
  });
});
