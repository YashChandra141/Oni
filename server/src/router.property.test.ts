// Property P35 — validates Req 18.5, 18.6
//
// Router account derivation: for any Connection_Sessions and any sequence of order actions,
// including requests that carry hostile `account_id` / `accountId` / `account` keys naming other
// accounts, every Command the Router sends carries the account of the requesting connection's
// session. Order requests go through `router.submit` as objects with the hostile keys. Cancel,
// CancelAll, ResetAccount, and FlattenAll are built as JSON ClientMessages with the same keys,
// parsed by the production parser, and mapped to Router calls by the gateway's `orderActionFor`.
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { orderActionFor } from "./gateway/ws.ts";
import { parseClientMessage } from "./protocol.ts";
import { resolveLimits } from "./risk/limits.ts";
import type { OrderOrigin, RouterSession, SubmitOrder } from "./router.ts";
import { GUEST, harness, originOf, walletSession } from "./router.testing.ts";

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".split("");
const ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-".split("");
const SYMBOLS = ["BTC-USD", "ETH-USD", "SOL-USD"] as const;
/** The last trade price (ticks) the harness seeds for each symbol. */
const LAST: Record<(typeof SYMBOLS)[number], bigint> = { "BTC-USD": 6_400_000n, "ETH-USD": 320_000n, "SOL-USD": 15_000n };

const hostileKeys = (id: string) => ({ account_id: id, accountId: id, account: id });

const addressArb = fc.array(fc.constantFrom(...BASE58), { minLength: 32, maxLength: 44 }).map((chars) => chars.join(""));

/** Generous limits so that many orders are approved. */
const limits = () =>
  resolveLimits({
    rateLimitPerSecond: 1_000_000,
    maxOpenOrders: 1_000_000,
    maxOrderValue: "9223372036854775807",
  });

const opArb = fc.record({
  kind: fc.constantFrom("place", "place", "place", "cancel", "cancel_all", "reset_account", "flatten_all", "position"),
  conn: fc.nat(1000),
  hostile: fc.nat(1000),
  symbol: fc.constantFrom(...SYMBOLS),
  side: fc.constantFrom("buy" as const, "sell" as const),
  qty: fc.bigInt({ min: 100_000n, max: 100_000_000n }),
  orderType: fc.constantFrom("market" as const, "limit" as const, "stop" as const),
  bps: fc.integer({ min: -500, max: 500 }),
  orderId: fc.array(fc.constantFrom(...ID_CHARS), { minLength: 1, maxLength: 64 }).map((c) => c.join("")),
  posQty: fc.bigInt({ min: -100_000_000n, max: 100_000_000n }),
});

const scenarioArb = fc.record({
  addresses: fc.uniqueArray(addressArb, { minLength: 0, maxLength: 3 }),
  exps: fc.array(fc.integer({ min: 10, max: 200_000 }), { minLength: 3, maxLength: 3 }),
  connCounts: fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 4, maxLength: 4 }),
  ops: fc.array(opArb, { minLength: 1, maxLength: 30 }),
});

describe("Property P35: Router account derivation (Req 18.5, 18.6)", () => {
  test("every sent Command carries the requesting connection's session account", () => {
    let approvals = 0;
    let commands = 0;
    fc.assert(
      fc.property(scenarioArb, ({ addresses, exps, connCounts, ops }) => {
        const h = harness({ limits: limits() });
        const sessions: RouterSession[] = [
          GUEST,
          ...addresses.map((a, i) => walletSession(a, 1_700_000_000 + (exps[i] ?? 3600))),
        ];
        const poolAccounts = [...sessions.map((s) => s.accountId), "w_victim"];
        const origins: OrderOrigin[] = [];
        sessions.forEach((session, si) => {
          for (let c = 0; c < (connCounts[si] ?? 1); c++) origins.push(originOf(`s${si}c${c}`, session));
        });

        for (const op of ops) {
          if (op.kind === "position") {
            const session = sessions[op.conn % sessions.length];
            if (session !== undefined) h.setPosition(session.accountId, op.symbol, op.posQty.toString());
            continue;
          }
          const origin = origins[op.conn % origins.length];
          if (origin === undefined) throw new Error("no origin");
          const own = origin.session.accountId;
          const others = poolAccounts.filter((a) => a !== own);
          const hostile = others[op.hostile % others.length] ?? "w_victim";

          const sentBefore = h.sent.length;
          const recordsBefore = h.records.length;
          const rejectedBefore = h.rejected.length;

          if (op.kind === "place") {
            const last = LAST[op.symbol];
            const price = (last * BigInt(10_000 + op.bps)) / 10_000n || 1n;
            const kind =
              op.orderType === "market"
                ? ({ type: "market" } as const)
                : op.orderType === "limit"
                  ? ({ type: "limit", price } as const)
                  : ({ type: "stop", stopPrice: price } as const);
            const order: SubmitOrder = { symbol: op.symbol, side: op.side, qty: op.qty, kind };
            // Extra account fields ride along; the Router must ignore them (Req 18.6).
            const hostileOrder: SubmitOrder = Object.assign({}, order, hostileKeys(hostile));
            h.router.submit(hostileOrder, origin);
          } else {
            const json = JSON.stringify({
              type: op.kind,
              request_id: "r1",
              ...(op.kind === "cancel" ? { order_id: op.orderId } : {}),
              ...hostileKeys(hostile),
            });
            const parsed = parseClientMessage(json);
            if (!parsed.ok) throw new Error(`hostile message failed to parse: ${parsed.message}`);
            // The parsed message carries no account field (Req 18.6).
            expect(Object.keys(parsed.value).filter((k) => /account/i.test(k) && k !== "type")).toEqual([]);
            const mapped = orderActionFor(parsed.value);
            if (mapped === null) throw new Error(`no Router action for ${op.kind}`);
            mapped.run(h.router, origin);
          }

          for (const cmd of h.sent.slice(sentBefore)) {
            expect(cmd.account_id).toBe(own);
            expect(cmd.account_id).not.toBe(hostile);
          }
          for (const record of h.records.slice(recordsBefore)) expect(record.accountId).toBe(own);
          for (const r of h.rejected.slice(rejectedBefore)) {
            expect(r.event.account_id).toBe(own);
            expect(r.connectionId).toBe(origin.connectionId);
          }
          commands += h.sent.length - sentBefore;
          approvals += h.records.slice(recordsBefore).filter((r) => r.kind === "order").length;
        }
      }),
      { numRuns: 200 },
    );
    // The generators must reach approved orders and other command types, or the property is vacuous.
    expect(approvals).toBeGreaterThan(0);
    expect(commands).toBeGreaterThan(approvals);
  });

  test("a wallet session submitting an order that names w_victim yields a command for its own account only", () => {
    const h = harness();
    const wallet = walletSession("Abc123");
    const hostile: SubmitOrder & Record<string, unknown> = Object.assign(
      {},
      { symbol: "BTC-USD", side: "buy" as const, qty: 10_000_000n, kind: { type: "limit" as const, price: 6_400_000n } },
      hostileKeys("w_victim"),
    );
    const result = h.router.submit(hostile, originOf("c1", wallet));
    expect(result.ok).toBe(true);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.account_id).toBe("w_Abc123");
    expect(JSON.stringify(h.sent)).not.toContain("w_victim");
    expect(h.records.map((r) => r.accountId)).toEqual(["w_Abc123"]);
  });
});
