// Property P31 — validates Req 45.5, 45.9, 45.10, 45.11
//
// Keys are generated here with WebCrypto. The nonce store of Task 18.4 does not exist yet, so
// "consumed" is modelled with a tiny in-test Set: the first attempt marks the nonce used, and a
// replay then sees `used: true` in the IssuedNonce record, which checkSiws reports as `nonce_used`.
// `globalThis.fetch` is replaced by a function that throws for the whole file, which shows that
// signing in needs no network or Solana RPC access (Req 49.3).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fc from "fast-check";
import { encodeBase58 } from "../../../shared/base58.ts";
import { verifyEd25519 } from "./ed25519.ts";
import {
  CLOCK_SKEW_MS,
  type IssuedNonce,
  NONCE_TTL_MS,
  SIGN_IN_STATEMENT,
  type SiwsCheckContext,
  type SiwsFields,
  checkSiws,
  formatSiws,
  parseSiws,
} from "./siws.ts";

const ORIGIN = "http://localhost:3000";
const DOMAIN = "localhost:3000";
const NOW = Date.parse("2025-12-01T10:02:00.000Z");
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const NUM_RUNS = 50;

const realFetch = globalThis.fetch;
let fetchCalls = 0;

beforeAll(() => {
  globalThis.fetch = (() => {
    fetchCalls++;
    throw new Error("network access is not allowed in P31");
  }) as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  expect(fetchCalls).toBe(0);
});

interface KeyPair {
  readonly privateKey: CryptoKey;
  readonly publicKey: Uint8Array;
  readonly address: string;
}

async function generateKeyPair(): Promise<KeyPair> {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { privateKey: pair.privateKey, publicKey, address: encodeBase58(publicKey) };
}

async function sign(key: KeyPair, message: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign("Ed25519", key.privateKey, message));
}

/** A fresh nonce record for `fields`, issued for its address and ORIGIN, valid until NOW + 3 min. */
function issue(fields: SiwsFields, used = false): IssuedNonce {
  return { nonce: fields.nonce, address: fields.address, origin: ORIGIN, expiresAt: NOW + 3 * 60_000, used };
}

function ctxFor(fields: SiwsFields, used = false): SiwsCheckContext {
  return { now: NOW, origin: ORIGIN, nonce: issue(fields, used) };
}

/** Valid issued-at / expiration times relative to NOW. */
const timing = fc.record({
  issuedAgoMs: fc.integer({ min: 0, max: NONCE_TTL_MS }),
  expiresInMs: fc.integer({ min: 1, max: 3 * 60_000 }),
});

const nonceText = fc
  .array(fc.constantFrom(...ALNUM.split("")), { minLength: 8, maxLength: 64 })
  .map((chars) => chars.join(""));

