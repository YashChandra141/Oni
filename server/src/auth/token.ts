// Session_Token issue and verify, and the Token_Denylist (Req 45.12-45.14; design Decision A12).
//
// Format: `v1.<payload>.<mac>`
//   payload = base64url(JSON {sub: address, iat, exp, jti})   (iat and exp in epoch SECONDS)
//   mac     = base64url(HMAC-SHA256(secret, "v1." + payload))
// The Account_Id is always derived from `sub` as `w_<sub>`; it is never read from the payload.
//
// `verify` checks the MAC (WebCrypto `subtle.verify`, constant time) BEFORE parsing the payload,
// then the payload shape, expiry, and the denylist. Every failure reason is a short code that
// never contains token text.

import { z } from "zod";
import { isSolanaAddress } from "../../../shared/siws.ts";
import { AccountIdSchema } from "../protocol.ts";
import type { AccountId } from "../protocol.ts";

/** Session_Token lifetime: 24 h (Req 45.12). */
export const TOKEN_TTL_SEC = 24 * 60 * 60;

const PREFIX = "v1.";

export type RandomBytes = (length: number) => Uint8Array;

/** Default random source. */
export const defaultRandomBytes: RandomBytes = (length) => crypto.getRandomValues(new Uint8Array(length));

export interface TokenClaims {
  /** Wallet_Address (base58 of 32 bytes). */
  readonly address: string;
  readonly accountId: AccountId;
  readonly jti: string;
  /** Issued-at, epoch seconds. */
  readonly iat: number;
  /** Expiry, epoch seconds. */
  readonly exp: number;
}

export type TokenFailure = "malformed" | "bad_mac" | "bad_payload" | "expired" | "denied";

export type VerifyResult =
  | { readonly ok: true; readonly claims: TokenClaims }
  | { readonly ok: false; readonly reason: TokenFailure };

const PayloadSchema = z.object({
  sub: z.string(),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().nonnegative(),
  jti: z.string().min(1).max(64),
});

/** `w_<address>` as an AccountId, or null when the result is not a valid AccountId. */
export function accountIdForAddress(address: string): AccountId | null {
  const parsed = AccountIdSchema.safeParse(`w_${address}`);
  return parsed.success ? parsed.data : null;
}

function b64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

const B64URL = /^[A-Za-z0-9_-]*$/;

function b64urlDecode(text: string): Uint8Array | null {
  if (!B64URL.test(text)) return null;
  return new Uint8Array(Buffer.from(text, "base64url"));
}

/**
 * Token_Denylist: `Map<jti, exp>` (exp in epoch seconds). In memory only, so it is empty after a
 * restart (Req 45.14). Entries are dropped once their token has expired anyway.
 */
export class TokenDenylist {
  private readonly entries = new Map<string, number>();

  constructor(private readonly now: () => number) {}

  deny(jti: string, exp: number): void {
    this.prune();
    this.entries.set(jti, exp);
  }

  has(jti: string): boolean {
    this.prune();
    return this.entries.has(jti);
  }

  /** Drops every entry whose expiry time has passed. */
  prune(): void {
    const nowSec = Math.floor(this.now() / 1000);
    for (const [jti, exp] of this.entries) {
      if (exp <= nowSec) this.entries.delete(jti);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

export interface TokenServiceOptions {
  /** SESSION_SECRET. */
  readonly secret: string;
  /** Epoch milliseconds. */
  readonly now: () => number;
  readonly randomBytes?: RandomBytes;
  readonly denylist?: TokenDenylist;
}

export class TokenService {
  readonly denylist: TokenDenylist;
  private readonly now: () => number;
  private readonly randomBytes: RandomBytes;
  private keyPromise: Promise<CryptoKey> | undefined;

  constructor(private readonly options: TokenServiceOptions) {
    this.now = options.now;
    this.randomBytes = options.randomBytes ?? defaultRandomBytes;
    this.denylist = options.denylist ?? new TokenDenylist(options.now);
  }

  private key(): Promise<CryptoKey> {
    this.keyPromise ??= crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(this.options.secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    return this.keyPromise;
  }

  /** Issues a token for a Wallet_Address. Throws RangeError for an address that is not a Solana address. */
  async issue(address: string): Promise<string> {
    if (!isSolanaAddress(address) || accountIdForAddress(address) === null) {
      throw new RangeError("invalid wallet address");
    }
    const iat = Math.floor(this.now() / 1000);
    const payload = b64urlEncode(
      new TextEncoder().encode(
        JSON.stringify({ sub: address, iat, exp: iat + TOKEN_TTL_SEC, jti: b64urlEncode(this.randomBytes(16)) }),
      ),
    );
    const signed = new TextEncoder().encode(PREFIX + payload);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await this.key(), signed));
    return `${PREFIX}${payload}.${b64urlEncode(mac)}`;
  }

  async verify(token: string): Promise<VerifyResult> {
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== "v1") return { ok: false, reason: "malformed" };
    const payloadText = parts[1] ?? "";
    const macBytes = b64urlDecode(parts[2] ?? "");
    if (payloadText === "" || macBytes === null) return { ok: false, reason: "malformed" };
    // The last base64url character of a 32-byte MAC carries 2 unused bits, so several texts decode
    // to the same MAC. Accept only the canonical text, so every character of the token matters.
    if (b64urlEncode(macBytes) !== parts[2]) return { ok: false, reason: "malformed" };

    // MAC first, in constant time, before the payload is parsed.
    const macOk = await crypto.subtle.verify(
      "HMAC",
      await this.key(),
      macBytes,
      new TextEncoder().encode(PREFIX + payloadText),
    );
    if (!macOk) return { ok: false, reason: "bad_mac" };

    const raw = b64urlDecode(payloadText);
    if (raw === null) return { ok: false, reason: "bad_payload" };
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return { ok: false, reason: "bad_payload" };
    }
    const parsed = PayloadSchema.safeParse(json);
    if (!parsed.success) return { ok: false, reason: "bad_payload" };
    const { sub, iat, exp, jti } = parsed.data;
    const accountId = isSolanaAddress(sub) ? accountIdForAddress(sub) : null;
    if (accountId === null) return { ok: false, reason: "bad_payload" };

    if (exp <= Math.floor(this.now() / 1000)) return { ok: false, reason: "expired" };
    if (this.denylist.has(jti)) return { ok: false, reason: "denied" };
    return { ok: true, claims: { address: sub, accountId, jti, iat, exp } };
  }

  /** Signs a token out: its jti stays denied until the token's own expiry (Req 45.14). */
  deny(claims: Pick<TokenClaims, "jti" | "exp">): void {
    this.denylist.deny(claims.jti, claims.exp);
  }
}
