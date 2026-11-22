"use client";

import { useEffect, useState } from "react";
import { forClient, keymap } from "../../../shared/keymap";
import { PageFrame } from "../../components/shell/PageFrame";
import { CHART_TYPES, CHART_TYPE_LABELS, type ChartType } from "../../lib/chartData";
import { useTerminalStore } from "../../lib/store";

const CHART_TYPE_KEY = "oni:default-chart-type";
const WEB_KEYMAP = forClient(keymap, "web");

function isChartType(value: string | null): value is ChartType {
  return CHART_TYPES.some((t) => t === value);
}

export default function SettingsPage() {
  const providers = useTerminalStore((s) => s.providers);
  const setProvider = useTerminalStore((s) => s.setProvider);
  const hello = useTerminalStore((s) => s.hello);
  const selectedVenue = useTerminalStore((s) => s.selection.venue);
  const selectVenue = useTerminalStore((s) => s.selectVenue);
  const [chartType, setChartType] = useState<ChartType>("candles");

  useEffect(() => {
    const saved = window.localStorage.getItem(CHART_TYPE_KEY);
    if (isChartType(saved)) setChartType(saved);
  }, []);

  const venues = hello === null ? [] : [...new Set([hello.defaultVenue, ...hello.liveVenues])];
  const bindings = Object.entries(WEB_KEYMAP.contexts).flatMap(([context, map]) =>
    [...map.entries()].map(([key, action]) => ({ context, key, action })),
  );

  return (
    <PageFrame title="Settings">
      <div className="max-w-md space-y-4 text-xs">
        <label className="flex items-center justify-between gap-4">
          <span className="text-phosphor-dim">AI provider</span>
          <select
            aria-label="AI provider"
            className="border border-crt-line bg-transparent px-1 py-0.5"
            value={providers.selected ?? ""}
            onChange={(e) => {
              const found = providers.available.find((p) => p.id === e.target.value);
              if (found !== undefined && found.reason === null) setProvider(found.id);
            }}
          >
            <option value="" disabled>
              {providers.available.length === 0 ? "none available" : "choose…"}
            </option>
            {providers.available.map((p) => (
              <option key={p.id} value={p.id} disabled={p.reason !== null}>
                {p.id} · {p.model}
                {p.reason === null ? "" : ` (${p.reason})`}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center justify-between gap-4">
          <span className="text-phosphor-dim">Default venue</span>
          <select
            aria-label="Default venue"
            className="border border-crt-line bg-transparent px-1 py-0.5"
            value={selectedVenue}
            onChange={(e) => {
              const found = venues.find((v) => v === e.target.value);
              if (found !== undefined) selectVenue(found);
            }}
          >
            {venues.length === 0 && <option value={selectedVenue}>{selectedVenue}</option>}
            {venues.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center justify-between gap-4">
          <span className="text-phosphor-dim">Default chart type</span>
          <select
            aria-label="Default chart type"
            className="border border-crt-line bg-transparent px-1 py-0.5"
            value={chartType}
            onChange={(e) => {
              const next = e.target.value;
              if (!isChartType(next)) return;
              setChartType(next);
              window.localStorage.setItem(CHART_TYPE_KEY, next);
            }}
          >
            {CHART_TYPES.map((t) => (
              <option key={t} value={t}>
                {CHART_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>

        <p className="text-phosphor-dim">
          Theme: Oni (dark, fixed). Wallet sign-in is in the top bar. API keys and URLs are server settings and
          cannot be entered here.
        </p>

        <section aria-label="Keymap">
          <h2 className="crt-title mb-1">Keymap</h2>
          <ul className="space-y-0.5">
            {bindings.map((b) => (
              <li key={`${b.context}|${b.key}`} className="flex justify-between gap-4">
                <span className="text-phosphor-dim">
                  {b.context} · {b.key}
                </span>
                <span>{b.action}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </PageFrame>
  );
}
