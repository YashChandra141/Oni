// Unit tests for the protocol Zod schemas and bigint helpers (Req 1.4, 17.3, 17.4).
import { describe, expect, test } from "bun:test";
import {
  AccountIdSchema,
  ClientMessageSchema,
  CommandSchema,
  EventSchema,
  I64_MAX,
  I64_MIN,
  OrderIdSchema,
  PriceSchema,
  ServerMessageSchema,
  formatDecimal,
  fromBigInt,
  isCanonicalI64,
  parseClientMessage,
  parseEventLine,
  toBigInt,
  type ClientMessage,
  type Command,
  type Event,
  type ServerMessage,
} from "./protocol.ts";

/** `w_<base58 address>`, as the server builds a Wallet_Account id. */
const WALLET_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const WALLET_ACCOUNT = `w_${WALLET_ADDRESS}`;

const values = { ema: 1.5, sma: null, vwap: 64000.25, bb_upper: null, bb_mid: null, bb_lower: null, rsi: 55, atr: 0.1 };
const bar = { t: 1_733_200_000_000, open: "6400000", high: "6400100", low: "6399900", close: "6400050", volume: "150000000" };

const trade: Extract<Event, { type: "trade" }> = {
  type: "trade",
  symbol: "BTC-USD",
  price: "6400000",
  qty: "10000000",
  side: "buy",
  ts: 1_733_200_000_000,
};

const EVENTS: Event[] = [
  { type: "candle", symbol: "BTC-USD", timeframe: "1m", snapshot: true, bars: [bar] },
  { type: "candle", symbol: "ETH-USD", timeframe: "1d", snapshot: false, bars: [] },
  trade,
  {
    type: "book",
    symbol: "SOL-USD",
    bids: [{ price: "23000", qty: "500000000" }],
    asks: [{ price: "23001", qty: "100000000" }],
    spread: "1",
    imbalance_bps: -10_000,
    ts: 1,
  },
  { type: "book", symbol: "SOL-USD", bids: [], asks: [], spread: null, imbalance_bps: 0, ts: 0 },
  { type: "indicators", symbol: "BTC-USD", timeframe: "15m", ts: 2, values },
  { type: "order_ack", account_id: "guest", order_id: "ord-1", status: "accepted" },
  { type: "order_rejected", account_id: WALLET_ACCOUNT, order_id: "ord_2", reason: "unknown order" },
  {
    type: "fill",
    account_id: "guest",
    order_id: "A1",
    symbol: "BTC-USD",
    side: "sell",
    price: "6400000",
    qty: "5000000",
    fee: "-9223372036854775808",
    remaining: "0",
    ts: 3,
  },
  {
    type: "position",
    account_id: "guest",
    symbol: "BTC-USD",
    qty: "-5000000",
    avg_entry: "6400000",
    realized: "0",
    unrealized: "9223372036854775807",
  },
  { type: "position", account_id: WALLET_ACCOUNT, symbol: "ETH-USD", qty: "0", avg_entry: null, realized: "-12", unrealized: "0" },
  { type: "heartbeat", ts: 1_733_200_000_000 },
  { type: "pong", id: 7 },
  { type: "error", code: "invalid_json", message: "expected value at line 1 column 1" },
];

const CLIENT_MESSAGES: ClientMessage[] = [
  { type: "subscribe", symbol: "BTC-USD", timeframe: "5m" },
  { type: "unsubscribe", symbol: "BTC-USD", timeframe: "1h" },
  { type: "command_text", request_id: "r1", text: "BUY BTC 0.1 LMT 64000" },
  { type: "confirm", request_id: "r2", preview_id: "p1" },
  { type: "discard", preview_id: "p1" },
  { type: "cancel", request_id: "r3", order_id: "ord-1" },
  { type: "cancel_all", request_id: "r4" },
  { type: "flatten_all", request_id: "r5" },
  { type: "reset_account", request_id: "r6" },
  { type: "authenticate", token: "v1.payload.mac" },
  { type: "ping", id: 0 },
];

