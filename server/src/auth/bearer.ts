// `Authorization: Bearer` → account (Req 20.28, 20.29; design "Auth_Service").
//
// - No header: the Guest_Account.
// - `Bearer <token>` with a token the Auth_Service accepts: the Wallet_Account `w_<address>`.
// - Anything else (another scheme, extra spaces, an empty token, a bad, expired, or denylisted
//   token): 401. The token text is never echoed or logged here.

import type { MiddlewareHandler } from "hono";
import type { AccountId } from "../protocol.ts";
import type { VerifyResult } from "./token.ts";

/** What `TokenService` offers; tests may pass a fake. */
export interface TokenVerifier {
  verify(token: string): Promise<VerifyResult>;
}

export interface ResolvedAccount {
  readonly accountId: AccountId;
  /** Wallet_Address, or null for the Guest_Account. */
  readonly address: string | null;
  /** Present for a wallet session. */
  readonly jti?: string;
  /** Token expiry, epoch seconds. Present for a wallet session. */
  readonly exp?: number;
}

export type BearerResult = ({ readonly ok: true } & ResolvedAccount) | { readonly ok: false; readonly status: 401 };

/** Exactly one space between the scheme and a non-empty token without whitespace. */
const BEARER = /^Bearer (\S+)$/;

const GUEST: BearerResult = { ok: true, accountId: "guest" as AccountId, address: null };

export async function resolveBearer(
  authorizationHeader: string | null | undefined,
  tokens: TokenVerifier,
): Promise<BearerResult> {
  if (authorizationHeader === null || authorizationHeader === undefined) return GUEST;
  const match = BEARER.exec(authorizationHeader);
  if (match === null || match[1] === undefined) return { ok: false, status: 401 };
  let result: VerifyResult;
  try {
    result = await tokens.verify(match[1]);
  } catch {
    return { ok: false, status: 401 };
  }
  if (!result.ok) return { ok: false, status: 401 };
  const { accountId, address, jti, exp } = result.claims;
  return { ok: true, accountId, address, jti, exp };
}

/** Context variables set by `bearerMiddleware`. */
export interface AuthVariables {
  account: ResolvedAccount;
}

/**
 * Hono middleware: sets `c.get("account")` or answers 401 `{error:"unauthorized"}`.
 * For /orders, /positions, /journal (Task 11.4): no header means guest.
 */
export function bearerMiddleware(tokens: TokenVerifier): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const result = await resolveBearer(c.req.header("authorization"), tokens);
    if (!result.ok) {
      c.header("Cache-Control", "no-store");
      return c.json({ error: "unauthorized" }, 401);
    }
    const { ok: _ok, ...account } = result;
    c.set("account", account);
    await next();
    return undefined;
  };
}
