"use client";

// Trades tape (Task 8.3/8.4, Req 27.2, 2.11, 3.12): the newest trades with local time, price, quantity, and side.

import { memo, useMemo } from "react";
import { tapeRows } from "../lib/bookView";
import { formatPrice, formatQty } from "../lib/format";
import { useTerminalStore, type TapeEntry } from "../lib/store";
import { formatClock } from "../lib/timeFormat";

interface TapeRowProps {
  readonly entry: TapeEntry;
  readonly priceDecimals: number;
  readonly qtyDecimals: number;
}

const TapeRow = memo(function TapeRow({ entry, priceDecimals, qtyDecimals }: TapeRowProps) {
  return (
    <li className={`flex justify-between gap-2 ${entry.side === "buy" ? "text-buy" : "text-sell"}`}>
      <span className="text-phosphor-dim">{formatClock(entry.ts)}</span>
      <span>{formatPrice(entry.price, priceDecimals)}</span>
      <span>{formatQty(entry.qty, qtyDecimals)}</span>
    </li>
  );
});

export default function TradesTape() {
  const tape = useTerminalStore((state) => state.tape);
  const symbol = useTerminalStore((state) => state.selection.symbol);
  const info = useTerminalStore((state) => state.instruments[state.selection.symbol]);
  const rows = useMemo(() => tapeRows(tape, symbol), [tape, symbol]);

  if (rows.length === 0) {
    return <div className="text-xs text-phosphor-faint">waiting for trades…</div>;
  }

  return (
    <ul className="space-y-0.5 text-xs">
      {rows.map((entry) => (
        <TapeRow
          key={entry.id}
          entry={entry}
          priceDecimals={info?.price_decimals ?? 2}
          qtyDecimals={info?.qty_decimals ?? 8}
        />
      ))}
    </ul>
  );
}
