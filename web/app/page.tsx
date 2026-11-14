"use client";

import type { ReactNode } from "react";
import { ChartPanelLoader } from "../components/ChartPanelLoader";
import { CommandBar } from "../components/CommandBar";
import { ConfirmDialog } from "../components/ConfirmDialog";
import OpenOrdersPanel from "../components/OpenOrdersPanel";
import OrderBookPanel from "../components/OrderBookPanel";
import { OrderHotkeys } from "../components/OrderHotkeys";
import OrderTicket from "../components/OrderTicket";
import PnlPanel from "../components/PnlPanel";
import PositionsPanel from "../components/PositionsPanel";
import { PreviewDialog } from "../components/PreviewDialog";
import { RejectionToast } from "../components/RejectionToast";
import { StatusBar } from "../components/StatusBar";
import TradesTape from "../components/TradesTape";
import Watchlist from "../components/Watchlist";
import { WS_URL } from "../lib/config";
import { accountLabel } from "../lib/status";
import { useTerminalStore } from "../lib/store";
import { TerminalSocketContext } from "../lib/terminalContext";
import { useTerminalSocket } from "../lib/useTerminalSocket";

// Terminal layout (Task 5.1) with the live connection (Task 5.3), the chart (Task 5.4), and order
// entry and the account panels (Task 12.3). The panels match design.md "5. Web UI".

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
    <main className="grid h-screen grid-cols-[12rem_1fr_16rem] grid-rows-[auto_1fr_12rem_auto] gap-1 p-1">
      <StatusBar />

      <Panel title="Watchlist" className="row-span-2">
        <Watchlist />
      </Panel>

      <Panel title="Chart">
        <ChartPanelLoader />
      </Panel>

      <div className="flex min-h-0 flex-col gap-1">
        <Panel title="Order book" className="flex-1">
          <OrderBookPanel />
        </Panel>
        <Panel title="Order ticket">
          <OrderTicket />
        </Panel>
      </div>

      <Panel title="Positions / Orders" className="col-span-2">
        <div className="mb-1 text-xs text-amber" aria-label="Account">
          {account}
        </div>
        <div className="grid h-[calc(100%-1.25rem)] grid-cols-[1fr_1.4fr_11rem] gap-4 text-xs">
          <PositionsPanel />
          <OpenOrdersPanel />
          <PnlPanel />
        </div>
      </Panel>

      <Panel title="Tape">
        <TradesTape />
      </Panel>

      <CommandBar />

      <OrderHotkeys />
      <PreviewDialog />
      <ConfirmDialog />
      <RejectionToast />
    </main>
    </TerminalSocketContext.Provider>
  );
}
