"use client";

import { useState } from "react";
import NewsPanel from "./NewsPanel";
import PortfolioTab from "./PortfolioTab";
import Watchlist from "./Watchlist";

type Tab = "watchlist" | "portfolio";

/** Watchlist | Portfolio tabs, with the News & Events panel below. */
export default function RightColumn() {
  const [tab, setTab] = useState<Tab>("watchlist");
  const tabs: readonly { id: Tab; label: string }[] = [
    { id: "watchlist", label: "Watchlist" },
    { id: "portfolio", label: "Portfolio" },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex min-h-0 flex-1 flex-col">
        <div role="tablist" className="mb-1 flex shrink-0 gap-2 text-xs">
          {tabs.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={tab === id ? "text-amber underline" : "text-phosphor-dim"}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {tab === "watchlist" ? <Watchlist /> : <PortfolioTab />}
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col border-t border-crt-line pt-1">
        <h3 className="crt-title mb-1 shrink-0 text-xs">News &amp; Events</h3>
        <div className="min-h-0 flex-1 overflow-auto">
          <NewsPanel />
        </div>
      </div>
    </div>
  );
}
