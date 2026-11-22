// Structural check of the single order path (Req 18.1, 18.3, trading-safety rule 2): only the
// Router uses the engine's order sender and builds order Commands. This reads the source text of
// every .ts file under server/src, so a new module that sneaks in an order path fails here.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC = import.meta.dir;

/** Modules that may mention the order-sender capability, relative to server/src with `/`. */
const SENDER_ALLOWED = new Set(["engine/supervisor.ts", "main.ts", "router.ts"]);

/** Modules that may build order Commands (`type: "place_order"` and friends). */
const COMMAND_BUILDERS_ALLOWED = new Set(["router.ts"]);

/** Never scanned for order Commands: the wire schemas describe them, they do not send them. */
const COMMAND_SCAN_EXCLUDED = new Set(["protocol.ts"]);

const SENDER_PATTERN = /\bcreateOrderSender\b|\bOrderSender\b/;
const ORDER_COMMAND_PATTERN = /["'`]?\btype["'`]?\s*:\s*["'`](?:place_order|cancel|cancel_all|reset_account)["'`]/;

interface SourceFile {
  /** Path relative to server/src, with `/` separators. */
  readonly path: string;
  readonly text: string;
}

function isTestSupport(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.endsWith(".test.ts") || name === "testing.ts" || path.startsWith("integration/");
}

function listTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "generated" || entry.name === "node_modules") continue;
      files.push(...listTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

function readSources(): SourceFile[] {
  return listTsFiles(SRC).map((full) => ({
    path: relative(SRC, full).split(sep).join("/"),
    text: readFileSync(full, "utf8"),
  }));
}

describe("single order path (Req 18.1, 18.3)", () => {
  const sources = readSources();
  const production = sources.filter((s) => !isTestSupport(s.path));

  test("the scan sees the server sources", () => {
    const paths = sources.map((s) => s.path);
    expect(paths).toContain("router.ts");
    expect(paths).toContain("engine/supervisor.ts");
    expect(paths).toContain("main.ts");
    expect(paths).toContain("gateway/ws.ts");
    expect(production.length).toBeGreaterThan(10);
  });

  test("only the supervisor, main.ts, and router.ts mention the order sender", () => {
    const offenders = production.filter((s) => SENDER_PATTERN.test(s.text) && !SENDER_ALLOWED.has(s.path));
    expect(offenders.map((s) => s.path)).toEqual([]);
  });

  test("the Router holds the sender and main.ts creates it", () => {
    const text = (path: string) => sources.find((s) => s.path === path)?.text ?? "";
    expect(text("main.ts")).toContain("createOrderSender");
    expect(text("router.ts")).toMatch(/sender:\s*RouterSender/);
  });

  test("only router.ts builds PlaceOrder, Cancel, CancelAll, and ResetAccount commands", () => {
    const offenders = production.filter(
      (s) => !COMMAND_SCAN_EXCLUDED.has(s.path) && ORDER_COMMAND_PATTERN.test(s.text) && !COMMAND_BUILDERS_ALLOWED.has(s.path),
    );
    expect(offenders.map((s) => s.path)).toEqual([]);
    expect(ORDER_COMMAND_PATTERN.test(sources.find((s) => s.path === "router.ts")?.text ?? "")).toBe(true);
  });

  test("the gateway never touches the order path directly", () => {
    const ws = sources.find((s) => s.path === "gateway/ws.ts")?.text ?? "";
    expect(ws).not.toMatch(SENDER_PATTERN);
    expect(ws).not.toMatch(ORDER_COMMAND_PATTERN);
    // It may only call sendControl for market-data subscriptions (candles and the 24 h ticker).
    const calls = [...ws.matchAll(/sendControl\(\{\s*type:\s*"([a-z_]+)"/g)].map((m) => m[1] ?? "");
    expect(calls.length).toBeGreaterThan(0);
    for (const type of calls) {
      expect(["subscribe", "unsubscribe", "subscribe_ticker", "unsubscribe_ticker"]).toContain(type);
    }
  });

  test("the patterns catch what they should", () => {
    expect(ORDER_COMMAND_PATTERN.test('send({ type: "place_order", account_id: a })')).toBe(true);
    expect(ORDER_COMMAND_PATTERN.test("{ type: 'cancel_all' }")).toBe(true);
    expect(ORDER_COMMAND_PATTERN.test('{ "type": "reset_account" }')).toBe(true);
    expect(ORDER_COMMAND_PATTERN.test('{ type: "subscribe" }')).toBe(false);
    expect(SENDER_PATTERN.test("const s = supervisor.createOrderSender()")).toBe(true);
    expect(SENDER_PATTERN.test("const s: OrderSender = x")).toBe(true);
    expect(SENDER_PATTERN.test("RouterSender")).toBe(false);
  });
});
