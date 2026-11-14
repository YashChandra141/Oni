// Wallet Standard, app side: wallet discovery and the minimal types this UI uses.
//
// Spec: https://github.com/wallet-standard/wallet-standard (docs/ and packages/core/app).
// These types and the discovery protocol are written by hand to avoid adding the
// `@wallet-standard/*` packages (design Decision A14 recorded the original plan to pin them).
// Only the pieces the sign-in flow needs are modelled.
//
// Discovery protocol (two window events, order independent):
//  1. The app dispatches `wallet-standard:app-ready` with `detail = { register(...wallets) }`.
//     Wallets that loaded earlier hear it and call `register`.
//  2. The app listens for `wallet-standard:register-wallet`. Its `detail` is a callback
//     `(api) => void` that the app must call with its own `{ register }` object. Wallets that load
//     later dispatch it.
// `register` returns the unregister function for the wallets it added.
//
// Safety (trading-safety rule 9): only the features in `ALLOWED_FEATURES` may be called, and
// every call goes through `callFeature`. No transaction feature is modelled at all.
//
// Nothing here touches `window` at module scope, so the module can load during SSR/static export.

/** The only Wallet Standard features the UI may call. */
export const ALLOWED_FEATURES = [
  "standard:connect",
  "standard:disconnect",
  "standard:events",
  "solana:signIn",
  "solana:signMessage",
] as const;

export type AllowedFeature = (typeof ALLOWED_FEATURES)[number];

export interface WalletAccount {
  /** Base58 for Solana accounts. */
  readonly address: string;
  readonly publicKey: Uint8Array;
  readonly chains: readonly string[];
  readonly features: readonly string[];
}

export interface Wallet {
  readonly version: string;
  readonly name: string;
  readonly icon: string;
  readonly chains: readonly string[];
  /** Feature objects keyed by feature name. Values are only used through `callFeature`. */
  readonly features: Readonly<Record<string, unknown>>;
  readonly accounts: readonly WalletAccount[];
}

export interface ConnectFeature {
  connect(input?: { readonly silent?: boolean }): Promise<{ readonly accounts: readonly WalletAccount[] }>;
}

export interface DisconnectFeature {
  disconnect(): Promise<void>;
}

export interface EventsChange {
  readonly accounts?: readonly WalletAccount[];
  readonly chains?: readonly string[];
  readonly features?: Readonly<Record<string, unknown>>;
}

export interface EventsFeature {
  on(event: "change", listener: (properties: EventsChange) => void): () => void;
}

/** Input of `solana:signIn`: the SIWS fields. */
export interface SolanaSignInInput {
  readonly domain?: string;
  readonly address?: string;
  readonly statement?: string;
  readonly uri?: string;
  readonly version?: string;
  readonly chainId?: string;
  readonly nonce?: string;
  readonly issuedAt?: string;
  readonly expirationTime?: string;
  readonly notBefore?: string;
  readonly requestId?: string;
  readonly resources?: readonly string[];
}

export interface SolanaSignInOutput {
  readonly account: WalletAccount;
  readonly signedMessage: Uint8Array;
  readonly signature: Uint8Array;
}

export interface SignInFeature {
  signIn(...inputs: SolanaSignInInput[]): Promise<readonly SolanaSignInOutput[]>;
}

export interface SolanaSignMessageInput {
  readonly account: WalletAccount;
  readonly message: Uint8Array;
}

export interface SolanaSignMessageOutput {
  readonly signedMessage: Uint8Array;
  readonly signature: Uint8Array;
}

export interface SignMessageFeature {
  signMessage(...inputs: SolanaSignMessageInput[]): Promise<readonly SolanaSignMessageOutput[]>;
}

export interface FeatureMap {
  "standard:connect": ConnectFeature;
  "standard:disconnect": DisconnectFeature;
  "standard:events": EventsFeature;
  "solana:signIn": SignInFeature;
  "solana:signMessage": SignMessageFeature;
}

/** Thrown for a feature name outside `ALLOWED_FEATURES`. */
export class ForbiddenFeatureError extends Error {
  override readonly name = "ForbiddenFeatureError";
}

/** Thrown when the wallet does not expose an allowed feature. */
export class MissingFeatureError extends Error {
  override readonly name = "MissingFeatureError";
}

function isAllowedFeature(name: string): name is AllowedFeature {
  return (ALLOWED_FEATURES as readonly string[]).includes(name);
}

/**
 * The single way the UI reaches a wallet feature. Throws `ForbiddenFeatureError` for any name
 * outside `ALLOWED_FEATURES` (for example any Solana transaction-signing feature), even when the wallet has it.
 */
