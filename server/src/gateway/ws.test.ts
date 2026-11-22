// Gateway WebSocket handlers with fake sockets and a fake supervisor (Req 17.1–17.7).
import { describe, expect, test } from "bun:test";
import { isOrderCommand } from "../engine/supervisor.ts";
import { INSTRUMENTS } from "../instruments.ts";
import { type Event, type ServerMessage, ServerMessageSchema } from "../protocol.ts";
import type { ActionResult, OrderOrigin, RouterRejectReason } from "../router.ts";
import { FakePublisher, FakeSocket, FakeSupervisor, eventsOf, immediateTimer, memoryLogger } from "./testing.ts";
import { type GatewayRouter, DEFAULT_STARTING_BALANCE, Gateway, MAX_INBOUND_BYTES, NOTICES_TOPIC, PROTOCOL_VERSION, accountTopic, candlesTopic, marketTopic } from "./ws.ts";

const ACCOUNT_TOPIC = accountTopic("guest");

function setup(
  options: {
    running?: boolean;
    dataMode?: "replay" | "live";
    liveVenue?: "coinbase" | "backpack";
  } = {},
) {
  const supervisor = new FakeSupervisor();
  supervisor.running = options.running ?? true;
  const publisher = new FakePublisher();
  const logger = memoryLogger();
  let n = 0;
  const gateway = new Gateway({
    supervisor,
    config: { dataMode: options.dataMode ?? "replay", liveVenue: options.liveVenue ?? "backpack" },
    logger,
    randomUUID: () => `client-${++n}`,
    batcherTimer: immediateTimer,
  });
  gateway.setPublisher(publisher);
  const connect = (): FakeSocket => {
    const ws = new FakeSocket();
    publisher.sockets.add(ws);
    gateway.open(ws);
    return ws;
  };
  const send = (ws: FakeSocket, msg: unknown) => gateway.message(ws, JSON.stringify(msg));
  return { supervisor, publisher, logger, gateway, connect, send };
}

const SUB = { type: "subscribe", venue: "replay", symbol: "BTC-USD", timeframe: "1m" } as const;
const UNSUB = { type: "unsubscribe", venue: "replay", symbol: "BTC-USD", timeframe: "1m" } as const;

const SNAPSHOT: Event = {
  type: "candle",
  venue: "replay",
  symbol: "BTC-USD",
  timeframe: "1m",
  snapshot: true,
  bars: [{ t: 0, open: "100", high: "110", low: "90", close: "105", volume: "7" }],
};

const TRADE = (symbol: string, price: string, qty: string, side: "buy" | "sell", ts: number): Event => ({
  type: "trade",
  venue: "replay",
  symbol,
  price,
  qty,
  side,
  synthetic: false,
  ts,
});

function errorOf(msg: ServerMessage | undefined): { code: string; message: string } | null {
  if (msg?.type !== "event" || msg.event.type !== "error") return null;
  return { code: msg.event.code, message: msg.event.message };
}

describe("open", () => {
  test("assigns a client id, joins the account topic, and sends Hello then a guest Session (Req 1.8)", () => {
    const { connect } = setup({ running: false });
    const ws = connect();
    expect(ws.data.clientId).toBe("client-1");
    expect(ws.topics.has(ACCOUNT_TOPIC)).toBe(true);
    expect(ws.topics.has(NOTICES_TOPIC)).toBe(true);
    expect(ws.data.session).toEqual({ accountId: "guest", address: null, jti: null, exp: null });
    expect(ws.messages()).toEqual([
      {
        type: "hello",
        protocol_version: PROTOCOL_VERSION,
        data_mode: "replay",
        live_venues: [],
        venue_status: [],
        default_venue: "replay",
        starting_balance: DEFAULT_STARTING_BALANCE,
        engine_running: false,
        instruments: INSTRUMENTS.map((i) => ({ ...i, venues: [...i.venues] })),
        providers: [],
        news_enabled: false,
      },
      { type: "session", account_id: "guest", address: null },
    ]);
    // Both are valid Server_Messages under the v3 schema.
    for (const m of ws.messages()) expect(ServerMessageSchema.safeParse(m).success).toBe(true);
  });
});

