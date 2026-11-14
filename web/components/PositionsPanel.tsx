"use client";

// Positions (Task 12.3, Req 28.1): signed quantity, average entry, realized and unrealized P&L
// for the session's account. Gains are green, losses red.

import { formatPrice, formatQty } from "../lib/format";
import { DEFAULT_PRICE_DECIMALS, DEFAULT_QTY_DECIMALS, formatMoney, pnlClass } from "../lib/orderEntry";
import { useTerminalStore } from "../lib/store";

export default function PositionsPanel() {
  const positions = useTerminalStore((state) => state.positions);
  const instruments = useTerminalStore((state) => state.instruments);
  const rows = Object.values(positions);

  return (
    <div className="min-h-0 overflow-auto">
      <div className="grid grid-cols-5 gap-2 text-phosphor-dim">
        <span>SYMBOL</span>
        <span className="text-right">QTY</span>
        <span className="text-right">AVG</span>
        <span className="text-right">RPNL</span>
        <span className="text-right">UPNL</span>
      </div>
      {rows.length === 0 ? (
        <div className="text-phosphor-faint">no positions</div>
      ) : (
        rows.map((row) => {
          const info = instruments[row.symbol];
          const sell = row.qty.startsWith("-");
          return (
            <div key={row.symbol} className="grid grid-cols-5 gap-2">
              <span>{row.symbol}</span>
              <span className={`text-right ${sell ? "text-sell" : "text-buy"}`}>
                {formatQty(row.qty, info?.qty_decimals ?? DEFAULT_QTY_DECIMALS)}
              </span>
              <span className="text-right">
                {formatPrice(row.avgEntry ?? undefined, info?.price_decimals ?? DEFAULT_PRICE_DECIMALS)}
              </span>
              <span className={`text-right ${pnlClass(row.realized)}`}>{formatMoney(row.realized)}</span>
              <span className={`text-right ${pnlClass(row.unrealized)}`}>{formatMoney(row.unrealized)}</span>
            </div>
          );
        })
      )}
    </div>
  );
}
