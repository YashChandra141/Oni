// Router unit tests (Task 11.2): Req 15.5, 18.1, 18.2, 18.3, 18.5, 46.5, 19.7. The real
// Risk_Engine, AccountState, and MarketState are used; the sender, journal, clock, and gateway
// hooks are small recording fakes. `harness()` lives in router.testing.ts (shared with the
// Task 11.6 property tests).
import { describe, expect, test } from "bun:test";
import { OrderIdSchema } from "./protocol.ts";
import { resolveLimits } from "./risk/limits.ts";
import { type RouterRejectReason, type SubmitOrder, createOrderIdGenerator, marketPrices } from "./router.ts";
import { GUEST, START_MS, harness, limitBuy, originOf, walletSession } from "./router.testing.ts";
import type { RouterSession } from "./router.ts";
import { MarketState } from "./state/market.ts";

const conn = (id: string, session: RouterSession = GUEST) => originOf(id, session);

describe("submit: approval", () => {
  test("sends one PlaceOrder with the session account and exact wire shape, then journals and notes it", () => {
    const h = harness();
    const wallet = walletSession("Abc123");
    const result = h.router.submit(limitBuy(), conn("c1", wallet));

    expect(result).toEqual({ ok: true, orderId: "o_1_abc123" });
    expect(h.sent).toEqual([
      {
        type: "place_order",
        account_id: "w_Abc123",
        order_id: "o_1_abc123",
        symbol: "BTC-USD",
        side: "buy",
        qty: "10000000",
        kind: { type: "limit", price: "6400000" },
      },
    ]);
    expect(h.records).toEqual([
      {
        kind: "order",
        accountId: "w_Abc123",
        orderId: "o_1_abc123",
        symbol: "BTC-USD",
        side: "buy",
        qty: 10_000_000n,
        orderKind: "limit",
        price: 6_400_000n,
        source: "web",
        ts: START_MS,
      },
    ]);
    expect(h.pending.get("o_1_abc123")).toBe("c1");
    expect(h.rejected).toEqual([]);

    // noteOrder: when the engine acks, the cache row knows side, kind, and quantity.
    h.acceptOrder("w_Abc123", "o_1_abc123");
    expect(h.accounts.openOrders("w_Abc123")).toMatchObject([
      { orderId: "o_1_abc123", symbol: "BTC-USD", side: "buy", qty: 10_000_000n, kind: { type: "limit", price: "6400000" } },
    ]);
  });

  test("encodes market and stop orders", () => {
    const h = harness();
    h.router.submit({ symbol: "ETH-USD", side: "sell", qty: 100_000_000n, kind: { type: "market" } }, conn("c1"));
    h.router.submit({ symbol: "ETH-USD", side: "sell", qty: 100_000_000n, kind: { type: "stop", stopPrice: 310_000n } }, conn("c1"));
    expect(h.sent[0]).toMatchObject({ type: "place_order", account_id: "guest", kind: { type: "market" }, qty: "100000000" });
    expect(h.sent[1]).toMatchObject({ kind: { type: "stop", stop_price: "310000" } });
    expect(h.records.map((r) => r.kind === "order" && r.orderKind)).toEqual(["market", "stop"]);
  });

  test("records the source on the journal record", () => {
    const h = harness();
    h.router.submit(limitBuy(), originOf("c1", GUEST, "mcp"));
    expect(h.records[0]).toMatchObject({ kind: "order", source: "mcp" });
  });

  test("a throwing journal never blocks the order (Req 20.8)", () => {
    const h = harness();
    h.journal.throwOnEnqueue = true;
    expect(h.router.submit(limitBuy(), conn("c1")).ok).toBe(true);
    expect(h.sent).toHaveLength(1);
    expect(h.logs.some((l) => l.includes("journal enqueue failed"))).toBe(true);
  });
});

