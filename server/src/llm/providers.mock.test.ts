// Mock-server tests for all four LLM providers (task 9.7, Req 3.3, 3.4, 3.5, 3.6, 3.13, 6.3).
//
// Each provider talks real HTTP to a local Bun.serve mock (port 0) and reads a recorded response
// fixture from ./fixtures/providers/. The mock is not allowlisted, so each provider gets an
// injected fetch that sends the request to the mock instead of guardedFetch; the allowlist is
// untouched. No test contacts a real LLM host.
//
// Every scenario also checks that the fake API key and the prompt text never show up in an error
// message or in anything logged (trading-safety rule 6).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { INTENT_JSON_SCHEMA, INTENT_SCHEMA_NAME, IntentSchema } from "./intentSchema.ts";
import { ANTHROPIC_VERSION, createAnthropicProvider } from "./anthropic.ts";
import { createNvidiaProvider } from "./nvidia.ts";
import { createOllamaProvider } from "./ollama.ts";
import { createOpenAiJsonProvider } from "./openai.ts";
import {
  LlmBadOutput,
  LlmRefused,
  LlmTimeout,
  LlmUnavailable,
  type JsonLlmProvider,
  type JsonRequest,
} from "./provider.ts";

const API_KEY = "sk-fake-MOCKTEST-key-0000000000";
const PROMPT_MARKER = "UNIQUE_PROMPT_MARKER_7f3a91";
const SYSTEM_MARKER = "UNIQUE_SYSTEM_MARKER_c41d02";

interface Recorded {
  readonly path: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

type Handler = (req: Recorded) => Response | Promise<Response>;

let server: ReturnType<typeof Bun.serve>;
let handler: Handler = () => new Response("unset", { status: 500 });
let recorded: Recorded[] = [];
let mockOrigin = "";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const text = await request.text();
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        // leave empty
      }
      const entry: Recorded = { path: new URL(request.url).pathname, headers: request.headers, body };
      recorded.push(entry);
      return handler(entry);
    },
  });
  mockOrigin = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  void server.stop(true);
});

/** Sends the provider's request to the mock server, keeping the path. */
const toMock = async (input: string, init: RequestInit): Promise<Response> => {
  const url = new URL(input);
  return fetch(`${mockOrigin}${url.pathname}${url.search}`, init);
};

async function loadFixture(file: string): Promise<Record<string, unknown>> {
  return (await Bun.file(new URL(`./fixtures/providers/${file}`, import.meta.url)).json()) as Record<string, unknown>;
}

function request(overrides: Partial<JsonRequest> = {}): JsonRequest {
  return {
    system: `You extract intents. ${SYSTEM_MARKER}`,
    user: `buy some bitcoin ${PROMPT_MARKER}`,
    schemaName: INTENT_SCHEMA_NAME,
    schema: INTENT_JSON_SCHEMA,
    maxOutputTokens: 500,
    timeoutMs: 5000,
    ...overrides,
  };
}

async function thrown(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("expected the call to throw");
}

// Log capture: every test in this file must leave the logs free of the key and the prompt.
const logged: string[] = [];
const originalConsole = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };

beforeEach(() => {
  logged.length = 0;
  recorded = [];
  for (const k of Object.keys(originalConsole) as (keyof typeof originalConsole)[]) {
    console[k] = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  }
});

afterEach(() => {
  Object.assign(console, originalConsole);
  const all = logged.join("\n");
  expect(all).not.toContain(API_KEY);
  expect(all).not.toContain(PROMPT_MARKER);
  expect(all).not.toContain(SYSTEM_MARKER);
});

function expectNoLeak(error: Error): void {
  for (const text of [error.message, String((error as LlmUnavailable).stack ?? "").split("\n")[0] ?? ""]) {
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain(PROMPT_MARKER);
    expect(text).not.toContain(SYSTEM_MARKER);
  }
}

interface Spec {
  readonly name: string;
  readonly file: string;
  readonly path: string;
  readonly make: () => JsonLlmProvider;
  readonly refusal: boolean;
}

const SPECS: readonly Spec[] = [
  {
    name: "openai",
    file: "openai.responses.json",
    path: "/v1/responses",
    refusal: true,
    make: () => createOpenAiJsonProvider({ apiKey: API_KEY, model: "fixture-model", fetch: toMock }),
  },
  {
    name: "anthropic",
    file: "anthropic.messages.json",
    path: "/v1/messages",
    refusal: true,
    make: () => createAnthropicProvider({ apiKey: API_KEY, model: "fixture-model", fetch: toMock }),
  },
  {
    name: "nvidia",
    file: "nvidia.chat.json",
    path: "/v1/chat/completions",
    refusal: true,
    make: () =>
      createNvidiaProvider({ apiKey: API_KEY, model: "fixture-model", fetch: toMock, baseUrl: "https://nim.example.test/v1" }),
  },
  {
    name: "ollama",
    file: "ollama.chat.json",
    path: "/api/chat",
    refusal: false,
    make: () => createOllamaProvider({ baseUrl: "http://ollama.example.test", model: "fixture-model", fetch: toMock }),
  },
];

