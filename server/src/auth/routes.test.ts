// Route tests for sign-in, logout, and errors (Task 18.7).
// Validates: Requirements 16.4, 45.2, 45.3, 45.5, 45.7, 45.14, 45.15
// Pairing routes are in routes.pairing.test.ts.

import { describe, expect, test } from "bun:test";
import { createHttpApp } from "../http.ts";
import { MAX_BODY_BYTES } from "./routes.ts";
import { ORIGIN, b64, createHarness, json, makeWallet, post, session, signIn } from "./routes.testing.ts";

const EVIL = "https://evil.example";

describe("POST /auth/nonce and /auth/verify: happy path", () => {
  test("nonce then verify issues a token for w_<address>", async () => {
    const h = createHarness();
    const wallet = await makeWallet();
    const result = await signIn(h, wallet);

    expect(result.nonceRes.status).toBe(200);
    expect(result.nonceRes.headers.get("cache-control")).toBe("no-store");
    expect(result.fields.domain).toBe("haunted.example");
    expect(result.fields.uri).toBe(ORIGIN);

    expect(result.verifyRes.status).toBe(200);
    expect(result.verifyRes.headers.get("cache-control")).toBe("no-store");
    const body = await json(result.verifyRes);
    expect(body["account_id"]).toBe(`w_${wallet.address}`);
    expect(body["address"]).toBe(wallet.address);
    expect(typeof body["token"]).toBe("string");

    const verified = await h.tokens.verify(body["token"] as string);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.claims.address).toBe(wallet.address);
      expect(body["exp"]).toBe(verified.claims.exp);
    }
  });
});