describe("hello venues (Req 1.11, 15.1)", () => {
  const helloOf = (ws: FakeSocket) => ws.messages()[0];

  test("live mode lists the configured Live_Venue and makes it the default", () => {
    for (const liveVenue of ["coinbase", "backpack"] as const) {
      const { connect } = setup({ dataMode: "live", liveVenue });
      expect(helloOf(connect())).toMatchObject({
        type: "hello",
        data_mode: "live",
        live_venues: [liveVenue],
        default_venue: liveVenue,
      });
    }
  });

  test("replay mode lists no live venue and defaults to replay even when LIVE_VENUE is set", () => {
    const { connect } = setup({ dataMode: "replay", liveVenue: "coinbase" });
    expect(helloOf(connect())).toMatchObject({
      type: "hello",
      data_mode: "replay",
      live_venues: [],
      default_venue: "replay",
    });
  });
});

describe("venue handling and v3 stubs", () => {
  test("a venue that is not available gets an invalid_message Error and no engine command", () => {
    const { supervisor, connect, send } = setup();
    const ws = connect();
    send(ws, { ...SUB, venue: "coinbase" });
    expect(errorOf(ws.last())?.code).toBe("invalid_message");
    expect(supervisor.sent).toEqual([]);
  });

  test("a missing or invalid venue on subscribe fails validation", () => {
    const { connect, gateway } = setup();
    const ws = connect();
    for (const msg of [{ type: "subscribe", symbol: "BTC-USD", timeframe: "1m" }, { ...SUB, venue: "binance" }]) {
      gateway.message(ws, JSON.stringify(msg));
      expect(errorOf(ws.last())?.code).toBe("invalid_message");
    }
  });

  test("without AI wiring, SetProvider and AiRequest answer ai_disabled", () => {
    const { connect, send } = setup();
    const ws = connect();
    send(ws, { type: "set_provider", provider: "ollama" });
    expect(ws.last()).toMatchObject({ type: "notice", kind: "ai_disabled" });
    send(ws, {
      type: "ai_request",
      request_id: "r2",
      action: "analyze",
      text: "",
      symbol: "BTC-USD",
      timeframe: "1h",
      venue: "replay",
    });
    expect(ws.last()).toMatchObject({ type: "ai_error", request_id: "r2", reason: "ai_disabled" });
  });

  test("an AI prompt over 1,000 characters fails validation", () => {
    const { connect, send } = setup();
    const ws = connect();
    send(ws, {
      type: "ai_request",
      request_id: "r",
      action: "ask",
      text: "x".repeat(1001),
      symbol: "BTC-USD",
      timeframe: "1h",
      venue: "replay",
    });
    expect(errorOf(ws.last())?.code).toBe("invalid_message");
  });
});

describe("validation (Req 17.3, 17.4)", () => {
  test("invalid messages get an invalid_message Error and the socket stays usable", () => {
    const { gateway, connect, send } = setup();
    const ws = connect();
    for (const raw of ["not json", "{}", JSON.stringify({ ...SUB, timeframe: "2m" })]) {
      gateway.message(ws, raw);
      expect(errorOf(ws.last())?.code).toBe("invalid_message");
    }
    gateway.message(ws, new Uint8Array([123, 125]));
    expect(errorOf(ws.last())?.code).toBe("invalid_message");
    gateway.message(ws, " ".repeat(MAX_INBOUND_BYTES + 1));
    expect(errorOf(ws.last())?.message).toContain("too large");
    expect(ws.closed).toBe(false);

    send(ws, { type: "ping", id: 9 });
    expect(ws.last()).toEqual({ type: "pong", id: 9 });
  });

  test("an unknown symbol is refused without touching the engine", () => {
    const { supervisor, connect, send } = setup();
    const ws = connect();
    send(ws, { ...SUB, symbol: "NOPE-USD" });
    expect(errorOf(ws.last())?.code).toBe("unknown_symbol");
    expect(supervisor.sent).toEqual([]);
    expect(ws.topics.has("market:replay:NOPE-USD")).toBe(false);
  });
});

