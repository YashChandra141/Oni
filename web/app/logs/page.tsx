"use client";

import { useEffect, useState } from "react";
import { PageFrame } from "../../components/shell/PageFrame";
import { loadSession } from "../../lib/auth";
import { API_URL } from "../../lib/config";

type LogState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly lines: readonly string[] };

function toLines(body: unknown): readonly string[] {
  const list: unknown =
    Array.isArray(body) || typeof body !== "object" || body === null
      ? body
      : ((body as Record<string, unknown>)["records"] ??
        (body as Record<string, unknown>)["entries"] ??
        (body as Record<string, unknown>)["journal"] ??
        body);
  if (!Array.isArray(list)) return [];
  return (list as readonly unknown[]).map((item) => JSON.stringify(item));
}

export default function LogsPage() {
  const [state, setState] = useState<LogState>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    const token = loadSession(window.localStorage, Date.now())?.token;
    const headers: Record<string, string> = token === undefined ? {} : { Authorization: `Bearer ${token}` };
    fetch(`${API_URL}/journal`, { headers, signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body: unknown = await res.json();
        setState({ kind: "ready", lines: toLines(body) });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ kind: "error", message: error instanceof Error ? error.message : "request failed" });
      });
    return () => controller.abort();
  }, []);

  return (
    <PageFrame title="Logs">
      <p className="mb-2 text-xs text-phosphor-dim">
        Activity of the current engine run only. Nothing is stored; it clears when the engine restarts.
      </p>
      {state.kind === "loading" && <p className="text-xs text-phosphor-dim">Loading…</p>}
      {state.kind === "error" && <p className="text-xs text-amber">Could not load the activity log ({state.message}).</p>}
      {state.kind === "ready" &&
        (state.lines.length === 0 ? (
          <p className="text-xs text-phosphor-dim">No activity yet.</p>
        ) : (
          <ul aria-label="Activity log" className="space-y-0.5 font-mono text-xs">
            {state.lines.map((line, i) => (
              <li key={i} className="break-all border-b border-crt-line">
                {line}
              </li>
            ))}
          </ul>
        ))}
    </PageFrame>
  );
}
