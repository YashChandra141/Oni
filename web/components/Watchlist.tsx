"use client";

import { memo, useCallback, useEffect, useState } from "react";
import { formatPrice } from "../lib/format";
import { pairKey, useTerminalStore } from "../lib/store";
import { useSocketHandle } from "../lib/terminalContext";
import { symbolForKey, watchlistSymbols } from "../lib/watchlist";

/** Req 26: watchlist of all symbols with last price, 24h change, star, and click to select. */

const TEN_SYMBOLS: readonly string[] = [
  "BTC-USD",
  "ETH-USD",
  "SOL-USD",
  "BNB-USD",
  "XRP-USD",
  "DOGE-USD",
  "JUP-USD",
  "WIF-USD",
  "BONK-USD",
  "PEPE-USD",
];

/** Basis points as a signed percent with two decimals, using integer math. */
export function formatChangeBps(bps: number): string {
  if (!Number.isInteger(bps)) return "—";
  const abs = Math.abs(bps);
  const sign = bps > 0 ? "+" : bps < 0 ? "-" : "";
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}%`;
}

const WatchRow = memo(function WatchRow({
  symbol,
  starred,
  onStar,
}: {
  symbol: string;
  starred: boolean;
  onStar: (symbol: string) => void;
}) {
  const venue = useTerminalStore((state) => state.selection.venue);
  const ticker = useTerminalStore((state) => state.tickers[pairKey(venue, symbol)]?.ticker);
  const lastTradePrice = useTerminalStore((state) => state.lastTrade[pairKey(venue, symbol)]?.price);
  const decimals = useTerminalStore((state) => state.instruments[symbol]?.price_decimals);
  const selected = useTerminalStore((state) => state.selection.symbol === symbol);
  const selectSymbol = useTerminalStore((state) => state.selectSymbol);

  const price = ticker?.last ?? lastTradePrice;
  const change = ticker?.change_bps;
  const color = change === undefined || change === 0 ? "text-phosphor-dim" : change > 0 ? "text-buy" : "text-sell";
  const base = symbol.split("-")[0] ?? symbol;

  return (
    <li
      role="option"
      aria-selected={selected}
      onClick={() => selectSymbol(symbol)}
      className={`flex cursor-pointer items-center gap-1 px-1 ${selected ? "bg-crt-line" : ""}`}
    >
      <button
        type="button"
        aria-label={starred ? `Unstar ${symbol}` : `Star ${symbol}`}
        aria-pressed={starred}
        onClick={(event) => {
          event.stopPropagation();
          onStar(symbol);
        }}
        className={starred ? "text-amber" : "text-phosphor-dim"}
      >
        {starred ? "★" : "☆"}
      </button>
      <span
        aria-hidden="true"
        className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-crt-line text-[10px]"
      >
        {base.charAt(0)}
      </span>
      <span className="flex-1 truncate">{symbol}</span>
      <span className="tabular-nums">{formatPrice(price, decimals)}</span>
      <span className={`w-16 text-right tabular-nums ${color}`}>
        {change === undefined ? "—" : formatChangeBps(change)}
      </span>
    </li>
  );
});

/** Watchlist panel body: click a row, or Tab / Shift+Tab, to switch symbol. */
export default function Watchlist() {
  const instruments = useTerminalStore((state) => state.instruments);
  const venue = useTerminalStore((state) => state.selection.venue);
  const { send } = useSocketHandle();
  const [stars, setStars] = useState<ReadonlySet<string>>(new Set());

  const known = watchlistSymbols(instruments);
  const symbols = known.length > 3 ? known : TEN_SYMBOLS;
  const ordered = [...symbols.filter((s) => stars.has(s)), ...symbols.filter((s) => !stars.has(s))];
  const key = ordered.join(",");

  useEffect(() => {
    const list = key === "" ? [] : key.split(",");
    for (const symbol of list) send({ type: "subscribe_ticker", symbol, venue });
    return () => {
      for (const symbol of list) send({ type: "unsubscribe_ticker", symbol, venue });
    };
  }, [key, venue, send]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const { selection, selectSymbol } = useTerminalStore.getState();
      const target = symbolForKey(event, selection.symbol, ordered);
      if (target === null) return;
      event.preventDefault();
      selectSymbol(target);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const toggle = useCallback(
    (symbol: string) =>
      setStars((prev) => {
        const next = new Set(prev);
        if (next.has(symbol)) next.delete(symbol);
        else next.add(symbol);
        return next;
      }),
    [],
  );

  return (
    <ul role="listbox" aria-label="Watchlist" className="space-y-1">
      {ordered.map((symbol) => (
        <WatchRow key={symbol} symbol={symbol} starred={stars.has(symbol)} onStar={toggle} />
      ))}
    </ul>
  );
}
