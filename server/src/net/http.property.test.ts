// Property 24: the allowlist permits exactly its rules (Task 6.22; Req 14.3, 14.9, 14.10).
//
// TypeScript twin of rust/crates/engine/src/feed/allowlist_properties.rs. It checks `isAllowed`
// (the pure matcher) and `createGuardedFetch` (the wrapper that `guardedFetch` is built from)
// against an oracle that is written here from the design table, not copied from `buildRules`.
// No test touches the network: the wrapper gets a fake `fetchImpl` that counts calls.
//
// **Validates: Requirements 14.3, 14.9, 14.10**
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { buildRules, createGuardedFetch, GuardedFetchError, isAllowed, type AllowlistConfig } from "./http.ts";

const NUM_RUNS = 300;

// --- Configs ---------------------------------------------------------------------------------
// NVIDIA_BASE_URL and OLLAMA_BASE_URL decide two hosts of the allowlist, so the properties run on
// two configs with different host, port, scheme, path prefix, and trailing slash.

interface Base {
  readonly scheme: "https" | "http";
  readonly host: string;
  readonly port: string;
  readonly prefix: string;
  readonly slash: boolean;
}
interface ConfigParts {
  readonly nvidia: Base;
  readonly ollama: Base;
  readonly plan: string;
}

const CONFIGS: readonly ConfigParts[] = [
  {
    nvidia: { scheme: "https", host: "integrate.api.nvidia.com", port: "", prefix: "/v1", slash: false },
    ollama: { scheme: "http", host: "localhost", port: "11434", prefix: "", slash: false },
    plan: "developer",
  },
  {
    nvidia: { scheme: "https", host: "nim.internal.example", port: "8443", prefix: "/openai/v1", slash: true },
    ollama: { scheme: "https", host: "ollama.example.org", port: "", prefix: "/prefix", slash: false },
    plan: "growth",
  },
];

function baseUrl(b: Base): string {
  return `${b.scheme}://${b.host}${b.port === "" ? "" : `:${b.port}`}${b.prefix}${b.slash ? "/" : ""}`;
}

function toConfig(parts: ConfigParts): AllowlistConfig {
  return {
    nvidiaBaseUrl: baseUrl(parts.nvidia),
    ollamaBaseUrl: baseUrl(parts.ollama),
    cryptopanicPlan: parts.plan,
  };
}

interface Rule {
  readonly scheme: string;
  readonly host: string;
  readonly port: string;
  readonly path: string;
  readonly methods: readonly string[];
}

/** The design table, written out by hand. */
function expectedRules(c: ConfigParts): readonly Rule[] {
  const r = (scheme: string, host: string, port: string, path: string, method: string): Rule => ({
    scheme,
    host,
    port,
    path,
    methods: [method],
  });
  return [
    r("https", "newsapi.org", "", "/v2/everything", "GET"),
    r("https", "cryptopanic.com", "", `/api/${c.plan}/v2/posts/`, "GET"),
    r("https", "api.openai.com", "", "/v1/responses", "POST"),
    r("https", "api.anthropic.com", "", "/v1/messages", "POST"),
    r(c.nvidia.scheme, c.nvidia.host, c.nvidia.port, `${c.nvidia.prefix}/chat/completions`, "POST"),
    r(c.nvidia.scheme, c.nvidia.host, c.nvidia.port, `${c.nvidia.prefix}/models`, "GET"),
    r(c.ollama.scheme, c.ollama.host, c.ollama.port, `${c.ollama.prefix}/api/chat`, "POST"),
    r(c.ollama.scheme, c.ollama.host, c.ollama.port, `${c.ollama.prefix}/api/tags`, "GET"),
  ];
}

// --- Oracle ----------------------------------------------------------------------------------

interface Req {
  readonly scheme: string;
  readonly userinfo: string;
  readonly host: string;
  readonly port: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;
  readonly method: string;
}

/** A port equal to the scheme default is the same as no port (WHATWG URL). */
function effectivePort(scheme: string, port: string): string {
  return (scheme === "https" && port === "443") || (scheme === "http" && port === "80") ? "" : port;
}

