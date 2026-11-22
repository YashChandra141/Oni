"use client";

import { formatMoney } from "../lib/orderEntry";
import { useTerminalStore } from "../lib/store";

const INTEGER = /^-?\d+$/;

/** Equity minus free balance: the value tied up in positions (Money string), or undefined. */
function positionsValue(equity: string | undefined, free: string | undefined): string | undefined {
  if (equity === undefined || free === undefined) return undefined;
  if (!INTEGER.test(equity) || !INTEGER.test(free)) return undefined;
  return (BigInt(equity) - BigInt(free)).toString();
}

export function PortfolioTab() {
  const balance = useTerminalStore((state) => {
    const id = state.session?.accountId ?? state.dataAccountId;
    return id === null ? undefined : state.balances[id];
  });
  const value = positionsValue(balance?.equity, balance?.freeBalance);

  const rows: readonly (readonly [string, string])[] = [
    ["Equity", formatMoney(balance?.equity)],
    ["Free balance", formatMoney(balance?.freeBalance)],
    ["Positions value", formatMoney(value)],
  ];

  return (
    <dl aria-label="Portfolio" className="space-y-1 text-xs">
      {rows.map(([label, text]) => (
        <div key={label} className="flex justify-between px-1">
          <dt className="text-phosphor-dim">{label}</dt>
          <dd className="tabular-nums">${text}</dd>
        </div>
      ))}
    </dl>
  );
}

export default PortfolioTab;
