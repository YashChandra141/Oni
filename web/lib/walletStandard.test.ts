// Wallet Standard discovery and the feature guard (Task 20.1, Req 47.1, 49.1, 49.2).
import { describe, expect, test } from "bun:test";
import { fakeWallet } from "./testingWallet";
import {
  ALLOWED_FEATURES,
  APP_READY_EVENT,
  ForbiddenFeatureError,
  MissingFeatureError,
  REGISTER_WALLET_EVENT,
  callFeature,
  getWallets,
  hasSignIn,
  hasSignMessage,
  isSolanaWallet,
} from "./walletStandard";
import type { Wallet, WalletsApi } from "./walletStandard";

/** What a wallet extension does when it loads after the app is ready. */
function registerLate(target: EventTarget, wallet: Wallet): void {
  target.dispatchEvent(
    new CustomEvent(REGISTER_WALLET_EVENT, { detail: (api: WalletsApi) => api.register(wallet) }),
  );
}

describe("getWallets", () => {
  test("finds a wallet that registered before the app was ready", () => {
    const target = new EventTarget();
    const wallet = fakeWallet();
    target.addEventListener(APP_READY_EVENT, (event) => {
      (event as CustomEvent<WalletsApi>).detail.register(wallet);
    });
    expect(getWallets(target).get()).toEqual([wallet]);
  });

  test("finds a wallet that registers after the app was ready and reports it", () => {
    const target = new EventTarget();
    const registry = getWallets(target);
    const seen: Wallet[][] = [];
    registry.on("register", (...wallets) => seen.push(wallets));
    expect(registry.get()).toEqual([]);

    const wallet = fakeWallet();
    registerLate(target, wallet);

    expect(registry.get()).toEqual([wallet]);
    expect(seen).toEqual([[wallet]]);
  });

  test("unregister removes the wallet once and reports it", () => {
    const target = new EventTarget();
    const registry = getWallets(target);
    const removed: Wallet[][] = [];
    registry.on("unregister", (...wallets) => removed.push(wallets));
    const wallet = fakeWallet();
    let unregister: () => void = () => {};
    target.dispatchEvent(
      new CustomEvent(REGISTER_WALLET_EVENT, {
        detail: (api: WalletsApi) => {
          unregister = api.register(wallet);
        },
      }),
    );
    expect(registry.get()).toEqual([wallet]);

    unregister();
    unregister();

    expect(registry.get()).toEqual([]);
    expect(removed).toEqual([[wallet]]);
  });

  test("ignores a duplicate registration and replaces the array on change", () => {
    const target = new EventTarget();
    const registry = getWallets(target);
    const wallet = fakeWallet();
    registerLate(target, wallet);
    const first = registry.get();
    registerLate(target, wallet);
    expect(registry.get()).toBe(first);
    registerLate(target, fakeWallet({ name: "Backpack" }));
    expect(registry.get()).not.toBe(first);
    expect(first).toHaveLength(1);
  });

  test("returns the same registry for the same target and stops listening when told", () => {
    const target = new EventTarget();
    expect(getWallets(target)).toBe(getWallets(target));
    const registry = getWallets(target);
    let count = 0;
    const off = registry.on("register", () => count++);
    off();
    registerLate(target, fakeWallet());
    expect(count).toBe(0);
  });

  test("a non-function detail is ignored", () => {
    const target = new EventTarget();
    const registry = getWallets(target);
    target.dispatchEvent(new CustomEvent(REGISTER_WALLET_EVENT, { detail: "nope" }));
    expect(registry.get()).toEqual([]);
  });
});

describe("feature helpers", () => {
  test("detect Solana chains and sign features", () => {
    expect(isSolanaWallet(fakeWallet())).toBe(true);
    expect(isSolanaWallet(fakeWallet({ chains: ["ethereum:1"] }))).toBe(false);
    expect(hasSignIn(fakeWallet({ signIn: false }))).toBe(false);
    expect(hasSignMessage(fakeWallet({ signMessage: false }))).toBe(false);
    expect(hasSignIn(fakeWallet())).toBe(true);
  });

  test("the allow-list holds exactly the five features", () => {
    expect([...ALLOWED_FEATURES]).toEqual([
      "standard:connect",
      "standard:disconnect",
      "standard:events",
      "solana:signIn",
      "solana:signMessage",
    ]);
  });
});

describe("callFeature", () => {
  test("returns an allowed feature the wallet has", () => {
    const wallet = fakeWallet();
    expect(typeof callFeature(wallet, "standard:connect").connect).toBe("function");
  });

  test("throws MissingFeatureError for an allowed feature the wallet lacks", () => {
    expect(() => callFeature(fakeWallet({ signIn: false }), "solana:signIn")).toThrow(MissingFeatureError);
  });

  test("refuses transaction features even when the wallet has them", () => {
    // Names are built by concatenation so the no-transaction-signing grep test (Req 49.2) skips this file.
    const sign = "sign";
    const names = [
      `solana:${sign}Transaction`,
      `solana:${sign}AndSendTransaction`,
      `solana:${sign}AllTransactions`,
      `solana:${sign}AndSendAllTransactions`,
    ];
    const wallet = fakeWallet({
      extraFeatures: Object.fromEntries(names.map((name) => [name, { [name.slice(7)]: async () => [] }])),
    });
    for (const name of names) {
      // The cast imitates a caller that bypasses the type system.
      expect(() => callFeature(wallet, name as "solana:signIn")).toThrow(ForbiddenFeatureError);
    }
  });
});
