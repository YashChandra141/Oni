// Plain-English orders through the gateway (Task 13.3, Req 23.3, 23.4, 23.5, 23.6, 23.7):
// `?` text → LlmOrderParser (mock provider) → Preview → Confirm → Router. No network.
import { describe, expect, test } from "bun:test";
import { PreviewStore } from "../commands/previews.ts";
import { FakePublisher, FakeSocket, FakeSupervisor, memoryLogger, settle, waitUntil } from "../gateway/testing.ts";
import { type CommandBar, Gateway } from "../gateway/ws.ts";
import type { ServerMessage } from "../protocol.ts";
import type { OrderOrigin, SubmitOrder } from "../router.ts";
import { LlmOrderParser } from "./parser.ts";
import { LlmUnavailable, type LlmProvider } from "./provider.ts";

const WALLET = { accountId: "w_Wallet1", address: "Wallet1", jti: "jti-1", exp: 4_000_000_000 };
const BUY_BTC = { action: "place", side: "buy", symbol: "BTC-USD", amount: { absolute: "0.1" }, order_type: "limit", price: { absolute: "64000" } };
const UNCLEAR = { action: "unclear", side: null, symbol: null, amount: null, order_type: null, price: null };

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

/** A provider whose calls stay pending until the test settles them. */
function controlledProvider() {
  const pending: Pending[] = [];
  const texts: string[] = [];
  const provider: LlmProvider = {
    interpret: (text) => {
      texts.push(text);
      return new Promise((resolve, reject) => void pending.push({ resolve, reject }));
    },
  };
  return { provider, pending, texts };
}

