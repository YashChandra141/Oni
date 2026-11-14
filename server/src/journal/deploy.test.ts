// Migration deploy and the Start_Script flow (Task 11.5; Req 16.4, 20.15, 20.16, 20.17).
// `server/scripts/start.ts` runs at import time, so its sequence is reproduced here from the same
// parts: one `deployOnce` before the Server starts, the queue created with `migrated` set to its
// result, then `retryDeploy` with the queue as the gate.
import { describe, expect, test } from "bun:test";
import { Backoff } from "../engine/backoff.ts";
import { MemoryJournalStore } from "./memory.ts";
import { type DeployConfig, type DeployResult, type DeployRunner, deployOnce, migrateUrl, retryDeploy } from "./deploy.ts";
import { JournalQueue } from "./queue.ts";
import type { JournalRecord } from "./store.ts";
import { waitUntil } from "../gateway/testing.ts";

const DATABASE_URL = "postgresql://appuser:fakepw-db@db.example.neon.tech/appdb";
const DIRECT_URL = "postgresql://direct:fakepw-direct@db-direct.example.neon.tech/appdb";
const config: DeployConfig = {
  databaseUrl: DATABASE_URL,
  directUrl: DIRECT_URL,
  openaiApiKey: undefined,
  sessionSecret: "x".repeat(40),
};
const SECRETS = [DATABASE_URL, DIRECT_URL, "fakepw-db", "fakepw-direct"];

function recorder() {
  const lines: { level: string; line: string }[] = [];
  return {
    lines,
    info: (line: string) => void lines.push({ level: "info", line }),
    warn: (line: string) => void lines.push({ level: "warn", line }),
    error: (line: string) => void lines.push({ level: "error", line }),
  };
}

