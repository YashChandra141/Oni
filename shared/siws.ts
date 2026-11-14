// Sign In With Solana (SIWS) message parser and formatter (Req 45.8, 45.9, 45.10).
//
// Dependency-free so the web UI (signMessage fallback) and the server share one implementation;
// `server/src/auth/siws.ts` re-exports it and adds the policy checks (`checkSiws`).
//
// Line format (the Wallet Standard `createSignInMessageText` shape, which Phantom and Backpack
// produce through `solana:signIn`). Joined with "\n", no trailing newline:
//
//   <domain> wants you to sign in with your Solana account:
//   <address>
//   <blank>
//   <statement>                  (optional; when absent the blank line is not repeated)
//   <blank>                      (only when a statement is present)
//   URI: <uri>
//   Version: <version>
//   Chain ID: <chainId>
//   Nonce: <nonce>
//   Issued At: <ISO 8601>
//   Expiration Time: <ISO 8601>  (optional)
//   Not Before: <ISO 8601>       (optional)
//   Request ID: <id>             (optional)
//   Resources:                   (optional; followed by one "- <uri>" line per resource)
//   - <uri>
//
// The parser is strict about structure (exact lines, fixed field order, no trailing lines) and
// about the syntax of each value (base58 address of 32 bytes, real ISO 8601 timestamps), but it
// does not judge policy: whether the version is "1", the chain is `solana:mainnet`, or the
// statement is ours is decided by `checkSiws` on the server. Error codes are short machine codes
// and never echo the input.

import { tryDecodeBase58 } from "./base58.ts";

/** The only statement the server issues and accepts (Req 45.1, 45.5). */
export const SIGN_IN_STATEMENT =
  "Sign in to Haunted Terminal paper trading. This signature does not authorize any transaction.";
/** SIWS version the server accepts (Req 45.5). */
export const SIWS_VERSION = "1";
/** Chain ID the server issues. An identity claim only; no RPC is ever contacted (Req 49.3). */
export const SOLANA_MAINNET_CHAIN_ID = "solana:mainnet";
/** Upper bound on the text the parser looks at, as a guard on untrusted input. */
export const MAX_SIWS_TEXT_LENGTH = 4096;

export interface SiwsFields {
  /** Host (and port) the user signs in to. */
  readonly domain: string;
  /** Wallet_Address: base58 of a 32-byte Ed25519 public key. */
  readonly address: string;
  /** Free text, one line, must not start with "URI: ". Absent in a statement-less message. */
  readonly statement?: string;
  readonly uri: string;
  readonly version: string;
  readonly chainId: string;
  readonly nonce: string;
  /** ISO 8601 with a zone ("Z" or ±hh:mm). Kept as text so formatting reproduces the signed bytes. */
  readonly issuedAt: string;
  readonly expirationTime?: string;
  readonly notBefore?: string;
  readonly requestId?: string;
  readonly resources?: readonly string[];
}

export type SiwsParseError =
  | "not_text"
  | "too_long"
  | "control_characters"
  | "header"
  | "domain"
  | "address"
  | "layout"
  | "statement"
  | "uri"
  | "version"
  | "chain_id"
  | "nonce"
  | "issued_at"
  | "expiration_time"
  | "not_before"
  | "request_id"
  | "resources"
  | "trailing";

export type SiwsParseResult =
  | { readonly ok: true; readonly fields: SiwsFields }
  | { readonly ok: false; readonly error: SiwsParseError };

const HEADER_SUFFIX = " wants you to sign in with your Solana account:";
const STATEMENT_URI_PREFIX = "URI: ";

/** Any control character except "\n" (so "\r", tabs, and NUL are rejected). */
const CONTROL_CHARACTERS = /[\u0000-\u0009\u000b-\u001f\u007f]/;
const DOMAIN = /^[^\s/?#]+$/;
const TOKEN = /^\S+$/;
const URI = /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/;
const NONCE = /^[A-Za-z0-9]{8,64}$/;
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

const ADDRESS_MIN_LENGTH = 32;
const ADDRESS_MAX_LENGTH = 44;
const PUBLIC_KEY_BYTES = 32;

/** True when `text` is base58 that decodes to exactly 32 bytes. */
export function isSolanaAddress(text: string): boolean {
  if (text.length < ADDRESS_MIN_LENGTH || text.length > ADDRESS_MAX_LENGTH) return false;
  const bytes = tryDecodeBase58(text);
  return bytes !== null && bytes.length === PUBLIC_KEY_BYTES;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/**
 * Parses an ISO 8601 date-time with a mandatory zone (`2025-01-31T12:00:00.000Z`,
 * `2025-01-31T12:00:00+02:00`) into epoch milliseconds, or null when the text is not a real
 * instant (month 13, 30 February, 24:00:00, a missing zone, and so on). Fractions beyond
 * milliseconds are accepted and truncated.
 */
export function parseIsoTimestamp(text: string): number | null {
  const match = ISO_TIMESTAMP.exec(text);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7];
  const zone = match[8];
  if (zone === undefined) return null;

  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  let offsetMinutes = 0;
  if (zone !== "Z") {
    const zoneHour = Number(zone.slice(1, 3));
    const zoneMinute = Number(zone.slice(4, 6));
    if (zoneHour > 23 || zoneMinute > 59) return null;
    offsetMinutes = (zone.startsWith("-") ? -1 : 1) * (zoneHour * 60 + zoneMinute);
  }
  const millis = fraction === undefined ? 0 : Number(fraction.slice(0, 3).padEnd(3, "0"));

  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millis);
  const time = date.getTime() - offsetMinutes * 60_000;
  return Number.isFinite(time) ? time : null;
}

