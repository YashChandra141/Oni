// Task 9.1: LLM config parsing, redaction, and the provider registry.
import { describe, expect, test } from "bun:test";
import { inspect } from "node:util";
import {
  Config,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_NVIDIA_BASE_URL,
  DEFAULT_NVIDIA_MODEL,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OPENAI_MODEL,
  REDACTED,
  loadConfig,
  redactSecrets,
  type EnvRecord,
} from "../config.ts";
import type { JsonLlmProvider, LlmProviderId } from "./provider.ts";
import { createProviderRegistry, type ProbeFetch, type ProviderFactories } from "./registry.ts";

const OPENAI = "sk-openai-secret-111";
const ANTHROPIC = "sk-ant-secret-222";
const NVIDIA = "nvapi-secret-333";
const NV_URL = "https://nim.internal.example:8443/v1";
const OL_URL = "http://ollama.internal.example:11434";

function ok(env: EnvRecord): Config {
  const result = loadConfig(env, { platform: "linux" });
  if (!result.ok) throw new Error(result.error.message);
  return result.config;
}

function variables(env: EnvRecord): string[] {
  const result = loadConfig(env, { platform: "linux" });
  if (result.ok) throw new Error("expected a config error");
  return result.error.issues.map((i) => i.variable);
}

const fake = (id: LlmProviderId, model: string): JsonLlmProvider => ({
  id,
  model,
  completeJson: async () => ({}),
});

const FACTORIES: ProviderFactories = {
  openai: (c) => fake("openai", c.openaiModel),
  anthropic: (c) => fake("anthropic", c.anthropicModel),
  nvidia: (c) => fake("nvidia", c.nvidiaModel),
  ollama: (c) => fake("ollama", c.ollamaModel),
};

