// Property P29 — validates Req 45.13, 45.14
//
// A Session_Token is accepted iff it was issued under this secret, is unmodified, is unexpired,
// and its jti is not in the Token_Denylist. The reference model is that sentence: each property
// builds one of the four ways to break it (or none) and checks the verdict.
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { encodeBase58 } from "../../../shared/base58.ts";
import { TOKEN_TTL_SEC, TokenService, type TokenFailure } from "./token.ts";

// WebCrypto based, so keep the run count modest.
const NUM_RUNS = 50;

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const REASONS: readonly TokenFailure[] = ["malformed", "bad_mac", "bad_payload", "expired", "denied"];

const secretArb = fc.string({ minLength: 32, maxLength: 48 });
const addressArb = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .map((bytes) => encodeBase58(bytes));
// Issue time in epoch ms with a sub-second part, so iat = floor(ms / 1000).
const t0Arb = fc.tuple(fc.integer({ min: 1_000_000_000, max: 2_000_000_000 }), fc.integer({ min: 0, max: 999 }))
  .map(([sec, ms]) => sec * 1000 + ms);

function makeService(secret: string, startMs: number, seed: number) {
  const clock = { ms: startMs };
  let counter = seed;
  const service = new TokenService({
    secret,
    now: () => clock.ms,
    // Distinct jti per token.
    randomBytes: (n) => new Uint8Array(n).map((_, i) => (counter + i) % 256),
  });
  counter += 1;
  return { clock, service };
}

/** Changes `token` in exactly one place; the result always differs from `token`. */
function mutate(token: string, kind: number, pos: number, pick: number): string {
  const i = pos % token.length;
  const ch = B64URL[pick % B64URL.length] ?? "A";
  switch (kind % 4) {
    case 0: {
      const orig = token[i];
      const replacement = ch === orig ? (B64URL[(pick + 1) % B64URL.length] ?? "B") : ch;
      return token.slice(0, i) + replacement + token.slice(i + 1);
    }
    case 1:
      return token.slice(0, i) + token.slice(i + 1);
    case 2:
      return token.slice(0, i) + ch + token.slice(i);
    default: {
      const dots: number[] = [];
      for (let k = 0; k < token.length; k++) if (token[k] === ".") dots.push(k);
      const d = dots[pos % dots.length] ?? 0;
      return token.slice(0, d) + ch + token.slice(d + 1);
    }
  }
}

describe("P29: Session_Token acceptance", () => {
  test("(a) before exp and not denied: ok with matching claims", async () => {
    await fc.assert(
      fc.asyncProperty(
        secretArb,
        addressArb,
        t0Arb,
        fc.integer({ min: 0, max: TOKEN_TTL_SEC * 1000 - 1 }),
        fc.integer({ min: 0, max: 255 }),
        async (secret, address, t0, elapsedMs, seed) => {
          const { service, clock } = makeService(secret, t0, seed);
          const token = await service.issue(address);
          // Any time before exp = iat + TTL, measured in whole seconds.
          const iat = Math.floor(t0 / 1000);
          clock.ms = Math.min(t0 + elapsedMs, (iat + TOKEN_TTL_SEC) * 1000 - 1);
          const result = await service.verify(token);
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.claims.address).toBe(address);
            expect(result.claims.accountId).toBe(`w_${address}`);
            expect(result.claims.iat).toBe(iat);
            expect(result.claims.exp).toBe(iat + TOKEN_TTL_SEC);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  test("(b) at or after exp: expired", async () => {
    await fc.assert(
      fc.asyncProperty(
        secretArb,
        addressArb,
        t0Arb,
        fc.integer({ min: 0, max: 10 * TOKEN_TTL_SEC * 1000 }),
        async (secret, address, t0, extraMs) => {
          const { service, clock } = makeService(secret, t0, 1);
          const token = await service.issue(address);
          clock.ms = (Math.floor(t0 / 1000) + TOKEN_TTL_SEC) * 1000 + extraMs;
          expect(await service.verify(token)).toEqual({ ok: false, reason: "expired" });
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  test("(c) denied until exp, then expired and pruned", async () => {
    await fc.assert(
      fc.asyncProperty(
        secretArb,
        addressArb,
        t0Arb,
        fc.integer({ min: 0, max: TOKEN_TTL_SEC * 1000 - 1 }),
        async (secret, address, t0, elapsedMs) => {
          const { service, clock } = makeService(secret, t0, 2);
          const token = await service.issue(address);
          const first = await service.verify(token);
          if (!first.ok) throw new Error("expected ok");
          service.deny(first.claims);
          clock.ms = Math.min(t0 + elapsedMs, first.claims.exp * 1000 - 1);
          expect(await service.verify(token)).toEqual({ ok: false, reason: "denied" });
          expect(service.denylist.size).toBe(1);
          clock.ms = first.claims.exp * 1000;
          expect(await service.verify(token)).toEqual({ ok: false, reason: "expired" });
          expect(service.denylist.size).toBe(0);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  test("(d) a token issued under another secret: bad_mac", async () => {
    await fc.assert(
      fc.asyncProperty(secretArb, secretArb, addressArb, t0Arb, async (secretA, secretB, address, t0) => {
        fc.pre(secretA !== secretB);
        const a = makeService(secretA, t0, 3).service;
        const b = makeService(secretB, t0, 3).service;
        expect(await b.verify(await a.issue(address))).toEqual({ ok: false, reason: "bad_mac" });
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("(e) any single mutation of the token is never accepted", async () => {
    await fc.assert(
      fc.asyncProperty(
        secretArb,
        addressArb,
        t0Arb,
        fc.nat({ max: 3 }),
        fc.nat({ max: 10_000 }),
        fc.nat({ max: 10_000 }),
        async (secret, address, t0, kind, pos, pick) => {
          const { service } = makeService(secret, t0, 4);
          const token = await service.issue(address);
          const changed = mutate(token, kind, pos, pick);
          expect(changed).not.toBe(token);
          const result = await service.verify(changed);
          expect(result.ok).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  test("(e) every character of a token matters, including the last MAC character", async () => {
    const { service } = makeService("k".repeat(32), 1_700_000_000_000, 5);
    const token = await service.issue(encodeBase58(new Uint8Array(32).fill(1)));
    // Every other base64url character at the final position must fail.
    for (const ch of B64URL) {
      if (ch === token.at(-1)) continue;
      expect((await service.verify(token.slice(0, -1) + ch)).ok).toBe(false);
    }
  });

  test("(f)(g) odd inputs fail without throwing, and reasons never contain the text", async () => {
    await fc.assert(
      fc.asyncProperty(secretArb, fc.oneof(fc.string({ maxLength: 200 }), fc.constantFrom("", ".", "..", "v1.", "v1..", "v1.a.", "v1.a.b", "v1.a.b.c")), async (secret, text) => {
        const { service } = makeService(secret, 1_700_000_000_000, 6);
        const result = await service.verify(text);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(REASONS).toContain(result.reason);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("(g) failure reasons of damaged real tokens never contain token text", async () => {
    await fc.assert(
      fc.asyncProperty(
        secretArb,
        addressArb,
        t0Arb,
        fc.nat({ max: 3 }),
        fc.nat({ max: 10_000 }),
        fc.nat({ max: 10_000 }),
        async (secret, address, t0, kind, pos, pick) => {
          const { service } = makeService(secret, t0, 7);
          const token = await service.issue(address);
          const result = await service.verify(mutate(token, kind, pos, pick));
          const text = JSON.stringify(result);
          for (const part of token.split(".")) expect(text.includes(part)).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
