// Test doubles for the Wallet Standard and the auth routes. Used only by tests.

import { formatSiws } from "../../shared/siws";
import type { SiwsFields } from "../../shared/siws";
import type { FetchLike, StorageLike } from "./auth";
import type {
  Wallet,
  WalletAccount,
  SolanaSignInInput,
  SolanaSignInOutput,
  SolanaSignMessageInput,
  SolanaSignMessageOutput,
} from "./walletStandard";

/** A well-formed Solana address (32 zero bytes). */
export const FAKE_ADDRESS = "11111111111111111111111111111111";

export function fakeAccount(address: string = FAKE_ADDRESS): WalletAccount {
  return {
    address,
    publicKey: new Uint8Array(32),
    chains: ["solana:mainnet"],
    features: ["solana:signIn", "solana:signMessage"],
  };
}

export const FAKE_SIGNATURE = new Uint8Array(64).fill(7);

export interface FakeWalletOptions {
  readonly name?: string;
  readonly chains?: readonly string[];
  readonly signIn?: boolean;
  readonly signMessage?: boolean;
  readonly connect?: boolean;
  readonly disconnect?: boolean;
  /** Extra feature objects, for example a transaction feature the UI must never call. */
  readonly extraFeatures?: Readonly<Record<string, unknown>>;
  /** When set, `signIn` and `signMessage` reject with this value. */
  readonly rejectSigningWith?: unknown;
  readonly address?: string;
}

export interface FakeWallet extends Wallet {
  /** Names of the feature methods called, in order. */
  readonly calls: string[];
  readonly signInInputs: SolanaSignInInput[];
  readonly signMessageInputs: SolanaSignMessageInput[];
}

export function fakeWallet(options: FakeWalletOptions = {}): FakeWallet {
  const account = fakeAccount(options.address);
  const calls: string[] = [];
  const signInInputs: SolanaSignInInput[] = [];
  const signMessageInputs: SolanaSignMessageInput[] = [];
  const features: Record<string, unknown> = { ...options.extraFeatures };

  if (options.connect ?? true) {
    features["standard:connect"] = {
      connect: async () => {
        calls.push("connect");
        return { accounts: [account] };
      },
    };
  }
  if (options.disconnect ?? true) {
    features["standard:disconnect"] = {
      disconnect: async () => {
        calls.push("disconnect");
      },
    };
  }
  if (options.signIn ?? true) {
    features["solana:signIn"] = {
      signIn: async (...inputs: SolanaSignInInput[]): Promise<SolanaSignInOutput[]> => {
        calls.push("signIn");
        if (options.rejectSigningWith !== undefined) throw options.rejectSigningWith;
        signInInputs.push(...inputs);
        const input = inputs[0] as SiwsFields;
        return [{ account, signedMessage: new TextEncoder().encode(formatSiws(input)), signature: FAKE_SIGNATURE }];
      },
    };
  }
  if (options.signMessage ?? true) {
    features["solana:signMessage"] = {
      signMessage: async (...inputs: SolanaSignMessageInput[]): Promise<SolanaSignMessageOutput[]> => {
        calls.push("signMessage");
        if (options.rejectSigningWith !== undefined) throw options.rejectSigningWith;
        signMessageInputs.push(...inputs);
        const input = inputs[0];
        return [{ signedMessage: input?.message ?? new Uint8Array(), signature: FAKE_SIGNATURE }];
      },
    };
  }

  return {
    version: "1.0.0",
    name: options.name ?? "Phantom",
    icon: "data:image/svg+xml;base64,",
    chains: options.chains ?? ["solana:mainnet"],
    features,
    accounts: [account],
    calls,
    signInInputs,
    signMessageInputs,
  };
}

export class MemoryStorage implements StorageLike {
  readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

export interface FakeReply {
  readonly status: number;
  readonly body?: unknown;
}

/** A fetch double that answers by URL and records every request. */
export function fakeFetch(replies: Readonly<Record<string, FakeReply | "network_error">>): {
  readonly fetch: FetchLike;
  readonly requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetch: FetchLike = async (url, init) => {
    requests.push({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body === undefined ? undefined : (JSON.parse(init.body) as unknown),
    });
    const reply = replies[url];
    if (reply === undefined) return { ok: false, status: 404, json: async () => ({}) };
    if (reply === "network_error") throw new TypeError("fetch failed");
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body ?? {} };
  };
  return { fetch, requests };
}

// ---------------------------------------------------------------------------------------------
// Recording wallet (Task 20.4, Req 49.1, 49.2)

const SIGN = "sign";

/**
 * Wallet features the UI must never use. The names are assembled from pieces on purpose, so the
 * grep test (noTransactionSigning.test.ts) does not match this file.
 */
export const FORBIDDEN_FEATURE_NAMES: readonly string[] = [
  `solana:${SIGN}Transaction`,
  `solana:${SIGN}AllTransactions`,
  `solana:${SIGN}AndSendTransaction`,
  `solana:${SIGN}AndSendAllTransactions`,
];

export interface RecordingWallet extends FakeWallet {
  /** Every feature name the app read from `wallet.features`, in order (a Proxy records each read). */
  readonly featuresAccessed: string[];
  /** Forbidden feature names whose methods were invoked. Must stay empty. */
  readonly forbiddenCalls: string[];
}

/** Maps a `FakeWallet.calls` entry to the feature that owns the method. */
export const CALL_TO_FEATURE: Readonly<Record<string, string>> = {
  connect: "standard:connect",
  disconnect: "standard:disconnect",
  signIn: "solana:signIn",
  signMessage: "solana:signMessage",
};

/**
 * A fake wallet that also exposes the transaction-signing features (as traps that record any
 * call) and records every feature name the app reads from `features`.
 */
export function recordingWallet(options: FakeWalletOptions = {}): RecordingWallet {
  const forbiddenCalls: string[] = [];
  const featuresAccessed: string[] = [];
  const traps: Record<string, unknown> = {};
  for (const name of FORBIDDEN_FEATURE_NAMES) {
    traps[name] = new Proxy(
      {},
      {
        get: () => () => {
          forbiddenCalls.push(name);
          return Promise.resolve([]);
        },
      },
    );
  }
  const base = fakeWallet({ ...options, extraFeatures: { ...traps, ...options.extraFeatures } });
  const features = new Proxy(base.features as Record<string, unknown>, {
    get(target, property, receiver) {
      if (typeof property === "string") featuresAccessed.push(property);
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  return { ...base, features, featuresAccessed, forbiddenCalls };
}
