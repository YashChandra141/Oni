// Command bar through the gateway (Task 12.1): command_text → preview or parse error, confirm →
// Router, discard, account switches, and the `?` hook. Uses the gateway fakes and a fake Router.
import { describe, expect, test } from "bun:test";
import type { VerifyResult } from "../auth/token.ts";
import { FakePublisher, FakeSocket, FakeSupervisor, memoryLogger, settle } from "../gateway/testing.ts";
import { type CommandBar, Gateway } from "../gateway/ws.ts";
import type { ServerMessage } from "../protocol.ts";
import type { ActionResult, OrderOrigin, RouterRejectReason, SubmitOrder } from "../router.ts";
import { PREVIEW_TTL_MS, PreviewStore } from "./previews.ts";

const NOW = 5_000_000;
const WALLET = { accountId: "w_Wallet1", address: "Wallet1", jti: "jti-1", exp: 4_000_000_000 };

interface Call {
  readonly action: "submit" | "cancel_all" | "flatten_all";
  readonly origin: OrderOrigin;
  readonly order?: SubmitOrder;
}

function setup(options: { wireHooks?: boolean } = {}) {
  const wireHooks = options.wireHooks ?? true;
  const supervisor = new FakeSupervisor();
  const publisher = new FakePublisher();
  let n = 0;
  const verifyResult: { value: VerifyResult } = {
    value: {
      ok: true,
      claims: { accountId: WALLET.accountId, address: WALLET.address, jti: WALLET.jti, iat: 1, exp: WALLET.exp },
    },
  };
  const gateway = new Gateway({
    supervisor,
    config: { dataMode: "replay", liveVenue: "backpack" },
    logger: memoryLogger(),
    randomUUID: () => `client-${++n}`,
    tokens: { verify: () => Promise.resolve(verifyResult.value) },
  });
  gateway.setPublisher(publisher);

  const positions = new Map<string, bigint>();
  const calls: Call[] = [];
  const state: { fail: RouterRejectReason | null } = { fail: null };
  const failure = (): ActionResult => (state.fail === null ? { ok: true } : { ok: false, reason: state.fail });
  const router: CommandBar["router"] = {
    submit: (order, origin) => {
      calls.push({ action: "submit", origin, order });
      return state.fail === null ? { ok: true, orderId: "o_1" } : { ok: false, orderId: "o_1", reason: state.fail };
    },
    cancelAll: (origin) => {
      calls.push({ action: "cancel_all", origin });
      return failure();
    },
    flattenAll: (origin) => {
      calls.push({ action: "flatten_all", origin });
      const r = failure();
      return r.ok ? { ok: true, results: [] } : { ok: false, reason: r.reason, results: [] };
    },
  };
  const previews = new PreviewStore({ now: () => NOW, newId: (() => { let i = 0; return () => `p${++i}`; })() });
  gateway.setCommandBar({
    previews,
    accounts: { positionLots: (accountId, symbol) => positions.get(`${accountId}:${symbol}`) ?? 0n },
    router,
  });
  if (wireHooks) {
    gateway.onAccountChange((connectionId) => {
      previews.discardForConnection(connectionId);
    });
    gateway.onConnectionClosed((connectionId) => {
      previews.discardForConnection(connectionId);
    });
  }

  const connect = (): FakeSocket => {
    const ws = new FakeSocket();
    publisher.sockets.add(ws);
    gateway.open(ws);
    return ws;
  };
  const send = (ws: FakeSocket, msg: unknown) => gateway.message(ws, JSON.stringify(msg));
  const signIn = async (ws: FakeSocket) => {
    send(ws, { type: "authenticate", token: "t" });
    await settle();
  };
  return { gateway, supervisor, previews, positions, calls, state, connect, send, signIn };
}

function lastOf(ws: FakeSocket): ServerMessage | undefined {
  return ws.last();
}

function errorOf(msg: ServerMessage | undefined): { code: string; message: string } | null {
  if (msg?.type !== "event" || msg.event.type !== "error") return null;
  return { code: msg.event.code, message: msg.event.message };
}

