import { describe, expect, test } from "bun:test";
import { encodeBase58 } from "../../../shared/base58.ts";
import {
  CLOCK_SKEW_MS,
  NONCE_TTL_MS,
  SIGN_IN_STATEMENT,
  type IssuedNonce,
  type SiwsCheckContext,
  type SiwsCheckReason,
  type SiwsFields,
  checkSiws,
  formatSiws,
  parseSiws,
} from "./siws.ts";

const ORIGIN = "http://localhost:3000";
const ADDRESS = encodeBase58(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
const NONCE = "9mTpZ4kQw2XnB7vL";
const ISSUED = "2025-12-01T10:00:00.000Z";
const EXPIRES = "2025-12-01T10:05:00.000Z";
/** Two minutes after issue: inside the nonce window and before the expiration time. */
const NOW = Date.parse("2025-12-01T10:02:00.000Z");

const issuedNonce: IssuedNonce = {
  nonce: NONCE,
  address: ADDRESS,
  origin: ORIGIN,
  expiresAt: Date.parse(EXPIRES),
  used: false,
};

const context: SiwsCheckContext = { now: NOW, origin: ORIGIN, nonce: issuedNonce };

/** The message the server issues for `ORIGIN` (design "Auth_Service"). */
const fields: SiwsFields = {
  domain: "localhost:3000",
  address: ADDRESS,
  statement: SIGN_IN_STATEMENT,
  uri: ORIGIN,
  version: "1",
  chainId: "solana:mainnet",
  nonce: NONCE,
  issuedAt: ISSUED,
  expirationTime: EXPIRES,
};

function reasonOf(f: SiwsFields, ctx: SiwsCheckContext = context): SiwsCheckReason | "ok" {
  const result = checkSiws(f, ctx);
  return result.ok ? "ok" : result.reason;
}

/** The outcome of `fields` with one or more fields changed. */
function withField(change: Partial<SiwsFields>, ctx: SiwsCheckContext = context): SiwsCheckReason | "ok" {
  return reasonOf({ ...fields, ...change }, ctx);
}

describe("checkSiws accepts a message the server issued", () => {
  test("the issued fields pass every check", () => {
    expect(checkSiws(fields, context)).toEqual({ ok: true });
  });

  test("fields parsed from the formatted text pass every check", () => {
    const parsed = parseSiws(formatSiws(fields));
    if (!parsed.ok) throw new Error(`expected a parse, got ${parsed.error}`);
    expect(checkSiws(parsed.fields, context)).toEqual({ ok: true });
  });

  test("a Not Before time equal to now has been reached", () => {
    expect(withField({ notBefore: "2025-12-01T10:02:00.000Z" })).toBe("ok");
  });

  test("an Issued At time exactly CLOCK_SKEW_MS ahead of now is accepted", () => {
    expect(withField({ issuedAt: new Date(NOW + CLOCK_SKEW_MS).toISOString() })).toBe("ok");
  });

  test("an Issued At time exactly NONCE_TTL_MS behind now is accepted", () => {
    expect(withField({ issuedAt: new Date(NOW - NONCE_TTL_MS).toISOString() })).toBe("ok");
  });
});

describe("checkSiws domain and URI (must match the request origin)", () => {
  test("a different host is a domain mismatch", () => {
    expect(withField({ domain: "evil.test:3000" })).toBe("domain_mismatch");
  });

  test("the host without its port is a domain mismatch", () => {
    expect(withField({ domain: "localhost" })).toBe("domain_mismatch");
  });

  test("a URI with a trailing slash is a URI mismatch", () => {
    expect(withField({ uri: "http://localhost:3000/" })).toBe("uri_mismatch");
  });

  test("a URI with another scheme is a URI mismatch", () => {
    expect(withField({ uri: "https://localhost:3000" })).toBe("uri_mismatch");
  });

  test("a reason never contains text from the message", () => {
    expect(JSON.stringify(checkSiws({ ...fields, domain: "evil.test:3000" }, context))).not.toContain("evil");
  });
});

describe("checkSiws address and nonce", () => {
  test("an address that is not base58 of 32 bytes is rejected before the nonce is looked at", () => {
    expect(withField({ address: encodeBase58(new Uint8Array(31).fill(7)) }, { ...context, nonce: undefined })).toBe(
      "address_invalid",
    );
  });

  test("an unknown nonce is rejected", () => {
    expect(reasonOf(fields, { ...context, nonce: undefined })).toBe("nonce_unknown");
  });

  test("a nonce that differs from the one issued is a nonce mismatch", () => {
    expect(withField({ nonce: "AAAAAAAAAAAAAAAA" })).toBe("nonce_mismatch");
  });

  test("a nonce issued for another address is a nonce mismatch", () => {
    const other = encodeBase58(new Uint8Array(32).fill(9));
    expect(reasonOf(fields, { ...context, nonce: { ...issuedNonce, address: other } })).toBe("nonce_mismatch");
  });

  test("a nonce issued for another origin is a nonce mismatch", () => {
    const other = { ...issuedNonce, origin: "http://localhost:4000" };
    expect(reasonOf(fields, { ...context, nonce: other })).toBe("nonce_mismatch");
  });

  test("a used nonce is rejected", () => {
    expect(reasonOf(fields, { ...context, nonce: { ...issuedNonce, used: true } })).toBe("nonce_used");
  });

  test("a nonce is accepted one millisecond before it expires", () => {
    expect(reasonOf(fields, { ...context, now: issuedNonce.expiresAt - 1 })).toBe("ok");
  });

  test("a nonce is rejected at the instant it expires", () => {
    expect(reasonOf(fields, { ...context, now: issuedNonce.expiresAt })).toBe("nonce_expired");
  });
});

describe("checkSiws chain ID, version, and statement", () => {
  test.each(["solana:devnet", "solana:testnet", "ethereum:1", "solana:MAINNET", ""])(
    "chain ID %j is rejected",
    (chainId) => {
      expect(withField({ chainId })).toBe("chain_id_mismatch");
    },
  );

  test.each(["2", "1.0", ""])("version %j is rejected", (version) => {
    expect(withField({ version })).toBe("version_mismatch");
  });

  test("a changed statement is rejected", () => {
    expect(withField({ statement: "Sign in to Haunted Terminal paper trading." })).toBe("statement_mismatch");
  });

  test("a message without the statement is rejected", () => {
    expect(withField({ statement: undefined })).toBe("statement_mismatch");
  });
});

describe("checkSiws timestamps", () => {
  test("a message without Expiration Time is rejected", () => {
    expect(withField({ expirationTime: undefined })).toBe("expiration_missing");
  });

  test("an Expiration Time that is not a time is rejected", () => {
    expect(withField({ expirationTime: "soon" })).toBe("bad_timestamp");
  });

  test("an Expiration Time equal to now has passed", () => {
    expect(withField({ expirationTime: "2025-12-01T10:02:00.000Z" })).toBe("expired");
  });

  test("an Expiration Time in the past is rejected", () => {
    expect(withField({ expirationTime: "2025-12-01T10:01:00.000Z" })).toBe("expired");
  });

  test("an Issued At time that is not a time is rejected", () => {
    expect(withField({ issuedAt: "yesterday" })).toBe("bad_timestamp");
  });

  test("an Issued At time one millisecond beyond the clock skew is rejected", () => {
    expect(withField({ issuedAt: new Date(NOW + CLOCK_SKEW_MS + 1).toISOString() })).toBe("issued_in_future");
  });

  test("an Issued At time one millisecond older than the nonce lifetime is rejected", () => {
    expect(withField({ issuedAt: new Date(NOW - NONCE_TTL_MS - 1).toISOString() })).toBe("issued_too_old");
  });

  test("a Not Before time in the future is rejected", () => {
    expect(withField({ notBefore: "2025-12-01T10:02:00.001Z" })).toBe("not_yet_valid");
  });

  test("a Not Before time that is not a time is rejected", () => {
    expect(withField({ notBefore: "later" })).toBe("bad_timestamp");
  });
});

describe("checkSiws resources", () => {
  test("a message with Resources is rejected, because the server issues none", () => {
    expect(withField({ resources: ["https://example.com/terms"] })).toBe("unexpected_resources");
  });
});

describe("checkSiws check order", () => {
  test("the first failing check is the one reported", () => {
    expect(withField({ domain: "evil.test:3000", statement: "other", uri: "http://x" })).toBe("domain_mismatch");
  });

  test("a used nonce is reported before a wrong statement", () => {
    expect(withField({ statement: "other" }, { ...context, nonce: { ...issuedNonce, used: true } })).toBe("nonce_used");
  });
});
