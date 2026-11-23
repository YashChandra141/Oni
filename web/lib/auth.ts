// Wallet sign-in for the Web UI (Req 47.1-47.3, 47.6, 49.1, 49.2, 33.4).
//
// Flow (`signIn`):
//  1. `standard:connect` to learn the account address (the nonce route needs it).
//  2. POST /auth/nonce {address} -> {nonce, fields}.
//  3. Sign the SIWS message: `solana:signIn` with the fields when the wallet has it, otherwise
//     `solana:signMessage` over the UTF-8 bytes of `formatSiws(fields)`.
//  4. POST /auth/verify {message: base64(signed message bytes), signature: base64(64 bytes)}
//     -> {token, account_id, address, exp (epoch seconds)}.
//  5. Store {token, address, accountId, exp} in localStorage under SESSION_STORAGE_KEY.
//
// The wallet signs only the SIWS sign-in message. Every wallet call goes through `callFeature`,
// which refuses anything outside ALLOWED_FEATURES (trading-safety rule 9, Req 49.1, 49.2).
// The token is never logged. `fetch`, storage, and the clock are injected for tests.

import { API_URL } from "./config";
import { formatSiws, SIGN_IN_STATEMENT } from "../../shared/siws";
import type { SiwsFields } from "../../shared/siws";
import { callFeature, hasSignIn, hasSignMessage } from "./walletStandard";
import type { Wallet, WalletAccount } from "./walletStandard";

/** localStorage key of the stored session. The suffix is the format version. */
export const SESSION_STORAGE_KEY = "oni:session:v1";

/** The key used before the rename to Oni. A session found here is moved to SESSION_STORAGE_KEY. */
export const LEGACY_SESSION_STORAGE_KEY = "haunted-terminal:session:v1";

export interface AuthSession {
  readonly token: string;
  /** Base58 wallet address. */
  readonly address: string;
  readonly accountId: string;
  /** Expiry, epoch seconds. */
  readonly exp: number;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface FetchLikeResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (
  url: string,
  init: { readonly method: string; readonly headers: Record<string, string>; readonly body?: string },
) => Promise<FetchLikeResponse>;

export interface AuthDeps {
  readonly fetch: FetchLike;
  readonly storage: StorageLike;
  /** Epoch milliseconds. */
  readonly now: () => number;
  /** HTTP base URL of the Server, without a trailing slash. */
  readonly apiUrl: string;
}

/** What the socket layer needs: the current token, and a way to drop it. */
export interface TokenSource {
  get(): string | null;
  clear(): void;
}

// ---------------------------------------------------------------------------------------------
// Errors

export type SignInErrorCode =
  | "cancelled"
  | "no_account"
  | "address_mismatch"
  | "unsupported_wallet"
  | "wallet_error"
  | "network"
  | "server_rejected"
  | "bad_response";

export class SignInError extends Error {
  override readonly name: string = "SignInError";
  constructor(
    readonly code: SignInErrorCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
  }
}

/** The user dismissed or rejected the wallet prompt. */
export class SignInCancelled extends SignInError {
  override readonly name: string = "SignInCancelled";
  constructor(options?: { readonly cause?: unknown }) {
    super("cancelled", "Sign-in was cancelled in the wallet.", options);
  }
}

/** Heuristic for a wallet rejection: EIP-1193 style code 4001, or a message saying so. */
export function isUserRejection(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, name, message } = error as { code?: unknown; name?: unknown; message?: unknown };
  if (code === 4001) return true;
  const text = `${typeof name === "string" ? name : ""} ${typeof message === "string" ? message : ""}`;
  return /reject|declin|denied|cancel|dismiss/i.test(text);
}

async function walletCall<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof SignInError) throw error;
    if (isUserRejection(error)) throw new SignInCancelled({ cause: error });
    throw new SignInError("wallet_error", "The wallet reported an error.", { cause: error });
  }
}

// ---------------------------------------------------------------------------------------------
// Stored session

function isSession(value: unknown): value is AuthSession {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.token === "string" &&
    v.token !== "" &&
    typeof v.address === "string" &&
    typeof v.accountId === "string" &&
    typeof v.exp === "number" &&
    Number.isFinite(v.exp)
  );
}

export function clearSession(storage: StorageLike): void {
  try {
    storage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Storage unavailable; nothing to remove.
  }
  try {
    storage.removeItem(LEGACY_SESSION_STORAGE_KEY);
  } catch {
    // Storage unavailable; nothing to remove.
  }
}

