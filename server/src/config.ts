// Server configuration from environment variables (Req 16).
//
// `loadConfig` reads only the env record it is given and returns a result
// instead of logging or exiting, so it can be tested. Its one side effect is
// drawing random bytes for the development SESSION_SECRET fallback (Req 16.8).
// `loadConfigOrExit` is the startup wrapper that logs variable NAMES (never
// values) and exits 1.
//
// Secrets (Req 16.4, trading-safety rule 6): OPENAI_API_KEY, the whole
// DATABASE_URL, the whole DIRECT_URL, and SESSION_SECRET. They live in private
// fields, are hidden from toJSON and inspect, and `redactSecrets` scrubs them
// (and the URL passwords) from any text before it reaches a log or a response.
// TERMINAL_TOKEN is not read here: it belongs to the MCP process (Task 14.3).

import { z } from "zod";

export const REDACTED = "[redacted]";

/**
 * Variables read by the Server (Req 16.1, plus REPLAY_FIXTURE and OPENAI_MODEL from the design
 * table, and REPLAY_SPEED for faster local demos, Task 4.6).
 */
export const CONFIG_VARS = [
  "PORT",
  "ENGINE_PATH",
  "DATA_MODE",
  "LIVE_VENUE",
  "REPLAY_FIXTURE",
  "REPLAY_SPEED",
  "ALLOWED_ORIGINS",
  "WEB_URL",
  "SESSION_SECRET",
  "DATABASE_URL",
  "DIRECT_URL",
  "DB_ADAPTER",
  "KILL_SWITCH",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "NODE_ENV",
] as const;

export type ConfigVar = (typeof CONFIG_VARS)[number];

export type EnvRecord = Readonly<Record<string, string | undefined>>;

export interface LoadConfigOptions {
  /** Defaults to `process.platform`. Injectable so the win32 `.exe` default is testable. */
  readonly platform?: string;
}

export interface ConfigIssue {
  readonly variable: ConfigVar;
  readonly problem: "invalid" | "missing";
  /** Built from static text and the variable name only, never from the value. */
  readonly message: string;
}

export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    super(`Invalid configuration: ${issues.map((i) => i.variable).join(", ")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

export type ConfigResult =
  | { readonly ok: true; readonly config: Config; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly error: ConfigError };

/** Minimum SESSION_SECRET length in bytes of its UTF-8 encoding (Req 16.7, design config table). */
export const MIN_SESSION_SECRET_BYTES = 32;
/** Random bytes in the per-process development fallback secret (Req 16.8). */
const GENERATED_SESSION_SECRET_BYTES = 32;

/** Expected formats, shown on validation failure in place of the rejected value. */
const EXPECTED: Record<ConfigVar, string> = {
  PORT: "an integer from 1 to 65535",
  ENGINE_PATH: "a non-empty path",
  DATA_MODE: '"replay" or "live"',
  LIVE_VENUE: '"coinbase" or "backpack"',
  REPLAY_FIXTURE: "a fixture file name matching ^[a-z0-9-]+\\.jsonl$",
  REPLAY_SPEED: "an integer from 1 to 50",
  ALLOWED_ORIGINS: "a comma-separated list of http(s) origins such as http://localhost:3000",
  WEB_URL: "an http(s) origin such as http://localhost:3000",
  SESSION_SECRET: `at least ${MIN_SESSION_SECRET_BYTES} bytes (UTF-8 length)`,
  DATABASE_URL: "a postgres:// or postgresql:// URL",
  DIRECT_URL: "a postgres:// or postgresql:// URL",
  DB_ADAPTER: '"pg" or unset',
  KILL_SWITCH: '"true" or "false"',
  OPENAI_API_KEY: "a non-empty string",
  OPENAI_MODEL: "a non-empty string",
  NODE_ENV: '"development", "production", or "test"',
};

/**
 * Default model for plain-English orders (Task 13.1). Verified as a listed model with
 * structured outputs on the Responses API at https://developers.openai.com/api/docs/models/gpt-5.4-mini
 */
export const DEFAULT_OPENAI_MODEL = "gpt-5.4-mini";

const DEFAULT_ENGINE_PATH = "rust/target/release/engine";
const FIXTURE_NAME = /^[a-z0-9-]+\.jsonl$/;
/** Replay speed bounds (Req 6.3, 6.4; `MIN_REPLAY_SPEED`/`MAX_REPLAY_SPEED` in the protocol crate). */
export const MIN_REPLAY_SPEED = 1;
export const MAX_REPLAY_SPEED = 50;

function isPostgresUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "postgres:" || url.protocol === "postgresql:") && url.hostname !== "";
  } catch {
    return false;
  }
}

/** Parses one origin and returns its normalized form (`scheme://host[:port]`), or null. */
function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    const plain =
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "";
    return plain ? url.origin : null;
  } catch {
    return null;
  }
}

