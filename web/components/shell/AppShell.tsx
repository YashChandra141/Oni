"use client";

// App shell (Task 14.1). It owns the one terminal socket, so client-side navigation between
// pages keeps the WebSocket connection (Req 21.3). Pages scroll inside their own panels.

import type { ReactNode } from "react";
import { WS_URL } from "../../lib/config";
import { TerminalSocketContext } from "../../lib/terminalContext";
import { useTerminalSocket } from "../../lib/useTerminalSocket";
import { Sidebar } from "./Sidebar";
import { TopNav } from "./TopNav";

export function AppShell({ children }: { children: ReactNode }) {
  const socket = useTerminalSocket(WS_URL);
  return (
    <TerminalSocketContext.Provider value={socket}>
      <div className="flex h-dvh min-h-0 flex-col gap-1 overflow-hidden p-1">
        <TopNav />
        <div className="flex min-h-0 flex-1 gap-1">
          <Sidebar />
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{children}</div>
        </div>
      </div>
    </TerminalSocketContext.Provider>
  );
}
