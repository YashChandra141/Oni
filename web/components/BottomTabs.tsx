"use client";

// Bottom tabs: Positions, Orders, Balances, P&L (Task 14.7, Req 25.3 to 25.10).

import { useState, type ReactNode } from "react";
import { formatPrice, formatQty, formatUnits } from "../lib/format";
import { useTerminalStore } from "../lib/store";
import OpenOrdersPanel from "./OpenOrdersPanel";
import PnlPanel from "./PnlPanel";
import PositionsPanel from "./PositionsPanel";

type BottomTab = "positions" | "orders" | "balances" | "pnl";

const TABS: readonly { readonly id: BottomTab; readonly label: string }[] = [
  { id: "positions", label: "Positions" },
  { id: "orders", label: "Orders" },
  { id: "balances", label: "Balances" },
  { id: "pnl", label: "P&L" },
];

const MONEY_DECIMALS = 10;

function money(raw: string | undefined): string {
  return raw === undefined ? "—" : (formatUnits(raw, MONEY_DECIMALS) ?? "—");
}

function Balances() {
  const accountId = useTerminalStore((s) => s.session?.accountId ?? s.dataAccountId ?? "guest");
  const balance = useTerminalStore((s) => s.balances[accountId]);
  const start = useTerminalStore((s) => s.startingBalance);
  return (
    <dl className="grid max-w-xs grid-cols-2 gap-x-4 text-xs">
      <dt className="text-phosphor-dim">Paper balance</dt>
      <dd className="text-right">{money(balance?.paperBalance)}</dd>
      <dt className="text-phosphor-dim">Free</dt>
      <dd className="text-right">{money(balance?.freeBalance)}</dd>
      <dt className="text-phosphor-dim">Equity</dt>
      <dd className="text-right">{money(balance?.equity)}</dd>
      <dt className="text-phosphor-dim">Starting</dt>
      <dd className="text-right">{money(start ?? undefined)}</dd>
    </dl>
  );
}

function Fills() {
  const fills = useTerminalStore((s) => s.fills);
  const rejections = useTerminalStore((s) => s.rejections);
  const instruments = useTerminalStore((s) => s.instruments);
  return (
    <div className="mt-2 text-xs">
      <div className="text-phosphor-dim">Recent fills</div>
      {fills.length === 0 ? <div className="text-phosphor-faint">no fills</div> : null}
      {fills.slice(0, 50).map((f, i) => {
        const info = instruments[f.symbol];
        return (
          <div key={`${f.orderId}-${f.ts}-${i}`} className="flex gap-3">
            <span className={f.side === "sell" ? "text-sell" : "text-buy"}>{f.side.toUpperCase()}</span>
            <span>{f.symbol}</span>
            <span>{formatQty(f.qty, info?.qty_decimals ?? 8)}</span>
            <span>@ {formatPrice(f.price, info?.price_decimals ?? 2)}</span>
          </div>
        );
      })}
      <div className="mt-1 text-phosphor-dim">Rejections</div>
      {rejections.length === 0 ? <div className="text-phosphor-faint">none</div> : null}
      {rejections.slice(0, 50).map((r, i) => (
        <div key={`${r.orderId ?? "x"}-${i}`} className="text-sell">
          {r.orderId ?? "—"} {r.reason}
        </div>
      ))}
    </div>
  );
}

function Orders() {
  const twaps = useTerminalStore((s) => s.twaps);
  const cancelTwap = useTerminalStore((s) => s.cancelTwap);
  const active = Object.values(twaps).filter((p) => p.status === "active");
  return (
    <div className="flex min-h-0 flex-col text-xs">
      <OpenOrdersPanel />
      {active.map((p) => (
        <div key={p.twapId} className="flex gap-3">
          <span>TWAP</span>
          <span>{p.symbol}</span>
          <span>
            {p.sent}/{p.slices} slices
          </span>
          <button
            type="button"
            aria-label={`Cancel TWAP ${p.twapId}`}
            className="text-sell"
            onClick={() => {
              cancelTwap(p.twapId);
            }}
          >
            ✕
          </button>
        </div>
      ))}
      <Fills />
    </div>
  );
}

export function BottomTabs() {
  const [tab, setTab] = useState<BottomTab>("positions");
  let body: ReactNode;
  switch (tab) {
    case "positions":
      body = <PositionsPanel />;
      break;
    case "orders":
      body = <Orders />;
      break;
    case "balances":
      body = <Balances />;
      break;
    case "pnl":
      body = <PnlPanel />;
      break;
  }
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div role="tablist" aria-label="Account" className="mb-1 flex shrink-0 gap-3 text-xs">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => {
              setTab(item.id);
            }}
            className={tab === item.id ? "text-amber underline" : "text-phosphor-dim"}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{body}</div>
    </div>
  );
}