describe("subscriptions", () => {
  test("first subscriber sends Subscribe once; a later one gets the cached snapshot", () => {
    const { supervisor, connect, send } = setup();
    const a = connect();
    send(a, SUB);
    expect(supervisor.sent).toEqual([SUB]);
    expect(a.topics.has(candlesTopic("replay", "BTC-USD", "1m"))).toBe(true);
    expect(a.topics.has(marketTopic("replay", "BTC-USD"))).toBe(true);

    supervisor.emitEvent(SNAPSHOT); // the engine's history answer, delivered to the topic's members
    expect(a.last()).toEqual({ type: "event_batch", events: [SNAPSHOT] });

    // A later subscriber gets the cached snapshot as a single event, not a second broadcast.
    const b = connect();
    send(b, SUB);
    expect(supervisor.sent).toEqual([SUB]); // still once
    expect(b.last()).toEqual({ type: "event", event: SNAPSHOT });
    expect(eventsOf(a)).toEqual([SNAPSHOT]);

    send(b, SUB); // duplicate: idempotent, engine not asked again
    expect(supervisor.sent).toEqual([SUB]);
  });

  test("the subscription provider reports active keys for the supervisor (Req 15.4)", () => {
    const { supervisor, connect, send } = setup();
    send(connect(), SUB);
    expect([...supervisor.provider()]).toEqual([{ venue: "replay", symbol: "BTC-USD", timeframe: "1m" }]);
  });

  test("the last unsubscribe sends Unsubscribe; market topic stays while another tf remains", () => {
    const { supervisor, connect, send } = setup();
    const a = connect();
    const b = connect();
    send(a, SUB);
    send(a, { ...SUB, timeframe: "5m" });
    send(b, SUB);

    send(a, UNSUB);
    expect(supervisor.sent).not.toContainEqual(UNSUB);
    expect(a.topics.has(candlesTopic("replay", "BTC-USD", "1m"))).toBe(false);
    expect(a.topics.has(marketTopic("replay", "BTC-USD"))).toBe(true); // 5m still subscribed

    send(a, { ...UNSUB, timeframe: "5m" });
    expect(supervisor.sent).toContainEqual({ ...UNSUB, timeframe: "5m" });
    expect(a.topics.has(marketTopic("replay", "BTC-USD"))).toBe(false);

    send(b, UNSUB);
    expect(supervisor.sent.filter((c) => JSON.stringify(c) === JSON.stringify(UNSUB))).toHaveLength(1);
    send(b, UNSUB); // not subscribed any more: no-op
    expect(supervisor.sent.filter((c) => JSON.stringify(c) === JSON.stringify(UNSUB))).toHaveLength(1);
  });

  test("closing the last subscriber's socket sends Unsubscribe", () => {
    const { supervisor, gateway, connect, send } = setup();
    const a = connect();
    send(a, SUB);
    gateway.close(a);
    expect(supervisor.sent).toEqual([SUB, UNSUB]);
    expect(supervisor.provider()).toEqual([]);
  });

  test("an engine restart clears the market state but keeps subscriptions (Req 15.7)", () => {
    const { supervisor, gateway, connect, send } = setup();
    send(connect(), SUB);
    supervisor.emitEvent(SNAPSHOT);
    supervisor.emitEvent(TRADE("BTC-USD", "1", "1", "buy", 1));
    expect(gateway.market.snapshot("BTC-USD", "1m")).not.toBeNull();
    supervisor.emitClearAccount();
    expect(gateway.market.snapshot("BTC-USD", "1m")).toBeNull();
    expect(gateway.market.quote("BTC-USD")).toBeNull();
    expect([...supervisor.provider()]).toEqual([{ venue: "replay", symbol: "BTC-USD", timeframe: "1m" }]);
  });

  test("engine events feed the market state: trades always, candles only while subscribed", () => {
    const { supervisor, gateway, connect, send } = setup();
    supervisor.emitEvent(SNAPSHOT); // no subscriber yet: not cached
    expect(gateway.market.candles("BTC-USD", "1m")).toBeNull();
    supervisor.emitEvent(TRADE("ETH-USD", "5", "2", "sell", 3));
    expect(gateway.market.quote("ETH-USD")?.last).toEqual({ price: "5", qty: "2", side: "sell", ts: 3 });

    const a = connect();
    send(a, SUB);
    supervisor.emitEvent(SNAPSHOT);
    expect(gateway.market.snapshot("BTC-USD", "1m")).toEqual(SNAPSHOT);

    // The last subscriber leaving drops the key's candles, and a late snapshot is not cached.
    send(a, UNSUB);
    expect(gateway.market.candles("BTC-USD", "1m")).toBeNull();
    supervisor.emitEvent(SNAPSHOT);
    expect(gateway.market.candles("BTC-USD", "1m")).toBeNull();

    // So a later first subscriber asks the engine again instead of reading a stale cache.
    const b = connect();
    send(b, SUB);
    expect(supervisor.sent.filter((c) => JSON.stringify(c) === JSON.stringify(SUB))).toHaveLength(2);
    expect(b.messages().map((m) => m.type)).toEqual(["hello", "session"]);
  });

  test("closing the last subscriber drops the key's cached candles", () => {
    const { supervisor, gateway, connect, send } = setup();
    const a = connect();
    send(a, SUB);
    supervisor.emitEvent(SNAPSHOT);
    gateway.close(a);
    expect(gateway.market.candles("BTC-USD", "1m")).toBeNull();
  });
});

