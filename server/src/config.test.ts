// Tests for server configuration (Req 16.1–16.9).
import { describe, expect, test } from "bun:test";
import { inspect } from "node:util";
import {
  Config,
  ConfigError,
  DEFAULT_OPENAI_MODEL,
  REDACTED,
  exitOnInvalidConfig,
  loadConfig,
  loadConfigOrExit,
  redactSecrets,
  type ConfigVar,
  type EnvRecord,
} from "./config.ts";

const DB_PASSWORD = "s3cr3t-db-pw";
const DIRECT_PASSWORD = "s3cr3t-direct-pw";
const DATABASE_URL = `postgresql://app:${DB_PASSWORD}@ep-example-pooler.us-east-2.aws.neon.tech/haunted?sslmode=require`;
const DIRECT_URL = `postgres://app:${DIRECT_PASSWORD}@ep-example.us-east-2.aws.neon.tech/haunted?sslmode=require`;
const OPENAI_API_KEY = "sk-test-0123456789abcdef";
/** 40 ASCII characters = 40 UTF-8 bytes. */
const SESSION_SECRET = "test-session-secret-0123456789-abcdefghi";

function ok(env: EnvRecord, platform = "linux"): { config: Config; warnings: readonly string[] } {
  const result = loadConfig(env, { platform });
  if (!result.ok) throw new Error(`expected ok, got ${result.error.message}`);
  return result;
}

function fail(env: EnvRecord): ConfigError {
  const result = loadConfig(env, { platform: "linux" });
  if (result.ok) throw new Error("expected a config error");
  return result.error;
}

/**
 * The stack without its `at ...` frame lines. Frames hold only file paths and line:column
 * numbers, never config values, and a short rejected value such as "0" could appear in them by
 * chance. The header lines, which repeat the message, are kept and checked.
 */
function stackWithoutFrames(error: Error): string {
  return (error.stack ?? "")
    .split("\n")
    .filter((line) => !/^\s*at\s/.test(line))
    .join("\n");
}

/** Every string an operator could see from a ConfigError, except stack frame locations. */
function errorText(error: ConfigError): string {
  return [
    error.message,
    String(error),
    stackWithoutFrames(error),
    JSON.stringify(error),
    ...error.issues.map((i) => i.message),
  ].join("\n");
}