function expectClean(lines: readonly { line: string }[]): void {
  const text = lines.map((l) => l.line).join("\n");
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

/** A runner that returns the scripted results in order and records each environment. */
function scripted(results: readonly (DeployResult | Error)[]) {
  const envs: Record<string, string>[] = [];
  const run: DeployRunner = async (env) => {
    envs.push({ ...env });
    const next = results[Math.min(envs.length - 1, results.length - 1)];
    if (next === undefined) throw new Error("no scripted result");
    if (next instanceof Error) throw next;
    return next;
  };
  return { run, envs };
}

const OK: DeployResult = { exitCode: 0, output: `Datasource "db": PostgreSQL at ${DIRECT_URL}\n\nAll migrations have been successfully applied.` };
const FAIL: DeployResult = {
  exitCode: 1,
  output: `Error: P1001: Can't reach database server at ${DIRECT_URL}\nconnection string ${DATABASE_URL} password fakepw-db`,
};

describe("migrateUrl (Req 20.16)", () => {
  test("prefers DIRECT_URL, falls back to DATABASE_URL", () => {
    expect(migrateUrl({ databaseUrl: DATABASE_URL, directUrl: DIRECT_URL })).toBe(DIRECT_URL);
    expect(migrateUrl({ databaseUrl: DATABASE_URL, directUrl: undefined })).toBe(DATABASE_URL);
    expect(migrateUrl({ databaseUrl: undefined, directUrl: undefined })).toBeUndefined();
  });
});

describe("deployOnce", () => {
  test("success: supplies DIRECT_URL to the runner, opens the gate, and logs redacted output", async () => {
    const { run, envs } = scripted([OK]);
    const gate: boolean[] = [];
    const log = recorder();
    const ok = await deployOnce({ config, run, gate: { setMigrated: (v) => void gate.push(v) }, log });
    expect(ok).toBe(true);
    expect(envs).toEqual([{ DIRECT_URL }]);
    expect(gate).toEqual([true]);
    expect(log.lines.some((l) => l.line.includes("[redacted]"))).toBe(true);
    expectClean(log.lines);
  });

  test("falls back to DATABASE_URL as the connection string when DIRECT_URL is unset", async () => {
    const { run, envs } = scripted([OK]);
    await deployOnce({ config: { ...config, directUrl: undefined }, run, gate: { setMigrated: () => {} }, log: recorder() });
    expect(envs).toEqual([{ DIRECT_URL: DATABASE_URL }]);
  });

  test("failure: closes the gate, logs the exit code, and keeps every secret out of the log", async () => {
    const { run } = scripted([FAIL]);
    const gate: boolean[] = [];
    const log = recorder();
    const ok = await deployOnce({ config, run, gate: { setMigrated: (v) => void gate.push(v) }, log });
    expect(ok).toBe(false);
    expect(gate).toEqual([false]);
    expect(log.lines.some((l) => l.level === "error" && l.line.includes("exit code 1"))).toBe(true);
    expectClean(log.lines);
  });

  test("a runner that throws is a failure, and its message is redacted", async () => {
    const { run } = scripted([new Error(`spawn failed for ${DIRECT_URL} (password fakepw-direct)`)]);
    const gate: boolean[] = [];
    const log = recorder();
    expect(await deployOnce({ config, run, gate: { setMigrated: (v) => void gate.push(v) }, log })).toBe(false);
    expect(gate).toEqual([false]);
    expect(log.lines).not.toHaveLength(0);
    expectClean(log.lines);
  });

  test("no URL at all is a failure without running anything", async () => {
    const { run, envs } = scripted([OK]);
    const gate: boolean[] = [];
    const ok = await deployOnce({
      config: { ...config, databaseUrl: undefined, directUrl: undefined },
      run,
      gate: { setMigrated: (v) => void gate.push(v) },
      log: recorder(),
    });
    expect(ok).toBe(false);
    expect(envs).toEqual([]);
    expect(gate).toEqual([false]);
  });
});

describe("retryDeploy (Req 20.17)", () => {
  test("retries on 500 ms doubling delays until a deploy succeeds", async () => {
    const { run, envs } = scripted([FAIL, FAIL, OK]);
    const gate: boolean[] = [];
    const sleeps: number[] = [];
    const log = recorder();
    const ok = await retryDeploy({
      config,
      run,
      gate: { setMigrated: (v) => void gate.push(v) },
      log,
      sleep: async (ms) => void sleeps.push(ms),
      backoff: new Backoff(),
    });
    expect(ok).toBe(true);
    expect(sleeps).toEqual([500, 1_000, 2_000]);
    expect(envs).toHaveLength(3);
    expect(gate).toEqual([false, false, true]);
    expectClean(log.lines);
  });

  test("stops without deploying once shouldStop is true", async () => {
    const { run, envs } = scripted([OK]);
    let stop = false;
    const ok = await retryDeploy(
      { config, run, gate: { setMigrated: () => {} }, log: recorder(), sleep: async () => void (stop = true) },
      () => stop,
    );
    expect(ok).toBe(false);
    expect(envs).toEqual([]);
  });
});

let n = 0;
function order(): JournalRecord {
  n += 1;
  return {
    type: "order",
    record_id: `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`,
    session_id: "s1",
    account_id: "guest",
    ts: BigInt(n),
    order_id: `o${n}`,
    source: "web",
    symbol: "BTC-USD",
    side: "buy",
    kind: "market",
    qty: 1n,
    price: null,
  };
}

describe("Start_Script flow with a failing, then succeeding, deploy (Req 20.15, 20.17)", () => {
  test("status is down and records are held until the retry succeeds, then status is up and they are written", async () => {
    const { run } = scripted([FAIL, OK]);
    const log = recorder();

    // 1. The script's first attempt, before the Server starts: the gate callback is a no-op.
    const migrated = await deployOnce({ config, run, gate: { setMigrated: () => {} }, log });
    expect(migrated).toBe(false);

    // 2. startServer builds the queue with journalMigrated = false.
    const store = new MemoryJournalStore();
    const queue = new JournalQueue({
      store,
      classify: () => "unreachable",
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      sleep: () => Promise.resolve(),
      migrated,
    });
    expect(queue.status()).toBe("down");

    // Orders keep flowing while the Journal is down; their records are held.
    queue.enqueue(order());
    queue.enqueue(order());
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(store.calls.insertBatch).toBe(0);
    expect(store.rows).toHaveLength(0);
    expect(queue.stats().queued).toBe(2);
    expect(queue.status()).toBe("down");

    // 3. The background retry uses the queue as its gate.
    const ok = await retryDeploy({ config, run, gate: queue, log, sleep: () => Promise.resolve() });
    expect(ok).toBe(true);
    expect(await waitUntil(() => store.rows.length === 2)).toBe(true);
    expect(await waitUntil(() => queue.status() === "up")).toBe(true);
    expect(queue.stats().queued).toBe(0);
    expectClean(log.lines);
    await queue.flush(1_000);
  });
});