function fail(error: SiwsParseError): SiwsParseResult {
  return { ok: false, error };
}

/**
 * Parses SIWS message text. Strict: the lines must appear exactly as in the format above, with no
 * extra or trailing lines. Never throws.
 */
export function parseSiws(text: string): SiwsParseResult {
  if (typeof text !== "string") return fail("not_text");
  if (text.length > MAX_SIWS_TEXT_LENGTH) return fail("too_long");
  if (CONTROL_CHARACTERS.test(text)) return fail("control_characters");

  const lines = text.split("\n");

  const header = lines[0] ?? "";
  if (!header.endsWith(HEADER_SUFFIX)) return fail("header");
  const domain = header.slice(0, header.length - HEADER_SUFFIX.length);
  if (!DOMAIN.test(domain)) return fail("domain");

  const address = lines[1];
  if (address === undefined || !isSolanaAddress(address)) return fail("address");
  if (lines[2] !== "") return fail("layout");

  let index = 3;
  let statement: string | undefined;
  const third = lines[3];
  if (third === undefined) return fail("layout");
  if (!third.startsWith(STATEMENT_URI_PREFIX)) {
    if (third === "") return fail("statement");
    statement = third;
    if (lines[4] !== "") return fail("layout");
    index = 5;
  }

  const take = (prefix: string): string | undefined => {
    const line = lines[index];
    if (line === undefined || !line.startsWith(prefix)) return undefined;
    index++;
    return line.slice(prefix.length);
  };

  const uri = take("URI: ");
  if (uri === undefined || !URI.test(uri)) return fail("uri");
  const version = take("Version: ");
  if (version === undefined || !TOKEN.test(version)) return fail("version");
  const chainId = take("Chain ID: ");
  if (chainId === undefined || !TOKEN.test(chainId)) return fail("chain_id");
  const nonce = take("Nonce: ");
  if (nonce === undefined || !NONCE.test(nonce)) return fail("nonce");
  const issuedAt = take("Issued At: ");
  if (issuedAt === undefined || parseIsoTimestamp(issuedAt) === null) return fail("issued_at");

  const expirationTime = take("Expiration Time: ");
  if (expirationTime !== undefined && parseIsoTimestamp(expirationTime) === null) return fail("expiration_time");
  const notBefore = take("Not Before: ");
  if (notBefore !== undefined && parseIsoTimestamp(notBefore) === null) return fail("not_before");
  const requestId = take("Request ID: ");
  if (requestId !== undefined && !TOKEN.test(requestId)) return fail("request_id");

  let resources: string[] | undefined;
  if (lines[index] === "Resources:") {
    index++;
    resources = [];
    for (let resource = take("- "); resource !== undefined; resource = take("- ")) {
      if (!URI.test(resource)) return fail("resources");
      resources.push(resource);
    }
  }

  if (index !== lines.length) return fail("trailing");

  return {
    ok: true,
    fields: {
      domain,
      address,
      ...(statement !== undefined ? { statement } : {}),
      uri,
      version,
      chainId,
      nonce,
      issuedAt,
      ...(expirationTime !== undefined ? { expirationTime } : {}),
      ...(notBefore !== undefined ? { notBefore } : {}),
      ...(requestId !== undefined ? { requestId } : {}),
      ...(resources !== undefined ? { resources } : {}),
    },
  };
}

/**
 * Formats fields as SIWS message text. For valid fields (the ones `parseSiws` can return),
 * `parseSiws(formatSiws(f))` yields fields equal to `f`. It does not validate: text that breaks the
 * format, such as a statement with a newline, produces text that `parseSiws` rejects.
 */
export function formatSiws(fields: SiwsFields): string {
  const lines: string[] = [`${fields.domain}${HEADER_SUFFIX}`, fields.address, ""];
  if (fields.statement !== undefined) lines.push(fields.statement, "");
  lines.push(
    `URI: ${fields.uri}`,
    `Version: ${fields.version}`,
    `Chain ID: ${fields.chainId}`,
    `Nonce: ${fields.nonce}`,
    `Issued At: ${fields.issuedAt}`,
  );
  if (fields.expirationTime !== undefined) lines.push(`Expiration Time: ${fields.expirationTime}`);
  if (fields.notBefore !== undefined) lines.push(`Not Before: ${fields.notBefore}`);
  if (fields.requestId !== undefined) lines.push(`Request ID: ${fields.requestId}`);
  if (fields.resources !== undefined) {
    lines.push("Resources:");
    for (const resource of fields.resources) lines.push(`- ${resource}`);
  }
  return lines.join("\n");
}
