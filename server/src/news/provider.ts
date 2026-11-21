// NewsProvider interface, strict NewsItem schema, and sanitization (Req 19.1, 19.11, 19.15).
// NewsItem matches the protocol NewsItem: { id, title, source, url, published_at (ms), symbols }.

import { z } from "zod";
import { mergeSymbols, NEWS_SYMBOLS, type NewsSymbol } from "./symbols";

export const NEWS_PROVIDER_IDS = ["newsapi", "cryptopanic"] as const;
export type NewsProviderId = (typeof NEWS_PROVIDER_IDS)[number];

export const MAX_TITLE_CHARS = 200;
export const MAX_SOURCE_CHARS = 60;
export const MAX_URL_CHARS = 2000;
export const MAX_NEWS_ITEMS = 30;

export const NewsItemSchema = z
  .object({
    id: z.string().min(1).max(64),
    title: z.string().min(1).max(MAX_TITLE_CHARS),
    source: z.string().max(MAX_SOURCE_CHARS),
    url: z
      .string()
      .max(MAX_URL_CHARS)
      .refine((u) => isHttpUrl(u)),
    published_at: z.number().int().nonnegative(),
    symbols: z.array(z.enum(NEWS_SYMBOLS)).max(NEWS_SYMBOLS.length),
  })
  .strict();
export type NewsItem = z.infer<typeof NewsItemSchema>;

export interface NewsProvider {
  readonly id: NewsProviderId;
  /** Fetches validated items for the symbols (all ten when empty). Rejects on failure or abort. */
  fetch(symbols: readonly NewsSymbol[], signal: AbortSignal): Promise<NewsItem[]>;
}

/** Fields a provider response is reduced to before sanitization. Items are rebuilt from these, never copied. */
export interface RawNews {
  readonly title: unknown;
  readonly url: unknown;
  readonly source: unknown;
  readonly publishedAt: unknown;
  /** CryptoPanic instrument codes. */
  readonly codes?: readonly string[];
}

export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (u.protocol === "http:" || u.protocol === "https:") && u.username === "" && u.password === "";
  } catch {
    return false;
  }
}

/** Strips tags, decodes a few entities, removes control characters, collapses whitespace. */
export function cleanText(input: string, max: number): string {
  const noTags = input.replace(/<[^>]*>/g, " ");
  const decoded = noTags
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&");
  // Decoding may expose new tags, so strip again.
  const stripped = decoded.replace(/<[^>]*>/g, " ");
  // eslint-disable-next-line no-control-regex
  const noControl = stripped.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ");
  const collapsed = noControl.replace(/\s+/g, " ").trim();
  return Array.from(collapsed).slice(0, max).join("").trim();
}

function toMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.trunc(value);
  if (typeof value === "string" && value !== "") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/** Stable id from the URL. */
function itemId(url: string): string {
  return `n_${Bun.hash(url).toString(16)}`;
}

/** Builds one NewsItem from raw fields, or null if it must be dropped (Req 19.11). */
export function sanitizeItem(raw: RawNews): NewsItem | null {
  if (typeof raw.title !== "string" || typeof raw.url !== "string") return null;
  const title = cleanText(raw.title, MAX_TITLE_CHARS);
  const url = raw.url.trim();
  const publishedAt = toMs(raw.publishedAt);
  if (title === "" || publishedAt === null || url.length > MAX_URL_CHARS || !isHttpUrl(url)) return null;
  const source = typeof raw.source === "string" ? cleanText(raw.source, MAX_SOURCE_CHARS) : "";
  const parsed = NewsItemSchema.safeParse({
    id: itemId(url),
    title,
    source,
    url,
    published_at: publishedAt,
    symbols: mergeSymbols(title, raw.codes),
  });
  return parsed.success ? parsed.data : null;
}

/** Sanitizes a batch: drops invalid and duplicate-URL items, sorts newest first, keeps at most 30. */
export function sanitizeItems(raws: readonly RawNews[]): NewsItem[] {
  const seen = new Set<string>();
  const items: NewsItem[] = [];
  for (const raw of raws) {
    const item = sanitizeItem(raw);
    if (item === null || seen.has(item.url)) continue;
    seen.add(item.url);
    items.push(item);
  }
  items.sort((a, b) => b.published_at - a.published_at);
  return items.slice(0, MAX_NEWS_ITEMS);
}
