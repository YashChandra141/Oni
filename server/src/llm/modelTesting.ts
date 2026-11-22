// Test helpers for the Ollama model list (Task 19.6). Used only by *.test.ts files.

import { type Config, loadConfig } from "../config.ts";
import type { JsonLlmProvider } from "./provider.ts";
import type { ProbeFetch, ProviderFactories } from "./registry.ts";

export const FAKE_OL_URL = "http://ollama.fake.example:11434";

export function modelConfig(ollamaModel = "base-model"): Config {
  // An explicit env object only: never process.env or Bun.env, which Bun fills from a local `.env`.
  // Every key is listed as empty (empty counts as unset), so a real key cannot leak in.
  const env: Record<string, string> = {
    OLLAMA_BASE_URL: FAKE_OL_URL,
    OLLAMA_MODEL: ollamaModel,
    LLM_PROVIDER: "ollama",
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    NVIDIA_API_KEY: "",
    NVIDIA_BASE_URL: "",
    OPENAI_MODEL: "",
    ANTHROPIC_MODEL: "",
    NVIDIA_MODEL: "",
  };
  const r = loadConfig(env, { platform: "linux" });
  if (!r.ok) throw new Error(r.error.message);
  return r.config;
}

export const tagsBody = (names: readonly string[]) => ({
  models: names.map((name) => ({ name, size: 100, details: { family: "fam", parameter_size: "1B" } })),
});

/** A probe fake whose body, status, and failure the test changes between probes. */
export class FakeTags {
  names: string[] = [];
  ok = true;
  body: unknown = undefined;
  fail: "none" | "throw" | "badjson" = "none";
  readonly urls: string[] = [];
  readonly fetch: ProbeFetch = async (url) => {
    this.urls.push(url);
    if (this.fail === "throw") throw new DOMException("timed out", "TimeoutError");
    if (this.fail === "badjson") {
      return {
        ok: true,
        json: async () => {
          throw new SyntaxError("bad json");
        },
      };
    }
    return { ok: this.ok, json: async () => (this.body !== undefined ? this.body : tagsBody(this.names)) };
  };
}

/** Records the model each built Ollama provider was given. */
export function ollamaFactories(built: string[] = []): ProviderFactories {
  return {
    ollama: (config, overrides) => {
      const model = overrides?.ollamaModel ?? config.ollamaModel;
      built.push(model);
      const p: JsonLlmProvider = { id: "ollama", model, completeJson: async () => ({}) };
      return p;
    },
  };
}