describe("command_text", () => {
  test("a valid command becomes a preview with canonical text and a 60 s expiry", () => {
    const { connect, send, previews } = setup();
    const ws = connect();
    send(ws, { type: "command_text", request_id: "r1", text: "buy btc 0.1 lmt 64000" });
    expect(lastOf(ws)).toEqual({
      type: "preview",
      request_id: "r1",
      preview: {
        preview_id: "p1",
        text: "BUY BTC-USD 0.1 LMT 64000.00",
        action: { type: "place", symbol: "BTC-USD", side: "buy", qty: "10000000", kind: { type: "limit", price: "6400000" } },
        expires_at: NOW + PREVIEW_TTL_MS,
      },
    });
    expect(previews.countFor("client-1")).toBe(1);
  });

  test("CANCEL ALL and FLAT give previews with their actions", () => {
    const { connect, send } = setup();
    const ws = connect();
    send(ws, { type: "command_text", request_id: "r1", text: "CANCEL ALL" });
    expect(lastOf(ws)).toMatchObject({ type: "preview", preview: { text: "CANCEL ALL", action: { type: "cancel_all" } } });
    send(ws, { type: "command_text", request_id: "r2", text: "flat" });
    expect(lastOf(ws)).toMatchObject({ type: "preview", preview: { text: "FLAT", action: { type: "flatten_all" } } });
  });

  test("a malformed command gets a parse_error with the position and creates no preview", () => {
    const { connect, send, previews } = setup();
    const ws = connect();
    send(ws, { type: "command_text", request_id: "r1", text: "BUY XRP 1" });
    const msg = lastOf(ws);
    expect(msg).toMatchObject({ type: "parse_error", request_id: "r1", position: 4 });
    expect(previews.size).toBe(0);
  });

  test("a % amount resolves against the session's own account", async () => {
    const { connect, send, signIn, positions } = setup();
    positions.set("guest:BTC-USD", 200_000_000n);
    positions.set(`${WALLET.accountId}:BTC-USD`, 40n);
    const ws = connect();
    send(ws, { type: "command_text", request_id: "r1", text: "SELL BTC 50%" });
    expect(lastOf(ws)).toMatchObject({ preview: { action: { qty: "100000000" } } });

    await signIn(ws);
    send(ws, { type: "command_text", request_id: "r2", text: "SELL BTC 50%" });
    expect(lastOf(ws)).toMatchObject({ request_id: "r2", preview: { action: { qty: "20" } } });
  });

  test("a % amount on a flat account is a parse_error", () => {
    const { connect, send } = setup();
    const ws = connect();
    send(ws, { type: "command_text", request_id: "r1", text: "SELL BTC 50%" });
    expect(lastOf(ws)).toMatchObject({ type: "parse_error", position: 9 });
  });

  test("? text is a plain-English order: llm_disabled notice, no preview, no order", () => {
    const { connect, send, previews, calls } = setup();
    const ws = connect();
    send(ws, { type: "command_text", request_id: "r1", text: "? buy a bit of bitcoin" });
    expect(lastOf(ws)).toMatchObject({ type: "notice", kind: "llm_disabled" });
    expect(previews.size).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe("confirm", () => {
  test("a place preview reaches Router.submit with the session and the parsed order", () => {
    const { connect, send, calls } = setup();
    const ws = connect();
    send(ws, { type: "command_text", request_id: "r1", text: "BUY BTC 0.1 LMT 64000" });
    send(ws, { type: "confirm", request_id: "r2", preview_id: "p1" });
    expect(calls).toEqual([
      {
        action: "submit",
        origin: { connectionId: "client-1", session: { accountId: "guest", address: null, jti: null, exp: null }, source: "web" },
        order: { symbol: "BTC-USD", side: "buy", qty: 10_000_000n, kind: { type: "limit", price: 6_400_000n } },
      },
    ]);
  });

  test("a preview confirms only once", () => {
    const { connect, send, calls } = setup();
    const ws = connect();
    send(ws, { type: "command_text", request_id: "r1", text: "BUY BTC 1" });
    send(ws, { type: "confirm", request_id: "r2", preview_id: "p1" });
    send(ws, { type: "confirm", request_id: "r3", preview_id: "p1" });
    expect(calls).toHaveLength(1);
    expect(errorOf(lastOf(ws))).toEqual({ code: "invalid_command", message: "confirm rejected: unknown_preview" });
  });

  test("account fields in the message are ignored (rule 10)", () => {
    const { connect, send, calls } = setup();
    const ws = connect();
    send(ws, { type: "command_text", request_id: "r1", text: "BUY BTC 1", account_id: "w_victim" });
    send(ws, { type: "confirm", request_id: "r2", preview_id: "p1", account_id: "w_victim", accountId: "w_victim" });
    expect(calls[0]?.origin.session.accountId).toBe("guest");
    expect(JSON.stringify(calls, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))).not.toContain("victim");
  });

  test("CANCEL ALL and FLAT go to the Router", () => {
    const { connect, send, calls } = setup();
    const ws = connect();
    send(ws, { type: "command_text", request_id: "r1", text: "CANCEL ALL" });
    send(ws, { type: "confirm", request_id: "r2", preview_id: "p1" });
    send(ws, { type: "command_text", request_id: "r3", text: "FLAT" });
    send(ws, { type: "confirm", request_id: "r4", preview_id: "p2" });
    expect(calls.map((c) => c.action)).toEqual(["cancel_all", "flatten_all"]);
  });

  test("a failed CANCEL ALL or FLAT is reported as invalid_command", () => {
    const { connect, send, state } = setup();
    const ws = connect();
    state.fail = "engine_unavailable";
    send(ws, { type: "command_text", request_id: "r1", text: "CANCEL ALL" });
    send(ws, { type: "confirm", request_id: "r2", preview_id: "p1" });
    expect(errorOf(lastOf(ws))).toEqual({ code: "invalid_command", message: "cancel all rejected: engine_unavailable" });
    send(ws, { type: "command_text", request_id: "r3", text: "FLAT" });
    send(ws, { type: "confirm", request_id: "r4", preview_id: "p2" });
    expect(errorOf(lastOf(ws))).toEqual({ code: "invalid_command", message: "flatten all rejected: engine_unavailable" });
  });

  test("a rejected place order adds no gateway error (the Router sends OrderRejected)", () => {
    const { connect, send, state } = setup();
    const ws = connect();
    state.fail = "kill_switch";
    send(ws, { type: "command_text", request_id: "r1", text: "BUY BTC 1" });
    const before = ws.sent.length;
    send(ws, { type: "confirm", request_id: "r2", preview_id: "p1" });
    expect(ws.sent.length).toBe(before);
  });

  test("another connection cannot confirm the preview", () => {
    const { connect, send, calls } = setup();
    const a = connect();
    const b = connect();
    send(a, { type: "command_text", request_id: "r1", text: "BUY BTC 1" });
    send(b, { type: "confirm", request_id: "r2", preview_id: "p1" });
    expect(errorOf(lastOf(b))).toEqual({ code: "invalid_command", message: "confirm rejected: wrong_connection" });
    expect(calls).toEqual([]);
    send(a, { type: "confirm", request_id: "r3", preview_id: "p1" });
    expect(calls).toHaveLength(1);
  });

  test("an unknown preview id is rejected", () => {
    const { connect, send, calls } = setup();
    const ws = connect();
    send(ws, { type: "confirm", request_id: "r1", preview_id: "nope" });
    expect(errorOf(lastOf(ws))).toEqual({ code: "invalid_command", message: "confirm rejected: unknown_preview" });
    expect(calls).toEqual([]);
  });
});

describe("account switch (Req 46.4)", () => {
  test("signing in discards the connection's pending previews", async () => {
    const { connect, send, signIn, previews, calls } = setup();
    const ws = connect();
    send(ws, { type: "command_text", request_id: "r1", text: "BUY BTC 1" });
    await signIn(ws);
    expect(previews.countFor("client-1")).toBe(0);
    send(ws, { type: "confirm", request_id: "r2", preview_id: "p1" });
    expect(errorOf(lastOf(ws))).toEqual({ code: "invalid_command", message: "confirm rejected: unknown_preview" });
    expect(calls).toEqual([]);
  });

  test("a logout discards previews made on the wallet account", async () => {
    const { connect, send, signIn, gateway, previews } = setup();
    const ws = connect();
    await signIn(ws);
    send(ws, { type: "command_text", request_id: "r1", text: "BUY BTC 1" });
    expect(previews.countFor("client-1")).toBe(1);
    gateway.handleLogout(WALLET.jti);
    expect(previews.countFor("client-1")).toBe(0);
  });

  test("a confirm whose preview account differs from the session is rejected even without the hook", async () => {
    const { connect, send, signIn, calls } = setup({ wireHooks: false });
    const ws = connect();
    send(ws, { type: "command_text", request_id: "r1", text: "BUY BTC 1" });
    await signIn(ws);
    send(ws, { type: "confirm", request_id: "r2", preview_id: "p1" });
    expect(errorOf(lastOf(ws))).toEqual({ code: "invalid_command", message: "confirm rejected: account_changed" });
    expect(calls).toEqual([]);
  });

  test("closing the connection discards its previews", () => {
    const { connect, send, gateway, previews } = setup();
    const ws = connect();
    send(ws, { type: "command_text", request_id: "r1", text: "BUY BTC 1" });
    gateway.close(ws);
    expect(previews.size).toBe(0);
  });
});

describe("discard", () => {
  test("drops the preview, so a later confirm is rejected", () => {
    const { connect, send, calls, previews } = setup();
    const ws = connect();
    send(ws, { type: "command_text", request_id: "r1", text: "BUY BTC 1" });
    send(ws, { type: "discard", preview_id: "p1" });
    expect(previews.size).toBe(0);
    send(ws, { type: "confirm", request_id: "r2", preview_id: "p1" });
    expect(errorOf(lastOf(ws))).toEqual({ code: "invalid_command", message: "confirm rejected: unknown_preview" });
    expect(calls).toEqual([]);
  });

  test("another connection cannot discard it", () => {
    const { connect, send, previews } = setup();
    const a = connect();
    const b = connect();
    send(a, { type: "command_text", request_id: "r1", text: "BUY BTC 1" });
    send(b, { type: "discard", preview_id: "p1" });
    expect(previews.size).toBe(1);
  });
});