describe("loadConfig defaults (Req 16.1)", () => {
  test("empty env gives the design-table defaults", () => {
    const { config, warnings } = ok({});
    expect(config.port).toBe(8080);
    expect(config.enginePath).toBe("rust/target/release/engine");
    expect(config.dataMode).toBe("replay");
    expect(config.replayFixture).toBe("demo.jsonl");
    expect(config.replaySpeed).toBe(1);
    expect(config.allowedOrigins).toEqual(["http://localhost:3000"]);
    expect(config.killSwitch).toBe(false);
    expect(config.openaiApiKey).toBeUndefined();
    expect(config.openaiModel).toBe(DEFAULT_OPENAI_MODEL);
    expect(config.databaseUrl).toBeUndefined();
    expect(config.directUrl).toBeUndefined();
    expect(config.dbAdapter).toBeUndefined();
    expect(config.nodeEnv).toBeUndefined();
    expect(config.isProduction).toBe(false);
    expect(config.liveVenue).toBe("backpack");
    expect(config.webUrl).toBe("http://localhost:3000");
    // Req 16.6: outside production, no DATABASE_URL means an in-memory journal with a warning.
    // Req 16.8: no SESSION_SECRET means a per-process secret with a warning.
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("DATABASE_URL");
    expect(warnings[1]).toContain("SESSION_SECRET");
  });

  test("empty strings count as unset", () => {
    const blank: Record<string, string> = {};
    for (const name of ["PORT", "ENGINE_PATH", "DATA_MODE", "DATABASE_URL", "DB_ADAPTER", "NODE_ENV", "KILL_SWITCH"]) {
      blank[name] = "";
    }
    const { config } = ok(blank);
    expect(config.port).toBe(8080);
    expect(config.dataMode).toBe("replay");
    expect(config.databaseUrl).toBeUndefined();
  });

  test("ENGINE_PATH default gets .exe on win32 only", () => {
    expect(ok({}, "win32").config.enginePath).toBe("rust/target/release/engine.exe");
    expect(ok({}, "darwin").config.enginePath).toBe("rust/target/release/engine");
  });

  test("an explicit ENGINE_PATH is used as given, even on win32", () => {
    expect(ok({ ENGINE_PATH: "C:\\bin\\engine.exe" }, "win32").config.enginePath).toBe("C:\\bin\\engine.exe");
    expect(ok({ ENGINE_PATH: "/opt/engine" }, "win32").config.enginePath).toBe("/opt/engine");
  });

  test("parses a full valid environment", () => {
    const { config, warnings } = ok({
      PORT: "9000",
      DATA_MODE: "live",
      REPLAY_FIXTURE: "btc-2026-11.jsonl",
      ALLOWED_ORIGINS: "http://localhost:3000, https://haunted.example.com/ ,http://localhost:3000",
      KILL_SWITCH: "true",
      DATABASE_URL,
      DIRECT_URL,
      DB_ADAPTER: "pg",
      OPENAI_API_KEY,
      OPENAI_MODEL: "some-model",
      LIVE_VENUE: "coinbase",
      WEB_URL: "https://HAUNTED.example.com",
      SESSION_SECRET,
      NODE_ENV: "production",
      UNRELATED: "ignored",
    });
    expect(config.liveVenue).toBe("coinbase");
    expect(config.webUrl).toBe("https://haunted.example.com");
    expect(config.sessionSecret).toBe(SESSION_SECRET);
    expect(config.port).toBe(9000);
    expect(config.dataMode).toBe("live");
    expect(config.replayFixture).toBe("btc-2026-11.jsonl");
    expect(config.allowedOrigins).toEqual(["http://localhost:3000", "https://haunted.example.com"]);
    expect(config.killSwitch).toBe(true);
    expect(config.databaseUrl).toBe(DATABASE_URL);
    expect(config.directUrl).toBe(DIRECT_URL);
    expect(config.dbAdapter).toBe("pg");
    expect(config.openaiApiKey).toBe(OPENAI_API_KEY);
    expect(config.openaiModel).toBe("some-model");
    expect(config.isProduction).toBe(true);
    expect(warnings).toEqual([]);
  });
});

describe("invalid values (Req 16.2)", () => {
  const cases: ReadonlyArray<readonly [ConfigVar, string]> = [
    ["PORT", "80a80-bogus"],
    ["PORT", "70000"],
    ["PORT", "0"],
    ["DATA_MODE", "paper-real-zz"],
    ["REPLAY_FIXTURE", "../etc/passwd.jsonl"],
    ["REPLAY_FIXTURE", "Demo.JSONL"],
    ["REPLAY_SPEED", "fast-zz"],
    ["ALLOWED_ORIGINS", "javascript:alert(1)"],
    ["ALLOWED_ORIGINS", "http://ok.test,https://evil.test/path-zz"],
    ["ALLOWED_ORIGINS", " , "],
    ["DATABASE_URL", `mysql://app:${DB_PASSWORD}@db.example.com/haunted`],
    ["DATABASE_URL", `not a url ${DB_PASSWORD}`],
    ["DIRECT_URL", `https://app:${DIRECT_PASSWORD}@db.example.com/haunted`],
    ["DB_ADAPTER", "neon-zz"],
    ["KILL_SWITCH", "yes-zz"],
    ["NODE_ENV", "staging-zz"],
    ["LIVE_VENUE", "kraken-zz"],
    ["LIVE_VENUE", "Backpack"],
    ["WEB_URL", "ftp://web.example.com"],
    ["WEB_URL", "http://localhost:3000/pair-zz"],
    ["WEB_URL", "not an origin zz"],
    ["SESSION_SECRET", "short-secret-zz"],
  ];

  for (const [name, value] of cases) {
    test(`${name}=<invalid> names ${name} and hides the value`, () => {
      const error = fail({ [name]: value });
      expect(error.issues.map((i) => i.variable)).toEqual([name]);
      expect(error.issues[0]?.problem).toBe("invalid");
      expect(error.message).toContain(name);
      const text = errorText(error);
      expect(text).not.toContain(value);
      expect(text).not.toContain(DB_PASSWORD);
      expect(text).not.toContain(DIRECT_PASSWORD);
    });
  }

  test("every invalid variable is reported", () => {
    const error = fail({ PORT: "x", DATA_MODE: "y", KILL_SWITCH: "z" });
    expect(error.issues.map((i) => i.variable)).toEqual(["PORT", "DATA_MODE", "KILL_SWITCH"]);
  });
});

