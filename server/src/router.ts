// Router (design §3 "Router (Req 18, 22)", Decisions A7 and A10).
//
// The ONLY module that writes order Commands (PlaceOrder, Cancel, CancelAll, ResetAccount) to
// the engine (Req 18.1, 18.3, trading-safety rule 2). It holds the supervisor's order sender,
// which main.ts creates once and passes in. `router.isolation.test.ts` fails if any other module
// uses the sender or builds an order Command.
//
// Account derivation (Req 18.5, trading-safety rule 10): every Command's `account_id` comes from
// `origin.session.accountId`, the gateway's verified Connection_Session of the requesting
// connection (`guest` without a wallet session). `SubmitOrder` has no account field, and
// `submit` copies only the known fields, so `account_id` / `accountId` keys on a hostile object
// are ignored.
//
// `submit` check order (the first failure wins; each rejection carries the order id):
//   1 session_expired      wallet session with exp <= now (seconds). Calls `onSessionExpired`
//                          so the gateway downgrades the connection to guest (Req 46.5).
//   2 engine_unavailable   the engine is not running (Req 15.5). Runs before the Risk_Engine, so
//                          it does not consume the connection's rate window.
//   3 invalid_order        unknown symbol, qty or price <= 0 or above i64, bad side or kind.
//   4 Risk_Engine          `checkOrder` with the order's account position and open orders and
//                          the connection's rate window (Req 18.2, 19). The window is stored
//                          back even when the order is rejected, because an attempt counts.
//   then the PlaceOrder is sent. A `false` from the sender (engine went down) is
//   `engine_unavailable`. After a successful send the Router journals the order, records a note
//   in the account cache, and remembers the requester so an engine OrderRejected reaches it.
//
// Journal writes are synchronous in-memory enqueues. A throwing journal is logged and never
// blocks an order (Req 20.8, 20.9).
//
// Cancel, CancelAll, ResetAccount: they act on the session's account only and skip the Risk
// Engine, since they reduce exposure (design "Router"). The kill switch and the rate limit do
// not block them. They still honour `session_expired` and `engine_unavailable`.
//
// FlattenAll: one opposite-side market order of |position| per non-flat symbol of the
// requester's account, each through `submit`, so the kill switch and the limits apply.

import type { Logger, OrderCommand } from "./engine/supervisor.ts";
import { instrumentBySymbol } from "./instruments.ts";
import {
  type AccountId,
  type Event,
  I64_MAX,
  type OrderId,
  type OrderKind,
  OrderIdSchema,
  type Side,
  fromBigInt,
  toBigInt,
} from "./protocol.ts";
import type { RiskLimits } from "./risk/limits.ts";
import { type RateWindow, type RejectReason, type RiskOrderKind, type RiskResult, checkOrder } from "./risk/risk.ts";
import type { AccountView, OrderNote } from "./state/account.ts";
import type { MarketState } from "./state/market.ts";

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

export type OrderSource = "web" | "tui" | "mcp" | "llm";

/** The gateway's Connection_Session, as the Router needs it (structurally a ConnectionSession). */
export interface RouterSession {
  readonly accountId: AccountId;
  readonly address: string | null;
  readonly jti: string | null;
  /** Token expiry in epoch seconds, or null for the guest. */
  readonly exp: number | null;
}

export interface OrderOrigin {
  readonly connectionId: string;
  readonly session: RouterSession;
  readonly source: OrderSource;
}

/** An order request. There is deliberately no account field (Req 18.5). Quantities are lots, prices ticks. */
export interface SubmitOrder {
  readonly symbol: string;
  readonly side: Side;
  readonly qty: bigint;
  readonly kind: RiskOrderKind;
}

export type RouterRejectReason = RejectReason | "engine_unavailable" | "session_expired" | "invalid_order";

export type SubmitResult =
  | { readonly ok: true; readonly orderId: OrderId }
  | { readonly ok: false; readonly orderId: OrderId; readonly reason: RouterRejectReason };

export type ActionResult = { readonly ok: true } | { readonly ok: false; readonly reason: RouterRejectReason };

