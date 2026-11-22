// Provider time limits (Req 3.14). Rate and daily-cap enforcement (Req 4.8, 4.9) is a later task.

/** Plain-English order parser. */
export const PARSER_TIMEOUT_MS = 15_000;
/** AI analyst and Copilot actions. */
export const ANALYST_TIMEOUT_MS = 30_000;
/** Ollama: a cold-loaded local model can be slow. */
export const OLLAMA_PARSER_TIMEOUT_MS = 60_000;
export const OLLAMA_ANALYST_TIMEOUT_MS = 120_000;
/**
 * Callers pick the limit: Ollama gets the longer one, other providers keep their own.
 * Providers honour the requested timeout exactly.
 */
export function timeoutForProvider(providerId: string, requested: number): number {
  if (providerId !== "ollama") return requested;
  return requested >= ANALYST_TIMEOUT_MS ? OLLAMA_ANALYST_TIMEOUT_MS : OLLAMA_PARSER_TIMEOUT_MS;
}
/** Ollama availability probe (`GET /api/tags`). */
export const OLLAMA_PROBE_TIMEOUT_MS = 2_000;
/** Minimum gap between Ollama availability probes. */
export const OLLAMA_RECHECK_MS = 30_000;
