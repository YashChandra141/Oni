// Zod schemas that mirror the generated protocol types in shared/protocol/ (design §1, §3).
//
// The Server validates engine stdout lines (EventSchema) and client WebSocket messages
// (ClientMessageSchema) at the boundary (Req 17.3, 17.4; tech.md). The compile-time checks at
// the bottom fail `bun run typecheck` if a schema and its generated type ever drift apart.
//
// Rules copied from the Rust protocol crate:
// - Price, Qty, and Money are canonical i64 decimal strings: optional `-`, no leading zeros,
//   no `-0`, no `+`, no whitespace, within the i64 range (rust/crates/protocol/src/num.rs).
//   JSON numbers are rejected. Convert with `toBigInt`, never `Number` (tech.md).
// - OrderId is 1 to 64 characters of [A-Za-z0-9_-] (types.rs).
// - AccountId is 1 to 64 characters of [A-Za-z0-9_], no `-` (types.rs, Req 1.10). The server
//   builds `guest` or `w_<base58 address>`; the schema accepts any id the engine would.
// - TimeMs and the other integer fields travel as JSON numbers. `z.number().int()` accepts
//   only safe integers, so a value that JavaScript would round is rejected.
// - Unknown object keys are stripped, as serde ignores them (no `deny_unknown_fields`).
//
// Semantic checks (known symbol, qty > 0, replay speed 1..=50) are not here. The engine codec
// and the Server's parser, risk, and gateway modules own them.

import { z } from "zod";
import type {
  AccountId,
  Bar,
  ClientMessage,
  Command,
  DataMode,
  ErrorCode,
  Event,
  IndicatorPoint,
  IndicatorValues,
  InstrumentInfo,
  Level,
  Money,
  NoticeKind,
  OrderId,
  OrderKind,
  OrderPreview,
  OrderStatus,
  Price,
  PreviewAction,
  Qty,
  ServerMessage,
  Side,
  Timeframe,
  Venue,
} from "../../shared/protocol/index.ts";

export type * from "../../shared/protocol/index.ts";

// ---------------------------------------------------------------------------------------------
// i64 decimal strings and bigint helpers
// ---------------------------------------------------------------------------------------------

export const I64_MIN = -(2n ** 63n);
export const I64_MAX = 2n ** 63n - 1n;

/** `0`, or an optional `-` followed by digits without a leading zero. */
const CANONICAL_INT = /^(?:0|-?[1-9][0-9]*)$/;
/** Longest canonical i64 text: "-9223372036854775808". Checked before BigInt sees the string. */
const MAX_I64_CHARS = 20;

/** Whether `s` is the canonical decimal text of an i64, as Rust's `i64::to_string` writes it. */
export function isCanonicalI64(s: string): boolean {
  if (s.length > MAX_I64_CHARS || !CANONICAL_INT.test(s)) return false;
  const n = BigInt(s);
  return n >= I64_MIN && n <= I64_MAX;
}

/** Converts a canonical i64 string (Price, Qty, Money) to bigint. Throws RangeError otherwise. */
export function toBigInt(s: string): bigint {
  if (!isCanonicalI64(s)) throw new RangeError("not a canonical i64 decimal string");
  return BigInt(s);
}

/** Converts a bigint to the canonical i64 wire string. Throws RangeError outside the i64 range. */
export function fromBigInt(b: bigint): string {
  if (b < I64_MIN || b > I64_MAX) throw new RangeError("value is outside the i64 range");
  return b.toString();
}

/**
 * Formats a fixed-point integer for display with exactly `decimals` fraction digits, e.g.
 * `formatDecimal(6400000n, 2) === "64000.00"`. Never goes through Number. A string input must
 * be a canonical i64 string. Throws RangeError for a bad value or a negative/non-integer
 * `decimals`.
 */
export function formatDecimal(value: bigint | string, decimals: number): string {
  if (!Number.isSafeInteger(decimals) || decimals < 0) {
    throw new RangeError("decimals must be a non-negative integer");
  }
  const v = typeof value === "string" ? toBigInt(value) : value;
  if (decimals === 0) return v.toString();
  const negative = v < 0n;
  const digits = (negative ? -v : v).toString().padStart(decimals + 1, "0");
  const cut = digits.length - decimals;
  return `${negative ? "-" : ""}${digits.slice(0, cut)}.${digits.slice(cut)}`;
}

