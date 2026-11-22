"use client";

import { useState } from "react";
import type { CopilotAction, ProviderId } from "../../shared/protocol/index";
import { useOrderActions } from "../lib/useOrderActions";
import { useSocketHandle } from "../lib/terminalContext";
import { useTerminalStore } from "../lib/store";

// AI Copilot panel (Task 14.9, Req 27). It never sends an order: "Place trade" and "Preview order"
// send `command_text`, so the server answers with a preview the user must confirm.

interface Pending {
  readonly id: string;
  readonly label: string;
}

const PLACEHOLDER = "@oni Analyze BTC trend, find a long entry with <2% risk";

function pct(bps: number): string {
  return `${(bps / 100).toFixed(0)}%`;
}

function Spinner() {
  return (
    <span
      role="status"
      aria-label="Working"
      className="inline-block h-3 w-3 animate-spin rounded-full border border-current border-t-transparent"
    />
  );
}

export function CopilotPanel({ large = false, showHistory = false }: { large?: boolean; showHistory?: boolean }) {
  const providers = useTerminalStore((s) => s.providers);
  const symbol = useTerminalStore((s) => s.selection.symbol);
  const ai = useTerminalStore((s) => s.ai);
  const setProvider = useTerminalStore((s) => s.setProvider);
  const sendAiRequest = useTerminalStore((s) => s.sendAiRequest);
  const socket = useSocketHandle();
  const orders = useOrderActions();
  const [prompt, setPrompt] = useState("");
  const [pending, setPending] = useState<readonly Pending[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const usable = providers.available.filter((p) => p.reason === null);
  const selected: ProviderId | null = providers.selected ?? providers.default;
  const enabled = usable.length > 0;

  const open = pending.filter(
    (p) => !(p.id in ai.analyses || p.id in ai.scans || p.id in ai.strategies || p.id in ai.errors),
  );
  const busy = open.length > 0;

  const run = (action: CopilotAction, label: string, text: string) => {
    setNotice(null);
    const id = sendAiRequest(action, text);
    if (id === null) {
      setNotice("Not connected.");
      return;
    }
    setPending((prev) => [...prev, { id, label }]);
  };

  const placeTrade = () => {
    const text = prompt.trim();
    if (text.length === 0) {
      setNotice("Describe the trade first.");
      return;
    }
    setNotice(null);
    if (!orders.submitCommand(`?${text}`)) setNotice("Not connected.");
  };

  const cancel = (id: string) => {
    socket.send({ type: "ai_cancel", request_id: id });
  };

  const previewIdea = (text: string) => {
    if (!orders.submitCommand(text)) setNotice("Not connected.");
  };

  const analyses = Object.values(ai.analyses);
  const scans = Object.values(ai.scans);
  const strategies = Object.values(ai.strategies);
  const errors = Object.values(ai.errors);
  const limit = showHistory ? 20 : 1;

  const btn =
    "border border-crt-line px-2 py-0.5 text-xs hover:bg-crt-line/30 disabled:opacity-40 disabled:cursor-not-allowed";

  return (
    <div className={`flex min-h-0 flex-col gap-2 text-xs ${large ? "text-sm" : ""}`} aria-label="AI Copilot">
      <div className="flex items-center gap-2">
        <label htmlFor="copilot-provider">Provider</label>
        <select
          id="copilot-provider"
          className="border border-crt-line bg-transparent px-1 py-0.5"
          value={selected ?? ""}
          disabled={providers.available.length === 0}
          onChange={(e) => {
            const found = providers.available.find((p) => p.id === e.target.value);
            if (found && found.reason === null) setProvider(found.id);
          }}
        >
          {selected === null ? <option value="">Select…</option> : null}
          {providers.available.map((p) => (
            <option key={p.id} value={p.id} disabled={p.reason !== null}>
              {p.id} ({p.model}){p.reason !== null ? ` — ${p.reason}` : ""}
            </option>
          ))}
        </select>
        {busy ? <Spinner /> : null}
      </div>
      {!enabled ? <div className="text-amber">No AI provider is available.</div> : null}

      <textarea
        aria-label="Copilot prompt"
        className="min-h-[3rem] w-full resize-y border border-crt-line bg-transparent p-1"
        placeholder={PLACEHOLDER}
        value={prompt}
        rows={large ? 4 : 2}
        onChange={(e) => setPrompt(e.target.value)}
      />

      <div className="flex flex-wrap gap-1">
        <button
          type="button"
          className={btn}
          disabled={!enabled}
          onClick={() => run("analyze", `Analyze ${symbol}`, prompt.trim() || `Analyze ${symbol}`)}
        >
          Analyze {symbol}
        </button>
        <button type="button" className={btn} disabled={!enabled} onClick={placeTrade}>
          Place trade
        </button>
        <button
          type="button"
          className={btn}
          disabled={!enabled}
          onClick={() => run("create_strategy", "Create strategy", prompt.trim() || `Strategy for ${symbol}`)}
        >
          Create strategy
        </button>
        <button
          type="button"
          className={btn}
          disabled={!enabled}
          onClick={() => run("scan", "Scan opportunities", prompt.trim() || "Scan opportunities")}
        >
          Scan opportunities
        </button>
      </div>

      {notice !== null ? <div className="text-amber">{notice}</div> : null}

      {open.map((p) => (
        <div key={p.id} className="flex items-center gap-2">
          <Spinner />
          <span>{p.label}…</span>
          <button type="button" className={btn} onClick={() => cancel(p.id)}>
            Cancel
          </button>
        </div>
      ))}

      {errors.slice(-limit).reverse().map((e) => (
        <div key={e.requestId} role="alert" className="border border-red-500 p-1 text-red-400">
          {e.reason}: {e.message}
        </div>
      ))}

      {analyses.slice(-limit).reverse().map((a) => (
        <div key={a.requestId} className="border border-crt-line p-1">
          <div>
            {a.analysis.symbol} · {a.analysis.bias} · confidence {pct(a.analysis.confidence_bps)}
            <span className="opacity-60"> ({a.provider}/{a.model})</span>
          </div>
          <p>{a.analysis.summary}</p>
          {a.analysis.rationale.length > 0 ? (
            <ul className="list-disc pl-4">
              {a.analysis.rationale.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          ) : null}
          {a.analysis.suggested_order !== null ? (
            <div className="mt-1 flex items-center gap-2">
              <span>
                Idea: {a.analysis.suggested_order.side} {a.analysis.suggested_order.qty}{" "}
                {a.analysis.suggested_order.kind.type}
              </span>
              {a.preview !== null ? (
                <button type="button" className={btn} onClick={() => previewIdea(a.preview?.text ?? "")}>
                  Preview order
                </button>
              ) : (
                <span className="text-amber">{a.previewError?.message ?? "No preview available."}</span>
              )}
            </div>
          ) : null}
        </div>
      ))}

      {scans.slice(-limit).reverse().map((s) => (
        <ol key={s.requestId} className="list-decimal border border-crt-line p-1 pl-6">
          {s.items.map((item, i) => (
            <li key={`${item.symbol}-${i}`}>
              {item.symbol} · {item.bias} · {pct(item.confidence_bps)} — {item.summary}
            </li>
          ))}
        </ol>
      ))}

      {strategies.slice(-limit).reverse().map((s) => (
        <pre key={s.requestId} className="whitespace-pre-wrap border border-crt-line p-1">
          {s.text}
        </pre>
      ))}
    </div>
  );
}

export default CopilotPanel;
