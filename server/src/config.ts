// Server configuration from environment variables (Req 16).
//
// `loadConfig` reads only the env record it is given and returns a result
// instead of logging or exiting, so it can be tested. Its one side effect is
// drawing random bytes for the development SESSION_SECRET fallback (Req 16.8).
// `loadConfigOrExit` is the startup wrapper that logs variable NAMES (never
// values) and exits 1.
//
// Secrets (Req 16.4, trading-safety rule 6): OPENAI_API_KEY and SESSION_SECRET.
// They live in private fields, are hidden from toJSON and inspect, and
// `redactSecrets` scrubs them from any text before it reaches a log or a response.
// There is no database, so there are no database URLs (Req 1.3).
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
  "LIVE_VENUES",
  "STARTING_BALANCE",
  "BALANCE_SLIPPAGE_BPS",
  "DEX_LEVELS",
  "DEX_SPREAD_BPS",
  "DEX_STEP_BPS",
  "DEX_LEVEL_NOTIONAL",
  "DEX_MAX_DEVIATION_PCT",
  "JUPITER_POLL_MS",
  "RAYDIUM_POLL_MS",
  "JUPITER_API_KEY",
  "AI_RATE_PER_MIN",
  "AI_DAILY_CAP",
  "REPLAY_FIXTURE",
  "REPLAY_SPEED",
  "ALLOWED_ORIGINS",
  "WEB_URL",
  "SESSION_SECRET",
  "KILL_SWITCH",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "NVIDIA_API_KEY",
  "NVIDIA_MODEL",
  "NVIDIA_BASE_URL",
  "OLLAMA_BASE_URL",
  "OLLAMA_MODEL",
  "LLM_PROVIDER",
  "NEWS_PROVIDER",
  "NEWS_API_KEY",
  "CRYPTOPANIC_API_KEY",
  "CRYPTOPANIC_PLAN",
  "NEWS_TTL_SECONDS",
  "NEWS_ALLOW_NEWSAPI_IN_PRODUCTION",
  "NODE_ENV",
] as const;

/** News provider choices (Req 19.3) and CryptoPanic plans (Req 19.5). */
export const NEWS_PROVIDER_CHOICES = ["newsapi", "cryptopanic", "none"] as const;
export type NewsProviderChoice = (typeof NEWS_PROVIDER_CHOICES)[number];
export const CRYPTOPANIC_PLANS = ["developer", "growth", "enterprise"] as const;
export type CryptoPanicPlan = (typeof CRYPTOPANIC_PLANS)[number];
export const MIN_NEWS_TTL_SECONDS = 300;
export const MAX_NEWS_TTL_SECONDS = 3600;
export const DEFAULT_NEWS_TTL_SECONDS = 900;

