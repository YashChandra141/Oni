import { describe, expect, test } from "bun:test";
import type { AccountId } from "../protocol.ts";
import { ActivityLog, type ActivityInput } from "./log.ts";

const acct = (s: string): AccountId => s as AccountId;

function order(accountId: string, orderId: string): ActivityInput {
  return {
    kind: "order",
    accountId: acct(accountId),
    orderId,
    venue: "coinbase",
    symbol: "BTC-USD",
    side: "buy",
    qty: 1n,
    orderKind: "market",
    price: null,
    source: "web",
    ts: 1,
  };
}

function fill(accountId: string, orderId: string): ActivityInput {
  return {
    kind: "fill",
    accountId: acct(accountId),
    orderId,
    venue: "coinbase",
    symbol: "BTC-USD",
    side: "buy",
    price: 10n,
    qty: 1n,
    fee: 0n,
    remaining: 0n,
    ts: 2,
  };
}

describe("ActivityLog", () => {
  test("lists newest first with increasing seq and filters orders", () => {
    const log = new ActivityLog();
    log.append(order("guest", "a"));
    log.append(fill("guest", "a"));
    log.append(order("guest", "b"));
    const all = log.listActivity(acct("guest"));
    expect(all.map((r) => r.kind)).toEqual(["order", "fill", "order"]);
    expect(all.map((r) => r.orderId)).toEqual(["b", "a", "a"]);
    expect(all[0]!.seq).toBeGreaterThan(all[1]!.seq);
    expect(log.listOrders(acct("guest")).map((r) => r.orderId)).toEqual(["b", "a"]);
  });

  test("limit range 1..1000, default 500", () => {
    const log = new ActivityLog({ maxRecordsPerAccount: 2_000 });
    for (let i = 0; i < 700; i++) log.append(order("guest", `o${i}`));
    expect(log.listActivity(acct("guest")).length).toBe(500);
    expect(log.listActivity(acct("guest"), 1).length).toBe(1);
    expect(log.listActivity(acct("guest"), 1000).length).toBe(700);
    expect(() => log.listActivity(acct("guest"), 0)).toThrow(RangeError);
    expect(() => log.listActivity(acct("guest"), 1001)).toThrow(RangeError);
    expect(() => log.listActivity(acct("guest"), 1.5)).toThrow(RangeError);
  });

  test("accounts are isolated", () => {
    const log = new ActivityLog();
    log.append(order("guest", "g"));
    log.append(order("w_abc", "w"));
    expect(log.listActivity(acct("guest")).map((r) => r.orderId)).toEqual(["g"]);
    expect(log.listActivity(acct("w_abc")).map((r) => r.orderId)).toEqual(["w"]);
    expect(log.listActivity(acct("w_none"))).toEqual([]);
  });

  test("per-account cap drops that account's oldest record only", () => {
    const log = new ActivityLog({ maxRecordsPerAccount: 3 });
    log.append(order("w_b", "keep"));
    for (let i = 0; i < 5; i++) log.append(order("guest", `o${i}`));
    expect(log.recordCount(acct("guest"))).toBe(3);
    expect(log.listActivity(acct("guest")).map((r) => r.orderId)).toEqual(["o4", "o3", "o2"]);
    expect(log.recordCount(acct("w_b"))).toBe(1);
  });

  test("account cap drops the least recently appended account whole", () => {
    const log = new ActivityLog({ maxAccounts: 2 });
    log.append(order("w_a", "a"));
    log.append(order("w_b", "b"));
    log.append(order("w_a", "a2")); // w_b is now the least recently appended
    log.append(order("w_c", "c"));
    expect(log.accountCount()).toBe(2);
    expect(log.recordCount(acct("w_b"))).toBe(0);
    expect(log.recordCount(acct("w_a"))).toBe(2);
    expect(log.recordCount(acct("w_c"))).toBe(1);
  });

  test("clear empties the log", () => {
    const log = new ActivityLog();
    log.append(order("guest", "a"));
    log.clear();
    expect(log.accountCount()).toBe(0);
    expect(log.listActivity(acct("guest"))).toEqual([]);
  });
});
