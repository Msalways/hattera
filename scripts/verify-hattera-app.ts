// Full built app against a disposable fake-engine server with an explicit native browser.
// No real provider account, browser profile, or OpenMausBot home is imported.
import { createServer, request } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, extname, sep, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { transformSync } from "esbuild";
import { launchVerificationServer } from "./control-omb.ts";
import { waitForExit } from "../server/testing/cleanup.ts";
import { browserSessionId, closeBrowserSession } from "../server/browser-engine.ts";
import { activeEngineBinDir } from "../server/engine-install.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = resolve(root, "dist");
const binaryPath = process.env.OMB_VERIFY_BROWSER_BINARY;
const executablePath = process.env.OMB_VERIFY_BROWSER_CHROME;
if (!binaryPath || !executablePath || !existsSync(binaryPath) || !existsSync(executablePath)) {
  throw new Error("Set OMB_VERIFY_BROWSER_BINARY and OMB_VERIFY_BROWSER_CHROME to installed files.");
}
if (!existsSync(resolve(dist, "index.html"))) throw new Error("Build the web app first: vite build --configLoader runner");

// The browser clicks a real server install button. npm downloads this package
// from a temporary loopback registry, never from the user's registry/account.
const installScratch = await mkdtemp(join(tmpdir(), "hattera-ui-npm-"));
const installPackage = "cline";
const installPackageDir = join(installScratch, "package");
await mkdir(join(installPackageDir, "bin"), { recursive: true });
await writeFile(join(installPackageDir, "package.json"), JSON.stringify({
  name: installPackage, version: "1.0.0", type: "module", bin: { cline: "bin/cline.js" },
}));
const fakeCli = await readFile(resolve(root, "server/testing/fake-acp-cli.ts"), "utf8");
const fakeAuth = `
import * as clineAuthFs from 'node:fs';
import { join as clineAuthJoin } from 'node:path';
if (process.argv.slice(2).join(' ') === 'auth --provider cline') {
  console.error('[auth] Enter this code in your browser: ABCD-EFGH');
  console.error('[auth] https://authkit.cline.bot/device?user_code=ABCD-EFGH');
  await new Promise(done => { const timer = setInterval(() => {
    if (!clineAuthFs.existsSync(clineAuthJoin(process.env.HOME, 'cline-auth-approved'))) return;
    clearInterval(timer);
    const directory = clineAuthJoin(process.env.HOME, '.cline', 'data', 'settings');
    clineAuthFs.mkdirSync(directory, { recursive: true });
    clineAuthFs.writeFileSync(clineAuthJoin(directory, 'providers.json'), JSON.stringify({ version: 1, lastUsedProvider: 'cline',
      providers: { cline: { settings: { provider: 'cline', model: 'fixture-model', auth: { accessToken: 'fixture-only' } } } } }));
    done();
  }, 100); });
  process.exit(0);
}
`;
await writeFile(join(installPackageDir, "bin/cline.js"), "#!/usr/bin/env node\n" + fakeAuth + transformSync(fakeCli, { loader: "ts", format: "esm", target: "node24" }).code.replace(/^#![^\n]*\n/, ""));
const npmCli = [join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
  join(process.env.ProgramFiles ?? "", "nodejs/node_modules/npm/bin/npm-cli.js")].find(existsSync);
if (!npmCli) throw new Error("Node.js installation has no npm CLI");
await promisify(execFile)(process.execPath, [npmCli, "pack", "--pack-destination", installScratch, "--ignore-scripts"], {
  cwd: installPackageDir, env: { ...process.env, npm_config_cache: join(installScratch, "pack-cache") }, timeout: 30_000,
});
const archive = (await readdir(installScratch)).find((name) => name.endsWith(".tgz"));
if (!archive) throw new Error("npm pack did not create a local install fixture");
const tarball = await readFile(join(installScratch, archive));
const registryRequests: string[] = [];
const registry = createServer((req, res) => {
  registryRequests.push(req.url ?? "");
  const address = registry.address();
  if (!address || typeof address === "string") throw new Error("Local npm registry has no port");
  if (decodeURIComponent((req.url ?? "").slice(1)) === installPackage) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ name: installPackage, "dist-tags": { latest: "1.0.0" }, versions: {
      "1.0.0": { name: installPackage, version: "1.0.0", bin: { cline: "bin/cline.js" },
        dist: { tarball: `http://127.0.0.1:${address.port}/fixture.tgz` } },
    } }));
  } else if (req.url === "/fixture.tgz") {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(tarball);
  } else { res.writeHead(404); res.end(); }
});
await new Promise<void>((done) => registry.listen(0, "127.0.0.1", done));
const registryAddress = registry.address();
if (!registryAddress || typeof registryAddress === "string") throw new Error("Local npm registry has no port");
const fixture = await launchVerificationServer({ ...process.env, FAKE_CODEX_MODE: "logged-out", OMB_TEST_NPM_REGISTRY_URL: `http://127.0.0.1:${registryAddress.port}/` },
  undefined, undefined, { binaryPath, executablePath }, undefined, undefined, ["opencode", "codex", "qwen"]);