/** LLM provider identifiers in default-selection order (Req 4.4). */
export const LLM_PROVIDER_IDS = ["ollama", "openai", "anthropic", "nvidia"] as const;
export type LlmProviderId = (typeof LLM_PROVIDER_IDS)[number];

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
  LIVE_VENUES: "a comma-separated list of coinbase, backpack, jupiter, raydium",
  STARTING_BALANCE: "an integer from 1000 to 100000000",
  BALANCE_SLIPPAGE_BPS: "an integer from 0 to 10000",
  DEX_LEVELS: "an integer from 1 to 50",
  DEX_SPREAD_BPS: "an integer from 1 to 10000",
  DEX_STEP_BPS: "an integer from 1 to 1000",
  DEX_LEVEL_NOTIONAL: "an integer from 1 to 1000000000",
  DEX_MAX_DEVIATION_PCT: "an integer from 1 to 100",
  JUPITER_POLL_MS: "an integer from 500 to 60000",
  RAYDIUM_POLL_MS: "an integer from 1000 to 60000",
  JUPITER_API_KEY: "a non-empty string",
  AI_RATE_PER_MIN: "an integer from 1 to 1000",
  AI_DAILY_CAP: "an integer from 1 to 1000000",
  REPLAY_FIXTURE: "a fixture file name matching ^[a-z0-9-]+\\.jsonl$",
  REPLAY_SPEED: "an integer from 1 to 50",
  ALLOWED_ORIGINS: "a comma-separated list of http(s) origins such as http://localhost:3000",
  WEB_URL: "an http(s) origin such as http://localhost:3000",
  SESSION_SECRET: `at least ${MIN_SESSION_SECRET_BYTES} bytes (UTF-8 length)`,
  KILL_SWITCH: '"true" or "false"',
  OPENAI_API_KEY: "a non-empty string",
  OPENAI_MODEL: "a non-empty string",
  ANTHROPIC_API_KEY: "a non-empty string",
  ANTHROPIC_MODEL: "a non-empty string",
  NVIDIA_API_KEY: "a non-empty string",
  NVIDIA_MODEL: "a non-empty string",
  NVIDIA_BASE_URL: "an http(s) URL with no credentials, query string, or fragment",
  OLLAMA_BASE_URL: "an http(s) URL with no credentials, query string, or fragment",
  OLLAMA_MODEL: "a non-empty string",
  LLM_PROVIDER: `one of ${LLM_PROVIDER_IDS.join(", ")}`,
  NEWS_PROVIDER: `one of ${NEWS_PROVIDER_CHOICES.join(", ")}`,
  NEWS_API_KEY: "a non-empty string",
  CRYPTOPANIC_API_KEY: "a non-empty string",
  CRYPTOPANIC_PLAN: `one of ${CRYPTOPANIC_PLANS.join(", ")}`,
  NEWS_TTL_SECONDS: `an integer from ${MIN_NEWS_TTL_SECONDS} to ${MAX_NEWS_TTL_SECONDS}`,
  NEWS_ALLOW_NEWSAPI_IN_PRODUCTION: '"true" or "false"',
  NODE_ENV: '"development", "production", or "test"',
};

/**
 * Default model for plain-English orders (Task 13.1). Verified as a listed model with
 * structured outputs on the Responses API at https://developers.openai.com/api/docs/models/gpt-5.4-mini
 */
export const DEFAULT_OPENAI_MODEL = "gpt-6-luna";
export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-5-5";
export const DEFAULT_NVIDIA_MODEL = "z-ai/glm-5.3-flash";
export const DEFAULT_OLLAMA_MODEL = "gemma4";
export const DEFAULT_NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
// 127.0.0.1, not localhost: on Windows `localhost` can resolve to ::1 first, where Ollama does not listen.
export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";

/**
 * Validates a provider base URL: http(s), no userinfo, no query, no fragment. Returns the URL
 * without a trailing slash, or null. Never throws and never echoes the input.
 */
export function normalizeBaseUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const ok =
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      !value.includes("?") &&
      !value.includes("#");
    if (!ok) return null;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

const baseUrl = z
  .string()
  .refine((v) => normalizeBaseUrl(v) !== null)
  .transform((v) => normalizeBaseUrl(v) ?? "");

export const LIVE_VENUE_NAMES = ["coinbase", "backpack", "jupiter", "raydium"] as const;
export type LiveVenueName = (typeof LIVE_VENUE_NAMES)[number];

/** Parses a LIVE_VENUES list: known names only, deduplicated, at least one. Null when invalid. */
export function parseLiveVenues(value: string): LiveVenueName[] | null {
  const out: LiveVenueName[] = [];
  for (const part of value.split(",").map((p) => p.trim().toLowerCase())) {
    if (part === "") continue;
    const name = LIVE_VENUE_NAMES.find((n) => n === part);
    if (name === undefined) return null;
    if (!out.includes(name)) out.push(name);
  }
  return out.length === 0 ? null : out;
}

const DEFAULT_ENGINE_PATH = "rust/target/release/engine";
const FIXTURE_NAME = /^[a-z0-9-]+\.jsonl$/;
/** Replay speed bounds (Req 6.3, 6.4; `MIN_REPLAY_SPEED`/`MAX_REPLAY_SPEED` in the protocol crate). */
export const MIN_REPLAY_SPEED = 1;
export const MAX_REPLAY_SPEED = 50;

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

