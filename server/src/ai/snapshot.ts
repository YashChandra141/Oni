// Market_Snapshot builder (design "AI analyst", Req 5.1, 5.2). Pure: reads from the state
// objects it is given and returns a bounded JSON-safe value of decimal strings.
//
// The snapshot holds no account id, wallet address, token, or secret. The caller's position
// and free balance are looked up by account id here, but the id itself is never copied out.

import { instrumentBySymbol } from "../instruments.ts";
import { formatDecimal } from "../protocol.ts";
import type { IndicatorValues, Level, Timeframe, TickerSchema, Venue } from "../protocol.ts";
import { MONEY_DECIMALS } from "../risk/limits.ts";
import type { AccountState } from "../state/account.ts";
import type { MarketState } from "../state/market.ts";
import type { z } from "zod";

export const SNAPSHOT_MAX_CANDLES = 100;
export const SNAPSHOT_MAX_BOOK_LEVELS = 10;
export const SNAPSHOT_MAX_NEWS = 10;
export const SNAPSHOT_MAX_TITLE_CHARS = 200;
export const SNAPSHOT_MAX_SOURCE_CHARS = 60;

type Ticker = z.infer<typeof TickerSchema>;

/** The news fields the snapshot reads (a subset of NewsItem). */
export interface SnapshotNewsItem {
  readonly title: string;
  readonly source: string;
  readonly published_at: number;
  readonly symbols: readonly string[];
}

export interface SnapshotInput {
  readonly symbol: string;
  readonly venue: Venue;
  readonly timeframe: Timeframe;
  /** The requesting connection's account id. Used for lookups only; never copied into the output. */
  readonly accountId: string;
  /** Wall clock in ms, for news age. */
  readonly now: number;
  readonly market: Pick<MarketState, "candles" | "lastTrade" | "topOfBook" | "snapshot">;
  readonly account: Pick<AccountState, "positions" | "balance">;
  /** Full book levels of the venue, best first, when the caller holds them. Falls back to top of book. */
  readonly book?: { readonly bids: readonly Level[]; readonly asks: readonly Level[] };
  readonly ticker?: Ticker | null;
  readonly news?: readonly SnapshotNewsItem[];
}

/** `[t, open, high, low, close, volume]`: t in ms, the rest decimal strings. */
export type SnapshotCandle = readonly [number, string, string, string, string, string];

export interface MarketSnapshot {
  readonly symbol: string;
  readonly venue: Venue;
  readonly timeframe: Timeframe;
  readonly last: { readonly price: string; readonly qty: string; readonly ts: number } | null;
  readonly candles: readonly SnapshotCandle[];
  readonly indicators: IndicatorValues | null;
  readonly book: {
    readonly bids: readonly (readonly [string, string])[];
    readonly asks: readonly (readonly [string, string])[];
    readonly spread: string | null;
    readonly imbalance_bps: number | null;
  };
  readonly ticker: {
    readonly open: string;
    readonly high: string;
    readonly low: string;
    readonly last: string;
    /** Null for DEX venues. */
    readonly volume: string | null;
    readonly change_bps: number;
  } | null;
  readonly news: readonly { readonly title: string; readonly source: string; readonly age_min: number }[];
  /** The caller's position in the symbol, or null when flat. */
  readonly position: { readonly qty: string; readonly avg_entry: string | null } | null;
  /** The caller's free balance in USD, or null before the first Balance event. */
  readonly free_balance: string | null;
}

function cut(text: string, max: number): string {
  return Array.from(text).slice(0, max).join("");
}

export function buildMarketSnapshot(input: SnapshotInput): MarketSnapshot {
  const { symbol, venue, timeframe } = input;
  const info = instrumentBySymbol(symbol);
  const pd = info?.price_decimals ?? 0;
  const qd = info?.qty_decimals ?? 0;
  const price = (v: string | bigint): string => formatDecimal(v, pd);
  const qty = (v: string | bigint): string => formatDecimal(v, qd);

  const bars = input.market.candles(symbol, timeframe, SNAPSHOT_MAX_CANDLES, venue) ?? [];
  const candles: SnapshotCandle[] = bars
    .slice(-SNAPSHOT_MAX_CANDLES)
    .map((b) => [b.t, price(b.open), price(b.high), price(b.low), price(b.close), qty(b.volume)] as const);

  const cached = input.market.snapshot(symbol, timeframe, venue);
  const lastPoint = cached?.indicators?.at(-1);
  const indicators: IndicatorValues | null = lastPoint === undefined ? null : { ...lastPoint.values };

  const trade = input.market.lastTrade(symbol, venue);
  const top = input.market.topOfBook(symbol, venue);
  let bids: readonly Level[];
  let asks: readonly Level[];
  if (input.book !== undefined) {
    bids = input.book.bids;
    asks = input.book.asks;
  } else {
    bids = top?.bid ? [top.bid] : [];
    asks = top?.ask ? [top.ask] : [];
  }
  const toRows = (levels: readonly Level[]): [string, string][] =>
    levels.slice(0, SNAPSHOT_MAX_BOOK_LEVELS).map((l): [string, string] => [price(l.price), qty(l.qty)]);

  const t = input.ticker;
  const news = (input.news ?? [])
    .filter((n) => n.symbols.includes(symbol) || n.symbols.includes(symbol.split("-")[0] ?? ""))
    .slice(0, SNAPSHOT_MAX_NEWS)
    .map((n) => ({
      title: cut(n.title, SNAPSHOT_MAX_TITLE_CHARS),
      source: cut(n.source, SNAPSHOT_MAX_SOURCE_CHARS),
      age_min: Math.max(0, Math.floor((input.now - n.published_at) / 60_000)),
    }));

  const pos = input.account.positions(input.accountId).find((p) => p.symbol === symbol);
  const bal = input.account.balance(input.accountId);

  return {
    symbol,
    venue,
    timeframe,
    last: trade === null ? null : { price: price(trade.price), qty: qty(trade.qty), ts: trade.ts },
    candles,
    indicators,
    book: {
      bids: toRows(bids),
      asks: toRows(asks),
      spread: top?.spread == null ? null : price(top.spread),
      imbalance_bps: top?.imbalance_bps ?? null,
    },
    ticker:
      t == null
        ? null
        : {
            open: price(t.open),
            high: price(t.high),
            low: price(t.low),
            last: price(t.last),
            volume: t.volume === null ? null : qty(t.volume),
            change_bps: t.change_bps,
          },
    news,
    position:
      pos === undefined
        ? null
        : { qty: qty(pos.qty), avg_entry: pos.avgEntry === null ? null : price(pos.avgEntry) },
    free_balance: bal === undefined ? null : formatDecimal(bal.freeBalance, MONEY_DECIMALS),
  };
}