export function saveSession(storage: StorageLike, session: AuthSession): void {
  try {
    storage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ token: session.token, address: session.address, accountId: session.accountId, exp: session.exp }),
    );
  } catch {
    // Storage full or blocked: the session lasts until the page closes only.
  }
}

/**
 * The stored session, or null. A corrupt or expired entry is deleted (Req 47.6). `nowMs` is epoch
 * milliseconds; `exp` is epoch seconds.
 */
export function loadSession(storage: StorageLike, nowMs: number): AuthSession | null {
  let raw: string | null;
  try {
    raw = storage.getItem(SESSION_STORAGE_KEY);
    if (raw === null) {
      const legacy = storage.getItem(LEGACY_SESSION_STORAGE_KEY);
      if (legacy !== null) {
        // Validated below like any stored value; moved to the new key only if valid.
        let legacyParsed: unknown = null;
        try {
          legacyParsed = JSON.parse(legacy);
        } catch {
          // Corrupt: dropped by clearSession below.
        }
        if (isSession(legacyParsed) && legacyParsed.exp * 1000 > nowMs) {
          storage.setItem(SESSION_STORAGE_KEY, legacy);
          storage.removeItem(LEGACY_SESSION_STORAGE_KEY);
          raw = legacy;
        } else {
          storage.removeItem(LEGACY_SESSION_STORAGE_KEY);
        }
      }
    }
  } catch {
    return null;
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearSession(storage);
    return null;
  }
  if (!isSession(parsed) || parsed.exp * 1000 <= nowMs) {
    clearSession(storage);
    return null;
  }
  return { token: parsed.token, address: parsed.address, accountId: parsed.accountId, exp: parsed.exp };
}

/** A `TokenSource` over `storage`, for the socket layer. */
export function createTokenSource(storage: StorageLike, now: () => number): TokenSource {
  return {
    get: () => loadSession(storage, now())?.token ?? null,
    clear: () => clearSession(storage),
  };
}

/** Real browser dependencies. Call from the client only. */
export function browserAuthDeps(): AuthDeps {
  return {
    fetch: (url, init) => fetch(url, init),
    storage: window.localStorage,
    now: () => Date.now(),
    apiUrl: API_URL,
  };
}

