// Pure mappers from Router records and engine events to stamped JournalRecords (Req 20.1-20.3,
// 20.18, 20.27). The Session_Id is the engine run's id at the moment of enqueue.

import type { Event } from "../protocol.ts";
import { toBigInt } from "../protocol.ts";
import type { RouterJournalRecord } from "../router.ts";
import type { FillRecord, JournalRecord, RejectionRecord } from "./store.ts";

/** Used before the engine has ever started, so every record still has a Session_Id. */
export const NO_SESSION = "no-session";

export interface StampContext {
  readonly sessionId: string | null;
  /** Epoch ms. */
  readonly now: number;
  readonly newId: () => string;
}

export function fromRouterRecord(rec: RouterJournalRecord, ctx: StampContext): JournalRecord {
  const base = {
    record_id: ctx.newId(),
    session_id: ctx.sessionId ?? NO_SESSION,
    account_id: rec.accountId,
    ts: BigInt(Math.trunc(ctx.now)),
    order_id: rec.orderId,
  };
  if (rec.kind === "order") {
    return {
      ...base,
      type: "order",
      source: rec.source,
      symbol: rec.symbol,
      side: rec.side,
      kind: rec.orderKind,
      qty: rec.qty,
      price: rec.price,
    };
  }
  // The risk or router rejection keeps only the reason and a short detail (design J5 columns).
  const parts = [rec.side, rec.symbol, rec.orderKind].filter((p): p is string => p !== null);
  return {
    ...base,
    type: "rejection",
    source: rec.source,
    reason: rec.reason,
    detail: parts.length === 0 ? null : parts.join(" "),
  };
}

export function fromFillEvent(event: Extract<Event, { type: "fill" }>, ctx: StampContext): FillRecord {
  return {
    type: "fill",
    record_id: ctx.newId(),
    session_id: ctx.sessionId ?? NO_SESSION,
    account_id: event.account_id,
    ts: BigInt(Math.trunc(ctx.now)),
    market_ts: BigInt(event.ts),
    order_id: event.order_id,
    symbol: event.symbol,
    side: event.side,
    price: toBigInt(event.price),
    qty: toBigInt(event.qty),
    fee: toBigInt(event.fee),
    remaining: toBigInt(event.remaining),
  };
}

export function fromRejectedEvent(event: Extract<Event, { type: "order_rejected" }>, ctx: StampContext): RejectionRecord {
  return {
    type: "rejection",
    record_id: ctx.newId(),
    session_id: ctx.sessionId ?? NO_SESSION,
    account_id: event.account_id,
    ts: BigInt(Math.trunc(ctx.now)),
    order_id: event.order_id,
    source: "engine",
    reason: event.reason,
    detail: null,
  };
}

/** JSON-safe view: every bigint becomes a decimal string (design endpoint table). */
export function rowToJson(row: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) out[key] = typeof value === "bigint" ? value.toString() : value;
  return out;
}