describe("submit: risk reasons (Req 18.2, 19.7)", () => {
  function expectRejected(
    h: ReturnType<typeof harness>,
    order: SubmitOrder,
    reason: RouterRejectReason,
    origin = conn("c1"),
  ): void {
    const result = h.router.submit(order, origin);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(reason);
    expect(h.sent).toEqual([]);
    expect(h.rejected).toEqual([
      {
        connectionId: origin.connectionId,
        event: { type: "order_rejected", account_id: origin.session.accountId, order_id: result.orderId, reason },
      },
    ]);
    expect(h.records).toMatchObject([
      { kind: "rejection", reason, accountId: origin.session.accountId, orderId: result.orderId, symbol: "BTC-USD", side: "buy", source: "web" },
    ]);
    expect(h.pending.size).toBe(0);
  }

  test("kill_switch", () => {
    expectRejected(harness({ killSwitch: true }), limitBuy(), "kill_switch");
  });

  test("rate_limit, and the window frees after a second", () => {
    const h = harness({ limits: resolveLimits({ rateLimitPerSecond: 2 }) });
    expect(h.router.submit(limitBuy(), conn("c1")).ok).toBe(true);
    expect(h.router.submit(limitBuy(), conn("c1")).ok).toBe(true);
    const third = h.router.submit(limitBuy(), conn("c1"));
    expect(third).toMatchObject({ ok: false, reason: "rate_limit" });
    expect(h.sent).toHaveLength(2);
    h.clock.ms += 1001;
    expect(h.router.submit(limitBuy(), conn("c1")).ok).toBe(true);
  });

  test("max_open_orders", () => {
    const h = harness({ limits: resolveLimits({ maxOpenOrders: 1 }) });
    h.acceptOrder("guest", "o_existing");
    expectRejected(h, limitBuy(), "max_open_orders");
  });

  test("price_band", () => {
    expectRejected(harness(), limitBuy(8_000_000n), "price_band");
  });

  test("max_order_value", () => {
    expectRejected(harness({ limits: resolveLimits({ maxOrderValue: "1000000000000" }) }), limitBuy(), "max_order_value");
  });

  test("max_position", () => {
    const h = harness();
    h.setPosition("guest", "BTC-USD", "500000000"); // 5 BTC, the default maximum
    expectRejected(h, limitBuy(), "max_position");
  });

  test("a rejected order still counts toward the rate window (an attempt counts)", () => {
    const h = harness({ limits: resolveLimits({ rateLimitPerSecond: 2 }) });
    h.router.submit(limitBuy(8_000_000n), conn("c1")); // price_band, recorded
    h.router.submit(limitBuy(8_000_000n), conn("c1")); // price_band, recorded
    expect(h.router.submit(limitBuy(), conn("c1"))).toMatchObject({ ok: false, reason: "rate_limit" });
  });
});

describe("submit: engine_unavailable (Req 15.5)", () => {
  test("is checked before the risk check and does not consume the rate window", () => {
    const h = harness({ running: false, killSwitch: true, limits: resolveLimits({ rateLimitPerSecond: 1 }) });
    expect(h.router.submit(limitBuy(), conn("c1"))).toMatchObject({ ok: false, reason: "engine_unavailable" });
    expect(h.sent).toEqual([]);
    expect(h.rejected[0]?.event.reason).toBe("engine_unavailable");
    expect(h.records[0]).toMatchObject({ kind: "rejection", reason: "engine_unavailable" });
    expect(h.router.trackedConnections).toBe(0);

    h.state.running = true;
    h.risk.killSwitch = false;
    expect(h.router.submit(limitBuy(), conn("c1")).ok).toBe(true); // window was untouched
  });

  test("a sender that reports false is engine_unavailable, with a rejection record and no order record", () => {
    const h = harness();
    h.state.accept = false;
    const result = h.router.submit(limitBuy(), conn("c1"));
    expect(result).toMatchObject({ ok: false, reason: "engine_unavailable" });
    expect(h.records.map((r) => r.kind)).toEqual(["rejection"]);
    expect(h.pending.size).toBe(0);
    expect(h.rejected).toHaveLength(1);
  });
});

