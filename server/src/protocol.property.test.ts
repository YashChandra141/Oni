// Property tests for the i64 decimal-string schemas and bigint helpers in protocol.ts. They
// strengthen the fixed cases in protocol.test.ts. Price, Qty, and Money are canonical i64
// strings, as Rust's `i64::to_string` writes them (rust/crates/protocol/src/num.rs).
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  AccountIdSchema,
  ClientMessageSchema,
  CommandSchema,
  EventSchema,
  I64_MAX,
  I64_MIN,
  MoneySchema,
  PriceSchema,
  QtySchema,
  ServerMessageSchema,
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

const NUM_RUNS = 500;
const SCHEMAS = [PriceSchema, QtySchema, MoneySchema] as const;

/** Any i64, with the range ends and the values around zero weighted in. */
const i64Arb = fc.oneof(
  fc.bigInt({ min: I64_MIN, max: I64_MAX }),
  fc.constantFrom(I64_MIN, I64_MIN + 1n, -1n, 0n, 1n, I64_MAX - 1n, I64_MAX),
);

/** Integers outside the i64 range, near the ends and far away. */
const outOfRangeArb = fc.oneof(
  fc.bigInt({ min: I64_MAX + 1n, max: I64_MAX * 4n }),
  fc.bigInt({ min: I64_MIN * 4n, max: I64_MIN - 1n }),
  fc.constantFrom(I64_MAX + 1n, I64_MIN - 1n),
);

const WHITESPACE = [" ", "\t", "\n", "\r", "\v", "\f", "\u00a0", "\u2028", "\ufeff"] as const;

/** Spellings of an i64 that Rust's `i64::to_string` never produces. */
const nonCanonicalArb = fc.oneof(
  // Leading zero: "07", "00", "-07", "007".
  fc.tuple(i64Arb, fc.integer({ min: 1, max: 3 })).map(([n, zeros]) => {
    const z = "0".repeat(zeros);
    return n < 0n ? `-${z}${-n}` : `${z}${n}`;
  }),
  // Plus sign: "+7", "+0", "+-7".
  i64Arb.map((n) => `+${n}`),
  // Negative zero, alone or with digits after it: "-0", "-00", "-01".
  fc.oneof(fc.constant("-0"), fc.nat().map((n) => `-0${n}`)),
  // Whitespace before, after, or both.
  fc
    .tuple(i64Arb, fc.constantFrom(...WHITESPACE), fc.constantFrom("before", "after", "both"))
    .map(([n, ws, where]) => (where === "before" ? ws + n : where === "after" ? `${n}${ws}` : ws + n + ws)),
);