describe("LLM config", () => {
  test("defaults match design.md", () => {
    const c = ok({});
    expect(c.openaiModel).toBe(DEFAULT_OPENAI_MODEL);
    expect(DEFAULT_OPENAI_MODEL).toBe("gpt-6-luna");
    expect(c.anthropicModel).toBe(DEFAULT_ANTHROPIC_MODEL);
    expect(DEFAULT_ANTHROPIC_MODEL).toBe("claude-haiku-5-5");
    expect(c.nvidiaModel).toBe(DEFAULT_NVIDIA_MODEL);
    expect(DEFAULT_NVIDIA_MODEL).toBe("z-ai/glm-5.3-flash");
    expect(c.ollamaModel).toBe(DEFAULT_OLLAMA_MODEL);
    expect(DEFAULT_OLLAMA_MODEL).toBe("gemma4");
    expect(c.nvidiaBaseUrl).toBe(DEFAULT_NVIDIA_BASE_URL);
    expect(c.ollamaBaseUrl).toBe(DEFAULT_OLLAMA_BASE_URL);
    expect(c.anthropicApiKey).toBeUndefined();
    expect(c.nvidiaApiKey).toBeUndefined();
    expect(c.llmProvider).toBeUndefined();
  });

  test("values are read from env and a trailing slash is trimmed", () => {
    const c = ok({
      ANTHROPIC_API_KEY: ANTHROPIC,
      NVIDIA_API_KEY: NVIDIA,
      NVIDIA_BASE_URL: `${NV_URL}/`,
      OLLAMA_BASE_URL: OL_URL,
      NVIDIA_MODEL: "m1",
      ANTHROPIC_MODEL: "m2",
      OLLAMA_MODEL: "m3",
      LLM_PROVIDER: "nvidia",
    });
    expect(c.anthropicApiKey).toBe(ANTHROPIC);
    expect(c.nvidiaApiKey).toBe(NVIDIA);
    expect(c.nvidiaBaseUrl).toBe(NV_URL);
    expect(c.ollamaBaseUrl).toBe(OL_URL);
    expect([c.nvidiaModel, c.anthropicModel, c.ollamaModel]).toEqual(["m1", "m2", "m3"]);
    expect(c.llmProvider).toBe("nvidia");
    expect(c.nvidiaHost).toBe("nim.internal.example:8443");
    expect(c.ollamaHost).toBe("ollama.internal.example:11434");
  });

  test("an unknown LLM_PROVIDER is reported by name only", () => {
    expect(variables({ LLM_PROVIDER: "gemini" })).toEqual(["LLM_PROVIDER"]);
  });

  test("base URLs with credentials, query, fragment, or a bad scheme are rejected without echoing them", () => {
    for (const bad of [
      "https://user:pass@nim.example/v1",
      "https://user@nim.example/v1",
      "https://nim.example/v1?key=abc",
      "https://nim.example/v1#x",
      "ftp://nim.example",
      "not a url",
    ]) {
      const result = loadConfig({ NVIDIA_BASE_URL: bad, OLLAMA_BASE_URL: bad }, { platform: "linux" });
      if (result.ok) throw new Error(`accepted ${bad}`);
      expect(result.error.issues.map((i) => i.variable)).toEqual(["NVIDIA_BASE_URL", "OLLAMA_BASE_URL"]);
      expect(JSON.stringify(result.error.issues)).not.toContain("pass");
      expect(result.error.message).not.toContain("pass");
    }
  });

  const full = (): Config =>
    ok({
      OPENAI_API_KEY: OPENAI,
      ANTHROPIC_API_KEY: ANTHROPIC,
      NVIDIA_API_KEY: NVIDIA,
      NVIDIA_BASE_URL: NV_URL,
      OLLAMA_BASE_URL: OL_URL,
    });

  test("redactSecrets scrubs every key and base URL", () => {
    const text = [OPENAI, ANTHROPIC, NVIDIA, NV_URL, OL_URL].join(" | ");
    const out = redactSecrets(text, full());
    for (const s of [OPENAI, ANTHROPIC, NVIDIA, NV_URL, OL_URL]) expect(out).not.toContain(s);
    expect(out).toContain(REDACTED);
  });

  test("toJSON, JSON.stringify, inspect, spread and keys hide every secret", () => {
    const c = full();
    const dumps = [
      JSON.stringify(c),
      JSON.stringify({ ...c }),
      inspect(c),
      JSON.stringify(Object.entries(c)),
      JSON.stringify(c.toJSON()),
    ].join("\n");
    for (const s of [OPENAI, ANTHROPIC, NVIDIA, NV_URL, OL_URL, "nim.internal", "ollama.internal"]) {
      expect(dumps).not.toContain(s);
    }
    expect(Object.keys(c)).not.toContain("nvidiaBaseUrl");
    expect(c.toJSON()).toMatchObject({ anthropicApiKey: REDACTED, nvidiaApiKey: REDACTED, nvidiaBaseUrl: REDACTED });
    expect(ok({}).toJSON()).toMatchObject({ anthropicApiKey: null, nvidiaApiKey: null });
  });
});

