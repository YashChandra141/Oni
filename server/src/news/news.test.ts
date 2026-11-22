// Task 11.5: mock-server tests for both news providers, the cache, and production gating.
// Validates: Requirements 19.4, 19.5, 19.7, 19.9, 19.12, 20.1, 20.2.
// No test contacts a real host: providers get a fetch function that points at a local Bun.serve mock.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../config";
import { MAX_BACKOFF_MS, NEWSAPI_DAILY_CAP, NewsCache, createConfiguredNewsProvider, type NewsLogger } from "./cache";
import { buildUrl, createCryptoPanicProvider, CryptoPanicUnavailableError, safeUrl, type FetchFn } from "./cryptopanic";
import { NewsApiError, NewsApiProvider, type NewsFetch } from "./newsapi";
import type { NewsItem, NewsProvider } from "./provider";

const FAKE_NEWSAPI_KEY = "FAKE-newsapi-key-0000";
const FAKE_CP_KEY = "FAKE-cryptopanic-token-0000";
const DAY_MS = 86_400_000;

async function fixture(name: string): Promise<unknown> {
  return Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).json();
}

type Mode =
  | { kind: "json"; body: unknown }
  | { kind: "text"; body: string }
  | { kind: "status"; status: number };

let mode: Mode = { kind: "status", status: 500 };
const seen: { url: string; headers: Headers }[] = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      seen.push({ url: req.url, headers: req.headers });
      if (mode.kind === "json") return Response.json(mode.body);
      if (mode.kind === "text") return new Response(mode.body, { headers: { "content-type": "application/json" } });
      return new Response("error", { status: mode.status });
    },
  });
});

afterAll(() => {
  void server.stop(true);
});

beforeEach(() => {
  seen.length = 0;
});

/** Rewrites the provider's real URL to the local mock, keeping path and query. */
function toMock(url: string): string {
  const u = new URL(url);
  return `http://127.0.0.1:${server.port}${u.pathname}${u.search}`;
}

const newsApiFetch: NewsFetch = (url, init) => fetch(toMock(url), init);
const cryptoFetch: FetchFn = (url, init) => fetch(toMock(url), init);

function newsApi(): NewsApiProvider {
  return new NewsApiProvider(FAKE_NEWSAPI_KEY, newsApiFetch);
}
function cryptoPanic(): NewsProvider {
  return createCryptoPanicProvider({ getApiKey: () => FAKE_CP_KEY, plan: "developer", fetchFn: cryptoFetch });
}

function signal(): AbortSignal {
  return AbortSignal.timeout(5000);
}

function collectLogger(): NewsLogger & { lines: string[] } {
  const lines: string[] = [];
  return { lines, warn: (m) => void lines.push(m) };
}

function expectNoSecrets(text: string): void {
  expect(text).not.toContain(FAKE_NEWSAPI_KEY);
  expect(text).not.toContain(FAKE_CP_KEY);
  expect(text).not.toContain("auth_token=");
}

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected rejection");
}

describe("NewsAPI provider (Req 19.4)", () => {
  test("success: sanitizes, dedupes, sorts newest first, key in header only", async () => {
    mode = { kind: "json", body: await fixture("newsapi_everything.json") };
    const items = await newsApi().fetch([], signal());
    expect(items.map((i) => i.url)).toEqual([
      "https://example.com/news/sol-upgrade",
      "https://example.com/news/btc-weekly-high",
    ]);
    expect(items[0]?.title).toBe("Solana network upgrade ships");
    expect(items[0]?.symbols).toEqual(["SOL-USD"]);
    expect(items[1]?.symbols).toEqual(["BTC-USD"]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers.get("x-api-key")).toBe(FAKE_NEWSAPI_KEY);
    expect(seen[0]?.url).not.toContain(FAKE_NEWSAPI_KEY);
  });

  test("malformed payload and invalid JSON are rejected without leaking the key", async () => {
    mode = { kind: "json", body: await fixture("malformed.json") };
    const e1 = await rejection(newsApi().fetch([], signal()));
    expect(e1).toBeInstanceOf(NewsApiError);
    mode = { kind: "text", body: "{not json" };
    const e2 = await rejection(newsApi().fetch([], signal()));
    expect(e2).toBeInstanceOf(NewsApiError);
    expectNoSecrets(`${e1.message} ${e2.message}`);
  });

  test("HTTP errors and rate limit carry the status", async () => {
    for (const status of [401, 429, 500]) {
      mode = { kind: "status", status };
      const e = await rejection(newsApi().fetch([], signal()));
      expect(e).toBeInstanceOf(NewsApiError);
      expect((e as NewsApiError).status).toBe(status);
      expectNoSecrets(e.message);
    }
  });

  test("a network failure message that contains the key is not forwarded", async () => {
    const leaky: NewsFetch = (url) => Promise.reject(new Error(`connect failed ${url} key=${FAKE_NEWSAPI_KEY}`));
    const e = await rejection(new NewsApiProvider(FAKE_NEWSAPI_KEY, leaky).fetch([], signal()));
    expectNoSecrets(e.message);
  });
});