const COMMANDS: Command[] = [
  { type: "subscribe", symbol: "BTC-USD", timeframe: "1m" },
  { type: "unsubscribe", symbol: "BTC-USD", timeframe: "1m" },
  { type: "place_order", account_id: "guest", order_id: "o1", symbol: "BTC-USD", side: "buy", qty: "1", kind: { type: "market" } },
  {
    type: "place_order",
    account_id: WALLET_ACCOUNT,
    order_id: "o2",
    symbol: "BTC-USD",
    side: "sell",
    qty: "1",
    kind: { type: "limit", price: "6400000" },
  },
  {
    type: "place_order",
    account_id: "guest",
    order_id: "o3",
    symbol: "BTC-USD",
    side: "buy",
    qty: "1",
    kind: { type: "stop", stop_price: "6500000" },
  },
  { type: "cancel", account_id: "guest", order_id: "o1" },
  { type: "cancel_all", account_id: "guest" },
  { type: "start_replay", fixture: "demo.jsonl", speed: 10 },
  { type: "reset_account", account_id: WALLET_ACCOUNT },
  { type: "ping", id: 42 },
];

const SERVER_MESSAGES: ServerMessage[] = [
  {
    type: "hello",
    protocol_version: 2,
    data_mode: "replay",
    venue: null,
    engine_running: true,
    instruments: [{ symbol: "BTC-USD", short: "BTC", price_decimals: 2, qty_decimals: 8 }],
  },
  { type: "hello", protocol_version: 2, data_mode: "live", venue: "backpack", engine_running: false, instruments: [] },
  { type: "event", event: { type: "heartbeat", ts: 5 } },
  {
    type: "preview",
    request_id: "r1",
    preview: {
      preview_id: "p1",
      text: "BUY BTC-USD 0.1 LMT 64000.00",
      action: { type: "place", symbol: "BTC-USD", side: "buy", qty: "10000000", kind: { type: "limit", price: "6400000" } },
      expires_at: 1_733_200_060_000,
    },
  },
  { type: "preview", request_id: "r2", preview: { preview_id: "p2", text: "CANCEL ALL", action: { type: "cancel_all" }, expires_at: 0 } },
  { type: "preview", request_id: "r3", preview: { preview_id: "p3", text: "FLAT", action: { type: "flatten_all" }, expires_at: 0 } },
  { type: "parse_error", request_id: "r4", message: "unknown keyword", position: 2 },
  { type: "notice", kind: "account_reset", message: "engine restarted" },
  { type: "notice", kind: "signed_out", message: "signed out" },
  { type: "session", account_id: "guest", address: null },
  { type: "session", account_id: WALLET_ACCOUNT, address: WALLET_ADDRESS },
  { type: "pong", id: 9 },
];

/** JSON text of `msg` with the field at `key` replaced by `value`. */
function withField(msg: object, key: string, value: unknown): string {
  return JSON.stringify({ ...msg, [key]: value });
}

describe("valid messages", () => {
  test("every Event variant parses from its JSON line to an equal value", () => {
    const tags = new Set(EVENTS.map((e) => e.type));
    expect(tags.size).toBe(11); // Req 1.2: all eleven variants
    for (const event of EVENTS) {
      expect(parseEventLine(JSON.stringify(event))).toEqual({ ok: true, value: event });
    }
  });

  test("every ClientMessage variant parses to an equal value", () => {
    expect(new Set(CLIENT_MESSAGES.map((m) => m.type)).size).toBe(11); // Req 1.7
    for (const msg of CLIENT_MESSAGES) {
      expect(parseClientMessage(JSON.stringify(msg))).toEqual({ ok: true, value: msg });
    }
  });

  test("every Command variant and OrderKind parses", () => {
    expect(new Set(COMMANDS.map((c) => c.type)).size).toBe(8); // Req 1.1
    for (const cmd of COMMANDS) expect(CommandSchema.parse(cmd)).toEqual(cmd);
  });

  test("every ServerMessage variant and PreviewAction parses", () => {
    expect(new Set(SERVER_MESSAGES.map((m) => m.type)).size).toBe(7); // Req 1.8
    for (const msg of SERVER_MESSAGES) expect(ServerMessageSchema.parse(msg)).toEqual(msg);
  });

  test("cancel_all carries the account id on the wire (protocol v2)", () => {
    const line = '{"type":"cancel_all","account_id":"guest"}';
    const cmd = CommandSchema.parse(JSON.parse(line));
    expect(cmd).toEqual({ type: "cancel_all", account_id: "guest" });
    expect(JSON.stringify(cmd)).toBe(line);
  });

  test("unknown keys are stripped, as serde ignores them", () => {
    const result = parseEventLine('{"type":"heartbeat","ts":1,"extra":true}');
    expect(result).toEqual({ ok: true, value: { type: "heartbeat", ts: 1 } });
  });
});

