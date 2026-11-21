// AccountState (design §3 `state/account.ts`): the server's cache of every Paper_Account's
// positions and open orders, fed by engine events (Req 14.1, 14.2).
//
// - Positions per (AccountId, symbol) from `Position` events. Each event replaces the entry. A
//   flat position (qty 0) is dropped, so `positions(accountId)` returns only non-flat entries.
// - Open orders per AccountId: an order opens on `OrderAck accepted`, `Fill` updates its
//   filled/remaining quantity, `OrderAck filled|canceled` removes it. `OrderRejected` never
//   changes an open order (the engine rejects a cancel of an unknown or foreign order and keeps
//   the order open, Req 11.9, 14.6); it only discards the note of an order that never opened.
// - `noteOrder` is called by the Router when it sends a PlaceOrder, so open-order rows can carry
//   side, kind, and original quantity for the UI and REST `/positions`. Notes are held until the
//   engine's ack arrives (or the order is rejected) and are bounded.
// - `clear()` empties every account (Req 15.7: an engine restart starts every account flat).
//
// Bounds: at most MAX_ACCOUNTS accounts (matches the engine's 1,000, Req 14.5) and
// MAX_OPEN_ORDERS_PER_ACCOUNT open orders (and pending notes) per account. Past a cap the
// oldest entry is dropped and a warning is logged; the engine remains the source of truth.
//
// All prices, quantities, and money are BigInt from the wire's decimal strings, never Number.
// Pure: no I/O, no timers. Getters return copies.

import type { Logger } from "../engine/supervisor.ts";
import type { AccountId, Event, OrderId, OrderKind, Side } from "../protocol.ts";
import { toBigInt } from "../protocol.ts";

export const MAX_ACCOUNTS = 1_000;
export const MAX_OPEN_ORDERS_PER_ACCOUNT = 1_000;

export interface PositionRow {
  readonly symbol: string;
  /** Signed quantity in lots, never 0 in `positions()` output. */
  readonly qty: bigint;
  /** Average entry price in ticks, or null when the engine sent none. */
  readonly avgEntry: bigint | null;
  readonly realized: bigint;
  readonly unrealized: bigint;
}

/** Latest Balance event of one account, in Money units (10^-10 USD). */
export interface BalanceRow {
  readonly paperBalance: bigint;
  readonly freeBalance: bigint;
  readonly equity: bigint;
}

export interface OrderNote {
  readonly symbol: string;
  readonly side: Side;
  readonly kind: OrderKind;
  readonly qty: bigint;
}

export interface OpenOrderRow {
  readonly orderId: OrderId;
  readonly symbol: string;
  /** Null when neither a note nor a fill told the cache. */
  readonly side: Side | null;
  readonly kind: OrderKind | null;
  /** Original quantity from the note, or null when unknown. */
  readonly qty: bigint | null;
  readonly filled: bigint;
  /** Remaining quantity from the latest Fill, or null before any fill without a note. */
  readonly remaining: bigint | null;
}

/** What the Router reads from the cache (risk context and flatten-all). */
export interface AccountView {
  /** Signed position of the account in the symbol, in lots (0n when flat or unknown). */
  positionLots(accountId: AccountId, symbol: string): bigint;
  /** Number of open orders of the account. */
  openOrderCount(accountId: AccountId): number;
  /** Non-flat positions of the account. */
  positions(accountId: AccountId): PositionRow[];
}

export function createEmptyAccountView(): AccountView {
  return { positionLots: () => 0n, openOrderCount: () => 0, positions: () => [] };
}

interface OpenOrder {
  readonly orderId: OrderId;
  symbol: string;
  side: Side | null;
  kind: OrderKind | null;
  qty: bigint | null;
  filled: bigint;
  remaining: bigint | null;
}

interface AccountEntry {
  readonly positions: Map<string, PositionRow>;
  /** Insertion order is acceptance order. */
  readonly orders: Map<OrderId, OpenOrder>;
  readonly notes: Map<OrderId, OrderNote>;
}

