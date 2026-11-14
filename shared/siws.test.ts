import { describe, expect, test } from "bun:test";
import { encodeBase58 } from "./base58.ts";
import {
  MAX_SIWS_TEXT_LENGTH,
  SIGN_IN_STATEMENT,
  type SiwsFields,
  type SiwsParseError,
  formatSiws,
  isSolanaAddress,
  parseIsoTimestamp,
  parseSiws,
} from "./siws.ts";

const ADDRESS = encodeBase58(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
const NONCE = "9mTpZ4kQw2XnB7vL";
const ISSUED = "2025-12-01T10:00:00.000Z";
const EXPIRES = "2025-12-01T10:05:00.000Z";

/** The message the server issues (design "Auth_Service"), one entry per line. */
function baseLines(): string[] {
  return [
    "localhost:3000 wants you to sign in with your Solana account:",
    ADDRESS,
    "",
    SIGN_IN_STATEMENT,
    "",
    "URI: http://localhost:3000",
    "Version: 1",
    "Chain ID: solana:mainnet",
    `Nonce: ${NONCE}`,
    `Issued At: ${ISSUED}`,
    `Expiration Time: ${EXPIRES}`,
  ];
}

const baseFields: SiwsFields = {
  domain: "localhost:3000",
  address: ADDRESS,
  statement: SIGN_IN_STATEMENT,
  uri: "http://localhost:3000",
  version: "1",
  chainId: "solana:mainnet",
  nonce: NONCE,
  issuedAt: ISSUED,
  expirationTime: EXPIRES,
};

function expectParsed(text: string): SiwsFields {
  const result = parseSiws(text);
  if (!result.ok) throw new Error(`expected a parse, got ${result.error}`);
  return result.fields;
}

function expectError(text: string, error: SiwsParseError): void {
  expect(parseSiws(text)).toEqual({ ok: false, error });
}

describe("SIWS examples in the shape wallets produce through solana:signIn", () => {
  test("the server-issued message with statement and expiration time", () => {
    const text = baseLines().join("\n");
    expect(expectParsed(text)).toEqual(baseFields);
    expect(formatSiws(baseFields)).toBe(text);
  });

  test("without optional fields: no statement, no expiration time", () => {
    const text = [
      "app.example.com wants you to sign in with your Solana account:",
      ADDRESS,
      "",
      "URI: https://app.example.com",
      "Version: 1",
      "Chain ID: solana:mainnet",
      `Nonce: ${NONCE}`,
      `Issued At: ${ISSUED}`,
    ].join("\n");
    const fields = expectParsed(text);
    expect(fields).toEqual({
      domain: "app.example.com",
      address: ADDRESS,
      uri: "https://app.example.com",
      version: "1",
      chainId: "solana:mainnet",
      nonce: NONCE,
      issuedAt: ISSUED,
    });
    expect("statement" in fields).toBe(false);
    expect("expirationTime" in fields).toBe(false);
    expect(formatSiws(fields)).toBe(text);
  });

  test("with every optional field, a zone offset, and several resources", () => {
    const text = [
      "wallet.example.org wants you to sign in with your Solana account:",
      ADDRESS,
      "",
      SIGN_IN_STATEMENT,
      "",
      "URI: https://wallet.example.org",
      "Version: 1",
      "Chain ID: solana:mainnet",
      `Nonce: ${NONCE}`,
      "Issued At: 2025-12-01T12:00:00.250+02:00",
      "Expiration Time: 2025-12-01T12:05:00+02:00",
      "Not Before: 2025-12-01T11:59:00-00:00",
      "Request ID: req-42",
      "Resources:",
      "- https://example.com/terms",
      "- ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
    ].join("\n");
    const fields = expectParsed(text);
    expect(fields.notBefore).toBe("2025-12-01T11:59:00-00:00");
    expect(fields.requestId).toBe("req-42");
    expect(fields.resources).toEqual([
      "https://example.com/terms",
      "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
    ]);
    expect(formatSiws(fields)).toBe(text);
  });

  test("an IPv6 literal domain with a port", () => {
    const text = baseLines()
      .map((line, i) => (i === 0 ? `[::1]:3000 wants you to sign in with your Solana account:` : line))
      .join("\n");
    expect(expectParsed(text).domain).toBe("[::1]:3000");
  });
});

describe("parseSiws rejects malformed text", () => {
  const cases: ReadonlyArray<readonly [string, (lines: string[]) => string, SiwsParseError]> = [
    ["empty text", () => "", "header"],
    ["wrong chain name in the header", (l) => [l[0]!.replace("Solana", "Ethereum"), ...l.slice(1)].join("\n"), "header"],
    ["no domain in the header", (l) => [" wants you to sign in with your Solana account:", ...l.slice(1)].join("\n"), "domain"],
    ["whitespace inside the domain", (l) => ["evil.com x wants you to sign in with your Solana account:", ...l.slice(1)].join("\n"), "domain"],
    ["address line missing", (l) => l.filter((_, i) => i !== 1).join("\n"), "address"],
    ["address with an invalid base58 character", (l) => l.map((x, i) => (i === 1 ? `${ADDRESS.slice(0, -1)}0` : x)).join("\n"), "address"],
    ["address that decodes to 31 bytes", (l) => l.map((x, i) => (i === 1 ? encodeBase58(new Uint8Array(31).fill(9)) : x)).join("\n"), "address"],
    ["address that decodes to 33 bytes", (l) => l.map((x, i) => (i === 1 ? encodeBase58(new Uint8Array(33).fill(9)) : x)).join("\n"), "address"],
    ["blank line after the address missing", (l) => l.filter((_, i) => i !== 2).join("\n"), "layout"],
    ["blank line after the statement missing", (l) => l.filter((_, i) => i !== 4).join("\n"), "layout"],
    ["two blank lines instead of a statement", (l) => [l[0]!, l[1]!, "", "", ...l.slice(5)].join("\n"), "statement"],
    ["URI line missing", (l) => l.filter((_, i) => i !== 5).join("\n"), "uri"],
    ["URI that is not a URI", (l) => l.map((x, i) => (i === 5 ? "URI: localhost" : x)).join("\n"), "uri"],
    ["Version line missing", (l) => l.filter((_, i) => i !== 6).join("\n"), "version"],
    ["empty version", (l) => l.map((x, i) => (i === 6 ? "Version: " : x)).join("\n"), "version"],
    ["Chain ID line missing", (l) => l.filter((_, i) => i !== 7).join("\n"), "chain_id"],
    ["Nonce line missing", (l) => l.filter((_, i) => i !== 8).join("\n"), "nonce"],
    ["nonce shorter than 8 characters", (l) => l.map((x, i) => (i === 8 ? "Nonce: abc123" : x)).join("\n"), "nonce"],
    ["nonce with a non-alphanumeric character", (l) => l.map((x, i) => (i === 8 ? "Nonce: abcdefgh!" : x)).join("\n"), "nonce"],
    ["Issued At line missing", (l) => l.filter((_, i) => i !== 9).join("\n"), "issued_at"],
    ["URI and Version swapped", (l) => [...l.slice(0, 5), l[6]!, l[5]!, ...l.slice(7)].join("\n"), "uri"],
    ["Issued At month 13", (l) => l.map((x, i) => (i === 9 ? "Issued At: 2025-13-01T10:00:00.000Z" : x)).join("\n"), "issued_at"],
    ["Issued At 30 February", (l) => l.map((x, i) => (i === 9 ? "Issued At: 2025-02-30T10:00:00Z" : x)).join("\n"), "issued_at"],
    ["Issued At 29 February in a non-leap year", (l) => l.map((x, i) => (i === 9 ? "Issued At: 2025-02-29T10:00:00Z" : x)).join("\n"), "issued_at"],
    ["Issued At hour 24", (l) => l.map((x, i) => (i === 9 ? "Issued At: 2025-12-01T24:00:00Z" : x)).join("\n"), "issued_at"],
    ["Issued At without a zone", (l) => l.map((x, i) => (i === 9 ? "Issued At: 2025-12-01T10:00:00" : x)).join("\n"), "issued_at"],
    ["Issued At with a space instead of T", (l) => l.map((x, i) => (i === 9 ? "Issued At: 2025-12-01 10:00:00Z" : x)).join("\n"), "issued_at"],
    ["Issued At in words", (l) => l.map((x, i) => (i === 9 ? "Issued At: yesterday" : x)).join("\n"), "issued_at"],
    ["Expiration Time that is not a time", (l) => l.map((x, i) => (i === 10 ? "Expiration Time: soon" : x)).join("\n"), "expiration_time"],
    ["Not Before that is not a time", (l) => [...l, "Not Before: 2025-12-01"].join("\n"), "not_before"],
    ["Request ID with a space", (l) => [...l, "Request ID: two words"].join("\n"), "request_id"],
    ["Resources entry that is not a URI", (l) => [...l, "Resources:", "- not a uri"].join("\n"), "resources"],
    ["Resources entry without a scheme", (l) => [...l, "Resources:", "- example.com"].join("\n"), "resources"],
    ["Not Before placed before Expiration Time", (l) => [...l.slice(0, 10), "Not Before: 2025-12-01T10:00:00Z", l[10]!].join("\n"), "trailing"],
    ["an extra line at the end", (l) => [...l, "Foo: bar"].join("\n"), "trailing"],
    ["a trailing newline", (l) => `${l.join("\n")}\n`, "trailing"],
    ["a blank line at the end of the optional section", (l) => [...l, ""].join("\n"), "trailing"],
    ["an extra line between fields", (l) => [...l.slice(0, 8), "Extra: 1", ...l.slice(8)].join("\n"), "nonce"],
    ["CRLF line endings", (l) => l.join("\r\n"), "control_characters"],
    ["a tab inside the statement", (l) => l.map((x, i) => (i === 3 ? `${SIGN_IN_STATEMENT}\t` : x)).join("\n"), "control_characters"],
    ["a NUL character", (l) => l.join("\n").replace("Version: 1", "Version: 1\u0000"), "control_characters"],
    ["text over the length cap", (l) => l.map((x, i) => (i === 3 ? "a".repeat(MAX_SIWS_TEXT_LENGTH) : x)).join("\n"), "too_long"],
  ];

  test.each(cases)("%s", (_name, build, error) => {
    expectError(build(baseLines()), error);
  });

  test("non-string input does not throw", () => {
    expect(parseSiws(undefined as unknown as string)).toEqual({ ok: false, error: "not_text" });
    expect(parseSiws(42 as unknown as string)).toEqual({ ok: false, error: "not_text" });
  });

  test("error codes never echo the input", () => {
    const text = baseLines().join("\n").replace("Version: 1", "Version: ");
    expect(JSON.stringify(parseSiws(text))).not.toContain(ADDRESS);
  });
});

describe("formatSiws and parseSiws round-trip", () => {
  const samples: ReadonlyArray<readonly [string, SiwsFields]> = [
    ["required fields and statement", baseFields],
    [
      "no statement and no expiration time",
      { domain: "a.b", address: ADDRESS, uri: "https://a.b", version: "1", chainId: "solana:devnet", nonce: "AbCd1234", issuedAt: ISSUED },
    ],
    [
      "all optional fields",
      {
        ...baseFields,
        notBefore: "2025-12-01T09:59:00Z",
        requestId: "r1",
        resources: ["https://a.example/x", "mailto:user@example.com"],
      },
    ],
    ["an empty Resources list", { ...baseFields, resources: [] }],
    ["the all-zero address", { ...baseFields, address: "1".repeat(32) }],
  ];

  test.each(samples)("%s", (_name, fields) => {
    expect(expectParsed(formatSiws(fields))).toEqual(fields);
  });
});

describe("isSolanaAddress", () => {
  test("accepts base58 of 32 bytes", () => {
    expect(isSolanaAddress(ADDRESS)).toBe(true);
    expect(isSolanaAddress("1".repeat(32))).toBe(true);
    expect(isSolanaAddress(encodeBase58(new Uint8Array(32).fill(255)))).toBe(true);
  });

  test("rejects other lengths, bad characters, and the empty string", () => {
    expect(isSolanaAddress("")).toBe(false);
    expect(isSolanaAddress(encodeBase58(new Uint8Array(31).fill(1)))).toBe(false);
    expect(isSolanaAddress(encodeBase58(new Uint8Array(33).fill(1)))).toBe(false);
    expect(isSolanaAddress(`${ADDRESS.slice(0, -1)}l`)).toBe(false);
    expect(isSolanaAddress(`${ADDRESS} `)).toBe(false);
    expect(isSolanaAddress("1".repeat(1000))).toBe(false);
  });
});

describe("parseIsoTimestamp", () => {
  test("parses UTC instants", () => {
    expect(parseIsoTimestamp("1970-01-01T00:00:00Z")).toBe(0);
    expect(parseIsoTimestamp("1970-01-01T00:00:00.000Z")).toBe(0);
    expect(parseIsoTimestamp("2025-12-01T10:00:00.123Z")).toBe(Date.parse("2025-12-01T10:00:00.123Z"));
    expect(parseIsoTimestamp("2024-02-29T00:00:00Z")).toBe(Date.parse("2024-02-29T00:00:00Z"));
  });

  test("applies zone offsets", () => {
    expect(parseIsoTimestamp("1970-01-01T01:00:00+01:00")).toBe(0);
    expect(parseIsoTimestamp("1969-12-31T19:00:00-05:00")).toBe(0);
  });

  test("handles short and long fractions", () => {
    expect(parseIsoTimestamp("1970-01-01T00:00:00.5Z")).toBe(500);
    expect(parseIsoTimestamp("1970-01-01T00:00:00.123456789Z")).toBe(123);
  });

  test.each([
    "",
    "2025-12-01",
    "2025-12-01T10:00:00",
    "2025-12-01 10:00:00Z",
    "2025-12-01t10:00:00z",
    "2025-00-01T10:00:00Z",
    "2025-12-00T10:00:00Z",
    "2025-04-31T10:00:00Z",
    "2025-12-01T10:60:00Z",
    "2025-12-01T10:00:60Z",
    "2025-12-01T10:00:00+24:00",
    "2025-12-01T10:00:00+01:60",
    "2025-12-01T10:00:00.Z",
    " 2025-12-01T10:00:00Z",
  ])("rejects %j", (text) => {
    expect(parseIsoTimestamp(text)).toBeNull();
  });
});
