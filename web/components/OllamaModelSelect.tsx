"use client";

// Local Ollama model picker for the Copilot panel and Settings page (Task 19.4, Req 38.15-38.17).
// Always shows the status line and, when models exist, the list. Picking a model also switches
// the provider to ollama.

import { useState } from "react";
import { firstOtherProvider, formatModelLabel, localModelValue } from "../lib/ollamaModels";
import { useTerminalStore } from "../lib/store";

export function OllamaModelSelect({ id }: { id: string }) {
  const [noOther, setNoOther] = useState(false);
  const clearOllamaModel = useTerminalStore((s) => s.clearOllamaModel);
  const providers = useTerminalStore((s) => s.providers);
  const models = useTerminalStore((s) => s.ollamaModels);
  const defaultModel = useTerminalStore((s) => s.ollamaDefault);
  const selectedModel = useTerminalStore((s) => s.ollamaSelected);
  const setOllamaModel = useTerminalStore((s) => s.setOllamaModel);
  const setProvider = useTerminalStore((s) => s.setProvider);

  const info = providers.available.find((p) => p.id === "ollama");
  if (info === undefined) return null;

  if (models.length === 0) {
    return info.reason === "no models" ? (
      <div className="text-amber">No local models. Run `ollama pull &lt;model&gt;`</div>
    ) : (
      <div className="text-amber">Ollama not reachable at the configured URL</div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div>Ollama: {models.length} {models.length === 1 ? "model" : "models"}</div>
      <div className="flex items-center gap-2">
        <label htmlFor={id}>Local models (Ollama)</label>
        <select
          id={id}
          aria-label="Ollama model"
          className="min-w-0 max-w-full border border-crt-line bg-transparent px-1 py-0.5"
          value={localModelValue(providers.selected, selectedModel, defaultModel)}
          onChange={(e) => {
            if (e.target.value === "") {
              const other = firstOtherProvider(providers.available);
              if (other === null) {
                setNoOther(true);
                return;
              }
              setNoOther(false);
              clearOllamaModel();
              setProvider(other);
              return;
            }
            setNoOther(false);
            setProvider("ollama");
            setOllamaModel(e.target.value);
          }}
        >
          <option value="">None</option>
          {models.map((m) => (
            <option key={m.name} value={m.name}>
              {formatModelLabel(m)}
            </option>
          ))}
        </select>
      </div>
      {noOther ? <div className="text-amber">No other provider available</div> : null}
    </div>
  );
}