// ---------------------------------------------------------------------------------------------
// Scalar schemas
// ---------------------------------------------------------------------------------------------

const i64String = (name: string) =>
  z.string().refine(isCanonicalI64, { message: `${name} must be a canonical i64 decimal string` });

export const PriceSchema = i64String("Price");
export const QtySchema = i64String("Qty");
export const MoneySchema = i64String("Money");

export const OrderIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, {
  message: "OrderId must be 1 to 64 characters of [A-Za-z0-9_-]",
});

/** Paper account id (Req 1.10). Unlike OrderId, `-` is not allowed. */
export const AccountIdSchema = z.string().regex(/^[A-Za-z0-9_]{1,64}$/, {
  message: "AccountId must be 1 to 64 characters of [A-Za-z0-9_]",
});

/** Unix epoch ms (Rust `TimeMs = i64`), limited to safe integers. */
export const TimeMsSchema = z.number().int();
const u32 = z.number().int().min(0).max(0xffff_ffff);
const i32 = z.number().int().min(-0x8000_0000).max(0x7fff_ffff);
/** Rust u64/usize, limited to the safe-integer part of the range. */
const u64 = z.number().int().min(0);

export const TimeframeSchema = z.enum(["1m", "5m", "15m", "1h", "1d"]);
export const SideSchema = z.enum(["buy", "sell"]);
export const OrderStatusSchema = z.enum(["accepted", "canceled", "filled"]);
export const DataModeSchema = z.enum(["replay", "live"]);
export const VenueSchema = z.enum(["coinbase", "backpack"]);
export const NoticeKindSchema = z.enum([
  "account_reset",
  "engine_down",
  "engine_up",
  "llm_disabled",
  "auth_failed",
  "session_expired",
  "signed_out",
]);
export const ErrorCodeSchema = z.enum([
  "invalid_json",
  "invalid_command",
  "invalid_message",
  "out_of_range",
  "unknown_symbol",
  "invalid_fixture",
  "feed_disconnected",
  "invalid_book_delta",
  "internal",
]);

// ---------------------------------------------------------------------------------------------
// Nested types
// ---------------------------------------------------------------------------------------------

export const OrderKindSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("market") }),
  z.object({ type: z.literal("limit"), price: PriceSchema }),
  z.object({ type: z.literal("stop"), stop_price: PriceSchema }),
]);

export const BarSchema = z.object({
  t: TimeMsSchema,
  open: PriceSchema,
  high: PriceSchema,
  low: PriceSchema,
  close: PriceSchema,
  volume: QtySchema,
});

export const LevelSchema = z.object({ price: PriceSchema, qty: QtySchema });

/** Indicator values are the only floats in the protocol (Req 1.5). */
const indicator = z.number().nullable();
export const IndicatorValuesSchema = z.object({
  ema: indicator,
  sma: indicator,
  vwap: indicator,
  bb_upper: indicator,
  bb_mid: indicator,
  bb_lower: indicator,
  rsi: indicator,
  atr: indicator,
});

/** One indicator sample for a candle history snapshot (chart-and-tape-fix, Req 2.6). */
export const IndicatorPointSchema = z.object({ t: TimeMsSchema, values: IndicatorValuesSchema });

export const InstrumentInfoSchema = z.object({
  symbol: z.string(),
  short: z.string(),
  price_decimals: u32,
  qty_decimals: u32,
});

export const PreviewActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("place"),
    symbol: z.string(),
    side: SideSchema,
    qty: QtySchema,
    kind: OrderKindSchema,
  }),
  z.object({ type: z.literal("cancel_all") }),
  z.object({ type: z.literal("flatten_all") }),
]);

export const OrderPreviewSchema = z.object({
  preview_id: z.string(),
  text: z.string(),
  action: PreviewActionSchema,
  expires_at: TimeMsSchema,
});

// ---------------------------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------------------------

