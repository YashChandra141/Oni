// Pure helpers for order entry, the command bar, and the account panels (Task 12.3, Req 22, 28,
// 30, 31). No DOM and no store access. Price, Qty, and Money values are decimal strings of integer
// counts; BigInt is used for every conversion and sum, never Number.

import type { ClientMessage, Venue } from "../../shared/protocol/index";
import { formatUnits } from "./format";

/** Fixed internal decimals (tech.md): 2 for prices, 8 for quantities. Used before `hello`. */
export const DEFAULT_PRICE_DECIMALS = 2;
export const DEFAULT_QTY_DECIMALS = 8;
/** Money is in units of 10^-10 USD (shared/protocol/Money.ts). */
export const MONEY_DECIMALS = 10;
/** Most submitted command texts kept (Req 31.3). */
export const MAX_HISTORY = 50;
/** How long the server keeps a preview (server PreviewStore: 60 s). */
export const PREVIEW_TTL_MS = 60_000;

const I64_MAX = 9_223_372_036_854_775_807n;
const POSITIVE_INTEGER = /^[1-9]\d*$/;
const DECIMAL = /^(\d+)(?:\.(\d+))?$/;
const INTEGER = /^-?\d+$/;

// ---------------------------------------------------------------------------------------------
// Request ids and message builders

let requestCounter = 0;

/** A fresh request id, unique within this page session. */
export function nextRequestId(): string {
  requestCounter += 1;
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `w${requestCounter.toString(36)}-${random}`;
}

export function commandTextMessage(
  requestId: string,
  text: string,
  venue: Venue | null = null,
): ClientMessage {
  return { type: "command_text", request_id: requestId, text, venue };
}

export function confirmMessage(requestId: string, previewId: string): ClientMessage {
  return { type: "confirm", request_id: requestId, preview_id: previewId };
}

export function discardMessage(previewId: string): ClientMessage {
  return { type: "discard", preview_id: previewId };
}

export function cancelMessage(requestId: string, orderId: string): ClientMessage {
  return { type: "cancel", request_id: requestId, order_id: orderId };
}

export function cancelAllMessage(requestId: string): ClientMessage {
  return { type: "cancel_all", request_id: requestId };
}

export function flattenAllMessage(requestId: string): ClientMessage {
  return { type: "flatten_all", request_id: requestId };
}

// ---------------------------------------------------------------------------------------------
// Decimals

/**
 * Parses a typed decimal ("0.1", "2") into an integer count of 10^-decimals units, as a decimal
 * string. Null when the text is not a positive decimal, has more fraction digits than
 * `decimals`, or exceeds the i64 range.
 */
export function parseDecimalUnits(text: string, decimals: number): string | null {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) return null;
  const match = DECIMAL.exec(text.trim());
  if (match === null) return null;
  const whole = match[1] ?? "";
  const frac = match[2] ?? "";
  if (frac.length > decimals) return null;
  const units = BigInt(whole + frac.padEnd(decimals, "0"));
  if (units <= 0n || units > I64_MAX) return null;
  return units.toString();
}