describe("submit: expired session (Req 46.5)", () => {
  test("rejects session_expired, calls the downgrade hook, and sends nothing", () => {
    const h = harness();
    const expiredSession = walletSession("Abc123", START_MS / 1000); // exp == now (s)
    const result = h.router.submit(limitBuy(), conn("c9", expiredSession));
    expect(result).toMatchObject({ ok: false, reason: "session_expired" });
    expect(h.expired).toEqual(["c9"]);
    expect(h.sent).toEqual([]);
    expect(h.rejected[0]).toMatchObject({ connectionId: "c9", event: { account_id: "w_Abc123", reason: "session_expired" } });
  });

  test("is checked before engine_unavailable", () => {
    const h = harness({ running: false });
    const result = h.router.submit(limitBuy(), conn("c9", walletSession("Abc123", START_MS / 1000 - 1)));
    expect(result).toMatchObject({ ok: false, reason: "session_expired" });
  });

  test("a session one second before expiry still works, and the guest never expires", () => {
    const h = harness();
    expect(h.router.submit(limitBuy(), conn("c1", walletSession("Abc123", START_MS / 1000 + 1))).ok).toBe(true);
    expect(h.router.submit(limitBuy(), conn("c2", GUEST)).ok).toBe(true);
    expect(h.expired).toEqual([]);
  });
});

describe("submit: invalid orders", () => {
  const bad: [string, SubmitOrder][] = [
    ["unknown symbol", { ...limitBuy(), symbol: "DOGE-USD" }],
    ["short symbol", { ...limitBuy(), symbol: "BTC" }],
    ["zero qty", limitBuy(6_400_000n, 0n)],
    ["negative qty", limitBuy(6_400_000n, -1n)],
    ["qty above i64", limitBuy(6_400_000n, 2n ** 63n)],
    ["zero limit price", limitBuy(0n)],
    ["limit price above i64", limitBuy(2n ** 63n)],
    ["zero stop price", { ...limitBuy(), kind: { type: "stop", stopPrice: 0n } }],
    ["bad side", { ...limitBuy(), side: "hold" as unknown as "buy" }],
    ["bad kind", { ...limitBuy(), kind: { type: "iceberg" } as unknown as SubmitOrder["kind"] }],
    ["number qty", { ...limitBuy(), qty: 5 as unknown as bigint }],
  ];
  for (const [name, order] of bad) {
    test(name, () => {
      const h = harness();
      expect(h.router.submit(order, conn("c1"))).toMatchObject({ ok: false, reason: "invalid_order" });
      expect(h.sent).toEqual([]);
      expect(h.records[0]).toMatchObject({ kind: "rejection", reason: "invalid_order" });
    });
  }
});

