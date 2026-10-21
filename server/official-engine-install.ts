// Official CLI installers that do not publish a supported npm package.
// Only these built-in drivers can select a script. The URL and arguments are
// fixed here, never supplied by the browser or an instance config.
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { DATA_DIR, stripWorkspaceCredentialEnv } from "./config.ts";
import { augmentedPath, findCliCandidates, registerPathDir, resetPathCache } from "./env-path.ts";
import { execCli, killCliTree, spawnCli } from "./procs.ts";

export type OfficialEngine = "cursor" | "hermes";
const MAX_SCRIPT_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT = 32 * 1024;
const INSTALL_TIMEOUT_MS = 30 * 60_000;
const running = new Map<string, Promise<void>>();

export function officialEngineFor(driverKind: string, platform: NodeJS.Platform = process.platform): { vendor: OfficialEngine } | null {
  if (process.env.OMB_TEST_SEALED_PATH === "1") return null;
  if (!["darwin", "linux", "win32"].includes(platform)) return null;
  if (driverKind === "cursorAgent") return { vendor: "cursor" };
  if (driverKind === "hermesAgent") return { vendor: "hermes" };
  return null;
}

export function officialEngineHome(vendor: OfficialEngine, baseDir = DATA_DIR): string {
  return join(baseDir, "tools", "official", vendor);
}

export function officialEngineBinDir(vendor: OfficialEngine, baseDir = DATA_DIR, platform: NodeJS.Platform = process.platform): string {
  const home = officialEngineHome(vendor, baseDir);
  if (vendor === "hermes") return join(home, "bin");
  return platform === "win32" ? join(home, "cursor-agent") : join(home, ".local", "bin");
}

export function registerOfficialEngineBins(baseDir = DATA_DIR): void {
  for (const vendor of ["cursor", "hermes"] as const) registerPathDir(officialEngineBinDir(vendor, baseDir));
}

/** A managed Hermes launch must use the same profile the installer created. */
export function managedHermesHome(baseDir = DATA_DIR): string | null {
  const bin = officialEngineBinDir("hermes", baseDir);
  const names = process.platform === "win32" ? ["hermes.exe", "hermes.cmd"] : ["hermes"];
  return names.some((name) => existsSync(join(bin, name))) ? officialEngineHome("hermes", baseDir) : null;
}

export function installOfficialEngine(vendor: OfficialEngine, baseDir = DATA_DIR): Promise<void> {
  const key = `${baseDir}:${vendor}`;
  const current = running.get(key);
  if (current) return current;
  const task = installOnce(vendor, baseDir).finally(() => running.delete(key));
  running.set(key, task);
  return task;
}

