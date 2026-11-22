// NVIDIA NIM JsonLlmProvider (design D3, task 9.4, Req 3.5).
//
// OpenAI-compatible chat completions: POST {NVIDIA_BASE_URL}/chat/completions with
// `nvext.guided_json` plus `response_format: {type: "json_object"}`. When the endpoint rejects
// that request with HTTP 400 or 422 (no `nvext` support), it retries once, same provider,
// without `nvext`, and puts the schema in the system prompt instead.
// The key and base URL never appear in an error message (trading-safety rule 6).

import { z } from "zod";
import { GuardedFetchError, type GuardedRequestInit } from "../net/http.ts";
import {
  LlmBadOutput,
  LlmRefused,
  LlmTimeout,
  LlmUnavailable,
  type JsonLlmProvider,
  type JsonRequest,
} from "./provider.ts";

export const NVIDIA_DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1";

export type FetchLike = (input: string, init: GuardedRequestInit) => Promise<Response>;

export interface NvidiaProviderOptions {
  readonly apiKey: string;
  /** Default comes from config (NVIDIA_MODEL). */
  readonly model: string;
  readonly fetch: FetchLike;
  /** NVIDIA_BASE_URL. Defaults to https://integrate.api.nvidia.com/v1. */
  readonly baseUrl?: string;
}

const Choice = z.looseObject({
  finish_reason: z.string().nullish(),
  message: z.looseObject({
    content: z.string().nullish(),
    refusal: z.string().nullish(),
  }),
});
const Envelope = z.looseObject({ choices: z.array(Choice) });

type Attempt = { readonly ok: true; readonly body: unknown } | { readonly ok: false; readonly status: number };

export function createNvidiaProvider(options: NvidiaProviderOptions): JsonLlmProvider {
  const { apiKey, model, fetch: doFetch } = options;
  const base = new URL(options.baseUrl ?? NVIDIA_DEFAULT_BASE_URL);
  if (base.protocol !== "https:" && base.protocol !== "http:") throw new Error("NVIDIA base URL must be http(s)");
  if (base.username !== "" || base.password !== "") throw new Error("NVIDIA base URL must not carry credentials");
  const endpoint = `${base.origin}${base.pathname.replace(/\/+$/, "")}/chat/completions`;

  async function attempt(req: JsonRequest, withNvext: boolean, combined: AbortSignal): Promise<Attempt> {
    const system = withNvext
      ? req.system
      : `${req.system}\n\nAnswer with one JSON object that matches this JSON Schema:\n${JSON.stringify(req.schema)}`;
    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: req.user },
      ],
      max_tokens: req.maxOutputTokens,
      stream: false,
      response_format: { type: "json_object" },
    };
    if (withNvext) body["nvext"] = { guided_json: req.schema };

    let response: Response;
    try {
      response = await doFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: combined,
        redirect: "error",
        timeoutMs: req.timeoutMs + 1000,
      });
    } catch (err) {
      // Never forward the error text: it can carry the URL.
      if (err instanceof GuardedFetchError) {
        if (err.kind === "timeout") throw new LlmTimeout();
        if (err.kind === "refused") throw new LlmUnavailable("The language model host is not allowlisted");
      }
      throw new LlmUnavailable("Could not reach the language model service");
    }
    if (!response.ok) return { ok: false, status: response.status };
    try {
      return { ok: true, body: await response.json() };
    } catch {
      throw new LlmBadOutput("The language model response was not valid JSON");
    }
  }

  return {
    id: "nvidia",
    model,
    async completeJson(req: JsonRequest): Promise<unknown> {
      const timeout = AbortSignal.timeout(req.timeoutMs);
      const combined = req.signal === undefined ? timeout : AbortSignal.any([timeout, req.signal]);

      let result: Attempt;
      try {
        result = await attempt(req, true, combined);
        if (!result.ok && (result.status === 400 || result.status === 422)) {
          result = await attempt(req, false, combined);
        }
      } catch (error) {
        if (timeout.aborted) throw new LlmTimeout();
        if (req.signal?.aborted === true) throw new LlmUnavailable("The request was aborted");
        throw error;
      }
      if (!result.ok) throw statusError(result.status);
      return extractJson(result.body);
    },
  };
}

/** The response body is not quoted: error text can echo part of a key. */
function statusError(status: number): LlmUnavailable {
  if (status === 401 || status === 403) {
    return new LlmUnavailable(`The language model service rejected the credentials (HTTP ${status})`, status);
  }
  if (status === 429) return new LlmUnavailable("The language model service is rate limited (HTTP 429)", status);
  if (status >= 500) return new LlmUnavailable(`The language model service failed (HTTP ${status})`, status);
  return new LlmUnavailable(`The language model service rejected the request (HTTP ${status})`, status);
}

function extractJson(raw: unknown): unknown {
  const parsed = Envelope.safeParse(raw);
  const choice = parsed.success ? parsed.data.choices[0] : undefined;
  if (choice === undefined) throw new LlmBadOutput("The language model response had an unexpected shape");

  const refusal = choice.message.refusal;
  if (typeof refusal === "string" && refusal !== "") throw new LlmRefused();
  if (choice.finish_reason === "content_filter") throw new LlmRefused();
  if (choice.finish_reason === "length") throw new LlmBadOutput("The language model response was cut short");

  const text = choice.message.content ?? "";
  if (text.trim() === "") throw new LlmBadOutput("The language model response had no text");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new LlmBadOutput();
  }
}
