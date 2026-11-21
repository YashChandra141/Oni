// Pure routing of engine events to Bun topics or a single connection (design Decision A10;
// Req 17.7, 17.9, 17.10, 17.11).
//
//   OrderAck, Fill, Position, Balance → topic `account:<account_id>`
//   OrderRejected             → the requesting connection when known, else `account:<account_id>`
//   Candle, Indicators        → topic `candles:<venue>:<symbol>:<tf>`
//   Trade, Book, Ticker24h    → topic `market:<venue>:<symbol>`
//   VenueStatus, PairStatus, ReferenceVenue → `notices`
//   Heartbeat, Pong, Error    → dropped (stay inside the server)
// Notices are published on NOTICES_TOPIC by the gateway; every connection is subscribed to it.
//
// No I/O, no timers: the clock is injected.

import type { AccountId, Event, Timeframe, Venue } from "../protocol.ts";

/** Every connection, guest or wallet, is subscribed to this topic (Req 17.9). */
export const NOTICES_TOPIC = "notices";

export function accountTopic(accountId: string): string {
  return `account:${accountId}`;
}

export function candlesTopic(venue: Venue, symbol: string, timeframe: Timeframe): string {
  return `candles:${venue}:${symbol}:${timeframe}`;
}

/** Venue-keyed market topic (design "Topics": `market:<venue>:<symbol>`). */
export function marketTopic(venue: Venue, symbol: string): string {
  return `market:${venue}:${symbol}`;
}

export type RouteResult =
  | { readonly topic: string }
  | { readonly toConnection: string }
  | { readonly drop: true };

export interface RouteContext {
  /**
   * The connection that requested the order, if known. The Router records it in
   * `PendingRequests` (Task 11.2); the gateway looks it up by `order_id` and passes it here.
   */
  readonly requester?: string | null | undefined;
}

/** Decides where an engine event goes. Pure. */
export function routeAccountEvent(event: Event, ctx: RouteContext = {}): RouteResult {
  switch (event.type) {
    case "candle":
    case "indicators":
      return { topic: candlesTopic(event.venue, event.symbol, event.timeframe) };
    case "trade":
    case "book":
    // Ticker subscriptions land in Task 3.5; until then a Ticker24h goes to the pair's market topic.
    case "ticker24h":
      return { topic: marketTopic(event.venue, event.symbol) };
    case "order_ack":
    case "fill":
    case "position":
    case "balance":
      return { topic: accountTopic(event.account_id) };
    // Venue and pair health concern every connection (Req 9.9, 18.1).
    case "venue_status":
    case "pair_status":
    case "reference_venue":
      return { topic: NOTICES_TOPIC };
    case "order_rejected":
      if (ctx.requester !== undefined && ctx.requester !== null) return { toConnection: ctx.requester };
      return { topic: accountTopic(event.account_id) };
    case "heartbeat":
    case "pong":
    case "error":
      return { drop: true };
  }
}

export interface PendingRequestsOptions {
  /** Epoch milliseconds. */
  readonly now: () => number;
  /** Entry lifetime. Default 60 000 ms. */
  readonly ttlMs?: number;
  /** Most entries kept; the oldest is dropped beyond this. Default 10 000. */
  readonly maxEntries?: number;
}

/**
 * orderId → requesting connection id. The Router `set`s an entry when it sends an order and the
 * gateway `take`s it when the engine rejects that order. Entries expire and the map is capped.
 */
export class PendingRequests {
  readonly #entries = new Map<string, { connectionId: string; at: number }>();
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #max: number;

  constructor(options: PendingRequestsOptions) {
    this.#now = options.now;
    this.#ttlMs = options.ttlMs ?? 60_000;
    this.#max = options.maxEntries ?? 10_000;
  }

  set(orderId: string, connectionId: string): void {
    this.#entries.delete(orderId); // re-insert at the newest position
    this.#entries.set(orderId, { connectionId, at: this.#now() });
    this.#prune();
    while (this.#entries.size > this.#max) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) break;
      this.#entries.delete(oldest.value);
    }
  }

  /** Returns and removes the requester of an order, or undefined when unknown or expired. */
  take(orderId: string): string | undefined {
    this.#prune();
    const entry = this.#entries.get(orderId);
    if (entry === undefined) return undefined;
    this.#entries.delete(orderId);
    return entry.connectionId;
  }

  /** Removes every entry of a closed connection. */
  dropConnection(connectionId: string): void {
    for (const [orderId, entry] of this.#entries) {
      if (entry.connectionId === connectionId) this.#entries.delete(orderId);
    }
  }

  get size(): number {
    this.#prune();
    return this.#entries.size;
  }

  #prune(): void {
    const cutoff = this.#now() - this.#ttlMs;
    for (const [orderId, entry] of this.#entries) {
      if (entry.at > cutoff) break; // insertion order is time order
      this.#entries.delete(orderId);
    }
  }
}

/** Convenience for tests and callers that type account ids. */
export type { AccountId };