function urlOf(q: Req): string {
  return `${q.scheme}://${q.userinfo}${q.host}${q.port === "" ? "" : `:${q.port}`}${q.path}${q.query}${q.fragment}`;
}

function oracle(rules: readonly Rule[], q: Req): boolean {
  if (q.userinfo !== "" || q.fragment !== "") return false;
  return rules.some(
    (r) =>
      r.scheme === q.scheme &&
      r.host === q.host &&
      effectivePort(r.scheme, r.port) === effectivePort(q.scheme, q.port) &&
      r.path === q.path &&
      r.methods.includes(q.method.toUpperCase()),
  );
}

// --- Generators ------------------------------------------------------------------------------

const METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "get", "post"] as const;
const SCHEMES = ["https", "http", "ws", "wss", "ftp"] as const;
const PORTS = ["", "443", "80", "8443", "11434", "9999", "65535"] as const;
const QUERIES = ["", "", "?a=1", "?auth_token=abc", "?q=/transaction"] as const;
const FRAGMENTS = ["", "", "", "#f"] as const;
const USERINFO = ["", "", "", "u:p@", "u@", "user:pass@"] as const;

function lookalikes(host: string): string[] {
  return [
    `evil.${host}`,
    `x${host}`,
    `${host}.evil.com`,
    `${host}x`,
    `${host}.`,
    host.replace(".", "-"),
    host.replace(".", ""),
    `${host}.evil`,
    "transaction-v1.raydium.io",
    "api.jup.ag",
    "api-v3.raydium.io",
  ];
}

function pathVariants(path: string): string[] {
  const noSlash = path.replace(/\/$/, "");
  return [
    path,
    `${path}/`,
    `${path}x`,
    `${path}/x`,
    `${path}/transaction`,
    `${path}/order`,
    noSlash,
    `${noSlash}s`,
    "/",
    "/v1",
    "/transaction",
  ];
}

/** A request that is either a rule, a rule with a few components replaced, or random. */
function requestArb(parts: ConfigParts): fc.Arbitrary<Req> {
  const rules = expectedRules(parts);
  const hosts = [...new Set(rules.map((r) => r.host))];
  const hostArb = fc.oneof(
    fc.constantFrom(...hosts),
    fc.constantFrom(...hosts.flatMap(lookalikes)),
    fc.stringMatching(/^[a-z]{1,8}(\.[a-z]{2,5}){1,2}$/),
  );
  const pathArb = fc.oneof(
    fc.constantFrom(...rules.flatMap((r) => pathVariants(r.path))),
    fc.stringMatching(/^(\/[a-z]{1,6}){0,3}$/).map((p) => (p === "" ? "/" : p)),
  );
  // 80% keep the rule's own value, 20% replace it, so about 17% of requests match a rule outright.
  const mut = <T>(a: fc.Arbitrary<T>): fc.Arbitrary<T | undefined> =>
    fc.oneof({ weight: 4, arbitrary: fc.constant(undefined) }, { weight: 1, arbitrary: a });
  return fc
    .record({
      rule: fc.constantFrom(...rules),
      method: mut(fc.constantFrom(...METHODS)),
      scheme: mut(fc.constantFrom(...SCHEMES)),
      userinfo: mut(fc.constantFrom(...USERINFO)),
      host: mut(hostArb),
      port: mut(fc.constantFrom(...PORTS)),
      path: mut(pathArb),
      query: fc.constantFrom(...QUERIES),
      fragment: mut(fc.constantFrom(...FRAGMENTS)),
    })
    .map(
      (g): Req => ({
        scheme: g.scheme ?? g.rule.scheme,
        userinfo: g.userinfo ?? "",
        host: g.host ?? g.rule.host,
        port: g.port ?? g.rule.port,
        path: g.path ?? g.rule.path,
        query: g.query,
        fragment: g.fragment ?? "",
        method: g.method ?? g.rule.methods[0] ?? "GET",
      }),
    );
}

