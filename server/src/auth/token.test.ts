import { describe, expect, test } from "bun:test";
import { encodeBase58 } from "../../../shared/base58.ts";
import { TOKEN_TTL_SEC, TokenDenylist, TokenService } from "./token.ts";

const ADDRESS = encodeBase58(new Uint8Array(32).fill(7));
const SECRET = "s".repeat(32);

function setup(secret = SECRET) {
  const clock = { ms: 1_700_000_000_000 };
  let counter = 0;
  const service = new TokenService({
    secret,
    now: () => clock.ms,
    randomBytes: (n) => new Uint8Array(n).fill(++counter),
  });
  return { clock, service };
}

describe("TokenService", () => {
  test("issues a token that verifies and derives the account id from the address", async () => {
    const { service } = setup();
    const token = await service.issue(ADDRESS);
    expect(token.startsWith("v1.")).toBe(true);
    const result = await service.verify(token);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.address).toBe(ADDRESS);
      expect(result.claims.accountId).toBe(`w_${ADDRESS}`);
      expect(result.claims.exp - result.claims.iat).toBe(TOKEN_TTL_SEC);
    }
  });

  test("rejects a modified payload and a token from another secret", async () => {
    const { service } = setup();
    const other = setup("t".repeat(32)).service;
    const token = await service.issue(ADDRESS);
    const [v, payload, mac] = token.split(".") as [string, string, string];
    const tampered = `${v}.${payload.slice(0, -1)}${payload.endsWith("A") ? "B" : "A"}.${mac}`;
    expect(await service.verify(tampered)).toEqual({ ok: false, reason: "bad_mac" });
    expect(await service.verify(await other.issue(ADDRESS))).toEqual({ ok: false, reason: "bad_mac" });
    expect(await service.verify("garbage")).toEqual({ ok: false, reason: "malformed" });
  });

  test("rejects an expired token", async () => {
    const { service, clock } = setup();
    const token = await service.issue(ADDRESS);
    clock.ms += TOKEN_TTL_SEC * 1000;
    expect(await service.verify(token)).toEqual({ ok: false, reason: "expired" });
  });

  test("rejects a denylisted token, and the denylist prunes expired entries", async () => {
    const { service, clock } = setup();
    const token = await service.issue(ADDRESS);
    const result = await service.verify(token);
    if (!result.ok) throw new Error("expected ok");
    service.deny(result.claims);
    expect(await service.verify(token)).toEqual({ ok: false, reason: "denied" });
    expect(service.denylist.size).toBe(1);
    clock.ms += TOKEN_TTL_SEC * 1000;
    service.denylist.prune();
    expect(service.denylist.size).toBe(0);
  });

  test("refuses to issue for a non-address", async () => {
    const { service } = setup();
    await expect(service.issue("not-an-address")).rejects.toThrow();
  });
});

describe("TokenDenylist prune boundary", () => {
  test("an entry stays until its expiry second, and is gone at it", () => {
    const clock = { ms: 99_000 };
    const denylist = new TokenDenylist(() => clock.ms);
    denylist.deny("jti-1", 100);
    expect(denylist.has("jti-1")).toBe(true);
    clock.ms = 99_999;
    expect(denylist.has("jti-1")).toBe(true);
    clock.ms = 100_000;
    expect(denylist.has("jti-1")).toBe(false);
    expect(denylist.size).toBe(0);
  });

  test("deny prunes entries that have already expired", () => {
    const clock = { ms: 0 };
    const denylist = new TokenDenylist(() => clock.ms);
    denylist.deny("old", 10);
    clock.ms = 10_000;
    denylist.deny("new", 500);
    expect(denylist.size).toBe(1);
    expect(denylist.has("new")).toBe(true);
  });
});
