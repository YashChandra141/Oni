// Property 52 and gateway examples for set_model (Task 19.6, Req 38.9 to 38.14).
// **Validates: Requirements 38.9, 38.10, 38.11**
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { PreviewStore } from "../commands/previews.ts";
import { FakeTags, modelConfig, ollamaFactories } from "../llm/modelTesting.ts";
import { LlmOrderParser } from "../llm/parser.ts";
import { createProviderRegistry, type ProviderRegistry } from "../llm/registry.ts";
import type { ServerMessage } from "../protocol.ts";
import { FakePublisher, FakeSocket, FakeSupervisor, memoryLogger, settle, waitUntil } from "./testing.ts";
import { type AiDeps, type CommandBar, Gateway } from "./ws.ts";

type Models = Extract<ServerMessage, { type: "ollama_models" }>;

function setup(names: string[], base = "base-model") {
  const tags = new FakeTags();
  tags.names = names;
  const clock = { now: 0 };
  const registry = createProviderRegistry({
    config: modelConfig(base),
    factories: ollamaFactories(),
    fetch: tags.fetch,
    now: () => clock.now,
  });
  const getCalls: [string, string | undefined][] = [];
  const spy: AiDeps["registry"] = {
    info: () => registry.info(),
    defaultId: () => registry.defaultId(),
    refresh: () => registry.refresh(),
    hasModel: (n) => registry.hasModel(n),
    chooseOllamaModel: (p) => registry.chooseOllamaModel(p),
    onModelsChanged: (l) => registry.onModelsChanged(l),
    get: ((id: Parameters<ProviderRegistry["get"]>[0], model?: string) => {
      getCalls.push([id, model]);
      return registry.get(id, model);
    }) as ProviderRegistry["get"],
  };
  const forgotten: string[] = [];
  const supervisor = new FakeSupervisor();
  const publisher = new FakePublisher();
  let n = 0;
  const gateway = new Gateway({
    supervisor,
    config: { dataMode: "replay", liveVenue: "backpack" },
    logger: memoryLogger(),
    randomUUID: () => `client-${++n}`,
  });
  gateway.setPublisher(publisher);
  gateway.setAi({
    registry: spy,
    limiter: { acquire: () => ({ ok: true }) as never, release: () => {}, forget: (id) => void forgotten.push(id) },
    accounts: { positions: () => [], balance: () => null } as never,
  });
  const connect = (): FakeSocket => {
    const ws = new FakeSocket();
    publisher.sockets.add(ws);
    gateway.open(ws);
    return ws;
  };
  const send = (ws: FakeSocket, msg: unknown) => gateway.message(ws, JSON.stringify(msg));
  const setModel = (ws: FakeSocket, model: string) => send(ws, { type: "set_model", provider: "ollama", model });
  return { tags, clock, registry, spy, getCalls, forgotten, gateway, connect, send, setModel };
}

const lastModels = (ws: FakeSocket): Models | undefined =>
  ws.messages().filter((m): m is Models => m.type === "ollama_models").at(-1);
const notices = (ws: FakeSocket) => ws.messages().filter((m) => m.type === "notice");

const alphabet = fc.constantFrom("m1", "m2", "m3", "base-model", "z.z:1");
const requested = fc.oneof(alphabet, fc.constantFrom("nope", "", "a b", "x".repeat(200)));

describe("P52 set_model", () => {
  test("accepted iff the name is in the list; otherwise model_unknown and the selection is unchanged", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uniqueArray(alphabet, { maxLength: 5 }), requested, requested, async (namesIn, first, second) => {
        const names: readonly string[] = namesIn;
        const s = setup([...names]);
        const ws = s.connect();
        s.setModel(ws, first);
        const inList1 = names.includes(first);
        const sawFirst = await waitUntil(() => (inList1 ? lastModels(ws) !== undefined : notices(ws).length === 1));
        expect(sawFirst).toBe(true);
        if (inList1) expect(lastModels(ws)?.selected).toBe(first);
        else expect(notices(ws)[0]).toMatchObject({ kind: "model_unknown" });
        const before = inList1 ? first : null;

        const noticesBefore = notices(ws).length;
        const modelsBefore = ws.messages().filter((m) => m.type === "ollama_models").length;
        s.setModel(ws, second);
        const inList2 = names.includes(second);
        await waitUntil(() =>
          inList2
            ? ws.messages().filter((m) => m.type === "ollama_models").length > modelsBefore
            : notices(ws).length > noticesBefore,
        );
        if (inList2) {
          expect(lastModels(ws)?.selected).toBe(second);
        } else {
          expect(notices(ws).at(-1)).toMatchObject({ kind: "model_unknown" });
          // Observe the selection through a list change that keeps every name.
          s.tags.names = [...names, "m-extra"];
          s.clock.now += 30_000;
          await s.registry.refresh();
          expect(lastModels(ws)?.selected).toBe(before);
        }
      }),
      { numRuns: 60 },
    );
  });
});

