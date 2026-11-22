// Ollama `GET /api/tags` body parser (Req 38.1 to 38.4, 38.20).
//
// The whole body is rejected (null) when it is not the expected shape or lists more than
// MAX_OLLAMA_MODELS entries. Entries whose name fails MODEL_NAME_RE are dropped one by one.
// Names, families, and sizes are display data only. Nothing here logs.

import { z } from "zod";
import type { OllamaModel } from "../protocol.ts";

export const MAX_OLLAMA_MODELS = 100;

/** 1 to 128 characters of A-Z a-z 0-9 . _ : / @ - (Req 38.2). */
export const MODEL_NAME_RE = /^[A-Za-z0-9._:/@-]{1,128}$/;

const Entry = z.looseObject({
  name: z.string(),
  size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  details: z
    .looseObject({
      family: z.string().nullish(),
      parameter_size: z.string().nullish(),
    })
    .nullish(),
});

const Body = z.looseObject({ models: z.array(Entry) });

/** The accepted models, or null when the whole body must be treated as a failed probe (Req 38.3). */
export function parseTags(body: unknown): OllamaModel[] | null {
  const parsed = Body.safeParse(body);
  if (!parsed.success) return null;
  if (parsed.data.models.length > MAX_OLLAMA_MODELS) return null;
  const out: OllamaModel[] = [];
  for (const m of parsed.data.models) {
    if (!MODEL_NAME_RE.test(m.name)) continue;
    out.push({
      name: m.name,
      size: m.size,
      family: m.details?.family ?? null,
      parameter_size: m.details?.parameter_size ?? null,
    });
  }
  return out;
}
