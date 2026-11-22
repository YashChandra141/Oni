// PreviewStore (design §3 "Router (Req 18, 22)", Req 22.4, 46.4, trading-safety rule 3).
//
// Holds the pending Order_Previews of the command bar. A preview is bound to the connection
// that asked for it and to that connection's account at creation time. `take` hands the
// command back once, and only when:
//   - the preview exists                                          else unknown_preview
//   - the taker is the connection that created it                else wrong_connection
//   - it has not expired (now < expires_at; at exactly 60 s it    else expired
//     is expired)
//   - the connection is still on the preview's account            else account_changed
// A successful `take` and an `expired` or `account_changed` result remove the preview, so a
// preview is never confirmed twice. `wrong_connection` leaves the owner's preview alone.
//
// The gateway's account-change hook and connection-close hook call `discardForConnection`
// (Req 46.4), so `account_changed` is a second line of defence.
//
// Bounds: MAX_PREVIEWS in total and MAX_PER_CONNECTION per connection. Past a cap the oldest
// preview is dropped. Expired previews are pruned on every `create`.
//
// Pure apart from the injected clock and id generator. No I/O, no timers.

import { fromBigInt, type AccountId, type OrderPreview, type PreviewAction, type Venue } from "../protocol.ts";
import type { ParsedCommand } from "./parser.ts";

export const PREVIEW_TTL_MS = 60_000;
export const MAX_PREVIEWS = 1_000;
export const MAX_PER_CONNECTION = 20;

export type TakeError = "unknown_preview" | "expired" | "wrong_connection" | "account_changed";

export type TakeResult =
  | { readonly ok: true; readonly command: ParsedCommand; readonly venue: Venue }
  | { readonly ok: false; readonly error: TakeError };

/** Venue of a preview created without one (replay mode; protocol v3). */
export const DEFAULT_PREVIEW_VENUE: Venue = "replay";

export interface PreviewStoreOptions {
  /** Epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Preview id generator. Defaults to `crypto.randomUUID`. Ids must be unguessable. */
  readonly newId?: () => string;
  readonly maxPreviews?: number;
  readonly maxPerConnection?: number;
}

interface Entry {
  readonly connectionId: string;
  readonly accountId: AccountId;
  readonly command: ParsedCommand;
  /** Venue the confirmed order goes to; set by the server, never by LLM output (rule 10). */
  readonly venue: Venue;
  readonly expiresAt: number;
}

/** The wire form of a parsed command (decimal strings for Qty and Price). */
export function previewAction(command: ParsedCommand, venue: Venue = DEFAULT_PREVIEW_VENUE): PreviewAction {
  switch (command.kind) {
    // The preview action names equal the command kinds. Written this way, not as a string literal
    // for the cancel-all type, because router.isolation.test.ts reserves that literal for the Router.
    case "cancel_all":
    case "flatten_all":
      return { type: command.kind };
    case "twap":
      return {
        type: "twap",
        symbol: command.symbol,
        side: command.side,
        venue,
        total_qty: fromBigInt(command.totalQty),
        slices: command.slices,
        interval_s: command.intervalS,
      };
    case "place": {
      const o = command.order;
      return {
        type: "place",
        symbol: command.symbol,
        venue,
        side: command.side,
        qty: fromBigInt(command.qty),
        kind:
          o.type === "market"
            ? { type: "market" }
            : o.type === "limit"
              ? { type: "limit", price: fromBigInt(o.price) }
              : { type: "stop", stop_price: fromBigInt(o.stopPrice) },
      };
    }
  }
}

export class PreviewStore {
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #maxPreviews: number;
  readonly #maxPerConnection: number;
  /** preview id → entry. Insertion order is creation order. */
  readonly #entries = new Map<string, Entry>();
  /** connection id → its preview ids, in creation order. */
  readonly #byConnection = new Map<string, Set<string>>();

  constructor(options: PreviewStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#newId = options.newId ?? (() => crypto.randomUUID());
    this.#maxPreviews = options.maxPreviews ?? MAX_PREVIEWS;
    this.#maxPerConnection = options.maxPerConnection ?? MAX_PER_CONNECTION;
  }

  /** Number of pending previews. */
  get size(): number {
    return this.#entries.size;
  }

  /** Number of pending previews of one connection. */
  countFor(connectionId: string): number {
    return this.#byConnection.get(connectionId)?.size ?? 0;
  }

  create(
    connectionId: string,
    accountId: AccountId,
    command: ParsedCommand,
    text: string,
    venue: Venue = DEFAULT_PREVIEW_VENUE,
  ): OrderPreview {
    const now = this.#now();
    this.#pruneExpired(now);
    const previewId = this.#newId();
    const expiresAt = now + PREVIEW_TTL_MS;
    this.#entries.set(previewId, { connectionId, accountId, command, venue, expiresAt });
    let ids = this.#byConnection.get(connectionId);
    if (ids === undefined) {
      ids = new Set();
      this.#byConnection.set(connectionId, ids);
    }
    ids.add(previewId);
    // Caps: this connection first, then the global total. The new preview is never the one dropped.
    while (ids.size > this.#maxPerConnection) {
      const oldest = ids.values().next();
      if (oldest.done) break;
      this.#remove(oldest.value);
    }
    while (this.#entries.size > this.#maxPreviews) {
      const oldest = this.#entries.keys().next();
      if (oldest.done || oldest.value === previewId) break;
      this.#remove(oldest.value);
    }
    return { preview_id: previewId, text, action: previewAction(command, venue), expires_at: expiresAt };
  }

  /** Single use. See the file header for the order of the checks. */
  take(previewId: string, connectionId: string, accountId: AccountId): TakeResult {
    const entry = this.#entries.get(previewId);
    if (entry === undefined) return { ok: false, error: "unknown_preview" };
    if (entry.connectionId !== connectionId) return { ok: false, error: "wrong_connection" };
    this.#remove(previewId);
    if (this.#now() >= entry.expiresAt) return { ok: false, error: "expired" };
    if (entry.accountId !== accountId) return { ok: false, error: "account_changed" };
    return { ok: true, command: entry.command, venue: entry.venue };
  }

  /** Drops one preview. Only its own connection can discard it. Returns whether one was dropped. */
  discard(previewId: string, connectionId: string): boolean {
    const entry = this.#entries.get(previewId);
    if (entry === undefined || entry.connectionId !== connectionId) return false;
    this.#remove(previewId);
    return true;
  }

  /** Drops every preview of a connection (account change or close). Returns how many. */
  discardForConnection(connectionId: string): number {
    const ids = this.#byConnection.get(connectionId);
    if (ids === undefined) return 0;
    const count = ids.size;
    for (const id of [...ids]) this.#entries.delete(id);
    this.#byConnection.delete(connectionId);
    return count;
  }

  #remove(previewId: string): void {
    const entry = this.#entries.get(previewId);
    if (entry === undefined) return;
    this.#entries.delete(previewId);
    const ids = this.#byConnection.get(entry.connectionId);
    if (ids === undefined) return;
    ids.delete(previewId);
    if (ids.size === 0) this.#byConnection.delete(entry.connectionId);
  }

  #pruneExpired(now: number): void {
    for (const [id, entry] of [...this.#entries]) {
      if (now >= entry.expiresAt) this.#remove(id);
    }
  }
}
