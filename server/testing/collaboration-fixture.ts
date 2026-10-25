import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { verificationServerEnvironment } from "../../scripts/control-hattera.ts";
import { findLocalRuntime, readLocalRuntime } from "../local-runtime.ts";
import { freePortBlock } from "./ports.ts";
import { removeTempDir, waitForExit } from "./cleanup.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));

export async function preparePeerFixture(): Promise<string> {
  const override = process.env.OMB_VERIFY_PEER_HELPER;
  if (override) {
    if (!existsSync(override)) throw new Error("OMB_VERIFY_PEER_HELPER does not name an existing fixture executable.");
    return resolve(override);
  }
  const source = join(root, "server/testing/fake-peer-network.go");
  const digest = createHash("sha256").update(readFileSync(source)).digest("hex").slice(0, 16);
  const directory = join(root, ".omb-scratch/verify-tools"); mkdirSync(directory, { recursive: true });
  const binary = join(directory, `peer-${process.platform}-${process.arch}-${digest}${process.platform === "win32" ? ".exe" : ""}`);
  if (!existsSync(binary)) {
    try { await promisify(execFile)("go", ["build", "-o", binary, source], { cwd: root, windowsHide: true, timeout: 120_000 }); }
    catch (error) { throw new Error("The collaboration E2E fixture requires Go. Install Go, then rerun npm run test:e2e.", { cause: error }); }
  }
  return binary;
}

/** Three foreground-owned app processes. No live runtime discovery, global
 * home, login, Compose volume or system VPN is used by this fixture. */
export async function createCollaborationFixture(options: { diverseProviders?: boolean } = {}) {
  const helper = await preparePeerFixture();
  const directory = mkdtempSync(join(tmpdir(), "hattera-collaboration-e2e-"));
  const homes = [0, 1, 2].map(index => join(directory, `peer-${index}`));
  const basePort = await freePortBlock([0, 1, 2, 3, 4, 5]);
  const ports = homes.map((_, index) => basePort + index * 2);
  const origins = ports.map((_, index) => `http://100.65.0.${index + 1}`);
  const urls = ports.map(port => `http://127.0.0.1:${port}`);
  const logs = homes.map(home => join(home, "server.log"));
  const children: Array<ChildProcess | undefined> = [];
  const environments = homes.map((home, index) => {
    mkdirSync(join(home, "tmp"), { recursive: true }); mkdirSync(join(home, "private-network/state"), { recursive: true });
    writeFileSync(join(home, "private-network/state/fixture.json"), JSON.stringify({ origin: origins[index], peers: Object.fromEntries(origins.map((origin, peer) => [origin, urls[peer]])) }));
    const driver = options.diverseProviders ? ["claudeAgent", "codex", "opencodeGo"][index]! : "claudeAgent";
    const cli = driver === "codex" ? "fake-codex-app-server.ts" : driver === "opencodeGo" ? "fake-acp-cli.ts" : "fake-claude-cli.ts";
    writeFileSync(join(home, "config.json"), JSON.stringify({ instances: { fixture: { driver, config: { cli: join(root, "server/testing", cli) } } } }));
    return { ...verificationServerEnvironment({}, home, ports[index]!), OMB_NETWORK_HELPER: helper, OMB_TAILSCALE_ENABLED: "1", OMB_PERSISTENT_WEB: "1",
      OMB_STATIC_DIR: resolve(process.env.OMB_VERIFY_WEB_DIST ?? join(root, "dist")),
      FAKE_CLAUDE_DUMP: join(home, "native-claude.json"),
      FAKE_CODEX_DUMP: join(home, "native-codex.json"), FAKE_CODEX_DUMP_TURNS_ONLY: "1",
      FAKE_ACP_DUMP: join(home, "native-acp.json"), FAKE_ACP_MODELS: "fixture/test", FAKE_ACP_TEXT_REPLY: "Shared ACP execution completed",
      FAKE_CLAUDE_TOOL_CALLS: "[]", FAKE_CLAUDE_REPLIES: JSON.stringify([`[Remote link fixture](${pathToFileURL(join(homes[0]!, "local-only.txt")).href})`]) };
  });
  const entry = resolve(process.env.OMB_VERIFY_SERVER_ENTRY ?? join(root, "server/index.ts"));
  const api = async (index: number, path: string, body?: object, method = body ? "POST" : "GET"): Promise<Record<string, any>> => {
    // Restart scenarios reuse the port, never a pooled socket from its former
    // process. Mutations are deliberately not retried by this test client.
    const response = await fetch(urls[index] + path, { method, headers: { "content-type": "application/json", origin: urls[index]!, connection: "close" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000) });
    const data = await response.json() as Record<string, any>;
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
    return data;
  };
  const launch = async (index: number) => {
    if (children[index]?.exitCode === null && children[index]?.signalCode === null) throw new Error("This fixture peer is already running.");
    const fd = openSync(logs[index]!, "a", 0o600);
    const child = spawn(process.execPath, ["--import", new URL("./fixture-parent.mjs", import.meta.url).href, ...(entry.endsWith(".ts") ? ["--experimental-strip-types"] : []), entry], {
      cwd: root, env: environments[index], windowsHide: true, stdio: ["ignore", fd, fd, "ipc"],
    }); closeSync(fd); children[index] = child;
    let failure: Error | undefined; child.on("error", error => { failure = error; });
    try {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        if (failure || child.exitCode !== null || child.signalCode !== null) throw failure ?? new Error(`Fixture peer exited before readiness; see ${logs[index]}`);
        const runtime = await findLocalRuntime(homes[index]!);
        if (runtime && child.pid && runtime.pid === child.pid) return runtime;
        await new Promise(done => setTimeout(done, 200));
      }
      throw new Error(`Fixture peer did not become ready; see ${logs[index]}`);
    } catch (error) { await waitForExit(child, { signal: "SIGTERM" }); throw error; }
  };
  const stop = async (index: number) => {
    const child = children[index]; if (!child) return;
    if (child.exitCode !== null || child.signalCode !== null) return;
    let requested = false;
    try {
      const runtime = await findLocalRuntime(homes[index]!);
      if (runtime && child.pid && runtime.pid === child.pid) { await api(index, "/api/local-runtime/stop", { pid: runtime.pid, environmentId: runtime.environmentId }); requested = true; }
    } finally { await waitForExit(child, requested ? { graceMs: 15_000 } : { signal: "SIGTERM" }); }
    if (readLocalRuntime(homes[index]!)) throw new Error("The stopped fixture left an active runtime discovery record.");
  };
  const saveEvidence = (destination: string) => {
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    for (const [index, file] of logs.entries()) if (existsSync(file)) copyFileSync(file, join(destination, `peer-${index}.log`));
  };
  const close = async () => {
    const stopped = await Promise.allSettled(homes.map((_, index) => stop(index)));
    const failure = stopped.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw new Error(`Fixture teardown failed; evidence retained at ${directory}`, { cause: failure.reason });
    await removeTempDir(directory);
  };
  return { directory, homes, ports, origins, urls, logs, launch, stop, api, saveEvidence, close };
}