describe("production requires both database URLs and SESSION_SECRET (Req 16.5, 16.7)", () => {
  test("nothing set: all three names reported as missing", () => {
    const error = fail({ NODE_ENV: "production" });
    expect(error.issues.map((i) => [i.variable, i.problem])).toEqual([
      ["DATABASE_URL", "missing"],
      ["DIRECT_URL", "missing"],
      ["SESSION_SECRET", "missing"],
    ]);
  });

  test("only DATABASE_URL and SESSION_SECRET set: DIRECT_URL reported", () => {
    const error = fail({ NODE_ENV: "production", DATABASE_URL, SESSION_SECRET });
    expect(error.issues.map((i) => i.variable)).toEqual(["DIRECT_URL"]);
    expect(errorText(error)).not.toContain(DB_PASSWORD);
    expect(errorText(error)).not.toContain(SESSION_SECRET);
  });

  test("only DIRECT_URL and SESSION_SECRET set: DATABASE_URL reported", () => {
    const error = fail({ NODE_ENV: "production", DIRECT_URL, SESSION_SECRET });
    expect(error.issues.map((i) => i.variable)).toEqual(["DATABASE_URL"]);
  });

  test("missing and invalid issues are reported together", () => {
    const error = fail({ NODE_ENV: "production", PORT: "nope", DIRECT_URL: "mysql://x@y/z", SESSION_SECRET });
    expect(error.issues.map((i) => [i.variable, i.problem])).toEqual([
      ["PORT", "invalid"],
      ["DIRECT_URL", "invalid"],
      ["DATABASE_URL", "missing"],
    ]);
  });

  test("all three set: ok, with no warnings", () => {
    const { config, warnings } = ok({ NODE_ENV: "production", DATABASE_URL, DIRECT_URL, SESSION_SECRET });
    expect(config.isProduction).toBe(true);
    expect(warnings).toEqual([]);
  });

  test("outside production, missing URLs are allowed", () => {
    expect(ok({ NODE_ENV: "development" }).config.databaseUrl).toBeUndefined();
  });
});