export type FlattenResult =
  | { readonly ok: true; readonly results: readonly FlattenEntry[] }
  | { readonly ok: false; readonly reason: RouterRejectReason; readonly results: readonly FlattenEntry[] };

export interface FlattenEntry {
  readonly symbol: string;
  readonly result: SubmitResult;
}

export type OrderRejectedEvent = Extract<Event, { type: "order_rejected" }>;

/** The write end of the engine's stdin for order Commands. `supervisor.createOrderSender()` satisfies it. */
export interface RouterSender {
  send(cmd: OrderCommand): boolean;
}

/** A sender for a supervisor that cannot send orders. It always reports the engine as unavailable. */
export const closedOrderSender: RouterSender = Object.freeze({ send: (): boolean => false });

export interface MarketPrices {
  lastPrice(symbol: string): bigint | null;
  bestBid(symbol: string): bigint | null;
  bestAsk(symbol: string): bigint | null;
}

export interface RouterAccounts extends AccountView {
  noteOrder?(accountId: AccountId, orderId: OrderId, note: OrderNote): void;
}

export interface RouterOrderRecord {
  readonly kind: "order";
  readonly accountId: AccountId;
  readonly orderId: OrderId;
  readonly symbol: string;
  readonly side: Side;
  readonly qty: bigint;
  readonly orderKind: "market" | "limit" | "stop";
  /** Limit price or stop price in ticks; null for a market order. */
  readonly price: bigint | null;
  readonly source: OrderSource;
  /** Epoch milliseconds. */
  readonly ts: number;
}

export interface RouterRejectionRecord {
  readonly kind: "rejection";
  readonly accountId: AccountId;
  readonly orderId: OrderId;
  readonly reason: string;
  /** Order fields, null when the input was too malformed to read them. */
  readonly symbol: string | null;
  readonly side: Side | null;
  readonly qty: bigint | null;
  readonly orderKind: "market" | "limit" | "stop" | null;
  readonly price: bigint | null;
  readonly source: OrderSource;
  /** Epoch milliseconds. */
  readonly ts: number;
}

export type RouterJournalRecord = RouterOrderRecord | RouterRejectionRecord;

/** Synchronous in-memory enqueue (Task 11.4 supplies the real queue). Must not await a database. */
export interface RouterJournal {
  enqueue(record: RouterJournalRecord): void;
}

