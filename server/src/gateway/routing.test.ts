// Gateway account-routing examples and PendingRequests edge cases
// (Req 17.7, 17.9, 17.10, 17.11, 46.1, 46.2, 46.3, 46.6). Complements session.test.ts.
import { describe, expect, test } from "bun:test";
import { encodeBase58 } from "../../../shared/base58.ts";
import { TokenService } from "../auth/token.ts";
import { type Event, parseClientMessage } from "../protocol.ts";
import { PendingRequests } from "./routing.ts";
import { FakePublisher, FakeSocket, FakeSupervisor, eventsOf, immediateTimer, memoryLogger, settle } from "./testing.ts";
import { Gateway } from "./ws.ts";

const A = encodeBase58(new Uint8Array(32).fill(7));
const B = encodeBase58(new Uint8Array(32).fill(9));

function setup() {
  const clock = { ms: 1_700_000_000_000 };
  let counter = 0;
  const tokens = new TokenService({
    secret: "r".repeat(32),
    now: () => clock.ms,
    randomBytes: (n) => new Uint8Array(n).fill(++counter),
  });
  const supervisor = new FakeSupervisor();
  const publisher = new FakePublisher();
  let n = 0;
  const gateway = new Gateway({
    supervisor,
    config: { dataMode: "replay", liveVenue: "backpack" },
    logger: memoryLogger(),
    randomUUID: () => `c${++n}`,
    tokens,
    now: () => clock.ms,
    batcherTimer: immediateTimer,
  });
  gateway.setPublisher(publisher);
  const connect = (): FakeSocket => {
    const ws = new FakeSocket();
    publisher.sockets.add(ws);
    gateway.open(ws);
    return ws;
  };
  const auth = async (ws: FakeSocket, token: string, extra: Record<string, unknown> = {}) => {
    gateway.message(ws, JSON.stringify({ type: "authenticate", token, ...extra }));
    await settle();
  };
  return { clock, tokens, supervisor, gateway, connect, auth };
}

const ack = (account_id: string, order_id = "o1"): Event => ({
  type: "order_ack",
  account_id,
  venue: "replay",
  order_id,
  status: "accepted",
});
const rejected = (account_id: string, order_id = "o1"): Event => ({
  type: "order_rejected",
  account_id,
  venue: "replay",
  order_id,
  reason: "risk",
});
const sessionsOf = (ws: FakeSocket) => ws.messages().filter((m) => m.type === "session");

describe("switching accounts", () => {
  test("authenticating as B while on A moves the socket; A's later events no longer arrive", async () => {
    const { supervisor, tokens, connect, auth } = setup();
    const ws = connect();
    await auth(ws, await tokens.issue(A));
    supervisor.emitEvent(ack(`w_${A}`, "before"));
    expect(eventsOf(ws)).toHaveLength(1);

    await auth(ws, await tokens.issue(B));
    expect(ws.topics.has(`account:w_${A}`)).toBe(false);
    expect(ws.topics.has(`account:w_${B}`)).toBe(true);
    supervisor.emitEvent(ack(`w_${A}`, "after-a"));
    expect(eventsOf(ws)).toHaveLength(1);
    supervisor.emitEvent(ack(`w_${B}`, "after-b"));
    expect(eventsOf(ws)).toHaveLength(2);
  });

  test("authenticating twice with the same token is idempotent", async () => {
    const { supervisor, tokens, connect, auth } = setup();
    const ws = connect();
    const token = await tokens.issue(A);
    await auth(ws, token);
    await auth(ws, token);
    const accountTopics = [...ws.topics].filter((t) => t.startsWith("account:"));
    expect(accountTopics).toEqual([`account:w_${A}`]);
    // Hello is not a session; the guest Session plus one per Authenticate.
    expect(sessionsOf(ws)).toHaveLength(3);
    expect(sessionsOf(ws).at(-1)).toEqual({ type: "session", account_id: `w_${A}`, address: A });
    supervisor.emitEvent(ack(`w_${A}`));
    expect(eventsOf(ws)).toHaveLength(1);
  });
});