/** `formatUnits` with trailing fraction zeros removed ("0.10000000" → "0.1", "1.00" → "1"). */
export function formatUnitsTrimmed(raw: string, decimals: number): string | null {
  const fixed = formatUnits(raw, decimals);
  if (fixed === null) return null;
  if (decimals === 0) return fixed;
  return fixed.replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * Formats Money (10^-10 USD) with `places` fraction digits, truncating toward zero, e.g.
 * `"123456789012"` → `"12.34"`. `"—"` when `raw` is missing or not an integer string.
 */
export function formatMoney(raw: string | undefined, places = 2): string {
  if (raw === undefined || !INTEGER.test(raw)) return "—";
  if (!Number.isInteger(places) || places < 0 || places > MONEY_DECIMALS) return "—";
  const value = BigInt(raw);
  const abs = value < 0n ? -value : value;
  const truncated = abs / 10n ** BigInt(MONEY_DECIMALS - places);
  const text = formatUnits(truncated.toString(), places) ?? "—";
  return value < 0n && truncated > 0n ? `-${text}` : text;
}

/** The sign of a Money string: -1, 0, or 1 (0 for anything that is not an integer string). */
export function moneySign(raw: string | undefined): -1 | 0 | 1 {
  if (raw === undefined || !INTEGER.test(raw)) return 0;
  const value = BigInt(raw);
  return value < 0n ? -1 : value > 0n ? 1 : 0;
}

/** Tailwind text class for a P&L value: buy color for gains, sell color for losses. */
export function pnlClass(raw: string | undefined): string {
  const sign = moneySign(raw);
  if (sign > 0) return "text-buy";
  if (sign < 0) return "text-sell";
  return "text-phosphor-dim";
}

// ---------------------------------------------------------------------------------------------
// Order ticket (Req 30.2)

export interface TicketInput {
  readonly symbol: string;
  /** Limit price in ticks; null means a market order. */
  readonly price: string | null;
  /** Quantity in lots. */
  readonly qty: string | null;
}

export interface InstrumentDecimals {
  readonly priceDecimals: number;
  readonly qtyDecimals: number;
}

export type TicketResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: string };

/**
 * Canonical command text for a ticket, in the form the server's Command_Formatter prints and its
 * Command_Parser accepts: `BUY BTC-USD 0.1 LMT 64000.00` or, with no price, `BUY BTC-USD 0.1`.
 * The quantity has trailing zeros trimmed; the price always has the instrument's price decimals.
 * An incomplete or invalid ticket gives an error and no text.
 */
export function ticketToCommandText(
  ticket: TicketInput,
  side: "buy" | "sell",
  decimals: InstrumentDecimals = { priceDecimals: DEFAULT_PRICE_DECIMALS, qtyDecimals: DEFAULT_QTY_DECIMALS },
): TicketResult {
  if (!/^[A-Z0-9]+-[A-Z0-9]+$/.test(ticket.symbol)) return { ok: false, error: "no symbol selected" };
  if (ticket.qty === null || !POSITIVE_INTEGER.test(ticket.qty) || BigInt(ticket.qty) > I64_MAX) {
    return { ok: false, error: "enter a quantity" };
  }
  const qty = formatUnitsTrimmed(ticket.qty, decimals.qtyDecimals);
  if (qty === null) return { ok: false, error: "enter a quantity" };
  const head = `${side === "buy" ? "BUY" : "SELL"} ${ticket.symbol} ${qty}`;
  if (ticket.price === null) return { ok: true, text: head };
  if (!POSITIVE_INTEGER.test(ticket.price) || BigInt(ticket.price) > I64_MAX) {
    return { ok: false, error: "invalid limit price" };
  }
  const price = formatUnits(ticket.price, decimals.priceDecimals);
  if (price === null) return { ok: false, error: "invalid limit price" };
  return { ok: true, text: `${head} LMT ${price}` };
}

// ---------------------------------------------------------------------------------------------
// Full order ticket (Task 14.6, Req 24)

export type TicketKind = "limit" | "market" | "stop" | "twap";

/** TWAP bounds, as the server's Command_Parser enforces them. */
export const TWAP_MIN_SLICES = 2;
export const TWAP_MAX_SLICES = 20;
export const TWAP_MIN_INTERVAL_S = 5;
export const TWAP_MAX_INTERVAL_S = 3_600;

export const SLIDER_STEPS: readonly number[] = [0, 25, 50, 75, 100];

export interface FullTicket {
  readonly symbol: string;
  readonly side: "buy" | "sell";
  readonly kind: TicketKind;
  /** Limit or stop price in ticks; ignored for market and TWAP. */
  readonly price: string | null;
  /** Quantity in lots. */
  readonly qty: string | null;
  readonly slices: string;
  readonly intervalS: string;
}