describe("order messages (no router yet)", () => {
  test("are refused with 'order entry not available yet' and no order command is sent", () => {
    const { supervisor, connect, send } = setup();
    const ws = connect();
    const messages = [
      { type: "command_text", request_id: "r1", text: "BUY BTC 0.1" },
      { type: "confirm", request_id: "r2", preview_id: "p1" },
      { type: "discard", preview_id: "p1" },
      { type: "cancel", request_id: "r3", order_id: "o1" },
      { type: "cancel_all", request_id: "r4" },
      { type: "flatten_all", request_id: "r5" },
      { type: "reset_account", request_id: "r6" },
    ];
    for (const msg of messages) {
      send(ws, msg);
      expect(errorOf(ws.last())).toEqual({ code: "internal", message: "order entry not available yet" });
    }
    expect(supervisor.sent).toEqual([]);
    expect(supervisor.sent.some(isOrderCommand)).toBe(false);
  });
});

describe("authenticate without a token verifier", () => {
  test("is rejected with auth_failed, the token is not logged, and the client stays guest", async () => {
    const { supervisor, logger, connect, send } = setup();
    const ws = connect();
    const token = "v1.secret-payload.secret-mac";
    send(ws, { type: "authenticate", token });
    await new Promise((r) => setTimeout(r, 5));
    expect(ws.last()).toMatchObject({ type: "notice", kind: "auth_failed" });
    expect(ws.messages().filter((m) => m.type === "session")).toEqual([
      { type: "session", account_id: "guest", address: null },
      { type: "session", account_id: "guest", address: null },
    ]);
    expect(ws.messages().some((m) => JSON.stringify(m).includes(token))).toBe(false);
    expect(logger.lines.some((l) => l.includes(token))).toBe(false);
    expect(ws.topics.has(ACCOUNT_TOPIC)).toBe(true);
    expect(supervisor.sent).toEqual([]);
  });
});

