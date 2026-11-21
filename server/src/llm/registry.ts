// Provider registry (Req 3.1, 3.2, 3.9, 3.10, 4.4, task 9.1).
//
// Builds the providers that the config makes available. `info()` is the only view that goes
// to clients: id, model, available. It never carries a key or a URL (Req 3.12).
//
// Availability:
//   openai, anthropic, nvidia  a key is set and a factory is registered
//   ollama                     a factory is registered and `GET <OLLAMA_BASE_URL>/api/tags`
//                              answered 2xx within 2 s; re-checked at most every 30 s
// The concrete providers are factories supplied by tasks 9.2 to 9.5.

import type { Config } from "../config.ts";
import { LLM_PROVIDER_IDS } from "../config.ts";
import { OLLAMA_PROBE_TIMEOUT_MS, OLLAMA_RECHECK_MS } from "./limits.ts";
import { anthropicFactory } from "./anthropic.ts";
import { createNvidiaProvider } from "./nvidia.ts";
import { createOllamaProvider } from "./ollama.ts";
import { createOpenAiJsonProvider } from "./openai.ts";
import type { JsonLlmProvider, LlmProviderId } from "./provider.ts";

/** The part of Config the registry reads. Narrow so tests can pass a real `Config` from `loadConfig`. */
export type RegistryConfig = Pick<
  Config,
  | "openaiApiKey"
  | "anthropicApiKey"
  | "nvidiaApiKey"
  | "openaiModel"
  | "anthropicModel"
  | "nvidiaModel"
  | "ollamaModel"
  | "ollamaBaseUrl"
  | "nvidiaBaseUrl"
  | "llmProvider"
>;

/** Builds one provider. Receives the config, so it can read its own key and base URL. */
export type ProviderFactory = (config: RegistryConfig) => JsonLlmProvider;
export type ProviderFactories = Partial<Record<LlmProviderId, ProviderFactory>>;

/** Safe to send to clients: no key, no URL (Req 3.12). */
export interface ProviderInfo {
  readonly id: LlmProviderId;
  readonly model: string;
  readonly available: boolean;
}

export type ProbeFetch = (url: string, init: { signal: AbortSignal; method: "GET" }) => Promise<{ ok: boolean }>;

export interface ProviderRegistryOptions {
  readonly config: RegistryConfig;
  readonly factories?: ProviderFactories;
  /** Defaults to global fetch. Production wires the allowlisted wrapper. */
  readonly fetch?: ProbeFetch;
  readonly now?: () => number;
}

export class ProviderRegistry {
  readonly #config: RegistryConfig;
  readonly #factories: ProviderFactories;
  readonly #fetch: ProbeFetch;
  readonly #now: () => number;
  readonly #providers = new Map<LlmProviderId, JsonLlmProvider>();
  #ollamaUp = false;
  #lastProbe: number | null = null;
  #probing: Promise<void> | null = null;

  constructor(options: ProviderRegistryOptions) {
    this.#config = options.config;
    this.#factories = options.factories ?? {};
    this.#fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, { ...init, redirect: "error" }));
    this.#now = options.now ?? Date.now;
  }

  #model(id: LlmProviderId): string {
    switch (id) {
      case "openai":
        return this.#config.openaiModel;
      case "anthropic":
        return this.#config.anthropicModel;
      case "nvidia":
        return this.#config.nvidiaModel;
      case "ollama":
        return this.#config.ollamaModel;
    }
  }

  #available(id: LlmProviderId): boolean {
    if (this.#factories[id] === undefined) return false;
    switch (id) {
      case "openai":
        return this.#config.openaiApiKey !== undefined;
      case "anthropic":
        return this.#config.anthropicApiKey !== undefined;
      case "nvidia":
        return this.#config.nvidiaApiKey !== undefined;
      case "ollama":
        return this.#ollamaUp;
    }
  }

  /**
   * Probes Ollama unless the last probe is under 30 s old (Req 3.9, 3.10). Concurrent calls share
   * one probe. Never rejects: a failed probe marks ollama unavailable.
   */
  refresh(): Promise<void> {
    if (this.#factories.ollama === undefined) return Promise.resolve();
    if (this.#probing !== null) return this.#probing;
    if (this.#lastProbe !== null && this.#now() - this.#lastProbe < OLLAMA_RECHECK_MS) return Promise.resolve();
    this.#lastProbe = this.#now();
    const probe = async (): Promise<void> => {
      try {
        const response = await this.#fetch(`${this.#config.ollamaBaseUrl}/api/tags`, {
          method: "GET",
          signal: AbortSignal.timeout(OLLAMA_PROBE_TIMEOUT_MS),
        });
        this.#ollamaUp = response.ok;
      } catch {
        this.#ollamaUp = false;
      }
      this.#probing = null;
    };
    this.#probing = probe();
    return this.#probing;
  }

  info(): readonly ProviderInfo[] {
    return LLM_PROVIDER_IDS.map((id) => ({ id, model: this.#model(id), available: this.#available(id) }));
  }

  /** The provider if it is available, else undefined. Built once and reused. */
  get(id: LlmProviderId): JsonLlmProvider | undefined {
    if (!this.#available(id)) return undefined;
    const cached = this.#providers.get(id);
    if (cached !== undefined) return cached;
    const factory = this.#factories[id];
    if (factory === undefined) return undefined;
    const provider = factory(this.#config);
    this.#providers.set(id, provider);
    return provider;
  }

  /** LLM_PROVIDER if available, else the first available of ollama, openai, anthropic, nvidia; null if none (Req 4.4). */
  defaultId(): LlmProviderId | null {
    const wanted = this.#config.llmProvider;
    if (wanted !== undefined && this.#available(wanted)) return wanted;
    return LLM_PROVIDER_IDS.find((id) => this.#available(id)) ?? null;
  }
}

/** The four real factories. Each throws if its key is missing; `get()` only calls it when available. */
export function defaultProviderFactories(): ProviderFactories {
  const doFetch = (input: string, init: RequestInit): Promise<Response> => globalThis.fetch(input, init);
  return {
    openai: (config) => {
      if (config.openaiApiKey === undefined) throw new Error("OPENAI_API_KEY is not set");
      return createOpenAiJsonProvider({ apiKey: config.openaiApiKey, model: config.openaiModel, fetch: doFetch });
    },
    anthropic: anthropicFactory,
    nvidia: (config) => {
      if (config.nvidiaApiKey === undefined) throw new Error("NVIDIA_API_KEY is not set");
      return createNvidiaProvider({
        apiKey: config.nvidiaApiKey,
        model: config.nvidiaModel,
        baseUrl: config.nvidiaBaseUrl,
        fetch: doFetch,
      });
    },
    ollama: (config) => createOllamaProvider({ baseUrl: config.ollamaBaseUrl, model: config.ollamaModel }),
  };
}

/** Registry with all four providers wired from config. */
export function buildRegistry(
  config: RegistryConfig,
  overrides: Omit<ProviderRegistryOptions, "config" | "factories"> = {},
): ProviderRegistry {
  return new ProviderRegistry({ ...overrides, config, factories: defaultProviderFactories() });
}

export function createProviderRegistry(options: ProviderRegistryOptions): ProviderRegistry {
  return new ProviderRegistry(options);
}
