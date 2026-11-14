// Property P24 — validates Req 32.4
// For arbitrary keymaps, loadKeymap accepts the map iff no context binds the
// same normalized key twice; when accepted, resolve returns exactly the bound
// action for every spelling of every bound key.
//
// Generators pick keys from a pool of canonical keys, each with several
// spellings (case variants, aliases, modifier orders). Duplicates are decided
// by the canonical key, independently of normalizeKey.
import { expect, test } from "bun:test";
import fc from "fast-check";
import { ACTIONS, CONTEXTS, type Action, type Context, loadKeymap, resolve } from "./keymap.ts";

const POOL: readonly (readonly string[])[] = [
  ["B", "b"],
  ["Q", "q"],
  ["Y", "y"],
  ["1"],
  ["+"],
  ["-"],
  [":"],
  ["Up", "up", "ArrowUp", "UP"],
  ["Escape", "Esc", "escape"],
  ["Enter", "enter", "Return"],
  ["Tab", "tab"],
  ["Shift+Tab", "shift+tab", "SHIFT+Tab"],
  ["Ctrl+Shift+X", "Shift+Ctrl+x", "ctrl+shift+X", "control+Shift+x"],
  ["Shift+B", "shift+b"],
];

interface Entry {
  readonly canon: number;
  readonly spelling: string;
  readonly action: Action;
}

const entryArb: fc.Arbitrary<Entry> = fc
  .integer({ min: 0, max: POOL.length - 1 })
  .chain((canon) =>
    fc.record({
      canon: fc.constant(canon),
      spelling: fc.constantFrom(...(POOL[canon] ?? [])),
      action: fc.constantFrom(...ACTIONS),
    }),
  );

// Raw spellings are unique per context (they are JSON object keys); normalized
// keys may still collide through case variants and aliases.
const contextArb = fc.uniqueArray(entryArb, { maxLength: 8, selector: (e) => e.spelling });

const keymapArb = fc.dictionary(fc.constantFrom(...CONTEXTS), contextArb, { maxKeys: CONTEXTS.length });

test("P24: loadKeymap accepts iff no context has duplicate normalized keys; resolve returns the bound action", () => {
  fc.assert(
    fc.property(keymapArb, (spec) => {
      const json = {
        version: 1,
        contexts: Object.fromEntries(
          Object.entries(spec).map(([ctx, entries]) => [
            ctx,
            Object.fromEntries(entries.map((e) => [e.spelling, e.action])),
          ]),
        ),
      };
      const hasDuplicate = Object.values(spec).some(
        (entries) => new Set(entries.map((e) => e.canon)).size !== entries.length,
      );
      const result = loadKeymap(json);
      expect(result.ok).toBe(!hasDuplicate);
      if (!result.ok) return;
      for (const [ctx, entries] of Object.entries(spec)) {
        for (const e of entries) {
          for (const spelling of POOL[e.canon] ?? []) {
            expect(resolve(result.keymap, ctx as Context, spelling)).toBe(e.action);
          }
        }
      }
    }),
    { numRuns: 500 },
  );
});
