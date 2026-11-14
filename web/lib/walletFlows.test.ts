// Recording fake wallet across the sign-in, sign-out and pairing flows (Task 20.4,
// Req 47.2, 47.3, 47.4, 47.6, 49.1, 49.2). Only the allowed Wallet Standard features may be used.
import { describe, expect, test } from "bun:test";
import { SIGN_IN_STATEMENT } from "../../shared/siws";
import type { SiwsFields } from "../../shared/siws";
import { SignInCancelled, saveSession, signIn, signOut } from "./auth";
import type { AuthDeps } from "./auth";
import { confirmPairing } from "./pairing";
import type { PairDeps } from "./pairing";
import { CALL_TO_FEATURE, FAKE_ADDRESS, FORBIDDEN_FEATURE_NAMES, MemoryStorage, fakeFetch, recordingWallet } from "./testingWallet";
import type { FakeReply, RecordingWallet } from "./testingWallet";
import { ALLOWED_FEATURES } from "./walletStandard";

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

function setup(replies: Record<string, FakeReply | "network_error"> = {}) {
  const storage = new MemoryStorage();
  const { fetch, requests } = fakeFetch({
    [`${API}/auth/nonce`]: { status: 200, body: { nonce: FIELDS.nonce, fields: FIELDS } },
    [`${API}/auth/verify`]: {
      status: 200,
      body: { token: "tok.en", account_id: `w_${FAKE_ADDRESS}`, address: FAKE_ADDRESS, exp: NOW_S + 86_400 },
    },
    [`${API}/auth/logout`]: { status: 204 },
    ...replies,
  });
  const deps: AuthDeps = { fetch, storage, now: () => NOW_MS, apiUrl: API };
  return { deps, storage, requests };
}

/** The feature names whose methods the app called, from the wallet's own call log. */
function calledFeatures(wallet: RecordingWallet): string[] {
  return wallet.calls.map((call) => CALL_TO_FEATURE[call] ?? `unknown:${call}`);
}

function expectOnlyAllowed(wallet: RecordingWallet): void {
  const allowed: readonly string[] = ALLOWED_FEATURES;
  expect(wallet.forbiddenCalls).toEqual([]);
  for (const name of calledFeatures(wallet)) expect(allowed).toContain(name);
  for (const name of wallet.featuresAccessed) {
    expect(FORBIDDEN_FEATURE_NAMES).not.toContain(name);
    expect(allowed).toContain(name);
  }
}

describe("recording wallet: sign-in paths", () => {
  test("uses standard:connect then solana:signIn", async () => {
    const { deps } = setup();
    const wallet = recordingWallet();
    await signIn(wallet, deps);
    expect(calledFeatures(wallet)).toEqual(["standard:connect", "solana:signIn"]);
    expectOnlyAllowed(wallet);
  });

  test("falls back to solana:signMessage when the wallet has no solana:signIn", async () => {
    const { deps } = setup();
    const wallet = recordingWallet({ signIn: false });
    await signIn(wallet, deps);
    expect(calledFeatures(wallet)).toEqual(["standard:connect", "solana:signMessage"]);
    expectOnlyAllowed(wallet);
  });

  test("a rejection in solana:signIn is SignInCancelled and nothing else is tried", async () => {
    const { deps, storage } = setup();
    const wallet = recordingWallet({ rejectSigningWith: { code: 4001, message: "User rejected the request." } });
    await expect(signIn(wallet, deps)).rejects.toBeInstanceOf(SignInCancelled);
    expect(calledFeatures(wallet)).toEqual(["standard:connect", "solana:signIn"]);
    expect(storage.data.size).toBe(0);
    expectOnlyAllowed(wallet);
  });

  test("a rejection in the signMessage fallback is SignInCancelled", async () => {
    const { deps, storage } = setup();
    const wallet = recordingWallet({ signIn: false, rejectSigningWith: new Error("User rejected the request.") });
    await expect(signIn(wallet, deps)).rejects.toBeInstanceOf(SignInCancelled);
    expect(calledFeatures(wallet)).toEqual(["standard:connect", "solana:signMessage"]);
    expect(storage.data.size).toBe(0);
    expectOnlyAllowed(wallet);
  });

  test("a wallet with only transaction features is unsupported and nothing is called", async () => {
    const { deps } = setup();
    const wallet = recordingWallet({ signIn: false, signMessage: false });
    const error = await signIn(wallet, deps).catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe("unsupported_wallet");
    expect(wallet.calls).toEqual([]);
    expectOnlyAllowed(wallet);
  });
});

describe("recording wallet: all flows", () => {
  test("sign in, sign out and pairing confirm call only allowed features", async () => {
    const { deps, storage } = setup();
    const wallet = recordingWallet();

    const session = await signIn(wallet, deps);

    // Pairing confirm needs only the token; it never reaches the wallet.
    const pairRequests: string[] = [];
    const pairDeps: PairDeps = {
      apiUrl: API,
      token: session.token,
      fetch: async (url) => {
        pairRequests.push(url);
        return { status: 204 };
      },
    };
    const callsBeforePairing = wallet.calls.length;
    expect(await confirmPairing("ABCD2345", pairDeps)).toEqual({ ok: true });
    expect(pairRequests).toEqual([`${API}/auth/pair/confirm`]);
    expect(wallet.calls).toHaveLength(callsBeforePairing);

    await signOut(deps, wallet);
    expect(storage.data.size).toBe(0);

    expect(calledFeatures(wallet)).toEqual(["standard:connect", "solana:signIn", "standard:disconnect"]);
    expectOnlyAllowed(wallet);
  });

  test("the signMessage fallback flow, signed out again, stays within the allow-list", async () => {
    const { deps, storage } = setup();
    const wallet = recordingWallet({ signIn: false });
    await signIn(wallet, deps);
    await signOut(deps, wallet);
    expect(storage.data.size).toBe(0);
    expect(calledFeatures(wallet)).toEqual(["standard:connect", "solana:signMessage", "standard:disconnect"]);
    expectOnlyAllowed(wallet);
  });

  test("sign-out of a stored session with a wallet that lacks disconnect calls nothing on the wallet", async () => {
    const { deps, storage } = setup();
    saveSession(storage, { token: "t", address: FAKE_ADDRESS, accountId: `w_${FAKE_ADDRESS}`, exp: NOW_S + 100 });
    const wallet = recordingWallet({ disconnect: false });
    await signOut(deps, wallet);
    expect(wallet.calls).toEqual([]);
    expectOnlyAllowed(wallet);
  });

  test("the wallet exposes the forbidden features, so the guard is what keeps them unused", () => {
    const wallet = recordingWallet();
    for (const name of FORBIDDEN_FEATURE_NAMES) expect(Reflect.has(wallet.features, name)).toBe(true);
    // The probe above is a `has` check, not a property read, so nothing was recorded.
    expect(wallet.featuresAccessed).toEqual([]);
  });
});
