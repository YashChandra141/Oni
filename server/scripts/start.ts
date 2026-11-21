// Start_Script: the Server_Image command (oni-terminal-v2 Req 1.1, 1.2).
//
// 1. Validate the configuration (exits non-zero on a bad variable, Req 16.2).
// 2. Start the Server in this process. There is no database and nothing to migrate: the
//    Activity_Log lives in memory for the current engine run.

import { loadConfigOrExit, redactSecrets } from "../src/config.ts";
import { startServer } from "../src/main.ts";

const config = loadConfigOrExit();

const running = startServer({ config });
const mode = config.dataMode === "replay" ? `replay mode, ${config.replayFixture} at ${config.replaySpeed}x` : "live mode";
console.log(`[server] listening on port ${running.port} (${mode})`);

let shuttingDown = false;
const shutdown = (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received, shutting down`);
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
