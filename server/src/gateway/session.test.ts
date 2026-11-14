// Connection_Session, Authenticate, logout/expiry downgrades, and account routing in the gateway
// (Req 17.7, 17.9, 17.10, 46.1-46.6), plus the pure routing module.
import { describe, expect, test } from "bun:test";
import { encodeBase58 } from "../../../shared/base58.ts";
import { TOKEN_TTL_SEC, TokenService } from "../auth/token.ts";
import type { Event, ServerMessage } from "../protocol.ts";
import { PendingRequests, accountTopic, routeAccountEvent } from "./routing.ts";
import { FakePublisher, FakeSocket, FakeSupervisor, memoryLogger, settle } from "./testing.ts";
import { Gateway, NOTICES_TOPIC } from "./ws.ts";

const ADDRESS = encodeBase58(new Uint8Array(32).fill(7));
const ADDRESS_2 = encodeBase58(new Uint8Array(32).fill(9));
const SECRET = "s".repeat(32);

function setup() {
  const clock = { ms: 1_700_000_000_000 };
  let counter = 0;
  const tokens = new TokenService({
    secret: SECRET,
    now: () => clock.ms,
    randomBytes: (n) => new Uint8Array(n).fill(++counter),
  });
  const supervisor = new FakeSupervisor();
  const publisher = new FakePublisher();
  const logger = memoryLogger();
  let n = 0;
  const gateway = new Gateway({
    supervisor,
    config: { dataMode: "replay", liveVenue: "backpack" },
    logger,
    randomUUID: () => `c${++n}`,
    tokens,
    now: () => clock.ms,
  });
  gateway.setPublisher(publisher);
  const connect = (): FakeSocket => {
    const ws = new FakeSocket();
    publisher.sockets.add(ws);
    gateway.open(ws);
    return ws;
  };
  const auth = async (ws: FakeSocket, token: string) => {
    gateway.message(ws, JSON.stringify({ type: "authenticate", token }));
    await settle();
  };
  return { clock, tokens, supervisor, publisher, logger, gateway, connect, auth };
}

const ack = (account_id: string): Event => ({ type: "order_ack", account_id, order_id: "o1", status: "accepted" });
const sessions = (ws: FakeSocket) => ws.messages().filter((m) => m.type === "session");
const noticeKinds = (ws: FakeSocket) =>
  ws.messages().flatMap((m: ServerMessage) => (m.type === "notice" ? [m.kind] : []));

describe("routeAccountEvent (pure)", () => {
  test("account events go to account:<account_id>", () => {
    expect(routeAccountEvent(ack("w_x"))).toEqual({ topic: "account:w_x" });
    expect(accountTopic("guest")).toBe("account:guest");
  });

  test("OrderRejected goes to the requester when known, else the account topic", () => {
    const e: Event = { type: "order_rejected", account_id: "w_x", order_id: "o1", reason: "r" };
    expect(routeAccountEvent(e, { requester: "c1" })).toEqual({ toConnection: "c1" });
    expect(routeAccountEvent(e, {})).toEqual({ topic: "account:w_x" });
    expect(routeAccountEvent(e, { requester: null })).toEqual({ topic: "account:w_x" });
  });

  test("heartbeat, pong, and error are dropped", () => {
    expect(routeAccountEvent({ type: "heartbeat", ts: 1 })).toEqual({ drop: true });
    expect(routeAccountEvent({ type: "pong", id: 1 })).toEqual({ drop: true });
  });
});

describe("PendingRequests", () => {
  test("take returns and removes; entries expire; the map is capped", () => {
    const clock = { ms: 0 };
    const p = new PendingRequests({ now: () => clock.ms, ttlMs: 100, maxEntries: 2 });
    p.set("a", "c1");
    expect(p.take("a")).toBe("c1");
    expect(p.take("a")).toBeUndefined();
    p.set("b", "c1");
    clock.ms = 100;
    expect(p.take("b")).toBeUndefined();
    p.set("x", "c1");
    p.set("y", "c2");
    p.set("z", "c3");
    expect(p.take("x")).toBeUndefined();
    expect(p.take("z")).toBe("c3");
    p.dropConnection("c2");
    expect(p.size).toBe(0);
  });
});