describe("engine events → topics (Req 17.6, 17.7)", () => {
  const cases: [Event, string][] = [
    [SNAPSHOT, "candles:replay:BTC-USD:1m"],
    [
      {
        type: "indicators",
        venue: "replay",
        symbol: "BTC-USD",
        timeframe: "1m",
        ts: 1,
        values: { ema: 1.5, sma: null, vwap: null, bb_upper: null, bb_mid: null, bb_lower: null, rsi: 50, atr: null },
      },
      "candles:replay:BTC-USD:1m",
    ],
    [TRADE("ETH-USD", "100", "1", "buy", 1), "market:replay:ETH-USD"],
    [
      {
        type: "book",
        venue: "replay",
        symbol: "SOL-USD",
        bids: [],
        asks: [],
        spread: null,
        imbalance_bps: 0,
        synthetic: false,
        ts: 1,
      },
      "market:replay:SOL-USD",
    ],
    [{ type: "order_ack", account_id: "guest", venue: "replay", order_id: "o1", status: "accepted" }, ACCOUNT_TOPIC],
    [
      {
        type: "fill",
        account_id: "guest",
        venue: "replay",
        order_id: "o1",
        symbol: "BTC-USD",
        side: "buy",
        price: "100",
        qty: "1",
        fee: "0",
        remaining: "0",
        ts: 1,
      },
      ACCOUNT_TOPIC,
    ],
    [
      {
        type: "position",
        account_id: "guest",
        symbol: "BTC-USD",
        qty: "1",
        avg_entry: "100",
        realized: "0",
        unrealized: "0",
      },
      ACCOUNT_TOPIC,
    ],
  ];

  for (const [event, topic] of cases) {
    test(`${event.type} reaches the members of ${topic} inside an event_batch`, () => {
      const { supervisor, connect, send } = setup();
      const member = connect();
      const outsider = connect();
      // Join the topic through a subscribe, as a client does (account topics need no subscribe).
      const [kind, , symbol, timeframe] = topic.split(":");
      if (kind === "candles") send(member, { ...SUB, symbol, timeframe });
      else if (kind === "market") send(member, { ...SUB, symbol });
      expect(member.topics.has(topic)).toBe(true);
      supervisor.emitEvent(event);
      expect(member.messages().slice(2)).toEqual([{ type: "event_batch", events: [event] }]);
      if (kind !== "account") expect(outsider.messages().map((m) => m.type)).toEqual(["hello", "session"]);
    });
  }

  test("Heartbeat, Pong, and engine Error are not broadcast", () => {
    const { supervisor, publisher, logger, connect } = setup();
    const ws = connect();
    supervisor.emitEvent({ type: "heartbeat", ts: 1 });
    supervisor.emitEvent({ type: "pong", id: 1 });
    supervisor.emitEvent({ type: "error", code: "unknown_symbol", message: "unknown symbol NOPE-USD" });
    expect(publisher.published).toEqual([]);
    expect(ws.messages().map((m) => m.type)).toEqual(["hello", "session"]);
    expect(logger.lines.some((l) => l.includes("unknown_symbol"))).toBe(true);
  });

  test("OrderRejected with no known requester goes to the account topic (Req 17.10)", () => {
    const { supervisor, connect } = setup();
    const ws = connect();
    const event: Event = {
      type: "order_rejected",
      account_id: "guest",
      venue: "replay",
      order_id: "o1",
      reason: "unknown order",
    };
    supervisor.emitEvent(event);
    expect(ws.last()).toEqual({ type: "event_batch", events: [event] });
  });

  test("notices go to every client on the notices topic", () => {
    const { supervisor, connect } = setup();
    const a = connect();
    const b = connect();
    supervisor.emitNotice({ kind: "account_reset", message: "reset" });
    for (const ws of [a, b]) expect(ws.last()).toEqual({ type: "notice", kind: "account_reset", message: "reset" });
  });

  test("market events reach only clients subscribed to the symbol", () => {
    const { supervisor, connect, send } = setup();
    const a = connect();
    const b = connect();
    send(a, SUB);
    supervisor.emitEvent(TRADE("BTC-USD", "1", "1", "sell", 1));
    expect(a.last()?.type).toBe("event_batch");
    expect(b.messages().map((m) => m.type)).toEqual(["hello", "session"]);
  });

  test("dispose detaches the supervisor listeners", () => {
    const { supervisor, connect, gateway } = setup();
    const ws = connect();
    gateway.dispose();
    supervisor.emitEvent({ type: "order_ack", account_id: "guest", venue: "replay", order_id: "o1", status: "accepted" });
    expect(ws.messages().map((m) => m.type)).toEqual(["hello", "session"]);
  });
});

