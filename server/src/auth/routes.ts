// Auth routes (Req 45.1-45.3, 45.5, 45.7, 45.14, 45.15, 48.2, 48.4, 48.6-48.9; design "Auth_Service").
//
// | Route                | Auth             | Body                         | Success                                  | Errors             |
// |----------------------|------------------|------------------------------|------------------------------------------|--------------------|
// | POST /auth/nonce     | Origin allowed   | {address}                    | 200 {nonce, fields}                      | 400, 403, 429      |
// | POST /auth/verify    | Origin allowed   | {message, signature} base64  | 200 {token, account_id, address, exp}    | 400, 401, 403, 429 |
// | POST /auth/logout    | Bearer           | none                         | 204                                      | 401, 429           |
// | POST /auth/pair      | none             | {verifier} base64url         | 200 {code, pair_url, expires_in, interval} | 400, 429         |
// | POST /auth/pair/confirm | Bearer (wallet) | {code}                     | 204                                      | 400, 401, 404, 429 |
// | POST /auth/pair/poll | none             | {code, secret}               | 200 {status:"pending"} or {status:"ok", token, account_id, address, exp} | 400, 404, 429 |
//
// Every dependency is injected, so tests use a fake clock, in-memory stores, and a capturing
// logger. The error bodies are `{error: "<code>"}` only. The logger receives the route, the
// status, an outcome code, and (when known) the account id and jti. It never receives bodies,
// tokens, signatures, nonces, pairing codes or secrets, or the Authorization header
// (Req 16.4, trading-safety rule 6). No Solana RPC call is made anywhere (Req 49.3).

import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { decodePublicKey, verifyEd25519 } from "./ed25519.ts";
import { resolveBearer } from "./bearer.ts";
import type { TokenVerifier } from "./bearer.ts";
import { normalizeOrigin, checkOrigin } from "../gateway/origin.ts";
import type { NonceStore } from "./nonces.ts";
import { normalizePairingCode } from "./pairing.ts";
import type { PairingStore } from "./pairing.ts";
import { POLL_CODE_ROUTE } from "./ratelimit.ts";
import type { RateLimiter } from "./ratelimit.ts";
import { SIGN_IN_STATEMENT, SIWS_VERSION, SOLANA_MAINNET_CHAIN_ID, checkSiws, isSolanaAddress, parseSiws } from "./siws.ts";
import { accountIdForAddress } from "./token.ts";
import type { TokenClaims, TokenService } from "./token.ts";

/** Largest JSON body any auth route reads. */
export const MAX_BODY_BYTES = 16 * 1024;

export interface AuthLogger {
  info(line: string): void;
}

export interface AuthRouteDeps {
  readonly config: { readonly webUrl: string; readonly allowedOrigins: readonly string[] };
  readonly nonces: Pick<NonceStore, "issue" | "consume">;
  readonly tokens: TokenVerifier & Pick<TokenService, "issue" | "deny">;
  readonly pairing: Pick<PairingStore, "create" | "confirm" | "poll">;
  readonly limiter: Pick<RateLimiter, "check">;
  /** Epoch milliseconds. Use the same clock as the stores. */
  readonly now: () => number;
  /** Called after a logout has denylisted `jti` (the gateway signs the connections out). */
  readonly onLogout: (jti: string, address: string) => void;
  readonly getClientIp: (c: Context) => string;
  readonly logger?: AuthLogger;
  /** Applied to error text before it is logged. Defaults to identity; main passes `redactSecrets`. */
  readonly redact?: (text: string) => string;
}

/**
 * Socket address from the env that main.ts passes to `app.fetch(req, env)`:
 * `{ socketAddress: server.requestIP(req)?.address }`. Anything else yields undefined.
 */
export function socketAddressFromEnv(env: unknown): string | undefined {
  if (typeof env !== "object" || env === null) return undefined;
  const value = (env as { socketAddress?: unknown }).socketAddress;
  return typeof value === "string" ? value : undefined;
}

const NonceBody = z.object({ address: z.string().min(1).max(64) });
const VerifyBody = z.object({ message: z.string().min(1).max(8192), signature: z.string().min(1).max(200) });
const PairBody = z.object({ verifier: z.string().min(1).max(64) });
const ConfirmBody = z.object({ code: z.string().min(1).max(32) });
const PollBody = z.object({ code: z.string().min(1).max(32), secret: z.string().min(1).max(128) });

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Strict standard base64 (RFC 4648 §4, padded). Returns null for anything else. */
function decodeBase64(text: string): Uint8Array | null {
  if (text.length % 4 !== 0 || !BASE64.test(text)) return null;
  return new Uint8Array(Buffer.from(text, "base64"));
}

type JsonRead = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

