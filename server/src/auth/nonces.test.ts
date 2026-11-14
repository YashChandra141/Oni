import { describe, expect, test } from "bun:test";
import { decodeBase58, encodeBase58 } from "../../../shared/base58.ts";
import { NonceStore } from "./nonces.ts";
import { NONCE_TTL_MS } from "./siws.ts";

const ORIGIN = "http://localhost:3000";
const ADDRESS = encodeBase58(new Uint8Array(32).fill(3));

function setup(capacity?: number) {
  const clock = { ms: 1_000_000 };
  let counter = 0;
  const store = new NonceStore({
    now: () => clock.ms,
    randomBytes: (n) => new Uint8Array(n).fill(++counter),
    capacity,
  });
  return { clock, store };
}

describe("NonceStore", () => {
  test("issues a 16-byte base58 nonce and consumes it once", () => {
    const { store } = setup();
    const { nonce, expiresAt } = store.issue(ORIGIN, ADDRESS);
    expect(decodeBase58(nonce).length).toBe(16);
    expect(expiresAt).toBe(1_000_000 + NONCE_TTL_MS);
    const record = store.consume(nonce, ADDRESS);
    expect(record).toMatchObject({ nonce, origin: ORIGIN, address: ADDRESS, used: false });
    expect(store.consume(nonce, ADDRESS)).toBeUndefined();
  });

  test("an unbound nonce takes the address from the message", () => {
    const { store } = setup();
    const { nonce } = store.issue(ORIGIN);
    expect(store.consume(nonce, ADDRESS)?.address).toBe(ADDRESS);
  });

  test("an expired nonce is pruned on issue but returned by consume before that", () => {
    const { store, clock } = setup();
    const a = store.issue(ORIGIN, ADDRESS).nonce;
    clock.ms += NONCE_TTL_MS;
    expect(store.consume(a, ADDRESS)?.expiresAt).toBeLessThanOrEqual(clock.ms);
    const b = store.issue(ORIGIN, ADDRESS).nonce;
    clock.ms += NONCE_TTL_MS;
    store.prune();
    expect(store.peek(b)).toBeUndefined();
  });

  test("drops the oldest entry past capacity", () => {
    const { store } = setup(2);
    const first = store.issue(ORIGIN, ADDRESS).nonce;
    store.issue(ORIGIN, ADDRESS);
    store.issue(ORIGIN, ADDRESS);
    expect(store.size).toBe(2);
    expect(store.consume(first, ADDRESS)).toBeUndefined();
  });
});

describe("NonceStore expiry and eviction", () => {
  test("a nonce is live one millisecond before 5 minutes and gone at exactly 5 minutes", () => {
    const { store, clock } = setup();
    const { nonce, expiresAt } = store.issue(ORIGIN, ADDRESS);
    expect(expiresAt - clock.ms).toBe(5 * 60_000);
    clock.ms = expiresAt - 1;
    expect(store.peek(nonce)).toBeDefined();
    clock.ms = expiresAt;
    expect(store.peek(nonce)).toBeUndefined();
  });

  test("consuming an expired nonce removes it, so it cannot be retried", () => {
    const { store, clock } = setup();
    const { nonce } = store.issue(ORIGIN, ADDRESS);
    clock.ms += NONCE_TTL_MS + 1;
    expect(store.consume(nonce, ADDRESS)).toBeDefined();
    expect(store.consume(nonce, ADDRESS)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  test("peek does not consume, and consume then peek finds nothing", () => {
    const { store } = setup();
    const { nonce } = store.issue(ORIGIN, ADDRESS);
    expect(store.peek(nonce)).toBeDefined();
    expect(store.peek(nonce)).toBeDefined();
    store.consume(nonce, ADDRESS);
    expect(store.peek(nonce)).toBeUndefined();
  });

  test("past capacity the oldest nonces go first and the newest remain", () => {
    const { store } = setup(3);
    const nonces = [1, 2, 3, 4, 5].map(() => store.issue(ORIGIN, ADDRESS).nonce);
    expect(store.size).toBe(3);
    expect(store.peek(nonces[0] ?? "")).toBeUndefined();
    expect(store.peek(nonces[1] ?? "")).toBeUndefined();
    expect(store.peek(nonces[2] ?? "")).toBeDefined();
    expect(store.peek(nonces[3] ?? "")).toBeDefined();
    expect(store.peek(nonces[4] ?? "")).toBeDefined();
  });
});
