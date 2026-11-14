// MCP server entry point (design "MCP server (Req 24)", Task 14.1).
//
// Run: `bun run server/src/mcp/main.ts`. A stdio MCP server built with @modelcontextprotocol/sdk
// that acts as a client of the running Oni server at TERMINAL_URL (default
// http://localhost:8080). stdout carries the MCP JSON-RPC channel, so every log line goes to
// stderr, and console.log is redirected there as a guard.
//
// Env (validated with Zod; only variable names are ever logged, never values):
//   TERMINAL_URL  http(s) URL of the Oni server. Default http://localhost:8080.
//   TERMINAL_TOKEN  optional Session_Token (Req 24.9-24.11). Set: the process signs in with
//                   Authenticate after each WS connect and sends Authorization: Bearer on REST
//                   calls (a wallet account). Unset or empty: guest account. Never logged.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pkg from "../../package.json" with { type: "json" };
import { TerminalClient } from "./client.ts";
import { createTools } from "./tools.ts";

export const DEFAULT_TERMINAL_URL = "http://localhost:8080";

const McpEnvSchema = z.object({
  TERMINAL_URL: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.url({ protocol: /^https?$/ }).default(DEFAULT_TERMINAL_URL),
  ),
});

/**
 * TERMINAL_TOKEN (Req 24.9-24.11): optional Session_Token. Empty or whitespace-only counts as
 * unset (guest), and so does an unexpanded `${NAME}` placeholder from mcp.json. Otherwise it must
 * be a single printable-ASCII string without whitespace, at most 4096 chars (header-safe).
 * Zod issue messages are never printed: only the variable name is.
 */
const TerminalTokenSchema = z.preprocess(
  (v) => {
    if (typeof v !== "string") return v;
    const t = v.trim();
    return t === "" || /^\$\{[^}]*\}$/.test(t) ? undefined : t;
  },
  z
    .string()
    .max(4096)
    .regex(/^[\x21-\x7e]+$/)
    .optional(),
);

export interface McpEnv {
  readonly TERMINAL_URL: string;
  /** Secret. Never log, print, or return it. Absent: guest account. */
  readonly TERMINAL_TOKEN: string | undefined;
}

/** Parses the MCP process env. On failure, names the variables only. */
export function parseMcpEnv(
  env: Readonly<Record<string, string | undefined>>,
): { ok: true; env: McpEnv } | { ok: false; variables: string[] } {
  const url = McpEnvSchema.safeParse({ TERMINAL_URL: env.TERMINAL_URL });
  const token = TerminalTokenSchema.safeParse(env.TERMINAL_TOKEN);
  if (url.success && token.success) {
    return { ok: true, env: { TERMINAL_URL: url.data.TERMINAL_URL, TERMINAL_TOKEN: token.data } };
  }
  const variables: string[] = [];
  if (!url.success) variables.push("TERMINAL_URL");
  if (!token.success) variables.push("TERMINAL_TOKEN");
  return { ok: false, variables };
}

async function main(): Promise<void> {
  // stdout is the MCP channel: nothing else may write to it.
  console.log = (...args: unknown[]) => console.error(...args);
  console.info = (...args: unknown[]) => console.error(...args);

  const parsed = parseMcpEnv(process.env);
  if (!parsed.ok) {
    console.error(`[mcp] invalid configuration: ${parsed.variables.join(", ")}`);
    process.exit(1);
  }

  const token = parsed.env.TERMINAL_TOKEN ?? null;
  const client = new TerminalClient({
    baseUrl: parsed.env.TERMINAL_URL,
    ...(token === null ? {} : { token: () => token }),
  });
  const server = new McpServer({ name: "oni-terminal", version: pkg.version });
  for (const tool of createTools(client)) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputShape },
      (args: unknown) => tool.run(args),
    );
  }

  server.server.onclose = () => {
    client.close();
  };

  await server.connect(new StdioServerTransport());
  const who = token === null ? "guest account" : "token set";
  console.error(
    `[mcp] oni-terminal ${pkg.version} ready; terminal server ${new URL(parsed.env.TERMINAL_URL).origin}; ${who}`,
  );
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(`[mcp] fatal: ${err instanceof Error ? err.name : "unknown error"}`);
    process.exit(1);
  });
}
