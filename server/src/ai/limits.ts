// AI request limits (Req 4.8, 4.9, 7.10; design "AI limits"). Pure, with an injectable clock.

export type AiLimitReason = "rate_limited" | "busy" | "daily_cap";
export type AiLimitResult = { readonly ok: true } | { readonly ok: false; readonly reason: AiLimitReason };

/** Maps a limiter reason to the wire reason of AiError. */
export function toAiErrorReason(reason: AiLimitReason): "ai_rate_limit" | "ai_daily_cap" {
  return reason === "daily_cap" ? "ai_daily_cap" : "ai_rate_limit";
}

export interface AiLimitOptions {
  readonly ratePerMin: number; // AI_RATE_PER_MIN, default 6
  readonly dailyCap: number; // AI_DAILY_CAP, default 500
  readonly maxInFlight: number; // default 3
  readonly now: () => number; // epoch ms
}

export const DEFAULT_AI_LIMITS = { ratePerMin: 6, dailyCap: 500, maxInFlight: 3 } as const;

const WINDOW_MS = 60_000;
const DAY_MS = 86_400_000;

export const GUEST_ACCOUNT = "guest";

export class AiLimiter {
  private readonly opts: AiLimitOptions;
  private readonly times = new Map<string, number[]>();
  private readonly inFlight = new Map<string, number>();
  private readonly daily = new Map<string, { day: number; used: number }>();

  constructor(opts: Partial<AiLimitOptions> = {}) {
    this.opts = { ...DEFAULT_AI_LIMITS, now: () => Date.now(), ...opts };
  }

  /**
   * Checks and, on success, records one user action. `dailyUnits` is the number of provider
   * calls it needs (0 for Ollama, 1 for a single request, N for a scan of N symbols). A scan
   * counts once for rate and `dailyUnits` for the daily cap, and is rejected whole.
   * Every accepted call must be paired with `release(connectionId)`.
   */
  acquire(connectionId: string, accountId: string, dailyUnits: number): AiLimitResult {
    const now = this.opts.now();

    if ((this.inFlight.get(connectionId) ?? 0) >= this.opts.maxInFlight) {
      return { ok: false, reason: "busy" };
    }

    const recent = (this.times.get(connectionId) ?? []).filter((t) => t > now - WINDOW_MS);
    if (recent.length >= this.opts.ratePerMin) {
      this.times.set(connectionId, recent);
      return { ok: false, reason: "rate_limited" };
    }

    const key = accountId === GUEST_ACCOUNT || accountId === "" ? GUEST_ACCOUNT : accountId;
    const day = Math.floor(now / DAY_MS);
    const entry = this.daily.get(key);
    const used = entry !== undefined && entry.day === day ? entry.used : 0;
    if (dailyUnits > 0 && used + dailyUnits > this.opts.dailyCap) {
      this.times.set(connectionId, recent);
      return { ok: false, reason: "daily_cap" };
    }

    recent.push(now);
    this.times.set(connectionId, recent);
    this.inFlight.set(connectionId, (this.inFlight.get(connectionId) ?? 0) + 1);
    if (dailyUnits > 0) this.daily.set(key, { day, used: used + dailyUnits });
    return { ok: true };
  }

  /** Ends one in-flight request. Rate and daily units are not refunded. */
  release(connectionId: string): void {
    const n = (this.inFlight.get(connectionId) ?? 0) - 1;
    if (n > 0) this.inFlight.set(connectionId, n);
    else this.inFlight.delete(connectionId);
  }

  /** Drops all state of a closed connection. */
  forget(connectionId: string): void {
    this.times.delete(connectionId);
    this.inFlight.delete(connectionId);
  }
}