function fakeFetch() {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response("{}");
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("per-request timeoutMs", () => {
  const cfg: AllowlistConfig = {
    nvidiaBaseUrl: "https://integrate.api.nvidia.com/v1",
    ollamaBaseUrl: "http://localhost:11434",
    cryptopanicPlan: "developer",
  };
  const waitOnSignal = (async (_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_res, rej) => {
      init?.signal?.addEventListener("abort", () => rej(new Error("aborted")));
    })) as unknown as typeof fetch;

  test("a smaller timeoutMs fires before the default", async () => {
    const gf = createGuardedFetch({ rules: buildRules(cfg), fetchImpl: waitOnSignal, timeoutMs: 5_000 });
    const err = await gf("http://localhost:11434/api/tags", { timeoutMs: 20 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GuardedFetchError);
    expect((err as GuardedFetchError).kind).toBe("timeout");
  });

  test("a larger timeoutMs outlives the default and is not forwarded to fetch", async () => {
    let seen: Record<string, unknown> = {};
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      seen = { ...init };
      await new Promise((r) => setTimeout(r, 80));
      return new Response("{}");
    }) as unknown as typeof fetch;
    const gf = createGuardedFetch({ rules: buildRules(cfg), fetchImpl, timeoutMs: 20 });
    const res = await gf("http://localhost:11434/api/tags", { timeoutMs: 5_000 });
    expect(res.ok).toBe(true);
    expect("timeoutMs" in seen).toBe(false);
  });
});

