// Locates the debug engine binary for the integration tests and decides whether they can run.
//
// `cargo test` does not rebuild `rust/target/debug/engine(.exe)`; only `cargo build` does. A
// binary left over from an older build can lack newer CLI flags (for example `--venue`), and the
// tests would then fail for a reason unrelated to the code under test. So the tests run only when
// the binary exists and is newer than every engine and protocol source file; otherwise they are
// skipped with a message that says how to build it.

import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPO_ROOT } from "../main.ts";

export const ENGINE_PATH = resolve(
  REPO_ROOT,
  "rust",
  "target",
  "debug",
  process.platform === "win32" ? "engine.exe" : "engine",
);

const BUILD_HINT = "build it with `cargo build --manifest-path rust/Cargo.toml -p engine`";

/** Newest modification time (ms) of `path` or, for a directory, of the files under it; 0 if absent. */
function newestMtime(path: string): number {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return 0;
  }
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = 0;
  for (const name of readdirSync(path)) {
    const mtime = newestMtime(join(path, name));
    if (mtime > newest) newest = mtime;
  }
  return newest;
}

/** `null` when the binary is usable, else the reason the integration tests are skipped. */
function skipReason(): string | null {
  let binaryMtime: number;
  try {
    binaryMtime = statSync(ENGINE_PATH).mtimeMs;
  } catch {
    return `${ENGINE_PATH} does not exist; ${BUILD_HINT}`;
  }
  const crates = resolve(REPO_ROOT, "rust", "crates");
  const sources = Math.max(
    newestMtime(join(crates, "engine", "src")),
    newestMtime(join(crates, "protocol", "src")),
    newestMtime(join(crates, "engine", "Cargo.toml")),
  );
  if (sources > binaryMtime) return `${ENGINE_PATH} is older than the engine sources; ${BUILD_HINT}`;
  return null;
}

const reason = skipReason();

/** True when the integration tests can run against a current engine binary. */
export const ENGINE_READY = reason === null;

/** Logs why the integration tests in `file` are skipped, once per file. */
export function warnIfSkipped(file: string): void {
  if (reason !== null) console.warn(`skipping ${file}: ${reason}`);
}