/** Decimal integer string within [min, max]. */
function intRange(min: number, max: number, digits: number) {
  return z
    .string()
    .regex(new RegExp(`^[0-9]{1,${digits}}$`))
    .transform(Number)
    .refine((n) => n >= min && n <= max);
}

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
  // Alias of a one-venue LIVE_VENUES. LIVE_VENUES wins when both are set.
  LIVE_VENUE: z.enum(["coinbase", "backpack"]).optional(),
  LIVE_VENUES: z
    .string()
    .refine((v) => parseLiveVenues(v) !== null)
    .transform((v) => parseLiveVenues(v) ?? [])
    .optional(),
  STARTING_BALANCE: intRange(1_000, 100_000_000, 8).default(100_000),
  BALANCE_SLIPPAGE_BPS: intRange(0, 10_000, 5).default(100),
  DEX_LEVELS: intRange(1, 50, 2).default(10),
  DEX_SPREAD_BPS: intRange(1, 10_000, 5).default(10),
  DEX_STEP_BPS: intRange(1, 1_000, 4).default(5),
  DEX_LEVEL_NOTIONAL: intRange(1, 1_000_000_000, 10).default(25_000),
  DEX_MAX_DEVIATION_PCT: intRange(1, 100, 3).default(5),
  JUPITER_POLL_MS: intRange(500, 60_000, 5).optional(),
  RAYDIUM_POLL_MS: intRange(1_000, 60_000, 5).optional(),
  JUPITER_API_KEY: nonEmpty.optional(),
  AI_RATE_PER_MIN: intRange(1, 1_000, 4).default(6),
  AI_DAILY_CAP: intRange(1, 1_000_000, 7).default(500),
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
  KILL_SWITCH: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  OPENAI_API_KEY: nonEmpty.optional(),
  OPENAI_MODEL: nonEmpty.optional(),
  ANTHROPIC_API_KEY: nonEmpty.optional(),
  ANTHROPIC_MODEL: nonEmpty.default(DEFAULT_ANTHROPIC_MODEL),
  NVIDIA_API_KEY: nonEmpty.optional(),
  NVIDIA_MODEL: nonEmpty.default(DEFAULT_NVIDIA_MODEL),
  NVIDIA_BASE_URL: baseUrl.default(DEFAULT_NVIDIA_BASE_URL),
  OLLAMA_BASE_URL: baseUrl.default(DEFAULT_OLLAMA_BASE_URL),
  OLLAMA_MODEL: nonEmpty.default(DEFAULT_OLLAMA_MODEL),
  LLM_PROVIDER: z.enum(LLM_PROVIDER_IDS).optional(),
  NEWS_PROVIDER: z.enum(NEWS_PROVIDER_CHOICES).optional(),
  NEWS_API_KEY: nonEmpty.optional(),
  CRYPTOPANIC_API_KEY: nonEmpty.optional(),
  CRYPTOPANIC_PLAN: z.enum(CRYPTOPANIC_PLANS).default("developer"),
  NEWS_TTL_SECONDS: z
    .string()
    .regex(/^[0-9]{1,4}$/)
    .transform(Number)
    .refine((n) => n >= MIN_NEWS_TTL_SECONDS && n <= MAX_NEWS_TTL_SECONDS)
    .default(DEFAULT_NEWS_TTL_SECONDS),
  NEWS_ALLOW_NEWSAPI_IN_PRODUCTION: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  NODE_ENV: z.enum(["development", "production", "test"]).optional(),
});

type ParsedEnv = z.output<typeof EnvSchema>;

interface Secrets {
  readonly anthropicApiKey: string | undefined;
  readonly nvidiaApiKey: string | undefined;
  readonly newsApiKey: string | undefined;
  readonly cryptopanicApiKey: string | undefined;
  /** URLs can carry credentials, so they are secrets in logs (trading-safety rule 6). */
  readonly nvidiaBaseUrl: string;
  readonly ollamaBaseUrl: string;
  readonly openaiApiKey: string | undefined;
  readonly jupiterApiKey: string | undefined;
  readonly sessionSecret: string;
}

