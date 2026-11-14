// Pure helpers for the /pair page (Req 48.4, 48.5). No React, no DOM, no globals.

/** Must match PAIRING_ALPHABET in server/src/auth/pairing.ts (no 0, 1, I, L, O). */
export const PAIRING_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const PAIRING_CODE_LENGTH = 8;

/** Uppercases, strips spaces and hyphens, and validates. Returns the 8-char code or null. */
export function normalizeCode(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.replace(/[\s-]/g, "").toUpperCase();
  if (code.length !== PAIRING_CODE_LENGTH) return null;
  for (const ch of code) {
    if (!PAIRING_ALPHABET.includes(ch)) return null;
  }
  return code;
}

/** `ABCD2345` becomes `ABCD-2345`. Input must be a normalized code. */
export function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export type PairFailure = "not_signed_in" | "expired_or_unknown" | "rejected" | "network";
export type PairResult = { readonly ok: true } | { readonly ok: false; readonly reason: PairFailure };

export interface PairFetchResponse {
  readonly status: number;
}

export interface PairDeps {
  readonly fetch: (
    url: string,
    init: { readonly method: string; readonly headers: Record<string, string>; readonly body: string },
  ) => Promise<PairFetchResponse>;
  /** HTTP base URL of the Server, without a trailing slash. */
  readonly apiUrl: string;
  /** Session token, or null when signed out. Never logged. */
  readonly token: string | null;
}

export const PAIR_FAILURE_TEXT: Readonly<Record<PairFailure, string>> = {
  not_signed_in: "Sign in with your wallet first.",
  expired_or_unknown: "This code has expired or is unknown. Start again in your terminal.",
  rejected: "The server rejected this code.",
  network: "Could not reach the server. Try again.",
};

/**
 * POSTs the code to /auth/pair/confirm with the Bearer token. Sends nothing without a valid code
 * or a token. 204 is success; 401 means not signed in; 404 expired or unknown; 400 rejected.
 */
export async function confirmPairing(code: string, deps: PairDeps): Promise<PairResult> {
  const normalized = normalizeCode(code);
  if (normalized === null) return { ok: false, reason: "rejected" };
  if (deps.token === null || deps.token === "") return { ok: false, reason: "not_signed_in" };
  let response: PairFetchResponse;
  try {
    response = await deps.fetch(`${deps.apiUrl}/auth/pair/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${deps.token}` },
      body: JSON.stringify({ code: normalized }),
    });
  } catch {
    return { ok: false, reason: "network" };
  }
  if (response.status === 204 || response.status === 200) return { ok: true };
  if (response.status === 401) return { ok: false, reason: "not_signed_in" };
  if (response.status === 404) return { ok: false, reason: "expired_or_unknown" };
  if (response.status === 400) return { ok: false, reason: "rejected" };
  return { ok: false, reason: "network" };
}