describe("SESSION_SECRET (Req 16.7, 16.8)", () => {
  const prod = { NODE_ENV: "production", DATABASE_URL, DIRECT_URL } as const;

  test("production without SESSION_SECRET: only that name is reported, as missing", () => {
    const error = fail(prod);
    expect(error.issues.map((i) => [i.variable, i.problem])).toEqual([["SESSION_SECRET", "missing"]]);
    expect(error.message).toContain("SESSION_SECRET");
  });

  test("production with an empty SESSION_SECRET counts as missing", () => {
    expect(fail({ ...prod, SESSION_SECRET: "" }).issues.map((i) => [i.variable, i.problem])).toEqual([
      ["SESSION_SECRET", "missing"],
    ]);
  });

  test("a too-short SESSION_SECRET is invalid (not missing) in production and hides the value", () => {
    const short = "short-secret-value-zz";
    const error = fail({ ...prod, SESSION_SECRET: short });
    expect(error.issues.map((i) => [i.variable, i.problem])).toEqual([["SESSION_SECRET", "invalid"]]);
    expect(errorText(error)).not.toContain(short);
  });

  test("a too-short SESSION_SECRET is rejected outside production too, and the log hides it", () => {
    const short = "short-secret-value-zz";
    const lines: string[] = [];
    let code: number | undefined;
    try {
      loadConfigOrExit(
        { SESSION_SECRET: short },
        { platform: "linux" },
        {
          log: (l) => lines.push(l),
          warn: (l) => lines.push(l),
          exit: (c) => {
            code = c;
            throw new Error("exit");
          },
        },
      );
    } catch {
      // exit stub
    }
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("SESSION_SECRET");
    expect(lines.join("\n")).not.toContain(short);
  });

  test("the length limit is 32 bytes of UTF-8, not 32 characters", () => {
    expect(fail({ SESSION_SECRET: "a".repeat(31) }).issues.map((i) => i.variable)).toEqual(["SESSION_SECRET"]);
    expect(ok({ SESSION_SECRET: "a".repeat(32) }).config.sessionSecret).toBe("a".repeat(32));
    // 16 two-byte characters = 32 bytes: accepted. 15 of them plus one ASCII = 31 bytes: rejected.
    expect(ok({ SESSION_SECRET: "é".repeat(16) }).config.sessionSecret).toBe("é".repeat(16));
    expect(fail({ SESSION_SECRET: `${"é".repeat(15)}a` }).issues.map((i) => i.variable)).toEqual(["SESSION_SECRET"]);
  });

  test("a valid SESSION_SECRET is used as given and produces no SESSION_SECRET warning", () => {
    const { config, warnings } = ok({ SESSION_SECRET });
    expect(config.sessionSecret).toBe(SESSION_SECRET);
    expect(warnings.some((w) => w.includes("SESSION_SECRET"))).toBe(false);
  });

  test("unset outside production: random 32-byte per-process secret and a warning", () => {
    const first = ok({});
    const second = ok({ SESSION_SECRET: "" });
    for (const { config, warnings } of [first, second]) {
      expect(new TextEncoder().encode(config.sessionSecret).length).toBeGreaterThanOrEqual(32);
      const warning = warnings.find((w) => w.includes("SESSION_SECRET"));
      expect(warning).toBeDefined();
      expect(warning).toContain("restart");
      expect(warnings.join("\n")).not.toContain(config.sessionSecret);
    }
    expect(first.config.sessionSecret).not.toBe(second.config.sessionSecret);
  });

  test("the fallback warning is logged by loadConfigOrExit, without the secret", () => {
    const lines: string[] = [];
    const config = loadConfigOrExit(
      { NODE_ENV: "development" },
      { platform: "linux" },
      {
        log: (l) => lines.push(l),
        warn: (l) => lines.push(l),
        exit: () => {
          throw new Error("unexpected exit");
        },
      },
    );
    expect(lines.some((l) => l.includes("SESSION_SECRET"))).toBe(true);
    expect(lines.join("\n")).not.toContain(config.sessionSecret);
  });
});

describe("LIVE_VENUE (Req 16.1)", () => {
  test("defaults to backpack when unset or empty", () => {
    expect(ok({}).config.liveVenue).toBe("backpack");
    expect(ok({ LIVE_VENUE: "" }).config.liveVenue).toBe("backpack");
  });

  test("accepts coinbase and backpack", () => {
    expect(ok({ LIVE_VENUE: "coinbase" }).config.liveVenue).toBe("coinbase");
    expect(ok({ LIVE_VENUE: "backpack" }).config.liveVenue).toBe("backpack");
    expect(ok({ LIVE_VENUE: "coinbase" }).config.toJSON()).toMatchObject({ liveVenue: "coinbase" });
  });

  test("any other value is invalid, even in replay mode", () => {
    for (const value of ["kraken-zz", "COINBASE", " coinbase", "coinbase,backpack"]) {
      const error = fail({ LIVE_VENUE: value, DATA_MODE: "replay" });
      expect(error.issues.map((i) => [i.variable, i.problem])).toEqual([["LIVE_VENUE", "invalid"]]);
      expect(errorText(error)).not.toContain(value);
    }
  });
});

