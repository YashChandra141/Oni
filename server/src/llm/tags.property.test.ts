// Property 54: the tags parser rejects malformed and oversized input (Req 38.1 to 38.4, 38.20).
// **Validates: Requirements 38.2, 38.3, 38.4**
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { MAX_OLLAMA_MODELS, MODEL_NAME_RE, parseTags } from "./tags.ts";

const CHARS = [..."abcxyzABCXYZ0189._:/@-"];
const goodName = fc.array(fc.constantFrom(...CHARS), { minLength: 1, maxLength: 40 }).map((a) => a.join(""));
const badName = fc.oneof(
  fc.constant(""),
  fc.constant("a b"),
  fc.constant("x".repeat(129)),
  fc.string({ minLength: 1, maxLength: 10 }).map((s) => `${s}\n`),
  fc.constantFrom("a;b", "a|b", "né", "a\u0000b", "a\\b", "<x>"),
);
const entry = (name: string) => ({ name, size: 10, details: { family: "f", parameter_size: "1B" } });

describe("P54 parseTags", () => {
  test("valid lists up to the cap parse to the same names in order", () => {
    fc.assert(
      fc.property(fc.array(goodName, { maxLength: MAX_OLLAMA_MODELS }), (names) => {
        const out = parseTags({ models: names.map(entry) });
        expect(out?.map((x) => x.name)).toEqual(names);
      }),
      { numRuns: 100 },
    );
  });

  test("family and parameter_size default to null when details are missing, null, or partial", () => {
    fc.assert(
      fc.property(
        goodName,
        fc.constantFrom(undefined, null, {}, { family: null }, { parameter_size: null }),
        (n, details) => {
          const out = parseTags({ models: [{ name: n, size: 1, ...(details === undefined ? {} : { details }) }] });
          expect(out).toEqual([{ name: n, size: 1, family: null, parameter_size: null }]);
        },
      ),
      { numRuns: 30 },
    );
  });

  test("more than the cap rejects the whole body", () => {
    fc.assert(
      fc.property(fc.integer({ min: MAX_OLLAMA_MODELS + 1, max: MAX_OLLAMA_MODELS + 50 }), (n) => {
        expect(parseTags({ models: Array.from({ length: n }, (_, i) => entry(`m${i}`)) })).toBeNull();
      }),
      { numRuns: 30 },
    );
  });

  test("entries with a bad name are dropped one by one, the rest kept", () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(goodName.map((n) => [n, true] as const), badName.map((n) => [n, false] as const)), { maxLength: 50 }), (items) => {
        const out = parseTags({ models: items.map(([n]) => entry(n)) });
        expect(out?.map((x) => x.name)).toEqual(items.filter(([, ok]) => ok).map(([n]) => n));
        for (const x of out ?? []) expect(MODEL_NAME_RE.test(x.name)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  test("any body that is not { models: [valid entries] } is null", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.anything(),
          fc.constant({}),
          fc.constant({ models: "x" }),
          fc.constant({ models: [{ name: 1, size: 1 }] }),
          fc.constant({ models: [{ name: "a" }] }),
          fc.constant({ models: [{ name: "a", size: -1 }] }),
          fc.constant({ models: [{ name: "a", size: 1.5 }] }),
          fc.constant({ models: [null] }),
        ),
        (body) => {
          const out = parseTags(body);
          // anything() may by chance produce a valid body; then it must satisfy the invariants.
          if (out !== null) {
            expect(out.length).toBeLessThanOrEqual(MAX_OLLAMA_MODELS);
            for (const x of out) expect(MODEL_NAME_RE.test(x.name)).toBe(true);
          }
        },
      ),
      { numRuns: 200 },
    );
    for (const body of [null, 1, "x", [], {}, { models: "x" }, { models: [{ name: "a" }] }, { models: [{ name: "a", size: -1 }] }]) {
      expect(parseTags(body)).toBeNull();
    }
  });
});
