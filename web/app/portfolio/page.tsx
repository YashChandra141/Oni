"use client";

import { PageFrame, StatRow } from "../../components/shell/PageFrame";
import { formatPrice, formatQty } from "../../lib/format";
import { formatMoney } from "../../lib/orderEntry";
import { useTerminalStore } from "../../lib/store";

const INTEGER = /^-?\d+$/;

export default function PortfolioPage() {
  const balance = useTerminalStore((s) => {
    const id = s.session?.accountId ?? s.dataAccountId;
    return id === null ? undefined : s.balances[id];
  });
  const positions = useTerminalStore((s) => s.positions);
  const instruments = useTerminalStore((s) => s.instruments);
  const start = useTerminalStore((s) => s.startingBalance);

  const held =
    balance !== undefined && INTEGER.test(balance.equity) && INTEGER.test(balance.freeBalance)
      ? (BigInt(balance.equity) - BigInt(balance.freeBalance)).toString()
      : undefined;
  const rows = Object.values(positions);

  return (
    <PageFrame title="Portfolio">
      <dl aria-label="Balance summary" className="mb-4 max-w-sm">
        <StatRow label="Starting balance" value={`$${formatMoney(start ?? undefined)}`} />
        <StatRow label="Equity" value={`$${formatMoney(balance?.equity)}`} />
        <StatRow label="Free balance" value={`$${formatMoney(balance?.freeBalance)}`} />
        <StatRow label="Positions value" value={`$${formatMoney(held)}`} />
      </dl>
      <table className="w-full text-xs">
        <thead className="text-left text-phosphor-dim">
          <tr>
            <th className="px-1">Symbol</th>
            <th className="px-1 text-right">Qty</th>
            <th className="px-1 text-right">Avg entry</th>
            <th className="px-1 text-right">Realized</th>
            <th className="px-1 text-right">Unrealized</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={5} className="px-1 py-2 text-phosphor-dim">
                No open positions.
              </td>
            </tr>
          ) : (
            rows.map((p) => {
              const info = instruments[p.symbol];
              return (
                <tr key={p.symbol} className="border-t border-crt-line">
                  <td className="px-1">{p.symbol}</td>
                  <td className="px-1 text-right tabular-nums">{formatQty(p.qty, info?.qty_decimals)}</td>
                  <td className="px-1 text-right tabular-nums">
                    {formatPrice(p.avgEntry ?? undefined, info?.price_decimals)}
                  </td>
                  <td className="px-1 text-right tabular-nums">${formatMoney(p.realized)}</td>
                  <td className="px-1 text-right tabular-nums">${formatMoney(p.unrealized)}</td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </PageFrame>
  );
}
