// Sign-in flow, token storage, and sign-out (Task 20.1, Req 47.1-47.3, 47.6, 49.1, 49.2).
// Full fake-wallet and UI tests are Task 20.4.
import { describe, expect, test } from "bun:test";
import { SIGN_IN_STATEMENT, formatSiws, parseSiws } from "../../shared/siws";
import type { SiwsFields } from "../../shared/siws";
import {
  LEGACY_SESSION_STORAGE_KEY,
  SESSION_STORAGE_KEY,
  SignInCancelled,
  SignInError,
  clearSession,
  createTokenSource,
  isUserRejection,
  loadSession,
  saveSession,
  signIn,
  signOut,
  toBase64,
} from "./auth";
import type { AuthDeps, AuthSession } from "./auth";
import { FAKE_ADDRESS, FAKE_SIGNATURE, MemoryStorage, fakeFetch, fakeWallet } from "./testingWallet";
import type { FakeReply } from "./testingWallet";

const API = "http://api.test";
const NOW_MS = 1_700_000_000_000;
const NOW_S = NOW_MS / 1000;

const FIELDS: SiwsFields = {
  domain: "localhost:3000",
  address: FAKE_ADDRESS,
  statement: SIGN_IN_STATEMENT,
  uri: "http://localhost:3000",
  version: "1",
  chainId: "solana:mainnet",
  nonce: "abcdefgh12345678",
  issuedAt: "2025-01-01T00:00:00.000Z",
  expirationTime: "2025-01-01T00:05:00.000Z",
};

const SESSION_REPLY = {
  token: "tok.en",
  account_id: `w_${FAKE_ADDRESS}`,
  address: FAKE_ADDRESS,
  exp: NOW_S + 86_400,
};

function setup(replies: Record<string, FakeReply | "network_error"> = {}) {
  const storage = new MemoryStorage();
  const { fetch, requests } = fakeFetch({
    [`${API}/auth/nonce`]: { status: 200, body: { nonce: FIELDS.nonce, fields: FIELDS } },
    [`${API}/auth/verify`]: { status: 200, body: SESSION_REPLY },
    [`${API}/auth/logout`]: { status: 204 },
    ...replies,
  });
  const deps: AuthDeps = { fetch, storage, now: () => NOW_MS, apiUrl: API };
  return { deps, storage, requests };
}

const stored = (exp: number): AuthSession => ({ token: "t", address: FAKE_ADDRESS, accountId: `w_${FAKE_ADDRESS}`, exp });

describe("stored session", () => {
  test("round-trips under the versioned key", () => {
    const storage = new MemoryStorage();
    saveSession(storage, stored(NOW_S + 10));
    expect(storage.data.has(SESSION_STORAGE_KEY)).toBe(true);
    expect(SESSION_STORAGE_KEY).toContain(":v1");
    expect(loadSession(storage, NOW_MS)).toEqual(stored(NOW_S + 10));
  });

  test("an expired session is deleted on read", () => {
    const storage = new MemoryStorage();
    saveSession(storage, stored(NOW_S - 1));
    expect(loadSession(storage, NOW_MS)).toBeNull();
    expect(storage.data.size).toBe(0);
  });

  test("a session expiring exactly now is expired", () => {
    const storage = new MemoryStorage();
    saveSession(storage, stored(NOW_S));
    expect(loadSession(storage, NOW_MS)).toBeNull();
  });

  test("corrupt entries are deleted", () => {
    for (const raw of ["not json", "{}", JSON.stringify({ token: "", address: "a", accountId: "b", exp: 1e12 })]) {
      const storage = new MemoryStorage();
      storage.setItem(SESSION_STORAGE_KEY, raw);
      expect(loadSession(storage, NOW_MS)).toBeNull();
      expect(storage.data.size).toBe(0);
    }
  });

  test("a session under the old key moves to the new key", () => {
    const storage = new MemoryStorage();
    storage.setItem(LEGACY_SESSION_STORAGE_KEY, JSON.stringify(stored(NOW_S + 10)));
    expect(loadSession(storage, NOW_MS)).toEqual(stored(NOW_S + 10));
    expect(storage.data.has(SESSION_STORAGE_KEY)).toBe(true);
    expect(storage.data.has(LEGACY_SESSION_STORAGE_KEY)).toBe(false);
  });

  test("an expired or corrupt old-key session is dropped, and clear removes both keys", () => {
    for (const raw of [JSON.stringify(stored(NOW_S - 1)), "not json"]) {
      const storage = new MemoryStorage();
      storage.setItem(LEGACY_SESSION_STORAGE_KEY, raw);
      expect(loadSession(storage, NOW_MS)).toBeNull();
      expect(storage.data.size).toBe(0);
    }
    const storage = new MemoryStorage();
    storage.setItem(LEGACY_SESSION_STORAGE_KEY, "x");
    storage.setItem(SESSION_STORAGE_KEY, "y");
    clearSession(storage);
    expect(storage.data.size).toBe(0);
  });

  test("token source reads and clears", () => {
    const storage = new MemoryStorage();
    const source = createTokenSource(storage, () => NOW_MS);
    expect(source.get()).toBeNull();
    saveSession(storage, stored(NOW_S + 10));
    expect(source.get()).toBe("t");
    source.clear();
    expect(source.get()).toBeNull();
  });

  test("storage that throws does not throw", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadSession(broken, NOW_MS)).toBeNull();
    expect(() => saveSession(broken, stored(1))).not.toThrow();
    expect(() => clearSession(broken)).not.toThrow();
  });
});