describe("i64 decimal strings (properties)", () => {
  test("fromBigInt output is accepted by every scalar schema and round-trips through toBigInt", () => {
    fc.assert(
      fc.property(i64Arb, (n) => {
        const s = fromBigInt(n);
        expect(isCanonicalI64(s)).toBe(true);
        for (const schema of SCHEMAS) expect(schema.safeParse(s)).toEqual({ success: true, data: s });
        expect(toBigInt(s)).toBe(n);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("toBigInt then fromBigInt returns the same canonical string", () => {
    fc.assert(
      fc.property(i64Arb, (n) => {
        const s = n.toString();
        expect(fromBigInt(toBigInt(s))).toBe(s);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("values outside the i64 range are rejected by fromBigInt, toBigInt, and the schemas", () => {
    fc.assert(
      fc.property(outOfRangeArb, (n) => {
        const s = n.toString();
        expect(() => fromBigInt(n)).toThrow(RangeError);
        expect(() => toBigInt(s)).toThrow(RangeError);
        for (const schema of SCHEMAS) expect(schema.safeParse(s).success).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("non-canonical spellings (leading zero, +, -0, whitespace) are rejected", () => {
    fc.assert(
      fc.property(nonCanonicalArb, (s) => {
        expect(isCanonicalI64(s)).toBe(false);
        expect(() => toBigInt(s)).toThrow(RangeError);
        for (const schema of SCHEMAS) expect(schema.safeParse(s).success).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Protocol v2 (Task 17.3): AccountId, account Commands and Events, Authenticate, Session, Hello
// with a venue, and the new notice kinds. Property P1 (server side): every generated message
// survives `JSON.stringify` and is accepted by its schema with the same value (Req 2.3).
// ---------------------------------------------------------------------------------------------

const ACCOUNT_ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_".split("");
const ORDER_ID_CHARS = [...ACCOUNT_ID_CHARS, "-"];

const TIMEFRAMES = ["1m", "5m", "15m", "1h", "1d"] as const;
const SIDES = ["buy", "sell"] as const;
const ORDER_STATUSES = ["accepted", "canceled", "filled"] as const;
const DATA_MODES = ["replay", "live"] as const;
const VENUES = ["coinbase", "backpack"] as const;
const NOTICE_KINDS = [
  "account_reset",
  "engine_down",
  "engine_up",
  "llm_disabled",
  "auth_failed",
  "session_expired",
  "signed_out",
] as const;
const ERROR_CODES = [
  "invalid_json",
  "invalid_command",
  "invalid_message",
  "out_of_range",
  "unknown_symbol",
  "invalid_fixture",
  "feed_disconnected",
  "invalid_book_delta",
  "internal",
] as const;

/** A string of `minLength` to `maxLength` characters drawn from `chars`. */
const charsArb = (chars: readonly string[], minLength: number, maxLength: number) =>
  fc.array(fc.constantFrom(...chars), { minLength, maxLength }).map((parts) => parts.join(""));

/** The account id rule of Req 1.10, written without the schema's regex. */
function isAccountIdText(s: string): boolean {
  if (s.length < 1 || s.length > 64) return false;
  for (const c of s) if (!ACCOUNT_ID_CHARS.includes(c)) return false;
  return true;
}

/** Valid ids: `guest`, `w_<address-like>`, and any 1 to 64 characters of `[A-Za-z0-9_]`. */
const accountIdArb = fc.oneof(
  fc.constant("guest"),
  charsArb(ACCOUNT_ID_CHARS, 32, 44).map((address) => `w_${address}`),
  charsArb(ACCOUNT_ID_CHARS, 1, 64),
  charsArb(ACCOUNT_ID_CHARS, 64, 64),
);

/** Invalid ids: empty, too long, or with one character outside `[A-Za-z0-9_]`. */
const invalidAccountIdArb = fc.oneof(
  fc.constant(""),
  charsArb(ACCOUNT_ID_CHARS, 65, 80),
  fc
    .tuple(
      charsArb(ACCOUNT_ID_CHARS, 0, 30),
      fc.constantFrom("-", ".", "/", ":", " ", "é", "\n", "\\", '"', "\u0000"),
      charsArb(ACCOUNT_ID_CHARS, 0, 30),
    )
    .map(([head, bad, tail]) => `${head}${bad}${tail}`),
);

/** Any string near the account id rule: printable, binary, valid, invalid, and boundary lengths. */
const accountIdCandidateArb = fc.oneof(
  fc.string({ maxLength: 80 }),
  fc.string({ unit: "binary", maxLength: 80 }),
  accountIdArb,
  invalidAccountIdArb,
  charsArb(ACCOUNT_ID_CHARS, 0, 70),
  charsArb(ORDER_ID_CHARS, 0, 70),
  accountIdArb.map((id) => `${id}\n`),
);

const orderIdArb = charsArb(ORDER_ID_CHARS, 1, 64);
const i64TextArb = i64Arb.map((n) => n.toString());
const timeMsArb = fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER });
const u32Arb = fc.integer({ min: 0, max: 0xffff_ffff });
const u64Arb = fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER });
const textArb = fc.string({ unit: "binary", maxLength: 40 });
const sideArb = fc.constantFrom(...SIDES);
const timeframeArb = fc.constantFrom(...TIMEFRAMES);

const orderKindArb = fc.oneof(
  fc.constant({ type: "market" as const }),
  fc.record({ type: fc.constant("limit" as const), price: i64TextArb }),
  fc.record({ type: fc.constant("stop" as const), stop_price: i64TextArb }),
);

/** The four Commands that carry an account_id (Req 1.9). */
const accountCommandArb = fc.oneof(
  fc.record({
    type: fc.constant("place_order" as const),
    account_id: accountIdArb,
    order_id: orderIdArb,
    symbol: textArb,
    side: sideArb,
    qty: i64TextArb,
    kind: orderKindArb,
  }),
  fc.record({ type: fc.constant("cancel" as const), account_id: accountIdArb, order_id: orderIdArb }),
  fc.record({ type: fc.constant("cancel_all" as const), account_id: accountIdArb }),
  fc.record({ type: fc.constant("reset_account" as const), account_id: accountIdArb }),
);

/** The four Events that carry an account_id (Req 1.9). */
const accountEventArb = fc.oneof(
  fc.record({
    type: fc.constant("order_ack" as const),
    account_id: accountIdArb,
    order_id: orderIdArb,
    status: fc.constantFrom(...ORDER_STATUSES),
  }),
  fc.record({
    type: fc.constant("order_rejected" as const),
    account_id: accountIdArb,
    order_id: orderIdArb,
    reason: textArb,
  }),
  fc.record({
    type: fc.constant("fill" as const),
    account_id: accountIdArb,
    order_id: orderIdArb,
    symbol: textArb,
    side: sideArb,
    price: i64TextArb,
    qty: i64TextArb,
    fee: i64TextArb,
    remaining: i64TextArb,
    ts: timeMsArb,
  }),
  fc.record({
    type: fc.constant("position" as const),
    account_id: accountIdArb,
    symbol: textArb,
    qty: i64TextArb,
    avg_entry: fc.option(i64TextArb, { nil: null }),
    realized: i64TextArb,
    unrealized: i64TextArb,
  }),
);

/** The account Events plus a few Events without an account_id. */
const eventArb = fc.oneof(
  accountEventArb,
  fc.record({ type: fc.constant("heartbeat" as const), ts: timeMsArb }),
  fc.record({ type: fc.constant("pong" as const), id: u64Arb }),
  fc.record({
    type: fc.constant("trade" as const),
    symbol: textArb,
    price: i64TextArb,
    qty: i64TextArb,
    side: sideArb,
    ts: timeMsArb,
  }),
  fc.record({ type: fc.constant("error" as const), code: fc.constantFrom(...ERROR_CODES), message: textArb }),
);

/** Every ClientMessage variant (Req 1.7). */
const clientMessageArb = fc.oneof(
  fc.record({ type: fc.constant("subscribe" as const), symbol: textArb, timeframe: timeframeArb }),
  fc.record({ type: fc.constant("unsubscribe" as const), symbol: textArb, timeframe: timeframeArb }),
  fc.record({ type: fc.constant("command_text" as const), request_id: textArb, text: textArb }),
  fc.record({ type: fc.constant("confirm" as const), request_id: textArb, preview_id: textArb }),
  fc.record({ type: fc.constant("discard" as const), preview_id: textArb }),
  fc.record({ type: fc.constant("cancel" as const), request_id: textArb, order_id: orderIdArb }),
  fc.record({ type: fc.constant("cancel_all" as const), request_id: textArb }),
  fc.record({ type: fc.constant("flatten_all" as const), request_id: textArb }),
  fc.record({ type: fc.constant("reset_account" as const), request_id: textArb }),
  fc.record({ type: fc.constant("authenticate" as const), token: fc.string({ unit: "binary", maxLength: 300 }) }),
  fc.record({ type: fc.constant("ping" as const), id: u64Arb }),
);

const previewActionArb = fc.oneof(
  fc.record({
    type: fc.constant("place" as const),
    symbol: textArb,
    side: sideArb,
    qty: i64TextArb,
    kind: orderKindArb,
  }),
  fc.constant({ type: "cancel_all" as const }),
  fc.constant({ type: "flatten_all" as const }),
);

const instrumentInfoArb = fc.record({
  symbol: textArb,
  short: textArb,
  price_decimals: u32Arb,
  qty_decimals: u32Arb,
});

/** Every ServerMessage variant (Req 1.8, 1.11). `session` has both address forms. */
const serverMessageArb = fc.oneof(
  fc.record({
    type: fc.constant("hello" as const),
    protocol_version: u32Arb,
    data_mode: fc.constantFrom(...DATA_MODES),
    venue: fc.option(fc.constantFrom(...VENUES), { nil: null }),
    engine_running: fc.boolean(),
    instruments: fc.array(instrumentInfoArb, { maxLength: 3 }),
  }),
  fc.record({ type: fc.constant("event" as const), event: eventArb }),
  fc.record({
    type: fc.constant("preview" as const),
    request_id: textArb,
    preview: fc.record({
      preview_id: textArb,
      text: textArb,
      action: previewActionArb,
      expires_at: timeMsArb,
    }),
  }),
  fc.record({
    type: fc.constant("parse_error" as const),
    request_id: textArb,
    message: textArb,
    position: u64Arb,
  }),
  fc.record({
    type: fc.constant("notice" as const),
    kind: fc.constantFrom(...NOTICE_KINDS),
    message: textArb,
  }),
  fc.record({
    type: fc.constant("session" as const),
    account_id: accountIdArb,
    address: fc.option(textArb, { nil: null }),
  }),
  fc.record({ type: fc.constant("pong" as const), id: u64Arb }),
);

describe("protocol v2 (properties)", () => {
  test("AccountIdSchema accepts a string iff it is 1 to 64 characters of [A-Za-z0-9_]", () => {
    fc.assert(
      fc.property(accountIdCandidateArb, (s) => {
        expect(AccountIdSchema.safeParse(s).success).toBe(isAccountIdText(s));
      }),
      { numRuns: 1000 },
    );
  });

  test("every generated valid account id is accepted and every generated invalid one is not", () => {
    fc.assert(
      fc.property(accountIdArb, invalidAccountIdArb, (valid, invalid) => {
        expect(AccountIdSchema.safeParse(valid)).toEqual({ success: true, data: valid });
        expect(AccountIdSchema.safeParse(invalid).success).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("generated account Commands are accepted as JSON.stringify writes them", () => {
    fc.assert(
      fc.property(accountCommandArb, (command: Command) => {
        expect(CommandSchema.parse(JSON.parse(JSON.stringify(command)))).toEqual(command);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("generated Events are accepted as JSON.stringify writes them", () => {
    fc.assert(
      fc.property(eventArb, (event: Event) => {
        expect(parseEventLine(JSON.stringify(event))).toEqual({ ok: true, value: event });
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("an invalid or missing account_id is refused in every account Command, Event, and session", () => {
    fc.assert(
      fc.property(
        accountCommandArb,
        accountEventArb,
        fc.option(invalidAccountIdArb, { nil: null }),
        (command, event, bad) => {
          const withBad = (message: object): Record<string, unknown> => {
            const json: Record<string, unknown> = { ...message };
            if (bad === null) delete json.account_id;
            else json.account_id = bad;
            return json;
          };
          expect(CommandSchema.safeParse(withBad(command)).success).toBe(false);
          expect(EventSchema.safeParse(withBad(event)).success).toBe(false);
          expect(ServerMessageSchema.safeParse({ type: "event", event: withBad(event) }).success).toBe(false);
          expect(ServerMessageSchema.safeParse(withBad({ type: "session", address: null })).success).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  test("ClientMessageSchema accepts every generated ClientMessage as JSON.stringify writes it", () => {
    fc.assert(
      fc.property(clientMessageArb, (message: ClientMessage) => {
        const text = JSON.stringify(message);
        expect(ClientMessageSchema.safeParse(JSON.parse(text)).success).toBe(true);
        expect(parseClientMessage(text)).toEqual({ ok: true, value: message });
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("account fields added to a ClientMessage are dropped, never read (Req 18.5)", () => {
    fc.assert(
      fc.property(clientMessageArb, accountIdArb, fc.option(textArb, { nil: null }), (message, account, address) => {
        const text = JSON.stringify({ ...message, account_id: account, address });
        expect(parseClientMessage(text)).toEqual({ ok: true, value: message });
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("ServerMessageSchema accepts every generated ServerMessage as JSON.stringify writes it", () => {
    fc.assert(
      fc.property(serverMessageArb, (message: ServerMessage) => {
        const parsed = ServerMessageSchema.safeParse(JSON.parse(JSON.stringify(message)));
        expect(parsed.success).toBe(true);
        if (parsed.success) expect(parsed.data).toEqual(message);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
