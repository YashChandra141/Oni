/**
 * AI_Analyst (task 10.3, Req 5.4 to 5.7, 5.12). Calls the selected provider, validates the answer
 * with Zod, and turns a valid trade idea into canonical command text.
 *
 * This module only suggests. It imports no Router, no engine sender, and builds no order Command
 * (trading-safety rules 2 and 4). The gateway parses `commandText` with the Command_Parser into an
 * Order_Preview, setting venue and account from the server; the order reaches the Router only
 * through Confirm on that stored preview.
 */
import type { JsonLlmProvider, LlmProviderId } from "../llm/provider.ts";
import { isLlmError, LlmBadOutput, LlmRefused, LlmTimeout, LlmUnavailable } from "../llm/provider.ts";
import { timeoutForProvider } from "../llm/limits.ts";
import { OLLAMA_MODEL_MISSING } from "../llm/ollama.ts";
import type { MarketSnapshot } from "./snapshot.ts";
import { ANALYSIS_JSON_SCHEMA, AnalysisSchema, SYSTEM_PROMPT, buildUserPrompt } from "./prompt.ts";
import type { AnalysisOutput, TradeIdeaOutput } from "./prompt.ts";

export const ANALYST_TIMEOUT_MS = 30_000;
export const ANALYST_MAX_OUTPUT_TOKENS = 1200;

export type AiErrorCode =
  | "validation_error"
  | "timeout"
  | "refused"
  | "provider_unavailable"
  | "cancelled";

/** Typed failure of an analyst call. The message never carries a key, URL, or model output. */
export class AiError extends Error {
  readonly code: AiErrorCode;

  constructor(code: AiErrorCode, message: string) {
    super(message);
    this.name = "AiError";
    this.code = code;
  }
}

export interface AnalyzeInput {
  readonly provider: JsonLlmProvider;
  readonly snapshot: MarketSnapshot;
  /** Headlines, untrusted. */
  readonly news?: readonly string[];
  readonly userText?: string;
  readonly signal?: AbortSignal;
}

export interface AnalysisResult {
  readonly provider: LlmProviderId;
  readonly model: string;
  readonly analysis: AnalysisOutput;
  /** Canonical command text for the gateway to parse, or null when there is no trade idea. */
  readonly commandText: string | null;
}

/** `BUY BTC-USD 0.05 LMT 59000.00` from a validated idea. Tick and lot checks happen in the parser. */
export function tradeIdeaToCommandText(symbol: string, idea: TradeIdeaOutput): string {
  const side = idea.side === "buy" ? "BUY" : "SELL";
  return `${side} ${symbol} ${idea.qty} LMT ${idea.entry}`;
}

export function mapAnalystError(error: unknown, signal: AbortSignal | undefined): AiError {
  return mapError(error, signal);
}

function mapError(error: unknown, signal: AbortSignal | undefined): AiError {
  if (signal?.aborted === true) return new AiError("cancelled", "The request was cancelled");
  if (error instanceof LlmTimeout) return new AiError("timeout", "The language model did not answer in time");
  if (error instanceof LlmRefused) return new AiError("refused", "The language model declined to answer");
  if (error instanceof LlmBadOutput) return new AiError("validation_error", "The model output was not valid JSON");
  if (error instanceof LlmUnavailable && error.status === 404 && error.message === OLLAMA_MODEL_MISSING) {
    return new AiError("provider_unavailable", "The selected Ollama model is not installed");
  }
  if (error instanceof LlmUnavailable && error.status !== undefined) {
    return new AiError("provider_unavailable", `The language model is unavailable (HTTP ${error.status})`);
  }
  if (isLlmError(error)) return new AiError("provider_unavailable", "The language model is unavailable");
  return new AiError("provider_unavailable", "The language model call failed");
}

export async function analyze(input: AnalyzeInput): Promise<AnalysisResult> {
  const { provider, snapshot, signal } = input;
  if (signal?.aborted === true) throw new AiError("cancelled", "The request was cancelled");

  const user = buildUserPrompt({
    snapshot,
    task: "analyze",
    ...(input.news === undefined ? {} : { news: input.news }),
    ...(input.userText === undefined ? {} : { userText: input.userText }),
  });

  let raw: unknown;
  try {
    raw = await provider.completeJson({
      system: SYSTEM_PROMPT,
      user,
      schemaName: "analysis",
      schema: ANALYSIS_JSON_SCHEMA,
      maxOutputTokens: ANALYST_MAX_OUTPUT_TOKENS,
      timeoutMs: timeoutForProvider(provider.id, ANALYST_TIMEOUT_MS),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    throw mapError(error, signal);
  }

  const parsed = AnalysisSchema.safeParse(raw);
  if (!parsed.success) throw new AiError("validation_error", "The model output did not match the analysis schema");
  const analysis = parsed.data;

  return {
    provider: provider.id,
    model: provider.model,
    analysis,
    commandText: analysis.trade_idea === null ? null : tradeIdeaToCommandText(snapshot.symbol, analysis.trade_idea),
  };
}