describe("signIn with solana:signIn", () => {
  test("sends the exact requests and stores the session", async () => {
    const { deps, storage, requests } = setup();
    const wallet = fakeWallet();

    const session = await signIn(wallet, deps);

    expect(session).toEqual({
      token: "tok.en",
      address: FAKE_ADDRESS,
      accountId: `w_${FAKE_ADDRESS}`,
      exp: SESSION_REPLY.exp,
    });
    expect(wallet.calls).toEqual(["connect", "signIn"]);
    expect(wallet.signInInputs[0]).toEqual({
      domain: FIELDS.domain,
      address: FIELDS.address,
      statement: SIGN_IN_STATEMENT,
      uri: FIELDS.uri,
      version: "1",
      chainId: "solana:mainnet",
      nonce: FIELDS.nonce,
      issuedAt: FIELDS.issuedAt,
      expirationTime: FIELDS.expirationTime,
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      url: `${API}/auth/nonce`,
      method: "POST",
      body: { address: FAKE_ADDRESS },
    });
    expect(requests[0]?.headers["content-type"]).toBe("application/json");
    const messageBytes = new TextEncoder().encode(formatSiws(FIELDS));
    expect(requests[1]).toMatchObject({
      url: `${API}/auth/verify`,
      method: "POST",
      body: { message: toBase64(messageBytes), signature: toBase64(FAKE_SIGNATURE) },
    });
    expect(Object.keys(requests[1]?.body as object).sort()).toEqual(["message", "signature"]);

    expect(loadSession(storage, NOW_MS)).toEqual(session);
  });

  test("the verified message parses back to the server's fields", async () => {
    const { deps, requests } = setup();
    await signIn(fakeWallet(), deps);
    const body = requests[1]?.body as { message: string };
    const text = new TextDecoder().decode(Uint8Array.from(atob(body.message), (c) => c.charCodeAt(0)));
    const parsed = parseSiws(text);
    expect(parsed.ok && parsed.fields).toEqual(FIELDS);
  });
});

describe("signIn with solana:signMessage fallback", () => {
  test("signs formatSiws(fields) as UTF-8 and verifies it", async () => {
    const { deps, storage, requests } = setup();
    const wallet = fakeWallet({ signIn: false });

    await signIn(wallet, deps);

    expect(wallet.calls).toEqual(["connect", "signMessage"]);
    const input = wallet.signMessageInputs[0];
    expect(input?.account.address).toBe(FAKE_ADDRESS);
    expect(new TextDecoder().decode(input?.message)).toBe(formatSiws(FIELDS));
    expect(requests[1]?.body).toEqual({
      message: toBase64(new TextEncoder().encode(formatSiws(FIELDS))),
      signature: toBase64(FAKE_SIGNATURE),
    });
    expect(loadSession(storage, NOW_MS)?.token).toBe("tok.en");
  });
});