describe("Authenticate", () => {
  test("a valid token moves the socket to its wallet account and sends Session", async () => {
    const { gateway, tokens, connect, auth, logger } = setup();
    const ws = connect();
    const token = await tokens.issue(ADDRESS);
    await auth(ws, token);
    expect(ws.topics.has("account:guest")).toBe(false);
    expect(ws.topics.has(`account:w_${ADDRESS}`)).toBe(true);
    expect(ws.topics.has(NOTICES_TOPIC)).toBe(true);
    expect(ws.last()).toEqual({ type: "session", account_id: `w_${ADDRESS}`, address: ADDRESS });
    expect(gateway.sessionOf("c1")?.accountId).toBe(`w_${ADDRESS}`);
    expect(ws.messages().some((m) => JSON.stringify(m).includes(token))).toBe(false);
    expect(logger.lines.some((l) => l.includes(token))).toBe(false);
  });

  test("invalid, expired, and denylisted tokens leave the connection guest with auth_failed", async () => {
    const { clock, tokens, connect, auth, logger } = setup();
    const denied = await tokens.issue(ADDRESS);
    const verified = await tokens.verify(denied);
    if (!verified.ok) throw new Error("expected ok");
    tokens.deny(verified.claims);
    const expired = await tokens.issue(ADDRESS_2);
    clock.ms += TOKEN_TTL_SEC * 1000; // `expired` is now past its exp

    for (const token of ["garbage", expired, denied]) {
      const ws = connect();
      await auth(ws, token);
      expect(ws.topics.has("account:guest")).toBe(true);
      expect(ws.topics.size).toBe(2);
      expect(sessions(ws).at(-1)).toEqual({ type: "session", account_id: "guest", address: null });
      expect(noticeKinds(ws)).toEqual(["auth_failed"]);
      expect(logger.lines.some((l) => l.includes(token))).toBe(false);
    }
  });

  test("a token verified after the socket closed changes nothing", async () => {
    const { gateway, tokens, connect } = setup();
    const ws = connect();
    const token = await tokens.issue(ADDRESS);
    gateway.message(ws, JSON.stringify({ type: "authenticate", token }));
    gateway.close(ws);
    await settle();
    expect(ws.topics.has(`account:w_${ADDRESS}`)).toBe(false);
    expect(sessions(ws)).toHaveLength(1);
  });

});

describe("account-change hook", () => {
  test("fires on sign-in and on downgrade, and stops after unsubscribe", async () => {
    const { gateway, tokens, connect, auth } = setup();
    const calls: [string, string, string][] = [];
    const off = gateway.onAccountChange((id, from, to) => void calls.push([id, from, to]));
    const ws = connect();
    await auth(ws, await tokens.issue(ADDRESS));
    gateway.downgradeExpired("c1");
    expect(calls).toEqual([
      ["c1", "guest", `w_${ADDRESS}`],
      ["c1", `w_${ADDRESS}`, "guest"],
    ]);
    off();
    await auth(ws, await tokens.issue(ADDRESS));
    expect(calls).toHaveLength(2);
  });

  test("a throwing listener does not break the switch", async () => {
    const { gateway, tokens, connect, auth } = setup();
    gateway.onAccountChange(() => {
      throw new Error("boom");
    });
    const ws = connect();
    await auth(ws, await tokens.issue(ADDRESS));
    expect(ws.last()).toMatchObject({ type: "session", address: ADDRESS });
  });
});

