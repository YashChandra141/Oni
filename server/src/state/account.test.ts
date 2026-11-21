import { describe, expect, test } from "bun:test";
import type { Event } from "../protocol.ts";
import { AccountState } from "./account.ts";

type Ev<T extends Event["type"]> = Extract<Event, { type: T }>;

const ack = (account_id: string, order_id: string, status: Ev<"order_ack">["status"]): Event => ({
  type: "order_ack",
  account_id,
  venue: "replay",
  order_id,
  status,
});
const rejected = (account_id: string, order_id: string): Event => ({
  type: "order_rejected",
  account_id,
  venue: "replay",
  order_id,
  reason: "unknown_order",
});
const fill = (account_id: string, order_id: string, qty: string, remaining: string): Event => ({
  type: "fill",
  account_id,
  venue: "replay",
  order_id,
  symbol: "BTC-USD",
  side: "buy",
  price: "6400000",
  qty,
  fee: "10",
  remaining,
  ts: 1,
});
const position = (account_id: string, symbol: string, qty: string): Event => ({
  type: "position",
  account_id,
  symbol,
  qty,
  avg_entry: qty === "0" ? null : "6400000",
  realized: "5",
  unrealized: "-3",
});

describe("positions", () => {
  test("each Position event replaces the entry", () => {
    const s = new AccountState();
    s.apply(position("guest", "BTC-USD", "100"));
    s.apply(position("guest", "BTC-USD", "250"));
    expect(s.positionLots("guest", "BTC-USD")).toBe(250n);
    expect(s.positions("guest")).toEqual([
      { symbol: "BTC-USD", qty: 250n, avgEntry: 6400000n, realized: 5n, unrealized: -3n },
    ]);
  });

  test("a flat position is removed; unknown accounts and symbols read as 0", () => {
    const s = new AccountState();
    s.apply(position("guest", "BTC-USD", "-40"));
    expect(s.positionLots("guest", "BTC-USD")).toBe(-40n);
    s.apply(position("guest", "BTC-USD", "0"));
    expect(s.positions("guest")).toEqual([]);
    expect(s.positionLots("guest", "BTC-USD")).toBe(0n);
    expect(s.positionLots("nobody", "ETH-USD")).toBe(0n);
    expect(s.size).toBe(0);
  });
});

describe("open orders", () => {
  test("accepted, partial fill, then filled", () => {
    const s = new AccountState();
    s.noteOrder("guest", "o1", { symbol: "BTC-USD", side: "buy", kind: { type: "limit", price: "6400000" }, qty: 10n });
    s.apply(ack("guest", "o1", "accepted"));
    expect(s.openOrderCount("guest")).toBe(1);
    expect(s.openOrders("guest")).toEqual([
      {
        orderId: "o1",
        symbol: "BTC-USD",
        side: "buy",
        kind: { type: "limit", price: "6400000" },
        qty: 10n,
        filled: 0n,
        remaining: 10n,
      },
    ]);
    s.apply(fill("guest", "o1", "4", "6"));
    s.apply(fill("guest", "o1", "2", "4"));
    expect(s.openOrders("guest")[0]).toMatchObject({ filled: 6n, remaining: 4n });
    s.apply(ack("guest", "o1", "filled"));
    expect(s.openOrderCount("guest")).toBe(0);
    expect(s.openOrders("guest")).toEqual([]);
  });

  test("without a note the fill fills in symbol, side, and quantity", () => {
    const s = new AccountState();
    s.apply(ack("guest", "o1", "accepted"));
    s.apply(fill("guest", "o1", "4", "6"));
    expect(s.openOrders("guest")[0]).toMatchObject({
      symbol: "BTC-USD",
      side: "buy",
      qty: 10n,
      filled: 4n,
      remaining: 6n,
    });
  });

  test("canceled removes the order; rows keep acceptance order", () => {
    const s = new AccountState();
    for (const id of ["c", "a", "b"]) s.apply(ack("guest", id, "accepted"));
    expect(s.openOrders("guest").map((o) => o.orderId)).toEqual(["c", "a", "b"]);
    s.apply(ack("guest", "a", "canceled"));
    expect(s.openOrders("guest").map((o) => o.orderId)).toEqual(["c", "b"]);
    expect(s.openOrderCount("guest")).toBe(2);
  });

  test("OrderRejected leaves an open order alone and drops the note of a never-opened order", () => {
    const s = new AccountState();
    s.apply(ack("guest", "o1", "accepted"));
    s.apply(rejected("guest", "o1"));
    expect(s.openOrderCount("guest")).toBe(1);

    s.noteOrder("guest", "o2", { symbol: "BTC-USD", side: "sell", kind: { type: "market" }, qty: 1n });
    s.apply(rejected("guest", "o2"));
    s.apply(ack("guest", "o2", "accepted"));
    expect(s.openOrders("guest").find((o) => o.orderId === "o2")?.side).toBeNull();
  });

  test("a fill for an unknown order is ignored", () => {
    const s = new AccountState();
    s.apply(fill("guest", "ghost", "1", "0"));
    expect(s.openOrderCount("guest")).toBe(0);
    expect(s.size).toBe(0);
  });
});