describe("CryptoPanic provider (Req 19.5, 19.7)", () => {
  test("success: maps posts, instrument codes, and fallback URL/source", async () => {
    mode = { kind: "json", body: await fixture("cryptopanic_posts.json") };
    const items = await cryptoPanic().fetch(["BTC-USD", "ETH-USD"], signal());
    expect(items.map((i) => i.url)).toEqual([
      "https://example.com/news/meme-listing",
      "https://example.com/news/eth-fees",
    ]);
    expect(items[0]?.symbols).toEqual(["BONK-USD"]);
    expect(items[0]?.source).toBe("example.com");
    expect(items[1]?.symbols).toEqual(["ETH-USD"]);
    expect(seen).toHaveLength(1);
    const url = new URL(seen[0]?.url ?? "");
    expect(url.pathname).toBe("/api/developer/v2/posts/");
    expect(url.searchParams.get("currencies")).toBe("BTC,ETH");
    expect(url.searchParams.get("auth_token")).toBe(FAKE_CP_KEY);
  });

  test("buildUrl uses all ten symbols when none are given", () => {
    const q = new URL(buildUrl("growth", FAKE_CP_KEY, [])).searchParams.get("currencies") ?? "";
    expect(q.split(",")).toHaveLength(10);
  });

  test("safeUrl drops the query string", () => {
    expect(safeUrl(buildUrl("developer", FAKE_CP_KEY, []))).toBe("https://cryptopanic.com/api/developer/v2/posts/");
    expect(safeUrl("not a url")).toBe("[invalid url]");
  });

  test("malformed payload and invalid JSON are rejected without URL or key", async () => {
    mode = { kind: "json", body: await fixture("malformed.json") };
    const e1 = await rejection(cryptoPanic().fetch([], signal()));
    mode = { kind: "text", body: "<html>" };
    const e2 = await rejection(cryptoPanic().fetch([], signal()));
    expect(e1.message).toContain("validation");
    expect(e2.message).toContain("invalid JSON");
    expectNoSecrets(`${e1.message} ${e2.message}`);
  });

  test("401/403/404 mean unavailable; 429 and 500 are plain failures", async () => {
    for (const status of [401, 403, 404]) {
      mode = { kind: "status", status };
      const e = await rejection(cryptoPanic().fetch([], signal()));
      expect(e).toBeInstanceOf(CryptoPanicUnavailableError);
      expect((e as CryptoPanicUnavailableError).status).toBe(status);
      expectNoSecrets(e.message);
    }
    for (const status of [429, 500]) {
      mode = { kind: "status", status };
      const e = await rejection(cryptoPanic().fetch([], signal()));
      expect(e).not.toBeInstanceOf(CryptoPanicUnavailableError);
      expect(e.message).toContain(String(status));
      expectNoSecrets(e.message);
    }
  });

  test("a network failure whose message holds the full URL is redacted", async () => {
    const leaky: FetchFn = (url) => Promise.reject(new Error(`connect failed ${url}`));
    const p = createCryptoPanicProvider({ getApiKey: () => FAKE_CP_KEY, plan: "developer", fetchFn: leaky });
    const e = await rejection(p.fetch([], signal()));
    expectNoSecrets(e.message);
    const aborted = AbortSignal.abort();
    const e2 = await rejection(p.fetch([], aborted));
    expectNoSecrets(e2.message);
  });

  test("a missing key fails without a request", async () => {
    const p = createCryptoPanicProvider({ getApiKey: () => undefined, plan: "developer", fetchFn: cryptoFetch });
    await rejection(p.fetch([], signal()));
    expect(seen).toHaveLength(0);
  });
});

