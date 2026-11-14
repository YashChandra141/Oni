// Shared keymap loader (design §4, Req 32). Dependency-free so the web UI and
// the server can both import it. The TUI has its own Rust loader with the same
// rules (Task 6.3).
//
// Rules:
// - Keys are normalized before comparison: single letters are case-insensitive,
//   modifiers are put in the order Ctrl+Alt+Shift+Meta, and named keys get one
//   canonical spelling (e.g. "ArrowUp" and "up" both become "Up").
// - A context may bind each normalized key at most once (Req 32.4).
// - Lookup: the focused context first, then `global`. While `command` is
//   focused, only `command` bindings apply, so letters type text.
// - `app.quit` and `auth.pair` are TUI-only; `forClient(keymap, "web")` drops them.
import raw from "./keymap.json" with { type: "json" };

export const CONTEXTS = ["global", "chart", "book", "orders", "command", "dialog"] as const;
export type Context = (typeof CONTEXTS)[number];

export const ACTIONS = [
  "timeframe.1m",
  "timeframe.5m",
  "timeframe.15m",
  "timeframe.1h",
  "timeframe.1d",
  "symbol.next",
  "symbol.prev",
  "order.buy",
  "order.sell",
  "account.flatten",
  "orders.cancel_all",
  "indicator.ema",
  "indicator.vwap",
  "indicator.bollinger",
  "indicator.rsi",
  "indicator.atr",
  "command.focus",
  "auth.pair",
  "app.quit",
  "chart.zoom_in",
  "chart.zoom_out",
  "chart.pan_back",
  "chart.pan_forward",
  "book.up",
  "book.down",
  "book.prefill",
  "orders.up",
  "orders.down",
  "order.cancel",
  "history.prev",
  "history.next",
  "command.submit",
  "command.blur",
  "dialog.confirm",
  "dialog.cancel",
] as const;
export type Action = (typeof ACTIONS)[number];

/** Actions only the TUI handles. The web UI signs in with buttons (Req 47) and cannot quit. */
export const TUI_ONLY_ACTIONS: readonly Action[] = ["app.quit", "auth.pair"];

export type Client = "web" | "tui";

/** A validated keymap. Every context is present; map keys are normalized. */
export interface Keymap {
  readonly version: 1;
  readonly contexts: Readonly<Record<Context, ReadonlyMap<string, Action>>>;
}

export type LoadResult =
  | { readonly ok: true; readonly keymap: Keymap }
  | { readonly ok: false; readonly errors: readonly string[] };

const MODIFIER_ORDER = ["Ctrl", "Alt", "Shift", "Meta"] as const;
type Modifier = (typeof MODIFIER_ORDER)[number];

const MODIFIER_ALIASES: Readonly<Record<string, Modifier>> = {
  ctrl: "Ctrl",
  control: "Ctrl",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
  meta: "Meta",
  cmd: "Meta",
};

const NAMED_KEYS = [
  "Up",
  "Down",
  "Left",
  "Right",
  "Enter",
  "Escape",
  "Tab",
  "Backspace",
  "Delete",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Space",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F12",
] as const;

// Lower-case spelling -> canonical named key, including browser `KeyboardEvent.key` names.
const NAMED_LOOKUP: ReadonlyMap<string, string> = new Map<string, string>([
  ...NAMED_KEYS.map((k): [string, string] => [k.toLowerCase(), k]),
  ["arrowup", "Up"],
  ["arrowdown", "Down"],
  ["arrowleft", "Left"],
  ["arrowright", "Right"],
  ["esc", "Escape"],
  ["return", "Enter"],
  ["del", "Delete"],
]);

function normalizeBase(base: string): string | null {
  if (base === " ") return "Space";
  if (base.length === 1) {
    const code = base.charCodeAt(0);
    // Printable ASCII except space: letters, digits, punctuation such as + - :
    if (code < 0x21 || code > 0x7e) return null;
    return base.toUpperCase();
  }
  return NAMED_LOOKUP.get(base.toLowerCase()) ?? null;
}

/**
 * Normalize a key spelling such as "shift+tab", "b", or "ArrowUp" to its
 * canonical form ("Shift+Tab", "B", "Up"). Returns null for an invalid key.
 */
export function normalizeKey(key: string): string | null {
  if (key.length === 0) return null;
  let base: string;
  let mods: string[];
  if (key === "+") {
    base = "+";
    mods = [];
  } else if (key.endsWith("++")) {
    base = "+";
    mods = key.slice(0, -2).split("+");
  } else {
    const parts = key.split("+");
    base = parts.pop() ?? "";
    mods = parts;
  }
  const seen = new Set<Modifier>();
  for (const m of mods) {
    const mod = MODIFIER_ALIASES[m.toLowerCase()];
    if (mod === undefined || seen.has(mod)) return null;
    seen.add(mod);
  }
  const canonicalBase = normalizeBase(base);
  if (canonicalBase === null) return null;
  const ordered = MODIFIER_ORDER.filter((m) => seen.has(m));
  return [...ordered, canonicalBase].join("+");
}

