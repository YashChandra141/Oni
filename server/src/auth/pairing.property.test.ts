// Property P32 — validates Req 48.10
//
// Pairing issues a token at most once, only with the right secret, only after confirm, and only
// before expiry. The model tracks one pairing (expiry time, confirmed address, collected flag);
// the store is driven with a fake clock, a seeded random source, and an issueToken that counts calls.
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { PAIRING_ALPHABET, PAIRING_CAPACITY, PAIRING_TTL_MS, PairingStore } from "./pairing.ts";

const NUM_RUNS = 50;
const CODE_PATTERN = new RegExp(`^[${PAIRING_ALPHABET}]{8}$`);

/** Deterministic byte source (LCG) so a failing seed reproduces. */
function seededBytes(seed: number): (length: number) => Uint8Array {
  let state = seed >>> 0;
  return (length) => {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      out[i] = state >>> 24;
    }
    return out;
  };
}

async function verifierOf(secret: Uint8Array): Promise<string> {
  // Copy into an ArrayBuffer-backed array: WebCrypto's BufferSource excludes SharedArrayBuffer.
  return Buffer.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(secret)))).toString("base64url");
}

type Op =
  | { readonly kind: "confirm"; readonly who: "A" | "B" }
  | { readonly kind: "confirmWrongCode" }
  | { readonly kind: "poll"; readonly right: boolean }
  | { readonly kind: "advance"; readonly ms: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom<"A" | "B">("A", "B").map((who): Op => ({ kind: "confirm", who })) },
  { weight: 1, arbitrary: fc.constant<Op>({ kind: "confirmWrongCode" }) },
  { weight: 4, arbitrary: fc.boolean().map((right): Op => ({ kind: "poll", right })) },
  { weight: 2, arbitrary: fc.integer({ min: 0, max: 60_000 }).map((ms): Op => ({ kind: "advance", ms })) },
  { weight: 1, arbitrary: fc.integer({ min: PAIRING_TTL_MS, max: 2 * PAIRING_TTL_MS }).map((ms): Op => ({ kind: "advance", ms })) },
);

const ADDRESSES = { A: "AddrA", B: "AddrB" } as const;

describe("P32: pairing token issue", () => {
  test("matches the reference model for random operation sequences", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 0xffffffff }),
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        fc.array(opArb, { minLength: 1, maxLength: 30 }),
        async (seed, secret, ops) => {
          const clock = { ms: 1_000_000 };
          const issuedFor: string[] = [];
          const store = new PairingStore({
            now: () => clock.ms,
            randomBytes: seededBytes(seed),
            issueToken: async (address) => {
              issuedFor.push(address);
              return `token-${issuedFor.length}`;
            },
          });
          const secretB64 = Buffer.from(secret).toString("base64url");
          const wrong = new Uint8Array(secret);
          wrong[0] = (wrong[0] ?? 0) ^ 1;
          const wrongB64 = Buffer.from(wrong).toString("base64url");

          const created = store.create(await verifierOf(secret));
          if (created === null) throw new Error("create failed");
          const code = created.code;
          const wrongCode = (code[0] === "A" ? "B" : "A") + code.slice(1);

          // Reference model.
          const expiresAt = clock.ms + PAIRING_TTL_MS;
          let confirmed: string | undefined;
          let collected = false;
          let collectedCount = 0;
          const live = () => !collected && clock.ms < expiresAt;

          for (const op of ops) {
            switch (op.kind) {
              case "advance":
                clock.ms += op.ms;
                break;
              case "confirmWrongCode":
                expect(store.confirm(wrongCode, "AddrA")).toBe(false);
                break;
              case "confirm": {
                const address = ADDRESSES[op.who];
                const expected = live() && (confirmed === undefined || confirmed === address);
                expect(store.confirm(code, address)).toBe(expected);
                if (expected) confirmed = address;
                break;
              }
              case "poll": {
                const result = await store.poll(code, op.right ? secretB64 : wrongB64);
                if (!live() || !op.right) {
                  expect(result).toBe("not_found");
                } else if (confirmed === undefined) {
                  expect(result).toBe("pending");
                } else {
                  expect(result).toEqual({ token: `token-${collectedCount + 1}`, address: confirmed });
                  collected = true;
                  collectedCount++;
                }
                break;
              }
            }
            // At most one token per code, and one issueToken call per collected token.
            expect(collectedCount).toBeLessThanOrEqual(1);
            expect(issuedFor.length).toBe(collectedCount);
          }
          if (collectedCount === 1) expect(issuedFor).toEqual([confirmed ?? ""]);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  test("unknown codes are not found and never issue a token", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 20 }), fc.string({ maxLength: 60 }), async (code, secret) => {
        let calls = 0;
        const store = new PairingStore({
          now: () => 0,
          issueToken: async () => {
            calls++;
            return "t";
          },
        });
        expect(await store.poll(code, secret)).toBe("not_found");
        expect(store.confirm(code, "AddrA")).toBe(false);
        expect(calls).toBe(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("codes are 8 characters from the alphabet and never repeat across 1,000 creates", async () => {
    const verifier = await verifierOf(new Uint8Array(32).fill(5));
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 0xffffffff }), async (seed) => {
        const store = new PairingStore({
          now: () => 0,
          randomBytes: seededBytes(seed),
          issueToken: async () => "t",
        });
        const seen = new Set<string>();
        for (let i = 0; i < PAIRING_CAPACITY; i++) {
          const created = store.create(verifier);
          if (created === null) throw new Error("create failed");
          expect(CODE_PATTERN.test(created.code)).toBe(true);
          seen.add(created.code);
        }
        expect(seen.size).toBe(PAIRING_CAPACITY);
        expect(store.size).toBe(PAIRING_CAPACITY);
      }),
      { numRuns: 10 },
    );
  });
});
