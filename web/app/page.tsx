"use client";

import type { ReactNode } from "react";
import { ChartPanelLoader } from "../components/ChartPanelLoader";
import OrderBookPanel from "../components/OrderBookPanel";
import { StatusBar } from "../components/StatusBar";
import TradesTape from "../components/TradesTape";
import Watchlist from "../components/Watchlist";
import { WS_URL } from "../lib/config";
import { accountLabel } from "../lib/status";
import { useTerminalStore } from "../lib/store";
import { TerminalSocketContext } from "../lib/terminalContext";
import { useTerminalSocket } from "../lib/useTerminalSocket";

// Terminal layout (Task 5.1) with the live connection (Task 5.3) and the chart (Task 5.4). The
// panels match design.md "5. Web UI"; the other panels arrive in later tasks.

function Panel({
  title,
  className = "",
  children,
}: {
  title: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className={`crt-panel flex min-h-0 flex-col ${className}`}>
      <h2 className="crt-title border-b border-crt-line px-2 py-1 text-xs">{title}</h2>
      <div className="min-h-0 flex-1 overflow-hidden p-2 text-sm">{children}</div>
    </section>
  );
}

export default function Home() {
  const socket = useTerminalSocket(WS_URL);
  const session = useTerminalStore((state) => state.session);
  const account = accountLabel(session);

  return (
    <TerminalSocketContext.Provider value={socket}>
    <main className="grid h-screen grid-cols-[12rem_1fr_16rem] grid-rows-[auto_1fr_10rem_auto] gap-1 p-1">
      <StatusBar />

      <Panel title="Watchlist" className="row-span-2">
        <Watchlist />
      </Panel>

      <Panel title="Chart">
        <ChartPanelLoader />
      </Panel>

      <Panel title="Order book">
        <OrderBookPanel />
      </Panel>

      <Panel title="Positions / Orders" className="col-span-2">
        <div className="mb-1 text-xs text-amber" aria-label="Account">
          {account}
        </div>
        <div className="grid grid-cols-2 gap-4 text-xs">
          <div>
            <div className="text-phosphor-dim">SYMBOL QTY AVG UPNL RPNL</div>
            <div className="text-phosphor-faint">no positions</div>
          </div>
          <div>
            <div className="text-phosphor-dim">ID SIDE TYPE QTY PRICE</div>
            <div className="text-phosphor-faint">no open orders</div>
          </div>
        </div>
      </Panel>

      <Panel title="Tape">
        <TradesTape />
      </Panel>

      <footer aria-label="Command bar" className="crt-panel col-span-3 flex items-center gap-2 px-2 py-1">
        <span className="text-amber">&gt;</span>
        <span className="text-phosphor-faint">BUY BTC 0.1 LMT 64000</span>
        <span className="crt-cursor" aria-hidden="true">
          █
        </span>
      </footer>
    </main>
    </TerminalSocketContext.Provider>
  );
}