describe("accounts and connections (Req 18.5, 19)", () => {
  test("guest and wallet commands carry their own account ids", () => {
    const h = harness();
    h.router.submit(limitBuy(), conn("c1", GUEST));
    h.router.submit(limitBuy(), conn("c2", walletSession("Wal1")));
    h.router.submit(limitBuy(), conn("c3", walletSession("Wal2")));
    expect(h.sent.map((c) => (c.type === "place_order" ? c.account_id : null))).toEqual(["guest", "w_Wal1", "w_Wal2"]);
  });

  test("risk uses the order's account: a wallet position does not limit the guest", () => {
    const h = harness();
    h.setPosition("w_Wal1", "BTC-USD", "500000000");
    expect(h.router.submit(limitBuy(), conn("c1", walletSession("Wal1")))).toMatchObject({ ok: false, reason: "max_position" });
    expect(h.router.submit(limitBuy(), conn("c2", GUEST)).ok).toBe(true);
  });

  test("two connections on one wallet share positions and open orders", () => {
    const h = harness({ limits: resolveLimits({ maxOpenOrders: 1 }) });
    const wallet = walletSession("Wal1");
    const first = h.router.submit(limitBuy(), conn("c1", wallet));
    expect(first.ok).toBe(true);
    h.acceptOrder("w_Wal1", first.orderId);
    expect(h.router.submit(limitBuy(), conn("c2", wallet))).toMatchObject({ ok: false, reason: "max_open_orders" });
  });

  test("two connections on one wallet have separate rate windows", () => {
    const h = harness({ limits: resolveLimits({ rateLimitPerSecond: 1 }) });
    const wallet = walletSession("Wal1");
    expect(h.router.submit(limitBuy(), conn("c1", wallet)).ok).toBe(true);
    expect(h.router.submit(limitBuy(), conn("c1", wallet))).toMatchObject({ ok: false, reason: "rate_limit" });
    expect(h.router.submit(limitBuy(), conn("c2", wallet)).ok).toBe(true);
    expect(h.router.trackedConnections).toBe(2);
    h.router.forgetConnection("c1");
    h.router.forgetConnection("c2");
    expect(h.router.trackedConnections).toBe(0);
  });

  test("account fields on a hostile request are ignored", () => {
    const h = harness();
    const hostile = {
      ...limitBuy(),
      account_id: "w_victim",
      accountId: "w_victim",
      kind: { type: "limit", price: 6_400_000n, account_id: "w_victim", accountId: "w_victim" },
    } as unknown as SubmitOrder;
    expect(h.router.submit(hostile, conn("c1", walletSession("Mine"))).ok).toBe(true);
    const command = h.sent[0];
    expect(command).toMatchObject({ type: "place_order", account_id: "w_Mine" });
    expect(JSON.stringify(command)).not.toContain("victim");
    expect(JSON.stringify(h.records, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain("victim");
  });
});

describe("order ids", () => {
  test("have the o_<base36>_<random> form and are valid OrderIds", () => {
    const next = createOrderIdGenerator();
    const ids = Array.from({ length: 200 }, () => next());
    expect(new Set(ids).size).toBe(200);
    for (const id of ids) {
      expect(id).toMatch(/^o_[0-9a-z]+_[0-9a-f]{12}$/);
      expect(OrderIdSchema.safeParse(id).success).toBe(true);
    }
    expect(ids[0]?.startsWith("o_1_")).toBe(true);
    expect(ids[34]?.startsWith("o_z_")).toBe(true); // counter 35 in base 36
    expect(ids[35]?.startsWith("o_10_")).toBe(true); // counter 36
  });

  test("every rejection carries an id", () => {
    const h = harness({ running: false });
    const a = h.router.submit(limitBuy(), conn("c1"));
    const b = h.router.submit(limitBuy(), conn("c1"));
    expect(a.orderId).toBe("o_1_abc123");
    expect(b.orderId).toBe("o_2_abc123");
  });
});

describe("cancel, cancel all, reset", () => {
  test("act on the session's account and send one command each", () => {
    const h = harness();
    const wallet = walletSession("Wal1");
    expect(h.router.cancel("o_1_abc123", conn("c1", wallet))).toEqual({ ok: true });
    expect(h.router.cancelAll(conn("c1", wallet))).toEqual({ ok: true });
    expect(h.router.resetAccount(conn("c1", GUEST))).toEqual({ ok: true });
    expect(h.sent).toEqual([
      { type: "cancel", account_id: "w_Wal1", order_id: "o_1_abc123" },
      { type: "cancel_all", account_id: "w_Wal1" },
      { type: "reset_account", account_id: "guest" },
    ]);
    // An engine rejection of the cancel is delivered to the requester.
    expect(h.pending.get("o_1_abc123")).toBe("c1");
  });

  test("are not blocked by the kill switch or the rate limit", () => {
    const h = harness({ killSwitch: true, limits: resolveLimits({ rateLimitPerSecond: 1 }) });
    for (let i = 0; i < 3; i += 1) {
      expect(h.router.cancel("o_1_abc123", conn("c1"))).toEqual({ ok: true });
      expect(h.router.cancelAll(conn("c1"))).toEqual({ ok: true });
      expect(h.router.resetAccount(conn("c1"))).toEqual({ ok: true });
    }
    expect(h.sent).toHaveLength(9);
    expect(h.router.trackedConnections).toBe(0);
  });

  test("are rejected with engine_unavailable while the engine is down, and when the sender fails", () => {
    const h = harness({ running: false });
    expect(h.router.cancel("o_1_abc123", conn("c1"))).toEqual({ ok: false, reason: "engine_unavailable" });
    expect(h.router.cancelAll(conn("c1"))).toEqual({ ok: false, reason: "engine_unavailable" });
    expect(h.router.resetAccount(conn("c1"))).toEqual({ ok: false, reason: "engine_unavailable" });
    expect(h.sent).toEqual([]);

    h.state.running = true;
    h.state.accept = false;
    expect(h.router.cancelAll(conn("c1"))).toEqual({ ok: false, reason: "engine_unavailable" });
    expect(h.pending.size).toBe(0);
  });

  test("an expired wallet session is session_expired and calls the downgrade hook", () => {
    const h = harness();
    const old = walletSession("Wal1", START_MS / 1000 - 5);
    expect(h.router.cancel("o_1_abc123", conn("c4", old))).toEqual({ ok: false, reason: "session_expired" });
    expect(h.router.cancelAll(conn("c4", old))).toEqual({ ok: false, reason: "session_expired" });
    expect(h.router.resetAccount(conn("c4", old))).toEqual({ ok: false, reason: "session_expired" });
    expect(h.expired).toEqual(["c4", "c4", "c4"]);
    expect(h.sent).toEqual([]);
  });

  test("cancel rejects a malformed order id", () => {
    const h = harness();
    expect(h.router.cancel("bad id!", conn("c1"))).toEqual({ ok: false, reason: "invalid_order" });
    expect(h.sent).toEqual([]);
  });
});

describe("flattenAll", () => {
  test("sends one opposite-side market order of |position| per non-flat symbol of the requester's account", () => {
    const h = harness();
    h.setPosition("w_Wal1", "BTC-USD", "200000000"); // long 2 BTC
    h.setPosition("w_Wal1", "ETH-USD", "-300000000"); // short 3 ETH
    h.setPosition("w_Wal2", "SOL-USD", "100000000"); // someone else's
    h.setPosition("guest", "BTC-USD", "100000000");

    const result = h.router.flattenAll(conn("c1", walletSession("Wal1")));
    expect(result.ok).toBe(true);
    expect(result.results.map((r) => r.symbol).sort()).toEqual(["BTC-USD", "ETH-USD"]);
    const placed = h.sent.flatMap((c) => (c.type === "place_order" ? [c] : []));
    expect(placed).toHaveLength(2);
    expect(placed.every((c) => c.account_id === "w_Wal1" && c.kind.type === "market")).toBe(true);
    const bySymbol = Object.fromEntries(placed.map((c) => [c.symbol, c]));
    expect(bySymbol["BTC-USD"]).toMatchObject({ side: "sell", qty: "200000000" });
    expect(bySymbol["ETH-USD"]).toMatchObject({ side: "buy", qty: "300000000" });
  });

  test("sends nothing and succeeds when the account is flat", () => {
    const h = harness();
    h.setPosition("guest", "BTC-USD", "100000000");
    h.setPosition("guest", "BTC-USD", "0");
    expect(h.router.flattenAll(conn("c1"))).toEqual({ ok: true, results: [] });
    expect(h.sent).toEqual([]);
  });

  test("the kill switch blocks the orders it would send", () => {
    const h = harness({ killSwitch: true });
    h.setPosition("guest", "BTC-USD", "100000000");
    const result = h.router.flattenAll(conn("c1"));
    expect(result).toMatchObject({ ok: false, reason: "kill_switch" });
    expect(h.sent).toEqual([]);
  });

  test("engine_unavailable and session_expired stop it before any order", () => {
    const h = harness({ running: false });
    h.setPosition("guest", "BTC-USD", "100000000");
    expect(h.router.flattenAll(conn("c1"))).toEqual({ ok: false, reason: "engine_unavailable", results: [] });
    h.state.running = true;
    const old = walletSession("Wal1", START_MS / 1000 - 1);
    h.setPosition("w_Wal1", "BTC-USD", "100000000");
    expect(h.router.flattenAll(conn("c5", old))).toEqual({ ok: false, reason: "session_expired", results: [] });
    expect(h.expired).toEqual(["c5"]);
    expect(h.sent).toEqual([]);
  });
});

describe("marketPrices", () => {
  test("reads last trade and best bid/ask as bigint ticks, null when unknown", () => {
    const market = new MarketState();
    const prices = marketPrices(market);
    expect(prices.lastPrice("BTC-USD")).toBeNull();
    expect(prices.bestBid("BTC-USD")).toBeNull();
    market.apply({ type: "trade", symbol: "BTC-USD", price: "6400000", qty: "1", side: "buy", ts: 1 });
    market.apply({
      type: "book",
      symbol: "BTC-USD",
      bids: [{ price: "6399900", qty: "5" }, { price: "6399800", qty: "5" }],
      asks: [{ price: "6400100", qty: "5" }],
      spread: "200",
      imbalance_bps: 0,
      ts: 2,
    });
    expect(prices.lastPrice("BTC-USD")).toBe(6_400_000n);
    expect(prices.bestBid("BTC-USD")).toBe(6_399_900n);
    expect(prices.bestAsk("BTC-USD")).toBe(6_400_100n);
    expect(prices.lastPrice("ETH-USD")).toBeNull();
  });
});
