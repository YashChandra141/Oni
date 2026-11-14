// The wallets the sign-in menu offers (Req 47.1, 47.2): Phantom and Backpack, found through the
// Wallet Standard registry, kept live as wallets register and unregister.
//
// `createWalletList` is useSyncExternalStore-friendly: `getSnapshot` returns the same array until
// the set of eligible wallets changes, and `subscribe` returns its own unsubscribe.

import { getWallets, hasConnect, hasSignIn, hasSignMessage, isSolanaWallet } from "./walletStandard";
import type { Wallet, WalletsRegistry } from "./walletStandard";

/** Lower-case names of the supported wallets. */
export const SUPPORTED_WALLET_NAMES: readonly string[] = ["phantom", "backpack"];

/**
 * A wallet is offered when its name is Phantom or Backpack (case-insensitive), it lists a Solana
 * chain, supports `standard:connect`, and supports `solana:signIn` or `solana:signMessage`.
 */
export function isSupportedWallet(wallet: Wallet): boolean {
  if (typeof wallet.name !== "string") return false;
  if (!SUPPORTED_WALLET_NAMES.includes(wallet.name.trim().toLowerCase())) return false;
  if (!isSolanaWallet(wallet)) return false;
  if (!hasConnect(wallet)) return false;
  return hasSignIn(wallet) || hasSignMessage(wallet);
}

export function filterSupportedWallets(wallets: readonly Wallet[]): Wallet[] {
  return wallets.filter(isSupportedWallet);
}

export interface WalletList {
  getSnapshot(): readonly Wallet[];
  /** Server-side snapshot: always empty. */
  getServerSnapshot(): readonly Wallet[];
  subscribe(onChange: () => void): () => void;
}

const NO_WALLETS: readonly Wallet[] = [];

export function createWalletList(registry: WalletsRegistry): WalletList {
  let source: readonly Wallet[] | null = null;
  let snapshot: readonly Wallet[] = NO_WALLETS;

  return {
    getSnapshot() {
      const current = registry.get();
      if (current !== source) {
        source = current;
        const next = filterSupportedWallets(current);
        // Keep the old array when the eligible set did not change.
        const same = next.length === snapshot.length && next.every((wallet, index) => wallet === snapshot[index]);
        if (!same) snapshot = next;
      }
      return snapshot;
    },
    getServerSnapshot() {
      return NO_WALLETS;
    },
    subscribe(onChange) {
      const offRegister = registry.on("register", onChange);
      const offUnregister = registry.on("unregister", onChange);
      return () => {
        offRegister();
        offUnregister();
      };
    },
  };
}

let browserList: WalletList | null = null;

/** The wallet list for the browser's `window`. Created on first use, never at module load. */
export function browserWalletList(): WalletList {
  if (typeof window === "undefined") return createWalletList(getWallets()); // SSR: empty, not cached
  browserList ??= createWalletList(getWallets());
  return browserList;
}
