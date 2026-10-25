import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { findLocalRuntime, localRuntimeMatches, type LocalRuntime } from "./local-runtime.ts";

/** Persistent launches use the same serve supervisor, runtime and data lease as
 * foreground/desktop launches. Cwd is never a workspace identity or config path. */
export async function launchLocalWeb(options: {
  dataDir: string; port: number; entry: string; environment?: NodeJS.ProcessEnv;
}): Promise<{ runtime: LocalRuntime; reused: boolean; logPath?: string }> {
  const dataDir = resolve(options.dataDir);
  const running = await findLocalRuntime(dataDir);
  if (running) return { runtime: running, reused: true };
  // An older runtime may not publish discovery; never start a second writer.
  if (await localRuntimeMatches(dataDir, options.port)) throw new Error(`Hattera is already running at http://127.0.0.1:${options.port}. Open that address; restart it after updating to enable launcher discovery.`);
  // Avoid creating DATA_DIR before the runtime's existing legacy migration.
  const logPath = join(mkdtempSync(join(tmpdir(), "hattera-web-")), "server.log");
  const fd = openSync(logPath, "wx", 0o600);
  let child;
  try {
    child = spawn(process.execPath, [...(options.entry.endsWith(".ts") ? ["--experimental-strip-types"] : []), options.entry,
      "serve", "--data-dir", dataDir, "--port", String(options.port), "--no-pair", "--no-open"], {
      cwd: dirname(options.entry), env: { ...(options.environment ?? process.env), OMB_DATA_DIR: dataDir, OMB_PERSISTENT_WEB: "1", OMB_LOCAL_CLI: "1" },
      detached: true, windowsHide: true, stdio: ["ignore", fd, fd],
    });
  } finally { closeSync(fd); }
  let failure: string | undefined;
  let endedAt: number | undefined;
  child.once("error", error => { failure = error.message; endedAt = Date.now(); });
  child.once("exit", () => { endedAt = Date.now(); });
  child.unref();
  const deadline = Date.now() + 65_000;
  while (Date.now() < deadline) {
    const runtime = await findLocalRuntime(dataDir);
    if (runtime) return { runtime, reused: false, logPath };
    // A concurrent launcher can win the same existing lease. Let it finish
    // starting before reporting our losing supervisor's exit as a failure.
    if (endedAt !== undefined && Date.now() - endedAt > 10_000) break;
    await delay(250);
  }
  throw new Error(`${failure ?? "Hattera did not become ready"}. Check ${logPath}. The existing data-directory lease prevents a second writer; saved state was not replaced.`);
}