describe("WEB_URL (Req 16.1, 16.9)", () => {
  test("defaults to the first ALLOWED_ORIGINS entry", () => {
    expect(ok({}).config.webUrl).toBe("http://localhost:3000");
    expect(ok({ WEB_URL: "" }).config.webUrl).toBe("http://localhost:3000");
    expect(ok({ ALLOWED_ORIGINS: "https://b.example.com/, http://localhost:3000" }).config.webUrl).toBe(
      "https://b.example.com",
    );
  });

  test("an explicit WEB_URL that is listed is accepted, even when it is not the first entry", () => {
    const env = { ALLOWED_ORIGINS: "https://a.example.com,https://b.example.com", WEB_URL: "https://b.example.com" };
    expect(ok(env).config.webUrl).toBe("https://b.example.com");
  });

  test("WEB_URL is normalized to scheme://host[:port] before the membership check", () => {
    const listed = { ALLOWED_ORIGINS: "https://haunted.example.com,http://localhost:3000" };
    for (const value of [
      "https://haunted.example.com/",
      "HTTPS://HAUNTED.example.com",
      "https://haunted.example.com:443",
    ]) {
      expect(ok({ ...listed, WEB_URL: value }).config.webUrl).toBe("https://haunted.example.com");
    }
    expect(ok({ WEB_URL: "http://LOCALHOST:3000/" }).config.webUrl).toBe("http://localhost:3000");
  });

  test("a WEB_URL that is not in ALLOWED_ORIGINS is rejected by name, without its value", () => {
    const value = "https://not-listed.example.com";
    for (const env of [
      { WEB_URL: value },
      { WEB_URL: value, ALLOWED_ORIGINS: "http://localhost:3000,https://other.example.com" },
    ]) {
      const error = fail(env);
      expect(error.issues.map((i) => [i.variable, i.problem])).toEqual([["WEB_URL", "invalid"]]);
      expect(error.message).toContain("WEB_URL");
      expect(errorText(error)).not.toContain(value);
    }
  });

  test("the default ALLOWED_ORIGINS is the list a lone WEB_URL is checked against", () => {
    expect(fail({ WEB_URL: "http://localhost:4000" }).issues.map((i) => i.variable)).toEqual(["WEB_URL"]);
  });

  test("a malformed ALLOWED_ORIGINS is reported once, not also as a WEB_URL mismatch", () => {
    const error = fail({ ALLOWED_ORIGINS: "javascript:alert(1)", WEB_URL: "http://localhost:3000" });
    expect(error.issues.map((i) => i.variable)).toEqual(["ALLOWED_ORIGINS"]);
  });

  test("a WEB_URL outside ALLOWED_ORIGINS logs its name and exits with code 1", () => {
    const value = "https://not-listed.example.com";
    const lines: string[] = [];
    let code: number | undefined;
    try {
      loadConfigOrExit(
        { WEB_URL: value },
        { platform: "linux" },
        {
          log: (l) => lines.push(l),
          warn: (l) => lines.push(l),
          exit: (c) => {
            code = c;
            throw new Error("exit");
          },
        },
      );
    } catch {
      // exit stub
    }
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("WEB_URL");
    expect(lines.join("\n")).not.toContain(value);
  });
});