describe("production gating of NewsAPI (Req 20.1, 20.2)", () => {
  const base = {
    NODE_ENV: "production",
    SESSION_SECRET: "FAKE-session-secret-0123456789abcdef0123456789",
    NEWS_PROVIDER: "newsapi",
    NEWS_API_KEY: FAKE_NEWSAPI_KEY,
  };

  function load(env: Record<string, string>) {
    const r = loadConfig(env);
    if (!r.ok) throw new Error("config should load");
    return r;
  }

  test("newsapi is disabled in production and a warning is produced", () => {
    const r = load(base);
    expect(r.config.newsProvider).toBe("none");
    expect(r.warnings.some((w) => w.includes("disabled in production"))).toBe(true);
    expect(createConfiguredNewsProvider(r.config)).toBeNull();
    for (const w of r.warnings) expectNoSecrets(w);
  });

  test("NEWS_ALLOW_NEWSAPI_IN_PRODUCTION=true overrides the disable", () => {
    const r = load({ ...base, NEWS_ALLOW_NEWSAPI_IN_PRODUCTION: "true" });
    expect(r.config.newsProvider).toBe("newsapi");
    expect(createConfiguredNewsProvider(r.config)?.id).toBe("newsapi");
  });

  test("newsapi works outside production and cryptopanic is the production default", () => {
    const dev = load({ NODE_ENV: "development", NEWS_API_KEY: FAKE_NEWSAPI_KEY });
    expect(dev.config.newsProvider).toBe("newsapi");
    const prod = load({ NODE_ENV: "production", SESSION_SECRET: base.SESSION_SECRET, CRYPTOPANIC_API_KEY: FAKE_CP_KEY });
    expect(prod.config.newsProvider).toBe("cryptopanic");
    expect(createConfiguredNewsProvider(prod.config)?.id).toBe("cryptopanic");
  });
});

