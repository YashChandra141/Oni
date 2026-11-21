// Subscription registry for the gateway (design §3 "Gateway (Req 17)").
//
// - Ref-counts subscriptions per (venue, symbol, timeframe) across clients (protocol v3,
//   Req 15.1). The gateway sends the engine `Subscribe` when a key gets its first subscriber and
//   `Unsubscribe` when its last subscriber leaves. A client subscribing twice to the same key
//   counts once.
// - `active()` lists every key with at least one subscriber. The gateway hands it to
//   `supervisor.setSubscriptionProvider`, so the supervisor resends them, with their venue,
//   after a restart (Req 15.4).
//
// The candle snapshot cache lives in `state/market.ts` (MarketState), not here (Task 4.6).
//
// Pure: no I/O, no timers. The Bun topic subscriptions themselves live in ws.ts.

import type { Timeframe, Venue } from "../protocol.ts";

export interface SubscriptionKey {
  readonly venue: Venue;
  readonly symbol: string;
  readonly timeframe: Timeframe;
}

export interface SubscribeResult {
  /** True when this call gave the key its first subscriber: send the engine `Subscribe`. */
  readonly first: boolean;
  /** False when the client was already subscribed to the key (the call changed nothing). */
  readonly added: boolean;
}

function keyOf(venue: Venue, symbol: string, timeframe: Timeframe): string {
  // Venues and timeframes never contain "|", so the split in `parseKey` is unambiguous.
  return `${venue}|${timeframe}|${symbol}`;
}

function parseKey(key: string): SubscriptionKey {
  const a = key.indexOf("|");
  const b = key.indexOf("|", a + 1);
  return {
    venue: key.slice(0, a) as Venue,
    timeframe: key.slice(a + 1, b) as Timeframe,
    symbol: key.slice(b + 1),
  };
}

export class SubscriptionRegistry {
  /** key → client ids subscribed to it. A key is present only while it has subscribers. */
  readonly #subscribers = new Map<string, Set<string>>();
  /** client id → keys it is subscribed to. */
  readonly #byClient = new Map<string, Set<string>>();

  /** Adds a subscription. Idempotent per (client, key). */
  subscribe(clientId: string, venue: Venue, symbol: string, timeframe: Timeframe): SubscribeResult {
    const key = keyOf(venue, symbol, timeframe);
    let clients = this.#subscribers.get(key);
    const first = clients === undefined;
    if (clients === undefined) {
      clients = new Set();
      this.#subscribers.set(key, clients);
    }
    if (clients.has(clientId)) return { first: false, added: false };
    clients.add(clientId);
    let keys = this.#byClient.get(clientId);
    if (keys === undefined) {
      keys = new Set();
      this.#byClient.set(clientId, keys);
    }
    keys.add(key);
    return { first, added: true };
  }

  /** Removes a subscription. Returns the key if its count dropped to 0 (send `Unsubscribe`). */
  unsubscribe(clientId: string, venue: Venue, symbol: string, timeframe: Timeframe): SubscriptionKey[] {
    const key = keyOf(venue, symbol, timeframe);
    const keys = this.#byClient.get(clientId);
    if (keys === undefined || !keys.delete(key)) return [];
    if (keys.size === 0) this.#byClient.delete(clientId);
    return this.#release(clientId, key) ? [parseKey(key)] : [];
  }

  /** Removes every subscription of a client. Returns the keys whose count dropped to 0. */
  removeClient(clientId: string): SubscriptionKey[] {
    const keys = this.#byClient.get(clientId);
    if (keys === undefined) return [];
    this.#byClient.delete(clientId);
    const dropped: SubscriptionKey[] = [];
    for (const key of keys) {
      if (this.#release(clientId, key)) dropped.push(parseKey(key));
    }
    return dropped;
  }

  /** Whether the client is subscribed to the key. */
  isSubscribed(clientId: string, venue: Venue, symbol: string, timeframe: Timeframe): boolean {
    return this.#byClient.get(clientId)?.has(keyOf(venue, symbol, timeframe)) ?? false;
  }

  /** Whether the client has any subscription for the (venue, symbol), at any timeframe. */
  clientHasSymbol(clientId: string, venue: Venue, symbol: string): boolean {
    const keys = this.#byClient.get(clientId);
    if (keys === undefined) return false;
    for (const key of keys) {
      const parsed = parseKey(key);
      if (parsed.venue === venue && parsed.symbol === symbol) return true;
    }
    return false;
  }

  /** Number of clients subscribed to the key. */
  count(venue: Venue, symbol: string, timeframe: Timeframe): number {
    return this.#subscribers.get(keyOf(venue, symbol, timeframe))?.size ?? 0;
  }

  /** Every key with at least one subscriber, for `supervisor.setSubscriptionProvider`. */
  active(): SubscriptionKey[] {
    return [...this.#subscribers.keys()].map(parseKey);
  }

  /** Drops the client from the key. Returns true when the key has no subscribers left. */
  #release(clientId: string, key: string): boolean {
    const clients = this.#subscribers.get(key);
    if (clients === undefined || !clients.delete(clientId)) return false;
    if (clients.size > 0) return false;
    this.#subscribers.delete(key);
    return true;
  }
}