describe("rejected messages", () => {
  const rejectsEvent = (line: string) => {
    const r = parseEventLine(line);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_message");
  };

  test("number-typed prices, quantities, and money", () => {
    rejectsEvent(withField(trade, "price", 6400000));
    rejectsEvent(withField(trade, "qty", 1));
    rejectsEvent(JSON.stringify({ ...EVENTS[9], realized: 0 }));
  });

  test("non-canonical decimal strings", () => {
    for (const bad of ["", "+5", "05", "-0", "00", " 5", "5 ", "1.5", "1e3", "0x10", "--1", "-", "５"]) {
      rejectsEvent(withField(trade, "price", bad));
    }
  });

  test("decimal strings outside the i64 range", () => {
    rejectsEvent(withField(trade, "price", "9223372036854775808"));
    rejectsEvent(withField(trade, "price", "-9223372036854775809"));
    rejectsEvent(withField(trade, "price", "1".repeat(400)));
  });

  test("bad, missing, and non-string tags", () => {
    rejectsEvent('{"type":"Heartbeat","ts":1}');
    rejectsEvent('{"type":"place_order","ts":1}');
    rejectsEvent('{"ts":1}');
    rejectsEvent('{"type":3,"ts":1}');
    expect(parseClientMessage('{"type":"place_order","order_id":"x"}').ok).toBe(false);
  });

  test("bad timeframes", () => {
    for (const tf of ["1M", "2m", "1w", "", 1]) {
      expect(parseClientMessage(JSON.stringify({ type: "subscribe", symbol: "BTC-USD", timeframe: tf })).ok).toBe(false);
    }
  });

  test("bad order ids", () => {
    for (const id of ["", "a".repeat(65), "has space", "semi;colon", "slash/", "é", 5]) {
      expect(parseClientMessage(JSON.stringify({ type: "cancel", request_id: "r", order_id: id })).ok).toBe(false);
    }
    expect(OrderIdSchema.safeParse("a".repeat(64)).success).toBe(true);
    expect(OrderIdSchema.safeParse("Az09_-").success).toBe(true);
  });

  test("bad and missing account ids (Req 1.9, 1.10)", () => {
    for (const id of ["", "a".repeat(65), "guest-1", "w-abc", "has space", "é", null, 5]) {
      expect(CommandSchema.safeParse({ type: "cancel_all", account_id: id }).success).toBe(false);
      rejectsEvent(JSON.stringify({ ...EVENTS[6], account_id: id }));
      expect(ServerMessageSchema.safeParse({ type: "session", account_id: id, address: null }).success).toBe(false);
    }
    expect(CommandSchema.safeParse({ type: "cancel_all" }).success).toBe(false);
    expect(CommandSchema.safeParse({ type: "reset_account" }).success).toBe(false);
    const { account_id: _, ...noAccount } = EVENTS[8] as Extract<Event, { type: "fill" }>;
    rejectsEvent(JSON.stringify(noAccount));
    expect(AccountIdSchema.safeParse("a".repeat(64)).success).toBe(true);
    expect(AccountIdSchema.safeParse(WALLET_ACCOUNT).success).toBe(true);
  });

  test("bad venues and notice kinds", () => {
    const hello = SERVER_MESSAGES[1];
    for (const venue of ["Backpack", "binance", "", 1]) {
      expect(ServerMessageSchema.safeParse({ ...hello, venue }).success).toBe(false);
    }
    const { venue: _, ...noVenue } = hello as Extract<ServerMessage, { type: "hello" }>;
    expect(ServerMessageSchema.safeParse(noVenue).success).toBe(false);
    expect(ServerMessageSchema.safeParse({ type: "notice", kind: "signed_in", message: "" }).success).toBe(false);
  });

  test("integers that are fractional, negative where unsigned, or unsafe", () => {
    rejectsEvent('{"type":"heartbeat","ts":1.5}');
    rejectsEvent('{"type":"pong","id":-1}');
    rejectsEvent('{"type":"heartbeat","ts":9007199254740993}');
    rejectsEvent(JSON.stringify({ ...EVENTS[3], imbalance_bps: 2 ** 31 }));
  });

  test("null where the field is required, and a missing nullable field", () => {
    rejectsEvent(withField(trade, "price", null));
    const { avg_entry: _, ...noAvg } = { ...(EVENTS[10] as Extract<Event, { type: "position" }>) };
    rejectsEvent(JSON.stringify(noAvg));
  });

  test("JSON.parse failures return invalid_json without throwing", () => {
    for (const text of ["", "{", "not json", '{"type":"ping","id":1', "\u0000"]) {
      expect(parseEventLine(text)).toEqual({ ok: false, code: "invalid_json", message: "not valid JSON" });
      expect(parseClientMessage(text)).toEqual({ ok: false, code: "invalid_json", message: "not valid JSON" });
    }
  });

  test("valid JSON that is not an object is invalid_message", () => {
    for (const text of ["null", "1", '"ping"', "[]"]) {
      const r = parseClientMessage(text);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("invalid_message");
    }
  });

  test("error messages name the field and do not echo the value", () => {
    const secret = "9".repeat(30);
    const r = parseEventLine(withField(trade, "price", secret));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("price");
      expect(r.message).not.toContain(secret);
    }
  });
});

