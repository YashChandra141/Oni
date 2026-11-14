// Restart backoff for the Engine_Supervisor (Req 15.2, 15.3), also used by the Journal_Writer
// retry loop (Req 20.10). Pure: no timers and no I/O, and the clock is injected.
//
// API:
// - `next()` returns the delay to wait now and doubles the following one:
//   500, 1000, 2000, … capped at 30 000 ms (Req 15.2, 20.10).
// - `reset()` makes the next delay 500 ms again (the journal calls it after a write succeeds).
// - `markStarted()` records that the engine just started, at `now()`.
// - `onExit()` is called when the engine exits and returns the restart delay to use. If the
//   engine ran for at least 60 000 ms since `markStarted()`, the delay is reset first, so the
//   result is 500 ms (Req 15.3). The check happens at exit time, so no timer is needed while
//   the engine runs. Without a `markStarted()` since the last exit, uptime counts as zero.
//
// Supervisor use:
//   const backoff = new Backoff();
//   spawn(); backoff.markStarted();
//   onEngineExit(() => setTimeout(restart, backoff.onExit()));

export const BACKOFF_INITIAL_MS = 500;
export const BACKOFF_MAX_MS = 30_000;
/** Uptime after which an exit restarts at the initial delay again (Req 15.3). */
export const BACKOFF_RESET_AFTER_MS = 60_000;

export interface BackoffOptions {
  /** Monotonic clock in ms. Defaults to `performance.now`. */
  readonly now?: () => number;
  readonly initialMs?: number;
  readonly maxMs?: number;
  readonly resetAfterMs?: number;
}

export class Backoff {
  readonly #now: () => number;
  readonly #initial: number;
  readonly #max: number;
  readonly #resetAfter: number;
  #nextDelay: number;
  #startedAt: number | null = null;

  constructor(options: BackoffOptions = {}) {
    this.#now = options.now ?? (() => performance.now());
    this.#initial = options.initialMs ?? BACKOFF_INITIAL_MS;
    this.#max = options.maxMs ?? BACKOFF_MAX_MS;
    this.#resetAfter = options.resetAfterMs ?? BACKOFF_RESET_AFTER_MS;
    if (!(this.#initial > 0 && this.#max >= this.#initial && this.#resetAfter >= 0)) {
      throw new RangeError("Backoff needs 0 < initialMs <= maxMs and resetAfterMs >= 0");
    }
    this.#nextDelay = this.#initial;
  }

  /** Returns the current delay and doubles the next one, up to the cap. */
  next(): number {
    const delay = this.#nextDelay;
    this.#nextDelay = Math.min(delay * 2, this.#max);
    return delay;
  }

  /** The next `next()` returns the initial delay. */
  reset(): void {
    this.#nextDelay = this.#initial;
  }

  /** Records the engine start time. */
  markStarted(): void {
    this.#startedAt = this.#now();
  }

  /**
   * Handles an engine exit and returns the restart delay. Resets the backoff first when the
   * engine ran for at least `resetAfterMs` since `markStarted()` (Req 15.3).
   */
  onExit(): number {
    const startedAt = this.#startedAt;
    this.#startedAt = null;
    if (startedAt !== null && this.#now() - startedAt >= this.#resetAfter) this.reset();
    return this.next();
  }
}