function parseOrigins(value: string): string[] | null {
  const parts = value
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  if (parts.length === 0) return null;
  const origins: string[] = [];
  for (const part of parts) {
    const origin = normalizeOrigin(part);
    if (origin === null) return null;
    if (!origins.includes(origin)) origins.push(origin);
  }
  return origins;
}

const DEFAULT_ALLOWED_ORIGINS: readonly string[] = ["http://localhost:3000"];

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** 32 random bytes from `crypto.getRandomValues`, base64url-encoded (43 characters). */
function generateSessionSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(GENERATED_SESSION_SECRET_BYTES));
  return Buffer.from(bytes).toString("base64url");
}

const nonEmpty = z.string().min(1);
const postgresUrl = z.string().refine(isPostgresUrl);

const EnvSchema = z.object({
  PORT: z
    .string()
    .regex(/^[0-9]{1,5}$/)
    .transform(Number)
    .refine((n) => n >= 1 && n <= 65535)
    .default(8080),
  ENGINE_PATH: nonEmpty.optional(),
  DATA_MODE: z.enum(["replay", "live"]).default("replay"),
  // Req 44.1: picks the live adapter; ignored in replay mode. Passed to the engine in Task 7.2.
  LIVE_VENUE: z.enum(["coinbase", "backpack"]).default("backpack"),
  REPLAY_FIXTURE: z.string().regex(FIXTURE_NAME).default("demo.jsonl"),
  REPLAY_SPEED: z
    .string()
    .regex(/^[0-9]{1,2}$/)
    .transform(Number)
    .refine((n) => n >= MIN_REPLAY_SPEED && n <= MAX_REPLAY_SPEED)
    .default(1),
  ALLOWED_ORIGINS: z
    .string()
    .refine((v) => parseOrigins(v) !== null)
    .transform((v) => parseOrigins(v) ?? [])
    .default([...DEFAULT_ALLOWED_ORIGINS]),
  // Normalized to `scheme://host[:port]`. Membership in ALLOWED_ORIGINS is checked in loadConfig (Req 16.9).
  WEB_URL: z
    .string()
    .refine((v) => normalizeOrigin(v) !== null)
    .transform((v) => normalizeOrigin(v) ?? "")
    .optional(),
  SESSION_SECRET: z
    .string()
    .refine((v) => utf8Length(v) >= MIN_SESSION_SECRET_BYTES)
    .optional(),
  DATABASE_URL: postgresUrl.optional(),
  DIRECT_URL: postgresUrl.optional(),
  DB_ADAPTER: z.literal("pg").optional(),
  KILL_SWITCH: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  OPENAI_API_KEY: nonEmpty.optional(),
  OPENAI_MODEL: nonEmpty.optional(),
  NODE_ENV: z.enum(["development", "production", "test"]).optional(),
});

type ParsedEnv = z.output<typeof EnvSchema>;

interface Secrets {
  readonly openaiApiKey: string | undefined;
  readonly databaseUrl: string | undefined;
  readonly directUrl: string | undefined;
  readonly sessionSecret: string;
}

/** Values loadConfig derives from the parsed env before building the Config. */
interface Resolved {
  readonly enginePath: string;
  readonly webUrl: string;
  readonly sessionSecret: string;
}

// `Symbol.for` returns the same symbol Bun.inspect and node:util.inspect look up.
const inspectCustom: unique symbol = Symbol.for("nodejs.util.inspect.custom");

export class Config {
  readonly port: number;
  readonly enginePath: string;
  readonly dataMode: "replay" | "live";
  /** Venue used in live mode (Req 44.1). */
  readonly liveVenue: "coinbase" | "backpack";
  readonly replayFixture: string;
  /** Speed sent with `StartReplay` (1–50). */
  readonly replaySpeed: number;
  readonly allowedOrigins: readonly string[];
  /** Normalized web UI origin, always one of `allowedOrigins` (Req 16.9). SIWS domain and pair URL base. */
  readonly webUrl: string;
  readonly killSwitch: boolean;
  /** OPENAI_MODEL, or DEFAULT_OPENAI_MODEL when unset. */
  readonly openaiModel: string;
  readonly dbAdapter: "pg" | undefined;
  readonly nodeEnv: "development" | "production" | "test" | undefined;
  // Private, so the secrets are not own enumerable properties (spread, Object.keys,
  // default inspect) and are reachable only through the getters below.
  readonly #secrets: Secrets;