describe("bigint helpers", () => {
  test("isCanonicalI64 matches the Rust rule", () => {
    for (const ok of ["0", "1", "-1", "6400000", "9223372036854775807", "-9223372036854775808"]) {
      expect(isCanonicalI64(ok)).toBe(true);
    }
    for (const bad of ["-0", "01", "+1", "1.0", "9223372036854775808", "-9223372036854775809", "1\n"]) {
      expect(isCanonicalI64(bad)).toBe(false);
    }
  });

  test("toBigInt converts exactly beyond 2^53", () => {
    expect(toBigInt("9007199254740993")).toBe(9_007_199_254_740_993n);
    expect(toBigInt("-9223372036854775808")).toBe(I64_MIN);
    expect(() => toBigInt("1.5")).toThrow(RangeError);
    expect(() => toBigInt("9223372036854775808")).toThrow(RangeError);
  });

  test("fromBigInt writes canonical strings and checks the range", () => {
    expect(fromBigInt(0n)).toBe("0");
    expect(fromBigInt(-42n)).toBe("-42");
    expect(fromBigInt(I64_MAX)).toBe("9223372036854775807");
    expect(fromBigInt(I64_MIN)).toBe("-9223372036854775808");
    expect(() => fromBigInt(I64_MAX + 1n)).toThrow(RangeError);
    expect(() => fromBigInt(I64_MIN - 1n)).toThrow(RangeError);
    for (const s of ["0", "-1", "123456789012345678"]) expect(fromBigInt(toBigInt(s))).toBe(s);
    expect(PriceSchema.safeParse(fromBigInt(I64_MIN)).success).toBe(true);
  });

  test("formatDecimal places the decimal point without Number", () => {
    expect(formatDecimal(6_400_000n, 2)).toBe("64000.00");
    expect(formatDecimal("10000000", 8)).toBe("0.10000000");
    expect(formatDecimal(5n, 2)).toBe("0.05");
    expect(formatDecimal(-5n, 2)).toBe("-0.05");
    expect(formatDecimal(-123_456n, 2)).toBe("-1234.56");
    expect(formatDecimal(0n, 10)).toBe("0.0000000000");
    expect(formatDecimal(42n, 0)).toBe("42");
    expect(formatDecimal(I64_MIN, 10)).toBe("-922337203.6854775808");
    expect(formatDecimal(I64_MAX, 10)).toBe("922337203.6854775807");
    expect(formatDecimal(9_007_199_254_740_993n, 2)).toBe("90071992547409.93");
  });

  test("formatDecimal rejects bad inputs", () => {
    expect(() => formatDecimal(1n, -1)).toThrow(RangeError);
    expect(() => formatDecimal(1n, 1.5)).toThrow(RangeError);
    expect(() => formatDecimal("01", 2)).toThrow(RangeError);
  });
});

