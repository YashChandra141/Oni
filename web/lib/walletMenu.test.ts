import { describe, expect, test } from "bun:test";
import { SignInCancelled, SignInError } from "./auth";
import type { AuthDeps, AuthSession, SignInErrorCode } from "./auth";
import type { SessionInfo } from "./store";
import { fakeWallet } from "./testingWallet";
import {
  NO_WALLET_MESSAGE,
  PENDING_MESSAGE,
  SIGN_IN_ERROR_TEXT,
  menuState,
  runSignIn,
  shortAddress,
} from "./walletMenu";

const ADDRESS = "AbCdEfGhJkLmNpQrStUvWxYz123456789abcdWxYz";
const guest: SessionInfo = { accountId: "guest", address: null } as SessionInfo;
const signedIn: SessionInfo = { accountId: `w_${ADDRESS}`, address: ADDRESS } as SessionInfo;

describe("shortAddress", () => {
  test("shortens long addresses to first 4 + … + last 4", () => {
    expect(shortAddress("AbCd1234567890WxYz")).toBe("AbCd…WxYz");
  });
  test("leaves addresses of 9 characters or fewer unchanged", () => {
    expect(shortAddress("abcdefghi")).toBe("abcdefghi");
    expect(shortAddress("abc")).toBe("abc");
  });
});

describe("menuState", () => {
  const phantom = fakeWallet({ name: "Phantom" });
  const backpack = fakeWallet({ name: "backpack" });

  test("guest with a button per wallet", () => {
    const view = menuState([phantom, backpack], guest, false, null);
    expect(view).toEqual({
      kind: "guest",
      buttons: [
        { walletIndex: 0, label: "Sign in with Phantom" },
        { walletIndex: 1, label: "Sign in with Backpack" },
      ],
      error: null,
    });
  });

  test("no wallets shows the guest message", () => {
    const view = menuState([], null, false, null);
    expect(view.kind).toBe("no_wallet");
    if (view.kind === "no_wallet") expect(view.message).toBe("No Phantom or Backpack wallet found. Trading as guest.");
    expect(NO_WALLET_MESSAGE).toBe("No Phantom or Backpack wallet found. Trading as guest.");
  });

  test("signed in shows the short address and Sign out", () => {
    const view = menuState([phantom], signedIn, false, null);
    expect(view).toEqual({
      kind: "signed_in",
      address: ADDRESS,
      shortAddress: "AbCd…WxYz",
      signOutLabel: "Sign out",
      error: null,
    });
  });

  test("pending wins over everything else", () => {
    const view = menuState([phantom], signedIn, true, "network");
    expect(view).toEqual({ kind: "pending", message: PENDING_MESSAGE, error: null });
    expect(PENDING_MESSAGE).toBe("Waiting for wallet…");
  });

  test("error text is attached to the guest and no-wallet views", () => {
    const guestView = menuState([phantom], guest, false, "cancelled");
    expect(guestView.error).toBe("Sign-in cancelled");
    expect(menuState([], guest, false, "network").error).toBe(SIGN_IN_ERROR_TEXT.network);
  });

  test("every error code has short text without raw server detail", () => {
    const codes: SignInErrorCode[] = [
      "cancelled",
      "no_account",
      "address_mismatch",
      "unsupported_wallet",
      "wallet_error",
      "network",
      "server_rejected",
      "bad_response",
    ];
    for (const code of codes) {
      const text = SIGN_IN_ERROR_TEXT[code];
      expect(text.length).toBeGreaterThan(0);
      expect(text.length).toBeLessThan(50);
      expect(text).not.toMatch(/HTTP|\d{3}/);
    }
  });
});

describe("runSignIn", () => {
  const deps = {} as AuthDeps;
  const wallet = fakeWallet({ name: "Phantom" });
  const session: AuthSession = { token: "t", address: ADDRESS, accountId: `w_${ADDRESS}`, exp: 1 };

  test("returns the session on success", async () => {
    expect(await runSignIn(wallet, deps, async () => session)).toEqual({ kind: "signed_in", session });
  });

  test("maps SignInCancelled to cancelled", async () => {
    const outcome = await runSignIn(wallet, deps, async () => {
      throw new SignInCancelled();
    });
    expect(outcome).toEqual({ kind: "error", code: "cancelled" });
  });

  test("keeps the code of other SignInErrors and never exposes the message", async () => {
    const outcome = await runSignIn(wallet, deps, async () => {
      throw new SignInError("server_rejected", "The server rejected /auth/verify (HTTP 401).");
    });
    expect(outcome).toEqual({ kind: "error", code: "server_rejected" });
  });

  test("maps unknown errors to wallet_error", async () => {
    const outcome = await runSignIn(wallet, deps, async () => {
      throw new Error("boom");
    });
    expect(outcome).toEqual({ kind: "error", code: "wallet_error" });
  });
});