  constructor(parsed: ParsedEnv, resolved: Resolved) {
    this.port = parsed.PORT;
    this.enginePath = resolved.enginePath;
    this.dataMode = parsed.DATA_MODE;
    this.liveVenue = parsed.LIVE_VENUE;
    this.replayFixture = parsed.REPLAY_FIXTURE;
    this.replaySpeed = parsed.REPLAY_SPEED;
    this.allowedOrigins = Object.freeze([...parsed.ALLOWED_ORIGINS]);
    this.webUrl = resolved.webUrl;
    this.killSwitch = parsed.KILL_SWITCH;
    this.openaiModel = parsed.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL;
    this.dbAdapter = parsed.DB_ADAPTER;
    this.nodeEnv = parsed.NODE_ENV;
    this.#secrets = Object.freeze({
      openaiApiKey: parsed.OPENAI_API_KEY,
      databaseUrl: parsed.DATABASE_URL,
      directUrl: parsed.DIRECT_URL,
      sessionSecret: resolved.sessionSecret,
    });
    Object.freeze(this);
  }

  /** HMAC-SHA256 key for Session_Tokens (Decision A12): SESSION_SECRET, or the per-process fallback. */
  get sessionSecret(): string {
    return this.#secrets.sessionSecret;
  }

  get openaiApiKey(): string | undefined {
    return this.#secrets.openaiApiKey;
  }

  get databaseUrl(): string | undefined {
    return this.#secrets.databaseUrl;
  }

  get directUrl(): string | undefined {
    return this.#secrets.directUrl;
  }

  get isProduction(): boolean {
    return this.nodeEnv === "production";
  }

  /** Safe view: secrets appear as "[redacted]" when set and null when unset (Req 16.4). */
  toJSON(): Record<string, unknown> {
    const mask = (v: string | undefined): string | null => (v === undefined ? null : REDACTED);
    return {
      port: this.port,
      enginePath: this.enginePath,
      dataMode: this.dataMode,
      liveVenue: this.liveVenue,
      replayFixture: this.replayFixture,
      replaySpeed: this.replaySpeed,
      allowedOrigins: [...this.allowedOrigins],
      webUrl: this.webUrl,
      killSwitch: this.killSwitch,
      openaiModel: this.openaiModel,
      dbAdapter: this.dbAdapter ?? null,
      nodeEnv: this.nodeEnv ?? null,
      openaiApiKey: mask(this.openaiApiKey),
      databaseUrl: mask(this.databaseUrl),
      directUrl: mask(this.directUrl),
      sessionSecret: mask(this.sessionSecret),
    };
  }

  [inspectCustom](): Record<string, unknown> {
    return this.toJSON();
  }
}

/**
 * Parses the Server configuration. Pure: no logging, no exit, no reads beyond `env`.
 * Empty strings count as unset, so blank `.env.example` placeholders select the defaults.
 */
