// No file under web/ may name a transaction-signing wallet feature (Task 20.4, Req 49.2).
// The names are assembled from pieces so this file never contains them. Tests that need the
// names (to assert they are never called) assemble them the same way.
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const SIGN = "sign";
const FORBIDDEN = [`${SIGN}Transaction`, `${SIGN}AndSendTransaction`, `${SIGN}AndSendAllTransactions`] as const;

const WEB_ROOT = join(import.meta.dir, "..");
const SKIPPED_DIRS = new Set(["node_modules", ".next", "out"]);
const SELF = "lib/noTransactionSigning.test.ts";

/** Walks web/ by hand so node_modules, .next and out are never entered. Paths use "/". */
function walk(dir: string, prefix: string, files: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) walk(join(dir, entry.name), `${prefix}${entry.name}/`, files);
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
      files.push(`${prefix}${entry.name}`);
    }
  }
}

async function webSourceFiles(): Promise<string[]> {
  const files: string[] = [];
  walk(WEB_ROOT, "", files);
  return files.filter((file) => file !== SELF).sort();
}

describe("no transaction signing in web/", () => {
  test("scans a realistic set of source files", async () => {
    const files = await webSourceFiles();
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain("lib/auth.ts");
    expect(files).toContain("lib/walletStandard.ts");
    expect(files).toContain("app/pair/page.tsx");
    expect(files).toContain("components/WalletMenu.tsx");
    expect(files.some((f) => f.startsWith("node_modules/") || f.startsWith(".next/") || f.startsWith("out/"))).toBe(false);
  });

  test("no .ts or .tsx file mentions a transaction-signing feature", async () => {
    const offenders: string[] = [];
    for (const file of await webSourceFiles()) {
      const text = await Bun.file(join(WEB_ROOT, file)).text();
      for (const name of FORBIDDEN) {
        if (text.includes(name)) offenders.push(`${file}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the check would catch a mention", () => {
    for (const name of FORBIDDEN) {
      expect(`wallet.features["solana:${name}"]`.includes(name)).toBe(true);
    }
  });
});
