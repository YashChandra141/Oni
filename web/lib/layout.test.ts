import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import {
  GRID_AREA_ROWS,
  GRID_AREAS,
  GRID_ROWS,
  GRID_STYLE,
  PANEL_AREA,
  type PanelId,
} from "./layout";

// Task 1.7 / 8.5: Property 6 (fixed web layout, no page overflow).
// Reads component sources as text and checks the layout spec in web/lib/layout.ts.
// Validates: Requirements 2.9, 2.10, 3.13

const webDir = join(import.meta.dir, "..");
const pageSrc = readFileSync(join(webDir, "app", "page.tsx"), "utf8");
const layoutSrc = readFileSync(join(webDir, "app", "layout.tsx"), "utf8");

/** Remove comments so commented-out classes do not count. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const page = stripComments(pageSrc);
const layout = stripComments(layoutSrc);

function classTokens(value: string): string[] {
  return value.split(/\s+/).filter(Boolean);
}

/** Split a grid track list such as `auto_minmax(0,1fr)_12rem_auto` on top-level underscores. */
function splitTracks(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if ((ch === "_" || ch === " ") && depth === 0) {
      if (cur) out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

interface Tag {
  name: string;
  attrs: string;
  selfClosing: boolean;
  closing: boolean;
}

function scanTags(src: string): Tag[] {
  const tags: Tag[] = [];
  const re = /<(\/?)([A-Za-z][\w.]*)?((?:"[^"]*"|'[^']*'|\{(?:[^{}]|\{[^{}]*\})*\}|[^>"'{}])*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    tags.push({ closing: m[1] === "/", name: m[2] ?? "", attrs: m[3] ?? "", selfClosing: m[4] === "/" });
  }
  return tags;
}

function classNameOf(attrs: string): string {
  const m = /className\s*=\s*(?:"([^"]*)"|\{`([^`]*)`\}|\{"([^"]*)"\})/.exec(attrs);
  return (m?.[1] ?? m?.[2] ?? m?.[3] ?? "").replace(/\$\{[^}]*\}/g, " ");
}

/** The tags that are direct children of the <main> grid, with their effective class lists. */
function gridChildren(): { name: string; classes: string[] }[] {
  const tags = scanTags(page);
  const start = tags.findIndex((t) => !t.closing && t.name === "main");
  if (start < 0) throw new Error("no <main> grid found in page.tsx");
  const panelBase = classTokens(
    /<section[^>]*className=\{`([^`]*)`\}/.exec(page)?.[1]?.replace(/\$\{[^}]*\}/g, " ") ?? "",
  );
  const children: { name: string; classes: string[] }[] = [];
  let depth = 0;
  for (const tag of tags.slice(start + 1)) {
    if (tag.name === "" ) continue; // fragments
    if (tag.closing) {
      if (depth === 0) break; // </main>
      depth--;
      continue;
    }
    if (depth === 0) {
      const own = classTokens(classNameOf(tag.attrs));
      const isPanel = tag.name === "Panel";
      // Components without a className (overlays, StatusBar, CommandBar) style themselves.
      if (isPanel || own.length > 0 || /^[a-z]/.test(tag.name)) {
        children.push({ name: tag.name, classes: isPanel ? [...panelBase, ...own] : own });
      }
    }
    if (!tag.selfClosing) depth++;
  }
  return children;
}

describe("Property 6: fixed web layout with no page overflow", () => {
  test("only the status bar and command bar rows are auto tracks", () => {
    expect(page.includes("style={GRID_STYLE}"), "<main> must use style={GRID_STYLE}").toBe(true);
    expect(GRID_STYLE.gridTemplateRows).toBe(GRID_ROWS);
    const tracks = splitTracks(GRID_ROWS).map((t) => t.replace(/\s+/g, ""));
    const autos = tracks.filter((t) => t === "auto");
    // Status bar row (first) and command bar row (last) are the only auto rows.
    expect(tracks[0]).toBe("auto");
    expect(tracks[tracks.length - 1]).toBe("auto");
    expect(autos.length, `rows: ${tracks.join(" ")}`).toBe(2);
    // Every other track is a fixed length or minmax(0, Nfr).
    for (const t of tracks.slice(1, -1)) {
      expect(/^(\d+(\.\d+)?(rem|px|vh|dvh)|minmax\(0,\d*(\.\d+)?fr\))$/.test(t), `track ${t}`).toBe(true);
    }
  });

  test("page.tsx uses no row-span or col-span", () => {
    const hits = page.match(/\b(?:row|col)-span-[\w[\]/-]+/g) ?? [];
    expect(hits).toEqual([]);
  });

  test("every grid child has min-h-0 and min-w-0", () => {
    const children = gridChildren();
    expect(children.length).toBeGreaterThan(0);
    const missing = children
      .filter((c) => !c.classes.includes("min-h-0") || !c.classes.includes("min-w-0"))
      .map((c) => `${c.name} (${c.classes.join(" ")})`);
    expect(missing).toEqual([]);
  });

  test("layout.tsx body is h-dvh overflow-hidden and not min-h-screen", () => {
    const body = /<body[^>]*className=(?:"([^"]*)"|\{`([^`]*)`\})/.exec(layout);
    expect(body, "layout.tsx must render <body className=...>").not.toBeNull();
    const classes = classTokens(body![1] ?? body![2] ?? "");
    expect(classes).toContain("h-dvh");
    expect(classes).toContain("overflow-hidden");
    expect(classes).not.toContain("min-h-screen");
    expect(layout.includes("min-h-screen")).toBe(false);
  });
});

