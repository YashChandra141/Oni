// Start_Script (design Decision J5, Req 20.15-20.17): the Server_Image command.
//
// 1. Validate the configuration (exits non-zero on a bad variable, Req 16.2).
// 2. With DATABASE_URL set, apply pending Migrations with `prisma migrate deploy`.
// 3. Start the Server in this process. When the deploy failed the Journal_Status is `down`, the
//    Journal_Queue holds records, and the deploy is retried in the background.
// Without DATABASE_URL (not production) the Server uses the in-memory Journal.

import { loadConfigOrExit, redactSecrets } from "../src/config.ts";
import { bunDeployRunner, deployOnce, retryDeploy } from "../src/journal/deploy.ts";
import { startServer } from "../src/main.ts";

const config = loadConfigOrExit();
const log = { info: console.log, warn: console.warn, error: console.error };

// The deploy runs before the Server listens, so a healthy database is migrated before any write.
// Its result is passed to `startServer` as `journalMigrated`, which sets the queue's gate.
let migrated = config.databaseUrl === undefined;
if (config.databaseUrl !== undefined) {
  migrated = await deployOnce({ config, run: bunDeployRunner(), gate: { setMigrated: () => {} }, log });
}

const running = startServer({ config, journalMigrated: migrated });
const mode = config.dataMode === "replay" ? `replay mode, ${config.replayFixture} at ${config.replaySpeed}x` : "live mode";
console.log(`[server] listening on port ${running.port} (${mode}); journal ${running.journal.status()}`);

let stopped = false;
if (!migrated && config.databaseUrl !== undefined) {
  console.warn("[server] Migrations failed: Journal_Status is down; retrying in the background");
  void retryDeploy(
    { config, run: bunDeployRunner(), gate: running.journal, log },
    () => stopped,
  ).then((ok) => {
    if (ok) console.log("[server] Migrations applied: Journal_Status up");
  });
}

let shuttingDown = false;
const shutdown = (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  stopped = true;
  console.log(`[server] ${signal} received, shutting down`);
  // `stop()` flushes the Journal_Queue with a 5 s deadline.
  running.stop().then(
    () => process.exit(0),
    (err: unknown) => {
      console.error(
        `[server] shutdown failed: ${redactSecrets(err instanceof Error ? err.name : "unknown error", config)}`,
      );
      process.exit(1);
    },
  );
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
