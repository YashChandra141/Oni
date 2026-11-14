// Route tests for TUI pairing and log privacy (Task 18.7).
// Validates: Requirements 16.4, 45.7, 45.15, 48.6, 48.8, 48.9

import { describe, expect, test } from "bun:test";
import { ORIGIN, SESSION_SECRET, createHarness, json, makeWallet, makePairingSecret, post, session, signIn } from "./routes.testing.ts";
import type { Harness } from "./routes.testing.ts";

/** Starts a pairing and returns its code and secret. */
async function startPairing(h: Harness, ip?: string): Promise<{ code: string; secret: string; verifier: string }> {
  const pairingSecret = await makePairingSecret();
  const res = await post(h, "/auth/pair", { verifier: pairingSecret.verifier }, ip === undefined ? {} : { ip });
  expect(res.status).toBe(200);
  const body = await json(res);
  return { code: body["code"] as string, secret: pairingSecret.secret, verifier: pairingSecret.verifier };
}

/** Polls after waiting out the per-code limit of 1 per 2 seconds. */
async function poll(h: Harness, code: string, secret: string): Promise<Response> {
  h.advance(2100);
  return post(h, "/auth/pair/poll", { code, secret });
}

describe("POST /auth/pair", () => {
  test("returns a code, pair_url, expires_in, and interval", async () => {
    const h = createHarness();
    const pairingSecret = await makePairingSecret();
    const res = await post(h, "/auth/pair", { verifier: pairingSecret.verifier });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await json(res);
    expect(body["code"]).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    expect(body["pair_url"]).toBe(`${ORIGIN}/pair?code=${body["code"] as string}`);
    expect(body["expires_in"]).toBe(300);
    expect(body["interval"]).toBe(2);
  });

  test("rejects a missing or malformed verifier with 400", async () => {
    const h = createHarness();
    expect((await post(h, "/auth/pair", {})).status).toBe(400);
    expect((await post(h, "/auth/pair", "{nope")).status).toBe(400);
    expect((await post(h, "/auth/pair", { verifier: "short" })).status).toBe(400);
    expect((await post(h, "/auth/pair", { verifier: "!!!!" })).status).toBe(400);
  });

  test("the 6th request in a minute from one IP is 429; another IP is unaffected (Req 48.9)", async () => {
    const h = createHarness();
    for (let i = 0; i < 5; i++) await startPairing(h, "7.7.7.7");
    const pairingSecret = await makePairingSecret();
    const limited = await post(h, "/auth/pair", { verifier: pairingSecret.verifier }, { ip: "7.7.7.7" });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    const other = await post(h, "/auth/pair", { verifier: pairingSecret.verifier }, { ip: "8.8.8.8" });
    expect(other.status).toBe(200);
    h.advance(60_000);
    const later = await post(h, "/auth/pair", { verifier: pairingSecret.verifier }, { ip: "7.7.7.7" });
    expect(later.status).toBe(200);
  });
});

