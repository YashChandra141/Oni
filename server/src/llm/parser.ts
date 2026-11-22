// LLM_Order_Parser (Req 23.2, 23.3, 23.4, 23.5, 23.6, 23.7, Task 13.2, design "LLM_Order_Parser").
//
//   `?` text → LlmProvider.interpret → Zod IntentSchema → canonical command text
//            → the normal Command_Parser → ParsedCommand
//
// The result is a ParsedCommand only. This module has no Router, no PreviewStore, and no
// socket: the gateway turns the command into an Order_Preview, and the order reaches the Router
// only after the same connection confirms that preview (Req 23.6, trading-safety rules 3, 4).
//
// The model output is untrusted (trading-safety rules 4 and 10):
//   - it is validated with a strict Zod schema, so an extra field such as `account_id` fails;
//   - it is turned into text, then parsed by the same parser as typed commands, so every grammar,
//     tick, lot, and range rule applies;
//   - the account for `%` amounts is the caller's `accountId` argument, never a model field.
// Error messages never quote model output or user text, and never contain the API key (the
// provider scrubs its own errors; this module adds nothing from the environment).

import { INSTRUMENTS } from "../instruments.ts";
import { unitsToFixed, unitsToTrimmed } from "../commands/formatter.ts";
import { type ParsedCommand, decimalToUnits, parseCommand, resolveSymbol } from "../commands/parser.ts";
import type { AccountId } from "../protocol.ts";
import { INTENT_JSON_SCHEMA, INTENT_SCHEMA_NAME, type LlmIntent, IntentSchema } from "./intentSchema.ts";
import { PARSER_TIMEOUT_MS, timeoutForProvider } from "./limits.ts";
import { MAX_OUTPUT_TOKENS, SYSTEM_PROMPT, buildUserMessage } from "./openai.ts";
import {
  type JsonLlmProvider,
  type LlmContext,
  type LlmProvider,
  type LlmProviderId,
  isLlmError,
} from "./provider.ts";

/** The part of ProviderRegistry the parser reads. */
export interface LlmProviderSource {
  get(id: LlmProviderId, model?: string): JsonLlmProvider | undefined;
  defaultId(): LlmProviderId | null;
  refresh?(): Promise<void>;
  chooseOllamaModel?(preferred?: string): string | undefined;
}

/** Time limit for the whole interpretation (Req 23.5). The OpenAI provider enforces the same. */
export const LLM_PARSE_TIMEOUT_MS = 15_000;

/** Shown for `?` input when no OPENAI_API_KEY is set (Req 23.7). */
export const LLM_DISABLED_MESSAGE = "Plain-English orders are disabled: no language model is configured on this server.";

export type LlmParseResult =
  | {
      readonly ok: true;
      readonly command: ParsedCommand;
      /** The canonical command text the intent was turned into (what the preview shows). */
      readonly text: string;
    }
  | { readonly ok: false; readonly kind: "disabled"; readonly message: string }
  | { readonly ok: false; readonly kind: "error"; readonly message: string };

export interface LlmOrderParserOptions {
  /** Null when OPENAI_API_KEY is unset: the parser is then disabled (Req 23.7). */
  readonly provider?: LlmProvider | null;
  /** Provider registry (task 9.6). Used when `provider` is not set. */
  readonly registry?: LlmProviderSource | null;
  /** Signed position of an account in a full symbol, in lots. */
  readonly positionLots: (accountId: AccountId, symbol: string) => bigint;
  /** Last trade price in ticks, or null when there is none. */
  readonly lastPrice: (symbol: string) => bigint | null;
  /** Defaults to LLM_PARSE_TIMEOUT_MS. Injectable for tests. */
  readonly timeoutMs?: number;
}

type TextResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string };

const BAD_INTENT = "Could not turn that into an order. Try rephrasing, or type a command such as BUY BTC 0.1 LMT 64000.";