describe("ProviderRegistry", () => {
  const up: ProbeFetch = async () => ({ ok: true, json: async () => ({ models: [{ name: "gemma4", size: 1, details: {} }] }) });
  const down: ProbeFetch = async () => {
    throw new Error("connect refused");
  };

  test("no keys and no Ollama: nothing is available and there is no default", async () => {
    const r = createProviderRegistry({ config: ok({}), factories: FACTORIES, fetch: down });
    await r.refresh();
    expect(r.info().every((p) => !p.available)).toBe(true);
    expect(r.defaultId()).toBeNull();
    expect(r.get("openai")).toBeUndefined();
  });

  test("a key makes its provider available; a missing factory does not", () => {
    const config = ok({ OPENAI_API_KEY: OPENAI, ANTHROPIC_API_KEY: ANTHROPIC });
    const r = createProviderRegistry({ config, factories: { openai: FACTORIES.openai } });
    const byId = Object.fromEntries(r.info().map((p) => [p.id, p.available]));
    expect(byId).toEqual({ ollama: false, openai: true, anthropic: false, nvidia: false });
    expect(r.get("openai")?.model).toBe(DEFAULT_OPENAI_MODEL);
    expect(r.get("openai")).toBe(r.get("openai"));
  });

  test("default is LLM_PROVIDER when available, else ollama, openai, anthropic, nvidia in order", async () => {
    const keys = { OPENAI_API_KEY: OPENAI, ANTHROPIC_API_KEY: ANTHROPIC, NVIDIA_API_KEY: NVIDIA };
    const noOllama = createProviderRegistry({ config: ok(keys), factories: FACTORIES, fetch: down });
    await noOllama.refresh();
    expect(noOllama.defaultId()).toBe("openai");

    const withOllama = createProviderRegistry({ config: ok(keys), factories: FACTORIES, fetch: up });
    await withOllama.refresh();
    expect(withOllama.defaultId()).toBe("ollama");

    const pinned = createProviderRegistry({ config: ok({ ...keys, LLM_PROVIDER: "nvidia" }), factories: FACTORIES, fetch: up });
    await pinned.refresh();
    expect(pinned.defaultId()).toBe("nvidia");

    const pinnedUnavailable = createProviderRegistry({
      config: ok({ OPENAI_API_KEY: OPENAI, LLM_PROVIDER: "anthropic" }),
      factories: FACTORIES,
      fetch: down,
    });
    await pinnedUnavailable.refresh();
    expect(pinnedUnavailable.defaultId()).toBe("openai");
  });

  test("Ollama is probed at /api/tags, at most once per 30 s, and follows the result", async () => {
    let now = 1_000;
    let reachable = true;
    const urls: string[] = [];
    const fetchFn: ProbeFetch = async (url) => {
      urls.push(url);
      if (!reachable) return { ok: false, json: async () => ({}) };
      return { ok: true, json: async () => ({ models: [{ name: "gemma4", size: 1, details: {} }] }) };
    };
    const r = createProviderRegistry({ config: ok({ OLLAMA_BASE_URL: OL_URL }), factories: FACTORIES, fetch: fetchFn, now: () => now });
    await r.refresh();
    expect(urls).toEqual([`${OL_URL}/api/tags`]);
    expect(r.info().find((p) => p.id === "ollama")?.available).toBe(true);

    reachable = false;
    now += 29_000;
    await r.refresh();
    expect(urls.length).toBe(1);
    expect(r.info().find((p) => p.id === "ollama")?.available).toBe(true);

    now += 1_001;
    await r.refresh();
    expect(urls.length).toBe(2);
    expect(r.info().find((p) => p.id === "ollama")?.available).toBe(false);
  });

  test("provider info has only id, model, available, and no key or URL", async () => {
    const config = ok({
      OPENAI_API_KEY: OPENAI,
      ANTHROPIC_API_KEY: ANTHROPIC,
      NVIDIA_API_KEY: NVIDIA,
      NVIDIA_BASE_URL: NV_URL,
      OLLAMA_BASE_URL: OL_URL,
    });
    const r = createProviderRegistry({ config, factories: FACTORIES, fetch: up });
    await r.refresh();
    const json = JSON.stringify(r.info());
    for (const s of [OPENAI, ANTHROPIC, NVIDIA, NV_URL, OL_URL, "http", "internal"]) expect(json).not.toContain(s);
    for (const p of r.info()) {
      // Only the ollama entry may carry `models` (Req 38.6); no other key is allowed.
      const keys = Object.keys(p).sort();
      expect(keys).toEqual(p.id === "ollama" ? ["available", "id", "model", "models", "reachable"] : ["available", "id", "model"]);
      if (p.id === "ollama") {
        expect(Array.isArray(p.models)).toBe(true);
        for (const m of p.models ?? []) {
          for (const k of Object.keys(m)) expect(["name", "size", "family", "parameter_size"]).toContain(k);
        }
      }
    }
  });
});
