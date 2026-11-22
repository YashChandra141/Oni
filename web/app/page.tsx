"use client";

import type { ReactNode } from "react";
import { ChartPanelLoader } from "../components/ChartPanelLoader";
import { CommandBar } from "../components/CommandBar";
import { CopilotPanel } from "../components/CopilotPanel";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ExchangeTabs } from "../components/ExchangeTabs";
import { SymbolHeader } from "../components/SymbolHeader";
import { BottomTabs } from "../components/BottomTabs";
import { MarketSideTabs } from "../components/MarketSideTabs";
import { OrderHotkeys } from "../components/OrderHotkeys";
import OrderTicket from "../components/OrderTicket";
import { PreviewDialog } from "../components/PreviewDialog";
import { RejectionToast } from "../components/RejectionToast";
import TradesTape from "../components/TradesTape";
import RightColumn from "../components/RightColumn";
import { GRID_STYLE, PANEL_AREA } from "../lib/layout";
import { accountLabel } from "../lib/status";
import { useTerminalStore } from "../lib/store";

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
  const session = useTerminalStore((state) => state.session);
  const account = accountLabel(session);

  return (
    <>
      <main className="grid h-full min-h-0 overflow-hidden gap-1" style={GRID_STYLE}>
        <div className="flex min-h-0 min-w-0 flex-col" style={{ gridArea: PANEL_AREA.status }}>
          <div className="flex min-w-0 flex-col gap-1 px-2 py-1">
            <ExchangeTabs />
            <SymbolHeader />
          </div>
        </div>

        <div className="flex min-h-0 min-w-0 flex-col" style={{ gridArea: PANEL_AREA.watch }}>
          <Panel title="Watchlist" className="min-h-0 flex-1" body="clip">
            <RightColumn />
          </Panel>
        </div>

        <div className="flex min-h-0 min-w-0 flex-col" style={{ gridArea: PANEL_AREA.chart }}>
          <Panel title="Chart" className="min-h-0 flex-1" body="clip">
            <ChartPanelLoader />
          </Panel>
        </div>

        <div className="flex min-h-0 min-w-0 flex-col gap-1" style={{ gridArea: PANEL_AREA.side }}>
          <Panel title="Market" className="min-h-0 flex-1" body="clip">
            <MarketSideTabs />
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

        <div className="flex min-h-0 min-w-0 flex-col gap-1" style={{ gridArea: PANEL_AREA.account }}>
          <Panel title="AI Copilot" className="min-h-0 flex-1">
            <CopilotPanel />
          </Panel>
          <Panel title="Positions / Orders" className="min-h-0 flex-1" body="clip">
            <div className="flex h-full min-h-0 flex-col">
              <div className="mb-1 shrink-0 text-xs text-amber" aria-label="Account">
                {account}
              </div>
              <div className="min-h-0 flex-1 text-xs">
                <BottomTabs />
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
    </>
  );
}
