// Nonce store for sign-in (Req 45.1, 45.6; design "Auth_Service").
//
// A Nonce is 16 random bytes in base58, bound to the request Origin and optionally to a
// Wallet_Address, valid for 5 minutes, and single use. `consume` removes the record whether or
// not it is still valid, so a failed attempt cannot retry with the same nonce (Req 45.6). The
// record it returns has the `IssuedNonce` shape that `checkSiws` expects (`used` is always
// false: a nonce that was consumed earlier is simply unknown now).

import { encodeBase58 } from "../../../shared/base58.ts";
import type { IssuedNonce } from "./siws.ts";
import { NONCE_TTL_MS } from "./siws.ts";
import { defaultRandomBytes, type RandomBytes } from "./token.ts";

/** Entries kept at most; the oldest is dropped first. */
export const NONCE_CAPACITY = 10_000;

interface Entry {
  readonly origin: string;
  readonly address: string | undefined;
  readonly expiresAt: number;
}

export interface NonceStoreOptions {
  /** Epoch milliseconds. */
  readonly now: () => number;
  readonly randomBytes?: RandomBytes;
  readonly capacity?: number;
}

export class NonceStore {
  // Map iteration order is insertion order, so the first key is the oldest.
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly randomBytes: RandomBytes;
  private readonly capacity: number;

  constructor(options: NonceStoreOptions) {
    this.now = options.now;
    this.randomBytes = options.randomBytes ?? defaultRandomBytes;
    this.capacity = options.capacity ?? NONCE_CAPACITY;
  }

  /** Issues a nonce for an origin, optionally bound to a Wallet_Address. */
  issue(origin: string, address?: string): { readonly nonce: string; readonly expiresAt: number } {
    this.prune();
    let nonce = encodeBase58(this.randomBytes(16));
    while (this.entries.has(nonce)) nonce = encodeBase58(this.randomBytes(16));
    const expiresAt = this.now() + NONCE_TTL_MS;
    this.entries.set(nonce, { origin, address, expiresAt });
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
    return { nonce, expiresAt };
  }

  /**
   * Removes and returns the record for a nonce, or undefined when it is unknown or already
   * consumed. An expired record is still returned (and removed) so `checkSiws` can report
   * `nonce_expired`. `address` is the address named in the signed message; it fills in the
   * record when the nonce was issued without one and is otherwise ignored, so `checkSiws`
   * detects a mismatch.
   */
  consume(nonce: string, address: string): IssuedNonce | undefined {
    const entry = this.entries.get(nonce);
    if (entry === undefined) return undefined;
    this.entries.delete(nonce);
    return {
      nonce,
      address: entry.address ?? address,
      origin: entry.origin,
      expiresAt: entry.expiresAt,
      used: false,
    };
  }

  /** Read-only lookup that leaves the record in place. */
  peek(nonce: string): { readonly origin: string; readonly address: string | undefined; readonly expiresAt: number } | undefined {
    this.prune();
    return this.entries.get(nonce);
  }

  /** Drops expired entries. */
  prune(): void {
    const now = this.now();
    for (const [nonce, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(nonce);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