describe("gateway Ollama model examples", () => {
  test("accepts an installed model and rejects an unknown one without echoing it", async () => {
    const s = setup(["fake-a", "fake-b"]);
    const ws = s.connect();
    s.setModel(ws, "fake-b");
    expect(await waitUntil(() => lastModels(ws) !== undefined)).toBe(true);
    expect(lastModels(ws)).toMatchObject({ selected: "fake-b", default: "fake-a" });
    s.setModel(ws, "secret-unknown");
    expect(await waitUntil(() => notices(ws).length === 1)).toBe(true);
    expect(notices(ws)[0]).toMatchObject({ kind: "model_unknown" });
    expect(JSON.stringify(ws.messages())).not.toContain("secret-unknown");
  });

  test("a non-ollama provider is rejected", async () => {
    const s = setup(["fake-a"]);
    const ws = s.connect();
    s.send(ws, { type: "set_model", provider: "openai", model: "fake-a" });
    expect(await waitUntil(() => notices(ws).length === 1)).toBe(true);
    expect(notices(ws)[0]).toMatchObject({ kind: "model_unknown" });
  });

  test("a changed list is broadcast to every client, and a vanished selection falls back", async () => {
    const s = setup(["fake-a", "fake-b"]);
    const a = s.connect();
    const b = s.connect();
    s.setModel(a, "fake-b");
    expect(await waitUntil(() => lastModels(a)?.selected === "fake-b")).toBe(true);
    const bBefore = b.messages().filter((m) => m.type === "ollama_models").length;

    s.tags.names = ["fake-a", "fake-c"];
    s.clock.now += 30_000;
    await s.registry.refresh();
    expect(lastModels(a)).toMatchObject({ selected: null, default: "fake-a" });
    expect(lastModels(a)?.models.map((m) => m.name)).toEqual(["fake-a", "fake-c"]);
    expect(b.messages().filter((m) => m.type === "ollama_models").length).toBe(bBefore + 1);

    // No change, no broadcast.
    const aCount = a.messages().filter((m) => m.type === "ollama_models").length;
    s.clock.now += 30_000;
    await s.registry.refresh();
    expect(a.messages().filter((m) => m.type === "ollama_models").length).toBe(aCount);
    // The fallback choice for requests is now the default model.
    expect(s.registry.chooseOllamaModel(undefined)).toBe("fake-a");
  });

  test("a request uses registry.get('ollama', selected model)", async () => {
    const s = setup(["fake-a", "fake-b"]);
    const previews = new PreviewStore({ now: () => 1, newId: () => "p1" });
    const router: CommandBar["router"] = {
      submit: () => ({ ok: true, orderId: "o" }),
      cancelAll: () => ({ ok: true }),
      flattenAll: () => ({ ok: true, results: [] }),
    };
    // The parser reads the registry through the gateway's spy so the call is recorded.
    const llm = new LlmOrderParser({ registry: s.spy, positionLots: () => 0n, lastPrice: () => null });
    s.gateway.setCommandBar({ previews, accounts: { positionLots: () => 0n }, router, llm });
    const ws = s.connect();
    s.send(ws, { type: "set_provider", provider: "ollama" });
    expect(await waitUntil(() => ws.messages().some((m) => m.type === "providers"))).toBe(true);
    s.setModel(ws, "fake-b");
    expect(await waitUntil(() => lastModels(ws)?.selected === "fake-b")).toBe(true);
    s.getCalls.length = 0;
    s.send(ws, { type: "command_text", request_id: "r1", text: "? buy something" });
    expect(await waitUntil(() => s.getCalls.some(([id, m]) => id === "ollama" && m === "fake-b"))).toBe(true);
  });

  test("closing the connection drops its selection and forgets its limiter state", async () => {
    const s = setup(["fake-a", "fake-b"]);
    const ws = s.connect();
    s.setModel(ws, "fake-b");
    expect(await waitUntil(() => lastModels(ws)?.selected === "fake-b")).toBe(true);
    s.gateway.close(ws);
    expect(s.forgotten).toEqual(["client-1"]);
    // A new connection starts with no selection.
    const ws2 = s.connect();
    s.tags.names = ["fake-a", "fake-b", "fake-c"];
    s.clock.now += 30_000;
    await s.registry.refresh();
    await settle(1);
    expect(lastModels(ws2)?.selected).toBeNull();
    // The closed socket gets nothing more.
    const count = ws.messages().length;
    s.tags.names = ["fake-a"];
    s.clock.now += 30_000;
    await s.registry.refresh();
    expect(ws.messages().length).toBe(count);
  });
});