/**
 * Build a key string from a browser keyboard event. Shift is kept only for
 * named keys (Shift+Tab), because for printable characters it is already
 * reflected in `key` (":" and "+" need Shift on many layouts).
 */
export function keyFromEvent(e: {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
  readonly metaKey?: boolean;
}): string | null {
  const printable = e.key.length === 1 && e.key !== " ";
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey && !printable) mods.push("Shift");
  if (e.metaKey) mods.push("Meta");
  return normalizeKey([...mods, e.key].join("+"));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const ACTION_SET: ReadonlySet<string> = new Set(ACTIONS);
const CONTEXT_SET: ReadonlySet<string> = new Set(CONTEXTS);

function emptyContexts(): Record<Context, Map<string, Action>> {
  return {
    global: new Map(),
    chart: new Map(),
    book: new Map(),
    orders: new Map(),
    command: new Map(),
    dialog: new Map(),
  };
}

/**
 * Validate parsed keymap JSON. Contexts may be omitted (treated as empty).
 * Rejects a context that binds the same normalized key twice (Req 32.4).
 * Every error names the context and the key it concerns.
 */
export function loadKeymap(json: unknown): LoadResult {
  const errors: string[] = [];
  if (!isPlainObject(json)) {
    return { ok: false, errors: ["keymap: expected a JSON object"] };
  }
  for (const k of Object.keys(json)) {
    if (k !== "version" && k !== "contexts") errors.push(`keymap: unknown field "${k}"`);
  }
  if (json.version !== 1) errors.push(`keymap: "version" must be 1`);
  const contexts = emptyContexts();
  const rawContexts = json.contexts;
  if (!isPlainObject(rawContexts)) {
    errors.push(`keymap: "contexts" must be an object`);
    return { ok: false, errors };
  }
  for (const [ctxName, bindings] of Object.entries(rawContexts)) {
    if (!CONTEXT_SET.has(ctxName)) {
      errors.push(`unknown context "${ctxName}"`);
      continue;
    }
    if (!isPlainObject(bindings)) {
      errors.push(`context "${ctxName}": bindings must be an object`);
      continue;
    }
    const target = contexts[ctxName as Context];
    const rawByNormalized = new Map<string, string>();
    for (const [key, action] of Object.entries(bindings)) {
      const norm = normalizeKey(key);
      if (norm === null) {
        errors.push(`context "${ctxName}": invalid key "${key}"`);
        continue;
      }
      if (typeof action !== "string" || !ACTION_SET.has(action)) {
        errors.push(`context "${ctxName}": key "${key}" has unknown action ${JSON.stringify(action)}`);
        continue;
      }
      const prev = rawByNormalized.get(norm);
      if (prev !== undefined) {
        errors.push(
          `context "${ctxName}": key "${key}" duplicates "${prev}" (both normalize to "${norm}")`,
        );
        continue;
      }
      rawByNormalized.set(norm, key);
      target.set(norm, action as Action);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, keymap: { version: 1, contexts } };
}

/**
 * Resolve a key press to an action. The focused context is checked first,
 * then `global`. While `command` is focused only `command` bindings apply.
 * The client picks the focused context by priority dialog > command > panel.
 */
export function resolve(keymap: Keymap, focus: Context, key: string): Action | null {
  const norm = normalizeKey(key);
  if (norm === null) return null;
  const own = keymap.contexts[focus].get(norm);
  if (own !== undefined) return own;
  if (focus === "command") return null;
  return keymap.contexts.global.get(norm) ?? null;
}

/** The keymap as seen by one client: the web UI drops the TUI-only actions. */
export function forClient(keymap: Keymap, client: Client): Keymap {
  if (client === "tui") return keymap;
  const contexts = emptyContexts();
  for (const ctx of CONTEXTS) {
    for (const [key, action] of keymap.contexts[ctx]) {
      if (!TUI_ONLY_ACTIONS.includes(action)) contexts[ctx].set(key, action);
    }
  }
  return { version: 1, contexts };
}

function loadBundled(): Keymap {
  const result = loadKeymap(raw);
  if (!result.ok) {
    throw new Error(`shared/keymap.json is invalid:\n${result.errors.join("\n")}`);
  }
  return result.keymap;
}

/** The bundled `shared/keymap.json`, validated at import time (throws if invalid). */
export const keymap: Keymap = loadBundled();
export default keymap;