/** Values loadConfig derives from the parsed env before building the Config. */
interface Resolved {
  readonly newsProvider: NewsProviderChoice;
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
  /** Live venues from LIVE_VENUES (or the LIVE_VENUE alias); all four by default. */
  readonly liveVenues: readonly LiveVenueName[];
  readonly startingBalance: number;
  readonly balanceSlippageBps: number;
  readonly dexLevels: number;
  readonly dexSpreadBps: number;
  readonly dexStepBps: number;
  readonly dexLevelNotional: number;
  readonly dexMaxDeviationPct: number;
  readonly jupiterPollMs: number | undefined;
  readonly raydiumPollMs: number | undefined;
  readonly aiRatePerMin: number;
  readonly aiDailyCap: number;
  readonly replayFixture: string;
  /** Speed sent with `StartReplay` (1–50). */
  readonly replaySpeed: number;
  readonly allowedOrigins: readonly string[];
  /** Normalized web UI origin, always one of `allowedOrigins` (Req 16.9). SIWS domain and pair URL base. */
  readonly webUrl: string;
  readonly killSwitch: boolean;
  /** OPENAI_MODEL, or DEFAULT_OPENAI_MODEL when unset. */
  readonly openaiModel: string;
  readonly anthropicModel: string;
  readonly nvidiaModel: string;
  readonly ollamaModel: string;
  /** LLM_PROVIDER, or undefined to pick the first available (Req 4.4). */
  readonly llmProvider: LlmProviderId | undefined;
  readonly nodeEnv: "development" | "production" | "test" | undefined;
  /** Effective news provider after the default rule and the production NewsAPI rule (Req 19.3, 20.1, 20.2). */
  readonly newsProvider: NewsProviderChoice;
  readonly cryptopanicPlan: CryptoPanicPlan;
  readonly newsTtlSeconds: number;
  // Private, so the secrets are not own enumerable properties (spread, Object.keys,
  // default inspect) and are reachable only through the getters below.
  readonly #secrets: Secrets;

