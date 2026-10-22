// Remove only Hattera-owned software. A persistent marker prevents falling
// back to a bundled/system copy; account homes and workspace data stay intact.
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { rm } from "node:fs/promises";
import { DATA_DIR } from "./config.ts";
import { writeFileAtomic } from "./atomic.ts";
import { npmPackageOf } from "./engine-install.ts";
import { officialEngineFor } from "./official-engine-install.ts";
import type { EngineInstall } from "./contracts.ts";

export interface EngineRuntime {
  key: string;
  package?: string;
  vendor?: "cursor" | "hermes";
  managed?: true;
}

export function engineRuntime(driverKind: string, install: EngineInstall | undefined, cli: string | undefined): EngineRuntime | null {
  if (driverKind === "antigravityAgent") return { key: "antigravity", managed: true };
  if (!cli || !/^[a-z0-9][a-z0-9-]*$/i.test(cli)) return null;
  const pkg = npmPackageOf(install);
  if (pkg) return { key: cli, package: pkg };
  const official = install && officialEngineFor(driverKind);
  return official ? { key: cli, vendor: official.vendor } : null;
}

function marker(runtime: EngineRuntime, baseDir: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(runtime.key)) throw new Error("Invalid engine runtime.");
  return join(baseDir, "tools", "removed-engines", `${runtime.key}.json`);
}

export function engineRemoved(runtime: EngineRuntime, baseDir = DATA_DIR): boolean {
  return existsSync(marker(runtime, baseDir));
}

export function markEngineRemoved(runtime: EngineRuntime, baseDir = DATA_DIR): void {
  const path = marker(runtime, baseDir);
  assertOwnedParent(path, baseDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileAtomic(path, JSON.stringify({ removed: true }) + "\n", { mode: 0o600 });
}

export function restoreEngine(runtime: EngineRuntime, baseDir = DATA_DIR): void {
  const path = marker(runtime, baseDir);
  if (!present(path)) return;
  assertOwnedParent(path, baseDir);
  rmSync(path);
}

function runtimePaths(runtime: EngineRuntime, baseDir: string): string[] {
  marker(runtime, baseDir); // validate the fixed runtime key before computing deletion paths
  const tools = join(baseDir, "tools");
  if (runtime.managed) return [join(tools, "antigravity-acp", `${process.platform}-${process.arch}`)];
  if (runtime.vendor === "cursor") {
    const home = join(tools, "official", "cursor");
    return [join(home, ".local", "share", "cursor-agent"), join(home, ".local", "bin", "cursor-agent"), join(home, ".local", "bin", "agent"), join(home, "cursor-agent")];
  }
  if (runtime.vendor === "hermes") {
    const home = join(tools, "official", "hermes");
    // Hermes keeps config.yaml, .env, auth, profiles and sessions beside its
    // checkout. Never remove the whole HERMES_HOME.
    return ["bin", "hermes-agent", ".venv", "venv"].map(name => join(home, name));
  }
  if (!runtime.package || !/^(?:@[\w.-]+\/)?[\w.-]+$/.test(runtime.package)) throw new Error("Invalid engine package.");
  const prefix = join(tools, "npm");
  const modules = process.platform === "win32" ? join(prefix, "node_modules") : join(prefix, "lib", "node_modules");
  const bin = process.platform === "win32" ? prefix : join(prefix, "bin");
  return [join(tools, "engines", runtime.key), join(modules, ...runtime.package.split("/")),
    ...["", ".cmd", ".ps1", ".exe"].map(suffix => join(bin, runtime.key + suffix))];
}

function present(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** Check the real parent, so a symlink/junction in an ancestor cannot turn a
 * managed software removal into a recursive deletion outside the tools tree. */
function assertOwnedParent(path: string, baseDir: string): void {
  const canonicalBase = realpathSync(baseDir);
  const normalize = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  const root = normalize(join(canonicalBase, "tools"));
  let ancestor = dirname(resolve(path));
  while (!present(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
  const parent = normalize(realpathSync(ancestor));
  if (resolve(ancestor) === resolve(baseDir) && parent === normalize(canonicalBase)) return;
  if (parent !== root && !parent.startsWith(root + sep)) throw new Error("The engine installation points outside Hattera's tools folder. No external files were removed.");
}

export function hasOwnedEngineFiles(runtime: EngineRuntime, baseDir = DATA_DIR): boolean {
  // A permissions failure should keep the removal/retry action visible, not
  // take down the entire provider list. Removal itself still reports it.
  try { return runtimePaths(runtime, baseDir).some(present); }
  catch { return true; }
}

export async function removeEngineFiles(runtime: EngineRuntime, baseDir = DATA_DIR): Promise<void> {
  const paths = runtimePaths(runtime, baseDir).filter(present);
  // Validate every target before deleting anything. rm removes a target
  // symlink itself, and does not follow links inside a directory tree.
  for (const path of paths) assertOwnedParent(path, baseDir);
  for (const path of paths) await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