describe("logout and expiry downgrades", () => {
  test("logout moves every connection on the jti to guest and leaves others alone", async () => {
    const { gateway, tokens, connect, auth } = setup();
    const token = await tokens.issue(ADDRESS);
    const a = connect();
    const b = connect();
    const other = connect();
    await auth(a, token);
    await auth(b, token);
    await auth(other, await tokens.issue(ADDRESS_2));
    const v = await tokens.verify(token);
    if (!v.ok) throw new Error("expected ok");

    gateway.handleLogout(v.claims.jti);
    for (const ws of [a, b]) {
      expect(ws.topics.has("account:guest")).toBe(true);
      expect(ws.topics.has(`account:w_${ADDRESS}`)).toBe(false);
      expect(sessions(ws).at(-1)).toEqual({ type: "session", account_id: "guest", address: null });
      expect(noticeKinds(ws)).toEqual(["signed_out"]);
    }
    expect(other.topics.has(`account:w_${ADDRESS_2}`)).toBe(true);
    expect(noticeKinds(other)).toEqual([]);
    gateway.handleLogout(v.claims.jti); // idempotent
    expect(noticeKinds(a)).toEqual(["signed_out"]);
  });

  test("downgradeExpired sends Session guest and session_expired; a guest is a no-op", async () => {
    const { gateway, tokens, connect, auth } = setup();
    const g = connect();
    gateway.downgradeExpired("c1");
    expect(noticeKinds(g)).toEqual([]);
    const ws = connect();
    await auth(ws, await tokens.issue(ADDRESS));
    gateway.downgradeExpired("c2");
    expect(sessions(ws).at(-1)).toEqual({ type: "session", account_id: "guest", address: null });
    expect(noticeKinds(ws)).toEqual(["session_expired"]);
  });

  test("a wallet session past exp is downgraded before the next client message", async () => {
    const { clock, tokens, connect, auth, gateway } = setup();
    const ws = connect();
    await auth(ws, await tokens.issue(ADDRESS));
    clock.ms += TOKEN_TTL_SEC * 1000;
    gateway.message(ws, JSON.stringify({ type: "ping", id: 1 }));
    expect(ws.topics.has("account:guest")).toBe(true);
    expect(noticeKinds(ws)).toEqual(["session_expired"]);
    expect(ws.last()).toEqual({ type: "pong", id: 1 });
  });
});

describe("account routing through the gateway", () => {
  test("account events reach only connections on that account", async () => {
    const { supervisor, tokens, connect, auth } = setup();
    const guest = connect();
    const w1 = connect();
    const w2 = connect();
    await auth(w1, await tokens.issue(ADDRESS));
    await auth(w2, await tokens.issue(ADDRESS_2));
    const before = [guest, w1, w2].map((s) => s.sent.length);

    supervisor.emitEvent(ack(`w_${ADDRESS}`));
    expect([guest, w1, w2].map((s) => s.sent.length)).toEqual([before[0], (before[1] ?? 0) + 1, before[2]]);
    supervisor.emitEvent(ack("guest"));
    expect(guest.sent.length).toBe((before[0] ?? 0) + 1);
    expect(w1.sent.length).toBe((before[1] ?? 0) + 1);
  });

  test("OrderRejected goes only to the requester when it is on the order's account", async () => {
    const { gateway, supervisor, tokens, connect, auth } = setup();
    const a = connect();
    const b = connect();
    const token = await tokens.issue(ADDRESS);
    await auth(a, token);
    await auth(b, token);
    gateway.pendingRequests.set("o1", "c1");
    const e: Event = { type: "order_rejected", account_id: `w_${ADDRESS}`, order_id: "o1", reason: "risk" };
    supervisor.emitEvent(e);
    expect(a.last()).toEqual({ type: "event", event: e });
    expect(b.last()).toMatchObject({ type: "session" });
  });

  test("OrderRejected falls back to the account topic when the requester left", async () => {
    const { gateway, supervisor, tokens, connect, auth } = setup();
    const a = connect();
    const b = connect();
    const token = await tokens.issue(ADDRESS);
    await auth(a, token);
    await auth(b, token);
    gateway.pendingRequests.set("o1", "c1");
    gateway.close(a);
    const e: Event = { type: "order_rejected", account_id: `w_${ADDRESS}`, order_id: "o1", reason: "risk" };
    supervisor.emitEvent(e);
    expect(b.last()).toEqual({ type: "event", event: e });
  });

  test("notices reach guest and wallet connections (Req 17.9)", async () => {
    const { supervisor, tokens, connect, auth } = setup();
    const guest = connect();
    const wallet = connect();
    await auth(wallet, await tokens.issue(ADDRESS));
    supervisor.emitNotice({ kind: "engine_down", message: "down" });
    for (const ws of [guest, wallet]) expect(ws.last()).toEqual({ type: "notice", kind: "engine_down", message: "down" });
  });

  test("an account id in a client message is ignored (Req 18.5)", () => {
    const { gateway, supervisor, connect } = setup();
    const ws = connect();
    gateway.message(ws, JSON.stringify({ type: "cancel_all", request_id: "r1", account_id: "w_victim" }));
    expect(ws.data.session?.accountId).toBe("guest");
    expect(supervisor.sent).toEqual([]);
  });
});
