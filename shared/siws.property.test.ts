// Property P30 — validates Req 45.4, 45.8
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { encodeBase58 } from "./base58.ts";
import { SIGN_IN_STATEMENT, type SiwsFields, formatSiws, parseSiws } from "./siws.ts";

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const LOWER_ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";

const charFrom = (alphabet: string) => fc.constantFrom(...alphabet.split(""));
const wordFrom = (alphabet: string, min: number, max: number) =>
  fc.array(charFrom(alphabet), { minLength: min, maxLength: max }).map((chars) => chars.join(""));

/** A real 32-byte public key shape: any 32 bytes encode to a valid Wallet_Address. */
const address = fc.uint8Array({ minLength: 32, maxLength: 32 }).map((bytes) => encodeBase58(bytes));

const domain = fc
  .tuple(wordFrom(LOWER_ALNUM, 1, 12), wordFrom(LOWER_ALNUM, 2, 5), fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined }))
  .map(([name, tld, port]) => `${name}.${tld}${port === undefined ? "" : `:${port}`}`);

const uriValue = fc
  .tuple(fc.constantFrom("http", "https", "ipfs", "mailto"), wordFrom(LOWER_ALNUM, 1, 16))
  .map(([scheme, rest]) => `${scheme}:${scheme === "mailto" ? `${rest}@example.com` : `//${rest}.example.com/p`}`);

const timestamp = fc
  .tuple(
    fc.integer({ min: Date.UTC(2000, 0, 1), max: Date.UTC(2100, 0, 1) }),
    fc.constantFrom("Z", "+00:00", "+02:00", "-05:30", "-00:00"),
  )
  .map(([ms, zone]) => new Date(ms).toISOString().replace("Z", zone));

/** Printable ASCII, one line, not empty, not starting with the "URI: " line prefix. */
const customStatement = fc
  .array(fc.integer({ min: 0x20, max: 0x7e }), { minLength: 1, maxLength: 120 })
  .map((codes) => String.fromCharCode(...codes))
  .filter((text) => !text.startsWith("URI: "));

const statement = fc.option(fc.oneof(fc.constant(SIGN_IN_STATEMENT), customStatement), { nil: undefined });

const siwsFields: fc.Arbitrary<SiwsFields> = fc
  .record({
    domain,
    address,
    statement,
    uri: uriValue,
    version: fc.constant("1"),
    chainId: fc.constantFrom("solana:mainnet", "solana:devnet", "solana:testnet"),
    nonce: wordFrom(ALNUM, 8, 64),
    issuedAt: timestamp,
    expirationTime: fc.option(timestamp, { nil: undefined }),
    notBefore: fc.option(timestamp, { nil: undefined }),
    requestId: fc.option(wordFrom(ALNUM + "-_.", 1, 32), { nil: undefined }),
    resources: fc.option(fc.array(uriValue, { maxLength: 4 }), { nil: undefined }),
  })
  .map((f): SiwsFields => {
    // Optional fields are absent, not `undefined`, so toEqual-style equality is exact.
    const { statement: s, expirationTime, notBefore, requestId, resources, ...required } = f;
    return {
      ...required,
      ...(s !== undefined ? { statement: s } : {}),
      ...(expirationTime !== undefined ? { expirationTime } : {}),
      ...(notBefore !== undefined ? { notBefore } : {}),
      ...(requestId !== undefined ? { requestId } : {}),
      ...(resources !== undefined ? { resources } : {}),
    };
  });

describe("P30: SIWS round-trip", () => {
  test("parseSiws(formatSiws(f)) returns fields equal to f", () => {
    fc.assert(
      fc.property(siwsFields, (f) => {
        const result = parseSiws(formatSiws(f));
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.fields).toEqual(f);
      }),
      { numRuns: 300 },
    );
  });

  test("formatSiws output never contains a bare \\r", () => {
    fc.assert(
      fc.property(siwsFields, (f) => {
        expect(formatSiws(f)).not.toContain("\r");
      }),
      { numRuns: 300 },
    );
  });

  test("formatting the parsed fields reproduces the text exactly", () => {
    fc.assert(
      fc.property(siwsFields, (f) => {
        const text = formatSiws(f);
        const result = parseSiws(text);
        expect(result.ok && formatSiws(result.fields)).toBe(text);
      }),
      { numRuns: 200 },
    );
  });
});
