// Qualify the actual npm installation, outside the checkout and its node_modules.
// Usage: node scripts/testing/verify-npm-install.mjs /absolute/hattera-VERSION.tgz [report.json]
// Needs Node 24+, npm and registry access. Never imports a user's Hattera home,
// provider credentials, npmrc or browser profile. No provider account is signed in.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const tarball = resolve(process.argv[2] ?? "");
assert.ok(process.argv[2] && existsSync(tarball) && tarball.endsWith(".tgz"), "Pass a packed Hattera tarball");
const reportPath = process.argv[3] && resolve(process.argv[3]);
const space = statfsSync(tmpdir());
assert.ok(space.bavail * space.bsize >= 1024 ** 3, "Free at least 1 GiB in the temporary drive before npm qualification (2 GB recommended)");
const scratch = mkdtempSync(join(tmpdir(), "hattera-npm-"));
const prefix = join(scratch, "prefix with spaces"), home = join(scratch, "home"), data = join(home, ".hattera");
const unrelated = join(scratch, "another-project");
for (const dir of [home, unrelated, prefix]) mkdirSync(dir, { recursive: true });
for (const dir of [home, unrelated]) writeFileSync(join(dir, "package.json"), JSON.stringify({
  private: true, scripts: { hattera: "hattera", legacy: "openmausbot" },
}));
writeFileSync(join(home, ".npmrc"), "");
writeFileSync(join(home, "global-npmrc"), "");
const npmCandidates = [
  process.env.npm_execpath,
  join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
  join(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
  ...String(process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":").map(dir => join(dir, "npm")),
].filter(Boolean);
const npm = npmCandidates.find(path => existsSync(path) && realpathSync(path).endsWith("npm-cli.js"));
assert.ok(npm, "Node.js installation must include npm");
const env = {};
// System command discovery and explicit network trust settings only. In
// particular no OMB/HATTERA resources override can mask missing package files.
for (const key of ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS"]) {
  if (process.env[key]) env[key] = process.env[key];
}
// Do not discover the developer's globally installed provider CLIs. Node/npm
// and OS utilities are enough; engine installs add their own managed bin dirs.
env.PATH = (process.platform === "win32"
  ? [dirname(process.execPath), join(env.SystemRoot, "System32"), env.SystemRoot, join(env.SystemRoot, "System32/WindowsPowerShell/v1.0")]
  : [dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"]).join(process.platform === "win32" ? ";" : ":");
Object.assign(env, {
  HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData/Roaming"), LOCALAPPDATA: join(home, "AppData/Local"),
  XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local/share"),
  TMPDIR: scratch, TEMP: scratch, TMP: scratch,
  npm_config_cache: join(scratch, "npm-cache"), npm_config_userconfig: join(home, ".npmrc"),
  npm_config_globalconfig: join(home, "global-npmrc"), npm_config_registry: "https://registry.npmjs.org/",
  HATTERA_DATA_DIR: data, HATTERA_ENVIRONMENT_LABEL: "npm-qualification",
  OMB_TEST_INTERNAL_CAPABILITY_KEY: randomBytes(24).toString("hex"),
});
const ports = [];
for (let i = 0; i < 2; i++) {
  const server = createServer();
  await new Promise((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done); });
  ports.push(server);
}
const [port, webhook] = ports.map(server => server.address().port);
await Promise.all(ports.map(server => new Promise(done => server.close(done))));
env.HATTERA_PORT = String(port);
env.HATTERA_WEBHOOK_PORT = String(webhook);
const base = `http://127.0.0.1:${port}`;
const checks = [], publicProviderInstalls = process.env.HATTERA_VERIFY_NPM_PROVIDERS === "1";
const browserInstall = process.env.HATTERA_VERIFY_NPM_BROWSER === "1";
let receipt, installed;
const command = async (args, options = {}) => {
  try {
    return (await exec(process.execPath, [npm, ...args], {
      cwd: unrelated, env, windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024, ...options,
    })).stdout;
  } catch (error) {
    throw new Error(`${args.slice(0, 5).join(" ")}: ${error.message}\n${error.stdout ?? ""}\n${error.stderr ?? ""}`);
  }
};
// npm run forwards arguments through the platform shell to the installed bin
// on PATH, including Windows .cmd shims. It never downloads another package.
const cli = (args, options) => command(["run", "--silent", "hattera", "--", ...args], options);
const check = async (name, run) => { await run(); checks.push(name); console.log(`PASS ${name}`); };
async function api(method, path, body, status = 200, extraHeaders = {}) {
  const response = await fetch(base + path, {
    method, headers: { origin: base, "content-type": "application/json", ...extraHeaders },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json();
  assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(result)}`);
  return result;
}
async function stop() {
  if (!installed) return;
  await cli(["stop"]);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { await fetch(base + "/api/health", { signal: AbortSignal.timeout(500) }); }
    catch { return; }
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error("Installed background runtime did not stop");
}
let failure;
try {
  await check("npm global install with platform native dependencies", async () => {
    console.log(await command(["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", tarball], { timeout: 600_000 }));
    const modules = (await command(["root", "--global", "--prefix", prefix])).trim();
    installed = join(modules, "hattera");
    assert.ok(isAbsolute(installed) && installed.startsWith(prefix + sep));
    const binDir = process.platform === "win32" ? prefix : join(prefix, "bin");
    env.PATH = binDir + (process.platform === "win32" ? ";" : ":") + env.PATH;
    for (const name of ["hattera", "openmausbot"]) assert.ok(existsSync(join(binDir, name + (process.platform === "win32" ? ".cmd" : ""))));
    const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
    for (const name of ["@duckdb/node-api", "@resvg/resvg-js"]) assert.ok(manifest.dependencies[name]);
    for (const name of ["LICENSE", "NOTICE", "dist/index.html", "dist-server/index.js", "dist-server/tunnel-guardian.js", "enterprise/server/index.js", "enterprise/LICENSE"]) {
      assert.ok(existsSync(join(installed, name)), `Missing ${name}`);
    }
    for (const platform of ["win32", "darwin", "linux"]) for (const arch of ["x64", "arm64"]) {
      const target = join(installed, "network", `${platform}-${arch}`);
      assert.ok(existsSync(join(target, `hattera-network${platform === "win32" ? ".exe" : ""}`)));
      assert.ok(existsSync(join(target, "THIRD_PARTY_NOTICES.txt")));
    }
    assert.ok(!existsSync(join(installed, "server")), "Source tree leaked into npm artifact");
    assert.match(await cli(["--help"]), /hattera serve/);
    assert.match(await command(["run", "--silent", "legacy", "--", "--help"]), /hattera serve/);
  });
  await check("local launcher, runtime reuse, assets and remote auth boundary", async () => {
    receipt = JSON.parse(await cli(["web", "--cli-only", "--json"]));
    assert.equal(receipt.url, base);
    assert.ok(Number.isInteger(receipt.pid) && receipt.pid > 0);
    assert.equal((await fetch(base + "/api/health")).status, 200);
    const descriptor = await api("GET", "/.well-known/hattera/environment");
    assert.equal(descriptor.capabilities.localCli, true);
    assert.equal((await api("GET", "/.well-known/openmausbot/environment")).environmentId, descriptor.environmentId);
    const remote = await fetch(base + "/api/config", { headers: { "x-forwarded-for": "192.0.2.10", "x-forwarded-proto": "https" } });
    assert.ok([401, 403].includes(remote.status));
    const html = await fetch(base).then(response => response.text());
    const asset = html.match(/src="([^"]+\.js)"/);
    assert.ok(asset, "Built home page must load its JavaScript");
    assert.equal((await fetch(new URL(asset[1], base))).status, 200);
    const reused = JSON.parse(await cli(["web", "--cli-only", "--json"], { cwd: home }));
    assert.equal(reused.pid, receipt.pid, "Opening from another project must reuse the same owned runtime");
    assert.equal(reused.reused, true);
    assert.match(await cli(["status"]), /npm-qualification/);
    assert.match(await cli(["pair", "--label", "Qualification device"]), /pairing code:/);
    assert.match(await cli(["sessions"]), /no paired devices yet/);
  });
  await check("all provider families visible; no borrowed account credentials", async () => {
    const { instances } = await api("GET", "/api/instances");
    console.log(`Provider instances: ${instances.map(item => item.instanceId).join(", ")}`);
    assert.ok(instances.length >= 20, `Provider catalog unexpectedly short: ${instances.length}`);
    assert.ok(instances.some(item => item.instanceId === "opencodeGo"));
    assert.ok(instances.some(item => item.instanceId === "bedrock"));
    assert.ok(!instances.some(item => /test provider|verification fixture/i.test(item.displayName ?? "")));
    // Installed CLI discovery may find binaries in PATH; authentication still
    // belongs to this empty home, never the developer's configured account.
    console.log(`Catalog contains ${instances.length} providers`);
  });
  const { bot } = await api("POST", "/api/bots", { name: "Npm qualification" }, 201);
  const botPath = `/api/bots/${bot.id}/data`;
  let token, chartId;
  const mint = async () => {
    ({ token } = await api("POST", "/api/testing/internal-capability", { botId: bot.id, threadId: bot.threadId, kind: "data" }, 201,
      { "x-openmausbot-test-capability": env.OMB_TEST_INTERNAL_CAPABILITY_KEY }));
  };
  const tool = async (name, args, isError = false) => {
    const { result } = await api("POST", "/api/internal/data/mcp", { method: "tools/call", params: { name, arguments: args } }, 200, { authorization: `Bearer ${token}` });
    assert.equal(result.isError === true, isError, JSON.stringify(result));
    return result.structuredContent;
  };
  await check("DuckDB CSV load, SQL, rejected writes and table/chart results", async () => {
    await mint();
    const csv = join(data, "qualification.csv");
    writeFileSync(csv, "region,amount\nnorth,10\nsouth,20\nnorth,5\n");
    const loaded = await tool("data_load", { source: csv, name: "sales" });
    assert.equal(loaded.tables[0].rowCount, 3);
    assert.equal((await tool("data_describe", { target: "sales" })).columns.length, 2);
    const totals = await tool("data_sql", { sql: "SELECT sum(amount)::INTEGER AS total FROM sales" });
    assert.equal(Number(totals.rows[0][0]), 35);
    assert.equal((await tool("data_sql", { sql: "DELETE FROM sales" }, true)).code, "write_refused");
    await tool("data_show", { kind: "table", title: "Sales", sql: "SELECT * FROM sales" });
    const chart = await tool("data_show", { kind: "chart", title: "Regions", table: "sales", chart: { type: "bar", x: "region", y: "amount", agg: "sum" } });
    chartId = chart.id;
    assert.equal((await api("GET", botPath)).sheet.cards.length, 2);
    mkdirSync(join(home, "Downloads"), { recursive: true });
    const exported = await api("POST", botPath + "/export", { cardId: chartId, format: "csv" });
    assert.ok(exported.path.startsWith(join(home, "Downloads") + sep), exported.path);
    const exportedCsv = readFileSync(exported.path, "utf8");
    assert.match(exportedCsv, /north,15/);
    assert.match(exportedCsv, /south,20/);
  });
  await check("native PNG chart renderer and SVG output", async () => {
    for (const format of ["svg", "png"]) {
      const response = await fetch(`${base}${botPath}/cards/${chartId}/image?format=${format}`, { headers: { origin: base } });
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(response.status, 200, bytes.toString().slice(0, 500));
      if (format === "png") assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      else assert.match(bytes.toString(), /<svg/);
    }
  });
  await check("restart preserves bot, DuckDB source and result cards", async () => {
    await stop();
    receipt = JSON.parse(await cli(["web", "--cli-only", "--json"]));
    assert.equal((await api("GET", botPath)).sheet.cards.length, 2);
    await mint();
    assert.equal(Number((await tool("data_sql", { sql: "SELECT sum(amount)::INTEGER AS total FROM sales" })).rows[0][0]), 35);
  });
  await check("packaged private-network helper executes", async () => {
    const helper = join(installed, "network", `${process.platform}-${process.arch}`, `hattera-network${process.platform === "win32" ? ".exe" : ""}`);
    const { stdout } = await exec(helper, ["--version"], { env, timeout: 30_000, windowsHide: true });
    assert.ok(stdout.trim());
  });
  if (publicProviderInstalls) await check("fresh public downloads through every offered npm engine installer", async () => {
    const { instances } = await api("GET", "/api/instances");
    const targets = instances.filter(item => item.install?.server?.package && !["chatgpt", "claudeApi"].includes(item.instanceId));
    assert.ok(targets.length >= 8, "Missing npm engine installation routes");
    for (const item of targets) {
      assert.notEqual(item.snapshot?.state, "ready", `${item.instanceId} was already configured`);
      console.log(`Installing ${item.instanceId}: ${item.install.server.package}`);
      await api("POST", `/api/instances/${item.instanceId}/install`, {}, 202);
      const deadline = Date.now() + 30 * 60_000;
      for (;;) {
        const { install } = await api("GET", `/api/instances/${item.instanceId}/install/status`);
        if (install?.state === "failed") throw new Error(`${item.instanceId}: ${install.error}`);
        if (install?.state === "succeeded") break;
        assert.ok(Date.now() < deadline, `${item.instanceId}: install timed out`);
        await new Promise(done => setTimeout(done, 1000));
      }
      const refreshed = (await api("GET", "/api/instances")).instances.find(candidate => candidate.instanceId === item.instanceId);
      assert.notEqual(refreshed.snapshot?.state, "unavailable", `${item.instanceId}: ${JSON.stringify(refreshed.snapshot)}`);
      checks.push(`public engine install: ${item.instanceId}`);
      console.log(`PASS public engine install: ${item.instanceId}`);
    }
  });
  if (browserInstall) await check("browser engine downloads and starts in the isolated home", async () => {
    await cli(["browser", "install", ...(process.platform === "linux" ? ["--with-deps"] : [])], { timeout: 600_000 });
    assert.match(await cli(["browser", "status"]), /browser engine: agent-browser/);
    const browserRoot = join(data, "tools/agent-browser");
    const executable = `agent-browser${process.platform === "win32" ? ".exe" : ""}`;
    const binary = readdirSync(browserRoot).map(version => join(browserRoot, version, executable)).find(existsSync);
    assert.ok(binary, "The browser installer must leave a managed executable");
    const browserEnv = { ...env, AGENT_BROWSER_SESSION: "npm-qualification", AGENT_BROWSER_ARGS: "--no-sandbox", AGENT_BROWSER_NO_WEBMCP: "1" };
    try {
      await exec(binary, ["open", base], { env: browserEnv, timeout: 60_000, windowsHide: true });
      assert.match((await exec(binary, ["get", "title"], { env: browserEnv, timeout: 30_000, windowsHide: true })).stdout, /Hattera/i);
    } finally {
      await exec(binary, ["close"], { env: browserEnv, timeout: 15_000, windowsHide: true });
    }
  });
  await stop();
  await check("self-hosted serve keeps sign-in and pairing authentication", async () => {
    // Foreground serve is a different trust mode from the local CLI launcher.
    // Use the bundled server entry with no local-mode flag for a bounded child.
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, [join(installed, "dist-server/index.js")], { env, cwd: unrelated, windowsHide: true, stdio: "ignore" });
    let spawnError;
    child.once("error", error => { spawnError = error; });
    const exited = new Promise(done => child.once("exit", done));
    try {
      let ready = false;
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (spawnError) throw spawnError;
        if (child.exitCode !== null) throw new Error(`Self-hosted runtime exited ${child.exitCode}`);
        try { ready = (await fetch(base + "/api/health", { signal: AbortSignal.timeout(500) })).ok; } catch { /* starting */ }
        if (ready) break;
        await new Promise(done => setTimeout(done, 100));
      }
      assert.ok(ready, "Self-hosted runtime never became healthy");
      assert.equal((await api("GET", "/.well-known/hattera/environment")).capabilities.localCli, false);
      assert.ok([401, 403].includes((await fetch(base + "/api/config")).status));
    } finally {
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise((_, reject) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Self-hosted child did not stop")); }, 10_000);
        timer.unref();
      })]);
    }
  });
  await check("npm uninstall removes commands and preserves workspace data", async () => {
    await command(["uninstall", "--global", "--prefix", prefix, "--no-audit", "--no-fund", "hattera"]);
    const previous = installed;
    installed = undefined;
    assert.ok(!existsSync(previous));
    const binDir = process.platform === "win32" ? prefix : join(prefix, "bin");
    for (const name of ["hattera", "openmausbot"]) assert.ok(!existsSync(join(binDir, name + (process.platform === "win32" ? ".cmd" : ""))));
    assert.ok(existsSync(join(data, "qualification.csv")), "npm uninstall must preserve workspace files");
  });
  await check("npx executes the tarball after the global command is removed", async () => {
    assert.match(await command(["exec", "--yes", "--offline", "--package", tarball, "--", "hattera", "--help"]), /hattera serve/);
  });
} catch (error) {
  failure = error;
  console.error(error);
  if (receipt?.logPath && existsSync(receipt.logPath)) console.error(readFileSync(receipt.logPath, "utf8").slice(-6000));
} finally {
  try { await stop(); } catch (error) { failure ??= error; }
  // Release disk space before writing evidence. A full disk must not prevent
  // fixture cleanup or leave a global installation behind.
  assert.ok(resolve(scratch).startsWith(resolve(tmpdir()) + sep) && basename(scratch).startsWith("hattera-npm-"));
  try { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (error) { failure ??= error; }
  const report = {
    ok: !failure, platform: `${process.platform}-${process.arch}`, node: process.version,
    tarball: basename(tarball), sha256: createHash("sha256").update(readFileSync(tarball)).digest("hex"), checks,
    ...(failure ? { error: String(failure) } : {}),
    notQualified: ["real provider authentication and quotas", "live multi-device Tailscale", "desktop-only OS integrations",
      ...(!checks.includes("browser engine downloads and starts in the isolated home") ? ["browser engine download"] : []),
      ...(!checks.includes("fresh public downloads through every offered npm engine installer") ? ["public provider downloads"] : [])],
  };
  if (reportPath) { mkdirSync(dirname(reportPath), { recursive: true }); writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n"); }
  console.log(JSON.stringify(report));
}
if (failure) process.exitCode = 1;
