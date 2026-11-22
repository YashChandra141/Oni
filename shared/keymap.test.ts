// Unit tests for the shared keymap loader (design §4, Req 32.1, 32.3, 32.4).
import { describe, expect, test } from "bun:test";
import defaultKeymap, {
  forClient,
  keyFromEvent,
  keymap,
  loadKeymap,
  normalizeKey,
  resolve,
} from "./keymap.ts";

function errorsOf(json: unknown): readonly string[] {
  const r = loadKeymap(json);
  if (r.ok) throw new Error("expected loadKeymap to fail");
  return r.errors;
}

describe("bundled keymap.json", () => {
  test("loads and is the default export", () => {
    expect(defaultKeymap).toBe(keymap);
    expect(keymap.version).toBe(1);
    expect(resolve(keymap, "global", "B")).toBe("order.buy");
    expect(resolve(keymap, "global", "P")).toBe("auth.pair");
    expect(resolve(keymap, "global", "Q")).toBe("app.quit");
    expect(resolve(keymap, "global", "Shift+Tab")).toBe("symbol.prev");
    expect(resolve(keymap, "chart", "+")).toBe("chart.zoom_in");
    expect(resolve(keymap, "orders", "Delete")).toBe("order.cancel");
    expect(resolve(keymap, "dialog", "y")).toBe("dialog.confirm");
  });

  // JSON.parse keeps only the last of two identical raw keys, so check the raw text too (Req 32.4).
  test("raw file has no duplicate normalized key in any object", async () => {
    const text = await Bun.file(new URL("./keymap.json", import.meta.url)).text();
    // Walk the text so repeated raw keys in one object are seen (JSON.parse keeps the last one).
    const tokens = text.matchAll(/"((?:[^"\\]|\\.)*)"\s*:|[{}]|"(?:[^"\\]|\\.)*"/g);
    const stack: string[][] = [];
    const finished: string[][] = [];
    for (const m of tokens) {
      if (m[0] === "{") stack.push([]);
      else if (m[0] === "}") finished.push(stack.pop() ?? []);
      else if (m[1] !== undefined) stack[stack.length - 1]?.push(m[1]);
    }
    expect(stack.length).toBe(0);
    expect(finished.length).toBeGreaterThan(6);
    for (const keys of finished) {
      // Action names and "web"/"tui" do not normalize to a key, so only real key spellings count.
      const normalized = keys.map((k) => normalizeKey(k) ?? `raw:${k}`);
      const dupes = normalized.filter((k, i) => normalized.indexOf(k) !== i);
      expect({ keys, dupes }).toEqual({ keys, dupes: [] });
    }
    // Per client and context, the loader rejects any duplicate normalized key (Req 32.4).
    expect(loadKeymap(JSON.parse(text)).ok).toBe(true);
  });
});

describe("normalizeKey", () => {
  test("letters are case-insensitive", () => {
    expect(normalizeKey("b")).toBe("B");
    expect(normalizeKey("B")).toBe("B");
    expect(normalizeKey("shift+b")).toBe("Shift+B");
  });

  test("modifier order and spelling are normalized", () => {
    expect(normalizeKey("shift+tab")).toBe("Shift+Tab");
    expect(normalizeKey("Shift+Ctrl+x")).toBe("Ctrl+Shift+X");
    expect(normalizeKey("control+alt+Delete")).toBe("Ctrl+Alt+Delete");
  });

  test("named keys and symbols keep one spelling", () => {
    expect(normalizeKey("ArrowUp")).toBe("Up");
    expect(normalizeKey("up")).toBe("Up");
    expect(normalizeKey("Esc")).toBe("Escape");
    expect(normalizeKey("enter")).toBe("Enter");
    expect(normalizeKey("+")).toBe("+");
    expect(normalizeKey("Shift++")).toBe("Shift++");
    expect(normalizeKey("-")).toBe("-");
    expect(normalizeKey(":")).toBe(":");
    expect(normalizeKey("1")).toBe("1");
    expect(normalizeKey(" ")).toBe("Space");
  });

  test("invalid keys return null", () => {
    expect(normalizeKey("")).toBeNull();
    expect(normalizeKey("Hyper+B")).toBeNull();
    expect(normalizeKey("Shift+Shift+B")).toBeNull();
    expect(normalizeKey("Shift+")).toBeNull();
    expect(normalizeKey("Banana")).toBeNull();
    expect(normalizeKey("é")).toBeNull();
  });

  test("keyFromEvent keeps Shift only for named keys", () => {
    expect(keyFromEvent({ key: "Tab", shiftKey: true })).toBe("Shift+Tab");
    expect(keyFromEvent({ key: ":", shiftKey: true })).toBe(":");
    expect(keyFromEvent({ key: "B", shiftKey: true })).toBe("B");
    expect(keyFromEvent({ key: "ArrowLeft" })).toBe("Left");
  });
});

