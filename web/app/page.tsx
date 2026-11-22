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
import { NewsSection, WatchlistTabs } from "../components/RightColumn";
import { Split } from "../components/Split";
import { CENTRE_SPLIT, CONSOLE_SPLIT, LEFT_SPLIT, MAIN_SPLIT, RIGHT_SPLIT } from "../lib/layout";
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
      <main className="flex h-full min-h-0 flex-col gap-1 overflow-hidden">
        <div className="flex min-h-0 min-w-0 shrink-0 flex-col">
          <div className="flex min-w-0 flex-col gap-1 px-2 py-1">
            <ExchangeTabs />
            <SymbolHeader />
          </div>
        </div>

        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
          <Split direction="vertical" {...CONSOLE_SPLIT}>
          <Split direction="horizontal" {...MAIN_SPLIT}>
            <Split direction="vertical" {...LEFT_SPLIT}>
              <Panel title="Watchlist" className="h-full" body="clip">
                <WatchlistTabs />
              </Panel>
              <Panel title="News & Events" className="h-full" body="clip">
                <NewsSection />
              </Panel>
              <Panel title="Tape" className="h-full">
                <TradesTape />
              </Panel>
            </Split>

            <Split direction="vertical" {...CENTRE_SPLIT}>
              <Panel title="Chart" className="h-full" body="clip">
                <ChartPanelLoader />
              </Panel>
              <Panel title="AI Copilot" className="h-full">
                <CopilotPanel />
              </Panel>
              <Panel title="Positions / Orders" className="h-full" body="clip">
                <div className="flex h-full min-h-0 flex-col">
                  <div className="mb-1 shrink-0 text-xs text-amber" aria-label="Account">
                    {account}
                  </div>
                  <div className="min-h-0 flex-1 text-xs">
                    <BottomTabs />
                  </div>
                </div>
              </Panel>
            </Split>

            <Split direction="vertical" {...RIGHT_SPLIT}>
              <Panel title="Market" className="h-full" body="clip">
                <MarketSideTabs />
              </Panel>
              <Panel title="Order ticket" className="h-full">
                <OrderTicket />
              </Panel>
            </Split>
          </Split>
          <div className="flex h-full min-h-0 min-w-0 flex-col">
            <CommandBar />
          </div>
          </Split>
        </div>
      </main>

      <OrderHotkeys />
      <PreviewDialog />
      <ConfirmDialog />
      <RejectionToast />
    </>
  );
}
