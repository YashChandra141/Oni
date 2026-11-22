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
import { guardedFetch, type GuardedRequestInit } from "../net/http.ts";
import { OLLAMA_PROBE_TIMEOUT_MS, OLLAMA_RECHECK_MS } from "./limits.ts";
import { anthropicFactory } from "./anthropic.ts";
import { createNvidiaProvider } from "./nvidia.ts";
import { createOllamaProvider } from "./ollama.ts";
import { createOpenAiJsonProvider } from "./openai.ts";
import type { JsonLlmProvider, LlmProviderId } from "./provider.ts";
import type { OllamaModel } from "../protocol.ts";
import { parseTags } from "./tags.ts";

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
export interface FactoryOverrides {
  readonly ollamaModel?: string;
}
export type ProviderFactory = (config: RegistryConfig, overrides?: FactoryOverrides) => JsonLlmProvider;
export type ProviderFactories = Partial<Record<LlmProviderId, ProviderFactory>>;

/** Safe to send to clients: no key, no URL (Req 3.12). */
export interface ProviderInfo {
  readonly id: LlmProviderId;
  readonly model: string;
  readonly available: boolean;
  /** Only on `ollama`: the installed models (Req 38.6). */
  readonly models?: readonly OllamaModel[];
  /** Only on `ollama`: the last probe got a valid answer (the list may still be empty). */
  readonly reachable?: boolean;
}

export type ProbeFetch = (
  url: string,
  init: { signal: AbortSignal; method: "GET" },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export interface ProviderRegistryOptions {
  readonly config: RegistryConfig;
  readonly factories?: ProviderFactories;
  /** Defaults to the allowlisted `guardedFetch`. Tests pass a fake. */
  readonly fetch?: ProbeFetch;
  readonly now?: () => number;
  /** Receives one line on a probe state change: count and host only, never names or the full URL. */
  readonly log?: (line: string) => void;
}

export class ProviderRegistry {
  readonly #config: RegistryConfig;
  readonly #factories: ProviderFactories;
  readonly #fetch: ProbeFetch;
  readonly #now: () => number;
  readonly #providers = new Map<string, JsonLlmProvider>();
  readonly #listeners = new Set<() => void>();
  #models: readonly OllamaModel[] = [];
  #ollamaUp = false;
  #lastProbe: number | null = null;
  #probing: Promise<void> | null = null;
  readonly #log: (line: string) => void;
  #lastLogged: string | null = null;

  constructor(options: ProviderRegistryOptions) {
    this.#log = options.log ?? (() => {});
    this.#config = options.config;
    this.#factories = options.factories ?? {};
    this.#fetch = options.fetch ?? ((url, init) => guardedFetch(url, init));
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
        return this.#ollamaUp && this.#models.length > 0;
    }
  }

  #setModels(next: readonly OllamaModel[]): void {
    const same =
      next.length === this.#models.length &&
      next.every((m, i) => {
        const o = this.#models[i];
        return (
          o !== undefined &&
          o.name === m.name &&
          o.size === m.size &&
          o.family === m.family &&
          o.parameter_size === m.parameter_size
        );
      });
    if (same) return;
    this.#models = next;
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch {
        // a listener must not break the probe
      }
    }
  }

  /** Logs once per change of outcome. Count and host only (trading-safety rule 6). */
  #logProbe(count: number | null): void {
    let host = "unknown";
    try {
      host = new URL(this.#config.ollamaBaseUrl).host;
    } catch {
      // keep the placeholder
    }
    const line = count === null ? `[llm] ollama unreachable at ${host}` : `[llm] ollama: ${count} models at ${host}`;
    if (line === this.#lastLogged) return;
    this.#lastLogged = line;
    try {
      this.#log(line);
    } catch {
      // logging must not break the probe
    }
  }

  /** Whether `name` is in the latest Ollama_Model_List. */
  hasModel(name: string): boolean {
    return this.#models.some((m) => m.name === name);
  }

  /** preferred if installed, else OLLAMA_MODEL if installed, else the first installed model, else undefined (Req 38.12, 38.13). */
  chooseOllamaModel(preferred?: string): string | undefined {
    if (preferred !== undefined && this.hasModel(preferred)) return preferred;
    if (this.hasModel(this.#config.ollamaModel)) return this.#config.ollamaModel;
    return this.#models[0]?.name;
  }

  /** Called when a probe changes the Ollama_Model_List. Returns an unsubscribe function. */
  onModelsChanged(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
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
        const response = await this.#fetch(`${this.#config.ollamaBaseUrl.replace(/\/+$/, "")}/api/tags`, {
          method: "GET",
          signal: AbortSignal.timeout(OLLAMA_PROBE_TIMEOUT_MS),
        });
        let models: OllamaModel[] | null = null;
        if (response.ok) {
          try {
            models = parseTags(await response.json());
          } catch {
            models = null;
          }
        }
        this.#ollamaUp = response.ok && models !== null;
        this.#logProbe(this.#ollamaUp ? models?.length ?? 0 : null);
        this.#setModels(models ?? []);
      } catch {
        this.#ollamaUp = false;
        this.#logProbe(null);
        this.#setModels([]);
      }
      this.#probing = null;
    };
    this.#probing = probe();
    return this.#probing;
  }

  info(): readonly ProviderInfo[] {
    return LLM_PROVIDER_IDS.map((id) => {
      const model = id === "ollama" ? (this.chooseOllamaModel() ?? this.#model(id)) : this.#model(id);
      const base = { id, model, available: this.#available(id) };
      return id === "ollama" ? { ...base, models: this.#models, reachable: this.#ollamaUp } : base;
    });
  }

  /**
   * The provider if it is available, else undefined. Built once and reused. For `ollama`, `model`
   * picks the model (undefined means OLLAMA_MODEL); a model that is not installed gives undefined
   * when one is named. One provider is cached per model.
   */
  get(id: LlmProviderId, model?: string): JsonLlmProvider | undefined {
    if (!this.#available(id)) return undefined;
    const factory = this.#factories[id];
    if (factory === undefined) return undefined;
    let key: string = id;
    let overrides: FactoryOverrides | undefined;
    if (id === "ollama") {
      // A named model must be installed; with none named, use the fallback rule, never the raw default.
      if (model !== undefined && !this.hasModel(model)) return undefined;
      const chosen = model ?? this.chooseOllamaModel();
      if (chosen === undefined) return undefined;
      key = `ollama\u0000${chosen}`;
      overrides = { ollamaModel: chosen };
    }
    const cached = this.#providers.get(key);
    if (cached !== undefined) return cached;
    const provider = factory(this.#config, overrides);
    this.#providers.set(key, provider);
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
  const doFetch = (input: string, init: GuardedRequestInit): Promise<Response> => guardedFetch(input, init);
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
    ollama: (config, overrides) =>
      createOllamaProvider({ baseUrl: config.ollamaBaseUrl, model: overrides?.ollamaModel ?? config.ollamaModel }),
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
