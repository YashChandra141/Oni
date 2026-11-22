import { describe, expect, test } from "bun:test";
import { GuardedFetchError } from "../net/http.ts";
import { createOllamaProvider } from "./ollama.ts";
import { LlmTimeout, LlmUnavailable, type JsonRequest } from "./provider.ts";

const request = (timeoutMs: number): JsonRequest => ({
  system: "s",
  user: "u",
  schemaName: "x",
  schema: { type: "object" },
  maxOutputTokens: 10,
  timeoutMs,
});

describe("ollama timeouts", () => {
  test("passes its own timeout plus a margin to fetch", async () => {
    let seen: unknown;
    const provider = createOllamaProvider({
      baseUrl: "http://ollama.example.test",
      model: "m",
      fetch: async (_url, init) => {
        seen = init.timeoutMs;
        return Response.json({ message: { content: "{}" } });
      },
    });
    await provider.completeJson(request(60_000));
    expect(seen).toBe(61_000);
  });

  test("a guarded-fetch timeout maps to LlmTimeout", async () => {
    const provider = createOllamaProvider({
      baseUrl: "http://ollama.example.test",
      model: "m",
      fetch: async () => {
        throw new GuardedFetchError("timeout", "timed out");
      },
    });
    expect(provider.completeJson(request(60_000))).rejects.toBeInstanceOf(LlmTimeout);
  });

  test("a refused host maps to a safe LlmUnavailable", async () => {
    const provider = createOllamaProvider({
      baseUrl: "http://ollama.example.test",
      model: "m",
      fetch: async () => {
        throw new GuardedFetchError("refused", "refused");
      },
    });
    expect(provider.completeJson(request(1000))).rejects.toBeInstanceOf(LlmUnavailable);
  });
});
