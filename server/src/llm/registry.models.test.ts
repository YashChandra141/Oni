// Registry against a mock /api/tags (Task 19.6, Req 38.1 to 38.5, 38.10, 38.20).
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { FAKE_OL_URL, FakeTags, modelConfig, ollamaFactories, tagsBody } from "./modelTesting.ts";
import { createProviderRegistry } from "./registry.ts";

function make(tags: FakeTags, clock = { now: 1000 }, built: string[] = []) {
  const r = createProviderRegistry({
    config: modelConfig(),
    factories: ollamaFactories(built),
    fetch: tags.fetch,
    now: () => clock.now,
  });
  return r;
}
const models = (r: ReturnType<typeof make>) => r.info().find((p) => p.id === "ollama")?.models ?? [];
const avail = (r: ReturnType<typeof make>) => r.info().find((p) => p.id === "ollama")?.available;

describe("registry /api/tags", () => {
  test("a valid list is exposed with metadata and makes ollama available", async () => {
    const t = new FakeTags();
    t.names = ["fake-a", "fake-b"];
    const r = make(t);
    await r.refresh();
    expect(t.urls).toEqual([`${FAKE_OL_URL}/api/tags`]);
    expect(models(r)).toEqual([
      { name: "fake-a", size: 100, family: "fam", parameter_size: "1B" },
      { name: "fake-b", size: 100, family: "fam", parameter_size: "1B" },
    ]);
    expect(avail(r)).toBe(true);
    expect(r.hasModel("fake-a")).toBe(true);
    expect(r.hasModel("nope")).toBe(false);
  });

  test("an empty list is unavailable", async () => {
    const t = new FakeTags();
    const r = make(t);
    await r.refresh();
    expect(models(r)).toEqual([]);
    expect(avail(r)).toBe(false);
    expect(r.chooseOllamaModel()).toBeUndefined();
  });

  test("101 models fail the whole probe", async () => {
    const t = new FakeTags();
    t.names = Array.from({ length: 101 }, (_, i) => `m${i}`);
    const r = make(t);
    await r.refresh();
    expect(models(r)).toEqual([]);
    expect(avail(r)).toBe(false);
  });

  test("100 models are accepted", async () => {
    const t = new FakeTags();
    t.names = Array.from({ length: 100 }, (_, i) => `m${i}`);
    const r = make(t);
    await r.refresh();
    expect(models(r).length).toBe(100);
  });

  test("a bad name is dropped, others kept", async () => {
    const t = new FakeTags();
    t.names = ["good", "bad name", "also-good"];
    const r = make(t);
    await r.refresh();
    expect(models(r).map((m) => m.name)).toEqual(["good", "also-good"]);
    expect(avail(r)).toBe(true);
  });

  test("HTTP 500, malformed JSON, and a timeout each clear the list", async () => {
    for (const mode of ["500", "badjson", "timeout"] as const) {
      const t = new FakeTags();
      t.names = ["fake-a"];
      const clock = { now: 1000 };
      const r = make(t, clock);
      await r.refresh();
      expect(avail(r)).toBe(true);
      if (mode === "500") t.ok = false;
      if (mode === "badjson") t.fail = "badjson";
      if (mode === "timeout") t.fail = "throw";
      clock.now += 30_000;
      await r.refresh();
      expect(models(r)).toEqual([]);
      expect(avail(r)).toBe(false);
    }
  });

  test("a wrong-shaped body fails the probe", async () => {
    const t = new FakeTags();
    t.body = { models: "x" };
    const r = make(t);
    await r.refresh();
    expect(avail(r)).toBe(false);
  });

  test("re-checks at most every 30 s with a fake clock", async () => {
    const t = new FakeTags();
    t.names = ["fake-a"];
    const clock = { now: 5000 };
    const r = make(t, clock);
    await r.refresh();
    t.names = ["fake-b"];
    clock.now += 29_999;
    await r.refresh();
    expect(t.urls.length).toBe(1);
    expect(r.hasModel("fake-a")).toBe(true);
    clock.now += 1;
    await r.refresh();
    expect(t.urls.length).toBe(2);
    expect(r.hasModel("fake-a")).toBe(false);
    expect(r.hasModel("fake-b")).toBe(true);
  });

  test("concurrent refreshes share one probe", async () => {
    const t = new FakeTags();
    t.names = ["fake-a"];
    const r = make(t);
    await Promise.all([r.refresh(), r.refresh(), r.refresh()]);
    expect(t.urls.length).toBe(1);
  });

  test("onModelsChanged fires only on a change, and unsubscribe stops it", async () => {
    const t = new FakeTags();
    t.names = ["fake-a"];
    const clock = { now: 0 };
    const r = make(t, clock);
    let calls = 0;
    const off = r.onModelsChanged(() => void (calls += 1));
    await r.refresh();
    expect(calls).toBe(1);
    clock.now += 30_000;
    await r.refresh(); // same list
    expect(calls).toBe(1);
    t.names = ["fake-a", "fake-b"];
    clock.now += 30_000;
    await r.refresh();
    expect(calls).toBe(2);
    off();
    t.names = [];
    clock.now += 30_000;
    await r.refresh();
    expect(calls).toBe(2);
  });

  test("a throwing listener does not break the probe or other listeners", async () => {
    const t = new FakeTags();
    t.names = ["fake-a"];
    const r = make(t);
    let second = 0;
    r.onModelsChanged(() => {
      throw new Error("boom");
    });
    r.onModelsChanged(() => void (second += 1));
    await r.refresh();
    expect(second).toBe(1);
    expect(avail(r)).toBe(true);
  });

  test("get(ollama, model) builds one provider per installed model and refuses unknown ones", async () => {
    const t = new FakeTags();
    t.names = ["fake-a", "fake-b"];
    const built: string[] = [];
    const r = make(t, { now: 0 }, built);
    await r.refresh();
    const a = r.get("ollama", "fake-a");
    expect(a?.model).toBe("fake-a");
    expect(r.get("ollama", "fake-a")).toBe(a);
    expect(r.get("ollama", "fake-b")?.model).toBe("fake-b");
    expect(r.get("ollama", "missing")).toBeUndefined();
    expect(built).toEqual(["fake-a", "fake-b"]);
  });
});

