import { describe, expect, test } from "bun:test";
import { encodeBase58 } from "../../../shared/base58.ts";
import {
  ED25519_PUBLIC_KEY_BYTES,
  ED25519_SIGNATURE_BYTES,
  decodePublicKey,
  verifyEd25519,
} from "./ed25519.ts";
import { SIGN_IN_STATEMENT, formatSiws } from "./siws.ts";

const hex = (text: string): Uint8Array => Uint8Array.from(text.match(/../g) ?? [], (h) => Number.parseInt(h, 16));
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

interface KeyPair {
  readonly publicKey: CryptoKey;
  readonly privateKey: CryptoKey;
}

async function generateKeyPair(): Promise<{ publicKey: Uint8Array; sign: (message: Uint8Array) => Promise<Uint8Array> }> {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as unknown as KeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const sign = async (message: Uint8Array): Promise<Uint8Array> =>
    new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, new Uint8Array(message)));
  return { publicKey, sign };
}

function flipBit(bytes: Uint8Array, index: number): Uint8Array {
  const copy = bytes.slice();
  copy[index] = (copy[index] ?? 0) ^ 0x01;
  return copy;
}

// RFC 8032 section 7.1, TEST 1 to TEST 3.
const RFC_VECTORS: ReadonlyArray<readonly [name: string, publicKey: string, message: string, signature: string]> = [
  [
    "TEST 1 (empty message)",
    "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    "",
    "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
  ],
  [
    "TEST 2 (1 byte)",
    "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
    "72",
    "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
  ],
  [
    "TEST 3 (2 bytes)",
    "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025",
    "af82",
    "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a",
  ],
];

describe("verifyEd25519 with RFC 8032 vectors (proves WebCrypto Ed25519 on this Bun)", () => {
  test.each(RFC_VECTORS)("%s verifies", async (_name, pk, msg, sig) => {
    expect(await verifyEd25519(hex(pk), hex(sig), hex(msg))).toBe(true);
  });

  test.each(RFC_VECTORS)("%s fails when the message changes", async (_name, pk, msg, sig) => {
    const changed = msg === "" ? Uint8Array.of(0) : flipBit(hex(msg), 0);
    expect(await verifyEd25519(hex(pk), hex(sig), changed)).toBe(false);
  });

  test.each(RFC_VECTORS)("%s fails when one signature bit changes", async (_name, pk, msg, sig) => {
    for (const index of [0, 10, 31, 32, 50, 63]) {
      expect(await verifyEd25519(hex(pk), flipBit(hex(sig), index), hex(msg))).toBe(false);
    }
  });

  test("a signature does not verify under another vector's public key", async () => {
    const [first, second] = RFC_VECTORS;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(await verifyEd25519(hex(second![1]), hex(first![3]), hex(first![2]))).toBe(false);
  });

  test("views into a larger buffer are read by their own bytes", async () => {
    const [vector] = RFC_VECTORS;
    const padded = new Uint8Array(100);
    padded.set(hex(vector![3]), 20);
    expect(await verifyEd25519(hex(vector![1]), padded.subarray(20, 20 + ED25519_SIGNATURE_BYTES), hex(vector![2]))).toBe(
      true,
    );
  });
});

describe("verifyEd25519 with a generated keypair", () => {
  test("verifies a signature over an arbitrary message", async () => {
    const { publicKey, sign } = await generateKeyPair();
    expect(publicKey.length).toBe(ED25519_PUBLIC_KEY_BYTES);
    const message = utf8("any message, including unicode: \u2603 and bytes");
    const signature = await sign(message);
    expect(signature.length).toBe(ED25519_SIGNATURE_BYTES);
    expect(await verifyEd25519(publicKey, signature, message)).toBe(true);
  });

  test("rejects a changed message, a changed signature, and a different key", async () => {
    const a = await generateKeyPair();
    const b = await generateKeyPair();
    const message = utf8("hello");
    const signature = await a.sign(message);
    expect(await verifyEd25519(a.publicKey, signature, utf8("hellp"))).toBe(false);
    expect(await verifyEd25519(a.publicKey, signature, utf8("hello "))).toBe(false);
    expect(await verifyEd25519(a.publicKey, signature, new Uint8Array(0))).toBe(false);
    for (let i = 0; i < ED25519_SIGNATURE_BYTES; i += 9) {
      expect(await verifyEd25519(a.publicKey, flipBit(signature, i), message)).toBe(false);
    }
    expect(await verifyEd25519(b.publicKey, signature, message)).toBe(false);
  });

  test("verifies a signed SIWS message through its base58 address", async () => {
    const { publicKey, sign } = await generateKeyPair();
    const address = encodeBase58(publicKey);
    const text = formatSiws({
      domain: "localhost:3000",
      address,
      statement: SIGN_IN_STATEMENT,
      uri: "http://localhost:3000",
      version: "1",
      chainId: "solana:mainnet",
      nonce: "9mTpZ4kQw2XnB7vL",
      issuedAt: "2025-12-01T10:00:00.000Z",
      expirationTime: "2025-12-01T10:05:00.000Z",
    });
    const signature = await sign(utf8(text));
    const key = decodePublicKey(address);
    expect(key).toEqual(publicKey);
    expect(await verifyEd25519(key as Uint8Array, signature, utf8(text))).toBe(true);
    expect(await verifyEd25519(key as Uint8Array, signature, utf8(text.replace("localhost", "evil.test")))).toBe(false);
  });
});