/** Reads a JSON body of at most `MAX_BODY_BYTES`; the stream is cancelled when it is longer. */
async function readJson(c: Context): Promise<JsonRead> {
  if (!/^application\/json\s*(;|$)/i.test(c.req.header("content-type") ?? "")) return { ok: false };
  const declared = c.req.header("content-length");
  if (declared !== undefined && Number(declared) > MAX_BODY_BYTES) return { ok: false };
  const stream = c.req.raw.body;
  if (stream === null) return { ok: false };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        return { ok: false };
      }
      chunks.push(value);
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

type ErrorStatus = 400 | 401 | 403 | 404 | 429;

export function createAuthRoutes(deps: AuthRouteDeps): Hono {
  const app = new Hono();
  const log = deps.logger ?? { info: (line: string) => console.log(line) };
  const redact = deps.redact ?? ((text: string) => text);
  const webBase = deps.config.webUrl.replace(/\/+$/, "");

  // Every auth response is uncacheable. Set before the handler so it also covers error paths.
  app.use("/auth/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });

  const note = (route: string, status: number, outcome: string, account?: string, jti?: string): void => {
    log.info(
      `[auth] ${route} ${status} ${outcome}${account === undefined ? "" : ` account=${account}`}${jti === undefined ? "" : ` jti=${jti}`}`,
    );
  };

  const fail = (c: Context, route: string, status: ErrorStatus, outcome: string, code: string): Response => {
    note(route, status, outcome);
    return c.json({ error: code }, status);
  };

  /** Returns a 429 response when `key` is over the limit of `rule`, else null. */
  const limited = (c: Context, route: string, rule: string, key: string): Response | null => {
    const result = deps.limiter.check(rule, key);
    if (result.allowed) return null;
    c.header("Retry-After", String(result.retryAfterSec));
    note(route, 429, "rate_limited");
    return c.json({ error: "rate_limited" }, 429);
  };

  /** The allowed request origin (normalized), or null when the header is absent or not allowed (Req 45.2). */
  const allowedOrigin = (c: Context): string | null => {
    const header = c.req.header("origin");
    if (header === undefined) return null;
    if (checkOrigin(header, deps.config.allowedOrigins) === "deny") return null;
    return normalizeOrigin(header);
  };

  const sessionBody = async (token: string, address: string): Promise<Record<string, unknown> | null> => {
    const verified = await deps.tokens.verify(token);
    const accountId = accountIdForAddress(address);
    if (!verified.ok || accountId === null) return null;
    const claims: TokenClaims = verified.claims;
    return { token, account_id: accountId, address, exp: claims.exp };
  };

  // POST /auth/nonce
  app.post("/auth/nonce", async (c) => {
    const route = "/auth/nonce";
    const origin = allowedOrigin(c);
    if (origin === null) return fail(c, route, 403, "origin_denied", "origin_not_allowed");
    const rate = limited(c, route, route, deps.getClientIp(c));
    if (rate !== null) return rate;
    const body = await readJson(c);
    const parsed = body.ok ? NonceBody.safeParse(body.value) : undefined;
    if (parsed === undefined || !parsed.success) return fail(c, route, 400, "bad_body", "invalid_request");
    const { address } = parsed.data;
    if (!isSolanaAddress(address)) return fail(c, route, 400, "bad_address", "invalid_address");

    const issued = deps.nonces.issue(origin, address);
    const fields = {
      domain: new URL(origin).host,
      address,
      statement: SIGN_IN_STATEMENT,
      uri: origin,
      version: SIWS_VERSION,
      chainId: SOLANA_MAINNET_CHAIN_ID,
      nonce: issued.nonce,
      issuedAt: new Date(deps.now()).toISOString(),
      expirationTime: new Date(issued.expiresAt).toISOString(),
    };
    note(route, 200, "ok");
    return c.json({ nonce: issued.nonce, fields }, 200);
  });

  // POST /auth/verify
  app.post("/auth/verify", async (c) => {
    const route = "/auth/verify";
    const origin = allowedOrigin(c);
    if (origin === null) return fail(c, route, 403, "origin_denied", "origin_not_allowed");
    const rate = limited(c, route, route, deps.getClientIp(c));
    if (rate !== null) return rate;
    const body = await readJson(c);
    const parsed = body.ok ? VerifyBody.safeParse(body.value) : undefined;
    if (parsed === undefined || !parsed.success) return fail(c, route, 400, "bad_body", "invalid_request");

    const messageBytes = decodeBase64(parsed.data.message);
    const signature = decodeBase64(parsed.data.signature);
    if (messageBytes === null || signature === null) return fail(c, route, 400, "bad_base64", "invalid_request");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(messageBytes);
    } catch {
      return fail(c, route, 400, "bad_utf8", "invalid_message");
    }
    const message = parseSiws(text);
    if (!message.ok) return fail(c, route, 400, `parse_${message.error}`, "invalid_message");
    const { fields } = message;

    // Req 45.6: the nonce is consumed before any check, whatever the outcome.
    const nonce = deps.nonces.consume(fields.nonce, fields.address);
    const checked = checkSiws(fields, { now: deps.now(), origin, nonce });
    if (!checked.ok) return fail(c, route, 401, `check_${checked.reason}`, "verification_failed");

    const publicKey = decodePublicKey(fields.address);
    if (publicKey === null) return fail(c, route, 401, "bad_public_key", "verification_failed");
    if (!(await verifyEd25519(publicKey, signature, messageBytes))) {
      return fail(c, route, 401, "bad_signature", "verification_failed");
    }

    const token = await deps.tokens.issue(fields.address);
    const session = await sessionBody(token, fields.address);
    if (session === null) {
      note(route, 500, "issue_failed");
      return c.json({ error: "internal" }, 500);
    }
    const accountId = accountIdForAddress(fields.address) ?? undefined;
    note(route, 200, "ok", accountId);
    return c.json(session, 200);
  });

  // POST /auth/logout
  app.post("/auth/logout", async (c) => {
    const route = "/auth/logout";
    const rate = limited(c, route, route, deps.getClientIp(c));
    if (rate !== null) return rate;
    const bearer = await resolveBearer(c.req.header("authorization"), deps.tokens);
    if (!bearer.ok || bearer.jti === undefined || bearer.exp === undefined || bearer.address === null) {
      return fail(c, route, 401, "unauthorized", "unauthorized");
    }
    deps.tokens.deny({ jti: bearer.jti, exp: bearer.exp });
    try {
      deps.onLogout(bearer.jti, bearer.address);
    } catch (err) {
      // The token is already denied; a failing listener must not turn the logout into an error.
      log.info(`[auth] ${route} logout listener failed: ${redact(err instanceof Error ? err.name : "unknown")}`);
    }
    note(route, 204, "ok", bearer.accountId, bearer.jti);
    return c.body(null, 204);
  });

  // POST /auth/pair
  app.post("/auth/pair", async (c) => {
    const route = "/auth/pair";
    const rate = limited(c, route, route, deps.getClientIp(c));
    if (rate !== null) return rate;
    const body = await readJson(c);
    const parsed = body.ok ? PairBody.safeParse(body.value) : undefined;
    if (parsed === undefined || !parsed.success) return fail(c, route, 400, "bad_body", "invalid_request");
    const created = deps.pairing.create(parsed.data.verifier);
    if (created === null) return fail(c, route, 400, "bad_verifier", "invalid_request");
    note(route, 200, "ok");
    return c.json(
      {
        code: created.code,
        pair_url: `${webBase}/pair?code=${created.code}`,
        expires_in: created.expiresInSec,
        interval: created.interval,
      },
      200,
    );
  });

  // POST /auth/pair/confirm
  app.post("/auth/pair/confirm", async (c) => {
    const route = "/auth/pair/confirm";
    const rate = limited(c, route, route, deps.getClientIp(c));
    if (rate !== null) return rate;
    const bearer = await resolveBearer(c.req.header("authorization"), deps.tokens);
    if (!bearer.ok || bearer.address === null) return fail(c, route, 401, "unauthorized", "unauthorized");
    const body = await readJson(c);
    const parsed = body.ok ? ConfirmBody.safeParse(body.value) : undefined;
    if (parsed === undefined || !parsed.success) return fail(c, route, 400, "bad_body", "invalid_request");
    // Unknown, expired, and confirmed-by-another-address all answer 404, so a caller learns nothing.
    if (!deps.pairing.confirm(parsed.data.code, bearer.address)) {
      note(route, 404, "not_found", bearer.accountId, bearer.jti);
      return c.json({ error: "not_found" }, 404);
    }
    note(route, 204, "ok", bearer.accountId, bearer.jti);
    return c.body(null, 204);
  });

  // POST /auth/pair/poll
  app.post("/auth/pair/poll", async (c) => {
    const route = "/auth/pair/poll";
    const rate = limited(c, route, route, deps.getClientIp(c));
    if (rate !== null) return rate;
    const body = await readJson(c);
    const parsed = body.ok ? PollBody.safeParse(body.value) : undefined;
    if (parsed === undefined || !parsed.success) return fail(c, route, 400, "bad_body", "invalid_request");
    const { code, secret } = parsed.data;
    const perCode = limited(c, route, POLL_CODE_ROUTE, normalizePairingCode(code));
    if (perCode !== null) return perCode;

    const result = await deps.pairing.poll(code, secret);
    if (result === "not_found") return fail(c, route, 404, "not_found", "not_found");
    if (result === "pending") {
      note(route, 200, "pending");
      return c.json({ status: "pending" }, 200);
    }
    const session = await sessionBody(result.token, result.address);
    if (session === null) {
      note(route, 500, "issue_failed");
      return c.json({ error: "internal" }, 500);
    }
    note(route, 200, "ok", accountIdForAddress(result.address) ?? undefined);
    return c.json({ status: "ok", ...session }, 200);
  });

  app.onError((err, c) => {
    note(c.req.path, 500, `error_${redact(err instanceof Error ? err.name : "unknown")}`);
    return c.json({ error: "internal" }, 500);
  });

  return app;
}
