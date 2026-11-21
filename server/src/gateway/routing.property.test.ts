// Property P34 — validates Req 17.7, 17.9, 17.10, 17.11, 46.2
// Account event routing: every account event reaches exactly the open connections whose
// Connection_Session holds the event's Account_Id at delivery time; notices reach everyone.
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { encodeBase58 } from "../../../shared/base58.ts";
import { TOKEN_TTL_SEC, TokenService } from "../auth/token.ts";
import type { Event } from "../protocol.ts";
import { NOTICES_TOPIC, accountTopic, routeAccountEvent } from "./routing.ts";
import { FakePublisher, FakeSocket, FakeSupervisor, memoryLogger, waitUntil } from "./testing.ts";
import { Gateway } from "./ws.ts";

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const accountIdArb: fc.Arbitrary<string> = fc.oneof(
  fc.constant("guest"),
  fc
    .array(fc.constantFrom(...BASE58.split("")), { minLength: 1, maxLength: 44 })
    .map((chars) => `w_${chars.join("")}`),
);

function buildEvent(kind: 0 | 1 | 2 | 3, accountId: string, tag: string): Event {
  switch (kind) {
    case 0:
      return { type: "order_ack", account_id: accountId, venue: "replay", order_id: tag, status: "accepted" };
    case 1:
      return {
        type: "fill",
        account_id: accountId,
        venue: "replay",
        order_id: tag,
        symbol: "BTC-USD",
        side: "buy",
        price: "1",
        qty: "1",
        fee: "0",
        remaining: "0",
        ts: 1,
      };
    case 2:
      return { type: "position", account_id: accountId, symbol: tag, qty: "1", avg_entry: "1", realized: "0", unrealized: "0" };
    case 3:
      return { type: "order_rejected", account_id: accountId, venue: "replay", order_id: tag, reason: "risk" };
  }
}

/** The value that makes an event distinguishable from every other event in a run. */
function eventKey(event: Event): string {
  if (event.type === "position") return event.symbol;
  if (event.type === "order_ack" || event.type === "fill" || event.type === "order_rejected") return event.order_id;
  return "";
}

describe("P34 routeAccountEvent (pure)", () => {
  test("account events route to their own account topic, never another", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<0 | 1 | 2 | 3>(0, 1, 2, 3),
        accountIdArb,
        accountIdArb,
        fc.option(fc.string({ minLength: 1, maxLength: 12 }), { nil: undefined }),
        (kind, accountId, other, requester) => {
          const event = buildEvent(kind, accountId, "t1");
          const route = routeAccountEvent(event, { requester });
          if (kind === 3 && requester !== undefined) {
            expect(route).toEqual({ toConnection: requester });
            return;
          }
          expect(route).toEqual({ topic: `account:${accountId}` });
          if (other !== accountId) expect(route).not.toEqual({ topic: accountTopic(other) });
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------------------------
// End-to-end model
// ---------------------------------------------------------------------------------------------

const ADDRESSES = [1, 2, 3].map((n) => encodeBase58(new Uint8Array(32).fill(n)));
const ACCOUNTS = ["guest", ...ADDRESSES.map((a) => `w_${a}`)];
const SECRET = "p".repeat(32);

type Op =
  | { k: "auth"; c: number; a: number; reuse: boolean }
  | { k: "bad"; c: number }
  | { k: "logout"; c: number }
  | { k: "event"; y: number; kind: 0 | 1 | 2 | 3 }
  | { k: "notice" }
  | { k: "close"; c: number }
  | { k: "advance"; ms: number }
  | { k: "ping"; c: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ k: fc.constant("auth" as const), c: fc.nat(3), a: fc.nat(2), reuse: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("bad" as const), c: fc.nat(3) }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("logout" as const), c: fc.nat(3) }) },
  {
    weight: 6,
    arbitrary: fc.record({
      k: fc.constant("event" as const),
      y: fc.nat(3),
      kind: fc.constantFrom<0 | 1 | 2 | 3>(0, 1, 2, 3),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ k: "notice" as const }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("close" as const), c: fc.nat(3) }) },
  {
    weight: 1,
    arbitrary: fc.record({
      k: fc.constant("advance" as const),
      ms: fc.constantFrom(60_000, 3_600_000, TOKEN_TTL_SEC * 500, TOKEN_TTL_SEC * 1000 + 1_000),
    }),
  },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("ping" as const), c: fc.nat(3) }) },
);

interface Model {
  open: boolean;
  account: string;
  jti: string | null;
  exp: number | null;
}

