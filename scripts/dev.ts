// Local dev launcher (no Docker, no Render). Starts the server, waits for /health, then the web dev server.
// Usage: bun scripts/dev.ts [--server-only]
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const serverOnly = process.argv.includes("--server-only");
const isWin = process.platform === "win32";

const enginePath =
  process.env.ENGINE_PATH ?? join(root, "rust", "target", "release", isWin ? "engine.exe" : "engine");
if (!existsSync(enginePath)) {
  console.error(`Engine binary not found at ${enginePath}`);
  console.error("Build it first:\n  cargo build --release --manifest-path rust/Cargo.toml -p engine -p tui");
  process.exit(1);
}

const envFile = join(root, "server", ".env");
const serverArgs = ["bun"];
if (existsSync(envFile)) serverArgs.push("--env-file", envFile);
serverArgs.push(join(root, "server", "src", "main.ts"));

const port = process.env.PORT ?? "8080";
const children: Array<ReturnType<typeof Bun.spawn>> = [];

function stopAll(code: number): never {
  for (const c of children) {
    try {
      c.kill();
    } catch {
      // already exited
    }
  }
  process.exit(code);
}
process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));

// cwd = repo root so the engine finds fixtures/ the same way it does in production.
const server = Bun.spawn(serverArgs, {
  cwd: root,
  env: { ...process.env, ENGINE_PATH: enginePath },
  stdio: ["inherit", "inherit", "inherit"],
});
children.push(server);
void server.exited.then((code) => {
  console.error(`[dev] server exited with code ${code}`);
  stopAll(code || 1);
});

async function healthy(): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/health`);
    return res.status === 200;
  } catch {
    return false;
  }
}

const deadline = Date.now() + 30_000;
let ok = false;
while (Date.now() < deadline) {
  if (await healthy()) {
    ok = true;
    break;
  }
  await Bun.sleep(300);
}
if (!ok) {
  console.error(`[dev] server did not become healthy on port ${port} within 30 s`);
  stopAll(1);
}

if (!serverOnly) {
  const web = Bun.spawn(["bun", "run", "--cwd", "web", "dev"], {
    cwd: root,
    env: { ...process.env, CI: "1", NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["inherit", "inherit", "inherit"],
  });
  children.push(web);
  void web.exited.then((code) => {
    console.error(`[dev] web exited with code ${code}`);
    stopAll(code || 1);
  });
}

console.log("\nOni is running locally:");
if (!serverOnly) console.log("  Web:    http://localhost:3000");
console.log(`  WS:     ws://localhost:${port}/ws`);
console.log(`  Health: http://localhost:${port}/health`);
console.log("  TUI:    bun run dev:tui   (in a second terminal)");
console.log("Press Ctrl+C to stop.\n");

await new Promise(() => {});