describe("no list or URL in logs", () => {
  const spies: { mockRestore(): void }[] = [];
  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
  });

  test("probing writes nothing to the console, success or failure", async () => {
    const lines: string[] = [];
    for (const k of ["log", "info", "warn", "error", "debug"] as const) {
      spies.push(spyOn(console, k).mockImplementation((...a: unknown[]) => void lines.push(a.join(" "))));
    }
    const t = new FakeTags();
    t.names = ["secret-model-name"];
    const clock = { now: 0 };
    const r = make(t, clock);
    await r.refresh();
    t.fail = "throw";
    clock.now += 30_000;
    await r.refresh();
    t.fail = "none";
    t.body = tagsBody(["x"].concat(Array.from({ length: 200 }, (_, i) => `m${i}`)));
    clock.now += 30_000;
    await r.refresh();
    expect(lines.join("\n")).not.toContain("secret-model-name");
    expect(lines.join("\n")).not.toContain("ollama.fake.example");
    expect(lines).toEqual([]);
  });
});

describe("uninstalled OLLAMA_MODEL default", () => {
  test("get('ollama') without a model builds the first installed model, and info() reports it", async () => {
    const t = new FakeTags();
    t.names = ["fake-a", "fake-b"];
    const built: string[] = [];
    const r = make(t, { now: 1000 }, built);
    await r.refresh();
    expect(r.get("ollama")?.model).toBe("fake-a");
    expect(built).toEqual(["fake-a"]);
    expect(r.info().find((p) => p.id === "ollama")?.model).toBe("fake-a");
  });

  test("get('ollama') is undefined when nothing is installed", async () => {
    const r = make(new FakeTags());
    await r.refresh();
    expect(r.get("ollama")).toBeUndefined();
  });
});
