"use client";

// Symbol header (Task 14.3, Req 22): selected symbol, last price, 24h change, high, low, volume.
// The ticker subscription for the selected (venue, symbol) is sent by useTerminalSocket.

import { formatPrice, formatQty } from "../lib/format";
import { pairKey, useTerminalStore } from "../lib/store";

const DEX_VENUES: readonly string[] = ["jupiter", "raydium"];

function formatChange(bps: number): string {
  const sign = bps > 0 ? "+" : bps < 0 ? "-" : "";
  const abs = Math.abs(bps);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}%`;
}

export function SymbolHeader() {
  const { venue, symbol } = useTerminalStore((state) => state.selection);
  const entry = useTerminalStore((state) => state.tickers[pairKey(venue, symbol)]);
  const lastTrade = useTerminalStore((state) => state.lastTrade[pairKey(venue, symbol)]);
  const info = useTerminalStore((state) => state.instruments[symbol]);

  const pd = info?.price_decimals;
  const qd = info?.qty_decimals;
  const ticker = entry?.ticker;
  const last = ticker?.last ?? lastTrade?.price;
  const bps = ticker?.change_bps;
  const changeClass = bps === undefined ? "text-phosphor-dim" : bps >= 0 ? "text-buy" : "text-sell";
  const isDex = DEX_VENUES.includes(venue);
  const na = (value: string | null | undefined, fmt: (v: string | undefined) => string): string =>
    value === undefined || value === null ? "n/a" : fmt(value);

  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm" aria-label="Symbol header">
      <span className="crt-title text-base">{symbol.replace("-", "/")}</span>
      <span className="text-lg" aria-label="Last price">
        {last === undefined ? "—" : formatPrice(last, pd)}
      </span>
      <span className={changeClass} aria-label="24h change">
        {bps === undefined ? "n/a" : formatChange(bps)}
      </span>
      <span className="text-xs text-phosphor-dim">
        H {na(ticker?.high, (v) => formatPrice(v, pd))} · L {na(ticker?.low, (v) => formatPrice(v, pd))} · Vol{" "}
        {isDex ? "n/a" : na(ticker?.volume, (v) => formatQty(v, qd))}
      </span>
      {isDex ? <span className="text-xs text-amber">simulated depth, no volume</span> : null}
    </div>
  );
}

export default SymbolHeader;