describe("NewsCache (Req 19.9, 19.12)", () => {
  type Timer = { fn: () => void; delay: number };
  const realSetTimeout = globalThis.setTimeout;
  let timers: Timer[] = [];

  beforeEach(() => {
    timers = [];
    // Records the schedule instead of waiting. Only the cache runs while the stub is installed.
    globalThis.setTimeout = ((fn: () => void, delay?: number) => {
      timers.push({ fn, delay: delay ?? 0 });
      return { unref() {} };
    }) as unknown as typeof setTimeout;
  });
  afterEach(() => {
    globalThis.setTimeout = realSetTimeout;
  });

  const lastDelay = (): number => timers[timers.length - 1]?.delay ?? -1;

  function item(n: number): NewsItem {
    return { id: `n_${n}`, title: `Bitcoin ${n}`, source: "t", url: `https://example.com/${n}`, published_at: n, symbols: ["BTC-USD"] };
  }

  /** A provider whose behaviour the test steers. */
  function stub(id: "newsapi" | "cryptopanic", steps: (() => NewsItem[])[] = []) {
    const state = { calls: 0, steps };
    const provider: NewsProvider = {
      id,
      fetch: () => {
        state.calls += 1;
        const step = state.steps.shift();
        return step === undefined ? Promise.resolve([item(1)]) : Promise.resolve().then(step);
      },
    };
    return { provider, state };
  }
  const fail = (): NewsItem[] => {
    throw new Error("boom");
  };

  test("TTL: success schedules the next refresh after the TTL and exposes top items", async () => {
    const { provider } = stub("cryptopanic", [() => [item(2), item(1)]]);
    const cache = new NewsCache({ provider, ttlSeconds: 60, now: () => 1000, logger: collectLogger() });
    expect(cache.state().updatedAt).toBeNull();
    cache.start(); // scheduling is a no-op until started
    await cache.refresh();
    expect(lastDelay()).toBe(60_000);
    expect(cache.state()).toMatchObject({ available: true, updatedAt: 1000 });
    expect(cache.top(1).map((i) => i.id)).toEqual(["n_2"]);
  });

  test("start() schedules an immediate first refresh; no provider is a no-op", () => {
    const { provider } = stub("cryptopanic");
    const cache = new NewsCache({ provider, ttlSeconds: 60 });
    cache.start();
    expect(timers.map((t) => t.delay)).toEqual([0]);
    cache.stop();
    const none = new NewsCache({ provider: null, ttlSeconds: 60 });
    none.start();
    expect(none.enabled).toBe(false);
    expect(none.state().available).toBe(false);
    expect(timers).toHaveLength(1);
  });

  test("failure keeps old items, backs off exponentially up to 30 minutes, and success resets", async () => {
    const steps: (() => NewsItem[])[] = [() => [item(1)], fail, fail, fail, ...Array.from({ length: 12 }, () => fail), () => [item(3)]];
    const { provider } = stub("cryptopanic", steps);
    const logger = collectLogger();
    const cache = new NewsCache({ provider, ttlSeconds: 60, logger });
    cache.start();
    await cache.refresh();
    expect(lastDelay()).toBe(60_000);
    await cache.refresh();
    expect(lastDelay()).toBe(120_000);
    await cache.refresh();
    expect(lastDelay()).toBe(240_000);
    await cache.refresh();
    expect(lastDelay()).toBe(480_000);
    expect(cache.top().map((i) => i.id)).toEqual(["n_1"]);
    expect(cache.state().available).toBe(true);
    for (let i = 0; i < 12; i += 1) await cache.refresh();
    expect(lastDelay()).toBe(MAX_BACKOFF_MS);
    await cache.refresh();
    expect(lastDelay()).toBe(60_000);
    expect(cache.top().map((i) => i.id)).toEqual(["n_3"]);
    expect(logger.lines.length).toBeGreaterThan(0);
  });

  test("401/403/404 mark the provider unavailable and stop refreshing (Req 19.12)", async () => {
    for (const status of [401, 403, 404]) {
      const calls = { n: 0 };
      const provider: NewsProvider = {
        id: "cryptopanic",
        fetch: () => {
          calls.n += 1;
          return Promise.reject(new CryptoPanicUnavailableError(status));
        },
      };
      const logger = collectLogger();
      const cache = new NewsCache({ provider, ttlSeconds: 60, logger });
      const updates: boolean[] = [];
      cache.onUpdate((s) => void updates.push(s.available));
      await cache.refresh();
      await cache.refresh();
      expect(calls.n).toBe(1);
      expect(cache.state().available).toBe(false);
      expect(cache.top()).toEqual([]);
      expect(updates).toEqual([false]);
      expect(logger.lines[0]).toContain(String(status));
    }
  });

  test("a NewsAPI 401 is unavailable too, a 429 only backs off", async () => {
    const mk = (status: number) => {
      const provider: NewsProvider = { id: "newsapi", fetch: () => Promise.reject(new NewsApiError("x", status)) };
      const c = new NewsCache({ provider, ttlSeconds: 60, logger: collectLogger() });
      c.start();
      return c;
    };
    const a = mk(401);
    await a.refresh();
    expect(a.state().available).toBe(false);
    const b = mk(429);
    await b.refresh();
    expect(b.state().available).toBe(true);
    expect(lastDelay()).toBe(120_000);
  });

  test("NewsAPI is capped at 80 requests per UTC day and resets next day (fake clock)", async () => {
    const { provider, state } = stub("newsapi");
    let now = 5 * DAY_MS + 1000;
    const cache = new NewsCache({ provider, ttlSeconds: 60, now: () => now, logger: collectLogger() });
    cache.start();
    for (let i = 0; i < NEWSAPI_DAILY_CAP + 5; i += 1) await cache.refresh();
    expect(state.calls).toBe(NEWSAPI_DAILY_CAP);
    expect(lastDelay()).toBe(60_000);
    expect(cache.state().available).toBe(true);
    now = 6 * DAY_MS + 1;
    await cache.refresh();
    expect(state.calls).toBe(NEWSAPI_DAILY_CAP + 1);
  });

  test("CryptoPanic is not subject to the NewsAPI cap", async () => {
    const { provider, state } = stub("cryptopanic");
    const cache = new NewsCache({ provider, ttlSeconds: 60, now: () => 0, logger: collectLogger() });
    for (let i = 0; i < NEWSAPI_DAILY_CAP + 5; i += 1) await cache.refresh();
    expect(state.calls).toBe(NEWSAPI_DAILY_CAP + 5);
  });

  test("end to end against the mock: logs never hold the key or a full request URL", async () => {
    const run = async (provider: NewsProvider, statuses: number[]) => {
      const logger = collectLogger();
      const cache = new NewsCache({ provider, ttlSeconds: 60, logger });
      for (const status of statuses) {
        mode = { kind: "status", status };
        await cache.refresh();
      }
      mode = { kind: "text", body: "garbage" };
      await cache.refresh();
      return logger.lines.join("\n");
    };
    const cp = await run(cryptoPanic(), [500, 429]);
    const na = await run(newsApi(), [500, 429]);
    expect(cp.length).toBeGreaterThan(0);
    expect(na.length).toBeGreaterThan(0);
    expectNoSecrets(cp);
    expectNoSecrets(na);
    expect(cp).not.toContain("https://");
    expect(na).not.toContain("https://");
  });
});