/** A token source over `window.localStorage`. Safe to create before `window` exists; it reads lazily. */
export function browserTokenSource(): TokenSource {
  const storage = (): StorageLike | null => {
    try {
      return typeof window === "undefined" ? null : window.localStorage;
    } catch {
      return null;
    }
  };
  return {
    get: () => {
      const s = storage();
      return s === null ? null : loadSession(s, Date.now())?.token ?? null;
    },
    clear: () => {
      const s = storage();
      if (s !== null) clearSession(s);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Encoding

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function asBytes(value: unknown): Uint8Array | null {
  if (!ArrayBuffer.isView(value)) return null;
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

// ---------------------------------------------------------------------------------------------
// HTTP

async function postJson(deps: AuthDeps, path: string, body: unknown, bearer?: string): Promise<FetchLikeResponse> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (bearer !== undefined) headers.authorization = `Bearer ${bearer}`;
  try {
    return await deps.fetch(`${deps.apiUrl}${path}`, {
      method: "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    throw new SignInError("network", "Could not reach the server.", { cause: error });
  }
}

async function readOkJson(response: FetchLikeResponse, route: string): Promise<Record<string, unknown>> {
  if (!response.ok) {
    throw new SignInError("server_rejected", `The server rejected ${route} (HTTP ${response.status}).`);
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new SignInError("bad_response", `The server sent an unreadable ${route} response.`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SignInError("bad_response", `The server sent an invalid ${route} response.`);
  }
  return value as Record<string, unknown>;
}

const FIELD_NAMES = [
  "domain",
  "address",
  "statement",
  "uri",
  "version",
  "chainId",
  "nonce",
  "issuedAt",
  "expirationTime",
] as const;

function parseNonceResponse(body: Record<string, unknown>): SiwsFields {
  const raw = body.fields;
  if (typeof raw !== "object" || raw === null) throw new SignInError("bad_response", "Invalid nonce response.");
  const record = raw as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const name of FIELD_NAMES) {
    const value = record[name];
    if (typeof value !== "string" || value === "") throw new SignInError("bad_response", "Invalid nonce response.");
    out[name] = value;
  }
  return out as unknown as SiwsFields;
}

function parseVerifyResponse(body: Record<string, unknown>): AuthSession {
  const { token, account_id: accountId, address, exp } = body;
  if (
    typeof token !== "string" ||
    token === "" ||
    typeof accountId !== "string" ||
    typeof address !== "string" ||
    typeof exp !== "number" ||
    !Number.isFinite(exp)
  ) {
    throw new SignInError("bad_response", "Invalid verify response.");
  }
  return { token, address, accountId, exp };
}

// ---------------------------------------------------------------------------------------------
// Sign in and out

interface Signed {
  readonly message: Uint8Array;
  readonly signature: Uint8Array;
}

/**
 * Signs in with `wallet` and stores the session. Throws `SignInCancelled` when the user rejects a
 * wallet prompt, and `SignInError` for everything else.
 */
export async function signIn(wallet: Wallet, deps: AuthDeps): Promise<AuthSession> {
  if (!hasSignIn(wallet) && !hasSignMessage(wallet)) {
    throw new SignInError("unsupported_wallet", "This wallet cannot sign a sign-in message.");
  }

  // 1. Connect to learn the address.
  const connected = await walletCall(() => callFeature(wallet, "standard:connect").connect());
  const account: WalletAccount | undefined = connected.accounts[0] ?? wallet.accounts[0];
  if (account === undefined) throw new SignInError("no_account", "The wallet shared no account.");

  // 2. Nonce.
  const nonceBody = await readOkJson(await postJson(deps, "/auth/nonce", { address: account.address }), "/auth/nonce");
  const fields = parseNonceResponse(nonceBody);
  if (fields.address !== account.address) {
    throw new SignInError("address_mismatch", "The server's sign-in message is for a different address.");
  }
  // The wallet signs only the fixed sign-in statement (Req 49.1).
  if (fields.statement !== SIGN_IN_STATEMENT) {
    throw new SignInError("bad_response", "The server's sign-in message has an unexpected statement.");
  }

  // 3. Sign.
  const signed = hasSignIn(wallet) ? await signWithSignIn(wallet, fields, account) : await signWithMessage(wallet, fields, account);

  // 4. Verify.
  const verified = await readOkJson(
    await postJson(deps, "/auth/verify", {
      message: toBase64(signed.message),
      signature: toBase64(signed.signature),
    }),
    "/auth/verify",
  );
  const session = parseVerifyResponse(verified);

  // 5. Store.
  saveSession(deps.storage, session);
  return session;
}

async function signWithSignIn(wallet: Wallet, fields: SiwsFields, account: WalletAccount): Promise<Signed> {
  const outputs = await walletCall(() =>
    callFeature(wallet, "solana:signIn").signIn({
      domain: fields.domain,
      address: fields.address,
      statement: fields.statement ?? SIGN_IN_STATEMENT,
      uri: fields.uri,
      version: fields.version,
      chainId: fields.chainId,
      nonce: fields.nonce,
      issuedAt: fields.issuedAt,
      ...(fields.expirationTime !== undefined ? { expirationTime: fields.expirationTime } : {}),
    }),
  );
  const output = outputs[0];
  const message = asBytes(output?.signedMessage);
  const signature = asBytes(output?.signature);
  if (output === undefined || message === null || signature === null) {
    throw new SignInError("wallet_error", "The wallet returned no signature.");
  }
  if (output.account.address !== account.address) {
    throw new SignInError("address_mismatch", "The wallet signed with a different account.");
  }
  return { message, signature };
}

async function signWithMessage(wallet: Wallet, fields: SiwsFields, account: WalletAccount): Promise<Signed> {
  const message = new TextEncoder().encode(formatSiws(fields));
  const outputs = await walletCall(() => callFeature(wallet, "solana:signMessage").signMessage({ account, message }));
  const output = outputs[0];
  const signedMessage = asBytes(output?.signedMessage);
  const signature = asBytes(output?.signature);
  if (signedMessage === null || signature === null) {
    throw new SignInError("wallet_error", "The wallet returned no signature.");
  }
  return { message: signedMessage, signature };
}

/**
 * Signs out: POST /auth/logout with the stored token (network errors ignored), delete the stored
 * session, and disconnect the wallet when it has `standard:disconnect`. Never throws.
 */
export async function signOut(deps: AuthDeps, wallet?: Wallet): Promise<void> {
  const session = loadSession(deps.storage, deps.now());
  if (session !== null) {
    try {
      await postJson(deps, "/auth/logout", undefined, session.token);
    } catch {
      // Ignored: the token is dropped locally either way, and it expires on its own.
    }
  }
  clearSession(deps.storage);
  if (wallet !== undefined && wallet.features["standard:disconnect"] !== undefined) {
    try {
      await callFeature(wallet, "standard:disconnect").disconnect();
    } catch {
      // Ignored: the wallet may already be disconnected.
    }
  }
}