describe("verifyEd25519 returns false for bad input and never throws", () => {
  const pk = hex(RFC_VECTORS[0]![1]);
  const sig = hex(RFC_VECTORS[0]![3]);
  const msg = new Uint8Array(0);

  test("wrong public key lengths", async () => {
    for (const length of [0, 1, 31, 33, 64]) {
      expect(await verifyEd25519(new Uint8Array(length).fill(1), sig, msg)).toBe(false);
    }
    expect(await verifyEd25519(pk.subarray(0, 31), sig, msg)).toBe(false);
  });

  test("wrong signature lengths", async () => {
    for (const length of [0, 1, 63, 65, 128]) {
      expect(await verifyEd25519(pk, new Uint8Array(length).fill(1), msg)).toBe(false);
    }
    expect(await verifyEd25519(pk, sig.subarray(0, 63), msg)).toBe(false);
    const longer = new Uint8Array(65);
    longer.set(sig);
    expect(await verifyEd25519(pk, longer, msg)).toBe(false);
  });

  test("all-zero and all-0xff signatures of the right length under a real key", async () => {
    expect(await verifyEd25519(pk, new Uint8Array(64), msg)).toBe(false);
    expect(await verifyEd25519(pk, new Uint8Array(64).fill(255), utf8("x"))).toBe(false);
  });

  test("an all-0xff key of the right length does not throw", async () => {
    expect(typeof (await verifyEd25519(new Uint8Array(32).fill(255), sig, msg))).toBe("boolean");
  });

  test("random bytes", async () => {
    for (let i = 0; i < 5; i++) {
      const randomKey = crypto.getRandomValues(new Uint8Array(32));
      const randomSig = crypto.getRandomValues(new Uint8Array(64));
      expect(await verifyEd25519(randomKey, randomSig, utf8("garbage"))).toBe(false);
    }
  });

  test("arguments that are not Uint8Arrays", async () => {
    const bad = [undefined, null, "text", 42, {}, [1, 2, 3], new ArrayBuffer(32)] as unknown[];
    for (const value of bad) {
      expect(await verifyEd25519(value as Uint8Array, sig, msg)).toBe(false);
      expect(await verifyEd25519(pk, value as Uint8Array, msg)).toBe(false);
      expect(await verifyEd25519(pk, sig, value as Uint8Array)).toBe(false);
    }
  });
});

describe("decodePublicKey", () => {
  test("decodes a base58 address into its 32 bytes", () => {
    const bytes = hex(RFC_VECTORS[1]![1]);
    expect(decodePublicKey(encodeBase58(bytes))).toEqual(bytes);
  });

  test("the all-zero key is 32 '1' characters", () => {
    expect(decodePublicKey("1".repeat(32))).toEqual(new Uint8Array(32));
  });

  test("returns null for the wrong length, bad characters, empty, and long text", () => {
    expect(decodePublicKey(encodeBase58(new Uint8Array(31).fill(7)))).toBeNull();
    expect(decodePublicKey(encodeBase58(new Uint8Array(33).fill(7)))).toBeNull();
    expect(decodePublicKey(`${encodeBase58(new Uint8Array(32).fill(7)).slice(0, -1)}0`)).toBeNull();
    expect(decodePublicKey("")).toBeNull();
    expect(decodePublicKey(" ")).toBeNull();
    expect(decodePublicKey("1".repeat(10_000))).toBeNull();
    expect(decodePublicKey(undefined as unknown as string)).toBeNull();
  });
});