let chrome: ChildProcess | undefined;
const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".woff": "font/woff", ".woff2": "font/woff2",
};
let browserTestVisits = 0;
let fixtureBotId: string | undefined;
const server = createServer(async (req, res) => {
  if (req.url === "/__hattera-cline-auth/approve" && req.method === "POST") {
    await writeFile(join(fixture.info.dataDir, "cline-auth-approved"), "fixture only");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === "/__hattera-browser-test") {
    browserTestVisits++;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end('<!doctype html><title>Hattera browser check</title><h1>Browser check loaded</h1>');
    return;
  }
  if (req.url === "/__hattera-browser-test/status") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ visits: browserTestVisits }));
    return;
  }
  if (/^\/(api|identity|\.well-known)\//.test(req.url ?? "")) {
    const target = new URL(fixture.info.url);
    const proxy = request({ hostname: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    });
    proxy.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end("Fixture unavailable"); });
    req.pipe(proxy);
    return;
  }
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  let file = resolve(dist, `.${pathname}`);
  if (!file.startsWith(dist + sep)) file = resolve(dist, "index.html");
  try { if (!(await stat(file)).isFile()) file = resolve(dist, "index.html"); }
  catch { file = resolve(dist, "index.html"); }
  try {
    res.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream" });
    const contents = await readFile(file);
    res.end(file === resolve(dist, "index.html")
      ? contents.toString("utf8").replace("</body>", '<div role="status" style="position:fixed;bottom:12px;left:12px;z-index:1000;max-width:calc(100vw - 24px);padding:7px 11px;border-radius:8px;background:#17332f;color:white;font:12px system-ui;box-shadow:0 4px 16px #0003;pointer-events:none">Isolated test preview · AI replies are simulated · Real provider installs and sign-in are unavailable here</div></body>')
      : contents);
  } catch { res.writeHead(404); res.end(); }
});

try {
  const base = fixture.info.url;
  const chromeProfile = resolve(fixture.info.dataDir, "browser-cdp");
  await mkdir(chromeProfile, { recursive: true });
  chrome = spawn(executablePath, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
    "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${chromeProfile}`, "about:blank"],
    { stdio: "ignore", windowsHide: true });
  let cdpPort = 0;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { cdpPort = Number((await readFile(resolve(chromeProfile, "DevToolsActivePort"), "utf8")).split("\n")[0]); break; }
    catch { await new Promise((done) => setTimeout(done, 100)); }
  }
  if (!cdpPort) throw new Error("Isolated Chrome did not open a CDP port");
  const json = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method, headers: { origin: base, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(`${method} ${path}: ${JSON.stringify(value)}`);
    return value;
  };
  await json("PATCH", "/api/config", { features: { browser: true }, browserEngine: { attachCdpUrl: String(cdpPort) } });
  const { bots } = await json("GET", "/api/bots");
  if (bots.length !== 1) throw new Error("Expected one fixture bot");
  fixtureBotId = bots[0].id;
  await json("PATCH", `/api/bots/${bots[0].id}`, { browser: true });
  const config = await json("GET", "/api/config");
  if (config.browserEngine?.kind !== "engine") throw new Error(`Browser engine unavailable: ${JSON.stringify(config.browserEngine)}`);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No preview port");
  const previewUrl = `http://127.0.0.1:${address.port}`;
  const smoke = await promisify(execFile)(process.execPath, [resolve(root, "scripts/testing/hattera-browser-smoke.mjs"), previewUrl, executablePath],
    { cwd: root, timeout: 120_000 });
  const smokeResult = JSON.parse(smoke.stdout) as { ok?: boolean; checks?: string[] };
  if (smokeResult.ok !== true || !Array.isArray(smokeResult.checks)) throw new Error(`Browser smoke did not pass: ${smoke.stdout}`);
  const afterSmoke = await json("GET", "/api/instances");
  const openCode = afterSmoke.instances?.find((instance: { instanceId: string }) => instance.instanceId === "opencodeGo");
  const saved = JSON.parse(await readFile(resolve(fixture.info.dataDir, "config.json"), "utf8"));
  if (openCode?.snapshot.state !== "available" || !saved.instances?.opencodeGo?.config?.cli) {
    throw new Error("OpenCode lost its CLI configuration after the browser smoke");
  }
  const clineBinDir = activeEngineBinDir(fixture.info.dataDir, "cline");
  if (!clineBinDir || !existsSync(join(clineBinDir, process.platform === "win32" ? "cline.cmd" : "cline")) || !registryRequests.includes("/fixture.tgz")) {
    throw new Error("Browser install did not download and place the Cline CLI in the isolated tools directory");
  }
  console.log(JSON.stringify({ ok: true, simulatedProviders: true, browserEngine: config.browserEngine.kind,
    checks: smokeResult.checks }, null, 2));
} finally {
  if (fixtureBotId) await closeBrowserSession(binaryPath, {
    ...process.env, HOME: fixture.info.dataDir, USERPROFILE: fixture.info.dataDir,
    AGENT_BROWSER_SESSION: browserSessionId(fixtureBotId, ""),
  }).catch(() => {});
  await waitForExit(chrome, { signal: "SIGTERM" });
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  await fixture.close();
  registry.closeAllConnections();
  await new Promise<void>((done) => registry.close(() => done()));
  if (resolve(installScratch).startsWith(resolve(tmpdir()) + sep)) await rm(installScratch, { recursive: true, force: true });
}