describe("loadKeymap validation", () => {
  test("rejects a non-object and a wrong version", () => {
    expect(errorsOf(null)).toEqual(["keymap: expected a JSON object"]);
    expect(errorsOf([])).toEqual(["keymap: expected a JSON object"]);
    expect(errorsOf({ version: 2, contexts: {} })).toEqual([`keymap: "version" must be 1`]);
  });

  test("rejects missing contexts and unknown top-level fields", () => {
    expect(errorsOf({ version: 1 })).toEqual([`keymap: "contexts" must be an object`]);
    expect(errorsOf({ version: 1, contexts: {}, extra: 1 })).toEqual([`keymap: unknown field "extra"`]);
  });

  test("rejects an unknown context and non-object bindings", () => {
    expect(errorsOf({ version: 1, contexts: { popup: {} } })).toEqual([`unknown context "popup"`]);
    expect(errorsOf({ version: 1, contexts: { chart: "x" } })).toEqual([
      `context "chart": bindings must be an object`,
    ]);
  });

  test("rejects non-string and unknown actions, naming context and key", () => {
    expect(errorsOf({ version: 1, contexts: { global: { "order.buy": 7 } } })).toEqual([
      `context "global": action "order.buy" must list keys`,
    ]);
    expect(errorsOf({ version: 1, contexts: { global: { "order.buyy": ["B"] } } })).toEqual([
      `context "global": unknown action "order.buyy"`,
    ]);
    expect(errorsOf({ version: 1, contexts: { global: { B: "order.buyy" } } })).toEqual([
      `context "global": key "B" has unknown action "order.buyy"`,
    ]);
  });

  test("rejects an invalid key", () => {
    expect(errorsOf({ version: 1, contexts: { book: { Banana: "book.up" } } })).toEqual([
      `context "book": invalid key "Banana"`,
    ]);
  });

  // Req 32.4
  test("rejects a context that binds the same normalized key twice", () => {
    // Legacy "<key>": "<action>" bindings apply to both clients, so each client reports it.
    expect(errorsOf({ version: 1, contexts: { global: { B: "order.buy", b: "order.sell" } } })).toEqual([
      `context "global" (web): key "b" duplicates "B" (both normalize to "B")`,
      `context "global" (tui): key "b" duplicates "B" (both normalize to "B")`,
    ]);
    expect(
      errorsOf({
        version: 1,
        contexts: { orders: { "orders.up": { web: ["Up"] }, "orders.down": { web: ["ArrowUp"] } } },
      }),
    ).toEqual([`context "orders" (web): key "ArrowUp" duplicates "Up" (both normalize to "Up")`]);
    // The same key may be bound once per client.
    expect(
      loadKeymap({
        version: 1,
        contexts: { global: { "order.buy": { web: ["B"] }, "order.sell": { tui: ["B"] } } },
      }).ok,
    ).toBe(true);
  });

  test("the same key in different contexts is allowed", () => {
    const r = loadKeymap({
      version: 1,
      contexts: { book: { Up: "book.up" }, orders: { Up: "orders.up" } },
    });
    expect(r.ok).toBe(true);
  });
});

describe("resolve", () => {
  test("focused context wins over global, then falls back to global", () => {
    expect(resolve(keymap, "book", "Enter")).toBe("book.prefill");
    expect(resolve(keymap, "dialog", "Enter")).toBe("dialog.confirm");
    expect(resolve(keymap, "book", "B")).toBe("order.buy");
    // Digits are timeframes in the web view and pages in the TUI view.
    expect(resolve(forClient(keymap, "web"), "chart", "1")).toBe("timeframe.1m");
    expect(resolve(keymap, "chart", "1")).toBe("page.1");
    expect(resolve(keymap, "global", "Enter")).toBeNull();
    expect(resolve(keymap, "global", "Z")).toBeNull();
    expect(resolve(keymap, "global", "")).toBeNull();
  });

  test("command focus uses only command bindings, so letters type text", () => {
    expect(resolve(keymap, "command", "Enter")).toBe("command.submit");
    expect(resolve(keymap, "command", "Escape")).toBe("command.blur");
    expect(resolve(keymap, "command", "Up")).toBe("history.prev");
    expect(resolve(keymap, "command", "B")).toBeNull();
    expect(resolve(keymap, "command", "q")).toBeNull();
    expect(resolve(keymap, "command", "1")).toBeNull();
    expect(resolve(keymap, "command", ":")).toBeNull();
  });
});

describe("forClient", () => {
  test("web drops the TUI-only actions, TUI keeps everything", () => {
    const web = forClient(keymap, "web");
    expect(resolve(web, "global", "Q")).toBeNull();
    expect(resolve(web, "global", "P")).toBeNull();
    expect(resolve(web, "global", "B")).toBe("order.buy");
    const webActions = [...web.contexts.global.values()];
    expect(webActions).not.toContain("app.quit");
    expect(webActions).not.toContain("auth.pair");
    expect([...keymap.contexts.global.values()]).toContain("app.quit");
    expect(resolve(web, "global", "Alt+8")).toBe("page.8");
    expect(resolve(web, "global", "6")).toBe("timeframe.1d");
    expect(forClient(keymap, "tui")).toBe(keymap);
  });
});
