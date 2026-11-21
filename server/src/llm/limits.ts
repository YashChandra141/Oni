// Provider time limits (Req 3.14). Rate and daily-cap enforcement (Req 4.8, 4.9) is a later task.

/** Plain-English order parser. */
export const PARSER_TIMEOUT_MS = 15_000;
/** AI analyst and Copilot actions. */
export const ANALYST_TIMEOUT_MS = 30_000;
/** Ollama availability probe (`GET /api/tags`). */
export const OLLAMA_PROBE_TIMEOUT_MS = 2_000;
/** Minimum gap between Ollama availability probes. */
export const OLLAMA_RECHECK_MS = 30_000;
