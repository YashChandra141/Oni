// LLM_Provider interface (Req 23.1, 23.5, design "LLM_Order_Parser").
//
// A provider turns plain-English text into an UNVALIDATED JSON value. It never
// trades and never validates: the LLM_Order_Parser (Task 13.2) checks the value with
// the Zod intent schema and turns it into command text (trading-safety rule 4).

/** What the model may know about the caller's account. All numbers are decimal strings. */
export interface LlmContext {
  /** Internal symbols the model may name, e.g. `BTC-USD`. */
  readonly symbols: readonly string[];
  /** Signed position size per symbol, as a decimal string. Missing or "0" means flat. */
  readonly positions: Readonly<Record<string, string>>;
  /** Last trade price per symbol, as a decimal string. A symbol with no price is omitted. */
  readonly lastPrices: Readonly<Record<string, string>>;
}

/** One structured-output request to a provider (design "LLM providers"). */
export interface JsonRequest {
  readonly system: string;
  readonly user: string;
  /** `[a-zA-Z0-9_-]{1,64}`. */
  readonly schemaName: string;
  /** Provider-ready JSON Schema (additionalProperties false, every property required). */
  readonly schema: Readonly<Record<string, unknown>>;
  readonly maxOutputTokens: number;
  /** 15 000 for the parser, 30 000 for the analyst (Req 3.14). */
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export type LlmProviderId = "openai" | "anthropic" | "nvidia" | "ollama";

/**
 * Provider-neutral structured completion. Implementations (tasks 9.2 to 9.5) reject with the
 * typed errors below, and never put a key, URL, or response body in an error message.
 */
export interface JsonLlmProvider {
  readonly id: LlmProviderId;
  readonly model: string;
  /** Parsed JSON, unvalidated. The caller validates it with Zod (trading-safety rule 4). */
  completeJson(req: JsonRequest): Promise<unknown>;
}

export interface LlmProvider {
  /**
   * Returns the model's parsed JSON output, unvalidated. Rejects with one of the typed
   * errors below. `signal` aborts the call in addition to the provider's own time limit.
   */
  interpret(text: string, context: LlmContext, signal?: AbortSignal): Promise<unknown>;
}

/** No result within the time limit (Req 23.5). */
export class LlmTimeout extends Error {
  constructor(message = "The language model did not answer in time") {
    super(message);
    this.name = "LlmTimeout";
  }
}

/** The model declined to answer (safety refusal) or the response was cut short. */
export class LlmRefused extends Error {
  constructor(message = "The language model declined to answer") {
    super(message);
    this.name = "LlmRefused";
  }
}

/** Network failure, HTTP 429, 5xx, or a rejected key or request (Req 23.5). */
export class LlmUnavailable extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "LlmUnavailable";
    this.status = status;
  }
}

/** The response had no text or the text was not JSON. */
export class LlmBadOutput extends Error {
  constructor(message = "The language model returned output that is not valid JSON") {
    super(message);
    this.name = "LlmBadOutput";
  }
}

export type LlmError = LlmTimeout | LlmRefused | LlmUnavailable | LlmBadOutput;

export function isLlmError(error: unknown): error is LlmError {
  return (
    error instanceof LlmTimeout ||
    error instanceof LlmRefused ||
    error instanceof LlmUnavailable ||
    error instanceof LlmBadOutput
  );
}
