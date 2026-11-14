"use client";

import { useEffect, useRef } from "react";
import { formatPrice } from "../lib/format";
import { useTerminalStore } from "../lib/store";
import { changeIndicator, symbolForKey, watchlistSymbols, type PriceChange } from "../lib/watchlist";

const COLOR: Record<PriceChange, string> = {
  up: "text-phosphor",
  down: "text-red-400",
  flat: "text-phosphor-dim",
};

function WatchRow({ symbol }: { symbol: string }) {
  const price = useTerminalStore((state) => state.lastTrade[symbol]?.price);
  const decimals = useTerminalStore((state) => state.instruments[symbol]?.price_decimals);
  const selected = useTerminalStore((state) => state.selection.symbol === symbol);
  const selectSymbol = useTerminalStore((state) => state.selectSymbol);

  // Direction of the latest change; it holds until the price moves again.
  const prevPrice = useRef<string | undefined>(undefined);
  const direction = useRef<PriceChange>("flat");
  if (price !== prevPrice.current) {
    const change = changeIndicator(prevPrice.current, price);
    if (change !== "flat") direction.current = change;
    prevPrice.current = price;
  }

  return (
    <li
      role="option"
      aria-selected={selected}
      onClick={() => selectSymbol(symbol)}
      className={`flex cursor-pointer justify-between px-1 ${selected ? "bg-crt-line" : ""}`}
    >
      <span>{symbol}</span>
      <span className={COLOR[direction.current]}>{formatPrice(price, decimals)}</span>
    </li>
  );
}

/** Watchlist panel body (Req 27.3, 27.4): click a row, or Tab / Shift+Tab, to switch symbol. */
export default function Watchlist() {
  const instruments = useTerminalStore((state) => state.instruments);
  const symbols = watchlistSymbols(instruments);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const { selection, selectSymbol } = useTerminalStore.getState();
      const target = symbolForKey(event, selection.symbol, symbols);
      if (target === null) return;
      event.preventDefault();
      selectSymbol(target);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [symbols]);

  return (
    <ul role="listbox" aria-label="Watchlist" className="space-y-1">
      {symbols.map((symbol) => (
        <WatchRow key={symbol} symbol={symbol} />
      ))}
    </ul>
  );
}
