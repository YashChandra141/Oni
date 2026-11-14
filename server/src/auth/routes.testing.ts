// Shared harness for the auth route tests (Task 18.7). Not imported by production code.
// Real TokenService, NonceStore, PairingStore, RateLimiter and route code, a fake clock, and a
// capturing logger. Each request picks its client IP from the `x-test-ip` header, so tests get
// separate rate-limit buckets by passing different values.

import type { Hono } from "hono";
import { encodeBase58 } from "../../../shared/base58.ts";
import { NonceStore } from "./nonces.ts";
import { PairingStore } from "./pairing.ts";
import { RateLimiter } from "./ratelimit.ts";
import { createAuthRoutes } from "./routes.ts";
import { formatSiws } from "./siws.ts";
import type { SiwsFields } from "./siws.ts";
import { TokenService } from "./token.ts";

export const ORIGIN = "https://haunted.example";
export const SESSION_SECRET = "test-session-secret-0123456789-abcdefghijklmnop";
export const START_TIME = Date.UTC(2030, 0, 1, 12, 0, 0);

export interface Harness {
  readonly app: Hono;
  readonly tokens: TokenService;
  readonly nonces: NonceStore;
  readonly pairing: PairingStore;
  readonly logs: string[];
  readonly logouts: { jti: string; address: string }[];
  readonly advance: (ms: number) => void;
  readonly now: () => number;
}

export function createHarness(): Harness {
  let time = START_TIME;
  const now = (): number => time;
  const tokens = new TokenService({ secret: SESSION_SECRET, now });
  const nonces = new NonceStore({ now });
  const pairing = new PairingStore({ now, issueToken: (address) => tokens.issue(address) });
  const limiter = new RateLimiter({ now });
  const logs: string[] = [];
  const logouts: { jti: string; address: string }[] = [];
  const app = createAuthRoutes({
    config: { webUrl: ORIGIN, allowedOrigins: [ORIGIN] },
    nonces,
    tokens,
    pairing,
    limiter,
    now,
    onLogout: (jti, address) => {
      logouts.push({ jti, address });
    },
    getClientIp: (c) => c.req.header("x-test-ip") ?? "10.0.0.1",
    logger: {
      info: (line) => {
        logs.push(line);
      },
    },
  });
  return {
    app,
    tokens,
    nonces,
    pairing,
    logs,
    logouts,
    advance: (ms) => {
      time += ms;
    },
    now,
  };
}

export interface Wallet {
  readonly address: string;
  readonly sign: (bytes: Uint8Array) => Promise<Uint8Array>;
}

export async function makeWallet(): Promise<Wallet> {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return {
    address: encodeBase58(raw),
    sign: async (bytes) => new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, bytes)),
  };
}

export interface PostOptions {
  readonly origin?: string | null;
  readonly ip?: string;
  readonly bearer?: string;
  readonly contentType?: string | null;
  readonly headers?: Record<string, string>;
}

/** POST with a JSON (or raw string) body. `origin: null` omits the Origin header. */
export function post(h: Harness, path: string, body: unknown, options: PostOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  if (origin !== null) headers["origin"] = origin;
  const contentType = options.contentType === undefined ? "application/json" : options.contentType;
  if (contentType !== null) headers["content-type"] = contentType;
  if (options.ip !== undefined) headers["x-test-ip"] = options.ip;
  if (options.bearer !== undefined) headers["authorization"] = `Bearer ${options.bearer}`;
  const init: RequestInit = { method: "POST", headers };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  return Promise.resolve(h.app.request(path, init));
}

export async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

export function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export interface SignInOptions {
  readonly ip?: string;
  readonly origin?: string | null;
  /** Changes the fields before the message is formatted and signed. */
  readonly tweak?: (fields: SiwsFields) => SiwsFields;
  /** Changes the message text after it was signed (the signature then no longer matches). */
  readonly afterSign?: (text: string) => string;
  /** Signs with this wallet instead of the one whose address is in the message. */
  readonly signer?: Wallet;
}

export interface SignInResult {
  readonly nonceRes: Response;
  readonly verifyRes: Response;
  readonly fields: SiwsFields;
  readonly text: string;
  readonly messageB64: string;
  readonly signatureB64: string;
}

/** POST /auth/nonce, then build, sign, and POST the SIWS message to /auth/verify. */
export async function signIn(h: Harness, wallet: Wallet, options: SignInOptions = {}): Promise<SignInResult> {
  const post1: PostOptions = { origin: options.origin === undefined ? ORIGIN : options.origin, ...(options.ip !== undefined ? { ip: options.ip } : {}) };
  const nonceRes = await post(h, "/auth/nonce", { address: wallet.address }, post1);
  const nonceBody = await json(nonceRes);
  const base = nonceBody["fields"] as SiwsFields;
  const fields = options.tweak === undefined ? base : options.tweak(base);
  const text = formatSiws(fields);
  const signature = await (options.signer ?? wallet).sign(new TextEncoder().encode(text));
  const sent = options.afterSign === undefined ? text : options.afterSign(text);
  const messageB64 = b64(new TextEncoder().encode(sent));
  const signatureB64 = b64(signature);
  const verifyRes = await post(h, "/auth/verify", { message: messageB64, signature: signatureB64 }, post1);
  return { nonceRes, verifyRes, fields, text, messageB64, signatureB64 };
}

/** Signs in and returns the session body; throws when the sign-in fails. */
export async function session(
  h: Harness,
  wallet: Wallet,
  ip?: string,
): Promise<{ token: string; account_id: string; address: string; exp: number }> {
  const result = await signIn(h, wallet, ip === undefined ? {} : { ip });
  if (result.verifyRes.status !== 200) throw new Error(`sign-in failed: ${result.verifyRes.status}`);
  return (await json(result.verifyRes)) as { token: string; account_id: string; address: string; exp: number };
}

export interface PairingSecret {
  readonly secret: string;
  readonly verifier: string;
}

/** A random 32-byte Pairing_Secret (base64url) and its SHA-256 verifier (base64url). */
export async function makePairingSecret(): Promise<PairingSecret> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return { secret: Buffer.from(bytes).toString("base64url"), verifier: Buffer.from(hash).toString("base64url") };
}