describe("order actions with a Router (Task 11.2)", () => {
  function routerSetup() {
    const s = setup();
    const calls: { action: string; origin: OrderOrigin; orderId?: string }[] = [];
    const state: { fail: RouterRejectReason | null; throws: boolean } = { fail: null, throws: false };
    const outcome = (action: string, origin: OrderOrigin, orderId?: string): ActionResult => {
      calls.push(orderId === undefined ? { action, origin } : { action, origin, orderId });
      if (state.throws) throw new Error("boom");
      return state.fail === null ? { ok: true } : { ok: false, reason: state.fail };
    };
    const router: GatewayRouter = {
      cancel: (orderId, origin) => outcome("cancel", origin, orderId),
      cancelAll: (origin) => outcome("cancel_all", origin),
      resetAccount: (origin) => outcome("reset_account", origin),
      flattenAll: (origin) => {
        const result = outcome("flatten_all", origin);
        return result.ok ? { ok: true, results: [] } : { ok: false, reason: result.reason, results: [] };
      },
    };
    s.gateway.setRouter(router);
    return { ...s, calls, state };
  }

  const ACTIONS = [
    { type: "cancel", request_id: "r1", order_id: "o_1_abc" },
    { type: "cancel_all", request_id: "r2" },
    { type: "flatten_all", request_id: "r3" },
    { type: "reset_account", request_id: "r4" },
  ];

  test("each action reaches the Router with the connection id, the session, and source web", () => {
    const { connect, send, calls, supervisor } = routerSetup();
    const ws = connect();
    for (const msg of ACTIONS) send(ws, msg);
    expect(calls.map((c) => c.action)).toEqual(["cancel", "cancel_all", "flatten_all", "reset_account"]);
    expect(calls[0]?.orderId).toBe("o_1_abc");
    for (const call of calls) {
      expect(call.origin).toEqual({
        connectionId: "client-1",
        session: { accountId: "guest", address: null, jti: null, exp: null },
        source: "web",
      });
    }
    expect(ws.messages().filter((m) => m.type === "event")).toEqual([]);
    expect(supervisor.sent).toEqual([]);
  });

  test("the account comes from the session, never from the message (Req 18.5)", () => {
    const { connect, send, calls } = routerSetup();
    const ws = connect();
    ws.data.session = { accountId: "w_Mine", address: "Mine", jti: "j1", exp: 4_000_000_000 };
    send(ws, { type: "cancel_all", request_id: "r", account_id: "w_victim", accountId: "w_victim" });
    expect(calls[0]?.origin.session.accountId).toBe("w_Mine");
    expect(JSON.stringify(calls)).not.toContain("victim");
  });

  test("a failed result is an invalid_command error with the reason", () => {
    const { connect, send, state } = routerSetup();
    const ws = connect();
    state.fail = "engine_unavailable";
    send(ws, { type: "cancel_all", request_id: "r" });
    expect(errorOf(ws.last())).toEqual({ code: "invalid_command", message: "cancel all rejected: engine_unavailable" });
    send(ws, { type: "flatten_all", request_id: "r" });
    expect(errorOf(ws.last())).toEqual({ code: "invalid_command", message: "flatten all rejected: engine_unavailable" });
  });

  test("a throwing Router is an internal error and the connection stays usable", () => {
    const { connect, send, state } = routerSetup();
    const ws = connect();
    state.throws = true;
    send(ws, { type: "reset_account", request_id: "r" });
    expect(errorOf(ws.last())).toEqual({ code: "internal", message: "reset account failed" });
    send(ws, { type: "ping", id: 3 });
    expect(ws.last()).toEqual({ type: "pong", id: 3 });
  });

  test("command text, confirm, and discard are still refused until Task 12.1", () => {
    const { connect, send, calls } = routerSetup();
    const ws = connect();
    send(ws, { type: "command_text", request_id: "r", text: "BUY BTC 0.1" });
    expect(errorOf(ws.last())).toEqual({ code: "internal", message: "order entry not available yet" });
    expect(calls).toEqual([]);
  });

  test("sendTo reaches an open connection only, and onConnectionClosed fires on close", () => {
    const { gateway, connect } = routerSetup();
    const ws = connect();
    const closed: string[] = [];
    gateway.onConnectionClosed((id) => closed.push(id));
    expect(gateway.sendTo("client-1", { type: "pong", id: 9 })).toBe(true);
    expect(ws.last()).toEqual({ type: "pong", id: 9 });
    expect(gateway.sendTo("nobody", { type: "pong", id: 9 })).toBe(false);
    gateway.close(ws);
    expect(closed).toEqual(["client-1"]);
    expect(gateway.sendTo("client-1", { type: "pong", id: 9 })).toBe(false);
  });
});
