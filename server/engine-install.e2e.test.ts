import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";
import { activeEngineBinDir } from "./engine-install.ts";
import { removeTempDir } from "./testing/cleanup.ts";

async function packFixture(scratch: string, pkg: string, cli: string): Promise<Buffer> {
  const packageDir = join(scratch, "package");
  mkdirSync(join(packageDir, "bin"), { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({
    name: pkg, version: "1.0.0", type: "module", bin: { [cli]: "bin/opencode.js" },
  }));
  const source = readFileSync(fileURLToPath(new URL("./testing/fake-acp-cli.ts", import.meta.url)), "utf8");
  writeFileSync(join(packageDir, "bin", "opencode.js"), transformSync(source, { loader: "ts", format: "esm", target: "node24" }).code);
  const env = { ...process.env, npm_config_cache: join(scratch, "pack-cache"), npm_config_ignore_scripts: "true" };
  const npmCli = [join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(process.env.ProgramFiles ?? "", "nodejs", "node_modules", "npm", "bin", "npm-cli.js")].find(existsSync);
  if (!npmCli) throw new Error("Node.js installation has no npm CLI");
  const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [npmCli, "pack", "--pack-destination", scratch, "--ignore-scripts"], { cwd: packageDir, env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr }));
  });
  if (result.code !== 0) throw new Error(`Could not pack local OpenCode fixture: ${result.stderr}`);
  const archive = readdirSync(scratch).find((name) => name.endsWith(".tgz"));
  if (!archive) throw new Error("npm pack did not create an archive");
  return readFileSync(join(scratch, archive));
}

it.each([
  { engine: "opencodeGo", pkg: "opencode-ai", cli: "opencode" },
  { engine: "codex", pkg: "@openai/codex", cli: "codex" },
  { engine: "claude", pkg: "@anthropic-ai/claude-code", cli: "claude" },
  { engine: "cline", pkg: "cline", cli: "cline" },
  { engine: "pi", pkg: "@earendil-works/pi-coding-agent", cli: "pi" },
  { engine: "grok", pkg: "@xai-official/grok", cli: "grok" },
  { engine: "qwen", pkg: "@qwen-code/qwen-code", cli: "qwen" },
  { engine: "kimi", pkg: "@moonshot-ai/kimi-code", cli: "kimi" },
  { engine: "droid", pkg: "droid", cli: "droid" },
  { engine: "gemini", pkg: "@google/gemini-cli", cli: "gemini" },
])("installs $engine through the real HTTP route and npm from an isolated registry", async ({ engine, pkg, cli }) => {
  const scratch = mkdtempSync(join(tmpdir(), "hattera-opencode-install-"));
  const requests: string[] = [];
  let registry: ReturnType<typeof createServer> | undefined;
  let fixture: Awaited<ReturnType<typeof launchVerificationServer>> | undefined;
  try {
    const tarball = await packFixture(scratch, pkg, cli);
    registry = createServer((req, res) => {
      requests.push(req.url ?? "");
      if (decodeURIComponent((req.url ?? "").slice(1)) === pkg) {
        const address = registry!.address();
        if (!address || typeof address === "string") throw new Error("Registry address unavailable");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: pkg, "dist-tags": { latest: "1.0.0" }, versions: {
          "1.0.0": { name: pkg, version: "1.0.0", bin: { [cli]: "bin/opencode.js" },
            dist: { tarball: `http://127.0.0.1:${address.port}/fixture.tgz` } },
        } }));
      } else if (req.url === "/fixture.tgz") {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(tarball);
      } else {
        res.writeHead(404); res.end();
      }
    });
    await new Promise<void>((resolve) => registry!.listen(0, "127.0.0.1", resolve));
    const address = registry.address();
    if (!address || typeof address === "string") throw new Error("Registry address unavailable");
    fixture = await launchVerificationServer({ OMB_TEST_NPM_REGISTRY_URL: `http://127.0.0.1:${address.port}/` },
      undefined, undefined, undefined, undefined, undefined,
      engine === "codex" || engine === "grok" || engine === "kimi" || engine === "droid" || engine === "gemini" ? [engine] : []);
    const api = async (method: string, path: string, payload?: unknown) => {
      const response = await fetch(`${fixture!.info.url}${path}`, { method, headers: { origin: fixture!.info.url, "content-type": "application/json" },
        ...(["POST", "PATCH"].includes(method) ? { body: JSON.stringify(payload ?? {}) } : {}), signal: AbortSignal.timeout(120_000) });
      const body = await response.json() as { instances: Array<{
        instanceId: string;
        snapshot: { state: string; version?: string };
        install?: { server?: { package: string } };
      }>; error?: string; install?: { state: string; error?: string } };
      const binDir = activeEngineBinDir(fixture!.info.dataDir, cli);
      const prefix = binDir ? (process.platform === "win32" ? binDir : dirname(binDir)) : join(fixture!.info.dataDir, "tools", "engines", cli);
      const packageRoot = join(prefix, "node_modules", ...pkg.split("/"));
      expect(response.status, JSON.stringify({ body, files: existsSync(prefix) ? readdirSync(prefix) : [],
        packageFiles: existsSync(packageRoot) ? readdirSync(packageRoot) : [],
        packageJson: existsSync(join(packageRoot, "package.json")) ? JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) : null })).toBe(method === "POST" && path.endsWith("/install") ? 202 : 200);
      return body;
    };
    if (engine === "codex" || engine === "claude") await api("PATCH", `/api/instances/${engine}`, { cli: "" });
    const before = (await api("GET", "/api/instances")).instances.find((row) => row.instanceId === engine)!;
    expect(before.snapshot.state).toBe("unavailable");
    expect(before.install?.server).toEqual({ package: pkg });
    expect((await api("POST", `/api/instances/${engine}/install`)).install?.state).toBe("running");
    let status: string | undefined;
    for (let attempt = 0; attempt < 60; attempt++) {
      const result = (await api("GET", `/api/instances/${engine}/install/status`)).install;
      status = result?.state;
      if (status === "failed") throw new Error(result?.error);
      if (status === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(status).toBe("succeeded");
    const after = (await api("GET", "/api/instances")).instances.find((row) => row.instanceId === engine)!;
    if (engine === "opencodeGo" || engine === "codex") {
      expect(after.snapshot.state).toBe("available");
      expect(after.snapshot.version).toContain("fake-acp 1.0.0");
    }
    expect(requests.some((url) => decodeURIComponent(url.slice(1)) === pkg)).toBe(true);
    expect(requests).toContain("/fixture.tgz");
    expect(existsSync(join(activeEngineBinDir(fixture.info.dataDir, cli)!, process.platform === "win32" ? `${cli}.cmd` : cli))).toBe(true);
    const again = (await api("GET", "/api/instances")).instances.find((row) => row.instanceId === engine)!;
    expect(again.snapshot.state).toBe(after.snapshot.state);
  } finally {
    await fixture?.close();
    registry?.closeAllConnections();
    if (registry?.listening) await new Promise<void>((resolve) => registry!.close(() => resolve()));
    await removeTempDir(scratch);
  }
}, 180_000);