describe("pair, confirm, poll (Req 48)", () => {
  test("pending, then confirmed: one token once, then 404", async () => {
    const h = createHarness();
    const wallet = await makeWallet();
    const { code, secret } = await startPairing(h);

    const pending = await poll(h, code, secret);
    expect(pending.status).toBe(200);
    expect(await json(pending)).toEqual({ status: "pending" });

    const web = await session(h, wallet);
    const confirm = await post(h, "/auth/pair/confirm", { code }, { bearer: web.token });
    expect(confirm.status).toBe(204);
    expect(confirm.headers.get("cache-control")).toBe("no-store");

    const ok = await poll(h, code, secret);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    const body = await json(ok);
    expect(body["status"]).toBe("ok");
    expect(body["account_id"]).toBe(`w_${wallet.address}`);
    expect(body["address"]).toBe(wallet.address);
    const verified = await h.tokens.verify(body["token"] as string);
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(body["exp"]).toBe(verified.claims.exp);

    const second = await poll(h, code, secret);
    expect(second.status).toBe(404);
  });

  test("confirm accepts a lower-case code with a hyphen", async () => {
    const h = createHarness();
    const wallet = await makeWallet();
    const { code } = await startPairing(h);
    const web = await session(h, wallet);
    const typed = `${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase();
    const res = await post(h, "/auth/pair/confirm", { code: typed }, { bearer: web.token });
    expect(res.status).toBe(204);
  });

  test("a wrong secret answers 404 and does not consume the confirmed pairing", async () => {
    const h = createHarness();
    const wallet = await makeWallet();
    const { code, secret } = await startPairing(h);
    const web = await session(h, wallet);
    expect((await post(h, "/auth/pair/confirm", { code }, { bearer: web.token })).status).toBe(204);

    const wrong = await makePairingSecret();
    const bad = await poll(h, code, wrong.secret);
    expect(bad.status).toBe(404);
    const malformed = await poll(h, code, "!!!not-base64url!!!");
    expect(malformed.status).toBe(404);

    const good = await poll(h, code, secret);
    expect(good.status).toBe(200);
    expect((await json(good))["status"]).toBe("ok");
  });

  test("confirm without a Bearer token is 401", async () => {
    const h = createHarness();
    const { code } = await startPairing(h);
    expect((await post(h, "/auth/pair/confirm", { code })).status).toBe(401);
    expect((await post(h, "/auth/pair/confirm", { code }, { bearer: "v1.bad.bad" })).status).toBe(401);
  });

  test("confirm of an unknown code is 404", async () => {
    const h = createHarness();
    const wallet = await makeWallet();
    const web = await session(h, wallet);
    const res = await post(h, "/auth/pair/confirm", { code: "ABCDEFGH" }, { bearer: web.token });
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: "not_found" });
  });

  test("confirm of a code already confirmed by another address is 404", async () => {
    const h = createHarness();
    const a = await session(h, await makeWallet());
    const b = await session(h, await makeWallet());
    const { code } = await startPairing(h);
    expect((await post(h, "/auth/pair/confirm", { code }, { bearer: a.token })).status).toBe(204);
    expect((await post(h, "/auth/pair/confirm", { code }, { bearer: b.token })).status).toBe(404);
  });

  test("confirm with a bad body is 400", async () => {
    const h = createHarness();
    const web = await session(h, await makeWallet());
    expect((await post(h, "/auth/pair/confirm", {}, { bearer: web.token })).status).toBe(400);
  });

  test("poll of an unknown code is 404", async () => {
    const h = createHarness();
    const pairingSecret = await makePairingSecret();
    const res = await poll(h, "ABCDEFGH", pairingSecret.secret);
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: "not_found" });
  });

  test("poll and confirm after the 5-minute expiry are 404", async () => {
    const h = createHarness();
    const web = await session(h, await makeWallet());
    const { code, secret } = await startPairing(h);
    h.advance(5 * 60_000 + 1000);
    expect((await post(h, "/auth/pair/poll", { code, secret })).status).toBe(404);
    expect((await post(h, "/auth/pair/confirm", { code }, { bearer: web.token })).status).toBe(404);
  });

  test("poll with a bad body is 400", async () => {
    const h = createHarness();
    expect((await post(h, "/auth/pair/poll", { code: "ABCDEFGH" })).status).toBe(400);
  });

  test("per-code poll limit: a second poll within 2 s is 429, then it recovers (Req 48.9)", async () => {
    const h = createHarness();
    const { code, secret } = await startPairing(h);
    h.advance(2100);
    const first = await post(h, "/auth/pair/poll", { code, secret });
    expect(first.status).toBe(200);
    const second = await post(h, "/auth/pair/poll", { code, secret });
    expect(second.status).toBe(429);
    expect(Number(second.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    h.advance(2100);
    const third = await post(h, "/auth/pair/poll", { code, secret });
    expect(third.status).toBe(200);
  });
});

describe("logs hold no secrets (Req 16.4)", () => {
  test("a full sign-in, pairing, and logout flow logs outcome codes only", async () => {
    const h = createHarness();
    const wallet = await makeWallet();
    const result = await signIn(h, wallet);
    expect(result.verifyRes.status).toBe(200);
    const web = (await json(result.verifyRes)) as { token: string };

    const { code, secret, verifier } = await startPairing(h);
    await poll(h, code, secret);
    expect((await post(h, "/auth/pair/confirm", { code }, { bearer: web.token })).status).toBe(204);
    const paired = await json(await poll(h, code, secret));
    const pairedToken = paired["token"] as string;
    expect(typeof pairedToken).toBe("string");

    // Some failures, so error paths are logged too.
    await post(h, "/auth/nonce", { address: wallet.address }, { origin: "https://evil.example" });
    await post(h, "/auth/verify", { message: result.messageB64, signature: result.signatureB64 });
    await poll(h, code, secret);
    for (let i = 0; i < 11; i++) await post(h, "/auth/logout", undefined, { ip: "9.9.9.9", contentType: null });
    expect((await post(h, "/auth/logout", undefined, { bearer: web.token, contentType: null })).status).toBe(204);

    const log = h.logs.join("\n");
    const forbidden = [
      web.token,
      pairedToken,
      SESSION_SECRET,
      result.fields.nonce,
      result.signatureB64,
      result.messageB64,
      result.text,
      secret,
      verifier,
      code,
      `Bearer ${web.token}`,
      "authorization",
    ];
    for (const secretText of forbidden) expect(log.includes(secretText)).toBe(false);

    expect(log).toContain("/auth/verify 200 ok");
    expect(log).toContain(`account=w_${wallet.address}`);
    expect(log).toContain("jti=");
    expect(log).toContain("origin_denied");
    expect(log).toContain("rate_limited");
    expect(log).toContain("/auth/pair/poll 404 not_found");
    expect(log).toContain("/auth/logout 204 ok");
  });
});
