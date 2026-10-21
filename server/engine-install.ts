// Install an engine's command-line app from Settings, on the machine that
// runs this server, as this process's own user, into a directory the app
// owns. No sudo, no shell, no terminal: the package name comes from the
// driver's own install descriptor and never from a request, npm runs with
// a fixed argument list, and the binary is found on the engines' PATH
// afterwards because that directory is registered ahead of everything else.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { delimiter, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { EngineInstall } from "./contracts.ts";
import { DATA_DIR, stripWorkspaceCredentialEnv } from "./config.ts";
import { augmentedPath, findCliCandidates, registerPathDir } from "./env-path.ts";
import { execCli, killCliTree, spawnCli } from "./procs.ts";
import { registerOfficialEngineBins } from "./official-engine-install.ts";

const MAX_OUTPUT = 64 * 1024;
// Native CLI packages can exceed 100 MB. Docker egress slower than 100 KB/s
// still needs enough time to finish a valid download.
const DEFAULT_TIMEOUT_MS = 60 * 60_000;
const PROBE_TIMEOUT_MS = 30_000;

/** Legacy shared npm prefix, kept on PATH for existing installations. */
export function enginesPrefix(baseDir = DATA_DIR): string {
  return join(baseDir, "tools", "npm");
}

/** Where that prefix puts executables: `bin/` on POSIX, the prefix itself on Windows. */
export function enginesBinDir(baseDir = DATA_DIR, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? enginesPrefix(baseDir) : join(enginesPrefix(baseDir), "bin");
}

const managedDir = (baseDir: string) => join(baseDir, "tools", "engines");
const slotName = (name: string) => name.replace(/[^a-z0-9._-]/gi, "_");
const activeFile = (baseDir: string, slot: string) => join(managedDir(baseDir), slot, "active.json");
const stagedBinDir = (prefix: string) => process.platform === "win32" ? prefix : join(prefix, "bin");

/** Only a version that passed the CLI probe is registered on PATH. */
export function activeEngineBinDir(baseDir: string, slot: string): string | null {
  try {
    const { version } = JSON.parse(readFileSync(activeFile(baseDir, slot), "utf8")) as { version?: unknown };
    if (typeof version !== "string" || !/^[0-9a-f-]{36}$/i.test(version)) return null;
    const bin = stagedBinDir(join(managedDir(baseDir), slot, version));
    return existsSync(bin) ? bin : null;
  } catch { return null; }
}

/** Called once at boot: engines installed here win over any other copy on PATH. */
export function registerEnginesBinDir(baseDir = DATA_DIR): void {
  // Existing managed installs keep working; fresh installs use verified,
  // versioned prefixes so a failed update cannot replace a working CLI.
  registerPathDir(enginesBinDir(baseDir));
  registerOfficialEngineBins(baseDir);
  try {
    for (const entry of readdirSync(managedDir(baseDir), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const bin = activeEngineBinDir(baseDir, entry.name);
      if (bin) registerPathDir(bin);
    }
  } catch { /* no managed engines yet */ }
}

/** The npm package a driver's own install one-liner names, when it is one. */
export function npmPackageOf(install: EngineInstall | undefined, platform: NodeJS.Platform = process.platform): string | null {
  const line = platform === "linux" || platform === "darwin" || platform === "win32"
    ? install?.command?.[platform] : undefined;
  const match = line ? /^npm install -g ((?:@[\w.-]+\/)?[\w.-]+)$/.exec(line.trim()) : null;
  return match ? match[1]! : null;
}

export function npmAvailable(): boolean {
  return findCliCandidates("npm").length > 0;
}

/** What Settings may install for this engine on this machine, or null. A
 * managed engine keeps its own verified download; npm engines need a command
 * for this OS, npm on PATH, and a CLI whose version we can check afterwards. */
export function serverInstallFor(install: EngineInstall | undefined, cli: string | undefined, npmPresent: boolean = npmAvailable()): { package: string } | null {
  if (!install || install.managed || !cli) return null;
  const pkg = npmPackageOf(install);
  return pkg && npmPresent ? { package: pkg } : null;
}

interface InstallOptions {
  baseDir?: string;
  /** The executable the package must provide; checked after installing. */
  cli?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** PATH for finding npm; the engines' augmented PATH by default. */
  path?: string;
}

const running = new Map<string, Promise<void>>();

/** Install or update one npm engine. Concurrent clicks share one npm run. */
export function installNpmEngine(pkg: string, options: InstallOptions = {}): Promise<void> {
  const key = `${options.baseDir ?? DATA_DIR} ${slotName(options.cli ?? pkg)}`;
  const existing = running.get(key);
  if (existing) return existing;
  const run = installOnce(pkg, options).finally(() => running.delete(key));
  running.set(key, run);
  return run;
}

async function installOnce(pkg: string, options: InstallOptions): Promise<void> {
  const baseDir = options.baseDir ?? DATA_DIR;
  const slot = slotName(options.cli ?? pkg);
  const slotDir = join(managedDir(baseDir), slot);
  const version = randomUUID();
  const prefix = join(slotDir, version);
  mkdirSync(prefix, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...(options.env ?? process.env),
    PATH: options.path ?? augmentedPath(),
    NO_COLOR: "1",
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
    // Keep npm's cache and logs alongside the app-owned install. A server
    // account may not be allowed to write to its inherited user npm cache.
    npm_config_cache: join(baseDir, "tools", "npm-cache"),
  };
  // Workspace credentials (xai/box/voice keys) are not npm's to see.
  stripWorkspaceCredentialEnv(env as Record<string, string | undefined>);
  // npm 11 skips a dependency's install script unless the package is named
  // here; the engines that need one (Claude Code) are exactly these.
  // Engines like Codex ship their native binary as a platform optional
  // dependency, so a user-level `omit=optional` must not leave it out.
  const args = ["install", "-g", "--prefix", prefix, "--loglevel=error", "--include=optional", `--allow-scripts=${pkg}`, `${pkg}@latest`];
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    await runInstall(pkg, args, env, prefix, timeoutMs);
    const binDir = stagedBinDir(prefix);
    if (options.cli) {
      const installed = installedCli(binDir, options.cli);
      if (!installed) throw new Error(`${pkg} installed, but it did not provide a \`${options.cli}\` command. Check the package name in this engine's install descriptor.`);
      // npm can exit 0 after dropping a platform dependency. Retry once,
      // then keep the previous active version if this copy still cannot run.
      const probeEnv = { ...env, PATH: `${binDir}${delimiter}${augmentedPath()}` };
      let failure = await probeCli(installed, probeEnv);
      if (failure !== null) {
        await runInstall(pkg, args, env, prefix, timeoutMs);
        failure = await probeCli(installed, probeEnv);
        if (failure !== null) throw new Error(`npm installed ${pkg}, but \`${options.cli}\` does not start: ${failure}\nnpm can leave out a platform package when its download fails, even after a retry. Check this server's network connection, then install again from Settings.`);
      }
    }
    const temporary = join(slotDir, `active-${randomUUID()}.json`);
    writeFileSync(temporary, JSON.stringify({ version }));
    renameSync(temporary, activeFile(baseDir, slot));
    registerPathDir(binDir);
    // ponytail: old verified versions remain so running CLI processes and
    // rollback are safe; prune on a future storage-management pass.
  } catch (error) {
    try { rmSync(prefix, { recursive: true, force: true }); } catch { /* do not mask the install error */ }
    throw error;
  }
}