describe("P34 end-to-end account routing model", () => {
  test(
    "each event reaches exactly the open connections on its account; notices reach all open",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 2, max: 4 }), fc.array(opArb, { minLength: 1, maxLength: 20 }), async (nConns, ops) => {
          const clock = { ms: 1_700_000_000_000 };
          let counter = 0;
          const tokens = new TokenService({
            secret: SECRET,
            now: () => clock.ms,
            randomBytes: (n) => new Uint8Array(n).fill((++counter % 250) + 1),
          });
          const supervisor = new FakeSupervisor();
          const publisher = new FakePublisher();
          let ids = 0;
          const gateway = new Gateway({
            supervisor,
            config: { dataMode: "replay", liveVenue: "backpack" },
            logger: memoryLogger(),
            randomUUID: () => `c${++ids}`,
            tokens,
            now: () => clock.ms,
          });
          gateway.setPublisher(publisher);

          const sockets: FakeSocket[] = [];
          const models: Model[] = [];
          for (let i = 0; i < nConns; i++) {
            const ws = new FakeSocket();
            publisher.sockets.add(ws);
            gateway.open(ws);
            sockets.push(ws);
            models.push({ open: true, account: "guest", jti: null, exp: null });
          }

          /** Model of the lazy expiry that runs before every client message (Req 46.5). */
          const expireIfDue = (m: Model) => {
            if (m.exp !== null && Math.floor(clock.ms / 1000) >= m.exp) {
              m.account = "guest";
              m.jti = null;
              m.exp = null;
            }
          };
          const checkSessions = () => {
            for (let i = 0; i < nConns; i++) {
              const m = models[i];
              if (m === undefined || !m.open) continue;
              expect(sockets[i]?.data.session?.accountId).toBe(m.account);
              expect(sockets[i]?.topics.has(accountTopic(m.account))).toBe(true);
              const accountTopics = [...(sockets[i]?.topics ?? [])].filter((t) => t.startsWith("account:"));
              expect(accountTopics).toEqual([accountTopic(m.account)]);
            }
          };

          const lastToken = new Map<number, { token: string; exp: number }>();
          let seq = 0;

          for (const op of ops) {
            const ci = "c" in op ? op.c % nConns : 0;
            const ws = sockets[ci];
            const m = models[ci];
            if (ws === undefined || m === undefined) continue;

            switch (op.k) {
              case "auth": {
                if (!m.open) break;
                let entry = op.reuse ? lastToken.get(op.a) : undefined;
                if (entry === undefined || entry.exp * 1000 <= clock.ms) {
                  const token = await tokens.issue(ADDRESSES[op.a] ?? "");
                  const v = await tokens.verify(token);
                  if (!v.ok) throw new Error("fresh token must verify");
                  entry = { token, exp: v.claims.exp };
                  lastToken.set(op.a, entry);
                }
                const v = await tokens.verify(entry.token);
                if (!v.ok) throw new Error("token must verify");
                expireIfDue(m);
                const sessionCount = () => ws.messages().filter((x) => x.type === "session").length;
                gateway.message(ws, JSON.stringify({ type: "authenticate", token: entry.token }));
                const before = sessionCount(); // a lazy-expiry downgrade above already sent its Session
                // A successful Authenticate always ends with one more Session message.
                expect(await waitUntil(() => sessionCount() > before)).toBe(true);
                expect(ws.data.session?.jti).toBe(v.claims.jti);
                m.account = `w_${ADDRESSES[op.a]}`;
                m.jti = v.claims.jti;
                m.exp = v.claims.exp;
                break;
              }
              case "bad": {
                if (!m.open) break;
                const failures = () => ws.messages().filter((x) => x.type === "notice" && x.kind === "auth_failed").length;
                const before = failures();
                expireIfDue(m);
                gateway.message(ws, JSON.stringify({ type: "authenticate", token: "garbage" }));
                expect(await waitUntil(() => failures() === before + 1)).toBe(true);
                break;
              }
              case "logout": {
                if (!m.open || m.jti === null) break;
                const jti = m.jti;
                gateway.handleLogout(jti);
                for (const other of models) {
                  if (other.open && other.jti === jti) {
                    other.account = "guest";
                    other.jti = null;
                    other.exp = null;
                  }
                }
                break;
              }
              case "ping": {
                if (!m.open) break;
                expireIfDue(m);
                gateway.message(ws, JSON.stringify({ type: "ping", id: 1 }));
                break;
              }
              case "close": {
                if (!m.open) break;
                gateway.close(ws);
                publisher.sockets.delete(ws); // Bun stops delivering to a closed socket
                m.open = false;
                break;
              }
              case "advance": {
                clock.ms += op.ms;
                break;
              }
              case "notice": {
                const message = `n${++seq}`;
                const counts = sockets.map((s) => s.messages().filter((x) => x.type === "notice" && x.message === message).length);
                expect(counts).toEqual(models.map(() => 0));
                supervisor.emitNotice({ kind: "engine_up", message });
                expect(publisher.published.at(-1)?.topic).toBe(NOTICES_TOPIC);
                sockets.forEach((s, i) => {
                  const got = s.messages().filter((x) => x.type === "notice" && x.message === message).length;
                  expect(got).toBe(models[i]?.open === true ? 1 : 0);
                });
                break;
              }
              case "event": {
                const accountId = ACCOUNTS[op.y] ?? "guest";
                const tag = `e${++seq}`;
                const event = buildEvent(op.kind, accountId, tag);
                supervisor.emitEvent(event);
                sockets.forEach((s, i) => {
                  const got = s.messages().filter((x) => x.type === "event" && eventKey(x.event) === tag);
                  const mm = models[i];
                  const expected = mm !== undefined && mm.open && mm.account === accountId ? 1 : 0;
                  expect(got).toHaveLength(expected);
                  for (const x of got) {
                    // Never another account's event.
                    expect<string | undefined>(
                      x.type === "event" && "account_id" in x.event ? x.event.account_id : accountId,
                    ).toBe(mm?.account);
                  }
                });
                break;
              }
            }
            checkSessions();
          }
        }),
        { numRuns: 60 },
      );
    },
    120_000,
  );
});