export interface RouterDeps {
  readonly sender: RouterSender;
  readonly engineRunning: () => boolean;
  /** Read on every call, so a test (or a future admin hook) can change it. */
  readonly risk: { limits: RiskLimits; killSwitch: boolean };
  readonly market: MarketPrices;
  readonly accounts: RouterAccounts;
  readonly journal: RouterJournal;
  /** Epoch milliseconds. */
  readonly now: () => number;
  readonly newOrderId: () => OrderId;
  readonly pendingRequests: { set(orderId: string, connectionId: string): void };
  /** The gateway's downgrade hook: the connection becomes guest (Req 46.5). */
  readonly onSessionExpired: (connectionId: string) => void;
  /** Delivers an OrderRejected event to the requesting connection (Req 17.10, 19.7). */
  readonly onRejected: (connectionId: string, event: OrderRejectedEvent) => void;
  readonly logger: Pick<Logger, "info" | "warn" | "error">;
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** Order ids `o_<base36 counter>_<12 random hex chars>`: a valid OrderId (at most 64 chars, [A-Za-z0-9_-]). */
export function createOrderIdGenerator(random: () => string = defaultRandom): () => OrderId {
  let counter = 0;
  return () => {
    counter += 1;
    return `o_${counter.toString(36)}_${random()}`;
  };
}

function defaultRandom(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}

function positivePrice(value: bigint | null | undefined): bigint | null {
  return value === null || value === undefined || value <= 0n ? null : value;
}

/** Reads last trade price and best bid/ask from the market state as bigint ticks. */
export function marketPrices(market: Pick<MarketState, "lastTrade" | "topOfBook">): MarketPrices {
  return {
    lastPrice: (symbol) => {
      const last = market.lastTrade(symbol);
      return last === null ? null : positivePrice(toBigInt(last.price));
    },
    bestBid: (symbol) => {
      const level = market.topOfBook(symbol)?.bid ?? null;
      return level === null ? null : positivePrice(toBigInt(level.price));
    },
    bestAsk: (symbol) => {
      const level = market.topOfBook(symbol)?.ask ?? null;
      return level === null ? null : positivePrice(toBigInt(level.price));
    },
  };
}

function isPrice(value: unknown): value is bigint {
  return typeof value === "bigint" && value > 0n && value <= I64_MAX;
}

function normalizeKind(raw: unknown): RiskOrderKind | null {
  if (typeof raw !== "object" || raw === null) return null;
  const k = raw as { type?: unknown; price?: unknown; stopPrice?: unknown };
  switch (k.type) {
    case "market":
      return { type: "market" };
    case "limit":
      return isPrice(k.price) ? { type: "limit", price: k.price } : null;
    case "stop":
      return isPrice(k.stopPrice) ? { type: "stop", stopPrice: k.stopPrice } : null;
    default:
      return null;
  }
}

/** Copies the known fields of an order request and validates them. Null when invalid. */
function normalizeOrder(input: SubmitOrder): SubmitOrder | null {
  const raw: unknown = input;
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as { symbol?: unknown; side?: unknown; qty?: unknown; kind?: unknown };
  if (typeof r.symbol !== "string" || instrumentBySymbol(r.symbol) === undefined) return null;
  if (r.side !== "buy" && r.side !== "sell") return null;
  if (typeof r.qty !== "bigint" || r.qty <= 0n || r.qty > I64_MAX) return null;
  const kind = normalizeKind(r.kind);
  if (kind === null) return null;
  return { symbol: r.symbol, side: r.side, qty: r.qty, kind };
}

function wireKind(kind: RiskOrderKind): OrderKind {
  switch (kind.type) {
    case "market":
      return { type: "market" };
    case "limit":
      return { type: "limit", price: fromBigInt(kind.price) };
    case "stop":
      return { type: "stop", stop_price: fromBigInt(kind.stopPrice) };
  }
}

function kindPrice(kind: RiskOrderKind): bigint | null {
  switch (kind.type) {
    case "market":
      return null;
    case "limit":
      return kind.price;
    case "stop":
      return kind.stopPrice;
  }
}

/** Best-effort fields of a possibly malformed request, for a rejection record. */
function looseFields(input: SubmitOrder): Pick<RouterRejectionRecord, "symbol" | "side" | "qty" | "orderKind" | "price"> {
  const raw: unknown = input;
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as { symbol?: unknown; side?: unknown; qty?: unknown; kind?: unknown };
  const k = (typeof r.kind === "object" && r.kind !== null ? r.kind : {}) as { type?: unknown; price?: unknown; stopPrice?: unknown };
  const orderKind = k.type === "market" || k.type === "limit" || k.type === "stop" ? k.type : null;
  const rawPrice = orderKind === "limit" ? k.price : orderKind === "stop" ? k.stopPrice : null;
  const inRange = (v: unknown): bigint | null => (typeof v === "bigint" && v >= -I64_MAX && v <= I64_MAX ? v : null);
  return {
    symbol: typeof r.symbol === "string" ? r.symbol.slice(0, 32) : null,
    side: r.side === "buy" || r.side === "sell" ? r.side : null,
    qty: inRange(r.qty),
    orderKind,
    price: inRange(rawPrice),
  };
}

// ---------------------------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------------------------

export class Router {
  readonly #deps: RouterDeps;
  /** connection id → recent order attempts. Keyed by connection, never by account (Req 19.5). */
  readonly #rates = new Map<string, RateWindow>();

  constructor(deps: RouterDeps) {
    this.#deps = deps;
  }

  /** Drops the rate window of a closed connection. */
  forgetConnection(connectionId: string): void {
    this.#rates.delete(connectionId);
  }

