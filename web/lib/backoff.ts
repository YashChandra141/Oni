// Reconnect backoff for the Web UI socket (Req 33.2). Pure: no clock, no timers.
//
// Same rule as the TUI (rust/crates/tui/src/net.rs): the delay before a reconnect starts at
// 250 ms and doubles after each consecutive failure, capped at 10 s. The socket resets it when
// the server's `hello` arrives, not when the WebSocket opens: a proxy in front of a sleeping
// server can accept the upgrade and then drop it, and resetting on open alone would turn that
// into a 250 ms retry loop.

/** Delay before the first reconnect after a failure (Req 33.2). */
export const INITIAL_BACKOFF_MS = 250;
/** Longest delay between connection attempts (Req 33.2). */
export const MAX_BACKOFF_MS = 10_000;

export interface Backoff {
  /** The delay the next call to `nextDelay` returns, in ms. */
  readonly nextMs: number;
}

export function createBackoff(): Backoff {
  return { nextMs: INITIAL_BACKOFF_MS };
}

/** The delay to wait now, and the backoff for the following failure (twice as long, capped). */
export function nextDelay(backoff: Backoff): { readonly delayMs: number; readonly backoff: Backoff } {
  const delayMs = Math.min(backoff.nextMs, MAX_BACKOFF_MS);
  return { delayMs, backoff: { nextMs: Math.min(delayMs * 2, MAX_BACKOFF_MS) } };
}

/** Starts the sequence over at `INITIAL_BACKOFF_MS`. */
export function resetBackoff(): Backoff {
  return createBackoff();
}
