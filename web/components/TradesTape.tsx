"use client";

// Trades tape (Task 8.3, Req 27.2): the newest trades with UTC time, price, quantity, and side.

import { TAPE_ROWS, formatTimeUtc } from "../lib/bookView";
import { formatPrice, formatQty } from "../lib/format";
import { useTerminalStore } from "../lib/store";

export default function TradesTape() {
  const tape = useTerminalStore((state) => state.tape);
  const instruments = useTerminalStore((state) => state.instruments);
  const symbol = useTerminalStore((state) => state.selection.symbol);
  const rows = tape.filter((trade) => trade.symbol === symbol).slice(0, TAPE_ROWS);

  if (rows.length === 0) {
    return <div className="text-xs text-phosphor-faint">waiting for trades…</div>;
  }

  return (
    <ul className="space-y-0.5 text-xs">
      {rows.map((trade, index) => {
        const info = instruments[trade.symbol];
        return (
          <li
            key={`${trade.ts}-${index}`}
            className={`flex justify-between gap-2 ${trade.side === "buy" ? "text-buy" : "text-sell"}`}
          >
            <span className="text-phosphor-dim">{formatTimeUtc(trade.ts)}</span>
            <span>{formatPrice(trade.price, info?.price_decimals ?? 2)}</span>
            <span>{formatQty(trade.qty, info?.qty_decimals ?? 8)}</span>
          </li>
        );
      })}
    </ul>
  );
}