/** Engine → Server, one JSON line each (Req 1.2). */
export const EventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("candle"),
    symbol: z.string(),
    timeframe: TimeframeSchema,
    snapshot: z.boolean(),
    bars: z.array(BarSchema),
    indicators: z.array(IndicatorPointSchema).optional(),
  }),
  z.object({
    type: z.literal("trade"),
    symbol: z.string(),
    price: PriceSchema,
    qty: QtySchema,
    side: SideSchema,
    ts: TimeMsSchema,
  }),
  z.object({
    type: z.literal("book"),
    symbol: z.string(),
    bids: z.array(LevelSchema),
    asks: z.array(LevelSchema),
    spread: PriceSchema.nullable(),
    imbalance_bps: i32,
    ts: TimeMsSchema,
  }),
  z.object({
    type: z.literal("indicators"),
    symbol: z.string(),
    timeframe: TimeframeSchema,
    ts: TimeMsSchema,
    values: IndicatorValuesSchema,
  }),
  z.object({
    type: z.literal("order_ack"),
    account_id: AccountIdSchema,
    order_id: OrderIdSchema,
    status: OrderStatusSchema,
  }),
  z.object({
    type: z.literal("order_rejected"),
    account_id: AccountIdSchema,
    order_id: OrderIdSchema,
    reason: z.string(),
  }),
  z.object({
    type: z.literal("fill"),
    account_id: AccountIdSchema,
    order_id: OrderIdSchema,
    symbol: z.string(),
    side: SideSchema,
    price: PriceSchema,
    qty: QtySchema,
    fee: MoneySchema,
    remaining: QtySchema,
    ts: TimeMsSchema,
  }),
  z.object({
    type: z.literal("position"),
    account_id: AccountIdSchema,
    symbol: z.string(),
    qty: QtySchema,
    avg_entry: PriceSchema.nullable(),
    realized: MoneySchema,
    unrealized: MoneySchema,
  }),
  z.object({ type: z.literal("heartbeat"), ts: TimeMsSchema }),
  z.object({ type: z.literal("pong"), id: u64 }),
  z.object({ type: z.literal("error"), code: ErrorCodeSchema, message: z.string() }),
]);

/** Server → Engine, one JSON line each (Req 1.1). */
export const CommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("subscribe"), symbol: z.string(), timeframe: TimeframeSchema }),
  z.object({ type: z.literal("unsubscribe"), symbol: z.string(), timeframe: TimeframeSchema }),
  z.object({
    type: z.literal("place_order"),
    account_id: AccountIdSchema,
    order_id: OrderIdSchema,
    symbol: z.string(),
    side: SideSchema,
    qty: QtySchema,
    kind: OrderKindSchema,
  }),
  z.object({ type: z.literal("cancel"), account_id: AccountIdSchema, order_id: OrderIdSchema }),
  z.object({ type: z.literal("cancel_all"), account_id: AccountIdSchema }),
  z.object({ type: z.literal("start_replay"), fixture: z.string(), speed: u32 }),
  z.object({ type: z.literal("reset_account"), account_id: AccountIdSchema }),
  z.object({ type: z.literal("ping"), id: u64 }),
]);

/** Client → Server over the WebSocket (Req 17.3). */
export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("subscribe"), symbol: z.string(), timeframe: TimeframeSchema }),
  z.object({ type: z.literal("unsubscribe"), symbol: z.string(), timeframe: TimeframeSchema }),
  z.object({ type: z.literal("command_text"), request_id: z.string(), text: z.string() }),
  z.object({ type: z.literal("confirm"), request_id: z.string(), preview_id: z.string() }),
  z.object({ type: z.literal("discard"), preview_id: z.string() }),
  z.object({ type: z.literal("cancel"), request_id: z.string(), order_id: OrderIdSchema }),
  z.object({ type: z.literal("cancel_all"), request_id: z.string() }),
  z.object({ type: z.literal("flatten_all"), request_id: z.string() }),
  z.object({ type: z.literal("reset_account"), request_id: z.string() }),
  z.object({ type: z.literal("authenticate"), token: z.string() }),
  z.object({ type: z.literal("ping"), id: u64 }),
]);