function setup(provider: LlmProvider | null, timeoutMs?: number) {
  const supervisor = new FakeSupervisor();
  const publisher = new FakePublisher();
  let n = 0;
  const gateway = new Gateway({
    supervisor,
    config: { dataMode: "replay", liveVenue: "backpack" },
    logger: memoryLogger(),
    randomUUID: () => `client-${++n}`,
    tokens: {
      verify: () =>
        Promise.resolve({
          ok: true,
          claims: { accountId: WALLET.accountId, address: WALLET.address, jti: WALLET.jti, iat: 1, exp: WALLET.exp },
        }),
    },
  });
  gateway.setPublisher(publisher);

  const submits: { order: SubmitOrder; origin: OrderOrigin }[] = [];
  const other: string[] = [];
  const router: CommandBar["router"] = {
    submit: (order, origin) => {
      submits.push({ order, origin });
      return { ok: true, orderId: "o_1" };
    },
    cancelAll: () => (other.push("cancel_all"), { ok: true }),
    flattenAll: () => (other.push("flatten_all"), { ok: true, results: [] }),
  };
  const previews = new PreviewStore({ now: () => 5_000_000, newId: (() => { let i = 0; return () => `p${++i}`; })() });
  const llm = new LlmOrderParser({
    provider,
    positionLots: () => 0n,
    lastPrice: (symbol) => (symbol === "BTC-USD" ? 6_400_000n : null),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  gateway.setCommandBar({ previews, accounts: { positionLots: () => 0n }, router, llm });
  gateway.onAccountChange((id) => void previews.discardForConnection(id));
  gateway.onConnectionClosed((id) => void previews.discardForConnection(id));

  const connect = (): FakeSocket => {
    const ws = new FakeSocket();
    publisher.sockets.add(ws);
    gateway.open(ws);
    return ws;
  };
  const send = (ws: FakeSocket, msg: unknown) => gateway.message(ws, JSON.stringify(msg));
  const ask = (ws: FakeSocket, requestId: string, text = "? buy a bit of bitcoin") =>
    send(ws, { type: "command_text", request_id: requestId, text });
  return { gateway, previews, submits, other, connect, send, ask };
}

const typesOf = (ws: FakeSocket): ServerMessage["type"][] => ws.messages().map((m) => m.type);
const count = (ws: FakeSocket, type: ServerMessage["type"]) => typesOf(ws).filter((t) => t === type).length;

describe("? text → preview → confirm", () => {
  test("a valid answer becomes a preview, and Confirm from the same connection reaches the Router", async () => {
    const answering: LlmProvider = { interpret: async () => BUY_BTC };
    const { connect, ask, send, submits, previews } = setup(answering);
    const ws = connect();
    ask(ws, "r1");
    expect(await waitUntil(() => count(ws, "preview") === 1)).toBe(true);
    expect(ws.last()).toMatchObject({
      type: "preview",
      request_id: "r1",
      preview: { preview_id: "p1", text: "BUY BTC-USD 0.1 LMT 64000.00", action: { type: "place", symbol: "BTC-USD", side: "buy" } },
    });
    // Nothing reaches the Router before Confirm (Req 23.6).
    expect(submits).toEqual([]);
    expect(previews.countFor("client-1")).toBe(1);

    send(ws, { type: "confirm", request_id: "r2", preview_id: "p1" });
    expect(submits).toHaveLength(1);
    expect(submits[0]).toEqual({
      origin: { connectionId: "client-1", session: { accountId: "guest", address: null, jti: null, exp: null }, source: "web" },
      // The venue is the client's or the default (replay), never from the model output.
      order: { symbol: "BTC-USD", side: "buy", qty: 10_000_000n, kind: { type: "limit", price: 6_400_000n }, venue: "replay" },
    });
  });

  test("Discard sends nothing to the Router and a later Confirm is rejected", async () => {
    const { connect, ask, send, submits, previews } = setup({ interpret: async () => BUY_BTC });
    const ws = connect();
    ask(ws, "r1");
    expect(await waitUntil(() => count(ws, "preview") === 1)).toBe(true);
    send(ws, { type: "discard", preview_id: "p1" });
    expect(previews.size).toBe(0);
    send(ws, { type: "confirm", request_id: "r2", preview_id: "p1" });
    expect(ws.last()).toMatchObject({ type: "event", event: { type: "error", code: "invalid_command" } });
    expect(submits).toEqual([]);
  });

  test("another connection cannot confirm the preview", async () => {
    const { connect, ask, send, submits } = setup({ interpret: async () => BUY_BTC });
    const a = connect();
    const b = connect();
    ask(a, "r1");
    expect(await waitUntil(() => count(a, "preview") === 1)).toBe(true);
    send(b, { type: "confirm", request_id: "r2", preview_id: "p1" });
    expect(submits).toEqual([]);
  });

  test("model output with an account_id gives a parse_error and no preview (Req 23.4)", async () => {
    const { connect, ask, previews, submits } = setup({ interpret: async () => ({ ...BUY_BTC, account_id: "w_victim" }) });
    const ws = connect();
    ask(ws, "r1");
    expect(await waitUntil(() => count(ws, "parse_error") === 1)).toBe(true);
    expect(ws.last()).toMatchObject({ type: "parse_error", request_id: "r1" });
    expect(previews.size).toBe(0);
    expect(submits).toEqual([]);
  });

  test("an unclear answer gives a parse_error and no preview", async () => {
    const { connect, ask, previews } = setup({ interpret: async () => UNCLEAR });
    const ws = connect();
    ask(ws, "r1");
    expect(await waitUntil(() => count(ws, "parse_error") === 1)).toBe(true);
    expect(previews.size).toBe(0);
  });
});

describe("provider failures (Req 23.5)", () => {
  test("a provider that does not answer by the deadline gives a parse_error and no preview", async () => {
    const { provider } = controlledProvider();
    const { connect, ask, previews, submits } = setup(provider, 20);
    const ws = connect();
    ask(ws, "r1");
    expect(await waitUntil(() => count(ws, "parse_error") === 1)).toBe(true);
    expect(ws.last()).toMatchObject({ type: "parse_error", request_id: "r1" });
    expect(previews.size).toBe(0);
    expect(submits).toEqual([]);
  });

  test("a provider error gives a parse_error with the safe message and no preview", async () => {
    const failing: LlmProvider = {
      interpret: () => Promise.reject(new LlmUnavailable("The language model service is rate limited (HTTP 429)", 429)),
    };
    const { connect, ask, previews } = setup(failing);
    const ws = connect();
    ask(ws, "r1");
    expect(await waitUntil(() => count(ws, "parse_error") === 1)).toBe(true);
    const last = ws.last();
    expect(last?.type === "parse_error" ? last.message : "").toContain("rate limited");
    expect(previews.size).toBe(0);
  });

  test("the connection is free again after a failure", async () => {
    let calls = 0;
    const flaky: LlmProvider = {
      interpret: async () => {
        calls += 1;
        if (calls === 1) throw new LlmUnavailable("The language model service failed (HTTP 500)", 500);
        return BUY_BTC;
      },
    };
    const { connect, ask } = setup(flaky);
    const ws = connect();
    ask(ws, "r1");
    expect(await waitUntil(() => count(ws, "parse_error") === 1)).toBe(true);
    await settle();
    ask(ws, "r2");
    expect(await waitUntil(() => count(ws, "preview") === 1)).toBe(true);
  });
});

describe("account change and busy guard", () => {
  test("an account change while the call is in flight drops the result", async () => {
    const { provider, pending } = controlledProvider();
    const { connect, ask, send, previews, submits } = setup(provider);
    const ws = connect();
    ask(ws, "r1");
    // The parser resolves its provider asynchronously, so the call starts a microtask later.
    expect(await waitUntil(() => pending.length === 1)).toBe(true);

    send(ws, { type: "authenticate", token: "t" });
    expect(await waitUntil(() => ws.messages().some((m) => m.type === "session" && m.account_id === WALLET.accountId))).toBe(true);

    pending[0]?.resolve(BUY_BTC);
    expect(await waitUntil(() => count(ws, "parse_error") === 1)).toBe(true);
    expect(count(ws, "preview")).toBe(0);
    expect(previews.size).toBe(0);
    expect(submits).toEqual([]);
  });

  test("a second ? while one is in flight is refused without calling the provider", async () => {
    const { provider, pending, texts } = controlledProvider();
    const { connect, ask, previews } = setup(provider);
    const ws = connect();
    ask(ws, "r1", "? first");
    ask(ws, "r2", "? second");
    expect(ws.last()).toMatchObject({ type: "parse_error", request_id: "r2" });
    expect(await waitUntil(() => pending.length === 1)).toBe(true);
    // LlmOrderParser trims the text after the `?` before calling the provider.
    expect(texts).toEqual(["first"]);
    expect(pending).toHaveLength(1);

    pending[0]?.resolve(BUY_BTC);
    expect(await waitUntil(() => count(ws, "preview") === 1)).toBe(true);
    expect(ws.last()).toMatchObject({ type: "preview", request_id: "r1" });
    expect(previews.countFor("client-1")).toBe(1);
  });

  test("the busy guard is per connection", async () => {
    const { provider, pending } = controlledProvider();
    const { connect, ask } = setup(provider);
    const a = connect();
    const b = connect();
    ask(a, "r1");
    ask(b, "r2");
    expect(await waitUntil(() => pending.length === 2)).toBe(true);
  });

  test("a result that arrives after the connection closed is dropped", async () => {
    const { provider, pending } = controlledProvider();
    const { connect, ask, gateway, previews } = setup(provider);
    const ws = connect();
    ask(ws, "r1");
    expect(await waitUntil(() => pending.length === 1)).toBe(true);
    gateway.close(ws);
    pending[0]?.resolve(BUY_BTC);
    await settle();
    expect(previews.size).toBe(0);
    expect(count(ws, "preview")).toBe(0);
  });
});

describe("disabled (Req 23.7)", () => {
  test("without a provider, ? text gives Notice ai_disabled, no preview, no order", async () => {
    const { connect, ask, previews, submits, other } = setup(null);
    const ws = connect();
    ask(ws, "r1");
    expect(await waitUntil(() => ws.messages().some((m) => m.type === "notice" && m.kind === "ai_disabled"))).toBe(true);
    expect(previews.size).toBe(0);
    expect(submits).toEqual([]);
    expect(other).toEqual([]);
  });
});