/** `percent` as a plain decimal string with at most 4 fraction digits (never exponent form). */
function percentText(percent: number): string {
  const fixed = percent.toFixed(4);
  return fixed.replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * Turns a validated intent into canonical command text (design: "the Command_Formatter").
 * The text is then parsed by `parseCommand`, which applies every real rule. Pure.
 */
export function intentToCommandText(intent: LlmIntent, lastPrice: (symbol: string) => bigint | null): TextResult {
  switch (intent.action) {
    case "cancel_all":
      return { ok: true, text: "CANCEL ALL" };
    case "flatten":
      return { ok: true, text: "FLAT" };
    case "unclear":
      return { ok: false, message: "I could not tell what order you meant. Try rephrasing." };
    case "place":
      break;
  }

  if (intent.side === null || intent.symbol === null || intent.amount === null || intent.order_type === null) {
    return { ok: false, message: "The request is missing a side, symbol, amount, or order type." };
  }
  const instrument = resolveSymbol(intent.symbol);
  if (instrument === undefined) return { ok: false, message: "The request names a symbol that is not available." };

  const amount = "absolute" in intent.amount ? intent.amount.absolute : `${percentText(intent.amount.percent_of_position)}%`;
  const head = `${intent.side === "buy" ? "BUY" : "SELL"} ${instrument.symbol} ${amount}`;

  if (intent.order_type === "market") {
    if (intent.price !== null) return { ok: false, message: "A market order cannot have a price." };
    return { ok: true, text: head };
  }
  if (intent.price === null) return { ok: false, message: "A limit or stop order needs a price." };

  let priceText: string;
  if ("absolute" in intent.price) {
    const units = decimalToUnits(intent.price.absolute, instrument.price_decimals);
    if ("error" in units) return { ok: false, message: "The price is not valid for this symbol." };
    priceText = unitsToFixed(units.units, instrument.price_decimals);
  } else {
    const last = lastPrice(instrument.symbol);
    if (last === null) return { ok: false, message: "There is no recent price to compute a relative price from." };
    // pct is a percent; scale it to millionths (1% = 10_000). Whole-number math only.
    const scaled = Math.round(intent.price.relative_to_last_pct * 10_000);
    if (!Number.isSafeInteger(scaled)) return { ok: false, message: "The relative price is out of range." };
    const factor = 1_000_000n + BigInt(scaled);
    if (factor <= 0n) return { ok: false, message: "The relative price is out of range." };
    const units = (last * factor) / 1_000_000n;
    if (units <= 0n) return { ok: false, message: "The relative price is out of range." };
    priceText = unitsToFixed(units, instrument.price_decimals);
  }
  return { ok: true, text: `${head} ${intent.order_type === "limit" ? "LMT" : "STP"} ${priceText}` };
}

export class LlmOrderParser {
  readonly #provider: LlmProvider | null;
  readonly #registry: LlmProviderSource | null;
  readonly #positionLots: LlmOrderParserOptions["positionLots"];
  readonly #lastPrice: LlmOrderParserOptions["lastPrice"];
  readonly #timeoutMs: number;

  constructor(options: LlmOrderParserOptions) {
    this.#provider = options.provider ?? null;
    this.#registry = options.registry ?? null;
    this.#positionLots = options.positionLots;
    this.#lastPrice = options.lastPrice;
    this.#timeoutMs = options.timeoutMs ?? LLM_PARSE_TIMEOUT_MS;
  }

  /** False when no provider is configured (Req 23.7). */
  get enabled(): boolean {
    return this.#provider !== null || (this.#registry !== null && this.#registry.defaultId() !== null);
  }

  /** The legacy single provider, or the selected / default registry provider, as one `interpret`. */
  async #resolve(providerId: LlmProviderId | undefined, ollamaModel?: string): Promise<LlmProvider | null> {
    if (this.#provider !== null) return this.#provider;
    const registry = this.#registry;
    if (registry === null) return null;
    await registry.refresh?.();
    const id = providerId !== undefined && registry.get(providerId) !== undefined ? providerId : registry.defaultId();
    if (id === null) return null;
    let json: JsonLlmProvider | undefined;
    if (id === "ollama" && registry.chooseOllamaModel !== undefined) {
      // Req 38.12, 38.13: selected model if installed, else OLLAMA_MODEL, else the first installed.
      const model = registry.chooseOllamaModel(ollamaModel);
      json = model === undefined ? undefined : registry.get("ollama", model);
    } else {
      json = registry.get(id);
    }
    if (json === undefined) return null;
    return {
      interpret: (text, context, signal) =>
        json.completeJson({
          system: SYSTEM_PROMPT,
          user: buildUserMessage(text, context),
          schemaName: INTENT_SCHEMA_NAME,
          schema: INTENT_JSON_SCHEMA,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          timeoutMs: timeoutForProvider(json.id, PARSER_TIMEOUT_MS),
          ...(signal === undefined ? {} : { signal }),
        }),
    };
  }

  /**
   * Interprets the text after the `?`. `accountId` comes from the verified session of the
   * requesting connection; it only scopes the context and the `%` resolution. `providerId` is
   * the connection's selected provider; it falls back to the default when unavailable.
   */
  async parse(
    text: string,
    accountId: AccountId,
    providerId?: LlmProviderId,
    ollamaModel?: string,
  ): Promise<LlmParseResult> {
    const provider = await this.#resolve(providerId, ollamaModel);
    if (provider === null) return { ok: false, kind: "disabled", message: LLM_DISABLED_MESSAGE };

    const request = text.trim();
    if (request === "") return { ok: false, kind: "error", message: "Type an order after the ?" };

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("llm timeout"));
      }, this.#timeoutMs);
    });

    let raw: unknown;
    try {
      raw = await Promise.race([provider.interpret(request, this.#context(accountId), controller.signal), deadline]);
    } catch (error) {
      // Req 23.5: timeout or provider error → error, no preview. Typed provider errors carry
      // safe messages (the provider scrubs the key); anything else gets a generic text.
      const message = isLlmError(error) ? error.message : "The language model did not answer in time or failed.";
      return { ok: false, kind: "error", message };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      // The losing provider call may reject later; it must not become an unhandled rejection.
      deadline.catch(() => {});
    }

    // Req 23.2, 23.4: validate; any failure is an error with no preview.
    const validated = IntentSchema.safeParse(raw);
    if (!validated.success) return { ok: false, kind: "error", message: BAD_INTENT };

    const built = intentToCommandText(validated.data, this.#lastPrice);
    if (!built.ok) return { ok: false, kind: "error", message: built.message };

    // Req 23.3: the normal Command_Parser. The result is the same ParsedCommand as typing.
    const parsed = parseCommand(built.text, {
      positionLots: (symbol) => this.#positionLots(accountId, symbol),
    });
    if (!parsed.ok) {
      return { ok: false, kind: "error", message: `The request is not a valid order: ${parsed.error.message}` };
    }
    return { ok: true, command: parsed.command, text: built.text };
  }

  #context(accountId: AccountId): LlmContext {
    const positions: Record<string, string> = {};
    const lastPrices: Record<string, string> = {};
    for (const instrument of INSTRUMENTS) {
      const lots = this.#positionLots(accountId, instrument.symbol);
      const abs = lots < 0n ? -lots : lots;
      positions[instrument.symbol] = `${lots < 0n ? "-" : ""}${unitsToTrimmed(abs, instrument.qty_decimals)}`;
      const last = this.#lastPrice(instrument.symbol);
      if (last !== null) lastPrices[instrument.symbol] = unitsToFixed(last, instrument.price_decimals);
    }
    return { symbols: INSTRUMENTS.map((i) => i.symbol), positions, lastPrices };
  }
}