  /** Number of connections with a rate window (for tests). */
  get trackedConnections(): number {
    return this.#rates.size;
  }

  submit(input: SubmitOrder, origin: OrderOrigin): SubmitResult {
    const deps = this.#deps;
    const orderId = deps.newOrderId();
    const accountId = origin.session.accountId;
    const fail = (reason: RouterRejectReason): SubmitResult => this.#reject(orderId, origin, input, reason);

    // 1. Wallet session past its expiry (Req 46.5).
    if (this.#expired(origin.session)) {
      this.#expire(origin);
      return fail("session_expired");
    }
    // 2. Engine down (Req 15.5). Before the risk check, so the rate window is untouched.
    if (!deps.engineRunning()) return fail("engine_unavailable");
    // 3. Malformed request.
    const order = normalizeOrder(input);
    if (order === null) return fail("invalid_order");

    // 4. Risk_Engine (Req 18.2). Position and open orders are the order's account's.
    let risk: RiskResult;
    try {
      risk = checkOrder(
        {
          accountId,
          connectionId: origin.connectionId,
          symbol: order.symbol,
          side: order.side,
          qty: order.qty,
          kind: order.kind,
        },
        {
          limits: deps.risk.limits,
          killSwitch: deps.risk.killSwitch,
          positionLots: deps.accounts.positionLots(accountId, order.symbol),
          openOrderCount: deps.accounts.openOrderCount(accountId),
          lastPrice: deps.market.lastPrice(order.symbol),
          bestBid: deps.market.bestBid(order.symbol),
          bestAsk: deps.market.bestAsk(order.symbol),
          rate: this.#rates.get(origin.connectionId) ?? [],
          now: deps.now(),
        },
      );
    } catch (err) {
      // checkOrder throws only for input it cannot judge. Fail closed.
      deps.logger.error(`[router] risk check threw for ${accountId}: ${err instanceof Error ? err.name : "unknown"}`);
      return fail("invalid_order");
    }
    this.#rates.set(origin.connectionId, risk.rate);
    if (!risk.ok) return fail(risk.reason);

    // Approved: send exactly one PlaceOrder with the session's account (Req 18.5).
    const kind = wireKind(order.kind);
    const command: OrderCommand = {
      type: "place_order",
      account_id: accountId,
      order_id: orderId,
      symbol: order.symbol,
      side: order.side,
      qty: fromBigInt(order.qty),
      kind,
    };
    if (!this.#send(command)) return fail("engine_unavailable");

    this.#journal({
      kind: "order",
      accountId,
      orderId,
      symbol: order.symbol,
      side: order.side,
      qty: order.qty,
      orderKind: order.kind.type,
      price: kindPrice(order.kind),
      source: origin.source,
      ts: deps.now(),
    });
    try {
      deps.accounts.noteOrder?.(accountId, orderId, { symbol: order.symbol, side: order.side, kind, qty: order.qty });
    } catch (err) {
      deps.logger.warn(`[router] noting order ${orderId} failed: ${err instanceof Error ? err.name : "unknown"}`);
    }
    deps.pendingRequests.set(orderId, origin.connectionId);
    return { ok: true, orderId };
  }

  /** Cancels one open order of the requester's account. Not subject to risk limits. */
  cancel(orderId: OrderId, origin: OrderOrigin): ActionResult {
    const gate = this.#gate(origin);
    if (gate !== null) return gate;
    if (!OrderIdSchema.safeParse(orderId).success) return { ok: false, reason: "invalid_order" };
    const sent = this.#send({ type: "cancel", account_id: origin.session.accountId, order_id: orderId });
    if (!sent) return { ok: false, reason: "engine_unavailable" };
    // An engine OrderRejected for this id (unknown or foreign order) goes to the requester.
    this.#deps.pendingRequests.set(orderId, origin.connectionId);
    return { ok: true };
  }