/**
 * Canonical command text of the ticket: `BUY BTC-USD 0.1 LMT 64000.00`, `SELL BTC-USD 0.1 STP
 * 60000.00`, `BUY BTC-USD 0.1`, or `BUY BTC-USD 1 TWAP 4 60`.
 */
export function buildTicketCommand(ticket: FullTicket, decimals: InstrumentDecimals): TicketResult {
  if (ticket.kind === "limit" || ticket.kind === "stop") {
    if (ticket.price === null) return { ok: false, error: "enter a price" };
    const base = ticketToCommandText(
      { symbol: ticket.symbol, price: ticket.price, qty: ticket.qty },
      ticket.side,
      decimals,
    );
    if (!base.ok || ticket.kind === "limit") return base;
    return { ok: true, text: base.text.replace(/ LMT /, " STP ") };
  }
  const base = ticketToCommandText({ symbol: ticket.symbol, price: null, qty: ticket.qty }, ticket.side, decimals);
  if (!base.ok || ticket.kind === "market") return base;
  if (!/^\d{1,2}$/.test(ticket.slices)) return { ok: false, error: "invalid slice count" };
  const slices = Number(ticket.slices);
  if (slices < TWAP_MIN_SLICES || slices > TWAP_MAX_SLICES) {
    return { ok: false, error: `slices must be ${TWAP_MIN_SLICES} to ${TWAP_MAX_SLICES}` };
  }
  if (!/^\d{1,4}$/.test(ticket.intervalS)) return { ok: false, error: "invalid interval" };
  const interval = Number(ticket.intervalS);
  if (interval < TWAP_MIN_INTERVAL_S || interval > TWAP_MAX_INTERVAL_S) {
    return { ok: false, error: `interval must be ${TWAP_MIN_INTERVAL_S} to ${TWAP_MAX_INTERVAL_S} seconds` };
  }
  return { ok: true, text: `${base.text} TWAP ${slices} ${interval}` };
}

/** Notional in Money (10^-10 USD) of `qty` lots at `price` ticks; null on bad input. */
export function notionalMoney(
  price: string | null,
  qty: string | null,
  decimals: InstrumentDecimals,
): bigint | null {
  if (price === null || qty === null || !INTEGER.test(price) || !INTEGER.test(qty)) return null;
  const scale = MONEY_DECIMALS - decimals.priceDecimals - decimals.qtyDecimals;
  if (scale < 0) return null;
  return BigInt(price) * BigInt(qty) * 10n ** BigInt(scale);
}

/**
 * Lots for a slider at `percent`: a buy takes percent of `freeBalance` (Money) at `price` ticks,
 * a sell takes percent of the long `position` lots. Rounded down; null when it cannot be computed.
 */
export function sliderQty(
  side: "buy" | "sell",
  percent: number,
  price: string | null,
  freeBalance: string | undefined,
  position: string | undefined,
  decimals: InstrumentDecimals,
): string | null {
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) return null;
  const pct = BigInt(percent);
  if (side === "sell") {
    const held = position !== undefined && INTEGER.test(position) ? BigInt(position) : 0n;
    return held > 0n ? ((held * pct) / 100n).toString() : "0";
  }
  const scale = MONEY_DECIMALS - decimals.priceDecimals - decimals.qtyDecimals;
  if (scale < 0 || price === null || !POSITIVE_INTEGER.test(price)) return null;
  if (freeBalance === undefined || !INTEGER.test(freeBalance)) return null;
  const free = BigInt(freeBalance);
  if (free <= 0n) return "0";
  const perLot = BigInt(price) * 10n ** BigInt(scale);
  return ((free * pct) / 100n / perLot).toString();
}

// ---------------------------------------------------------------------------------------------
// Command history (Req 31.3)

/** Appends a submitted text: blank text is ignored, a repeat of the last entry is not added. */
export function pushHistory(history: readonly string[], text: string): readonly string[] {
  if (text.trim().length === 0) return history;
  if (history[history.length - 1] === text) return history;
  const next = [...history, text];
  return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
}