describe("account fields in client messages (Req 18.5, 46.2)", () => {
  test("extra account_id / accountId fields are stripped by the parser", () => {
    const parsed = parseClientMessage(
      JSON.stringify({ type: "cancel_all", request_id: "r1", account_id: "w_victim", accountId: "w_victim" }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect("account_id" in parsed.value).toBe(false);
      expect("accountId" in parsed.value).toBe(false);
    }
  });

  test("extra account fields on Authenticate never change the account the token grants", async () => {
    const { gateway, tokens, connect, auth } = setup();
    const ws = connect();
    await auth(ws, await tokens.issue(A), { account_id: "w_victim", accountId: "w_victim", address: "victim" });
    expect(gateway.sessionOf("c1")?.accountId).toBe(`w_${A}`);
    expect(ws.topics.has("account:w_victim")).toBe(false);
  });

  test("account fields on other messages leave a guest a guest", () => {
    const { gateway, connect } = setup();
    const ws = connect();
    gateway.message(ws, JSON.stringify({ type: "ping", id: 3, account_id: "w_victim" }));
    expect(ws.last()).toEqual({ type: "pong", id: 3 });
    expect(gateway.sessionOf("c1")?.accountId).toBe("guest");
    expect(ws.topics.has("account:w_victim")).toBe(false);
  });
});

describe("OrderRejected routing (Req 17.10)", () => {
  test("goes only to the recorded requester", async () => {
    const { gateway, supervisor, tokens, connect, auth } = setup();
    const a = connect();
    const b = connect();
    const token = await tokens.issue(A);
    await auth(a, token);
    await auth(b, token);
    gateway.pendingRequests.set("o1", "c2");
    supervisor.emitEvent(rejected(`w_${A}`));
    expect(eventsOf(a)).toHaveLength(0);
    expect(eventsOf(b)).toHaveLength(1);
  });

  test("falls back to the account topic after the TTL passes", async () => {
    const { clock, gateway, supervisor, tokens, connect, auth } = setup();
    const a = connect();
    const b = connect();
    const token = await tokens.issue(A);
    await auth(a, token);
    await auth(b, token);
    gateway.pendingRequests.set("o1", "c1");
    clock.ms += 60_001;
    supervisor.emitEvent(rejected(`w_${A}`));
    expect(eventsOf(a)).toHaveLength(1);
    expect(eventsOf(b)).toHaveLength(1);
  });

  test("falls back to the account topic when the requester switched accounts", async () => {
    const { gateway, supervisor, tokens, connect, auth } = setup();
    const a = connect();
    const b = connect();
    await auth(a, await tokens.issue(A));
    await auth(b, await tokens.issue(A));
    gateway.pendingRequests.set("o1", "c1");
    await auth(a, await tokens.issue(B)); // requester moves to account B
    supervisor.emitEvent(rejected(`w_${A}`));
    expect(eventsOf(a)).toHaveLength(0);
    expect(eventsOf(b)).toHaveLength(1);
  });

  test("a rejection for an unknown order goes to the account topic", async () => {
    const { supervisor, tokens, connect, auth } = setup();
    const guest = connect();
    const wallet = connect();
    await auth(wallet, await tokens.issue(A));
    supervisor.emitEvent(rejected("guest", "nobody"));
    expect(eventsOf(guest)).toHaveLength(1);
    expect(eventsOf(wallet)).toHaveLength(0);
  });
});

describe("PendingRequests edges", () => {
  const make = (opts: { ttlMs?: number; maxEntries?: number } = {}) => {
    const clock = { ms: 1000 };
    return { clock, p: new PendingRequests({ now: () => clock.ms, ...opts }) };
  };

  test("an unknown id returns undefined", () => {
    expect(make().p.take("nope")).toBeUndefined();
  });

  test("the default TTL is 60 s", () => {
    const { clock, p } = make();
    p.set("a", "c1");
    clock.ms += 59_999;
    expect(p.size).toBe(1);
    clock.ms += 1;
    expect(p.take("a")).toBeUndefined();
    expect(p.size).toBe(0);
  });

  test("setting an id again replaces the requester and refreshes its age", () => {
    const { clock, p } = make({ ttlMs: 100 });
    p.set("a", "c1");
    clock.ms += 60;
    p.set("a", "c2");
    clock.ms += 60; // 120 ms after the first set, 60 after the second
    expect(p.take("a")).toBe("c2");
  });

  test("the cap evicts the oldest entry first", () => {
    const { p } = make({ maxEntries: 3 });
    for (const id of ["a", "b", "c", "d", "e"]) p.set(id, `conn-${id}`);
    expect(p.size).toBe(3);
    expect(p.take("a")).toBeUndefined();
    expect(p.take("b")).toBeUndefined();
    expect(p.take("c")).toBe("conn-c");
    expect(p.take("e")).toBe("conn-e");
  });

  test("dropConnection removes only that connection's entries", () => {
    const { p } = make();
    p.set("a", "c1");
    p.set("b", "c2");
    p.set("c", "c1");
    p.dropConnection("c1");
    expect(p.take("a")).toBeUndefined();
    expect(p.take("c")).toBeUndefined();
    expect(p.take("b")).toBe("c2");
    p.dropConnection("missing"); // no-op
    expect(p.size).toBe(0);
  });
});
