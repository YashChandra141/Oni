import { describe, expect, test } from "bun:test";
import {
  PAIRING_ALPHABET,
  PAIRING_CAPACITY,
  PAIRING_TTL_MS,
  PairingStore,
  constantTimeEqual,
  normalizePairingCode,
} from "./pairing.ts";

const SECRET = new Uint8Array(32).fill(9);
const SECRET_B64 = Buffer.from(SECRET).toString("base64url");
const ADDRESS = "AddrA";

async function verifierOf(secret: Uint8Array): Promise<string> {
  // Copy into an ArrayBuffer-backed array: WebCrypto's BufferSource excludes SharedArrayBuffer.
  return Buffer.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(secret)))).toString("base64url");
}

function setup(capacity?: number) {
  const clock = { ms: 5_000 };
  let counter = 0;
  const issued: string[] = [];
  const store = new PairingStore({
    now: () => clock.ms,
    // Distinct, in-range bytes per call so codes differ.
    randomBytes: (n) => new Uint8Array(n).map((_, i) => (++counter * 7 + i) % 200),
    issueToken: async (address) => {
      issued.push(address);
      return `token-${issued.length}`;
    },
    capacity,
  });
  return { clock, store, issued };
}

describe("PairingStore", () => {
  test("code is 8 characters from the alphabet", async () => {
    const { store } = setup();
    const created = store.create(await verifierOf(SECRET));
    expect(created?.code).toMatch(new RegExp(`^[${PAIRING_ALPHABET}]{8}$`));
    expect(created?.expiresInSec).toBe(300);
  });

  test("rejects a malformed verifier", () => {
    expect(setup().store.create("short")).toBeNull();
  });

  test("pending until confirmed, then a token once, then not found", async () => {
    const { store } = setup();
    const created = store.create(await verifierOf(SECRET));
    const code = created?.code ?? "";
    expect(await store.poll(code, SECRET_B64)).toBe("pending");
    expect(store.confirm(code, ADDRESS)).toBe(true);
    expect(await store.poll(code, SECRET_B64)).toEqual({ token: "token-1", address: ADDRESS });
    expect(await store.poll(code, SECRET_B64)).toBe("not_found");
  });

  test("wrong secret is not found and does not consume the pairing", async () => {
    const { store } = setup();
    const code = store.create(await verifierOf(SECRET))?.code ?? "";
    store.confirm(code, ADDRESS);
    const wrong = Buffer.from(new Uint8Array(32).fill(1)).toString("base64url");
    expect(await store.poll(code, wrong)).toBe("not_found");
    expect(await store.poll(code, SECRET_B64)).toMatchObject({ address: ADDRESS });
  });

  test("confirm fails for unknown, expired, or differently confirmed codes", async () => {
    const { store, clock } = setup();
    const code = store.create(await verifierOf(SECRET))?.code ?? "";
    expect(store.confirm("ZZZZZZZZ", ADDRESS)).toBe(false);
    expect(store.confirm(code, ADDRESS)).toBe(true);
    expect(store.confirm(code, "AddrB")).toBe(false);
    clock.ms += PAIRING_TTL_MS;
    expect(store.confirm(code, ADDRESS)).toBe(false);
    expect(await store.poll(code, SECRET_B64)).toBe("not_found");
  });

  test("drops the oldest pairing past capacity", async () => {
    const { store } = setup(1);
    const first = store.create(await verifierOf(SECRET))?.code ?? "";
    store.create(await verifierOf(SECRET));
    expect(store.size).toBe(1);
    expect(store.confirm(first, ADDRESS)).toBe(false);
  });
});

function lcgStore(clock: { ms: number }) {
  let state = 12345;
  return new PairingStore({
    now: () => clock.ms,
    randomBytes: (n) => {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        out[i] = state >>> 24;
      }
      return out;
    },
    issueToken: async () => "t",
  });
}

describe("PairingStore capacity and expiry", () => {
  test("holds 1,000 pairings and drops the oldest when a 1,001st arrives", async () => {
    const clock = { ms: 0 };
    const store = lcgStore(clock);
    const verifier = await verifierOf(SECRET);
    const first = store.create(verifier)?.code ?? "";
    for (let i = 1; i < PAIRING_CAPACITY; i++) store.create(verifier);
    expect(store.size).toBe(PAIRING_CAPACITY);
    expect(store.confirm(first, ADDRESS)).toBe(true);
    const last = store.create(verifier)?.code ?? "";
    expect(store.size).toBe(PAIRING_CAPACITY);
    expect(store.confirm(first, ADDRESS)).toBe(false);
    expect(store.confirm(last, ADDRESS)).toBe(true);
  });

  test("expired pairings are pruned on the next create and by prune", async () => {
    const { store, clock } = setup();
    const verifier = await verifierOf(SECRET);
    const a = store.create(verifier)?.code ?? "";
    clock.ms += PAIRING_TTL_MS - 1;
    const b = store.create(verifier)?.code ?? "";
    expect(store.size).toBe(2);
    clock.ms += 1;
    expect(store.confirm(a, ADDRESS)).toBe(false);
    expect(store.size).toBe(1);
    clock.ms += PAIRING_TTL_MS;
    store.prune();
    expect(store.size).toBe(0);
    expect(store.confirm(b, ADDRESS)).toBe(false);
  });

  test("a pairing is live one millisecond before expiry and not at expiry", async () => {
    const { store, clock } = setup();
    const code = store.create(await verifierOf(SECRET))?.code ?? "";
    clock.ms += PAIRING_TTL_MS - 1;
    expect(await store.poll(code, SECRET_B64)).toBe("pending");
    clock.ms += 1;
    expect(await store.poll(code, SECRET_B64)).toBe("not_found");
  });

  test("codes are matched after normalization, and the same address may confirm twice", async () => {
    const { store } = setup();
    const code = store.create(await verifierOf(SECRET))?.code ?? "";
    const typed = `${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase();
    expect(normalizePairingCode(typed)).toBe(code);
    expect(store.confirm(typed, ADDRESS)).toBe(true);
    expect(store.confirm(code, ADDRESS)).toBe(true);
  });

  test("a non-base64url secret is not found", async () => {
    const { store } = setup();
    const code = store.create(await verifierOf(SECRET))?.code ?? "";
    expect(await store.poll(code, "not base64!")).toBe("not_found");
    expect(await store.poll(code, "")).toBe("not_found");
  });

  test("constantTimeEqual compares content and length", () => {
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1]))).toBe(false);
  });
});