export function callFeature<N extends AllowedFeature>(wallet: Wallet, name: N): FeatureMap[N] {
  if (!isAllowedFeature(name)) throw new ForbiddenFeatureError(`wallet feature not allowed: ${String(name)}`);
  const feature = wallet.features[name];
  if (typeof feature !== "object" || feature === null) {
    throw new MissingFeatureError(`wallet does not support ${name}`);
  }
  return feature as FeatureMap[N];
}

function hasFeature(wallet: Wallet, name: AllowedFeature): boolean {
  const feature = wallet.features[name];
  return typeof feature === "object" && feature !== null;
}

/** True when the wallet lists at least one Solana chain (`solana:mainnet`, `solana:devnet`, ...). */
export function isSolanaWallet(wallet: Wallet): boolean {
  return Array.isArray(wallet.chains) && wallet.chains.some((chain) => chain.startsWith("solana:"));
}

export function hasConnect(wallet: Wallet): boolean {
  return hasFeature(wallet, "standard:connect");
}

export function hasDisconnect(wallet: Wallet): boolean {
  return hasFeature(wallet, "standard:disconnect");
}

export function hasSignIn(wallet: Wallet): boolean {
  return hasFeature(wallet, "solana:signIn");
}

export function hasSignMessage(wallet: Wallet): boolean {
  return hasFeature(wallet, "solana:signMessage");
}

// ---------------------------------------------------------------------------------------------
// Discovery

export type RegisterWallets = (...wallets: Wallet[]) => () => void;

export interface WalletsApi {
  readonly register: RegisterWallets;
}

export type WalletsEvent = "register" | "unregister";

export interface WalletsRegistry {
  /** The registered wallets. The array is replaced (never mutated) whenever the set changes. */
  get(): readonly Wallet[];
  /** Listens for wallets being registered or unregistered. Returns the function that stops it. */
  on(event: WalletsEvent, listener: (...wallets: Wallet[]) => void): () => void;
}

export const APP_READY_EVENT = "wallet-standard:app-ready";
export const REGISTER_WALLET_EVENT = "wallet-standard:register-wallet";

const EMPTY_REGISTRY: WalletsRegistry = {
  get: () => [],
  on: () => () => {},
};

const registries = new WeakMap<EventTarget, WalletsRegistry>();

function createRegistry(target: EventTarget): WalletsRegistry {
  let wallets: readonly Wallet[] = [];
  const listeners: Record<WalletsEvent, Set<(...wallets: Wallet[]) => void>> = {
    register: new Set(),
    unregister: new Set(),
  };

  const emit = (event: WalletsEvent, changed: Wallet[]): void => {
    for (const listener of [...listeners[event]]) {
      try {
        listener(...changed);
      } catch {
        // A faulty listener must not break discovery.
      }
    }
  };

  const register: RegisterWallets = (...incoming) => {
    const fresh = incoming.filter((wallet, index) => !wallets.includes(wallet) && incoming.indexOf(wallet) === index);
    if (fresh.length === 0) return () => {};
    wallets = [...wallets, ...fresh];
    emit("register", fresh);
    return () => {
      const removed = fresh.filter((wallet) => wallets.includes(wallet));
      if (removed.length === 0) return;
      wallets = wallets.filter((wallet) => !removed.includes(wallet));
      emit("unregister", removed);
    };
  };

  const api: WalletsApi = Object.freeze({ register });

  try {
    target.addEventListener(REGISTER_WALLET_EVENT, (event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (typeof detail !== "function") return;
      try {
        (detail as (api: WalletsApi) => void)(api);
      } catch {
        // A faulty wallet callback must not break discovery.
      }
    });
    target.dispatchEvent(new CustomEvent<WalletsApi>(APP_READY_EVENT, { detail: api }));
  } catch {
    // No usable event target; the registry stays empty.
  }

  return {
    get: () => wallets,
    on(event, listener) {
      listeners[event].add(listener);
      return () => {
        listeners[event].delete(listener);
      };
    },
  };
}

/**
 * The wallet registry for `target` (default: `window`). Safe during SSR: without a window it
 * returns an empty registry. Calling it again for the same target returns the same registry.
 */
export function getWallets(target?: EventTarget): WalletsRegistry {
  const resolved = target ?? (typeof window === "undefined" ? undefined : window);
  if (resolved === undefined) return EMPTY_REGISTRY;
  const existing = registries.get(resolved);
  if (existing !== undefined) return existing;
  const created = createRegistry(resolved);
  registries.set(resolved, created);
  return created;
}