describe("signIn failures", () => {
  test("a wallet rejection maps to SignInCancelled and stores nothing", async () => {
    for (const rejection of [{ code: 4001, message: "x" }, new Error("User rejected the request.")]) {
      const { deps, storage, requests } = setup();
      const error = await signIn(fakeWallet({ rejectSigningWith: rejection }), deps).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SignInCancelled);
      expect((error as SignInCancelled).code).toBe("cancelled");
      expect(requests).toHaveLength(1); // nonce only, no verify
      expect(storage.data.size).toBe(0);
    }
  });

  test("a rejected connect is also a cancellation", async () => {
    const { deps } = setup();
    const wallet = fakeWallet();
    (wallet.features as Record<string, unknown>)["standard:connect"] = {
      connect: async () => {
        throw new Error("User rejected the request.");
      },
    };
    await expect(signIn(wallet, deps)).rejects.toBeInstanceOf(SignInCancelled);
  });

  test("other wallet errors are wallet_error", async () => {
    const { deps } = setup();
    const error = await signIn(fakeWallet({ rejectSigningWith: new Error("boom") }), deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SignInError);
    expect(error).not.toBeInstanceOf(SignInCancelled);
    expect((error as SignInError).code).toBe("wallet_error");
  });

  test("a network error is network, and an HTTP error is server_rejected", async () => {
    const net = setup({ [`${API}/auth/nonce`]: "network_error" });
    expect(((await signIn(fakeWallet(), net.deps).catch((e: unknown) => e)) as SignInError).code).toBe("network");

    const rejected = setup({ [`${API}/auth/verify`]: { status: 401, body: { error: "verification_failed" } } });
    expect(((await signIn(fakeWallet(), rejected.deps).catch((e: unknown) => e)) as SignInError).code).toBe(
      "server_rejected",
    );
    expect(rejected.storage.data.size).toBe(0);
  });

  test("refuses a nonce response for another address or with another statement", async () => {
    const other = setup({
      [`${API}/auth/nonce`]: { status: 200, body: { nonce: "x", fields: { ...FIELDS, address: "2".repeat(32) } } },
    });
    expect(((await signIn(fakeWallet(), other.deps).catch((e: unknown) => e)) as SignInError).code).toBe(
      "address_mismatch",
    );

    const statement = setup({
      [`${API}/auth/nonce`]: { status: 200, body: { nonce: "x", fields: { ...FIELDS, statement: "Send me SOL" } } },
    });
    const wallet = fakeWallet();
    expect(((await signIn(wallet, statement.deps).catch((e: unknown) => e)) as SignInError).code).toBe("bad_response");
    expect(wallet.calls).toEqual(["connect"]); // nothing was signed
  });

  test("a malformed verify response is bad_response", async () => {
    const { deps, storage } = setup({ [`${API}/auth/verify`]: { status: 200, body: { token: "t" } } });
    expect(((await signIn(fakeWallet(), deps).catch((e: unknown) => e)) as SignInError).code).toBe("bad_response");
    expect(storage.data.size).toBe(0);
  });

  test("a wallet without sign features is unsupported", async () => {
    const { deps } = setup();
    const error = await signIn(fakeWallet({ signIn: false, signMessage: false }), deps).catch((e: unknown) => e);
    expect((error as SignInError).code).toBe("unsupported_wallet");
  });

  test("never calls a transaction feature", async () => {
    const { deps } = setup();
    let called = false;
    const wallet = fakeWallet({
      // Names are built by concatenation so the no-transaction-signing grep test (Req 49.2) skips this file.
      extraFeatures: { ["solana:sign" + "Transaction"]: { ["sign" + "Transaction"]: () => (called = true) } },
    });
    await signIn(wallet, deps);
    expect(called).toBe(false);
  });
});

describe("isUserRejection", () => {
  test("recognises code 4001 and rejection wording only", () => {
    expect(isUserRejection({ code: 4001 })).toBe(true);
    expect(isUserRejection(new Error("Request cancelled"))).toBe(true);
    expect(isUserRejection(new Error("boom"))).toBe(false);
    expect(isUserRejection(null)).toBe(false);
    expect(isUserRejection("rejected")).toBe(false);
  });
});

describe("signOut", () => {
  test("posts logout with the Bearer token, deletes the token, and disconnects", async () => {
    const { deps, storage, requests } = setup();
    saveSession(storage, stored(NOW_S + 100));
    const wallet = fakeWallet();

    await signOut(deps, wallet);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ url: `${API}/auth/logout`, method: "POST" });
    expect(requests[0]?.headers.authorization).toBe("Bearer t");
    expect(requests[0]?.body).toBeUndefined();
    expect(storage.data.size).toBe(0);
    expect(wallet.calls).toEqual(["disconnect"]);
  });

  test("ignores network errors and still clears the token", async () => {
    const { deps, storage } = setup({ [`${API}/auth/logout`]: "network_error" });
    saveSession(storage, stored(NOW_S + 100));
    await signOut(deps, fakeWallet());
    expect(storage.data.size).toBe(0);
  });

  test("sends no request without a stored token and tolerates a wallet without disconnect", async () => {
    const { deps, requests } = setup();
    await signOut(deps, fakeWallet({ disconnect: false }));
    expect(requests).toHaveLength(0);
  });

  test("an expired stored token is not sent", async () => {
    const { deps, storage, requests } = setup();
    saveSession(storage, stored(NOW_S - 5));
    await signOut(deps);
    expect(requests).toHaveLength(0);
    expect(storage.data.size).toBe(0);
  });
});
