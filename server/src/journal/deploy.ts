// Migration deploy for the Start_Script (design Decision J5, Req 20.15-20.17).
//
// `prisma migrate deploy` runs as a child process with DIRECT_URL in its environment (Req 20.16).
// Every output line goes through `redactSecrets` before it is logged. The spawn and the timers
// are injected, so tests run it without Bun.spawn or real delays.

import { resolve } from "node:path";
import { Backoff } from "../engine/backoff.ts";
import { type SecretSource, redactSecrets } from "../config.ts";

export interface DeployResult {
  readonly exitCode: number;
  /** Combined stdout and stderr, unredacted. Callers must redact before logging. */
  readonly output: string;
}

/** Runs `prisma migrate deploy` with the given extra environment. */
export type DeployRunner = (env: Readonly<Record<string, string>>) => Promise<DeployResult>;

export interface DeployLogger {
  info(line: string): void;
  warn(line: string): void;
  error(line: string): void;
}

export interface DeployConfig extends SecretSource {
  readonly databaseUrl: string | undefined;
  readonly directUrl: string | undefined;
}

export interface MigrationGate {
  setMigrated(ok: boolean): void;
}

export interface DeployDeps {
  readonly config: DeployConfig;
  readonly run: DeployRunner;
  readonly gate: MigrationGate;
  readonly log: DeployLogger;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly backoff?: Backoff;
}

/** Directory that holds prisma.config.ts and prisma/ (the `server/` directory). */
export const SERVER_DIR = resolve(import.meta.dir, "..", "..");

export const DEPLOY_TIMEOUT_MS = 120_000;

/** The connection string for Prisma Migrate: DIRECT_URL, or DATABASE_URL when only that is set. */
export function migrateUrl(config: Pick<DeployConfig, "databaseUrl" | "directUrl">): string | undefined {
  return config.directUrl ?? config.databaseUrl;
}

/** Real runner: `bun x prisma migrate deploy` in the server directory, with a hard timeout. */
export function bunDeployRunner(cwd: string = SERVER_DIR): DeployRunner {
  return async (env) => {
    const proc = Bun.spawn([process.execPath, "x", "prisma", "migrate", "deploy"], {
      cwd,
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
      timeout: DEPLOY_TIMEOUT_MS,
    });
    const [out, err, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, output: `${out}\n${err}` };
  };
}

function logLines(text: string, deps: DeployDeps, level: "info" | "error"): void {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    deps.log[level](`[migrate] ${redactSecrets(line, deps.config)}`);
  }
}

/**
 * One `prisma migrate deploy` attempt. Calls `gate.setMigrated(true)` on success and
 * `setMigrated(false)` on failure. Never throws and never logs an unredacted line.
 */
export async function deployOnce(deps: DeployDeps): Promise<boolean> {
  const url = migrateUrl(deps.config);
  if (url === undefined) {
    deps.log.error("[migrate] no DIRECT_URL or DATABASE_URL: cannot apply Migrations");
    deps.gate.setMigrated(false);
    return false;
  }
  try {
    const result = await deps.run({ DIRECT_URL: url });
    if (result.exitCode === 0) {
      logLines(result.output, deps, "info");
      deps.gate.setMigrated(true);
      return true;
    }
    logLines(result.output, deps, "error");
    deps.log.error(`[migrate] prisma migrate deploy failed with exit code ${result.exitCode}`);
  } catch (err) {
    deps.log.error(
      `[migrate] prisma migrate deploy could not run: ${redactSecrets(err instanceof Error ? err.message : "unknown error", deps.config)}`,
    );
  }
  deps.gate.setMigrated(false);
  return false;
}

/**
 * Retries `deployOnce` on `backoff.ts` delays (500 ms doubling to 30 s) until one succeeds or
 * `shouldStop()` is true. Resolves with whether a deploy succeeded.
 */
export async function retryDeploy(deps: DeployDeps, shouldStop: () => boolean = () => false): Promise<boolean> {
  const backoff = deps.backoff ?? new Backoff();
  const sleep =
    deps.sleep ??
    ((ms: number) =>
      new Promise<void>((done) => {
        const handle = setTimeout(done, ms);
        (handle as { unref?: () => void }).unref?.();
      }));
  while (!shouldStop()) {
    await sleep(backoff.next());
    if (shouldStop()) break;
    if (await deployOnce(deps)) return true;
  }
  return false;
}