  /** Cancels every open order of the requester's account. Not subject to risk limits. */
  cancelAll(origin: OrderOrigin): ActionResult {
    const gate = this.#gate(origin);
    if (gate !== null) return gate;
    const sent = this.#send({ type: "cancel_all", account_id: origin.session.accountId });
    return sent ? { ok: true } : { ok: false, reason: "engine_unavailable" };
  }

  /** Resets the requester's account (a guest resets the shared guest account). Not subject to risk limits. */
  resetAccount(origin: OrderOrigin): ActionResult {
    const gate = this.#gate(origin);
    if (gate !== null) return gate;
    const sent = this.#send({ type: "reset_account", account_id: origin.session.accountId });
    return sent ? { ok: true } : { ok: false, reason: "engine_unavailable" };
  }

  /**
   * One opposite-side market order of |position| per non-flat symbol of the requester's account.
   * Each goes through `submit`, so the Risk_Engine (including the kill switch) applies.
   */
  flattenAll(origin: OrderOrigin): FlattenResult {
    const gate = this.#gate(origin);
    if (gate !== null) return { ok: false, reason: gate.reason, results: [] };
    const results: FlattenEntry[] = [];
    for (const position of this.#deps.accounts.positions(origin.session.accountId)) {
      if (position.qty === 0n) continue;
      const long = position.qty > 0n;
      const result = this.submit(
        {
          symbol: position.symbol,
          side: long ? "sell" : "buy",
          qty: long ? position.qty : -position.qty,
          kind: { type: "market" },
        },
        origin,
      );
      results.push({ symbol: position.symbol, result });
    }
    const failed = results.find((entry) => !entry.result.ok);
    if (failed !== undefined && !failed.result.ok) return { ok: false, reason: failed.result.reason, results };
    return { ok: true, results };
  }

  // -------------------------------------------------------------------------------------------

  #expired(session: RouterSession): boolean {
    return session.exp !== null && Math.floor(this.#deps.now() / 1000) >= session.exp;
  }

  #expire(origin: OrderOrigin): void {
    try {
      this.#deps.onSessionExpired(origin.connectionId);
    } catch (err) {
      this.#deps.logger.error(`[router] session-expired hook failed: ${err instanceof Error ? err.name : "unknown"}`);
    }
  }

  /** The checks shared by cancel, cancel-all, reset, and flatten-all. Null means go on. */
  #gate(origin: OrderOrigin): { readonly ok: false; readonly reason: RouterRejectReason } | null {
    if (this.#expired(origin.session)) {
      this.#expire(origin);
      return { ok: false, reason: "session_expired" };
    }
    if (!this.#deps.engineRunning()) return { ok: false, reason: "engine_unavailable" };
    return null;
  }

  /** The single place an order Command leaves the Router. */
  #send(command: OrderCommand): boolean {
    try {
      return this.#deps.sender.send(command);
    } catch (err) {
      this.#deps.logger.error(`[router] sending ${command.type} failed: ${err instanceof Error ? err.name : "unknown"}`);
      return false;
    }
  }

  #journal(record: RouterJournalRecord): void {
    try {
      this.#deps.journal.enqueue(record);
    } catch (err) {
      // Never block trading on the journal (Req 20.8, 20.9).
      this.#deps.logger.error(`[router] journal enqueue failed: ${err instanceof Error ? err.name : "unknown"}`);
    }
  }

  #reject(orderId: OrderId, origin: OrderOrigin, input: SubmitOrder, reason: RouterRejectReason): SubmitResult {
    const accountId = origin.session.accountId;
    this.#journal({
      kind: "rejection",
      accountId,
      orderId,
      reason,
      ...looseFields(input),
      source: origin.source,
      ts: this.#deps.now(),
    });
    this.#deps.logger.info(`[router] order ${orderId} rejected for ${accountId}: ${reason}`);
    try {
      this.#deps.onRejected(origin.connectionId, { type: "order_rejected", account_id: accountId, order_id: orderId, reason });
    } catch (err) {
      this.#deps.logger.error(`[router] rejection hook failed: ${err instanceof Error ? err.name : "unknown"}`);
    }
    return { ok: false, orderId, reason };
  }
}
