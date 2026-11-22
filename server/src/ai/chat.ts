/**
 * Copilot chat. A plain-text reply only: this module imports no Router and builds no order Command
 * or preview (trading-safety rules 2 and 4). The reply is untrusted text for display.
 */
import { timeoutForProvider } from "../llm/limits.ts";
import type { JsonLlmProvider } from "../llm/provider.ts";
import { AiError, mapAnalystError } from "./analyst.ts";
import { CHAT_JSON_SCHEMA, ChatReplySchema, SYSTEM_PROMPT, buildUserPrompt } from "./prompt.ts";
import type { MarketSnapshot } from "./snapshot.ts";

export const CHAT_TIMEOUT_MS = 30_000;
export const CHAT_MAX_OUTPUT_TOKENS = 1200;
export const CHAT_MAX_CHARS = 4000;

export interface ChatInput {
  readonly provider: JsonLlmProvider;
  readonly snapshot?: MarketSnapshot;
  readonly userText: string;
  readonly signal?: AbortSignal;
}

/** Removes control characters except newline and tab. */
function cleanReply(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  return text.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "").trim();
}

export async function chat(input: ChatInput): Promise<string> {
  const { provider, signal } = input;
  if (signal?.aborted === true) throw new AiError("cancelled", "The request was cancelled");

  let raw: unknown;
  try {
    raw = await provider.completeJson({
      system: SYSTEM_PROMPT,
      user: buildUserPrompt({ snapshot: input.snapshot ?? null, task: "chat", userText: input.userText }),
      schemaName: "chat",
      schema: CHAT_JSON_SCHEMA,
      maxOutputTokens: CHAT_MAX_OUTPUT_TOKENS,
      timeoutMs: timeoutForProvider(provider.id, CHAT_TIMEOUT_MS),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    throw mapAnalystError(error, signal);
  }
  const parsed = ChatReplySchema.safeParse(raw);
  if (!parsed.success) throw new AiError("validation_error", "The model output did not match the chat schema");
  const text = Array.from(cleanReply(parsed.data.reply)).slice(0, CHAT_MAX_CHARS).join("");
  if (text === "") throw new AiError("validation_error", "The model returned an empty reply");
  return text;
}
