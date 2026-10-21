import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activeEngineBinDir, enginesBinDir, enginesPrefix, installNpmEngine, npmPackageOf, registerEnginesBinDir, serverInstallFor } from "./engine-install.ts";
import { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";
import { augmentedPath, findCliCandidates, resetPathCacheForTests } from "./env-path.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import * as procs from "./procs.ts";
import { officialEngineFor } from "./official-engine-install.ts";

// A stand-in npm: records its arguments, honours --prefix, and behaves per
// FAKE_NPM_MODE. Nothing reaches a registry or the network.
// CommonJS on purpose: an extensionless shebang script parses as CJS, which
// skips the ESM-detection reparse and lets the stubborn-mode trap below arm
// itself before anything slower (requires, log writes) can delay boot.
const FAKE_NPM = `#!/usr/bin/env node
if (process.env.FAKE_NPM_MODE === 'stubborn') process.on('SIGTERM', () => {});
const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
const mode = process.env.FAKE_NPM_MODE || 'ok';
appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify({ args, cwd: process.cwd(), secret: process.env.XAI_API_KEY ?? null }) + '\\n');
if (mode === 'fail') { console.error('npm ERR! code E404\\nnpm ERR! 404 Not Found - registry-token-fixture'); process.exit(1); }
if (mode === 'permission') { console.error('npm ERR! code EPERM\\nnpm ERR! Operation was rejected by your operating system.\\nnpm ERR! C:\\private\\npm-cache\\secret.log'); process.exit(1); }
if (mode === 'registry-blocked') { console.error('npm error request to https://registry.npmjs.org/opencode-ai failed, reason: EACCES'); process.exit(1); }
if (mode === 'hang' || mode === 'stubborn') { setInterval(() => {}, 1000); }
else {
  const prefix = args[args.indexOf('--prefix') + 1];
  // Like npm in #2064: exit 0 having dropped the platform package, so the
  // launcher is there but cannot start. 'broken-once' does it on run one only.
  const runs = readFileSync(process.env.FAKE_NPM_LOG, 'utf8').trim().split('\\n').length;
  const broken = mode === 'broken' || (mode === 'broken-once' && runs === 1);
  if (mode !== 'no-bin' && process.platform === 'win32') {
    writeFileSync(join(prefix, 'fakebin.js'), broken ? "throw new Error('Missing optional dependency fake-engine-platform.');\\n" : "console.log('fixture');\\n");
    writeFileSync(join(prefix, 'fakebin.cmd'), '@echo off\\r\\nnode "%~dp0\\\\fakebin.js" %*\\r\\n');
  } else if (mode !== 'no-bin') {
    mkdirSync(join(prefix, 'bin'), { recursive: true });
    writeFileSync(join(prefix, 'bin', 'fakebin'), broken
      ? '#!/bin/sh\\necho "fakebin.js:1" >&2\\necho "Error: Missing optional dependency fake-engine-platform." >&2\\nexit 1\\n'
      : '#!/bin/sh\\necho fixture\\n', { mode: 0o755 });
  }
  if (mode === 'slow') setTimeout(() => process.exit(0), 300); else process.exit(0);
}
`;

/** Put the stand-in npm in `dir`: a shebang script, or on Windows the
 * `.cmd` shim npm itself would write, which spawnCli resolves to Node. */
function writeFakeNpm(dir: string): void {
  if (process.platform === "win32") {
    writeFileSync(join(dir, "npm.js"), FAKE_NPM);
    writeFileSync(join(dir, "npm.cmd"), '@echo off\r\nnode "%~dp0\\npm.js" %*\r\n');
    return;
  }
  writeFileSync(join(dir, "npm"), FAKE_NPM, { mode: 0o755 });
  chmodSync(join(dir, "npm"), 0o755);
}

/** A scratch data dir and a PATH holding only the stand-in npm. */
function useFakeNpm() {
  const ctx = { scratch: "", binDir: "", base: "" };
  let originalPath: string | undefined;
  beforeEach(() => {
    ctx.scratch = mkdtempSync(join(tmpdir(), "omb-engine-install-"));
    ctx.binDir = join(ctx.scratch, "fake-path");
    ctx.base = join(ctx.scratch, "data");
    mkdirSync(ctx.binDir);
    writeFakeNpm(ctx.binDir);
    originalPath = process.env.PATH;
    process.env.PATH = ctx.binDir;
    process.env.FAKE_NPM_LOG = join(ctx.scratch, "calls.jsonl");
    delete process.env.FAKE_NPM_MODE;
    resetPathCacheForTests();
  });
  afterEach(async () => {
    process.env.PATH = originalPath;
    delete process.env.FAKE_NPM_LOG;
    delete process.env.FAKE_NPM_MODE;
    resetPathCacheForTests();
    await removeTempDir(ctx.scratch);
  });
  const calls = () => readFileSync(join(ctx.scratch, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { args: string[]; cwd: string; secret: string | null });
  return { ctx, calls };
}

describe("npm package detection", () => {
  it("reads only a plain npm one-liner", () => {
    expect(npmPackageOf({ command: { linux: "npm install -g @anthropic-ai/claude-code" } }, "linux")).toBe("@anthropic-ai/claude-code");
    expect(npmPackageOf({ command: { darwin: "npm install -g mmx-cli" } }, "darwin")).toBe("mmx-cli");
    expect(npmPackageOf({ command: { linux: "curl -fsSL https://x.ai/cli/install.sh | bash" } }, "linux")).toBeNull();
    expect(npmPackageOf({ command: { linux: "npm install -g codex; rm -rf /" } }, "linux")).toBeNull();
    expect(npmPackageOf({ command: { linux: "npm install -g ../evil" } }, "linux")).toBeNull();
    expect(npmPackageOf(undefined)).toBeNull();
  });

  it("offers a server install only with a command for this platform and a CLI to verify", () => {
    const install = { command: { linux: "npm install -g fake-engine" } };
    expect(npmPackageOf(install, "win32")).toBeNull();
    expect(serverInstallFor(install, "fakebin", true)).toEqual(process.platform === "linux" ? { package: "fake-engine" } : null);
    expect(serverInstallFor(install, undefined, true)).toBeNull();
  });

  it("accounts for every built-in provider offered a server npm install", () => {
    const offered = BUILT_IN_DRIVERS.flatMap((driver) => {
      const raw = (driver.defaultConfig() as { cli?: unknown }).cli;
      const cli = typeof raw === "string" ? raw : undefined;
      const install = serverInstallFor(driver.install, cli, true);
      return install ? [{ driver: driver.driverKind, package: install.package, cli }] : [];
    }).sort((a, b) => a.driver.localeCompare(b.driver));
    expect(offered).toEqual([
      { driver: "claudeAgent", package: "@anthropic-ai/claude-code", cli: "claude" },
      { driver: "clineAgent", package: "cline", cli: "cline" },
      { driver: "codex", package: "@openai/codex", cli: "codex" },
      { driver: "droidAgent", package: "droid", cli: "droid" },
      { driver: "geminiAgent", package: "@google/gemini-cli", cli: "gemini" },
      { driver: "grokAgent", package: "@xai-official/grok", cli: "grok" },
      { driver: "kimiAgent", package: "@moonshot-ai/kimi-code", cli: "kimi" },
      { driver: "opencodeGo", package: "opencode-ai", cli: "opencode" },
      { driver: "piAgent", package: "@earendil-works/pi-coding-agent", cli: "pi" },
      { driver: "qwenAgent", package: "@qwen-code/qwen-code", cli: "qwen" },
    ]);
  });

  it("has a server installer for every built-in CLI provider", () => {
    const missing = BUILT_IN_DRIVERS.filter((driver) => {
      const cli = (driver.defaultConfig() as { cli?: unknown }).cli;
      if (typeof cli !== "string" || !cli) return false;
      return !driver.install?.managed
        && !serverInstallFor(driver.install, cli, true)
        && !officialEngineFor(driver.driverKind);
    }).map((driver) => driver.driverKind);
    expect(missing).toEqual([]);
  });

  it("lays the prefix out per platform", () => {
    expect(enginesBinDir("/data", "linux")).toBe(join("/data", "tools", "npm", "bin"));
    expect(enginesBinDir("/data", "win32")).toBe(enginesPrefix("/data"));
  });
});

describe("checking the installed command starts", () => {
  const { ctx, calls } = useFakeNpm();

  it("prefers the app-owned CLI over an already detected external copy", async () => {
    const external = join(ctx.binDir, process.platform === "win32" ? "fakebin.cmd" : "fakebin");
    writeFileSync(external, process.platform === "win32" ? "@echo off\r\necho old\r\n" : "#!/bin/sh\necho old\n", { mode: 0o755 });
    expect(findCliCandidates("fakebin")[0]?.toLowerCase()).toBe(external.toLowerCase());
    await installNpmEngine("fake-engine", { baseDir: ctx.base, cli: "fakebin" });
    expect(findCliCandidates("fakebin")[0]?.toLowerCase()).toBe(join(activeEngineBinDir(ctx.base, "fakebin")!, process.platform === "win32" ? "fakebin.cmd" : "fakebin").toLowerCase());
    expect(calls()).toHaveLength(1);
  });

  it("keeps the last working CLI active when an update fails, including after boot registration", async () => {
    await installNpmEngine("fake-engine", { baseDir: ctx.base, cli: "fakebin" });
    const workingBin = activeEngineBinDir(ctx.base, "fakebin");
    const workingCli = findCliCandidates("fakebin")[0];
    process.env.FAKE_NPM_MODE = "broken";
    await expect(installNpmEngine("fake-engine", { baseDir: ctx.base, cli: "fakebin" })).rejects.toThrow("does not start");
    expect(activeEngineBinDir(ctx.base, "fakebin")).toBe(workingBin);
    expect(findCliCandidates("fakebin")[0]).toBe(workingCli);
    resetPathCacheForTests();
    registerEnginesBinDir(ctx.base);
    expect(findCliCandidates("fakebin")[0]).toBe(workingCli);
  });

  it("switches to a verified new copy after a successful update", async () => {
    await installNpmEngine("fake-engine", { baseDir: ctx.base, cli: "fakebin" });
    const first = activeEngineBinDir(ctx.base, "fakebin");
    await installNpmEngine("fake-engine", { baseDir: ctx.base, cli: "fakebin" });
    const second = activeEngineBinDir(ctx.base, "fakebin");
    expect(second).not.toBe(first);
    expect(findCliCandidates("fakebin")[0]?.toLowerCase()).toBe(join(second!, process.platform === "win32" ? "fakebin.cmd" : "fakebin").toLowerCase());
    expect(calls()).toHaveLength(2);
  });

  it("gives a useful permission error without dumping npm paths into Settings", async () => {
    process.env.FAKE_NPM_MODE = "permission";
    const failure = await installNpmEngine("fake-engine", { baseDir: ctx.base }).catch((error: Error) => error.message);
    expect(failure).toContain("server blocked access");
    expect(failure).toContain("Hattera's tools folder");
    expect(failure).not.toContain("secret.log");
    expect(calls()).toHaveLength(1);
  });

  it("identifies a blocked registry request as network access, not a folder permission", async () => {
    process.env.FAKE_NPM_MODE = "registry-blocked";
    const failure = await installNpmEngine("opencode-ai", { baseDir: ctx.base }).catch((error: Error) => error.message);
    expect(failure).toContain("could not reach the npm registry");
    expect(failure).not.toContain("file or folder");
  });

  it("installs again when npm left a command that does not start", async () => {
    process.env.FAKE_NPM_MODE = "broken-once";
    await installNpmEngine("fake-engine", { baseDir: ctx.base, cli: "fakebin" });
    expect(calls()).toHaveLength(2);
    for (const call of calls()) expect(call.args).toContain("--include=optional");
  });

  it("reports a command that still does not start, in its own words", async () => {
    process.env.FAKE_NPM_MODE = "broken";
    const failure = await installNpmEngine("fake-engine", { baseDir: ctx.base, cli: "fakebin" }).catch((error: Error) => error.message);
    expect(failure).toContain("`fakebin` does not start: Error: Missing optional dependency fake-engine-platform.");
    expect(failure).toContain("install again from Settings");
    expect(calls()).toHaveLength(2);
  });

  it.skipIf(process.platform !== "win32")("does not claim Node is missing when a detected npm shim cannot launch", async () => {
    writeFileSync(join(ctx.binDir, "npm.cmd"), "@echo off\r\nunsupported-wrapper %*\r\n");
    await expect(installNpmEngine("fake-engine", { baseDir: ctx.base, cli: "fakebin" })).rejects.toThrow("npm was found but its launcher could not start");
  });
});

describe.skipIf(process.platform === "win32")("installing with npm", () => {
  const { ctx, calls } = useFakeNpm();

  it("installs into a verified app-owned prefix with a fixed argument list and no workspace credentials", async () => {
    expect(serverInstallFor({ command: { linux: "npm install -g fake-engine" } }, "fakebin")).toEqual({ package: "fake-engine" });
    await installNpmEngine("fake-engine", { baseDir: ctx.base, cli: "fakebin", env: { ...process.env, XAI_API_KEY: "workspace-secret" } });
    expect(calls()).toHaveLength(1);
    const prefix = dirname(activeEngineBinDir(ctx.base, "fakebin")!);
    expect(calls()[0]!.args).toEqual(["install", "-g", "--prefix", prefix, "--loglevel=error", "--include=optional", "--allow-scripts=fake-engine", "fake-engine@latest"]);
    // The child reports its cwd resolved; macOS puts the temp dir under /private.
    expect(realpathSync(calls()[0]!.cwd)).toBe(realpathSync(prefix));
    expect(calls()[0]!.secret).toBeNull();
    // The freshly installed binary is what a bare name now resolves to.
    expect(realpathSync(findCliCandidates("fakebin")[0]!)).toBe(realpathSync(join(activeEngineBinDir(ctx.base, "fakebin")!, "fakebin")));
    expect(augmentedPath().split(delimiter)[0]).toBe(activeEngineBinDir(ctx.base, "fakebin"));
  });

  it("coalesces concurrent clicks into one npm run", async () => {
    process.env.FAKE_NPM_MODE = "slow";
    await Promise.all([installNpmEngine("fake-engine", { baseDir: ctx.base }), installNpmEngine("fake-engine", { baseDir: ctx.base })]);
    expect(calls()).toHaveLength(1);
  });

  it("reports a failed install with npm's last lines, and a package that provides no command", async () => {
    process.env.FAKE_NPM_MODE = "fail";
    const failure = await installNpmEngine("fake-engine", { baseDir: ctx.base }).catch((error: Error) => error.message);
    expect(failure).toContain("could not install fake-engine");
    expect(failure).toContain("404 Not Found");
    process.env.FAKE_NPM_MODE = "no-bin";
    await expect(installNpmEngine("fake-engine", { baseDir: ctx.base, cli: "fakebin" })).rejects.toThrow("did not provide a `fakebin` command");
  });

  it("stops an install that hangs", async () => {
    process.env.FAKE_NPM_MODE = "hang";
    await expect(installNpmEngine("fake-engine", { baseDir: ctx.base, timeoutMs: 300 })).rejects.toThrow("took too long");
  });

  it("force-stops an install that ignores TERM", async () => {
    process.env.FAKE_NPM_MODE = "stubborn";
    const stopped = vi.spyOn(procs, "killCliTree");
    try {
      // Enough headroom for the fixture's Node boot under load, so TERM
      // arrives after the trap above is armed and only KILL can finish it.
      await expect(installNpmEngine("fake-engine", { baseDir: ctx.base, timeoutMs: 5000 })).rejects.toThrow("took too long and was stopped");
      expect(stopped.mock.calls[0]![0].signalCode).toBe("SIGKILL");
    } finally {
      stopped.mockRestore();
    }
  }, 20_000);

  it("reports an uncertain stop without waiting forever for npm close", async () => {
    process.env.FAKE_NPM_MODE = "hang";
    const kill = procs.killCliTree;
    const stopped = vi.spyOn(procs, "killCliTree").mockResolvedValue(false);
    try {
      await expect(installNpmEngine("fake-engine", { baseDir: ctx.base, timeoutMs: 300 })).rejects.toThrow("could not be confirmed stopped");
      expect(stopped.mock.calls[0]![0].exitCode).toBeNull();
      expect(stopped.mock.calls[0]![0].signalCode).toBeNull();
    } finally {
      const children = stopped.mock.calls.map(([child]) => child);
      stopped.mockRestore();
      await Promise.all(children.map((child) => kill(child, 0)));
    }
  });

  it("says plainly when npm is missing", async () => {
    // The PATH scan also looks in standard install locations, which a test
    // cannot empty, so absence is injected at both call sites.
    expect(serverInstallFor({ command: { linux: "npm install -g fake-engine" } }, "fakebin", false)).toBeNull();
    mkdirSync(join(ctx.scratch, "empty"));
    await expect(installNpmEngine("fake-engine", { baseDir: ctx.base, path: join(ctx.scratch, "empty") })).rejects.toThrow("npm is not installed");
  });
});