/** Server → Client over the WebSocket. */
export const ServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    protocol_version: u32,
    data_mode: DataModeSchema,
    venue: VenueSchema.nullable(),
    engine_running: z.boolean(),
    instruments: z.array(InstrumentInfoSchema),
  }),
  z.object({ type: z.literal("event"), event: EventSchema }),
  z.object({ type: z.literal("preview"), request_id: z.string(), preview: OrderPreviewSchema }),
  z.object({
    type: z.literal("parse_error"),
    request_id: z.string(),
    message: z.string(),
    position: u64,
  }),
  z.object({ type: z.literal("notice"), kind: NoticeKindSchema, message: z.string() }),
  z.object({ type: z.literal("session"), account_id: AccountIdSchema, address: z.string().nullable() }),
  z.object({ type: z.literal("pong"), id: u64 }),
]);

// ---------------------------------------------------------------------------------------------
// Line and message parsers (never throw)
// ---------------------------------------------------------------------------------------------

export type ParseFailure = {
  readonly ok: false;
  /** `invalid_json`: not JSON. `invalid_message`: JSON that does not match the schema. */
  readonly code: "invalid_json" | "invalid_message";
  /** Built from schema paths and static text, never from the input value. */
  readonly message: string;
};

export type ParseResult<T> = { readonly ok: true; readonly value: T } | ParseFailure;

const MAX_REPORTED_ISSUES = 3;

function describeIssues(error: z.ZodError): string {
  const parts = error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => {
    const path = issue.path.map(String).join(".");
    return path === "" ? issue.message : `${path}: ${issue.message}`;
  });
  const more = error.issues.length - MAX_REPORTED_ISSUES;
  if (more > 0) parts.push(`and ${more} more`);
  return parts.join("; ");
}

function parseJsonWith<T>(schema: z.ZodType<T>, text: string): ParseResult<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, code: "invalid_json", message: "not valid JSON" };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, code: "invalid_message", message: describeIssues(parsed.error) };
  return { ok: true, value: parsed.data };
}

/** Parses one engine stdout line into an Event. Never throws. */
export function parseEventLine(line: string): ParseResult<Event> {
  return parseJsonWith(EventSchema, line);
}

/** Parses one client WebSocket text message into a ClientMessage (Req 17.3). Never throws. */
export function parseClientMessage(json: string): ParseResult<ClientMessage> {
  return parseJsonWith(ClientMessageSchema, json);
}

// ---------------------------------------------------------------------------------------------
// Compile-time drift checks: each schema's inferred type and the generated type must be
// assignable to each other. A mismatch makes `Assert` fail, which fails `bun run typecheck`.
// ---------------------------------------------------------------------------------------------

type Equivalent<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
/** `true` when the schema's output type and `T` are mutually assignable. */
type Same<S extends z.ZodType, T> = Equivalent<z.infer<S>, T>;

// `Assert` is applied to concrete types here, so each line is checked on its own.
export type ProtocolSchemaChecks = [
  Assert<Same<typeof PriceSchema, Price>>,
  Assert<Same<typeof QtySchema, Qty>>,
  Assert<Same<typeof MoneySchema, Money>>,
  Assert<Same<typeof OrderIdSchema, OrderId>>,
  Assert<Same<typeof AccountIdSchema, AccountId>>,
  Assert<Same<typeof VenueSchema, Venue>>,
  Assert<Same<typeof TimeframeSchema, Timeframe>>,
  Assert<Same<typeof SideSchema, Side>>,
  Assert<Same<typeof OrderStatusSchema, OrderStatus>>,
  Assert<Same<typeof DataModeSchema, DataMode>>,
  Assert<Same<typeof NoticeKindSchema, NoticeKind>>,
  Assert<Same<typeof ErrorCodeSchema, ErrorCode>>,
  Assert<Same<typeof OrderKindSchema, OrderKind>>,
  Assert<Same<typeof BarSchema, Bar>>,
  Assert<Same<typeof LevelSchema, Level>>,
  Assert<Same<typeof IndicatorValuesSchema, IndicatorValues>>,
  Assert<Same<typeof IndicatorPointSchema, IndicatorPoint>>,
  Assert<Same<typeof InstrumentInfoSchema, InstrumentInfo>>,
  Assert<Same<typeof PreviewActionSchema, PreviewAction>>,
  Assert<Same<typeof OrderPreviewSchema, OrderPreview>>,
  Assert<Same<typeof EventSchema, Event>>,
  Assert<Same<typeof CommandSchema, Command>>,
  Assert<Same<typeof ClientMessageSchema, ClientMessage>>,
  Assert<Same<typeof ServerMessageSchema, ServerMessage>>,
];
