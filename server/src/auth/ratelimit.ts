// Fixed-window rate limiter for the auth routes (Req 45.15, 48.9; design "Rate limits").
//
// | Route                                        | Limit                  |
// |----------------------------------------------|------------------------|
// | /auth/nonce, /auth/verify, /auth/logout      | 10 per minute per IP   |
// | /auth/pair                                   | 5 per minute per IP    |
// | /auth/pair/confirm                           | 10 per minute per IP   |
// | /auth/pair/poll (per IP)                     | 60 per minute per IP   |
// | /auth/pair/poll:code (per Pairing_Code)      | 1 per 2 seconds        |
//
// `check(route, key)`: `key` is the client IP, except for the `POLL_CODE_ROUTE` rule where it
// is the normalized Pairing_Code. Only allowed requests are counted.

export interface RateRule {
  readonly limit: number;
  readonly windowMs: number;
}

export const POLL_CODE_ROUTE = "/auth/pair/poll:code";

export const RATE_RULES: Readonly<Record<string, RateRule>> = {
  "/auth/nonce": { limit: 10, windowMs: 60_000 },
  "/auth/verify": { limit: 10, windowMs: 60_000 },
  "/auth/logout": { limit: 10, windowMs: 60_000 },
  "/auth/pair": { limit: 5, windowMs: 60_000 },
  "/auth/pair/confirm": { limit: 10, windowMs: 60_000 },
  "/auth/pair/poll": { limit: 60, windowMs: 60_000 },
  [POLL_CODE_ROUTE]: { limit: 1, windowMs: 2_000 },
};

/** Counters kept at most; the oldest window is dropped first. */
export const RATE_CAPACITY = 20_000;

export type RateResult = { readonly allowed: true; readonly retryAfterSec: 0 } | { readonly allowed: false; readonly retryAfterSec: number };

interface Window {
  readonly start: number;
  count: number;
}

export interface RateLimiterOptions {
  /** Epoch milliseconds. */
  readonly now: () => number;
  readonly rules?: Readonly<Record<string, RateRule>>;
  readonly capacity?: number;
}

export class RateLimiter {
  private readonly windows = new Map<string, Window>();
  private readonly now: () => number;
  private readonly rules: Readonly<Record<string, RateRule>>;
  private readonly capacity: number;

  constructor(options: RateLimiterOptions) {
    this.now = options.now;
    this.rules = options.rules ?? RATE_RULES;
    this.capacity = options.capacity ?? RATE_CAPACITY;
  }

  /** Counts one request. Throws RangeError for a route without a rule (a programming error). */
  check(route: string, key: string): RateResult {
    const rule = this.rules[route];
    if (rule === undefined) throw new RangeError("no rate rule for route");
    const now = this.now();
    const id = `${route}\u0000${key}`;
    let window = this.windows.get(id);
    if (window === undefined || now - window.start >= rule.windowMs) {
      this.prune();
      window = { start: now, count: 0 };
      this.windows.delete(id);
      this.windows.set(id, window);
      while (this.windows.size > this.capacity) {
        const oldest = this.windows.keys().next();
        if (oldest.done === true) break;
        this.windows.delete(oldest.value);
      }
    }
    if (window.count >= rule.limit) {
      const retryMs = window.start + rule.windowMs - now;
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil(retryMs / 1000)) };
    }
    window.count++;
    return { allowed: true, retryAfterSec: 0 };
  }

  /** Drops windows that have ended. */
  prune(): void {
    const now = this.now();
    for (const [id, window] of this.windows) {
      const route = id.slice(0, id.indexOf("\u0000"));
      const rule = this.rules[route];
      if (rule === undefined || now - window.start >= rule.windowMs) this.windows.delete(id);
    }
  }

  get size(): number {
    return this.windows.size;
  }
}
