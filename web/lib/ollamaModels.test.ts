// Ollama model picker helpers (Task 19.6, Req 38.15 to 38.17).
import { describe, expect, test } from "bun:test";
import type { OllamaModel } from "../../shared/protocol/index";
import { formatBytes, formatModelLabel, reapplyStored } from "./ollamaModels";

const m = (name: string, over: Partial<OllamaModel> = {}): OllamaModel => ({
  name,
  size: 0,
  family: null,
  parameter_size: null,
  ...over,
});

describe("formatBytes (base 1000)", () => {
  test.each([
    [0, "0 B"],
    [999, "999 B"],
    [1000, "1.0 KB"],
    [1_500_000, "1.5 MB"],
    [4_300_000_000, "4.3 GB"],
    [2_000_000_000_000, "2.0 TB"],
    [-1, "?"],
    [Number.NaN, "?"],
    [Number.POSITIVE_INFINITY, "?"],
  ])("%p -> %p", (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });
});

describe("formatModelLabel", () => {
  test("joins name, family, parameter size, and size", () => {
    expect(formatModelLabel(m("fake-a", { size: 4_300_000_000, family: "fam", parameter_size: "7B" }))).toBe(
      "fake-a · fam · 7B · 4.3 GB",
    );
  });
  test("skips null and empty parts", () => {
    expect(formatModelLabel(m("fake-b", { size: 1000 }))).toBe("fake-b · 1.0 KB");
    expect(formatModelLabel(m("fake-c", { family: "", parameter_size: "", size: 5 }))).toBe("fake-c · 5 B");
  });
});

describe("reapplyStored", () => {
  const list = [m("fake-a"), m("fake-b")];
  test("returns the stored name only when listed", () => {
    expect(reapplyStored(list, "fake-b")).toBe("fake-b");
    expect(reapplyStored(list, "gone")).toBeNull();
    expect(reapplyStored(list, null)).toBeNull();
    expect(reapplyStored([], "fake-a")).toBeNull();
  });
});

describe("localModelValue / firstOtherProvider", () => {
  test("shows None unless ollama is active", async () => {
    const { localModelValue } = await import("./ollamaModels");
    expect(localModelValue("nvidia", "gemma3:1b", "gemma3:1b")).toBe("");
    expect(localModelValue(null, null, "x")).toBe("");
  });
  test("shows the model when ollama is active", async () => {
    const { localModelValue } = await import("./ollamaModels");
    expect(localModelValue("ollama", "a", "b")).toBe("a");
    expect(localModelValue("ollama", null, "b")).toBe("b");
  });
  test("picks first available non-ollama provider", async () => {
    const { firstOtherProvider } = await import("./ollamaModels");
    const p = (id: string, reason: string | null) => ({ id, reason });
    expect(firstOtherProvider([p("ollama", null), p("openai", "no key"), p("nvidia", null)])).toBe("nvidia");
    expect(firstOtherProvider([p("ollama", null)])).toBeNull();
  });
});
