// Ollama JsonLlmProvider (design D4, task 9.5, Req 3.6, 3.7).
//
// POST {OLLAMA_BASE_URL}/api/chat with the JSON schema in `format` and `stream: false`. No key.
// Availability (GET /api/tags) is probed by the registry. The base URL never appears in an
// error message (trading-safety rule 6).

import { z } from "zod";
import {
  LlmBadOutput,
  LlmTimeout,
  LlmUnavailable,
  type JsonLlmProvider,
  type JsonRequest,
} from "./provider.ts";

export type OllamaFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface OllamaProviderOptions {
  /** OLLAMA_BASE_URL. */
  readonly baseUrl: string;
  /** Default comes from config (OLLAMA_MODEL). */
  readonly model: string;
  readonly fetch?: OllamaFetch;
}

const Envelope = z.looseObject({
  message: z.looseObject({ content: z.string().nullish() }),
  done_reason: z.string().nullish(),
});

export function createOllamaProvider(options: OllamaProviderOptions): JsonLlmProvider {
  const { model } = options;
  const doFetch: OllamaFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const base = new URL(options.baseUrl);
  if (base.protocol !== "https:" && base.protocol !== "http:") throw new Error("Ollama base URL must be http(s)");
  if (base.username !== "" || base.password !== "") throw new Error("Ollama base URL must not carry credentials");
  const endpoint = `${base.origin}${base.pathname.replace(/\/+$/, "")}/api/chat`;

  return {
    id: "ollama",
    model,
    async completeJson(req: JsonRequest): Promise<unknown> {
      const timeout = AbortSignal.timeout(req.timeoutMs);
      const combined = req.signal === undefined ? timeout : AbortSignal.any([timeout, req.signal]);
      const body = {
        model,
        stream: false,
        format: req.schema,
        options: { num_predict: req.maxOutputTokens, temperature: 0 },
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
      };

      let response: Response;
      try {
        response = await doFetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: combined,
          redirect: "error",
        });
      } catch {
        // Never forward the error text: it can carry the URL.
        if (timeout.aborted) throw new LlmTimeout();
        if (req.signal?.aborted === true) throw new LlmUnavailable("The request was aborted");
        throw new LlmUnavailable("Could not reach the language model service");
      }
      if (!response.ok) {
        throw new LlmUnavailable(`The language model service failed (HTTP ${response.status})`, response.status);
      }

      let raw: unknown;
      try {
        raw = await response.json();
      } catch {
        if (timeout.aborted) throw new LlmTimeout();
        throw new LlmBadOutput("The language model response was not valid JSON");
      }
      const parsed = Envelope.safeParse(raw);
      if (!parsed.success) throw new LlmBadOutput("The language model response had an unexpected shape");
      if (parsed.data.done_reason === "length") throw new LlmBadOutput("The language model response was cut short");
      const text = parsed.data.message.content ?? "";
      if (text.trim() === "") throw new LlmBadOutput("The language model response had no text");
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new LlmBadOutput();
      }
    },
  };
}
