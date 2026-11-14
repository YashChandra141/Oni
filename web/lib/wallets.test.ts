// Wallet filtering and the live list (Task 20.1, Req 47.1, 47.2).
import { describe, expect, test } from "bun:test";
import { fakeWallet } from "./testingWallet";
import { REGISTER_WALLET_EVENT, getWallets } from "./walletStandard";
import type { Wallet, WalletsApi } from "./walletStandard";
import { createWalletList, filterSupportedWallets, isSupportedWallet } from "./wallets";

describe("isSupportedWallet", () => {
  test("accepts Phantom and Backpack in any case", () => {
    expect(isSupportedWallet(fakeWallet({ name: "Phantom" }))).toBe(true);
    expect(isSupportedWallet(fakeWallet({ name: "backpack" }))).toBe(true);
    expect(isSupportedWallet(fakeWallet({ name: "PHANTOM" }))).toBe(true);
  });

  test("rejects other names", () => {
    expect(isSupportedWallet(fakeWallet({ name: "Solflare" }))).toBe(false);
    expect(isSupportedWallet(fakeWallet({ name: "Phantom Fake" }))).toBe(false);
  });

  test("requires connect and signIn or signMessage", () => {
    expect(isSupportedWallet(fakeWallet({ connect: false }))).toBe(false);
    expect(isSupportedWallet(fakeWallet({ signIn: false }))).toBe(true);
    expect(isSupportedWallet(fakeWallet({ signMessage: false }))).toBe(true);
    expect(isSupportedWallet(fakeWallet({ signIn: false, signMessage: false }))).toBe(false);
  });

  test("requires a Solana chain", () => {
    expect(isSupportedWallet(fakeWallet({ chains: ["ethereum:1"] }))).toBe(false);
  });

  test("filterSupportedWallets keeps order", () => {
    const a = fakeWallet({ name: "Backpack" });
    const b = fakeWallet({ name: "Other" });
    const c = fakeWallet({ name: "Phantom" });
    expect(filterSupportedWallets([a, b, c])).toEqual([a, c]);
  });
});

describe("createWalletList", () => {
  function setup() {
    const target = new EventTarget();
    const list = createWalletList(getWallets(target));
    const register = (wallet: Wallet): (() => void) => {
      let off: () => void = () => {};
      target.dispatchEvent(
        new CustomEvent(REGISTER_WALLET_EVENT, {
          detail: (api: WalletsApi) => {
            off = api.register(wallet);
          },
        }),
      );
      return off;
    };
    return { list, register };
  }

  test("tracks register and unregister and notifies subscribers", () => {
    const { list, register } = setup();
    let notified = 0;
    const off = list.subscribe(() => notified++);
    expect(list.getSnapshot()).toEqual([]);

    const phantom = fakeWallet({ name: "Phantom" });
    const unregister = register(phantom);
    expect(list.getSnapshot()).toEqual([phantom]);
    expect(notified).toBe(1);

    unregister();
    expect(list.getSnapshot()).toEqual([]);
    expect(notified).toBe(2);

    off();
    register(fakeWallet({ name: "Backpack" }));
    expect(notified).toBe(2);
  });

  test("the snapshot is stable until the eligible set changes", () => {
    const { list, register } = setup();
    register(fakeWallet({ name: "Phantom" }));
    const first = list.getSnapshot();
    expect(list.getSnapshot()).toBe(first);
    register(fakeWallet({ name: "Unsupported" }));
    expect(list.getSnapshot()).toBe(first);
    register(fakeWallet({ name: "Backpack" }));
    expect(list.getSnapshot()).not.toBe(first);
    expect(list.getSnapshot()).toHaveLength(2);
  });

  test("the server snapshot is empty", () => {
    expect(setup().list.getServerSnapshot()).toEqual([]);
  });
});
