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
import { GRID_STYLE, PANEL_AREA } from "../lib/layout";
import { accountLabel } from "../lib/status";
import { useTerminalStore } from "../lib/store";
import { TerminalSocketContext } from "../lib/terminalContext";
import { useTerminalSocket } from "../lib/useTerminalSocket";

// Terminal layout (Task 5.1) with the live connection (Task 5.3), the chart (Task 5.4), and order
// entry and the account panels (Task 12.3). The panels match design.md "5. Web UI".

function Panel({
  title,
  className = "",
  body = "scroll",
  children,
}: {
  title: string;
  className?: string;
  body?: "scroll" | "clip";
  children: ReactNode;
}) {
  const bodyClass =
    body === "clip" ? "min-h-0 flex-1 overflow-hidden" : "min-h-0 flex-1 overflow-auto";
  return (
    <section
      aria-label={title}
      className={`crt-panel flex min-h-0 min-w-0 flex-col ${className}`}
    >
      <h2 className="crt-title border-b border-crt-line px-2 py-1 text-xs">{title}</h2>
      <div className={`${bodyClass} p-2 text-sm`}>{children}</div>
    </section>
  );
}

export default function Home() {
  const socket = useTerminalSocket(WS_URL);
  const session = useTerminalStore((state) => state.session);
  const account = accountLabel(session);

  return (
    <TerminalSocketContext.Provider value={socket}>
      <main className="grid h-dvh overflow-hidden gap-1 p-1" style={GRID_STYLE}>
        <div className="flex min-h-0 min-w-0 flex-col" style={{ gridArea: PANEL_AREA.status }}>
          <StatusBar />
        </div>

        <div className="flex min-h-0 min-w-0 flex-col" style={{ gridArea: PANEL_AREA.watch }}>
          <Panel title="Watchlist" className="min-h-0 flex-1">
            <Watchlist />
          </Panel>
        </div>

        <div className="flex min-h-0 min-w-0 flex-col" style={{ gridArea: PANEL_AREA.chart }}>
          <Panel title="Chart" className="min-h-0 flex-1" body="clip">
            <ChartPanelLoader />
          </Panel>
        </div>

        <div className="flex min-h-0 min-w-0 flex-col gap-1" style={{ gridArea: PANEL_AREA.side }}>
          <Panel title="Order book" className="min-h-0 flex-1">
            <OrderBookPanel />
          </Panel>
          <Panel title="Order ticket">
            <OrderTicket />
          </Panel>
        </div>

        <div className="flex min-h-0 min-w-0 flex-col" style={{ gridArea: PANEL_AREA.tape }}>
          <Panel title="Tape" className="min-h-0 flex-1">
            <TradesTape />
          </Panel>
        </div>

        <div className="flex min-h-0 min-w-0 flex-col" style={{ gridArea: PANEL_AREA.account }}>
          <Panel title="Positions / Orders" className="min-h-0 flex-1" body="clip">
            <div className="flex h-full min-h-0 flex-col">
              <div className="mb-1 shrink-0 text-xs text-amber" aria-label="Account">
                {account}
              </div>
              <div className="grid min-h-0 flex-1 grid-cols-[1fr_1.4fr_11rem] gap-4 text-xs">
                <PositionsPanel />
                <OpenOrdersPanel />
                <PnlPanel />
              </div>
            </div>
          </Panel>
        </div>

        <div className="flex min-h-0 min-w-0 flex-col" style={{ gridArea: PANEL_AREA.command }}>
          <CommandBar />
        </div>
      </main>

      <OrderHotkeys />
      <PreviewDialog />
      <ConfirmDialog />
      <RejectionToast />
    </TerminalSocketContext.Provider>
  );
}
