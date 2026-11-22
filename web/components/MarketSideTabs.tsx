"use client";

// Order Book | Trades tabs beside the chart (Task 14.7, Req 25.1, 25.2).

import { useState } from "react";
import OrderBookPanel from "./OrderBookPanel";
import TradesTape from "./TradesTape";

type SideTab = "book" | "trades";

const TABS: readonly { readonly id: SideTab; readonly label: string }[] = [
  { id: "book", label: "Order Book" },
  { id: "trades", label: "Trades" },
];

export function MarketSideTabs() {
  const [tab, setTab] = useState<SideTab>("book");
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div role="tablist" aria-label="Market data" className="mb-1 flex shrink-0 gap-2 text-xs">
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
      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "book" ? <OrderBookPanel /> : <TradesTape />}
      </div>
    </div>
  );
}