describe("schema exports", () => {
  test("EventSchema and ClientMessageSchema are usable directly", () => {
    expect(EventSchema.safeParse({ type: "pong", id: 1 }).success).toBe(true);
    expect(ClientMessageSchema.safeParse({ type: "pong", id: 1 }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Protocol v2 (Task 17.3): accounts, Authenticate, Session, venue, and the new notice kinds.
// The golden lines below are written by hand from the expectations in the Rust protocol crate's
// tests (command.rs, event.rs, client.rs, codec.rs), so a drift between the Rust serde output
// and the Zod schemas shows up here (Req 1.3, 1.7 to 1.11).
// ---------------------------------------------------------------------------------------------

const MAX_ACCOUNT_ID = "Z".repeat(64);

const GOLDEN_COMMAND_LINES = [
  '{"type":"cancel_all","account_id":"guest"}',
  '{"type":"reset_account","account_id":"w_abc"}',
  '{"type":"cancel","account_id":"guest","order_id":"o-1"}',
  '{"type":"place_order","account_id":"guest","order_id":"o-1","symbol":"ETH-USD","side":"sell","qty":"250","kind":{"type":"limit","price":"310000"}}',
  `{"type":"cancel_all","account_id":"${MAX_ACCOUNT_ID}"}`,
  `{"type":"reset_account","account_id":"${WALLET_ACCOUNT}"}`,
];

const GOLDEN_EVENT_LINES = [
  '{"type":"order_ack","account_id":"guest","order_id":"o-1","status":"canceled"}',
  '{"type":"order_rejected","account_id":"w_abc","order_id":"o-1","reason":"kill_switch"}',
  '{"type":"fill","account_id":"guest","order_id":"o-1","symbol":"BTC-USD","side":"buy","price":"6400000","qty":"10","fee":"640","remaining":"0","ts":2}',
  '{"type":"position","account_id":"guest","symbol":"BTC-USD","qty":"-10","avg_entry":"6400000","realized":"0","unrealized":"9223372036854775807"}',
  '{"type":"position","account_id":"guest","symbol":"ETH-USD","qty":"0","avg_entry":null,"realized":"0","unrealized":"0"}',
];

const GOLDEN_CLIENT_LINES = [
  '{"type":"authenticate","token":"v1.payload.mac"}',
  '{"type":"cancel_all","request_id":"r4"}',
  '{"type":"reset_account","request_id":"r6"}',
  '{"type":"ping","id":3}',
];

const GOLDEN_SERVER_LINES = [
  '{"type":"hello","protocol_version":2,"data_mode":"replay","venue":null,"engine_running":true,"instruments":[{"symbol":"BTC-USD","short":"BTC","price_decimals":2,"qty_decimals":8}]}',
  '{"type":"hello","protocol_version":2,"data_mode":"live","venue":"backpack","engine_running":false,"instruments":[]}',
  '{"type":"hello","protocol_version":2,"data_mode":"live","venue":"coinbase","engine_running":true,"instruments":[]}',
  '{"type":"session","account_id":"guest","address":null}',
  `{"type":"session","account_id":"${WALLET_ACCOUNT}","address":"${WALLET_ADDRESS}"}`,
  '{"type":"event","event":{"type":"order_ack","account_id":"guest","order_id":"o-9","status":"filled"}}',
  '{"type":"notice","kind":"account_reset","message":"engine restarted"}',
  '{"type":"notice","kind":"auth_failed","message":"invalid token"}',
  '{"type":"notice","kind":"session_expired","message":"session expired"}',
  '{"type":"notice","kind":"signed_out","message":"signed out"}',
];

const BAD_ACCOUNT_IDS: unknown[] = ["", "a".repeat(65), "guest-1", "w-abc", "has space", "guest\n", "é", "a.b", null, 5];

describe("protocol v2 golden lines", () => {
  test("Command lines from the Rust tests parse and keep every field", () => {
    for (const line of GOLDEN_COMMAND_LINES) {
      expect(CommandSchema.parse(JSON.parse(line))).toEqual(JSON.parse(line));
    }
  });

  test("Event lines from the Rust tests parse and keep every field", () => {
    for (const line of GOLDEN_EVENT_LINES) {
      expect(parseEventLine(line)).toEqual({ ok: true, value: JSON.parse(line) });
    }
  });

  test("ClientMessage lines parse and keep every field", () => {
    for (const line of GOLDEN_CLIENT_LINES) {
      expect(parseClientMessage(line)).toEqual({ ok: true, value: JSON.parse(line) });
    }
  });

  test("ServerMessage lines from the Rust tests parse and keep every field", () => {
    for (const line of GOLDEN_SERVER_LINES) {
      expect(ServerMessageSchema.parse(JSON.parse(line))).toEqual(JSON.parse(line));
    }
  });

  test("protocol v1 shapes are rejected", () => {
    const v1Commands = ['{"type":"cancel_all"}', '{"type":"reset_account"}', '{"type":"cancel","order_id":"o-1"}'];
    for (const line of v1Commands) expect(CommandSchema.safeParse(JSON.parse(line)).success).toBe(false);
    expect(parseEventLine('{"type":"order_ack","order_id":"o-1","status":"canceled"}').ok).toBe(false);
    expect(parseEventLine('{"type":"order_rejected","order_id":"o-1","reason":"x"}').ok).toBe(false);
    const v1Hello =
      '{"type":"hello","protocol_version":1,"data_mode":"replay","engine_running":true,"instruments":[]}';
    expect(ServerMessageSchema.safeParse(JSON.parse(v1Hello)).success).toBe(false);
  });
});

describe("protocol v2 schemas", () => {
  test("every order Command needs a valid account_id (Req 1.9, 1.10)", () => {
    const withAccount = COMMANDS.filter((c): c is Extract<Command, { account_id: string }> => "account_id" in c);
    expect(new Set(withAccount.map((c) => c.type))).toEqual(
      new Set(["place_order", "cancel", "cancel_all", "reset_account"]),
    );
    for (const command of withAccount) {
      expect(CommandSchema.safeParse(command).success).toBe(true);
      for (const id of BAD_ACCOUNT_IDS) {
        expect(CommandSchema.safeParse({ ...command, account_id: id }).success).toBe(false);
      }
      const { account_id: _omitted, ...without } = command;
      expect(CommandSchema.safeParse(without).success).toBe(false);
    }
  });

  test("every account Event needs a valid account_id (Req 1.9, 1.10)", () => {
    const withAccount = EVENTS.filter((e): e is Extract<Event, { account_id: string }> => "account_id" in e);
    expect(new Set(withAccount.map((e) => e.type))).toEqual(
      new Set(["order_ack", "order_rejected", "fill", "position"]),
    );
    for (const event of withAccount) {
      expect(EventSchema.safeParse(event).success).toBe(true);
      for (const id of BAD_ACCOUNT_IDS) {
        expect(EventSchema.safeParse({ ...event, account_id: id }).success).toBe(false);
        // The same Event wrapped in a Server_Message is refused too.
        expect(ServerMessageSchema.safeParse({ type: "event", event: { ...event, account_id: id } }).success).toBe(false);
      }
      const { account_id: _omitted, ...without } = event;
      expect(EventSchema.safeParse(without).success).toBe(false);
    }
  });

  test("account ids at the length bounds are accepted, one more is not", () => {
    expect(CommandSchema.safeParse({ type: "cancel_all", account_id: "a" }).success).toBe(true);
    expect(CommandSchema.safeParse({ type: "cancel_all", account_id: MAX_ACCOUNT_ID }).success).toBe(true);
    expect(CommandSchema.safeParse({ type: "cancel_all", account_id: `${MAX_ACCOUNT_ID}Z` }).success).toBe(false);
    expect(CommandSchema.safeParse({ type: "cancel_all", account_id: "" }).success).toBe(false);
  });

  test("the cancel_all and reset_account Commands are struct variants with only account_id", () => {
    expect(JSON.stringify(CommandSchema.parse({ type: "cancel_all", account_id: "guest" }))).toBe(
      '{"type":"cancel_all","account_id":"guest"}',
    );
    expect(JSON.stringify(CommandSchema.parse({ type: "reset_account", account_id: "w_abc" }))).toBe(
      '{"type":"reset_account","account_id":"w_abc"}',
    );
  });

  test("authenticate carries a string token (Req 1.7)", () => {
    const parsed = parseClientMessage('{"type":"authenticate","token":"v1.payload.mac"}');
    expect(parsed).toEqual({ ok: true, value: { type: "authenticate", token: "v1.payload.mac" } });
    // The Rust type accepts any string; the Auth_Service decides whether it is a valid token.
    expect(parseClientMessage('{"type":"authenticate","token":""}').ok).toBe(true);
    expect(parseClientMessage(JSON.stringify({ type: "authenticate", token: "t".repeat(4096) })).ok).toBe(true);
    for (const line of [
      '{"type":"authenticate"}',
      '{"type":"authenticate","token":null}',
      '{"type":"authenticate","token":5}',
      '{"type":"authenticate","token":["a"]}',
    ]) {
      const r = parseClientMessage(line);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("invalid_message");
    }
  });

  test("an authenticate failure message does not echo the token", () => {
    const secret = "s3cret-token-value";
    const r = parseClientMessage(JSON.stringify({ type: "authenticate", token: [secret] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).not.toContain(secret);
  });

  test("account fields on a ClientMessage are dropped, never read (Req 18.5)", () => {
    const extras = { account_id: "w_other", address: WALLET_ADDRESS, wallet: WALLET_ADDRESS };
    const messages: ClientMessage[] = [
      { type: "cancel", request_id: "r", order_id: "o-1" },
      { type: "cancel_all", request_id: "r" },
      { type: "flatten_all", request_id: "r" },
      { type: "reset_account", request_id: "r" },
      { type: "authenticate", token: "t" },
    ];
    for (const message of messages) {
      expect(parseClientMessage(JSON.stringify({ ...message, ...extras }))).toEqual({ ok: true, value: message });
    }
  });

  test("session needs account_id and an address that is a string or null (Req 1.8)", () => {
    const guest = { type: "session", account_id: "guest", address: null };
    expect(ServerMessageSchema.safeParse(guest).success).toBe(true);
    expect(ServerMessageSchema.safeParse({ ...guest, address: WALLET_ADDRESS }).success).toBe(true);
    const { address: _omitted, ...noAddress } = guest;
    expect(ServerMessageSchema.safeParse(noAddress).success).toBe(false);
    for (const address of [5, true, undefined, {}, ["a"]]) {
      expect(ServerMessageSchema.safeParse({ ...guest, address }).success).toBe(false);
    }
    const { account_id: _id, ...noAccount } = guest;
    expect(ServerMessageSchema.safeParse(noAccount).success).toBe(false);
  });

  test("hello names the venue or null (Req 1.11)", () => {
    const hello = { type: "hello", protocol_version: 2, data_mode: "live", engine_running: true, instruments: [] };
    for (const venue of ["coinbase", "backpack", null]) {
      expect(ServerMessageSchema.safeParse({ ...hello, venue }).success).toBe(true);
    }
    expect(ServerMessageSchema.safeParse(hello).success).toBe(false);
    for (const venue of ["Coinbase", "kraken", "", 0, false, undefined]) {
      expect(ServerMessageSchema.safeParse({ ...hello, venue }).success).toBe(false);
    }
  });

  test("every notice kind is accepted, including the three added in v2", () => {
    const kinds = [
      "account_reset",
      "engine_down",
      "engine_up",
      "llm_disabled",
      "auth_failed",
      "session_expired",
      "signed_out",
    ] as const;
    for (const kind of kinds) {
      const message = { type: "notice", kind, message: "m" } as const;
      expect(ServerMessageSchema.parse(message)).toEqual(message);
    }
    for (const kind of ["AuthFailed", "auth-failed", "signed_in", "", null, 1]) {
      expect(ServerMessageSchema.safeParse({ type: "notice", kind, message: "m" }).success).toBe(false);
    }
  });
});

describe("candle indicators history (chart-and-tape-fix, Req 2.6)", () => {
  const candle = { type: "candle", symbol: "BTC-USD", timeframe: "1m", snapshot: true, bars: [bar] };

  test("a candle snapshot parses with and without indicators", () => {
    expect(EventSchema.safeParse(candle).success).toBe(true);
    const withPoints = { ...candle, indicators: [{ t: bar.t, values }, { t: bar.t + 60_000, values }] };
    const r = EventSchema.safeParse(withPoints);
    expect(r.success).toBe(true);
    if (r.success && r.data.type === "candle") expect(r.data.indicators).toHaveLength(2);
    expect(EventSchema.safeParse({ ...candle, indicators: [] }).success).toBe(true);
  });

  test("a malformed indicator point is rejected", () => {
    const bad: unknown[] = [
      { t: "1733200000000", values },
      { t: bar.t },
      { t: bar.t, values: { ...values, ema: "1.5" } },
      { t: 1.5, values },
    ];
    for (const point of bad) {
      expect(EventSchema.safeParse({ ...candle, indicators: [point] }).success).toBe(false);
    }
    expect(EventSchema.safeParse({ ...candle, indicators: "x" }).success).toBe(false);
  });
});