  constructor(parsed: ParsedEnv, resolved: Resolved) {
    this.port = parsed.PORT;
    this.enginePath = resolved.enginePath;
    this.dataMode = parsed.DATA_MODE;
    this.liveVenues = Object.freeze(
      parsed.LIVE_VENUES ?? (parsed.LIVE_VENUE !== undefined ? [parsed.LIVE_VENUE] : [...LIVE_VENUE_NAMES]),
    );
    const firstCex = this.liveVenues.find((v) => v === "coinbase" || v === "backpack");
    this.liveVenue = firstCex === "coinbase" || firstCex === "backpack" ? firstCex : "backpack";
    this.startingBalance = parsed.STARTING_BALANCE;
    this.balanceSlippageBps = parsed.BALANCE_SLIPPAGE_BPS;
    this.dexLevels = parsed.DEX_LEVELS;
    this.dexSpreadBps = parsed.DEX_SPREAD_BPS;
    this.dexStepBps = parsed.DEX_STEP_BPS;
    this.dexLevelNotional = parsed.DEX_LEVEL_NOTIONAL;
    this.dexMaxDeviationPct = parsed.DEX_MAX_DEVIATION_PCT;
    this.jupiterPollMs = parsed.JUPITER_POLL_MS;
    this.raydiumPollMs = parsed.RAYDIUM_POLL_MS;
    this.aiRatePerMin = parsed.AI_RATE_PER_MIN;
    this.aiDailyCap = parsed.AI_DAILY_CAP;
    this.replayFixture = parsed.REPLAY_FIXTURE;
    this.replaySpeed = parsed.REPLAY_SPEED;
    this.allowedOrigins = Object.freeze([...parsed.ALLOWED_ORIGINS]);
    this.webUrl = resolved.webUrl;
    this.killSwitch = parsed.KILL_SWITCH;
    this.openaiModel = parsed.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL;
    this.anthropicModel = parsed.ANTHROPIC_MODEL;
    this.nvidiaModel = parsed.NVIDIA_MODEL;
    this.ollamaModel = parsed.OLLAMA_MODEL;
    this.llmProvider = parsed.LLM_PROVIDER;
    this.nodeEnv = parsed.NODE_ENV;
    this.newsProvider = resolved.newsProvider;
    this.cryptopanicPlan = parsed.CRYPTOPANIC_PLAN;
    this.newsTtlSeconds = parsed.NEWS_TTL_SECONDS;
    this.#secrets = Object.freeze({
      newsApiKey: parsed.NEWS_API_KEY,
      cryptopanicApiKey: parsed.CRYPTOPANIC_API_KEY,
      anthropicApiKey: parsed.ANTHROPIC_API_KEY,
      nvidiaApiKey: parsed.NVIDIA_API_KEY,
      nvidiaBaseUrl: parsed.NVIDIA_BASE_URL,
      ollamaBaseUrl: parsed.OLLAMA_BASE_URL,
      openaiApiKey: parsed.OPENAI_API_KEY,
      jupiterApiKey: parsed.JUPITER_API_KEY,
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

  /** Reaches the engine only through its child environment. */
  get jupiterApiKey(): string | undefined {
    return this.#secrets.jupiterApiKey;
  }

  get anthropicApiKey(): string | undefined {
    return this.#secrets.anthropicApiKey;
  }

  get nvidiaApiKey(): string | undefined {
    return this.#secrets.nvidiaApiKey;
  }

  get newsApiKey(): string | undefined {
    return this.#secrets.newsApiKey;
  }

  get cryptopanicApiKey(): string | undefined {
    return this.#secrets.cryptopanicApiKey;
  }

  get nvidiaBaseUrl(): string {
    return this.#secrets.nvidiaBaseUrl;
  }

  get ollamaBaseUrl(): string {
    return this.#secrets.ollamaBaseUrl;
  }

  /** Host (with port) of a base URL: the only part that may be logged. */
  get nvidiaHost(): string {
    return new URL(this.#secrets.nvidiaBaseUrl).host;
  }

  get ollamaHost(): string {
    return new URL(this.#secrets.ollamaBaseUrl).host;
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
      liveVenues: [...this.liveVenues],
      startingBalance: this.startingBalance,
      balanceSlippageBps: this.balanceSlippageBps,
      dexLevels: this.dexLevels,
      dexSpreadBps: this.dexSpreadBps,
      dexStepBps: this.dexStepBps,
      dexLevelNotional: this.dexLevelNotional,
      dexMaxDeviationPct: this.dexMaxDeviationPct,
      jupiterPollMs: this.jupiterPollMs ?? null,
      raydiumPollMs: this.raydiumPollMs ?? null,
      aiRatePerMin: this.aiRatePerMin,
      aiDailyCap: this.aiDailyCap,
      replayFixture: this.replayFixture,
      replaySpeed: this.replaySpeed,
      allowedOrigins: [...this.allowedOrigins],
      webUrl: this.webUrl,
      killSwitch: this.killSwitch,
      openaiModel: this.openaiModel,
      anthropicModel: this.anthropicModel,
      nvidiaModel: this.nvidiaModel,
      ollamaModel: this.ollamaModel,
      llmProvider: this.llmProvider ?? null,
      nodeEnv: this.nodeEnv ?? null,
      newsProvider: this.newsProvider,
      cryptopanicPlan: this.cryptopanicPlan,
      newsTtlSeconds: this.newsTtlSeconds,
      newsApiKey: mask(this.newsApiKey),
      cryptopanicApiKey: mask(this.cryptopanicApiKey),
      anthropicApiKey: mask(this.anthropicApiKey),
      nvidiaApiKey: mask(this.nvidiaApiKey),
      nvidiaBaseUrl: REDACTED,
      ollamaBaseUrl: REDACTED,
      openaiApiKey: mask(this.openaiApiKey),
      jupiterApiKey: mask(this.jupiterApiKey),
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

  // Req 16.7: in production SESSION_SECRET is required.
  if (input.NODE_ENV === "production" && input.SESSION_SECRET === undefined) {
    issues.push({
      variable: "SESSION_SECRET",
      problem: "missing",
      message: "SESSION_SECRET is required when NODE_ENV=production",
    });
  }

  if (!parsed.success || issues.length > 0) {
    return { ok: false, error: new ConfigError(issues) };
  }

  const data = parsed.data;
  const enginePath = data.ENGINE_PATH ?? (platform === "win32" ? `${DEFAULT_ENGINE_PATH}.exe` : DEFAULT_ENGINE_PATH);
  // ALLOWED_ORIGINS always parses to at least one origin, so the fallback is unreachable.
  const webUrl = data.WEB_URL ?? data.ALLOWED_ORIGINS[0] ?? DEFAULT_ALLOWED_ORIGINS[0] ?? "";

  const warnings: string[] = [];

  let sessionSecret = data.SESSION_SECRET;
  if (sessionSecret === undefined) {
    // Req 16.8: outside production (production was rejected above), use a random
    // per-process secret. Tokens signed with it die with the process.
    sessionSecret = generateSessionSecret();
    warnings.push(
      "SESSION_SECRET is unset: using a random per-process secret, so Session_Tokens will not survive a Server restart",
    );
  }

  const newsProvider = resolveNewsProvider(data, warnings);

  return { ok: true, config: new Config(data, { enginePath, webUrl, sessionSecret, newsProvider }), warnings };
}

/**
 * News provider selection (Req 19.3) and the production NewsAPI rule (Req 20.1, 20.2).
 * Default: newsapi outside production with NEWS_API_KEY, cryptopanic in production with
 * CRYPTOPANIC_API_KEY, else none. Production disables newsapi unless explicitly allowed.
 */
function resolveNewsProvider(data: ParsedEnv, warnings: string[]): NewsProviderChoice {
  const production = data.NODE_ENV === "production";
  let choice: NewsProviderChoice;
  if (data.NEWS_PROVIDER !== undefined) choice = data.NEWS_PROVIDER;
  else if (!production && data.NEWS_API_KEY !== undefined) choice = "newsapi";
  else if (production && data.CRYPTOPANIC_API_KEY !== undefined) choice = "cryptopanic";
  else choice = "none";

  if (production && choice === "newsapi" && !data.NEWS_ALLOW_NEWSAPI_IN_PRODUCTION) {
    warnings.push(
      "NEWS_PROVIDER=newsapi is disabled in production: the NewsAPI Developer plan permits development use only (set NEWS_ALLOW_NEWSAPI_IN_PRODUCTION=true for a plan that allows production)",
    );
    return "none";
  }
  return choice;
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
export type SecretSource = Pick<Config, "openaiApiKey"> & {
  readonly newsApiKey?: string | undefined;
  readonly cryptopanicApiKey?: string | undefined;
  readonly jupiterApiKey?: string | undefined;
  readonly sessionSecret?: string | undefined;
  readonly anthropicApiKey?: string | undefined;
  readonly nvidiaApiKey?: string | undefined;
  readonly nvidiaBaseUrl?: string | undefined;
  readonly ollamaBaseUrl?: string | undefined;
};

/**
 * Replaces every occurrence of OPENAI_API_KEY and SESSION_SECRET with "[redacted]"
 * (Req 16.4). Use on any text that may quote a secret before logging it.
 */
export function redactSecrets(text: string, config: SecretSource): string {
  const secrets = new Set<string>();
  for (const value of [
    config.openaiApiKey,
    config.sessionSecret,
    config.anthropicApiKey,
    config.nvidiaApiKey,
    config.newsApiKey,
    config.cryptopanicApiKey,
    config.jupiterApiKey,
    config.nvidiaBaseUrl,
    config.ollamaBaseUrl,
  ]) {
    if (value !== undefined && value !== "") secrets.add(value);
  }
  // Longest first, so a secret that contains another is replaced whole.
  const ordered = [...secrets].sort((a, b) => b.length - a.length);
  let out = text;
  for (const secret of ordered) out = out.split(secret).join(REDACTED);
  return out;
}
