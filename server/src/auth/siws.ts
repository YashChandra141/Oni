// SIWS policy checks for the Auth_Service (Req 45.5, 45.8, 45.9, 49.3; design "Auth_Service").
//
// Re-exports the parser and formatter from shared/siws.ts (the web UI uses the same module) and
// adds the pure `checkSiws`. Nothing here does I/O, reads a clock, or contacts a Solana RPC
// endpoint: the chain ID in a message is an identity claim only (Req 49.3).
//
// `checkSiws` runs before the Ed25519 signature check. The nonce is consumed before this runs
// (Req 45.6), so the caller passes the record as it was BEFORE that consumption, with `used`
// telling whether an earlier attempt had already consumed it.

import {
  type SiwsFields,
  SIGN_IN_STATEMENT,
  SIWS_VERSION,
  SOLANA_MAINNET_CHAIN_ID,
  isSolanaAddress,
  parseIsoTimestamp,
} from "../../../shared/siws.ts";

export * from "../../../shared/siws.ts";

/** A Nonce lives 5 minutes (Req 45.1). */
export const NONCE_TTL_MS = 5 * 60_000;
/** How far into the future a message's `Issued At` may lie (design: 60 s of clock skew). */
export const CLOCK_SKEW_MS = 60_000;
/** Chain IDs accepted in a message. An identity claim only (Req 49.3). */
export const ALLOWED_CHAIN_IDS: readonly string[] = [SOLANA_MAINNET_CHAIN_ID];

/** What the nonce store knows about the nonce named in the message, before this attempt used it. */
export interface IssuedNonce {
  readonly nonce: string;
  /** Wallet_Address the nonce was issued for. */
  readonly address: string;
  /** Request origin the nonce was issued for. */
  readonly origin: string;
  /** Epoch milliseconds at which the nonce stops being valid. */
  readonly expiresAt: number;
  /** True when an earlier attempt already consumed the nonce. */
  readonly used: boolean;
}

export interface SiwsCheckContext {
  /** Epoch milliseconds, from the injectable clock. */
  readonly now: number;
  /** Origin of the request, already known to be in ALLOWED_ORIGINS (`scheme://host[:port]`). */
  readonly origin: string;
  /** The nonce record found for `fields.nonce`, or undefined when the nonce is unknown. */
  readonly nonce: IssuedNonce | undefined;
}

/** Short machine codes. They never contain text taken from the message. */
export type SiwsCheckReason =
  | "domain_mismatch"
  | "uri_mismatch"
  | "address_invalid"
  | "nonce_unknown"
  | "nonce_mismatch"
  | "nonce_used"
  | "nonce_expired"
  | "chain_id_mismatch"
  | "version_mismatch"
  | "statement_mismatch"
  | "expiration_missing"
  | "bad_timestamp"
  | "expired"
  | "issued_in_future"
  | "issued_too_old"
  | "not_yet_valid"
  | "unexpected_resources";

export type SiwsCheckResult = { readonly ok: true } | { readonly ok: false; readonly reason: SiwsCheckReason };

const OK: SiwsCheckResult = { ok: true };

function reject(reason: SiwsCheckReason): SiwsCheckResult {
  return { ok: false, reason };
}

/** Host (with a non-default port) of an http(s) origin, or null. */
function hostOfOrigin(origin: string): string | null {
  try {
    const url = new URL(origin);
    return url.protocol === "http:" || url.protocol === "https:" ? url.host : null;
  } catch {
    return null;
  }
}

/**
 * Applies the sign-in policy to parsed fields and returns the first failing check, in this order:
 * domain, URI, address, nonce, chain ID, version, statement, expiration time, issued-at time,
 * not-before time, resources.
 *
 * - The domain must equal the host of the request origin and the URI must equal the request origin.
 * - The nonce must be known, issued for this address and origin, unused, and unexpired.
 * - Chain ID must be allowed, version must be "1", and the statement must be the Sign_In_Statement.
 * - `Expiration Time` is required (the server always issues one) and must be in the future.
 * - `Issued At` may be at most 60 s ahead of now and at most one nonce lifetime behind it.
 * - `Not Before`, when present, must have been reached.
 * - `Resources` must be absent: the server never issues any.
 */
export function checkSiws(fields: SiwsFields, ctx: SiwsCheckContext): SiwsCheckResult {
  const host = hostOfOrigin(ctx.origin);
  if (host === null || fields.domain !== host) return reject("domain_mismatch");
  if (fields.uri !== ctx.origin) return reject("uri_mismatch");
  if (!isSolanaAddress(fields.address)) return reject("address_invalid");

  const issued = ctx.nonce;
  if (issued === undefined) return reject("nonce_unknown");
  if (issued.nonce !== fields.nonce || issued.address !== fields.address || issued.origin !== ctx.origin) {
    return reject("nonce_mismatch");
  }
  if (issued.used) return reject("nonce_used");
  if (ctx.now >= issued.expiresAt) return reject("nonce_expired");

  if (!ALLOWED_CHAIN_IDS.includes(fields.chainId)) return reject("chain_id_mismatch");
  if (fields.version !== SIWS_VERSION) return reject("version_mismatch");
  if (fields.statement !== SIGN_IN_STATEMENT) return reject("statement_mismatch");

  if (fields.expirationTime === undefined) return reject("expiration_missing");
  const expiration = parseIsoTimestamp(fields.expirationTime);
  if (expiration === null) return reject("bad_timestamp");
  if (expiration <= ctx.now) return reject("expired");

  const issuedAt = parseIsoTimestamp(fields.issuedAt);
  if (issuedAt === null) return reject("bad_timestamp");
  if (issuedAt > ctx.now + CLOCK_SKEW_MS) return reject("issued_in_future");
  if (ctx.now - issuedAt > NONCE_TTL_MS) return reject("issued_too_old");

  if (fields.notBefore !== undefined) {
    const notBefore = parseIsoTimestamp(fields.notBefore);
    if (notBefore === null) return reject("bad_timestamp");
    if (notBefore > ctx.now) return reject("not_yet_valid");
  }

  if (fields.resources !== undefined) return reject("unexpected_resources");

  return OK;
}