describe.each(CONFIGS.map((c, i) => [i, c] as const))("config %d", (_i, parts) => {
  const config = toConfig(parts);
  const rules = buildRules(config);
  const expected = expectedRules(parts);

  test("isAllowed permits a request if and only if a rule matches it", () => {
    fc.assert(
      fc.property(requestArb(parts), (q) => {
        expect(isAllowed(rules, urlOf(q), q.method)).toBe(oracle(expected, q));
      }),
      { numRuns: 2000 },
    );
  });

  test("the oracle accepts something (the generator reaches the allowed set)", () => {
    let permitted = 0;
    fc.assert(
      fc.property(requestArb(parts), (q) => {
        if (oracle(expected, q)) permitted++;
      }),
      { numRuns: 500 },
    );
    expect(permitted).toBeGreaterThan(10);
  });

  test("guardedFetch calls fetch exactly when a rule matches, with redirect error and no mutation of the URL", () => {
    return fc.assert(
      fc.asyncProperty(requestArb(parts), async (q) => {
        const { calls, fetchImpl } = fakeFetch();
        const guarded = createGuardedFetch({ rules, fetchImpl });
        const url = urlOf(q);
        const allowed = oracle(expected, q);
        if (allowed) {
          await guarded(url, { method: q.method });
          expect(calls).toHaveLength(1);
          expect(calls[0]?.url).toBe(url);
          expect(calls[0]?.init.redirect).toBe("error");
          expect(calls[0]?.init.method).toBe(q.method.toUpperCase());
        } else {
          const err = await guarded(url, { method: q.method }).then(
            () => null,
            (e: unknown) => e,
          );
          expect(err).toBeInstanceOf(GuardedFetchError);
          expect((err as GuardedFetchError).kind).toBe("refused");
          expect(calls).toHaveLength(0);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("every allowlisted rule is permitted, with and without a query string", async () => {
    for (const r of expected) {
      const method = r.methods[0] ?? "GET";
      const port = r.port === "" ? "" : `:${r.port}`;
      for (const query of ["", "?auth_token=x&q=a%20b", "?a=1"]) {
        const url = `${r.scheme}://${r.host}${port}${r.path}${query}`;
        const { calls, fetchImpl } = fakeFetch();
        await createGuardedFetch({ rules, fetchImpl })(url, { method });
        expect(calls).toHaveLength(1);
        expect(isAllowed(rules, url, method)).toBe(true);
      }
      // The default method is GET.
      expect(isAllowed(rules, `${r.scheme}://${r.host}${port}${r.path}`, "GET")).toBe(method === "GET");
    }
  });

  test("a scheme change on any rule is refused (https to http, http to https, ws, wss)", () => {
    for (const r of expected) {
      const port = r.port === "" ? "" : `:${r.port}`;
      for (const scheme of ["https", "http", "ws", "wss", "ftp"]) {
        if (scheme === r.scheme) continue;
        const method = r.methods[0] ?? "GET";
        // A default-port change would not be refused as a port change, so the scheme alone decides.
        expect(isAllowed(rules, `${scheme}://${r.host}${port}${r.path}`, method)).toBe(false);
      }
    }
  });

  test("embedded credentials are refused on every rule", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...expected),
        fc.stringMatching(/^[a-z0-9]{1,8}$/),
        fc.option(fc.stringMatching(/^[a-z0-9]{1,8}$/), { nil: undefined }),
        (r, user, password) => {
          const port = r.port === "" ? "" : `:${r.port}`;
          const userinfo = password === undefined ? user : `${user}:${password}`;
          const method = r.methods[0] ?? "GET";
          expect(isAllowed(rules, `${r.scheme}://${userinfo}@${r.host}${port}${r.path}`, method)).toBe(false);
          // The classic trick: an allowed name in the userinfo, another host after the @.
          expect(isAllowed(rules, `${r.scheme}://${r.host}@evil.example${r.path}`, method)).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  test("a fragment is refused, a method outside the rule is refused", () => {
    fc.assert(
      fc.property(fc.constantFrom(...expected), fc.constantFrom(...METHODS), (r, method) => {
        const port = r.port === "" ? "" : `:${r.port}`;
        const base = `${r.scheme}://${r.host}${port}${r.path}`;
        expect(isAllowed(rules, `${base}#frag`, r.methods[0] ?? "GET")).toBe(false);
        expect(isAllowed(rules, base, method)).toBe(r.methods.includes(method.toUpperCase()));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("transaction, swap, order, and execute routes and hosts are refused for every method", () => {
    const hosts = [
      "transaction-v1.raydium.io",
      "api-v3.raydium.io",
      "api.jup.ag",
      "lite-api.jup.ag",
      "quote-api.jup.ag",
      "api.backpack.exchange",
      "api.coinbase.com",
      "api.binance.com",
      ...new Set(expected.map((r) => r.host)),
    ];
    const paths = [
      "/transaction",
      "/transaction/swap",
      "/v1/transaction",
      "/mint/price/transaction",
      "/swap/v1/swap",
      "/swap/v1/quote",
      "/ultra/v1/order",
      "/ultra/v1/execute",
      "/order",
      "/execute",
      "/price/v3",
      "/mint/price",
      "/pools/info/mint",
      "/api/v1/order",
    ];
    fc.assert(
      fc.property(
        fc.constantFrom(...hosts),
        fc.constantFrom(...paths),
        fc.constantFrom(...METHODS),
        fc.constantFrom(...QUERIES),
        (host, path, method, query) => {
          expect(isAllowed(rules, `https://${host}${path}${query}`, method)).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  test("a refusal logs the host only, never credentials or the query string", async () => {
    const warnings: string[] = [];
    const { calls, fetchImpl } = fakeFetch();
    const guarded = createGuardedFetch({ rules, fetchImpl, logger: { warn: (m) => warnings.push(m) } });
    const err = await guarded("https://user:hunter2@evil.example/p?auth_token=SECRET123", { method: "GET" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GuardedFetchError);
    expect(calls).toHaveLength(0);
    const text = `${warnings.join("\n")}\n${(err as Error).message}`;
    expect(text).toContain("evil.example");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("SECRET123");
  });

  test("an unparseable URL is refused without a network call", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const guarded = createGuardedFetch({ rules, fetchImpl });
    for (const url of ["", "not a url", "//newsapi.org/v2/everything", "/v2/everything", "https://"]) {
      await expect(guarded(url, { method: "GET" })).rejects.toBeInstanceOf(GuardedFetchError);
    }
    expect(calls).toHaveLength(0);
  });
});
