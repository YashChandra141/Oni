// TUI pairing store (Req 48; design Decisions A4 and A13).
//
// Flow: the TUI makes a Pairing_Secret (32 random bytes) and sends `verifier` = base64url
// SHA-256 of it. The server stores only the verifier. The web UI confirms the code with a
// signed-in wallet's address. The TUI polls with the code and the secret (base64url); the
// server hashes the secret and compares with the verifier in constant time. A confirmed pairing
// yields one fresh token, once, and the entry is deleted.
//
// `poll` answers "not_found" for an unknown, expired, already collected, or wrong-secret
// pairing, so a caller cannot tell them apart (Req 48.8).

import { defaultRandomBytes, type RandomBytes } from "./token.ts";

/** Pairing_Code alphabet: no 0, 1, I, L, or O (Req 48.2). */
export const PAIRING_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const PAIRING_CODE_LENGTH = 8;
/** A Pairing lives 5 minutes. */
export const PAIRING_TTL_MS = 5 * 60_000;
export const PAIRING_TTL_SEC = 300;
/** Seconds the TUI waits between polls. */
export const PAIRING_POLL_INTERVAL_SEC = 2;
export const PAIRING_CAPACITY = 1_000;

// Largest multiple of the alphabet size that fits in a byte; bytes at or above it are discarded
// so that every letter is equally likely (no modulo bias).
const ACCEPT_BELOW = Math.floor(256 / PAIRING_ALPHABET.length) * PAIRING_ALPHABET.length;

const B64URL = /^[A-Za-z0-9_-]+$/;

export type PollResult = "pending" | "not_found" | { readonly token: string; readonly address: string };

interface Entry {
  readonly verifier: Uint8Array;
  readonly expiresAt: number;
  address: string | undefined;
}

export interface PairingStoreOptions {
  /** Epoch milliseconds. */
  readonly now: () => number;
  /** Issues a Session_Token for a confirmed address. */
  readonly issueToken: (address: string) => Promise<string>;
  readonly randomBytes?: RandomBytes;
  readonly capacity?: number;
}

/** Constant-time equality for byte arrays of any length (length itself is not secret here). */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Upper-cases and strips hyphens and spaces, so `k7qm-4xzp` matches `K7QM4XZP`. */
export function normalizePairingCode(text: string): string {
  return text.replace(/[-\s]/g, "").toUpperCase();
}

function decodeB64url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!B64URL.test(text)) return null;
  return new Uint8Array(Buffer.from(text, "base64url"));
}

export class PairingStore {
  // Insertion order: the first key is the oldest.
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly issueToken: (address: string) => Promise<string>;
  private readonly randomBytes: RandomBytes;
  private readonly capacity: number;

  constructor(options: PairingStoreOptions) {
    this.now = options.now;
    this.issueToken = options.issueToken;
    this.randomBytes = options.randomBytes ?? defaultRandomBytes;
    this.capacity = options.capacity ?? PAIRING_CAPACITY;
  }

  private generateCode(): string {
    let code = "";
    while (code.length < PAIRING_CODE_LENGTH) {
      for (const byte of this.randomBytes(16)) {
        if (byte >= ACCEPT_BELOW) continue;
        code += PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length];
        if (code.length === PAIRING_CODE_LENGTH) break;
      }
    }
    return code;
  }

  /**
   * Starts a pairing. `verifier` is the base64url SHA-256 of the Pairing_Secret (32 bytes).
   * Returns null when the verifier is malformed.
   */
  create(verifier: string): { code: string; expiresInSec: number; interval: number } | null {
    const bytes = decodeB64url(verifier);
    if (bytes === null || bytes.length !== 32) return null;
    this.prune();
    let code = this.generateCode();
    while (this.entries.has(code)) code = this.generateCode();
    this.entries.set(code, { verifier: bytes, expiresAt: this.now() + PAIRING_TTL_MS, address: undefined });
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
    return { code, expiresInSec: PAIRING_TTL_SEC, interval: PAIRING_POLL_INTERVAL_SEC };
  }

  /**
   * Binds a verified wallet address to a live pairing. Returns false for an unknown or expired
   * code, or one already confirmed by a different address. Confirming again with the same
   * address succeeds.
   */
  confirm(code: string, address: string): boolean {
    const entry = this.live(normalizePairingCode(code));
    if (entry === undefined) return false;
    if (entry.address !== undefined && entry.address !== address) return false;
    entry.address = address;
    return true;
  }

  /** Polls from the TUI. `secret` is the base64url Pairing_Secret. */
  async poll(code: string, secret: string): Promise<PollResult> {
    const key = normalizePairingCode(code);
    const secretBytes = decodeB64url(secret);
    if (secretBytes === null || this.live(key) === undefined) return "not_found";
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", secretBytes));

    // Re-read after the await: another poll may have collected the entry meanwhile.
    const entry = this.live(key);
    if (entry === undefined || !constantTimeEqual(hash, entry.verifier)) return "not_found";
    const address = entry.address;
    if (address === undefined) return "pending";
    this.entries.delete(key);
    return { token: await this.issueToken(address), address };
  }

  /** Drops expired entries. */
  prune(): void {
    const now = this.now();
    for (const [code, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(code);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  private live(code: string): Entry | undefined {
    const entry = this.entries.get(code);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(code);
      return undefined;
    }
    return entry;
  }
}
