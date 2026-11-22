"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";
import {
  beginPing,
  formatLatency,
  getLatencySnapshot,
  LATENCY_PING_MS,
  latencyLevel,
  resetLatency,
  subscribeLatency,
  type LatencyLevel,
} from "../../lib/latency";
import { useTerminalStore } from "../../lib/store";
import { useSocketHandle } from "../../lib/terminalContext";
import { WalletMenu } from "../WalletMenu";
import { NavIcon } from "./NavIcon";
import { isActive, TOP_NAV } from "./nav";

const LEVEL_CLASS: Record<LatencyLevel, string> = {
  good: "text-buy",
  warn: "text-amber",
  bad: "text-sell",
  unknown: "text-phosphor-dim",
};

/** Top bar: brand, page links, and the status cluster (live dot, exchanges, latency, bell, gear, avatar). */
export function TopNav() {
  const pathname = usePathname();
  const connected = useTerminalStore((state) => state.connection.kind === "connected");
  const hello = useTerminalStore((state) => state.hello);
  const venueStatus = useTerminalStore((state) => state.venueStatus);
  const socket = useSocketHandle();
  const latency = useSyncExternalStore(subscribeLatency, getLatencySnapshot, () => null);
  const level = latencyLevel(latency);
  const replay = hello?.dataMode === "replay";
  const statuses = Object.values(venueStatus);
  const total = hello !== null && hello.liveVenues.length > 0 ? hello.liveVenues.length : statuses.length;
  const upCount = statuses.filter((status) => status === "connected").length;

  // Ping every 2 s while connected; the pong handler calls `recordPong`.
  useEffect(() => {
    if (!connected) {
      resetLatency();
      return;
    }
    const send = (): void => {
      socket.send({ type: "ping", id: beginPing() });
    };
    send();
    const timer = setInterval(send, LATENCY_PING_MS);
    return () => clearInterval(timer);
  }, [connected, socket]);

  return (
    <header className="crt-panel flex shrink-0 items-center gap-4 px-3 py-1.5 text-xs">
      <Link href="/" className="font-bold tracking-widest" aria-label="Oni home">
        ONI{" "}
        <span className="text-accent-bright" lang="ja">
          鬼
        </span>
      </Link>
      <nav aria-label="Primary" className="flex items-center gap-1">
        {TOP_NAV.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`rounded px-2 py-1 ${
                active
                  ? "border-b-2 border-accent-bright text-phosphor"
                  : "text-phosphor-dim hover:text-phosphor"
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="ml-auto flex items-center gap-3">
        <span
          className={`flex items-center gap-1 ${connected ? (replay ? "text-amber" : "text-buy") : "text-sell"}`}
          title={connected ? "Connected to the server" : "Not connected"}
        >
          <span
            aria-hidden="true"
            className={`inline-block h-2 w-2 rounded-full ${connected ? (replay ? "bg-amber" : "bg-buy") : "bg-sell"}`}
          />
          {!connected ? "Offline" : replay ? "Replay" : "Live"}
        </span>
        <span className="text-phosphor-dim" title="Connected exchanges">
          {upCount}/{total} Exchanges
        </span>
        <span className={LEVEL_CLASS[level]} title="One-way latency (median of last 10 pings / 2); target 50 ms">
          {formatLatency(latency)}
        </span>
        <button
          type="button"
          aria-label="Notifications"
          className="text-phosphor-dim hover:text-phosphor"
        >
          <NavIcon name="bell" size={16} />
        </button>
        <Link href="/settings" aria-label="Settings" className="text-phosphor-dim hover:text-phosphor">
          <NavIcon name="gear" size={16} />
        </Link>
        <WalletMenu />
      </div>
    </header>
  );
}
