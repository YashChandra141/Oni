// Bearer handling on /positions, /orders, and /journal with the real TokenService (Task 11.5;
// Req 20.28, 20.29, 20.30): no header is the guest, a valid token is the wallet account, and an
// invalid, expired, or denylisted token is 401 before query validation. The fake verifier in
// routes.test.ts does not cover expiry or the denylist.
import { describe, expect, test } from "bun:test";
import { encodeBase58 } from "../../../shared/base58.ts";
import { TOKEN_TTL_SEC, TokenService } from "../auth/token.ts";
import { AccountState } from "../state/account.ts";
import { MemoryJournalStore } from "./memory.ts";
import { createJournalRoutes } from "./routes.ts";
import type { JournalRecord } from "./store.ts";

const START_MS = 1_700_000_000_000;
const ADDRESS = encodeBase58(new Uint8Array(32).fill(7));
const WALLET = `w_${ADDRESS}`;
const SECRET = "t".repeat(32);

function order(i: number, account: string): JournalRecord {
  return {
    type: "order",
    record_id: `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`,
    session_id: "s1",
    account_id: account,
    ts: BigInt(i),
    order_id: `o${i}`,
    source: "web",
    symbol: "BTC-USD",
    side: "buy",
    kind: "market",
    qty: BigInt(i),
    price: null,
  };
}

async function setup() {
  const clock = { ms: START_MS };
  const tokens = new TokenService({ secret: SECRET, now: () => clock.ms });
  const store = new MemoryJournalStore();
  await store.insertBatch([order(1, "guest"), order(2, WALLET), order(3, "w_OtherWallet"), order(4, WALLET)]);
  const accounts = new AccountState();
  accounts.apply({ type: "position", account_id: "guest", symbol: "BTC-USD", qty: "1", avg_entry: "100", realized: "0", unrealized: "0" });
  accounts.apply({ type: "position", account_id: WALLET, symbol: "ETH-USD", qty: "-2", avg_entry: "50", realized: "7", unrealized: "-1" });
  const app = createJournalRoutes({
    tokens,
    store,
    status: () => "up",
    markUnreachable: () => {},
    sessionId: () => "s1",
    accounts,
    market: { quote: () => null, candles: () => null },
  });
  const issue = (): Promise<string> => tokens.issue(ADDRESS);
  return { app, tokens, clock, issue, store };
}

const auth = (token: string): { headers: Record<string, string> } => ({ headers: { authorization: `Bearer ${token}` } });

async function ids(res: Response): Promise<string[]> {
  const body = (await res.json()) as { order_id: string }[];
  return body.map((r) => r.order_id);
}

describe("journal routes with real session tokens", () => {
  test("no Authorization header is the guest account", async () => {
    const { app } = await setup();
    expect(await ids(await app.request("/orders"))).toEqual(["o1"]);
    expect(await ids(await app.request("/journal"))).toEqual(["o1"]);
    const positions = (await (await app.request("/positions")).json()) as { symbol: string }[];
    expect(positions.map((p) => p.symbol)).toEqual(["BTC-USD"]);
  });

  test("a valid token is the wallet account and sees only its own records", async () => {
    const { app, issue } = await setup();
    const token = await issue();
    expect(await ids(await app.request("/orders", auth(token)))).toEqual(["o2", "o4"]);
    expect(await ids(await app.request("/journal", auth(token)))).toEqual(["o2", "o4"]);
    const res = await app.request("/positions", auth(token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ symbol: "ETH-USD", qty: "-2", avg_entry: "50", realized: "7", unrealized: "-1" }]);
  });

  test("a client-supplied account field does not change the account", async () => {
    const { app } = await setup();
    expect(await ids(await app.request(`/orders?account_id=${WALLET}`))).toEqual(["o1"]);
  });

  test("invalid tokens are 401 on every route, even with a bad query", async () => {
    const { app, issue } = await setup();
    const good = await issue();
    const tampered = `${good.slice(0, -2)}${good.endsWith("AA") ? "BB" : "AA"}`;
    const headers: Record<string, string>[] = [
      { authorization: "Bearer not-a-token" },
      { authorization: `Bearer ${tampered}` },
      { authorization: `Basic ${good}` },
      { authorization: `bearer ${good}` },
      { authorization: "Bearer" },
      { authorization: "Bearer " },
      { authorization: "" },
    ];
    for (const h of headers) {
      for (const path of ["/positions", "/orders", "/journal", "/orders?limit=abc", "/journal?session=zzz"]) {
        const res = await app.request(path, { headers: h });
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: "unauthorized" });
      }
    }
  });

  test("an expired token is 401", async () => {
    const { app, issue, clock } = await setup();
    const token = await issue();
    expect((await app.request("/orders", auth(token))).status).toBe(200);
    clock.ms += (TOKEN_TTL_SEC + 1) * 1000;
    for (const path of ["/positions", "/orders", "/journal"]) {
      expect((await app.request(path, auth(token))).status).toBe(401);
    }
  });

  test("a denylisted (signed-out) token is 401", async () => {
    const { app, issue, tokens } = await setup();
    const token = await issue();
    const verdict = await tokens.verify(token);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    tokens.deny(verdict.claims);
    for (const path of ["/positions", "/orders", "/journal"]) {
      expect((await app.request(path, auth(token))).status).toBe(401);
    }
    // The guest account stays available without a header.
    expect((await app.request("/orders")).status).toBe(200);
  });

  test("a 401 body never echoes the token", async () => {
    const { app } = await setup();
    const res = await app.request("/orders", auth("secret-looking-token-value"));
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain("secret-looking-token-value");
  });
});