describe("origin check (Req 45.2)", () => {
  test("nonce: missing and disallowed Origin answer 403", async () => {
    const h = createHarness();
    const wallet = await makeWallet();
    for (const origin of [null, EVIL, "null"]) {
      const res = await post(h, "/auth/nonce", { address: wallet.address }, { origin });
      expect(res.status).toBe(403);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  test("verify: missing and disallowed Origin answer 403", async () => {
    const h = createHarness();
    for (const origin of [null, EVIL]) {
      const res = await post(h, "/auth/verify", { message: "AAAA", signature: "AAAA" }, { origin });
      expect(res.status).toBe(403);
    }
  });

  test("origin is checked before the rate limit and the body", async () => {
    const h = createHarness();
    for (let i = 0; i < 15; i++) {
      const res = await post(h, "/auth/nonce", "not json", { origin: EVIL });
      expect(res.status).toBe(403);
    }
  });
});

describe("400 cases", () => {
  test("malformed JSON", async () => {
    const h = createHarness();
    expect((await post(h, "/auth/nonce", "{not json")).status).toBe(400);
    expect((await post(h, "/auth/verify", "{not json")).status).toBe(400);
  });

  test("wrong content type", async () => {
    const h = createHarness();
    const wallet = await makeWallet();
    const res = await post(h, "/auth/nonce", { address: wallet.address }, { contentType: "text/plain" });
    expect(res.status).toBe(400);
    const none = await post(h, "/auth/nonce", { address: wallet.address }, { contentType: null });
    expect(none.status).toBe(400);
  });

  test("body over 16 KiB", async () => {
    const h = createHarness();
    const big = JSON.stringify({ address: "A".repeat(MAX_BODY_BYTES + 100) });
    expect(big.length).toBeGreaterThan(MAX_BODY_BYTES);
    expect((await post(h, "/auth/nonce", big)).status).toBe(400);
  });

  test("address that is not a Solana address", async () => {
    const h = createHarness();
    expect((await post(h, "/auth/nonce", { address: "abc" })).status).toBe(400);
    expect((await post(h, "/auth/nonce", {})).status).toBe(400);
  });

  test("bad base64 in message or signature", async () => {
    const h = createHarness();
    expect((await post(h, "/auth/verify", { message: "@@@@", signature: "AAAA" })).status).toBe(400);
    expect((await post(h, "/auth/verify", { message: "AAAA", signature: "not base64!" })).status).toBe(400);
    expect((await post(h, "/auth/verify", { message: "AAA", signature: "AAAA" })).status).toBe(400);
  });

  test("message that is not SIWS text", async () => {
    const h = createHarness();
    const message = b64(new TextEncoder().encode("hello"));
    const signature = b64(new Uint8Array(64));
    expect((await post(h, "/auth/verify", { message, signature })).status).toBe(400);
  });
});

describe("401 cases (Req 45.5)", () => {
  test("signature from another key", async () => {
    const h = createHarness();
    const wallet = await makeWallet();
    const other = await makeWallet();
    const result = await signIn(h, wallet, { signer: other });
    expect(result.verifyRes.status).toBe(401);
    expect(await json(result.verifyRes)).toEqual({ error: "verification_failed" });
  });

  test("message changed after signing", async () => {
    const h = createHarness();
    const wallet = await makeWallet();
    const result = await signIn(h, wallet, {
      afterSign: (text) =>
        text.replace(
          /Issued At: (\S+)/,
          (_match: string, iso: string) => `Issued At: ${new Date(Date.parse(iso) - 1000).toISOString()}`,
        ),
    });
    expect(result.verifyRes.status).toBe(401);
  });

  test("message for another domain", async () => {
    const h = createHarness();
    const wallet = await makeWallet();
    const result = await signIn(h, wallet, { tweak: (f) => ({ ...f, domain: "evil.example" }) });
    expect(result.verifyRes.status).toBe(401);
  });

  test("unknown nonce", async () => {
    const h = createHarness();
    const wallet = await makeWallet();
    const result = await signIn(h, wallet, { tweak: (f) => ({ ...f, nonce: "A".repeat(22) }) });
    expect(result.verifyRes.status).toBe(401);
  });

  test("reused nonce", async () => {
    const h = createHarness();
    const wallet = await makeWallet();
    const first = await signIn(h, wallet);
    expect(first.verifyRes.status).toBe(200);
    const again = await post(h, "/auth/verify", { message: first.messageB64, signature: first.signatureB64 });
    expect(again.status).toBe(401);
  });

  test("expired nonce (clock moves past 5 minutes)", async () => {
    const h = createHarness();
    const wallet = await makeWallet();
    const result = await signIn(h, wallet, {
      tweak: (f) => {
        h.advance(5 * 60_000 + 1000);
        return f;
      },
    });
    expect(result.verifyRes.status).toBe(401);
  });

  test("a failed attempt still consumes the nonce (Req 45.6)", async () => {
    const h = createHarness();
    const wallet = await makeWallet();
    const other = await makeWallet();
    const bad = await signIn(h, wallet, { signer: other });
    expect(bad.verifyRes.status).toBe(401);
    const good = await signWith(h, wallet, bad.fields.nonce);
    expect(good.status).toBe(401);
  });
});

/** Sends a correctly signed message for an already used nonce. */
async function signWith(h: ReturnType<typeof createHarness>, wallet: Awaited<ReturnType<typeof makeWallet>>, nonce: string) {
  const first = await signIn(h, wallet, { tweak: (f) => ({ ...f, nonce }) });
  return first.verifyRes;
}

describe("429 cases (Req 45.15)", () => {
  test("nonce: 11th request in a minute is 429 with Retry-After, per IP, and recovers", async () => {
    const h = createHarness();
    const wallet = await makeWallet();
    for (let i = 0; i < 10; i++) {
      const res = await post(h, "/auth/nonce", { address: wallet.address }, { ip: "1.1.1.1" });
      expect(res.status).toBe(200);
    }
    const limited = await post(h, "/auth/nonce", { address: wallet.address }, { ip: "1.1.1.1" });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(limited.headers.get("cache-control")).toBe("no-store");

    const other = await post(h, "/auth/nonce", { address: wallet.address }, { ip: "2.2.2.2" });
    expect(other.status).toBe(200);

    h.advance(60_000);
    const later = await post(h, "/auth/nonce", { address: wallet.address }, { ip: "1.1.1.1" });
    expect(later.status).toBe(200);
  });

  test("verify has its own bucket", async () => {
    const h = createHarness();
    for (let i = 0; i < 10; i++) {
      const res = await post(h, "/auth/verify", { message: "@@@@", signature: "AAAA" }, { ip: "3.3.3.3" });
      expect(res.status).toBe(400);
    }
    const limited = await post(h, "/auth/verify", { message: "@@@@", signature: "AAAA" }, { ip: "3.3.3.3" });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
  });
});

describe("POST /auth/logout (Req 45.14)", () => {
  test("logout answers 204, denylists the token, and calls onLogout", async () => {
    const h = createHarness();
    const wallet = await makeWallet();
    const { token } = await session(h, wallet);
    const verified = await h.tokens.verify(token);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;

    const res = await post(h, "/auth/logout", undefined, { bearer: token, contentType: null });
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(h.logouts).toEqual([{ jti: verified.claims.jti, address: wallet.address }]);

    const after = await h.tokens.verify(token);
    expect(after).toEqual({ ok: false, reason: "denied" });

    const again = await post(h, "/auth/logout", undefined, { bearer: token, contentType: null });
    expect(again.status).toBe(401);
    const confirm = await post(h, "/auth/pair/confirm", { code: "ABCDEFGH" }, { bearer: token });
    expect(confirm.status).toBe(401);
    expect(h.logouts).toHaveLength(1);
  });

  test("logout without a token, or with a bad one, is 401", async () => {
    const h = createHarness();
    expect((await post(h, "/auth/logout", undefined, { contentType: null })).status).toBe(401);
    expect((await post(h, "/auth/logout", undefined, { bearer: "v1.garbage.garbage", contentType: null })).status).toBe(401);
    expect(h.logouts).toHaveLength(0);
  });

  test("a token signed in again after logout is a different, valid token", async () => {
    const h = createHarness();
    const wallet = await makeWallet();
    const first = await session(h, wallet);
    await post(h, "/auth/logout", undefined, { bearer: first.token, contentType: null });
    const second = await session(h, wallet);
    expect(second.token).not.toBe(first.token);
    expect((await h.tokens.verify(second.token)).ok).toBe(true);
  });
});

describe("http app integration", () => {
  const engine = { running: false, sessionId: null } as const;

  test("/health carries no Cache-Control: no-store", async () => {
    const h = createHarness();
    const app = createHttpApp({ engine, auth: h.app, allowedOrigins: [ORIGIN] });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).not.toBe("no-store");
  });

  test("CORS preflight: allowed origin gets the allowed headers", async () => {
    const h = createHarness();
    const app = createHttpApp({ engine, auth: h.app, allowedOrigins: [ORIGIN] });
    const res = await app.request("/auth/nonce", {
      method: "OPTIONS",
      headers: {
        origin: ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect((res.headers.get("access-control-allow-headers") ?? "").toLowerCase()).toContain("authorization");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  test("CORS preflight: disallowed origin gets no Access-Control-Allow-Origin", async () => {
    const h = createHarness();
    const app = createHttpApp({ engine, auth: h.app, allowedOrigins: [ORIGIN] });
    const res = await app.request("/auth/nonce", {
      method: "OPTIONS",
      headers: { origin: EVIL, "access-control-request-method": "POST" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