describe("secrets stay out of serialized config (Req 16.4)", () => {
  const { config } = ok({ DATABASE_URL, DIRECT_URL, OPENAI_API_KEY, SESSION_SECRET });
  const leaks = [DATABASE_URL, DIRECT_URL, DB_PASSWORD, DIRECT_PASSWORD, OPENAI_API_KEY, SESSION_SECRET];

  function expectNoLeak(text: string): void {
    for (const secret of leaks) expect(text).not.toContain(secret);
  }

  test("toJSON / JSON.stringify", () => {
    const json = JSON.stringify(config);
    expectNoLeak(json);
    const parsed: unknown = JSON.parse(json);
    expect(parsed).toMatchObject({
      databaseUrl: REDACTED,
      directUrl: REDACTED,
      openaiApiKey: REDACTED,
      sessionSecret: REDACTED,
      port: 8080,
    });
  });

  test("unset secrets show as null, except the session secret, which always has a value", () => {
    const view = ok({}).config.toJSON();
    expect(view).toMatchObject({ databaseUrl: null, directUrl: null, openaiApiKey: null });
    expect(view).toMatchObject({ sessionSecret: REDACTED });
  });

  test("the generated fallback SESSION_SECRET is redacted everywhere too", () => {
    const { config: dev } = ok({});
    const generated = dev.sessionSecret;
    expect(generated.length).toBeGreaterThan(0);
    expect(JSON.stringify(dev)).not.toContain(generated);
    expect(Bun.inspect(dev)).not.toContain(generated);
    expect(inspect(dev, { depth: 10, showHidden: true })).not.toContain(generated);
    expect(JSON.stringify({ ...dev })).not.toContain(generated);
    expect(redactSecrets(`secret ${generated}`, dev)).toBe(`secret ${REDACTED}`);
  });

  test("Bun.inspect and node:util inspect", () => {
    const bunText = Bun.inspect(config);
    const nodeText = inspect(config, { depth: 10, showHidden: true });
    expectNoLeak(bunText);
    expectNoLeak(nodeText);
    expect(bunText).toContain(REDACTED);
    expect(nodeText).toContain(REDACTED);
  });

  test("spread, Object.keys, and Object.entries", () => {
    expectNoLeak(JSON.stringify({ ...config }));
    expectNoLeak(JSON.stringify(Object.entries(config)));
    expect(Object.keys(config)).not.toContain("databaseUrl");
    expect(Object.keys(config)).not.toContain("sessionSecret");
  });

  test("the getters still return the real values", () => {
    expect(config.sessionSecret).toBe(SESSION_SECRET);
    expect(config.databaseUrl).toBe(DATABASE_URL);
    expect(config.directUrl).toBe(DIRECT_URL);
    expect(config.openaiApiKey).toBe(OPENAI_API_KEY);
  });
});