describe("accounts", () => {
  test("counts and positions are per account", () => {
    const s = new AccountState();
    s.apply(ack("guest", "o1", "accepted"));
    s.apply(ack("w_abc", "o1", "accepted"));
    s.apply(ack("w_abc", "o2", "accepted"));
    s.apply(position("w_abc", "ETH-USD", "7"));
    expect(s.openOrderCount("guest")).toBe(1);
    expect(s.openOrderCount("w_abc")).toBe(2);
    expect(s.positionLots("guest", "ETH-USD")).toBe(0n);
    expect(s.positionLots("w_abc", "ETH-USD")).toBe(7n);
    // Another account's cancel ack for the same id does not touch guest.
    s.apply(ack("w_abc", "o1", "canceled"));
    expect(s.openOrderCount("guest")).toBe(1);
    expect(s.openOrderCount("w_abc")).toBe(1);
  });

  test("clear() empties every account", () => {
    const s = new AccountState();
    s.apply(ack("guest", "o1", "accepted"));
    s.apply(position("w_abc", "BTC-USD", "5"));
    s.clear();
    expect(s.size).toBe(0);
    expect(s.openOrderCount("guest")).toBe(0);
    expect(s.positions("w_abc")).toEqual([]);
  });

  test("non-account events are ignored", () => {
    const s = new AccountState();
    s.apply({ type: "heartbeat", ts: 1 });
    s.apply({ type: "pong", id: 1 });
    s.apply({ type: "trade", venue: "replay", symbol: "BTC-USD", price: "1", qty: "1", side: "buy", synthetic: false, ts: 1 });
    expect(s.size).toBe(0);
  });

  test("getters return copies", () => {
    const s = new AccountState();
    s.apply(position("guest", "BTC-USD", "5"));
    s.positions("guest").pop();
    expect(s.positions("guest")).toHaveLength(1);
  });
});

describe("caps", () => {
  test("past the account cap the oldest account is dropped and a warning is logged", () => {
    const warnings: string[] = [];
    const s = new AccountState({ maxAccounts: 2, logger: { info: () => {}, warn: (l) => warnings.push(l) } });
    s.apply(position("a1", "BTC-USD", "1"));
    s.apply(position("a2", "BTC-USD", "1"));
    s.apply(position("a3", "BTC-USD", "1"));
    expect(s.size).toBe(2);
    expect(s.positionLots("a1", "BTC-USD")).toBe(0n);
    expect(s.positionLots("a3", "BTC-USD")).toBe(1n);
    expect(warnings).toHaveLength(1);
  });

  test("past the open-order cap the oldest order is dropped", () => {
    const warnings: string[] = [];
    const s = new AccountState({ maxOpenOrdersPerAccount: 2, logger: { info: () => {}, warn: (l) => warnings.push(l) } });
    for (const id of ["o1", "o2", "o3"]) s.apply(ack("guest", id, "accepted"));
    expect(s.openOrders("guest").map((o) => o.orderId)).toEqual(["o2", "o3"]);
    expect(warnings).toHaveLength(1);
  });
});
