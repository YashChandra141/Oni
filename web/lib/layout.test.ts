import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { ALL_SPLITS, CONSOLE_SPLIT } from "./layout";
import { MAX_CONSOLE, pushConsole, type ConsoleEntry } from "./store";

// Property 6 (fixed web layout, no page overflow), updated for the resizable split layout.
// Reads component sources as text and checks the layout spec in web/lib/layout.ts.
// Validates: Requirements 2.9, 2.10, 3.13

const webDir = join(import.meta.dir, "..");

/** Remove comments so commented-out classes do not count. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const page = stripComments(readFileSync(join(webDir, "app", "page.tsx"), "utf8"));
const layout = stripComments(readFileSync(join(webDir, "app", "layout.tsx"), "utf8"));
const split = stripComments(readFileSync(join(webDir, "components", "Split.tsx"), "utf8"));
const shell = stripComments(readFileSync(join(webDir, "components", "shell", "AppShell.tsx"), "utf8"));

const classTokens = (value: string): string[] => value.split(/\s+/).filter(Boolean);

describe("Property 6: fixed web layout with no page overflow", () => {
  test("<main> fills the shell, clips overflow, and holds the splits and the fixed command bar", () => {
    const main = /<main\s+className="([^"]*)"/.exec(page);
    expect(main, "page.tsx must render <main className=...>").not.toBeNull();
    const classes = classTokens(main![1]!);
    for (const c of ["h-full", "min-h-0", "overflow-hidden", "flex", "flex-col"]) expect(classes).toContain(c);
    expect(page).not.toMatch(/\b(?:row|col)-span-/);
    // The command bar is inside the "trade-console" split's bottom pane, after the panels pane.
    const consoleSplit = page.indexOf("{...CONSOLE_SPLIT}");
    const bar = page.indexOf("<CommandBar");
    expect(consoleSplit).toBeGreaterThan(-1);
    expect(bar).toBeGreaterThan(page.lastIndexOf("</Split>", bar));
    expect(bar).toBeGreaterThan(consoleSplit);
    expect(bar).toBeLessThan(page.indexOf("</Split>", bar));
    expect(bar).toBeLessThan(page.indexOf("</main>"));
    expect(CONSOLE_SPLIT.id).toBe("trade-console");
    expect(CONSOLE_SPLIT.minPx?.[1]).toBeGreaterThan(0);
  });

  test("layout.tsx body and the app shell are h-dvh overflow-hidden", () => {
    const body = /<body[^>]*className="([^"]*)"/.exec(layout);
    const shellRoot = /<div\s+className="([^"]*)"/.exec(shell);
    expect(layout.includes("min-h-screen")).toBe(false);
    for (const classes of [classTokens(body?.[1] ?? ""), classTokens(shellRoot?.[1] ?? "")]) {
      expect(classes).toContain("h-dvh");
      expect(classes).toContain("overflow-hidden");
    }
  });

  test("console log ring buffer keeps the newest entries", () => {
    let log: readonly ConsoleEntry[] = [];
    for (let i = 0; i < MAX_CONSOLE + 25; i++) log = pushConsole(log, { ts: i, kind: "notice", text: `n${i}` });
    expect(log.length).toBe(MAX_CONSOLE);
    expect(log[0]?.ts).toBe(25);
    expect(log[log.length - 1]?.ts).toBe(MAX_CONSOLE + 24);
  });

  test("page.tsx uses the five nested splits", () => {
    expect((page.match(/<Split\b/g) ?? []).length).toBe(5);
    expect(page).toContain('direction="vertical" {...CONSOLE_SPLIT}');
    expect(page).toMatch(/<Split direction="horizontal" \{\.\.\.MAIN_SPLIT\}/);
    for (const name of ["LEFT_SPLIT", "CENTRE_SPLIT", "RIGHT_SPLIT"]) {
      expect(page).toContain(`direction="vertical" {...${name}}`);
    }
  });

  test("Split panes shrink and clip their content", () => {
    expect(split).toContain("min-h-0 min-w-0 overflow-hidden");
    expect(split).toContain('role="separator"');
  });

  test("split specs are consistent: sizes sum to 100 and respect the minimums", () => {
    fc.assert(
      fc.property(fc.constantFrom(...ALL_SPLITS), (spec) => {
        expect(spec.initial.length).toBe(spec.min.length);
        expect(spec.initial.reduce((a, b) => a + b, 0)).toBe(100);
        spec.initial.forEach((s, i) => expect(s).toBeGreaterThanOrEqual(spec.min[i]!));
        expect(spec.min.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(100);
      }),
      { numRuns: 20 },
    );
  });

  test("overlays are fixed and rendered outside <main>", () => {
    const mainEnd = page.indexOf("</main>");
    for (const name of ["PreviewDialog", "ConfirmDialog", "RejectionToast"]) {
      expect(page.indexOf(`<${name}`), `${name} after </main>`).toBeGreaterThan(mainEnd);
      const src = stripComments(readFileSync(join(webDir, "components", `${name}.tsx`), "utf8"));
      expect(/className="[^"]*\bfixed\b/.test(src), `${name} is fixed`).toBe(true);
    }
  });
});