type AccountEvent = Extract<Event, { type: "order_ack" | "order_rejected" | "fill" | "position" }>;

export interface AccountStateOptions {
  readonly logger?: Pick<Logger, "info" | "warn">;
  readonly maxAccounts?: number;
  readonly maxOpenOrdersPerAccount?: number;
}

export class AccountState implements AccountView {
  readonly #accounts = new Map<AccountId, AccountEntry>();
  readonly #balances = new Map<AccountId, BalanceRow>();
  readonly #logger: Pick<Logger, "info" | "warn"> | undefined;
  readonly #maxAccounts: number;
  readonly #maxOrders: number;

  constructor(options: AccountStateOptions = {}) {
    this.#logger = options.logger;
    this.#maxAccounts = options.maxAccounts ?? MAX_ACCOUNTS;
    this.#maxOrders = options.maxOpenOrdersPerAccount ?? MAX_OPEN_ORDERS_PER_ACCOUNT;
  }

  /** Number of accounts currently tracked. */
  get size(): number {
    return this.#accounts.size;
  }

  /** Applies one engine event. Events that are not account events are ignored. */
  apply(event: Event): void {
    switch (event.type) {
      case "position":
        this.#applyPosition(event);
        return;
      case "balance":
        if (!this.#balances.has(event.account_id) && this.#balances.size >= this.#maxAccounts) {
          const oldest = this.#balances.keys().next();
          if (!oldest.done) this.#balances.delete(oldest.value);
        }
        this.#balances.set(event.account_id, {
          paperBalance: toBigInt(event.paper_balance),
          freeBalance: toBigInt(event.free_balance),
          equity: toBigInt(event.equity),
        });
        return;
      case "order_ack":
        this.#applyAck(event);
        return;
      case "fill":
        this.#applyFill(event);
        return;
      case "order_rejected":
        this.#applyRejected(event);
        return;
      default:
        return;
    }
  }

  /** Records what the Router knows about an order it just sent, for the ack that follows. */
  noteOrder(accountId: AccountId, orderId: OrderId, note: OrderNote): void {
    const entry = this.#entry(accountId, true);
    if (entry === undefined) return;
    entry.notes.delete(orderId);
    entry.notes.set(orderId, note);
    this.#trim(entry.notes, accountId, "pending order notes");
  }

  positionLots(accountId: AccountId, symbol: string): bigint {
    return this.#accounts.get(accountId)?.positions.get(symbol)?.qty ?? 0n;
  }

  openOrderCount(accountId: AccountId): number {
    return this.#accounts.get(accountId)?.orders.size ?? 0;
  }

  positions(accountId: AccountId): PositionRow[] {
    const entry = this.#accounts.get(accountId);
    return entry === undefined ? [] : [...entry.positions.values()].map((p) => ({ ...p }));
  }

  /** Open orders of the account in acceptance order. */
  openOrders(accountId: AccountId): OpenOrderRow[] {
    const entry = this.#accounts.get(accountId);
    if (entry === undefined) return [];
    return [...entry.orders.values()].map((o) => ({
      orderId: o.orderId,
      symbol: o.symbol,
      side: o.side,
      kind: o.kind === null ? null : { ...o.kind },
      qty: o.qty,
      filled: o.filled,
      remaining: o.remaining,
    }));
  }

  /** Latest engine Balance of the account, or undefined before the first Balance event. */
  balance(accountId: AccountId): BalanceRow | undefined {
    const b = this.#balances.get(accountId);
    return b === undefined ? undefined : { ...b };
  }

  /** Empties every account (Req 15.7). */
  clear(): void {
    this.#balances.clear();
    this.#accounts.clear();
  }

  // -------------------------------------------------------------------------------------------

  #entry(accountId: AccountId, create: boolean): AccountEntry | undefined {
    const existing = this.#accounts.get(accountId);
    if (existing !== undefined || !create) return existing;
    if (this.#accounts.size >= this.#maxAccounts) {
      const oldest = this.#accounts.keys().next();
      if (!oldest.done) {
        this.#accounts.delete(oldest.value);
        this.#logger?.warn(`account cache full (${this.#maxAccounts}): dropped the oldest account`);
      }
    }
    const entry: AccountEntry = { positions: new Map(), orders: new Map(), notes: new Map() };
    this.#accounts.set(accountId, entry);
    return entry;
  }

  /** Drops the oldest entries of `map` until it fits the per-account cap. */
  #trim(map: Map<OrderId, unknown>, accountId: AccountId, what: string): void {
    while (map.size > this.#maxOrders) {
      const oldest = map.keys().next();
      if (oldest.done) return;
      map.delete(oldest.value);
      this.#logger?.warn(`${what} cap (${this.#maxOrders}) reached for ${accountId}: dropped the oldest`);
    }
  }

  /** Removes an account entry that holds nothing, so idle accounts do not use a cap slot. */
  #prune(accountId: AccountId, entry: AccountEntry): void {
    if (entry.positions.size === 0 && entry.orders.size === 0 && entry.notes.size === 0) {
      this.#accounts.delete(accountId);
    }
  }

  #applyPosition(event: Extract<AccountEvent, { type: "position" }>): void {
    const qty = toBigInt(event.qty);
    if (qty === 0n) {
      const entry = this.#accounts.get(event.account_id);
      if (entry === undefined) return;
      entry.positions.delete(event.symbol);
      this.#prune(event.account_id, entry);
      return;
    }
    const entry = this.#entry(event.account_id, true);
    if (entry === undefined) return;
    entry.positions.set(event.symbol, {
      symbol: event.symbol,
      qty,
      avgEntry: event.avg_entry === null ? null : toBigInt(event.avg_entry),
      realized: toBigInt(event.realized),
      unrealized: toBigInt(event.unrealized),
    });
  }

  #applyAck(event: Extract<AccountEvent, { type: "order_ack" }>): void {
    const { account_id: accountId, order_id: orderId } = event;
    if (event.status === "accepted") {
      const entry = this.#entry(accountId, true);
      if (entry === undefined) return;
      const note = entry.notes.get(orderId);
      entry.notes.delete(orderId);
      if (entry.orders.has(orderId)) return; // duplicate ack: keep the existing row
      entry.orders.set(orderId, {
        orderId,
        symbol: note?.symbol ?? "",
        side: note?.side ?? null,
        kind: note?.kind ?? null,
        qty: note?.qty ?? null,
        filled: 0n,
        remaining: note?.qty ?? null,
      });
      this.#trim(entry.orders, accountId, "open order");
      return;
    }
    // filled or canceled
    const entry = this.#accounts.get(accountId);
    if (entry === undefined) return;
    entry.orders.delete(orderId);
    entry.notes.delete(orderId);
    this.#prune(accountId, entry);
  }

  #applyFill(event: Extract<AccountEvent, { type: "fill" }>): void {
    const order = this.#accounts.get(event.account_id)?.orders.get(event.order_id);
    if (order === undefined) return;
    order.symbol = event.symbol;
    order.side = event.side;
    order.filled += toBigInt(event.qty);
    order.remaining = toBigInt(event.remaining);
    if (order.qty === null) order.qty = order.filled + order.remaining;
  }

  #applyRejected(event: Extract<AccountEvent, { type: "order_rejected" }>): void {
    const entry = this.#accounts.get(event.account_id);
    if (entry === undefined) return;
    if (entry.orders.has(event.order_id)) {
      // A rejected cancel (or a duplicate id) leaves the open order untouched.
      this.#logger?.info(`order_rejected for open order ${event.order_id} (${event.reason}): no change`);
      return;
    }
    entry.notes.delete(event.order_id);
    this.#prune(event.account_id, entry);
  }
}
