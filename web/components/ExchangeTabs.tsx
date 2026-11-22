"use client";

// Exchange tab bar (Task 14.3, Req 22): All / CEX / DEX filter, one tab per live venue with its
// badge and status dot, and Binance and Bybit as disabled "coming soon" tabs.

import { useRef, useState, type KeyboardEvent } from "react";
import type { Venue } from "../../shared/protocol/index";
import { useTerminalStore } from "../lib/store";

type Filter = "all" | "cex" | "dex";
type Kind = "cex" | "dex";

interface TabDef {
  readonly id: string;
  readonly label: string;
  readonly kind: Kind;
  readonly soon: boolean;
}

const TABS: readonly TabDef[] = [
  { id: "backpack", label: "Backpack", kind: "cex", soon: false },
  { id: "coinbase", label: "Coinbase", kind: "cex", soon: false },
  { id: "jupiter", label: "Jupiter", kind: "dex", soon: false },
  { id: "raydium", label: "Raydium", kind: "dex", soon: false },
  { id: "binance", label: "Binance", kind: "cex", soon: true },
  { id: "bybit", label: "Bybit", kind: "cex", soon: true },
];

const FILTERS: readonly { readonly id: Filter; readonly label: string }[] = [
  { id: "all", label: "All" },
  { id: "cex", label: "CEX" },
  { id: "dex", label: "DEX" },
];

function dotClass(status: string | undefined): string {
  if (status === "connected") return "bg-buy";
  if (status === "stale" || status === "connecting") return "bg-amber";
  return "bg-sell";
}

function dotLabel(status: string | undefined): string {
  if (status === "connected") return "connected";
  if (status === "stale") return "stale";
  if (status === "connecting") return "connecting";
  return "down";
}

export function ExchangeTabs() {
  const hello = useTerminalStore((state) => state.hello);
  const selected = useTerminalStore((state) => state.selection.venue);
  const venueStatus = useTerminalStore((state) => state.venueStatus);
  const selectVenue = useTerminalStore((state) => state.selectVenue);
  const [filter, setFilter] = useState<Filter>("all");
  const listRef = useRef<HTMLDivElement | null>(null);

  const live = hello?.dataMode === "live";
  const offered = new Set<string>(hello?.liveVenues ?? []);
  const statuses: Readonly<Partial<Record<string, string>>> = venueStatus;
  const visible = TABS.filter((tab) => filter === "all" || tab.kind === filter);

  const isEnabled = (tab: TabDef): boolean => !tab.soon && live && offered.has(tab.id);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const keys = ["ArrowRight", "ArrowLeft", "Home", "End"];
    if (!keys.includes(event.key)) return;
    const tabs = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([aria-disabled="true"])') ?? [],
    );
    if (tabs.length === 0) return;
    const current = tabs.findIndex((el) => el === document.activeElement);
    let next = current;
    if (event.key === "ArrowRight") next = (current + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (current - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else next = tabs.length - 1;
    event.preventDefault();
    tabs[next]?.focus();
  };

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs" aria-label="Exchanges">
      <div className="flex gap-1" role="group" aria-label="Exchange type">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={`border px-2 py-0.5 ${
              filter === f.id ? "border-amber text-amber" : "border-crt-line text-phosphor-dim"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div ref={listRef} role="tablist" aria-label="Exchange" className="flex flex-wrap gap-1" onKeyDown={onKeyDown}>
        {visible.map((tab) => {
          const enabled = isEnabled(tab);
          const active = enabled && selected === tab.id;
          const status = statuses[tab.id];
          const title = tab.soon ? "coming soon" : !live ? "live mode only" : !enabled ? "not enabled" : tab.label;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              aria-disabled={!enabled}
              tabIndex={enabled ? 0 : -1}
              title={title}
              onClick={() => {
                if (enabled) selectVenue(tab.id as Venue);
              }}
              className={`flex items-center gap-1 border px-2 py-0.5 ${
                active ? "border-amber text-amber" : "border-crt-line"
              } ${enabled ? "" : "cursor-not-allowed opacity-40"}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/brand/exchanges/${tab.id}.svg`} alt="" width={14} height={14} />
              <span>{tab.label}</span>
              <span className="text-phosphor-dim">{tab.kind.toUpperCase()}</span>
              {tab.soon ? (
                <span className="text-phosphor-dim">coming soon</span>
              ) : !live ? (
                <span className="text-phosphor-dim">live mode only</span>
              ) : enabled ? (
                <span
                  role="img"
                  aria-label={dotLabel(status)}
                  className={`inline-block h-2 w-2 rounded-full ${dotClass(status)}`}
                />
              ) : null}
              {active ? <span aria-hidden="true">✓</span> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default ExchangeTabs;