export interface HistoryStep {
  /** Position in the history after the step; null when back at the draft the user was typing. */
  readonly index: number | null;
  /** The text to show, or null to restore the draft. */
  readonly text: string | null;
}

/**
 * One Up ("prev") or Down ("next") step. `history` is oldest first and `index` is the current
 * position (null when not browsing). Up from the draft goes to the newest entry and stops at the
 * oldest; Down past the newest entry returns to the draft (`text: null`).
 */
export function historyStep(
  history: readonly string[],
  index: number | null,
  direction: "prev" | "next",
): HistoryStep {
  if (history.length === 0) return { index: null, text: null };
  if (direction === "prev") {
    const target = index === null ? history.length - 1 : Math.max(0, Math.min(index, history.length - 1) - 1);
    return { index: target, text: history[target] ?? null };
  }
  if (index === null) return { index: null, text: null };
  const target = index + 1;
  if (target >= history.length) return { index: null, text: null };
  return { index: target, text: history[target] ?? null };
}

// ---------------------------------------------------------------------------------------------
// Preview countdown (Req 22.1)

/**
 * The time (epoch ms) at which the preview stops being confirmable on this client. Trusts the
 * server's `expires_at` when it is within the server's TTL of `firstSeenMs`; otherwise (clock
 * skew between server and browser) falls back to `firstSeenMs + PREVIEW_TTL_MS`.
 */
export function previewDeadline(expiresAt: number, firstSeenMs: number): number {
  const remaining = expiresAt - firstSeenMs;
  if (Number.isFinite(remaining) && remaining > 0 && remaining <= PREVIEW_TTL_MS + 5_000) return expiresAt;
  return firstSeenMs + PREVIEW_TTL_MS;
}

/** Whole seconds left (rounded up), at least 0. */
export function previewSecondsLeft(deadlineMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
}

// ---------------------------------------------------------------------------------------------
// P&L totals (Req 28.1)

/** Sum of Money strings with BigInt; entries that are not integer strings count as 0. */
export function sumMoney(values: Iterable<string>): string {
  let total = 0n;
  for (const value of values) if (INTEGER.test(value)) total += BigInt(value);
  return total.toString();
}

export function unrealizedTotal(
  positions: Readonly<Record<string, { readonly unrealized: string }>>,
): string {
  return sumMoney(Object.values(positions).map((row) => row.unrealized));
}

export function realizedTotal(
  rows: Readonly<Record<string, { readonly realized: string }>>,
): string {
  return sumMoney(Object.values(rows).map((row) => row.realized));
}

/** Adds two non-negative or signed integer strings with BigInt (invalid input counts as 0). */
export function addUnits(a: string, b: string): string {
  return ((INTEGER.test(a) ? BigInt(a) : 0n) + (INTEGER.test(b) ? BigInt(b) : 0n)).toString();
}

// ---------------------------------------------------------------------------------------------
// Labels

/** Headline of a preview dialog for the preview's action. */
export function previewActionLabel(action: { readonly type: "place" | "twap" | "cancel_all" | "flatten_all" }): string {
  switch (action.type) {
    case "place":
      return "PLACE PAPER ORDER";
    // The web UI has no TWAP entry yet (Task 14.9 adds it); the label keeps the switch total.
    case "twap":
      return "PLACE PAPER TWAP";
    case "cancel_all":
      return "CANCEL ALL OPEN ORDERS";
    case "flatten_all":
      return "FLATTEN ALL POSITIONS";
  }
}

/** Short order type label for the open orders table. */
export function orderKindLabel(kind: "market" | "limit" | "stop" | null): string {
  switch (kind) {
    case "market":
      return "MKT";
    case "limit":
      return "LMT";
    case "stop":
      return "STP";
    case null:
      return "—";
  }
}

/** A rejection reason as text: `max_order_value` reads as `max order value` (Req 30.6). */
export function rejectionText(reason: string): string {
  return reason.replace(/_/g, " ");
}
