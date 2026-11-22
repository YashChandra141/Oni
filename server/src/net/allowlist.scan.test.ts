// Source scan for the read-only market-data guard (Task 6.22; Req 14.3, 14.9, 14.10, trading-safety
// rules 1 and 9). It reads the text of every source file in the repository, so a new module that
// sneaks in its own HTTP call, or any file that mentions a transaction-signing wallet method or a
// Solana RPC endpoint, fails here. Same style as router.isolation.test.ts.
//
// **Validates: Requirements 14.3, 14.9, 14.10**
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const SELF = "server/src/net/allowlist.scan.test.ts";

/** Directories that hold build output, dependencies, or generated code. */
const SKIP_DIRS = new Set(["node_modules", "target", ".next", "out", "generated", ".git", ".kiro", "dist", "build", "coverage", ".turbo"]);
const CODE_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".rs"]);
const TEXT_EXT = new Set([...CODE_EXT, ".toml", ".json", ".yml", ".yaml"]);
const MAX_BYTES = 1_000_000;

interface SourceFile {
  /** Path relative to the repository root, with `/` separators. */
  readonly path: string;
  readonly ext: string;
  readonly text: string;
}

function walk(dir: string, out: SourceFile[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const dot = entry.name.lastIndexOf(".");
    const ext = dot < 0 ? "" : entry.name.slice(dot);
    if (!TEXT_EXT.has(ext) || statSync(full).size > MAX_BYTES) continue;
    out.push({ path: relative(ROOT, full).split(sep).join("/"), ext, text: readFileSync(full, "utf8") });
  }
}

const FILES: SourceFile[] = [];
walk(ROOT, FILES);

/** Removes block and line comments. A `//` that follows `:`, a quote, or a word is part of a URL or string. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<![:\w"'`\\])\/\/.*$/gm, "");
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Tests, mock servers, and test doubles. They may call `fetch` against localhost or a fake. */
function isTestSupport(path: string): boolean {
  const name = baseName(path);
  return (
    /\.test\.tsx?$/.test(name) ||
    /^testing\w*\.tsx?$/.test(name) ||
    /(_tests|_properties|^properties|^test_ws)\.rs$/.test(name) ||
    path.includes("/integration/") ||
    path.includes("/tests/") ||
    path.includes("/__mocks__/")
  );
}

// --- Rules -----------------------------------------------------------------------------------

/**
 * Where a TypeScript file may make an HTTP request itself. Each entry says why. Everything else
 * must call `guardedFetch` (server) or the Oni server through an injected function (web).
 */
const TS_FETCH_ALLOWED: Readonly<Record<string, string>> = {
  "server/src/net/http.ts": "The wrapper. It checks the allowlist, then calls fetch with redirect: error and a timeout.",
  "server/src/mcp/client.ts": "The MCP client talks only to the Oni server it is pointed at (baseUrl). No external host.",
  "server/scripts/smoke.ts": "Post-deploy smoke script. Requests go to SMOKE_BASE_URL, the Oni server (default localhost).",
  "scripts/dev.ts": "Local dev launcher. Calls only the local server's /health.",
  "server/scripts/bench-latency.ts": "Latency bench. Requests go to a loopback server that the script starts itself.",
  "scripts/fetch-coin-icons.ts": "dev-only asset fetch from GitHub raw and the Jupiter token API, never run by the server",
  "web/lib/auth.ts": "Browser default for the injected AuthDeps.fetch. URLs are `${API_URL}${path}`, the Oni server.",
  "web/app/pair/page.tsx": "Browser default for the injected pairing fetch. URL is `${API_URL}/auth/pair/confirm`.",
  "web/app/logs/page.tsx": "Reads `${API_URL}/journal` from the Oni server.",
};

/** The allowed files that may name a host must name only a loopback host. */
const EXTERNAL_URL_LITERAL = /https?:\/\/(?!localhost\b|127\.0\.0\.1\b|\[::1\])/;

/** The only external URL an allow-listed file may name (dev-only asset fetch from GitHub raw, never run by the server). */
const ICON_FETCH_URL = "https://raw.githubusercontent.com/spothq/cryptocurrency-icons/master/svg/color";
/** Same justification: dev-only asset fetch of the Jupiter token logo, never run by the server. */
const ICON_FETCH_URL_JUP = "https://lite-api.jup.ag/tokens/v2/search";