const EXPECTED_INTENT = {
  action: "place",
  side: "buy",
  symbol: "BTC-USD",
  amount: { absolute: "0.1" },
  order_type: "limit",
  price: { absolute: "64000" },
};

for (const spec of SPECS) {
  describe(`${spec.name} against a mock server`, () => {
    let fixtures: Record<string, unknown> = {};
    beforeAll(async () => {
      fixtures = await loadFixture(spec.file);
    });
    const reply = (key: string): void => {
      handler = () => Response.json(fixtures[key]);
    };

    test("success: posts to the expected path and returns the parsed intent", async () => {
      reply("success");
      const result = await spec.make().completeJson(request());
      expect(result).toEqual(EXPECTED_INTENT);
      expect(IntentSchema.safeParse(result).success).toBe(true);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.path).toBe(spec.path);
      expect(JSON.stringify(recorded[0]?.body)).toContain(PROMPT_MARKER);
    });

    test("malformed JSON: a 200 body that is not JSON is LlmBadOutput", async () => {
      handler = () => new Response(`<html>${PROMPT_MARKER} ${API_KEY}</html>`, { status: 200 });
      const error = await thrown(spec.make().completeJson(request()));
      expect(error).toBeInstanceOf(LlmBadOutput);
      expectNoLeak(error);
    });

    test("malformed JSON: model text that is not JSON is LlmBadOutput and is not quoted", async () => {
      reply("textNotJson");
      const error = await thrown(spec.make().completeJson(request()));
      expect(error).toBeInstanceOf(LlmBadOutput);
      expect(error.message).not.toContain("buy btc");
      expectNoLeak(error);
    });

    test("schema violation: a wrong envelope or empty text is LlmBadOutput", async () => {
      for (const key of ["wrongEnvelope", "emptyText", "truncated"]) {
        reply(key);
        const error = await thrown(spec.make().completeJson(request()));
        expect(error).toBeInstanceOf(LlmBadOutput);
        expectNoLeak(error);
      }
    });

    test("schema violation: valid JSON of the wrong shape is returned unvalidated, and the intent schema rejects it", async () => {
      reply("schemaViolation");
      const result = await spec.make().completeJson(request());
      expect(IntentSchema.safeParse(result).success).toBe(false);
    });

    if (spec.refusal) {
      test("a refusal is LlmRefused", async () => {
        reply("refusal");
        const error = await thrown(spec.make().completeJson(request()));
        expect(error).toBeInstanceOf(LlmRefused);
        expectNoLeak(error);
      });
    }

    test("timeout: a slow server is LlmTimeout within the injected limit", async () => {
      handler = async () => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return Response.json(fixtures["success"]);
      };
      const started = performance.now();
      const error = await thrown(spec.make().completeJson(request({ timeoutMs: 30 })));
      expect(error).toBeInstanceOf(LlmTimeout);
      expect(performance.now() - started).toBeLessThan(380);
      expectNoLeak(error);
    });

    test("a caller abort is LlmUnavailable, not LlmTimeout", async () => {
      handler = async () => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return Response.json(fixtures["success"]);
      };
      const controller = new AbortController();
      const pending = thrown(spec.make().completeJson(request({ signal: controller.signal })));
      setTimeout(() => controller.abort(), 20);
      const error = await pending;
      expect(error).toBeInstanceOf(LlmUnavailable);
      expectNoLeak(error);
    });

    for (const status of [400, 401, 403, 404, 429, 500, 502, 503]) {
      // NVIDIA retries a 400 once without nvext; the final error is still the 400.
      test(`HTTP ${status} is LlmUnavailable with that status; the error body is not quoted`, async () => {
        handler = () =>
          Response.json({ error: { message: `bad key ${API_KEY} for prompt ${PROMPT_MARKER} ${SYSTEM_MARKER}` } }, { status });
        const error = await thrown(spec.make().completeJson(request()));
        expect(error).toBeInstanceOf(LlmUnavailable);
        expect((error as LlmUnavailable).status).toBe(status);
        expectNoLeak(error);
      });
    }

    test("a network failure is LlmUnavailable and leaks neither the key nor the prompt", async () => {
      const failing = async (): Promise<Response> => {
        throw new TypeError(`connect ECONNREFUSED Bearer ${API_KEY}`);
      };
      const make: Record<string, () => JsonLlmProvider> = {
        openai: () => createOpenAiJsonProvider({ apiKey: API_KEY, model: "m", fetch: failing }),
        anthropic: () => createAnthropicProvider({ apiKey: API_KEY, model: "m", fetch: failing }),
        nvidia: () => createNvidiaProvider({ apiKey: API_KEY, model: "m", fetch: failing, baseUrl: "https://nim.example.test/v1" }),
        ollama: () => createOllamaProvider({ baseUrl: "http://ollama.example.test", model: "m", fetch: failing }),
      };
      const error = await thrown((make[spec.name] as () => JsonLlmProvider)().completeJson(request()));
      expect(error).toBeInstanceOf(LlmUnavailable);
      expectNoLeak(error);
    });
  });
}

