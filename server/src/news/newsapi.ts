// NewsAPI provider (Req 19.4, 20.1, 20.2). Development use; production gating is done by the caller.
// GET https://newsapi.org/v2/everything with the key in the X-Api-Key header, never in the URL.

import { z } from "zod";
import { sanitizeItems, type NewsItem, type NewsProvider, type RawNews } from "./provider";
import { NEWS_SYMBOLS, type NewsSymbol } from "./symbols";

export const NEWSAPI_URL = "https://newsapi.org/v2/everything";
export const NEWSAPI_PAGE_SIZE = 30;

/** Same shape as `guardedFetch` in net/http.ts, which is the only caller of `fetch`. */
export type NewsFetch = (url: string, init: { method: "GET"; headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

/** Search phrase per symbol (design "News"). */
const QUERY_TERMS: Readonly<Record<NewsSymbol, string>> = {
  "BTC-USD": "Bitcoin",
  "ETH-USD": "Ethereum",
  "SOL-USD": "Solana",
  "BNB-USD": "BNB",
  "XRP-USD": "XRP",
  "DOGE-USD": "Dogecoin",
  "JUP-USD": '"Jupiter exchange"',
  "WIF-USD": "dogwifhat",
  "BONK-USD": "Bonk",
  "PEPE-USD": "Pepe",
};

/** `Bitcoin OR Ethereum OR ...` for the symbols (all ten when empty). */
export function buildQuery(symbols: readonly NewsSymbol[]): string {
  const wanted = symbols.length === 0 ? NEWS_SYMBOLS : NEWS_SYMBOLS.filter((s) => symbols.includes(s));
  return wanted.map((s) => QUERY_TERMS[s]).join(" OR ");
}

const ArticleSchema = z.looseObject({
  source: z.looseObject({ name: z.string().nullish() }).nullish(),
  title: z.string().nullish(),
  url: z.string().nullish(),
  publishedAt: z.string().nullish(),
});
const ResponseSchema = z.looseObject({
  status: z.string(),
  articles: z.array(ArticleSchema).optional(),
});

export class NewsApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "NewsApiError";
  }
}

export class NewsApiProvider implements NewsProvider {
  readonly id = "newsapi" as const;
  readonly #apiKey: string;
  readonly #fetch: NewsFetch;

  constructor(apiKey: string, fetchFn: NewsFetch) {
    this.#apiKey = apiKey;
    this.#fetch = fetchFn;
  }

  async fetch(symbols: readonly NewsSymbol[], signal: AbortSignal): Promise<NewsItem[]> {
    const params = new URLSearchParams({
      q: buildQuery(symbols),
      language: "en",
      sortBy: "publishedAt",
      pageSize: String(NEWSAPI_PAGE_SIZE),
    });
    let res: Response;
    try {
      res = await this.#fetch(`${NEWSAPI_URL}?${params.toString()}`, {
        method: "GET",
        headers: { "X-Api-Key": this.#apiKey },
        signal,
      });
    } catch (e) {
      if (signal.aborted) throw e;
      // Never forward the underlying message: it may contain the URL.
      throw new NewsApiError("newsapi request failed");
    }
    if (!res.ok) throw new NewsApiError(`newsapi http ${res.status}`, res.status);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new NewsApiError("newsapi response is not JSON");
    }
    const parsed = ResponseSchema.safeParse(body);
    if (!parsed.success || parsed.data.status !== "ok") throw new NewsApiError("newsapi response is malformed");
    const raws: RawNews[] = (parsed.data.articles ?? []).map((a) => ({
      title: a.title,
      url: a.url,
      source: a.source?.name ?? "",
      publishedAt: a.publishedAt,
    }));
    return sanitizeItems(raws);
  }
}
