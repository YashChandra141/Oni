// guardedFetch (design "HTTP allowlist", Req 14.3, trading-safety rules 1 and 6).
//
// Every outbound server HTTP request goes through here. The URL is parsed with `new URL`;
// userinfo is refused; scheme, host, port, path, and method must match a rule; then `fetch`
// runs with `redirect: "error"` and a timeout. A refusal makes no network call. Errors carry
// only host and path, never the query string (CryptoPanic's auth_token) or any header value.

export interface AllowRule {
  readonly scheme: "https:" | "http:";
  readonly host: string;
  /** Port as a string; "" is the scheme default. */
  readonly port: string;
  readonly path: string;
  /** true: the request path may start with `path`. false: it must equal `path`. */
  readonly prefix: boolean;
  readonly methods: readonly string[];
}

export interface AllowlistConfig {
  readonly nvidiaBaseUrl: string;
  readonly ollamaBaseUrl: string;
  readonly cryptopanicPlan: string;
}

export class GuardedFetchError extends Error {
  readonly kind: "refused" | "timeout" | "network";
  constructor(kind: "refused" | "timeout" | "network", message: string) {
    super(message);
    this.name = "GuardedFetchError";
    this.kind = kind;
  }
}

export const DEFAULT_TIMEOUT_MS = 15_000;

function rule(url: string, methods: readonly string[], prefix = false): AllowRule {
  const u = new URL(url);
  return {
    scheme: u.protocol === "http:" ? "http:" : "https:",
    host: u.hostname,
    port: u.port,
    path: u.pathname,
    prefix,
    methods,
  };
}

function joinPath(base: string, suffix: string): string {
  const u = new URL(base);
  const p = u.pathname.replace(/\/+$/, "");
  return `${u.origin}${p}${suffix}`;
}

/** Builds the server-side rules from the validated config (design table). */
export function buildRules(config: AllowlistConfig): readonly AllowRule[] {
  return Object.freeze([
    rule("https://newsapi.org/v2/everything", ["GET"]),
    rule(`https://cryptopanic.com/api/${config.cryptopanicPlan}/v2/posts/`, ["GET"]),
    rule("https://api.openai.com/v1/responses", ["POST"]),
    rule("https://api.anthropic.com/v1/messages", ["POST"]),
    rule(joinPath(config.nvidiaBaseUrl, "/chat/completions"), ["POST"]),
    rule(joinPath(config.nvidiaBaseUrl, "/models"), ["GET"]),
    rule(joinPath(config.ollamaBaseUrl, "/api/chat"), ["POST"]),
    rule(joinPath(config.ollamaBaseUrl, "/api/tags"), ["GET"]),
  ]);
}

/** Pure matcher. Returns true when the request is permitted. */
export function isAllowed(rules: readonly AllowRule[], rawUrl: string, method: string): boolean {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.username !== "" || u.password !== "") return false;
  if (u.hash !== "") return false;
  const m = method.toUpperCase();
  return rules.some(
    (r) =>
      r.scheme === u.protocol &&
      r.host === u.hostname &&
      r.port === u.port &&
      (r.prefix ? u.pathname.startsWith(r.path) : u.pathname === r.path) &&
      r.methods.includes(m),
  );
}

/** host + path only, no query string, no credentials. Safe for logs and errors. */
export function safeUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return `${u.host}${u.pathname}`;
  } catch {
    return "invalid-url";
  }
}

export type GuardedFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface GuardedFetchOptions {
  readonly rules: readonly AllowRule[];
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly logger?: { warn(message: string): void };
}

export function createGuardedFetch(options: GuardedFetchOptions): GuardedFetch {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async (url, init = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    if (!isAllowed(options.rules, url, method)) {
      let host = "invalid-url";
      try {
        host = new URL(url).host;
      } catch {
        // keep the placeholder
      }
      options.logger?.warn(`[net] refused request to ${host}`);
      throw new GuardedFetchError("refused", `request refused: host ${host} or path is not allowlisted`);
    }
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    try {
      return await (options.fetchImpl ?? fetch)(url, { ...init, method, redirect: "error", signal });
    } catch (err) {
      const where = safeUrl(url);
      if (timeout.aborted) throw new GuardedFetchError("timeout", `request to ${where} timed out`);
      // Never forward the original message: it can contain the full URL.
      const name = err instanceof Error ? err.name : "Error";
      throw new GuardedFetchError("network", `request to ${where} failed (${name})`);
    }
  };
}

let configured: GuardedFetch | null = null;

/** Called once at boot with the validated config. */
export function configureGuardedFetch(config: AllowlistConfig, logger?: { warn(message: string): void }): void {
  configured = createGuardedFetch({ rules: buildRules(config), ...(logger ? { logger } : {}) });
}

/** The process-wide guarded fetch. Throws `refused` until `configureGuardedFetch` has run. */
export const guardedFetch: GuardedFetch = (url, init) => {
  if (configured === null) {
    return Promise.reject(new GuardedFetchError("refused", "guardedFetch is not configured"));
  }
  return configured(url, init);
};