describe("redactSecrets (Req 16.4)", () => {
  const { config } = ok({ DATABASE_URL, DIRECT_URL, OPENAI_API_KEY, SESSION_SECRET });

  test("replaces SESSION_SECRET wherever it appears", () => {
    const out = redactSecrets(`key=${SESSION_SECRET}; again ${SESSION_SECRET}`, config);
    expect(out).toBe(`key=${REDACTED}; again ${REDACTED}`);
    expect(out).not.toContain(SESSION_SECRET);
  });

  test("replaces full URLs, passwords, and the API key", () => {
    const text = [
      `connect ${DATABASE_URL} failed`,
      `migrate via ${DIRECT_URL}`,
      `auth failed for password ${DB_PASSWORD} and ${DIRECT_PASSWORD}`,
      `Authorization: Bearer ${OPENAI_API_KEY}`,
    ].join("\n");
    const out = redactSecrets(text, config);
    for (const secret of [DATABASE_URL, DIRECT_URL, DB_PASSWORD, DIRECT_PASSWORD, OPENAI_API_KEY]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toBe(
      [
        `connect ${REDACTED} failed`,
        `migrate via ${REDACTED}`,
        `auth failed for password ${REDACTED} and ${REDACTED}`,
        `Authorization: Bearer ${REDACTED}`,
      ].join("\n"),
    );
  });

  test("replaces every occurrence", () => {
    expect(redactSecrets(`${OPENAI_API_KEY}|${OPENAI_API_KEY}`, config)).toBe(`${REDACTED}|${REDACTED}`);
  });

  test("redacts both the percent-encoded and decoded password", () => {
    const url = "postgresql://app:p%40ss%2Fw0rd@db.example.com/haunted";
    const source = { openaiApiKey: undefined, databaseUrl: url, directUrl: undefined };
    const out = redactSecrets(`raw p%40ss%2Fw0rd decoded p@ss/w0rd url ${url}`, source);
    expect(out).toBe(`raw ${REDACTED} decoded ${REDACTED} url ${REDACTED}`);
  });

  test("leaves text unchanged when there is nothing to redact", () => {
    expect(redactSecrets("engine started", config)).toBe("engine started");
    expect(redactSecrets(`password ${DB_PASSWORD}`, ok({}).config)).toBe(`password ${DB_PASSWORD}`);
  });
});

describe("exitOnInvalidConfig / loadConfigOrExit (Req 16.2, 16.5)", () => {
  class Exit extends Error {
    constructor(readonly code: number) {
      super(`exit ${code}`);
    }
  }

  function capture(): { lines: string[]; deps: { log: (l: string) => void; warn: (l: string) => void; exit: (c: number) => never } } {
    const lines: string[] = [];
    return {
      lines,
      deps: {
        log: (l) => lines.push(`log ${l}`),
        warn: (l) => lines.push(`warn ${l}`),
        exit: (c) => {
          throw new Exit(c);
        },
      },
    };
  }

  test("logs variable names only and exits with code 1", () => {
    const { lines, deps } = capture();
    const badPort = "bad-port-value-zz";
    const badDirect = `mysql://app:${DIRECT_PASSWORD}@db.example.com/x`;
    let code: number | undefined;
    try {
      loadConfigOrExit({ NODE_ENV: "production", PORT: badPort, DIRECT_URL: badDirect }, { platform: "linux" }, deps);
    } catch (e) {
      if (!(e instanceof Exit)) throw e;
      code = e.code;
    }
    expect(code).toBe(1);
    const logged = lines.join("\n");
    expect(logged).toContain("PORT");
    expect(logged).toContain("DIRECT_URL");
    expect(logged).toContain("DATABASE_URL");
    expect(logged).not.toContain(badPort);
    expect(logged).not.toContain(badDirect);
    expect(logged).not.toContain(DIRECT_PASSWORD);
  });

  test("exitOnInvalidConfig exits with code 1", () => {
    const { deps } = capture();
    expect(() => exitOnInvalidConfig(fail({ PORT: "x" }), deps)).toThrow(new Exit(1));
  });

  test("valid config returns and logs the in-memory journal and session secret warnings", () => {
    const { lines, deps } = capture();
    const config = loadConfigOrExit({}, { platform: "linux" }, deps);
    expect(config.port).toBe(8080);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toStartWith("warn [config] DATABASE_URL");
    expect(lines[1]).toStartWith("warn [config] SESSION_SECRET");
  });
});

describe("REPLAY_SPEED (Task 4.6)", () => {
  test("accepts integers 1 to 50, default 1, and rejects everything else (Req 6.3, 6.4)", () => {
    for (const [value, speed] of [
      ["1", 1],
      ["7", 7],
      ["50", 50],
      ["", 1],
    ] as const) {
      expect(ok({ REPLAY_SPEED: value }).config.replaySpeed).toBe(speed);
    }
    for (const value of ["0", "51", "2.5", "-3", "100", " 5"]) {
      expect(fail({ REPLAY_SPEED: value }).issues.map((i) => i.variable)).toEqual(["REPLAY_SPEED"]);
    }
    expect(ok({ REPLAY_SPEED: "50" }).config.toJSON()).toMatchObject({ replaySpeed: 50 });
  });
});
