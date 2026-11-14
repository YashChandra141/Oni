// MarketState (design §3 `state/market.ts`): the server's view of the shared market data, fed by
// engine events.
//
// - Last trade per symbol: price, qty, side, ts (from Trade events, Req 9.8).
// - Top of book per symbol: best bid, best ask, spread, imbalance (from Book events, Req 9.6).
//   The engine emits Book events from Task 8 on; until then `topOfBook` stays null.
// - Candle cache per (symbol, timeframe): the latest history snapshot (`Candle { snapshot: true }`)
//   with later live bars merged in, capped at 500 bars (Req 8.7). Live bars that arrive before
//   any snapshot are ignored, because without the history they would form a misleading series.
//
// This is the single candle cache in the server. The gateway's SubscriptionRegistry only
// ref-counts subscriptions. The gateway feeds this state from `supervisor.onEvent`, passes
// Candle events only for keys that still have subscribers, drops a key's candles when its last
// subscriber leaves (the engine stops updating it then), and calls `clear()` on every engine
// exit (Req 15.7), since a new engine process starts its own book, candles, and replay.
//
// `quote` and `candles` are what the REST quote/candles routes and the MCP tools read (Req 24.2,
// 24.3). Market data is shared by every Paper_Account (Req 14.1), so nothing here is per account.
//
// Pure: no I/O, no timers, no clock. Every getter returns copies.

import type { Bar, Event, Level, Price, Qty, Side, Timeframe } from "../protocol.ts";

/** Most bars kept per (symbol, timeframe) (Req 8.7: up to 500 of the most recent candles). */
export const MAX_SNAPSHOT_BARS = 500;

export type CandleEvent = Extract<Event, { type: "candle" }>;
export type TradeEvent = Extract<Event, { type: "trade" }>;
export type BookEvent = Extract<Event, { type: "book" }>;

export interface LastTrade {
  readonly price: Price;
  readonly qty: Qty;
  readonly side: Side;
  readonly ts: number;
}

export interface TopOfBook {
  /** Highest bid level, or null when the bid side is empty. */
  readonly bid: Level | null;
  /** Lowest ask level, or null when the ask side is empty. */
  readonly ask: Level | null;
  readonly spread: Price | null;
  readonly imbalance_bps: number;
  readonly ts: number;
}

export interface Quote {
  readonly symbol: string;
  readonly last: LastTrade | null;
  readonly book: TopOfBook | null;
}

/** Replaces the bar with the same `t`, otherwise appends; keeps the newest `max` bars. */
export function mergeBars(bars: Bar[], updates: readonly Bar[], max: number = MAX_SNAPSHOT_BARS): void {
  for (const bar of updates) {
    let replaced = false;
    // Live updates almost always touch the last bar, so search from the end.
    for (let i = bars.length - 1; i >= 0; i -= 1) {
      if (bars[i]?.t === bar.t) {
        bars[i] = { ...bar };
        replaced = true;
        break;
      }
    }
    if (!replaced) bars.push({ ...bar });
  }
  if (bars.length > max) bars.splice(0, bars.length - max);
}

/**
 * The best level of one side: the highest price for bids, the lowest for asks. Prices are
 * decimal tick strings, compared as BigInt. The engine sends levels best first, but this does
 * not rely on it.
 */
function bestLevel(levels: readonly Level[], side: "bid" | "ask"): Level | null {
  let best: Level | null = null;
  let bestPrice = 0n;
  for (const level of levels) {
    const price = BigInt(level.price);
    if (best === null || (side === "bid" ? price > bestPrice : price < bestPrice)) {
      best = level;
      bestPrice = price;
    }
  }
  return best === null ? null : { ...best };
}

function candleKey(symbol: string, timeframe: Timeframe): string {
  // Timeframes never contain "|", so the key is unambiguous.
  return `${timeframe}|${symbol}`;
}

export class MarketState {
  readonly #trades = new Map<string, LastTrade>();
  readonly #books = new Map<string, TopOfBook>();
  /** candleKey → cached bars, oldest first. */
  readonly #candles = new Map<string, Bar[]>();

  /** Applies one engine event. Events other than Trade, Book, and Candle are ignored. */
  apply(event: Event): void {
    switch (event.type) {
      case "trade":
        this.#trades.set(event.symbol, { price: event.price, qty: event.qty, side: event.side, ts: event.ts });
        return;
      case "book":
        this.#books.set(event.symbol, {
          bid: bestLevel(event.bids, "bid"),
          ask: bestLevel(event.asks, "ask"),
          spread: event.spread,
          imbalance_bps: event.imbalance_bps,
          ts: event.ts,
        });
        return;
      case "candle":
        this.#applyCandle(event);
        return;
      default:
        return;
    }
  }

  lastTrade(symbol: string): LastTrade | null {
    const trade = this.#trades.get(symbol);
    return trade === undefined ? null : { ...trade };
  }

  topOfBook(symbol: string): TopOfBook | null {
    const book = this.#books.get(symbol);
    if (book === undefined) return null;
    return {
      ...book,
      bid: book.bid === null ? null : { ...book.bid },
      ask: book.ask === null ? null : { ...book.ask },
    };
  }

  /** Last trade and top of book for a symbol (Req 24.2), or null when neither is known yet. */
  quote(symbol: string): Quote | null {
    const last = this.lastTrade(symbol);
    const book = this.topOfBook(symbol);
    if (last === null && book === null) return null;
    return { symbol, last, book };
  }

  /**
   * The most recent `limit` cached bars, oldest first (Req 24.3), or null when no snapshot is
   * cached for the key. `limit` must be an integer from 1 to 500; callers validate user input
   * with Zod first, so anything else is a programming error and throws RangeError.
   */
  candles(symbol: string, timeframe: Timeframe, limit: number = MAX_SNAPSHOT_BARS): Bar[] | null {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SNAPSHOT_BARS) {
      throw new RangeError(`limit must be an integer from 1 to ${MAX_SNAPSHOT_BARS}`);
    }
    const bars = this.#candles.get(candleKey(symbol, timeframe));
    if (bars === undefined) return null;
    return bars.slice(-limit).map((b) => ({ ...b }));
  }

  /** The cached bars as a `Candle { snapshot: true }` event for a new subscriber, or null. */
  snapshot(symbol: string, timeframe: Timeframe): CandleEvent | null {
    const bars = this.candles(symbol, timeframe);
    return bars === null ? null : { type: "candle", symbol, timeframe, snapshot: true, bars };
  }

  /** Forgets the cached candles of one key (its last subscriber left, so the engine stops updating it). */
  dropCandles(symbol: string, timeframe: Timeframe): void {
    this.#candles.delete(candleKey(symbol, timeframe));
  }

  /** Forgets everything (engine exit, Req 15.7). */
  clear(): void {
    this.#trades.clear();
    this.#books.clear();
    this.#candles.clear();
  }

  /** A snapshot replaces the cached bars; a live update is merged into an existing snapshot. */
  #applyCandle(event: CandleEvent): void {
    const key = candleKey(event.symbol, event.timeframe);
    if (event.snapshot) {
      const bars: Bar[] = [];
      mergeBars(bars, event.bars);
      this.#candles.set(key, bars);
      return;
    }
    const cached = this.#candles.get(key);
    if (cached !== undefined) mergeBars(cached, event.bars);
  }
}
