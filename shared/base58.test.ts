import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { BASE58_ALPHABET, Base58Error, decodeBase58, encodeBase58, tryDecodeBase58 } from "./base58.ts";

const ascii = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("base58 known vectors", () => {
  test('"Hello World!" encodes to 2NEpo7TZRRrLZSi2U', () => {
    expect(encodeBase58(ascii("Hello World!"))).toBe("2NEpo7TZRRrLZSi2U");
    expect(new TextDecoder().decode(decodeBase58("2NEpo7TZRRrLZSi2U"))).toBe("Hello World!");
  });

  test("32 zero bytes encode to 32 '1' characters", () => {
    expect(encodeBase58(new Uint8Array(32))).toBe("1".repeat(32));
    expect(decodeBase58("1".repeat(32))).toEqual(new Uint8Array(32));
  });

  test("the empty array and the empty string map to each other", () => {
    expect(encodeBase58(new Uint8Array(0))).toBe("");
    expect(decodeBase58("")).toEqual(new Uint8Array(0));
  });

  test("single bytes", () => {
    expect(encodeBase58(Uint8Array.of(0))).toBe("1");
    expect(encodeBase58(Uint8Array.of(57))).toBe("z");
    expect(encodeBase58(Uint8Array.of(58))).toBe("21");
    expect(encodeBase58(Uint8Array.of(255))).toBe("5Q");
    expect(decodeBase58("5Q")).toEqual(Uint8Array.of(255));
  });

  test("the system program address is 32 zero bytes", () => {
    expect(decodeBase58("11111111111111111111111111111111")).toEqual(new Uint8Array(32));
  });

  test("32 bytes of 0xff encode to 44 characters and decode back", () => {
    const bytes = new Uint8Array(32).fill(255);
    const text = encodeBase58(bytes);
    expect(text.length).toBe(44);
    expect(decodeBase58(text)).toEqual(bytes);
  });
});

describe("base58 leading zeros", () => {
  test("each leading zero byte is one leading '1'", () => {
    expect(encodeBase58(Uint8Array.of(0, 0, 1))).toBe("112");
    expect(decodeBase58("112")).toEqual(Uint8Array.of(0, 0, 1));
    expect(encodeBase58(Uint8Array.of(0, 0, 0))).toBe("111");
    expect(decodeBase58("111")).toEqual(Uint8Array.of(0, 0, 0));
  });

  test("zero bytes after a non-zero byte are not collapsed", () => {
    const bytes = Uint8Array.of(1, 0, 0, 0);
    expect(decodeBase58(encodeBase58(bytes))).toEqual(bytes);
  });
});

describe("base58 strict decoding", () => {
  test.each(["0", "O", "I", "l", "abc0", "a b", " abc", "abc ", "abc\n", "é", "日本", "a-b", "+/="])(
    "rejects %j",
    (text) => {
      expect(() => decodeBase58(text)).toThrow(Base58Error);
      expect(tryDecodeBase58(text)).toBeNull();
    },
  );

  test("the error message does not echo the input", () => {
    try {
      decodeBase58("secret-0-text");
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(Base58Error);
      expect((error as Error).message).not.toContain("secret");
    }
  });

  test("the alphabet has 58 distinct characters and none of 0 O I l", () => {
    expect(BASE58_ALPHABET.length).toBe(58);
    expect(new Set(BASE58_ALPHABET).size).toBe(58);
    for (const bad of "0OIl") expect(BASE58_ALPHABET.includes(bad)).toBe(false);
  });
});

describe("base58 properties", () => {
  test("decode(encode(bytes)) equals bytes", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 80 }), (bytes) => {
        expect(decodeBase58(encodeBase58(bytes))).toEqual(bytes);
      }),
      { numRuns: 300 },
    );
  });

  test("round-trips with a run of leading zero bytes", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 40 }), fc.uint8Array({ minLength: 0, maxLength: 40 }), (zeros, tail) => {
        const bytes = new Uint8Array(zeros + tail.length);
        bytes.set(tail, zeros);
        const text = encodeBase58(bytes);
        expect(decodeBase58(text)).toEqual(bytes);
        // Every leading zero byte is one leading "1".
        let leadingZeros = 0;
        while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) leadingZeros++;
        expect(text.startsWith("1".repeat(leadingZeros))).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  test("encode(decode(text)) equals text for any text over the alphabet", () => {
    const text = fc.array(fc.constantFrom(...BASE58_ALPHABET.split("")), { maxLength: 60 }).map((chars) => chars.join(""));
    fc.assert(
      fc.property(text, (s) => {
        expect(encodeBase58(decodeBase58(s))).toBe(s);
      }),
      { numRuns: 300 },
    );
  });
});