async function installOnce(vendor: OfficialEngine, baseDir: string): Promise<void> {
  const platform = process.platform;
  if (!["darwin", "linux", "win32"].includes(platform)) throw new Error(`${vendor} cannot be installed on this server's operating system.`);
  const home = officialEngineHome(vendor, baseDir);
  const binDir = officialEngineBinDir(vendor, baseDir);
  mkdirSync(home, { recursive: true });
  const url = vendor === "cursor"
    ? (platform === "win32" ? "https://cursor.com/install?win32=true" : "https://cursor.com/install")
    : (platform === "win32" ? "https://hermes-agent.nousresearch.com/install.ps1" : "https://hermes-agent.nousresearch.com/install.sh");
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new Error(`${vendor} could not reach its official installer. Check this server's network access and try again.`);
  }
  const expectedHost = vendor === "cursor" ? "cursor.com" : "hermes-agent.nousresearch.com";
  const finalUrl = new URL(response.url);
  if (!response.ok || !response.body || finalUrl.protocol !== "https:" || finalUrl.hostname !== expectedHost) {
    throw new Error(`${vendor}'s official installer could not be downloaded (${response.status}). Try again later.`);
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > MAX_SCRIPT_BYTES) throw new Error(`${vendor}'s installer exceeded the expected size.`);
    chunks.push(chunk);
  }
  if (bytes === 0) throw new Error(`${vendor}'s official installer was empty.`);
  const script = join(home, `install-${randomUUID()}${platform === "win32" ? ".ps1" : ".sh"}`);
  writeFileSync(script, Buffer.concat(chunks));
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: augmentedPath(), NO_COLOR: "1", CI: "1" };
  stripWorkspaceCredentialEnv(env as Record<string, string | undefined>);
  let command: string;
  let args: string[];
  if (vendor === "cursor") {
    // Cursor's official script writes under HOME / LOCALAPPDATA. Keep its
    // version tree and launchers inside the app's data directory.
    if (platform === "win32") env.LOCALAPPDATA = home;
    else env.HOME = home;
    command = platform === "win32" ? "powershell.exe" : "bash";
    args = platform === "win32" ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script] : [script];
  } else {
    env.HERMES_HOME = home;
    command = platform === "win32" ? "powershell.exe" : "bash";
    args = platform === "win32"
      ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-NonInteractive", "-HermesHome", home]
      : [script, "--non-interactive", "--hermes-home", home];
  }
  try {
    await runScript(command, args, env, home, vendor);
  } finally {
    unlinkSync(script);
  }
  registerPathDir(binDir);
  resetPathCache();
  const cli = vendor === "cursor" ? "cursor-agent" : "hermes";
  const installed = findCliCandidates(cli).find((path) => path.startsWith(binDir));
  if (!installed) throw new Error(`${vendor}'s installer finished but did not provide a ${cli} command in Hattera's tools folder.`);
  await new Promise<void>((resolve, reject) => {
    execCli(installed, ["--version"], { env: { ...env, PATH: augmentedPath() }, timeout: 30_000, maxBuffer: MAX_OUTPUT }, (error) => {
      if (error) reject(new Error(`${vendor} installed, but its command could not start. Check the server's installation log and try again.`));
      else resolve();
    });
  });
}

function runScript(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, vendor: OfficialEngine): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawnCli>;
    try { child = spawnCli(command, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] }); }
    catch { reject(new Error(`${vendor}'s installer could not start on this server.`)); return; }
    child.stdin.end();
    let output = "";
    const collect = (chunk: Buffer) => { if (output.length < MAX_OUTPUT) output += chunk.toString("utf8").slice(0, MAX_OUTPUT - output.length); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void killCliTree(child).then((stopped) => reject(new Error(stopped
        ? `${vendor}'s installer timed out. Check the server's network access and try again.`
        : `${vendor}'s installer timed out and could not be stopped. Stop it on the server before retrying.`)));
    }, INSTALL_TIMEOUT_MS);
    timer.unref();
    child.once("error", () => { clearTimeout(timer); reject(new Error(`${vendor}'s installer could not start on this server.`)); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return;
      if (code === 0) resolve();
      else reject(new Error(officialInstallFailure(vendor, output)));
    });
  });
}

function officialInstallFailure(vendor: OfficialEngine, output: string): string {
  const lower = stripVTControlCharacters(output).toLowerCase();
  const start = `Hattera could not install ${vendor} on this server.`;
  if (/could not resolve|name resolution|timed out|connection refused|tls|certificate|download failed|failed to fetch/.test(lower)) {
    return `${start} The server could not reach the provider's download service. Check its network access and retry.`;
  }
  if (/git (is required|not found)|git: command not found|git was not found/.test(lower)) {
    return `${start} This server image is missing Git, which the provider's installer requires.`;
  }
  if (/xz(-utils)?: (command not found|not found)|xz-utils is required/.test(lower)) {
    return `${start} This server image is missing xz-utils, which the provider's installer requires.`;
  }
  if (/permission denied|access is denied|eacces|eperm/.test(lower)) {
    return `${start} The app user cannot write to Hattera's tools folder.`;
  }
  return `${start} The provider's installer exited with an error. Retry from Settings.`;
}