const panelIds = Object.keys(PANEL_AREA) as PanelId[];
const areaGrid = GRID_AREA_ROWS.map((row) => row.split(/\s+/));
const cellsOf = (area: string): [number, number][] => {
  const cells: [number, number][] = [];
  areaGrid.forEach((row, r) => row.forEach((name, c) => name === area && cells.push([r, c])));
  return cells;
};
const rowsOf = (area: string) => cellsOf(area).map(([r]) => r);
const colsOf = (area: string) => cellsOf(area).map(([, c]) => c);

describe("Property 6: layout spec (fast-check)", () => {
  test("each panel sits in exactly one named area that exists in the template", () => {
    fc.assert(
      fc.property(fc.constantFrom(...panelIds), (id) => {
        const area = PANEL_AREA[id];
        expect(GRID_AREAS.includes(area)).toBe(true);
        expect(cellsOf(area).length).toBeGreaterThan(0);
        // exactly one element in page.tsx is placed in this area
        const uses = page.match(new RegExp(`gridArea:\\s*PANEL_AREA\\.${id}\\b`, "g")) ?? [];
        expect(uses.length).toBe(1);
      }),
      { numRuns: 50 },
    );
  });

  test("every named area holds exactly one element", () => {
    const areaNames = [...new Set(areaGrid.flat())];
    const placements = [...page.matchAll(/gridArea:\s*PANEL_AREA\.(\w+)/g)].map((m) => m[1]!);
    expect(new Set(placements).size).toBe(placements.length);
    fc.assert(
      fc.property(fc.constantFrom(...areaNames), (area) => {
        const owners = panelIds.filter((id) => PANEL_AREA[id] === area);
        expect(owners.length).toBe(1);
        expect(placements.filter((p) => PANEL_AREA[p as PanelId] === area).length).toBe(1);
      }),
      { numRuns: 50 },
    );
    expect(placements.length).toBe(areaNames.length);
  });

  test("content panel bodies scroll by default; clip is opt-in", () => {
    expect(page).toMatch(/body\s*=\s*"scroll"/);
    expect(page).toMatch(/"min-h-0 flex-1 overflow-auto"/);
    expect(page).toMatch(/body === "clip"\s*\?\s*"min-h-0 flex-1 overflow-hidden"/);
  });

  // v2: the page renders inside AppShell (top nav + sidebar), so the viewport-height chain is
  // body h-dvh -> shell h-dvh -> <main> h-full. A <main> with its own h-dvh would be taller than
  // the space under the top nav and its bottom row (the command bar) would be clipped.
  test("<body> and the app shell are h-dvh overflow-hidden, and <main> fills the shell without overflow", () => {
    const main = scanTags(page).find((t) => !t.closing && t.name === "main")!;
    const mainClasses = classTokens(classNameOf(main.attrs));
    const body = /<body[^>]*className="([^"]*)"/.exec(layout);
    const bodyClasses = classTokens(body?.[1] ?? "");
    const shellSrc = stripComments(readFileSync(join(webDir, "components", "shell", "AppShell.tsx"), "utf8"));
    const shellRoot = /<div\s+className="([^"]*)"/.exec(shellSrc);
    const shellClasses = classTokens(shellRoot?.[1] ?? "");
    fc.assert(
      fc.property(fc.constantFrom(bodyClasses, shellClasses), (classes) => {
        expect(classes).toContain("h-dvh");
        expect(classes).toContain("overflow-hidden");
      }),
      { numRuns: 10 },
    );
    expect(mainClasses).toContain("h-full");
    expect(mainClasses).toContain("overflow-hidden");
    expect(mainClasses).toContain("min-h-0");
  });

  test("no component source uses row-span-* or col-span-*", () => {
    const dir = join(webDir, "components");
    const files = ["StatusBar", "CommandBar", "PreviewDialog", "ConfirmDialog", "RejectionToast"]
      .map((n) => join(dir, `${n}.tsx`))
      .filter(existsSync);
    const sources = [page, layout, ...files.map((f) => stripComments(readFileSync(f, "utf8")))];
    fc.assert(
      fc.property(fc.constantFrom(...sources), (src) => {
        expect(src.match(/\b(?:row|col)-span-/g) ?? []).toEqual([]);
      }),
      { numRuns: 20 },
    );
  });

  test("arrangement follows GRID_AREA_ROWS", () => {
    const top = (a: string) => Math.min(...rowsOf(a));
    const bottom = (a: string) => Math.max(...rowsOf(a));
    const left = (a: string) => Math.min(...colsOf(a));
    const right = (a: string) => Math.max(...colsOf(a));
    const last = areaGrid.length - 1;
    expect(rowsOf("status").every((r) => r === 0)).toBe(true);
    expect(rowsOf("command").every((r) => r === last)).toBe(true);
    expect(right("watch")).toBeLessThan(left("chart"));
    expect(left("side")).toBeGreaterThan(right("chart"));
    expect(top("tape")).toBeGreaterThan(bottom("watch"));
    expect(left("tape")).toBe(left("watch"));
    expect(top("account")).toBeGreaterThan(bottom("chart"));
    expect(colsOf("account")).toContain(left("chart"));
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
