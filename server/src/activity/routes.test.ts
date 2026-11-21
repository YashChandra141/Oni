import { describe, expect, test } from "bun:test";
import type { TokenVerifier } from "../auth/bearer.ts";
import type { AccountId } from "../protocol.ts";
import { ActivityLog } from "./log.ts";
import { activityRoutes } from "./routes.ts";

const WALLET = "w_Wallet1" as AccountId;

const auth: TokenVerifier = {
  async verify(token) {
    if (token === "good") {
      return { ok: true, claims: { address: "Wallet1", accountId: WALLET, jti: "j", iat: 0, exp: 9_999_999_999 } };
    }
    return { ok: false, reason: "bad_mac" };
  },
};

function setup() {
  const log = new ActivityLog();
  const base = {
    kind: "order",
    orderId: "o1",
    venue: "coinbase",
    symbol: "BTC-USD",
    side: "buy",
    qty: 5n,
    orderKind: "limit",
    price: 100n,
    source: "web",
    ts: 1,
  } as const;
  log.append({ ...base, accountId: "guest" as AccountId, orderId: "g1" });
  log.append({ ...base, accountId: WALLET, orderId: "w1" });
  log.append({
    kind: "rejection",
    accountId: WALLET,
    orderId: "w2",
    reason: "kill_switch",
    symbol: null,
    side: null,
    qty: null,
    orderKind: null,
    price: null,
    source: null,
    ts: 2,
  });
  const positions = {
    positions: (id: AccountId) =>
      id === WALLET
        ? [{ symbol: "BTC-USD", qty: 3n, avgEntry: 100n, realized: 0n, unrealized: 1n }]
        : [],
  };
  return activityRoutes({ log, positions, auth });
}

const get = (app: ReturnType<typeof setup>, path: string, token?: string) =>
  app.request(path, token === undefined ? {} : { headers: { Authorization: `Bearer ${token}` } });

describe("activityRoutes", () => {
  test("no header is the guest account", async () => {
    const res = await get(setup(), "/orders");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>[];
    expect(body.map((r) => r.order_id)).toEqual(["g1"]);
    expect(body[0]).toMatchObject({ type: "order", seq: "1", qty: "5", price: "100" });
  });

  test("bearer token scopes to the wallet account", async () => {
    const app = setup();
    const journal = (await (await get(app, "/journal?session=all", "good")).json()) as Record<string, unknown>[];
    expect(journal.map((r) => r.type)).toEqual(["rejection", "order"]);
    const pos = (await (await get(app, "/positions", "good")).json()) as Record<string, unknown>[];
    expect(pos[0]).toMatchObject({ symbol: "BTC-USD", qty: "3" });
    expect(await (await get(app, "/positions")).json()).toEqual([]);
  });

  test("bad token gives 401", async () => {
    for (const path of ["/orders", "/journal", "/positions"]) {
      expect((await get(setup(), path, "nope")).status).toBe(401);
    }
  });

  test("bad limit or session gives 400", async () => {
    const app = setup();
    for (const q of ["limit=0", "limit=1001", "limit=abc", "limit=1.5", "session=old"]) {
      expect((await get(app, `/orders?${q}`)).status).toBe(400);
    }
    expect((await get(app, "/orders?limit=1000")).status).toBe(200);
  });
});
