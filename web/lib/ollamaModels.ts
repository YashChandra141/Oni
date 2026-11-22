// Pure helpers for the local Ollama model picker (Task 19.4, Req 38.15-38.17).

import type { OllamaModel } from "../../shared/protocol/index";

/** localStorage key that remembers the user's chosen Ollama model. */
export const OLLAMA_MODEL_KEY = "oni.ollamaModel";

/** Formats a byte count with decimal units (base 1000, as `ollama list` does): 4.3 GB. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1000 && i < units.length - 1) {
    value /= 1000;
    i += 1;
  }
  return i === 0 ? `${Math.round(value)} B` : `${value.toFixed(1)} ${units[i]}`;
}

/** "name · family · parameter_size · size", skipping null parts. */
export function formatModelLabel(m: OllamaModel): string {
  const parts: string[] = [m.name];
  if (m.family !== null && m.family !== "") parts.push(m.family);
  if (m.parameter_size !== null && m.parameter_size !== "") parts.push(m.parameter_size);
  parts.push(formatBytes(m.size));
  return parts.join(" · ");
}

/** Returns the stored name only when the list still offers it. */
export function reapplyStored(models: readonly OllamaModel[], stored: string | null): string | null {
  if (stored === null) return null;
  return models.some((m) => m.name === stored) ? stored : null;
}

export function readStoredModel(): string | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem(OLLAMA_MODEL_KEY);
  } catch {
    return null;
  }
}

export function writeStoredModel(name: string): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(OLLAMA_MODEL_KEY, name);
  } catch {
    // Storage may be blocked; the choice then lasts for this connection only.
  }
}

export function clearStoredModel(): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(OLLAMA_MODEL_KEY);
  } catch {
    // Storage may be blocked; nothing to clear then.
  }
}

/** Value of the local models <select>: "" (None) unless ollama is the active provider. */
export function localModelValue(
  activeProvider: string | null,
  selected: string | null,
  def: string | null,
): string {
  if (activeProvider !== "ollama") return "";
  return selected ?? def ?? "";
}

/** First available non-ollama provider id, in list order, or null. */
export function firstOtherProvider<T extends { id: string; reason: string | null }>(
  available: readonly T[],
): T["id"] | null {
  return available.find((p) => p.id !== "ollama" && p.reason === null)?.id ?? null;
}
