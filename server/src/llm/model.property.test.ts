// Property 53: the model fallback selection rule (Req 38.12, 38.13).
// preferred if installed, else OLLAMA_MODEL if installed, else the first installed, else none.
// **Validates: Requirements 38.12, 38.13**
// Also checks the /api/chat body and the parser's use of the selected model (Req 38.9, 38.19).
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { FakeTags, modelConfig, ollamaFactories } from "./modelTesting.ts";
import { LlmOrderParser } from "./parser.ts";
import { createOllamaProvider } from "./ollama.ts";
import { createProviderRegistry } from "./registry.ts";

const name = fc.constantFrom("m1", "m2", "m3", "m4", "base-model", "z.z:1");

describe("P53 chooseOllamaModel", () => {
  test("follows the fallback rule for any list, default, and preference", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(name, { maxLength: 6 }),
        name,
        fc.option(name, { nil: undefined }),
        async (installed, base, preferred) => {
          const t = new FakeTags();
          t.names = installed;
          const r = createProviderRegistry({
            config: modelConfig(base),
            factories: ollamaFactories(),
            fetch: t.fetch,
            now: () => 0,
          });
          await r.refresh();
          const expected =
            preferred !== undefined && installed.includes(preferred)
              ? preferred
              : installed.includes(base)
                ? base
                : installed[0];
          expect(r.chooseOllamaModel(preferred)).toBe(expected);
        },
      ),
      { numRuns: 150 },
    );
  });
});

describe("selected model reaches /api/chat", () => {
  test("the provider built for a model sends that model and nothing else from the list", async () => {
    const bodies: { model: string; messages: { content: string }[] }[] = [];
    const t = new FakeTags();
    t.names = ["alpha-one", "zulu-nine"];
    const r = createProviderRegistry({
      config: modelConfig("alpha-one"),
      factories: {
        ollama: (c, o) =>
          createOllamaProvider({
            baseUrl: c.ollamaBaseUrl,
            model: o?.ollamaModel ?? c.ollamaModel,
            fetch: async (url, init) => {
              expect(url.endsWith("/api/chat")).toBe(true);
              bodies.push(JSON.parse(String(init.body)));
              return new Response(JSON.stringify({ message: { content: '{"action":"unclear"}' } }), { status: 200 });
            },
          }),
      },
      fetch: t.fetch,
      now: () => 0,
    });
    await r.refresh();
    const parser = new LlmOrderParser({ registry: r, positionLots: () => 0n, lastPrice: () => null });

    await parser.parse("buy something", "guest", "ollama", "zulu-nine");
    await parser.parse("buy something", "guest", "ollama");
    await parser.parse("buy something", "guest", "ollama", "not-installed");
    expect(bodies.map((b) => b.model)).toEqual(["zulu-nine", "alpha-one", "alpha-one"]);
    // The prompt text never carries a model name from the list.
    for (const b of bodies) {
      const text = b.messages.map((m) => m.content).join("\n");
      expect(text).not.toContain("zulu-nine");
      expect(text).not.toContain("alpha-one");
    }
  });
});