function buildFields(address: string, nonce: string, t: { issuedAgoMs: number; expiresInMs: number }): SiwsFields {
  return {
    domain: DOMAIN,
    address,
    statement: SIGN_IN_STATEMENT,
    uri: ORIGIN,
    version: "1",
    chainId: "solana:mainnet",
    nonce,
    issuedAt: new Date(NOW - t.issuedAgoMs).toISOString(),
    expirationTime: new Date(NOW + t.expiresInMs).toISOString(),
  };
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

function reasonOf(f: SiwsFields, ctx: SiwsCheckContext): string {
  const result = checkSiws(f, ctx);
  return result.ok ? "ok" : result.reason;
}

describe("P31: SIWS tamper and nonce consumption", () => {
  test("(a) a signature by the matching key verifies and checkSiws accepts the message", async () => {
    await fc.assert(
      fc.asyncProperty(nonceText, timing, async (nonce, t) => {
        const key = await generateKeyPair();
        const fields = buildFields(key.address, nonce, t);
        const message = encode(formatSiws(fields));
        const signature = await sign(key, message);

        expect(await verifyEd25519(key.publicKey, signature, message)).toBe(true);

        const parsed = parseSiws(new TextDecoder().decode(message));
        expect(parsed.ok).toBe(true);
        if (parsed.ok) expect(checkSiws(parsed.fields, ctxFor(parsed.fields))).toEqual({ ok: true });
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("(b) flipping any single byte of the message or bit of the signature fails verification", async () => {
    await fc.assert(
      fc.asyncProperty(
        nonceText,
        timing,
        fc.nat(),
        fc.integer({ min: 1, max: 255 }),
        fc.nat(),
        fc.integer({ min: 0, max: 7 }),
        async (nonce, t, messageIndex, xor, signatureIndex, bit) => {
          const key = await generateKeyPair();
          const message = encode(formatSiws(buildFields(key.address, nonce, t)));
          const signature = await sign(key, message);

          const tamperedMessage = message.slice();
          const mi = messageIndex % tamperedMessage.length;
          tamperedMessage[mi] = (tamperedMessage[mi] ?? 0) ^ xor;
          expect(await verifyEd25519(key.publicKey, signature, tamperedMessage)).toBe(false);

          const tamperedSignature = signature.slice();
          const si = signatureIndex % tamperedSignature.length;
          tamperedSignature[si] = (tamperedSignature[si] ?? 0) ^ (1 << bit);
          expect(await verifyEd25519(key.publicKey, tamperedSignature, message)).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  test("(c) verifying against a different public key fails", async () => {
    await fc.assert(
      fc.asyncProperty(nonceText, timing, async (nonce, t) => {
        const key = await generateKeyPair();
        const other = await generateKeyPair();
        const message = encode(formatSiws(buildFields(key.address, nonce, t)));
        const signature = await sign(key, message);
        expect(await verifyEd25519(other.publicKey, signature, message)).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("(d) a replay of a consumed nonce is rejected", async () => {
    await fc.assert(
      fc.asyncProperty(nonceText, timing, async (nonce, t) => {
        const key = await generateKeyPair();
        const fields = buildFields(key.address, nonce, t);
        const consumed = new Set<string>(); // stands in for the Task 18.4 nonce store

        const attempt = (): string => {
          const ctx = ctxFor(fields, consumed.has(fields.nonce));
          consumed.add(fields.nonce); // consumed before the check result is used (Req 45.6)
          return reasonOf(fields, ctx);
        };

        expect(attempt()).toBe("ok");
        expect(attempt()).toBe("nonce_used");
        expect(attempt()).toBe("nonce_used");
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("(e) any single field mutation is rejected with a stable reason code", async () => {
    const mutations: ReadonlyArray<
      readonly [string, (f: SiwsFields) => SiwsFields, string]
    > = [
      ["domain", (f) => ({ ...f, domain: "evil.example:3000" }), "domain_mismatch"],
      ["uri", (f) => ({ ...f, uri: "https://evil.example" }), "uri_mismatch"],
      ["chainId", (f) => ({ ...f, chainId: "solana:devnet" }), "chain_id_mismatch"],
      ["statement", (f) => ({ ...f, statement: "Transfer everything." }), "statement_mismatch"],
      [
        "nonce",
        (f) => ({ ...f, nonce: f.nonce.startsWith("A") ? `B${f.nonce.slice(1)}` : `A${f.nonce.slice(1)}` }),
        "nonce_mismatch",
      ],
      ["expired expirationTime", (f) => ({ ...f, expirationTime: new Date(NOW - 1).toISOString() }), "expired"],
      ["future notBefore", (f) => ({ ...f, notBefore: new Date(NOW + 1).toISOString() }), "not_yet_valid"],
      ["future issuedAt", (f) => ({ ...f, issuedAt: new Date(NOW + CLOCK_SKEW_MS + 1).toISOString() }), "issued_in_future"],
    ];

    await fc.assert(
      fc.asyncProperty(nonceText, timing, async (nonce, t) => {
        const key = await generateKeyPair();
        const fields = buildFields(key.address, nonce, t);
        // The nonce record is issued for the unmutated message.
        const ctx = ctxFor(fields);
        expect(reasonOf(fields, ctx)).toBe("ok");
        for (const [, mutate, reason] of mutations) {
          expect(reasonOf(mutate(fields), ctx)).toBe(reason);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("no network access happened during the properties", () => {
    expect(fetchCalls).toBe(0);
  });
});