export function loadConfig(env: EnvRecord = Bun.env, options: LoadConfigOptions = {}): ConfigResult {
  const platform = options.platform ?? process.platform;

  const input: Partial<Record<ConfigVar, string>> = {};
  for (const name of CONFIG_VARS) {
    const value = env[name];
    if (value !== undefined && value !== "") input[name] = value;
  }

  const issues: ConfigIssue[] = [];
  const parsed = EnvSchema.safeParse(input);
  if (!parsed.success) {
    const invalid = new Set<ConfigVar>();
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      const name = CONFIG_VARS.find((v) => v === key);
      if (name !== undefined) invalid.add(name);
    }
    // Report in CONFIG_VARS order; messages never include the rejected value (Req 16.2).
    for (const name of CONFIG_VARS) {
      if (invalid.has(name)) {
        issues.push({ variable: name, problem: "invalid", message: `${name} is invalid: expected ${EXPECTED[name]}` });
      }
    }
  }

  // Req 16.9: WEB_URL must be one of ALLOWED_ORIGINS. Checked only when both values are
  // individually valid, so a malformed value is reported once, as invalid, above.
  const webOrigin = input.WEB_URL === undefined ? undefined : normalizeOrigin(input.WEB_URL);
  const origins = input.ALLOWED_ORIGINS === undefined ? DEFAULT_ALLOWED_ORIGINS : parseOrigins(input.ALLOWED_ORIGINS);
  if (webOrigin !== undefined && webOrigin !== null && origins !== null && !origins.includes(webOrigin)) {
    issues.push({
      variable: "WEB_URL",
      problem: "invalid",
      message: "WEB_URL is invalid: expected an origin listed in ALLOWED_ORIGINS",
    });
  }

  // Req 16.5, 16.7: in production both database URLs and SESSION_SECRET are required;
  // report each unset one by name.
  if (input.NODE_ENV === "production") {
    for (const name of ["DATABASE_URL", "DIRECT_URL", "SESSION_SECRET"] as const) {
      if (input[name] === undefined) {
        issues.push({ variable: name, problem: "missing", message: `${name} is required when NODE_ENV=production` });
      }
    }
  }

  if (!parsed.success || issues.length > 0) {
    return { ok: false, error: new ConfigError(issues) };
  }

  const data = parsed.data;
  const enginePath = data.ENGINE_PATH ?? (platform === "win32" ? `${DEFAULT_ENGINE_PATH}.exe` : DEFAULT_ENGINE_PATH);
  // ALLOWED_ORIGINS always parses to at least one origin, so the fallback is unreachable.
  const webUrl = data.WEB_URL ?? data.ALLOWED_ORIGINS[0] ?? DEFAULT_ALLOWED_ORIGINS[0] ?? "";

  const warnings: string[] = [];
  if (data.DATABASE_URL === undefined) {
    // Req 16.6: outside production the journal falls back to memory.
    warnings.push("DATABASE_URL is unset: the Journal is kept in memory only and is not persisted");
  }

  let sessionSecret = data.SESSION_SECRET;
  if (sessionSecret === undefined) {
    // Req 16.8: outside production (production was rejected above), use a random
    // per-process secret. Tokens signed with it die with the process.
    sessionSecret = generateSessionSecret();
    warnings.push(
      "SESSION_SECRET is unset: using a random per-process secret, so Session_Tokens will not survive a Server restart",
    );
  }

  return { ok: true, config: new Config(data, { enginePath, webUrl, sessionSecret }), warnings };
}

export interface ExitDeps {
  readonly log: (line: string) => void;
  readonly exit: (code: number) => never;
}

const defaultExitDeps: ExitDeps = {
  log: (line) => console.error(line),
  exit: (code) => process.exit(code),
};

/** Logs each offending variable name (never its value) and exits with code 1 (Req 16.2, 16.5). */
export function exitOnInvalidConfig(error: ConfigError, deps: ExitDeps = defaultExitDeps): never {
  deps.log(`[config] ${error.message}`);
  for (const issue of error.issues) deps.log(`[config] ${issue.message}`);
  return deps.exit(1);
}

/** Startup entry point: returns the config, logging warnings, or logs the problems and exits 1. */
export function loadConfigOrExit(
  env: EnvRecord = Bun.env,
  options: LoadConfigOptions = {},
  deps: ExitDeps & { readonly warn: (line: string) => void } = {
    ...defaultExitDeps,
    warn: (line) => console.warn(line),
  },
): Config {
  const result = loadConfig(env, options);
  if (!result.ok) return exitOnInvalidConfig(result.error, deps);
  for (const warning of result.warnings) deps.warn(`[config] ${warning}`);
  return result.config;
}

/** `Config` satisfies this; `sessionSecret` is optional so narrow test doubles still type-check. */
export type SecretSource = Pick<Config, "openaiApiKey" | "databaseUrl" | "directUrl"> & {
  readonly sessionSecret?: string | undefined;
};

function urlPasswords(value: string | undefined): string[] {
  if (value === undefined) return [];
  try {
    const raw = new URL(value).password;
    if (raw === "") return [];
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      // Malformed percent-encoding: only the raw form can appear in text.
    }
    return [raw, decoded];
  } catch {
    return [];
  }
}

/**
 * Replaces every occurrence of OPENAI_API_KEY, the full DATABASE_URL, the full
 * DIRECT_URL, each URL password (raw and percent-decoded), and SESSION_SECRET
 * with "[redacted]" (Req 16.4). Use on any text that may quote connection details
 * before logging it.
 */
export function redactSecrets(text: string, config: SecretSource): string {
  const secrets = new Set<string>();
  for (const value of [config.openaiApiKey, config.databaseUrl, config.directUrl, config.sessionSecret]) {
    if (value !== undefined && value !== "") secrets.add(value);
  }
  for (const pw of [...urlPasswords(config.databaseUrl), ...urlPasswords(config.directUrl)]) {
    if (pw !== "") secrets.add(pw);
  }
  // Longest first, so a full URL is replaced before its password would split it.
  const ordered = [...secrets].sort((a, b) => b.length - a.length);
  let out = text;
  for (const secret of ordered) out = out.split(secret).join(REDACTED);
  return out;
}
