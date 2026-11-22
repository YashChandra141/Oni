// Server-memory news cache (Task 11.4, Req 19.8 to 19.13). Refreshes the configured provider
// every NEWS_TTL_SECONDS through guardedFetch, keeps the latest sanitized items (at most 30,
// newest first, unique URLs), keeps serving old items on failure, backs off up to 30 minutes,
// caps NewsAPI at 80 requests per UTC day, and marks the provider unavailable on 401/403/404.
// Keys and URLs are never logged: only the provider id and an HTTP status or error name.

import type { Config } from "../config";
import { guardedFetch } from "../net/http";
import { createCryptoPanicProvider, CryptoPanicUnavailableError } from "./cryptopanic";
import { NewsApiError, NewsApiProvider } from "./newsapi";
import type { NewsItem, NewsProvider } from "./provider";

export const NEWSAPI_DAILY_CAP = 80;
export const MAX_BACKOFF_MS = 30 * 60 * 1000;
export const SNAPSHOT_NEWS_ITEMS = 10;
const REQUEST_TIMEOUT_MS = 15_000;
const DAY_MS = 86_400_000;

export interface NewsLogger {
  warn(message: string): void;
}

export interface NewsCacheOptions {
  /** Null when news is not configured. */
  readonly provider: NewsProvider | null;
  readonly ttlSeconds: number;
  readonly now?: () => number;
  readonly logger?: NewsLogger;
}

export interface NewsState {
  readonly available: boolean;
  readonly items: readonly NewsItem[];
  readonly updatedAt: number | null;
}

export type NewsListener = (state: NewsState) => void;

export class NewsCache {
  readonly #provider: NewsProvider | null;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #log: NewsLogger;
  readonly #listeners = new Set<NewsListener>();
  #items: readonly NewsItem[] = [];
  #updatedAt: number | null = null;
  #unavailable = false;
  #failures = 0;
  #day = -1;
  #dayCount = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #stopped = true;
  #running = false;

  constructor(options: NewsCacheOptions) {
    this.#provider = options.provider;
    this.#ttlMs = options.ttlSeconds * 1000;
    this.#now = options.now ?? Date.now;
    this.#log = options.logger ?? { warn: (m) => console.warn(m) };
  }

  /** True when a provider is configured (Hello.news_enabled). */
  get enabled(): boolean {
    return this.#provider !== null;
  }

  state(): NewsState {
    return {
      available: this.#provider !== null && !this.#unavailable,
      items: this.#items,
      updatedAt: this.#updatedAt,
    };
  }

  /** The newest `n` items for the Market_Snapshot (Req 19.9). Empty when unavailable. */
  top(n: number = SNAPSHOT_NEWS_ITEMS): readonly NewsItem[] {
    return this.#unavailable ? [] : this.#items.slice(0, n);
  }

  onUpdate(listener: NewsListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Starts the refresh loop with an immediate first refresh. No-op without a provider. */
  start(): void {
    if (this.#provider === null || !this.#stopped) return;
    this.#stopped = false;
    this.#schedule(0);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #schedule(delayMs: number): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      void this.refresh();
    }, delayMs);
    this.#timer.unref();
  }

  /** One refresh attempt. Never rejects. Schedules the next one. */
  async refresh(): Promise<void> {
    const provider = this.#provider;
    if (provider === null || this.#unavailable || this.#running) return;
    this.#running = true;
    try {
      if (provider.id === "newsapi" && !this.#takeNewsApiSlot()) {
        this.#schedule(this.#ttlMs);
        return;
      }
      try {
        const items = await provider.fetch([], AbortSignal.timeout(REQUEST_TIMEOUT_MS));
        this.#items = items;
        this.#updatedAt = this.#now();
        this.#failures = 0;
        this.#emit();
        this.#schedule(this.#ttlMs);
      } catch (err) {
        const status = unavailableStatus(err);
        if (status !== null) {
          this.#unavailable = true;
          this.#log.warn(`[news] ${provider.id} unavailable (HTTP ${status}); news disabled until restart`);
          this.#emit();
          return;
        }
        // Keep serving the old items; retry with exponential backoff capped at 30 minutes.
        this.#failures += 1;
        const name = err instanceof Error ? err.name : "Error";
        this.#log.warn(`[news] ${provider.id} refresh failed (${name}); keeping cached items`);
        this.#schedule(Math.min(MAX_BACKOFF_MS, this.#ttlMs * 2 ** Math.min(this.#failures, 10)));
      }
    } finally {
      this.#running = false;
    }
  }

  #takeNewsApiSlot(): boolean {
    const day = Math.floor(this.#now() / DAY_MS);
    if (day !== this.#day) {
      this.#day = day;
      this.#dayCount = 0;
    }
    if (this.#dayCount >= NEWSAPI_DAILY_CAP) return false;
    this.#dayCount += 1;
    return true;
  }

  #emit(): void {
    const state = this.state();
    for (const listener of [...this.#listeners]) {
      try {
        listener(state);
      } catch {
        // A failing listener must not stop the others.
      }
    }
  }
}

function unavailableStatus(err: unknown): number | null {
  if (err instanceof CryptoPanicUnavailableError) return err.status;
  if (err instanceof NewsApiError && err.status !== undefined && [401, 403, 404].includes(err.status)) {
    return err.status;
  }
  return null;
}

/** Builds the provider the config selects (production gating is already in `config.newsProvider`). */
export function createConfiguredNewsProvider(
  config: Pick<Config, "newsProvider" | "newsApiKey" | "cryptopanicApiKey" | "cryptopanicPlan">,
): NewsProvider | null {
  if (config.newsProvider === "newsapi" && config.newsApiKey !== undefined) {
    return new NewsApiProvider(config.newsApiKey, (url, init) => guardedFetch(url, init));
  }
  if (config.newsProvider === "cryptopanic" && config.cryptopanicApiKey !== undefined) {
    return createCryptoPanicProvider({
      getApiKey: () => config.cryptopanicApiKey,
      plan: config.cryptopanicPlan,
      fetchFn: (url, init) => guardedFetch(url, init),
    });
  }
  return null;
}
