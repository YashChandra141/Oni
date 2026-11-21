// Anthropic Messages API implementation of JsonLlmProvider (design D2, task 9.3).
//
// POST https://api.anthropic.com/v1/messages
//   headers: x-api-key, anthropic-version, content-type
//   body:    { model, max_tokens, system, messages: [{role:"user", content}],
//              output_config: { format: { type: "json_schema", schema } } }
// Structured output uses output_config.format, not forced tool use (forced tool_choice returns
// HTTP 400 on some current models). The first text block is parsed as JSON and returned
// unvalidated; the caller validates it with Zod (trading-safety rule 4).
// The key is sent only in the x-api-key header and is never put in an error message.

import { z } from "zod";
import { redactSecrets } from "../config.ts";
import {
  LlmBadOutput,
  LlmRefused,
  LlmTimeout,
  LlmUnavailable,
  type JsonLlmProvider,
  type JsonRequest,
} from "./provider.ts";
import type { ProviderFactory } from "./registry.ts";

export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
export const ANTHROPIC_VERSION = "2026-10-21";

export type AnthropicFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface AnthropicProviderOptions {
  readonly apiKey: string;
  /** Default model comes from config (ANTHROPIC_MODEL). */
  readonly model: string;
  readonly fetch?: AnthropicFetch;
  readonly baseUrl?: string;
}

const Block = z.looseObject({ type: z.string(), text: z.string().optional() });
const Envelope = z.looseObject({
  stop_reason: z.string().nullable().optional(),
  content: z.array(Block).optional(),
});

export function createAnthropicProvider(options: AnthropicProviderOptions): JsonLlmProvider {
  const { apiKey, model } = options;
  const doFetch: AnthropicFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const base = new URL(options.baseUrl ?? ANTHROPIC_BASE_URL);
  if (base.protocol !== "https:") throw new Error("Anthropic base URL must use https");
  const endpoint = new URL("/v1/messages", base).toString();
  const scrub = (text: string): string => redactSecrets(text, { openaiApiKey: undefined, anthropicApiKey: apiKey });

  return {
    id: "anthropic",
    model,
    async completeJson(req: JsonRequest): Promise<unknown> {
      const timeout = AbortSignal.timeout(req.timeoutMs);
      const combined = req.signal === undefined ? timeout : AbortSignal.any([timeout, req.signal]);

      let response: Response;
      try {
        response = await doFetch(endpoint, {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model,
            max_tokens: req.maxOutputTokens,
            system: req.system,
            messages: [{ role: "user", content: req.user }],
            output_config: { format: { type: "json_schema", schema: req.schema } },
          }),
          signal: combined,
        });
      } catch (error) {
        if (timeout.aborted) throw new LlmTimeout();
        if (error instanceof Error && error.name === "AbortError") throw new LlmUnavailable("The request was aborted");
        const detail = error instanceof Error ? scrub(error.message).slice(0, 200) : "";
        throw new LlmUnavailable(
          `Could not reach provider anthropic${detail === "" ? "" : `: ${detail}`}`,
        );
      }

      if (!response.ok) throw statusError(response.status);

      let raw: unknown;
      try {
        raw = await response.json();
      } catch {
        if (timeout.aborted) throw new LlmTimeout();
        if (req.signal?.aborted === true) throw new LlmUnavailable("The request was aborted");
        throw new LlmBadOutput("The language model response was not valid JSON");
      }
      return extractJson(raw);
    },
  };
}

/** Never quotes the response body. */
function statusError(status: number): LlmUnavailable {
  if (status === 401 || status === 403) {
    return new LlmUnavailable(`provider anthropic: credentials rejected (HTTP ${status})`, status);
  }
  if (status === 429) return new LlmUnavailable("provider anthropic: rate limited (HTTP 429)", status);
  if (status >= 500) return new LlmUnavailable(`provider anthropic: service failed (HTTP ${status})`, status);
  return new LlmUnavailable(`provider anthropic: request rejected (HTTP ${status})`, status);
}

function extractJson(raw: unknown): unknown {
  const parsed = Envelope.safeParse(raw);
  if (!parsed.success) throw new LlmBadOutput("The language model response had an unexpected shape");
  const { stop_reason: stopReason, content = [] } = parsed.data;
  if (stopReason === "refusal") throw new LlmRefused();
  if (stopReason === "max_tokens") throw new LlmBadOutput("The language model response was cut short");
  const block = content.find((b) => b.type === "text");
  const text = block?.text ?? "";
  if (text === "") throw new LlmBadOutput("The language model response had no text");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new LlmBadOutput();
  }
}

/** Factory for ProviderRegistry (`factories.anthropic`). Only called when the key is set. */
export const anthropicFactory: ProviderFactory = (config) => {
  if (config.anthropicApiKey === undefined) throw new Error("ANTHROPIC_API_KEY is not set");
  return createAnthropicProvider({ apiKey: config.anthropicApiKey, model: config.anthropicModel });
};
