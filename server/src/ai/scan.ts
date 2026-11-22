/**
 * Copilot scan and strategy draft (task 10.5, Req 7.2, 7.3, 7.5, 7.6). Both only suggest: this module
 * imports no Router and builds no order Command (trading-safety rules 2 and 4).
 */
import { instrumentBySymbol } from "../instruments.ts";
import type { JsonLlmProvider } from "../llm/provider.ts";
import { AiError, mapAnalystError } from "./analyst.ts";
import type { MarketSnapshot } from "./snapshot.ts";
import {
  SCAN_JSON_SCHEMA,
  STRATEGY_JSON_SCHEMA,
  ScanEntrySchema,
  StrategyDraftSchema,
  SYSTEM_PROMPT,
  buildUserPrompt,
} from "./prompt.ts";

export const SCAN_CALL_TIMEOUT_MS = 30_000;
export const SCAN_MAX_CONCURRENCY = 3;
export const SCAN_MIN_ITEMS = 8;
export const SCAN_MAX_ITEMS = 15;
export const SCAN_MAX_OUTPUT_TOKENS = 600;
export const STRATEGY_TIMEOUT_MS = 30_000;
export const STRATEGY_MAX_OUTPUT_TOKENS = 1200;
export const STRATEGY_MAX_CHARS = 500;
export const STRATEGY_PREFIX = "draft, not executed";

export interface ScanItemResult {
  readonly symbol: string;
  readonly bias: "long" | "short" | "neutral";
  /** 0..10000, the protocol ScanItem field. */
  readonly confidence_bps: number;
  readonly summary: string;
  /** Set when this symbol's call failed; such items sort last. */
  readonly error: string | null;
}

export interface ScanInput {
  readonly provider: JsonLlmProvider;
  /** Reduced snapshots (50 candles, 5 book levels, 3 headlines), built by the caller. */
  readonly snapshots: readonly MarketSnapshot[];
  readonly signal?: AbortSignal;
}

async function scanOne(provider: JsonLlmProvider, snapshot: MarketSnapshot, signal?: AbortSignal): Promise<ScanItemResult> {
  const fail = (message: string): ScanItemResult => ({
    symbol: snapshot.symbol,
    bias: "neutral",
    confidence_bps: 0,
    summary: message,
    error: message,
  });
  try {
    const raw = await provider.completeJson({
      system: SYSTEM_PROMPT,
      user: buildUserPrompt({ snapshot, task: "scan" }),
      schemaName: "scan",
      schema: SCAN_JSON_SCHEMA,
      maxOutputTokens: SCAN_MAX_OUTPUT_TOKENS,
      timeoutMs: SCAN_CALL_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
    });
    const parsed = ScanEntrySchema.safeParse(raw);
    if (!parsed.success) return fail("The model output did not match the scan schema");
    return {
      symbol: snapshot.symbol,
      bias: parsed.data.bias,
      confidence_bps: Math.round(parsed.data.confidence * 10_000),
      summary: parsed.data.summary,
      error: null,
    };
  } catch (error) {
    const mapped = mapAnalystError(error, signal);
    if (mapped.code === "cancelled") throw mapped;
    return fail(mapped.message);
  }
}

/** Ranks by confidence descending, errors last. Ties keep input order (Array.sort is stable). */
export function rankScan(items: readonly ScanItemResult[]): ScanItemResult[] {
  return [...items].sort((a, b) => {
    if ((a.error === null) !== (b.error === null)) return a.error === null ? -1 : 1;
    return b.confidence_bps - a.confidence_bps;
  });
}

export async function scan(input: ScanInput): Promise<ScanItemResult[]> {
  const { provider, signal } = input;
  if (signal?.aborted === true) throw new AiError("cancelled", "The request was cancelled");

  const seen = new Set<string>();
  const known = input.snapshots.filter((s) => {
    if (instrumentBySymbol(s.symbol) === undefined || seen.has(s.symbol)) return false;
    seen.add(s.symbol);
    return true;
  });
  const targets = known.slice(0, SCAN_MAX_ITEMS);

  const results: (ScanItemResult | undefined)[] = new Array<ScanItemResult | undefined>(targets.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (signal?.aborted === true) throw new AiError("cancelled", "The request was cancelled");
      const i = next++;
      const snapshot = targets[i];
      if (snapshot === undefined) return;
      results[i] = await scanOne(provider, snapshot, signal);
    }
  };
  await Promise.all(Array.from({ length: Math.min(SCAN_MAX_CONCURRENCY, targets.length) }, worker));

  return rankScan(results.filter((r): r is ScanItemResult => r !== undefined));
}

export interface DraftStrategyInput {
  readonly provider: JsonLlmProvider;
  /** Optional context snapshot of the selected symbol. */
  readonly snapshot?: MarketSnapshot;
  readonly userText?: string;
  readonly signal?: AbortSignal;
}

/** Returns the draft text, always starting with "draft, not executed" and at most 500 characters. */
export async function draftStrategy(input: DraftStrategyInput): Promise<string> {
  const { provider, signal } = input;
  if (signal?.aborted === true) throw new AiError("cancelled", "The request was cancelled");

  let raw: unknown;
  try {
    raw = await provider.completeJson({
      system: SYSTEM_PROMPT,
      user: buildUserPrompt({
        snapshot: input.snapshot ?? null,
        task: "create_strategy",
        ...(input.userText === undefined ? {} : { userText: input.userText }),
      }),
      schemaName: "strategy",
      schema: STRATEGY_JSON_SCHEMA,
      maxOutputTokens: STRATEGY_MAX_OUTPUT_TOKENS,
      timeoutMs: STRATEGY_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    throw mapAnalystError(error, signal);
  }
  const parsed = StrategyDraftSchema.safeParse(raw);
  if (!parsed.success) throw new AiError("validation_error", "The model output did not match the strategy schema");

  const text = `${STRATEGY_PREFIX}: ${parsed.data.title}. ${parsed.data.description}`.replace(/\s+/g, " ");
  return Array.from(text).slice(0, STRATEGY_MAX_CHARS).join("");
}