function installedCli(binDir: string, cli: string): string | null {
  const names = process.platform === "win32" ? [`${cli}.exe`, `${cli}.cmd`] : [cli];
  return names.map((name) => join(binDir, name)).find(existsSync) ?? null;
}

async function runInstall(pkg: string, args: string[], env: NodeJS.ProcessEnv, prefix: string, timeoutMs: number): Promise<void> {
  const result = await runNpm(args, env, prefix, timeoutMs);
  if (result.code !== 0) {
    throw new Error(installFailure(pkg, result.output));
  }
}

/** Keep npm's machine-specific paths and log locations out of the UI. */
function installFailure(pkg: string, output: string): string {
  const lower = stripVTControlCharacters(output).toLowerCase();
  const start = `npm could not install ${pkg} on this server.`;
  if (/request to https?:\/\/|registry\.npmjs\.org|fetch failed/.test(lower)) {
    return `${start} This server could not reach the npm registry. The hosting operator must allow registry downloads; then retry here.`;
  }
  if (/\beperm\b|\beacces\b|operation was rejected by your operating system/.test(lower)) {
    return `${start} The server blocked access to Hattera's tools folder. Give the app user write access there, then retry from Settings.`;
  }
  if (/\be404\b|404 not found/.test(lower)) return `${start} npm could not find the package in its configured registry.`;
  if (/\benotfound\b|\beconn|\betimedout\b|network/.test(lower)) return `${start} npm could not reach its registry. The hosting operator must fix this server's network access; then retry here.`;
  return `${start} Check the server's npm log for the cause, then retry from Settings.`;
}

/** Null when `<cli> --version` succeeds, else why it did not. A Node
 * launcher that throws prints its source line first, so its `Error:` line
 * is the one worth showing. */
function probeCli(cli: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolveProbe) => {
    execCli(cli, ["--version"], { env, timeout: PROBE_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: MAX_OUTPUT }, (error, stdout, stderr) => {
      if (!error) return resolveProbe(null);
      const lines = stripVTControlCharacters(`${stderr ?? ""}\n${stdout}`).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const said = lines.find((line) => /^\w*Error: /.test(line)) ?? lines[0] ?? error.message;
      resolveProbe(said.slice(0, 400));
    });
  });
}

function runNpm(args: string[], env: NodeJS.ProcessEnv, cwd: string, timeoutMs: number): Promise<{ code: number | null; output: string }> {
  return new Promise((resolveRun, rejectRun) => {
    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli("npm", args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      rejectRun(new Error("npm was found but its launcher could not start on this server. The hosting operator needs to repair this deployment's Node.js/npm installation."));
      return;
    }
    child.stdin.end();
    let output = "";
    const receive = (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT) output += chunk.toString("utf8").slice(0, MAX_OUTPUT - output.length);
    };
    child.stdout.on("data", receive);
    child.stderr.on("data", receive);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void killCliTree(child).then((stopped) => {
        rejectRun(new Error(stopped
          ? "The install took too long and was stopped. Check the server's network connection and try again."
          : "The install took too long, but npm could not be confirmed stopped. Ask the server administrator to stop the install process before trying again."));
      });
    }, timeoutMs);
    timer.unref();
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (timedOut) return; // A failed kill is not a failed npm launch.
      clearTimeout(timer);
      rejectRun(new Error(error.code === "ENOENT"
        ? "npm is not installed on this server. Install Node.js with npm for the user running Hattera, then try again."
        : "npm was found but its launcher could not start on this server. The hosting operator needs to repair this deployment's Node.js/npm installation."));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return; // The whole group must stop, not just npm's root.
      resolveRun({ code, output });
    });
  });
}