describe("provider-specific requests", () => {
  test("openai: strict json_schema format, bearer key, store false", async () => {
    handler = () => Response.json((fixturesCache["openai"] as Record<string, unknown>)["success"]);
    await createOpenAiJsonProvider({ apiKey: API_KEY, model: "fixture-model", fetch: toMock }).completeJson(request());
    const call = recorded[0];
    expect(call?.headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(call?.body["store"]).toBe(false);
    expect(call?.body["max_output_tokens"]).toBe(500);
    expect(call?.body["text"]).toEqual({
      format: { type: "json_schema", name: INTENT_SCHEMA_NAME, strict: true, schema: INTENT_JSON_SCHEMA },
    });
  });

  test("anthropic: x-api-key, version header, output_config.format, no forced tool use", async () => {
    handler = () => Response.json((fixturesCache["anthropic"] as Record<string, unknown>)["success"]);
    await createAnthropicProvider({ apiKey: API_KEY, model: "fixture-model", fetch: toMock }).completeJson(request());
    const call = recorded[0];
    expect(call?.headers.get("x-api-key")).toBe(API_KEY);
    expect(call?.headers.get("anthropic-version")).toBe(ANTHROPIC_VERSION);
    expect(call?.headers.get("authorization")).toBeNull();
    expect(call?.body["output_config"]).toEqual({ format: { type: "json_schema", schema: INTENT_JSON_SCHEMA } });
    expect(call?.body["tools"]).toBeUndefined();
    expect(call?.body["tool_choice"]).toBeUndefined();
    expect(call?.body["max_tokens"]).toBe(500);
  });

  test("nvidia: guided_json and json_object on the first request, bearer key", async () => {
    handler = () => Response.json((fixturesCache["nvidia"] as Record<string, unknown>)["success"]);
    await createNvidiaProvider({ apiKey: API_KEY, model: "fixture-model", fetch: toMock, baseUrl: "https://nim.example.test/v1" }).completeJson(
      request(),
    );
    expect(recorded).toHaveLength(1);
    const call = recorded[0];
    expect(call?.headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(call?.body["nvext"]).toEqual({ guided_json: INTENT_JSON_SCHEMA });
    expect(call?.body["response_format"]).toEqual({ type: "json_object" });
  });

  for (const status of [400, 422]) {
    test(`nvidia: HTTP ${status} on nvext retries once without nvext, with the schema in the system prompt`, async () => {
      let n = 0;
      handler = () => {
        n += 1;
        return n === 1
          ? Response.json({ error: "nvext not supported" }, { status })
          : Response.json((fixturesCache["nvidia"] as Record<string, unknown>)["success"]);
      };
      const result = await createNvidiaProvider({
        apiKey: API_KEY,
        model: "fixture-model",
        fetch: toMock,
        baseUrl: "https://nim.example.test/v1",
      }).completeJson(request());
      expect(result).toEqual(EXPECTED_INTENT);
      expect(recorded).toHaveLength(2);
      expect(recorded[1]?.body["nvext"]).toBeUndefined();
      const messages = recorded[1]?.body["messages"] as { role: string; content: string }[];
      expect(messages[0]?.content).toContain("JSON Schema");
    });
  }

  test("nvidia: a 500 is not retried", async () => {
    handler = () => new Response("down", { status: 500 });
    const error = await thrown(
      createNvidiaProvider({ apiKey: API_KEY, model: "m", fetch: toMock, baseUrl: "https://nim.example.test/v1" }).completeJson(request()),
    );
    expect(error).toBeInstanceOf(LlmUnavailable);
    expect(recorded).toHaveLength(1);
  });

  test("ollama: no key or auth header, stream false, schema in format, temperature 0", async () => {
    handler = () => Response.json((fixturesCache["ollama"] as Record<string, unknown>)["success"]);
    await createOllamaProvider({ baseUrl: "http://ollama.example.test/", model: "fixture-model", fetch: toMock }).completeJson(request());
    const call = recorded[0];
    expect(call?.headers.get("authorization")).toBeNull();
    expect(call?.body["stream"]).toBe(false);
    expect(call?.body["format"]).toEqual(INTENT_JSON_SCHEMA);
    expect(call?.body["options"]).toEqual({ num_predict: 500, temperature: 0 });
  });

  test("nvidia and ollama refuse a base URL with embedded credentials", () => {
    expect(() => createNvidiaProvider({ apiKey: API_KEY, model: "m", fetch: toMock, baseUrl: "https://user:pw@nim.example.test/v1" })).toThrow();
    expect(() => createOllamaProvider({ baseUrl: "http://user:pw@ollama.example.test", model: "m", fetch: toMock })).toThrow();
  });
});

// Fixtures for the provider-specific block, loaded once.
const fixturesCache: Record<string, Record<string, unknown>> = {};
beforeAll(async () => {
  fixturesCache["openai"] = await loadFixture("openai.responses.json");
  fixturesCache["anthropic"] = await loadFixture("anthropic.messages.json");
  fixturesCache["nvidia"] = await loadFixture("nvidia.chat.json");
  fixturesCache["ollama"] = await loadFixture("ollama.chat.json");
});
