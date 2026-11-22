"use client";

import { useEffect, useRef, useState } from "react";
import type { CopilotAction, ProviderId } from "../../shared/protocol/index";
import { OllamaModelSelect } from "./OllamaModelSelect";
import { useOrderActions } from "../lib/useOrderActions";
import { useTerminalStore, type CopilotMessage } from "../lib/store";

// AI Copilot chat (Task 14.9, Req 27). It never sends an order: "Place trade" and "Preview order"
// send `command_text`, so the server answers with a preview the user must confirm.
// All text is rendered as plain text (React escapes it); there is no raw HTML.

const PLACEHOLDER = "Ask the Copilot… (Enter sends, Shift+Enter for a new line)";
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function localTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

function SpinnerBubble({ label, startedAt, onCancel }: { label: string; startedAt: number; onCancel: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, []);
  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000));
  const frame = FRAMES[Math.floor(now / 100) % FRAMES.length];
  return (
    <div className="flex justify-start" role="status" aria-label={`${label} in progress`}>
      <div className="max-w-[85%] border border-crt-line px-2 py-1">
        <span className="mr-2 inline-block w-3 text-center">{frame}</span>
        <span>thinking… {elapsed}s</span>
        <button
          type="button"
          className="ml-2 border border-crt-line px-1 text-xs hover:bg-crt-line/30"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export function CopilotPanel({ large = false }: { large?: boolean; showHistory?: boolean }) {
  const providers = useTerminalStore((s) => s.providers);
  const ollamaSelected = useTerminalStore((s) => s.ollamaSelected);
  const symbol = useTerminalStore((s) => s.selection.symbol);
  const ai = useTerminalStore((s) => s.ai);
  const messages = useTerminalStore((s) => s.copilotMessages);
  const pendingMap = useTerminalStore((s) => s.copilotPending);
  const setProvider = useTerminalStore((s) => s.setProvider);
  const sendAiRequest = useTerminalStore((s) => s.sendAiRequest);
  const cancelAiRequest = useTerminalStore((s) => s.cancelAiRequest);
  const clearCopilotChat = useTerminalStore((s) => s.clearCopilotChat);
  const orders = useOrderActions();
  const [prompt, setPrompt] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  const usable = providers.available.filter((p) => p.reason === null);
  const selected: ProviderId | null = providers.selected ?? providers.default;
  const enabled = usable.length > 0;

  const pending = Object.values(pendingMap);
  const busy = pending.length > 0;

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "end" });
  }, [messages.length, pending.length]);

  const run = (action: CopilotAction, label: string, text: string): boolean => {
    setNotice(null);
    const id = sendAiRequest(action, text, label);
    if (id === null) {
      setNotice("Not connected.");
      return false;
    }
    return true;
  };

  const send = () => {
    const text = prompt.trim();
    if (text.length === 0 || busy || !enabled) return;
    if (run("chat" as CopilotAction, text, text)) setPrompt("");
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

  const previewIdea = (text: string) => {
    if (!orders.submitCommand(text)) setNotice("Not connected.");
  };

  const btn =
    "border border-crt-line px-2 py-0.5 text-xs hover:bg-crt-line/30 disabled:opacity-40 disabled:cursor-not-allowed";

  const bubble = (m: CopilotMessage) => {
    const mine = m.role === "user";
    const tone = mine
      ? "border-crt-line bg-crt-line/20"
      : m.role === "error"
        ? "border-red-500 text-red-400"
        : "border-crt-line";
    const analysis = m.kind === "analysis" && m.requestId !== undefined ? ai.analyses[m.requestId] : undefined;
    return (
      <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
        <div
          className={`max-w-[85%] border px-2 py-1 ${tone}`}
          role={m.role === "error" ? "alert" : undefined}
        >
          <div className="whitespace-pre-wrap break-words">{m.text}</div>
          {analysis !== undefined && analysis.analysis.suggested_order !== null ? (
            <div className="mt-1 flex items-center gap-2">
              {analysis.preview !== null ? (
                <button type="button" className={btn} onClick={() => previewIdea(analysis.preview?.text ?? "")}>
                  Preview order
                </button>
              ) : (
                <span className="text-amber">{analysis.previewError?.message ?? "No preview available."}</span>
              )}
            </div>
          ) : null}
          <div className="mt-0.5 text-[10px] opacity-50">{localTime(m.ts)}</div>
        </div>
      </div>
    );
  };

  return (
    <div className={`flex h-full min-h-0 flex-col gap-2 text-xs ${large ? "text-sm" : ""}`} aria-label="AI Copilot">
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
              {p.id} ({p.id === "ollama" && ollamaSelected !== null ? ollamaSelected : p.model}){p.reason !== null ? ` — ${p.reason}` : ""}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={`${btn} ml-auto`}
          disabled={messages.length === 0}
          onClick={clearCopilotChat}
        >
          Clear chat
        </button>
      </div>
      <OllamaModelSelect id="copilot-ollama-model" />
      {!enabled ? <div className="text-amber">No AI provider is available.</div> : null}

      <div
        className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto border border-crt-line/50 p-1"
        aria-label="Copilot transcript"
        aria-live="polite"
      >
        {messages.length === 0 && !busy ? <div className="opacity-50">Ask the Copilot anything about the market.</div> : null}
        {messages.map(bubble)}
        {pending.map((p) => (
          <SpinnerBubble
            key={p.requestId}
            label={p.label}
            startedAt={p.startedAt}
            onCancel={() => cancelAiRequest(p.requestId)}
          />
        ))}
        <div ref={endRef} />
      </div>

      <div className="flex flex-wrap gap-1">
        <button
          type="button"
          className={btn}
          disabled={!enabled || busy}
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
          disabled={!enabled || busy}
          onClick={() => run("create_strategy", "Create strategy", prompt.trim() || `Strategy for ${symbol}`)}
        >
          Create strategy
        </button>
        <button
          type="button"
          className={btn}
          disabled={!enabled || busy}
          onClick={() => run("scan", "Scan opportunities", prompt.trim() || "Scan opportunities")}
        >
          Scan opportunities
        </button>
      </div>

      {notice !== null ? <div className="text-amber">{notice}</div> : null}

      <div className="flex items-end gap-1">
        <textarea
          aria-label="Copilot prompt"
          className="min-h-[2.5rem] w-full resize-none border border-crt-line bg-transparent p-1"
          placeholder={PLACEHOLDER}
          value={prompt}
          rows={large ? 3 : 2}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button type="button" className={btn} disabled={!enabled || busy || prompt.trim().length === 0} onClick={send}>
          Send
        </button>
      </div>
    </div>
  );
}

export default CopilotPanel;
