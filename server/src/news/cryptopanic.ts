// CryptoPanic NewsProvider (Req 19.5, 19.7). The auth_token travels in the query string,
// so URLs are redacted before they reach any error message or log.

import { z } from "zod";
import type { CryptoPanicPlan } from "../config";
import { guardedFetch } from "../net/http";
import { sanitizeItems, type NewsItem, type NewsProvider, type RawNews } from "./provider";
import { NEWS_SYMBOLS, type NewsSymbol } from "./symbols";

export const CRYPTOPANIC_ORIGIN = "https://cryptopanic.com";

/** Fetch signature used for the request. Production passes the allowlisted wrapper. */
export type FetchFn = (url: string, init: { readonly signal: AbortSignal; readonly headers: Record<string, string> }) => Promise<Response>;

export interface CryptoPanicOptions {
  /** Read from config at call time so the key is never copied into a long-lived field. */
  readonly getApiKey: () => string | undefined;
  readonly plan: CryptoPanicPlan;
  readonly fetchFn?: FetchFn;
}

/** HTTP status codes that mean the provider is unavailable (Req 19.12, 19.13). */
export class CryptoPanicUnavailableError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`CryptoPanic unavailable (HTTP ${status})`);
    this.name = "CryptoPanicUnavailableError";
    this.status = status;
  }
}

const InstrumentSchema = z.looseObject({ code: z.string().optional() });
const PostSchema = z.looseObject({
  title: z.string(),
  published_at: z.string(),
  url: z.string().optional(),
  original_url: z.string().optional(),
  source: z.looseObject({ title: z.string().optional(), domain: z.string().optional() }).optional(),
  instruments: z.array(InstrumentSchema).optional(),
});
const ResponseSchema = z.looseObject({ results: z.array(z.unknown()) });

/** Drops the query string and fragment. Never throws. */
export function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "[invalid url]";
  }
}

export function buildUrl(plan: CryptoPanicPlan, token: string, symbols: readonly NewsSymbol[]): string {
  const list = symbols.length === 0 ? NEWS_SYMBOLS : symbols;
  const currencies = list.map((s) => s.replace(/-USD$/, "")).join(",");
  const q = new URLSearchParams({ auth_token: token, currencies, kind: "news" });
  return `${CRYPTOPANIC_ORIGIN}/api/${plan}/v2/posts/?${q.toString()}`;
}

export function createCryptoPanicProvider(opts: CryptoPanicOptions): NewsProvider {
  const doFetch: FetchFn = opts.fetchFn ?? ((url, init) => guardedFetch(url, init));
  return {
    id: "cryptopanic",
    async fetch(symbols, signal): Promise<NewsItem[]> {
      const token = opts.getApiKey();
      if (token === undefined || token === "") throw new Error("CryptoPanic API key is not set");
      const url = buildUrl(opts.plan, token, symbols);
      let res: Response;
      try {
        res = await doFetch(url, { signal, headers: { accept: "application/json" } });
      } catch (err) {
        if (signal.aborted) throw new Error(`CryptoPanic request aborted: ${safeUrl(url)}`);
        const name = err instanceof Error ? err.name : "Error";
        throw new Error(`CryptoPanic request failed (${name}): ${safeUrl(url)}`);
      }
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        throw new CryptoPanicUnavailableError(res.status);
      }
      if (!res.ok) throw new Error(`CryptoPanic HTTP ${res.status}: ${safeUrl(url)}`);
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new Error(`CryptoPanic returned invalid JSON: ${safeUrl(url)}`);
      }
      const parsed = ResponseSchema.safeParse(body);
      if (!parsed.success) throw new Error(`CryptoPanic response failed validation: ${safeUrl(url)}`);
      const raws: RawNews[] = [];
      for (const entry of parsed.data.results) {
        const post = PostSchema.safeParse(entry);
        if (!post.success) continue;
        const p = post.data;
        const codes: string[] = [];
        for (const i of p.instruments ?? []) if (i.code !== undefined) codes.push(i.code);
        raws.push({
          title: p.title,
          url: p.url ?? p.original_url,
          source: p.source?.title ?? p.source?.domain ?? "",
          publishedAt: p.published_at,
          codes,
        });
      }
      return sanitizeItems(raws);
    },
  };
}
