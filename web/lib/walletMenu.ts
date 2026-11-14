// Pure view model and sign-in action for the wallet menu (Req 47.4, 47.5, 47.7).
// No React and no DOM here, so everything is testable with plain values.

import { SignInError } from "./auth";
import type { AuthDeps, AuthSession, SignInErrorCode } from "./auth";
import { shortAddress } from "./status";
import type { SessionInfo } from "./store";
import type { Wallet } from "./walletStandard";

export { shortAddress };

export const NO_WALLET_MESSAGE = "No Phantom or Backpack wallet found. Trading as guest.";
export const PENDING_MESSAGE = "Waiting for wallet…";
export const SIGN_OUT_LABEL = "Sign out";

/** Short, fixed text per error code. The raw error message (which may echo server text) is never shown. */
export const SIGN_IN_ERROR_TEXT: Readonly<Record<SignInErrorCode, string>> = {
  cancelled: "Sign-in cancelled",
  no_account: "The wallet shared no account",
  address_mismatch: "The wallet account did not match",
  unsupported_wallet: "This wallet cannot sign in",
  wallet_error: "Wallet error, try again",
  network: "Could not reach the server",
  server_rejected: "Sign-in was rejected",
  bad_response: "Unexpected server response",
};

export function errorText(code: SignInErrorCode): string {
  return SIGN_IN_ERROR_TEXT[code];
}

/** Display name: `Phantom` or `Backpack` for the supported wallets, else the trimmed name. */
export function walletDisplayName(wallet: Pick<Wallet, "name">): string {
  const name = wallet.name.trim();
  const lower = name.toLowerCase();
  if (lower === "phantom") return "Phantom";
  if (lower === "backpack") return "Backpack";
  return name;
}

export interface SignInButton {
  /** Index into the `wallets` array given to `menuState`. */
  readonly walletIndex: number;
  readonly label: string;
}

export type MenuView =
  | {
      readonly kind: "pending";
      readonly message: string;
      readonly error: string | null;
    }
  | {
      readonly kind: "signed_in";
      readonly address: string;
      readonly shortAddress: string;
      readonly signOutLabel: string;
      readonly error: string | null;
    }
  | {
      readonly kind: "guest";
      readonly buttons: readonly SignInButton[];
      readonly error: string | null;
    }
  | {
      readonly kind: "no_wallet";
      readonly message: string;
      readonly error: string | null;
    };

/** True when the session belongs to a wallet account. */
export function isSignedIn(session: SessionInfo | null): session is SessionInfo & { readonly address: string } {
  return session !== null && session.accountId !== "guest" && typeof session.address === "string" && session.address !== "";
}

export function menuState(
  wallets: readonly Pick<Wallet, "name">[],
  session: SessionInfo | null,
  pending: boolean,
  error: SignInErrorCode | null,
): MenuView {
  const errorMessage = error === null ? null : errorText(error);
  if (pending) return { kind: "pending", message: PENDING_MESSAGE, error: null };
  if (isSignedIn(session)) {
    return {
      kind: "signed_in",
      address: session.address,
      shortAddress: shortAddress(session.address),
      signOutLabel: SIGN_OUT_LABEL,
      error: errorMessage,
    };
  }
  if (wallets.length === 0) return { kind: "no_wallet", message: NO_WALLET_MESSAGE, error: errorMessage };
  return {
    kind: "guest",
    buttons: wallets.map((wallet, walletIndex) => ({
      walletIndex,
      label: `Sign in with ${walletDisplayName(wallet)}`,
    })),
    error: errorMessage,
  };
}

export type SignInOutcome =
  | { readonly kind: "signed_in"; readonly session: AuthSession }
  | { readonly kind: "error"; readonly code: SignInErrorCode };

export type SignInFn = (wallet: Wallet, deps: AuthDeps) => Promise<AuthSession>;

/**
 * Runs a sign-in and turns the result into a value. Never throws: a `SignInError` keeps its code
 * (`SignInCancelled` has `cancelled`); any other error becomes `wallet_error`.
 */
export async function runSignIn(wallet: Wallet, deps: AuthDeps, signInFn: SignInFn): Promise<SignInOutcome> {
  try {
    const session = await signInFn(wallet, deps);
    return { kind: "signed_in", session };
  } catch (error) {
    if (error instanceof SignInError) return { kind: "error", code: error.code };
    return { kind: "error", code: "wallet_error" };
  }
}