/** Ways a TypeScript file can make an outbound request. Applied to comment-free text. */
const TS_HTTP_PATTERNS: readonly (readonly [string, RegExp])[] = [
  // A call to `fetch(`, not `x.fetch(`, `#fetch(`, `async fetch(` or the interface method `fetch(symbols: ...)`.
  ["fetch(", /(?<![.\w$#])(?<!async\s)fetch\s*\((?!\s*\w+\s*:)/],
  ["globalThis.fetch / window.fetch / self.fetch / Bun.fetch", /\b(?:globalThis|window|self|Bun)\.fetch\b/],
  ["XMLHttpRequest", /\bXMLHttpRequest\b/],
  ["EventSource / sendBeacon", /\bnew\s+EventSource\s*\(|\bsendBeacon\s*\(/],
  ["HTTP client package", /from\s+["'](?:axios|node-fetch|cross-fetch|undici|got|ky|superagent)["']/],
  ["node:http(s)", /from\s+["']node:https?["']|require\(\s*["']https?["']\s*\)/],
];

/**
 * Rust: where a file may open a network connection. The engine's only HTTP client is
 * feed/http.rs (it checks feed/allowlist.rs first). The WebSocket adapters connect to the two
 * allowlisted URLs. The TUI connects only to the server it was pointed at with --server.
 */
const RS_NET_ALLOWED: Readonly<Record<string, string>> = {
  "rust/crates/engine/src/feed/http.rs": "The engine's allowlisted HTTPS GET. Calls allowlist::check_get before any connection.",
  "rust/crates/engine/src/feed/coinbase.rs": "Public Coinbase WebSocket, COINBASE_WS_URL (checked below against ALLOWED_WS_URLS).",
  "rust/crates/engine/src/feed/backpack.rs": "Public Backpack WebSocket, BACKPACK_WS_URL (checked below against ALLOWED_WS_URLS).",
  "rust/crates/tui/src/http.rs": "The TUI's REST client for the Oni server's auth and pairing routes. No external host.",
  "rust/crates/tui/src/net.rs": "The TUI's WebSocket to the Oni server at /ws. No external host.",
};
const RS_NET_PATTERN = /\bTcpStream::connect\b|\bconnect_async(?:_with_config|_tls_with_config)?\s*\(|\bUdpSocket::bind\b/;
const RS_NET_CRATES = /\b(?:reqwest|ureq|isahc|attohttpc|surf|hyper_util|hyper::client)\b/;

/** Words and hosts no source file may contain (trading-safety rules 1 and 9). */
const FORBIDDEN: readonly (readonly [string, RegExp])[] = [
  ["a transaction-signing wallet method", /\bsign(?:AndSend)?(?:All)?Transactions?\b|\bsignAndSend\w*/],
  ["a transaction-signing wallet method (snake case)", /\bsign_(?:and_send_)?(?:all_)?transactions?\b/],
  ["a Solana RPC URL", /api\.(?:mainnet-beta|devnet|testnet)\.solana\.com|\.solana\.com\b/],
  ["a Solana RPC provider URL", /helius-rpc\.com|rpc\.ankr\.com\/solana|quiknode\.pro|solana-mainnet\.g\.alchemy\.com/],
];

/**
 * Files that may name a forbidden word because they list it as forbidden. None exist today: the
 * web wallet allow-list (web/lib/walletStandard.ts) names only the four allowed features, and
 * its test builds the forbidden names without spelling them. Add a file here only if it names a
 * word purely in a deny context, and say why.
 */
const FORBIDDEN_WORD_EXCEPTIONS: Readonly<Record<string, string>> = {
  [SELF]: "This file: it holds the patterns.",
};

// --- Tests -----------------------------------------------------------------------------------

describe("the source scan sees the repository", () => {
  const paths = FILES.map((f) => f.path);
  test("it reads the wrappers, the web client, the engine, and the TUI", () => {
    for (const p of [
      "server/src/net/http.ts",
      "server/src/router.ts",
      "web/lib/auth.ts",
      "web/lib/walletStandard.ts",
      "rust/crates/engine/src/feed/allowlist.rs",
      "rust/crates/engine/src/feed/http.rs",
      "rust/crates/tui/src/http.rs",
      SELF,
    ]) {
      expect(paths).toContain(p);
    }
    expect(FILES.length).toBeGreaterThan(100);
  });

  test("it skips dependencies, build output, and generated code", () => {
    for (const p of paths) {
      expect(p).not.toMatch(/(^|\/)(node_modules|target|\.next|out|generated)\//);
    }
  });
});

describe("no HTTP call outside the wrappers (Req 14.3, trading-safety rule 1)", () => {
  const ts = FILES.filter((f) => [".ts", ".tsx", ".js", ".mjs", ".cjs"].includes(f.ext) && !isTestSupport(f.path));

  test("TypeScript: only the allow-listed files call fetch or another HTTP client", () => {
    const offenders: string[] = [];
    for (const f of ts) {
      if (f.path in TS_FETCH_ALLOWED) continue;
      const text = stripComments(f.text);
      for (const [label, pattern] of TS_HTTP_PATTERNS) {
        if (pattern.test(text)) offenders.push(`${f.path}: ${label}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the allow-listed TypeScript files exist, still need their entry, and name no external host", () => {
    for (const path of Object.keys(TS_FETCH_ALLOWED)) {
      const f = ts.find((x) => x.path === path);
      expect(f, path).toBeDefined();
      const text = stripComments(f?.text ?? "");
      if (path === "server/src/net/http.ts") {
        // The wrapper hands the global `fetch` a request only after `isAllowed` passed.
        expect(text).toContain("fetchImpl ?? fetch");
        expect(text).toContain("isAllowed(options.rules, url, method)");
        continue;
      }
      expect(TS_HTTP_PATTERNS.some(([, p]) => p.test(text)), `${path} no longer makes a request: remove its entry`).toBe(true);
      // One exemption: dev-only asset fetch from GitHub raw, never run by the server.
      const checked = path === "scripts/fetch-coin-icons.ts" ? text.replaceAll(ICON_FETCH_URL, "").replaceAll(ICON_FETCH_URL_JUP, "") : text;
      expect(checked, path).not.toMatch(EXTERNAL_URL_LITERAL);
    }
  });

  test("every server module that reaches an external host does so through guardedFetch", () => {
    const text = (path: string) => FILES.find((f) => f.path === path)?.text ?? "";
    // News providers receive guardedFetch from cache.ts, or default to it.
    expect(text("server/src/news/cache.ts")).toMatch(/guardedFetch\(url, init\)/);
    expect(text("server/src/news/cryptopanic.ts")).toMatch(/guardedFetch\(url, init\)/);
    // LLM providers default to it, and the registry's probe and factories use it.
    expect(text("server/src/llm/registry.ts")).toMatch(/guardedFetch\(url, init\)/);
    expect(text("server/src/llm/registry.ts")).toMatch(/guardedFetch\(input, init\)/);
    expect(text("server/src/llm/anthropic.ts")).toMatch(/guardedFetch\(input, init\)/);
    expect(text("server/src/llm/ollama.ts")).toMatch(/guardedFetch\(input, init\)/);
  });

  test("Rust: no HTTP client crate anywhere (the TUI and engine use their own rustls clients)", () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      if (f.ext === ".rs" && RS_NET_CRATES.test(stripComments(f.text))) offenders.push(f.path);
      if (f.path.endsWith("Cargo.toml") && /^\s*(?:reqwest|ureq|isahc|attohttpc|surf)\s*=/m.test(f.text)) offenders.push(f.path);
    }
    expect(offenders).toEqual([]);
  });

  test("Rust: only the allow-listed files open a network connection", () => {
    const rs = FILES.filter((f) => f.ext === ".rs" && !isTestSupport(f.path));
    const offenders = rs.filter((f) => !(f.path in RS_NET_ALLOWED) && RS_NET_PATTERN.test(stripComments(f.text)));
    expect(offenders.map((f) => f.path)).toEqual([]);
    for (const path of Object.keys(RS_NET_ALLOWED)) {
      const f = rs.find((x) => x.path === path);
      expect(f, path).toBeDefined();
      expect(RS_NET_PATTERN.test(stripComments(f?.text ?? "")), `${path} no longer connects: remove its entry`).toBe(true);
    }
  });

  test("Rust: the engine's HTTP client checks the allowlist before it connects", () => {
    const http = stripComments(FILES.find((f) => f.path === "rust/crates/engine/src/feed/http.rs")?.text ?? "");
    const check = http.indexOf("allowlist::check_get(host, path)");
    const connect = http.indexOf("exchange(host, &request)");
    expect(check).toBeGreaterThan(-1);
    expect(connect).toBeGreaterThan(check);
  });

  test("Rust: the WebSocket adapters connect to URLs on ALLOWED_WS_URLS", () => {
    const text = (path: string) => FILES.find((f) => f.path === path)?.text ?? "";
    const allowed = [...text("rust/crates/engine/src/feed/allowlist.rs").matchAll(/ALLOWED_WS_URLS[\s\S]*?\];/g)]
      .flatMap((m) => [...m[0].matchAll(/"(wss:\/\/[^"]+)"/g)].map((u) => u[1]))
      .filter((u): u is string => u !== undefined);
    expect(allowed.length).toBe(2);
    const coinbase = /COINBASE_WS_URL: &str = "([^"]+)"/.exec(text("rust/crates/engine/src/feed/coinbase.rs"))?.[1];
    const backpack = /BACKPACK_WS_URL: &str = "([^"]+)"/.exec(text("rust/crates/engine/src/feed/backpack.rs"))?.[1];
    expect(allowed).toContain(coinbase ?? "missing");
    expect(allowed).toContain(backpack ?? "missing");
  });
});

describe("no transaction signing and no Solana RPC (Req 14.9, 14.10, trading-safety rules 1 and 9)", () => {
  test("no source file names a signing method or an RPC endpoint", () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      if (f.path in FORBIDDEN_WORD_EXCEPTIONS) continue;
      for (const [label, pattern] of FORBIDDEN) {
        if (pattern.test(f.text)) offenders.push(`${f.path}: ${label}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the exception list holds only this file", () => {
    expect(Object.keys(FORBIDDEN_WORD_EXCEPTIONS)).toEqual([SELF]);
  });

  test("the web wallet allow-list names only the four allowed features", () => {
    const text = FILES.find((f) => f.path === "web/lib/walletStandard.ts")?.text ?? "";
    const list = /ALLOWED_FEATURES\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(text)?.[1] ?? "";
    const names = [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    // standard:events is read-only (account change notices); it signs nothing.
    expect(names.every((n) => /^(?:standard:(?:connect|disconnect|events)|solana:(?:signIn|signMessage))$/.test(n ?? ""))).toBe(true);
    expect(names).toContain("solana:signIn");
    expect(names).toContain("solana:signMessage");
  });

  test("the patterns catch what they should", () => {
    const hits = (text: string) => FORBIDDEN.filter(([, p]) => p.test(text)).length;
    for (const word of ["signTransaction", "signAllTransactions", "signAndSendTransaction", "signAndSendAllTransactions", "signAndSendFoo"]) {
      expect(hits(`wallet.${word}(tx)`), word).toBeGreaterThan(0);
    }
    expect(hits("sign_and_send_transaction(tx)")).toBeGreaterThan(0);
    for (const url of [
      "https://api.mainnet-beta.solana.com",
      "https://api.devnet.solana.com",
      "https://mainnet.helius-rpc.com/?api-key=x",
      "https://rpc.ankr.com/solana",
    ]) {
      expect(hits(url), url).toBeGreaterThan(0);
    }
    for (const fine of ["solana:signIn", "solana:signMessage", "signMessage", "signature", "standard:connect"]) {
      expect(hits(fine), fine).toBe(0);
    }
  });

  test("the HTTP patterns catch what they should", () => {
    const hit = (text: string) => TS_HTTP_PATTERNS.some(([, p]) => p.test(stripComments(text)));
    expect(hit("const r = await fetch(url)")).toBe(true);
    expect(hit("return fetch(`${base}/x`, { method: 'GET' })")).toBe(true);
    expect(hit("x ?? ((u, i) => globalThis.fetch(u, i))")).toBe(true);
    expect(hit("const x = new XMLHttpRequest()")).toBe(true);
    expect(hit('import axios from "axios"')).toBe(true);
    // Not calls to the global fetch.
    expect(hit("app.fetch(req)")).toBe(false);
    expect(hit("await this.#fetch(url, init)")).toBe(false);
    expect(hit("async fetch(symbols, signal) {}")).toBe(false);
    expect(hit("fetch(symbols: readonly NewsSymbol[], signal: AbortSignal): Promise<NewsItem[]>;")).toBe(false);
    expect(hit("// fetch(url) in a comment\nconst a = 1;")).toBe(false);
    expect(hit("/** `globalThis.fetch(url)` in a block comment */")).toBe(false);
    expect(hit("const doFetch = guardedFetch(url, init)")).toBe(false);
    expect(RS_NET_PATTERN.test("let s = TcpStream::connect((host, 443)).await?;")).toBe(true);
    expect(RS_NET_PATTERN.test("connect_async_with_config(url, cfg, true)")).toBe(true);
    expect(RS_NET_CRATES.test("use reqwest::Client;")).toBe(true);
  });
});
