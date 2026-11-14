// Base58 with the Bitcoin alphabet (Solana addresses and our nonces use it).
//
// Dependency-free and BigInt-free so the web UI and the server can both import it. Each leading
// zero byte becomes one leading "1" and back. Decoding is strict: any character outside the
// alphabet (including whitespace, "0", "O", "I", "l", and non-ASCII) is an error.
//
// Used by shared/siws.ts (address validation) and server/src/auth (Req 45.1, 45.3, 45.4).
//
// Decision (task 18.2): hand-written, not `@scure/base` as design Decision A11 first proposed. The
// algorithm is short, and the known vectors and property tests in base58.test.ts cover it, so
// no dependency is needed.

export const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Thrown by `decodeBase58` for any character outside the alphabet. The message never echoes the input. */
export class Base58Error extends Error {
  constructor() {
    super("invalid base58 character");
    this.name = "Base58Error";
  }
}

/** ASCII code → digit value, or -1. Codes above 127 are out of range and handled by the caller. */
const DIGIT_OF: Int8Array = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < BASE58_ALPHABET.length; i++) table[BASE58_ALPHABET.charCodeAt(i)] = i;
  return table;
})();

export function encodeBase58(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  // log(256) / log(58) is about 1.3657, so 138/100 is a safe upper bound on digits per byte.
  const size = Math.floor(((bytes.length - zeros) * 138) / 100) + 1;
  const digits = new Uint8Array(size);
  let length = 0;
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i] ?? 0;
    let used = 0;
    for (let k = size - 1; (carry !== 0 || used < length) && k >= 0; k--, used++) {
      carry += 256 * (digits[k] ?? 0);
      digits[k] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    length = used;
  }

  let start = size - length;
  while (start < size && digits[start] === 0) start++;
  let out = "1".repeat(zeros);
  for (; start < size; start++) out += BASE58_ALPHABET.charAt(digits[start] ?? 0);
  return out;
}

/** Decodes base58 text. Throws `Base58Error` on a character outside the alphabet. */
export function decodeBase58(text: string): Uint8Array {
  let zeros = 0;
  while (zeros < text.length && text.charCodeAt(zeros) === 0x31 /* "1" */) zeros++;

  // log(58) / log(256) is about 0.7325, so 733/1000 is a safe upper bound on bytes per digit.
  const size = Math.floor(((text.length - zeros) * 733) / 1000) + 1;
  const bytes = new Uint8Array(size);
  let length = 0;
  for (let i = zeros; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const digit = code < 128 ? (DIGIT_OF[code] ?? -1) : -1;
    if (digit < 0) throw new Base58Error();
    let carry = digit;
    let used = 0;
    for (let k = size - 1; (carry !== 0 || used < length) && k >= 0; k--, used++) {
      carry += 58 * (bytes[k] ?? 0);
      bytes[k] = carry % 256;
      carry = Math.floor(carry / 256);
    }
    length = used;
  }

  let start = size - length;
  while (start < size && bytes[start] === 0) start++;
  const out = new Uint8Array(zeros + (size - start));
  out.set(bytes.subarray(start), zeros);
  return out;
}

/** Like `decodeBase58`, but returns null instead of throwing. */
export function tryDecodeBase58(text: string): Uint8Array | null {
  try {
    return decodeBase58(text);
  } catch {
    return null;
  }
}
