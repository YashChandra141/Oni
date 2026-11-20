"use client";

// P&L totals (Task 12.3, Req 28.1, 28.3): realized and unrealized P&L summed over symbols with
// BigInt, and their total. Realized P&L stays after a position is closed.

import { addUnits, formatMoney, pnlClass, realizedTotal, unrealizedTotal } from "../lib/orderEntry";
import { useTerminalStore } from "../lib/store";

export default function PnlPanel() {
  const positions = useTerminalStore((state) => state.positions);
  const realizedBySymbol = useTerminalStore((state) => state.realizedBySymbol);
  const realized = realizedTotal(realizedBySymbol);
  const unrealized = unrealizedTotal(positions);
  const total = addUnits(realized, unrealized);

  return (
    <div className="flex min-h-0 flex-col gap-0.5 overflow-auto" aria-label="P&L">
      <div className="flex justify-between">
        <span className="text-phosphor-dim">REALIZED</span>
        <span className={pnlClass(realized)}>{formatMoney(realized)}</span>
      </div>
      <div className="flex justify-between">
        <span className="text-phosphor-dim">UNREALIZED</span>
        <span className={pnlClass(unrealized)}>{formatMoney(unrealized)}</span>
      </div>
      <div className="flex justify-between border-t border-crt-line pt-0.5">
        <span className="text-phosphor-dim">TOTAL</span>
        <span className={pnlClass(total)}>{formatMoney(total)}</span>
      </div>
    </div>
  );
}
