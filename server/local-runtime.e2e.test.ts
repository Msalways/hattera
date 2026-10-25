import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { verificationServerEnvironment } from "../scripts/control-hattera.ts";
import { freePortBlock } from "./testing/ports.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { launchLocalWeb } from "./web-launcher.ts";
import { findLocalRuntime, readLocalRuntime, localRuntimeMatches } from "./local-runtime.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

it("keeps one runtime across working folders, preserves state through restart and stops through its authenticated API", async () => {
  const home = mkdtempSync(join(tmpdir(), "hattera-launcher-"));
  mkdirSync(join(home, "tmp"));
  const otherCwd = mkdtempSync(join(tmpdir(), "hattera-other-project-"));
  const previousCwd = process.cwd();
  const port = await freePortBlock([0, 1]);
  const environment = verificationServerEnvironment({}, home, port);
  delete environment.OMB_LOOPBACK_TRUST;
  Object.assign(environment, {
    GITHUB_CLIENT_ID: "fixture-client", GITHUB_CLIENT_SECRET: "fixture-client-secret",
    BETTER_AUTH_SECRET: "fixture-secret-that-is-at-least-32-characters-long", GITHUB_OWNER_ID: "12345",
    OMB_PUBLIC_URL: `http://127.0.0.1:${port}`, GITHUB_REDIRECT_URI: `http://127.0.0.1:${port}/identity/callback/github`,
  });
  writeFileSync(join(home, "config.json"), JSON.stringify({ instances: {
    fixture: { driver: "claudeAgent", config: { cli: join(root, "server", "testing", "fake-claude-cli.ts") } },
  } }));
  const entry = process.env.OMB_VERIFY_SERVER_ENTRY ? join(dirname(process.env.OMB_VERIFY_SERVER_ENTRY), "openmausbot.js") : join(root, "server", "hattera.ts");
  const options = { dataDir: home, port, entry, environment };
  let base = `http://127.0.0.1:${port}`;
  const api = async (path: string, body?: object) => {
    const response = await fetch(base + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000) });
    expect(response.status).toBe(200);
    return response.json() as Promise<{ persistent?: boolean }>;
  };
  const stop = async () => {
    const running = await findLocalRuntime(home);
    if (!running) return;
    await fetch(`http://127.0.0.1:${running.port}/api/local-runtime/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pid: running.pid, environmentId: running.environmentId }) });
    await expect.poll(() => readLocalRuntime(home), { timeout: 15_000 }).toBeNull();
  };
  try {
    const first = await launchLocalWeb(options);
    expect(first.reused).toBe(false);
    expect(await localRuntimeMatches(home, port, first.runtime.pid)).toBe(true);
    expect((await api("/api/local-runtime")).persistent).toBe(true);
    // A fresh CLI launch is already the local owner; no pairing code or login
    // cookie is needed to enter the app. Forwarded callers remain untrusted.
    const session = await fetch(base + "/api/auth/session").then(response => response.json()) as {kind:string;trust?:string;scopes:string[]};
    expect(session.scopes).toContain("admin");
    const descriptor = await fetch(base + "/.well-known/openmausbot/environment").then(response => response.json()) as {capabilities:{localCli?:boolean;githubSignIn?:boolean}};
    expect(descriptor.capabilities.localCli).toBe(true);
    expect(descriptor.capabilities.githubSignIn).toBe(true);
    const remote = await fetch(base + "/api/bots", { headers: { "x-forwarded-for": "203.0.113.20" } });
    expect([401, 403]).toContain(remote.status);
    const opened = await fetch(base + "/api/auth/pairing", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scopes: ["client"] }) });
    expect(opened.status).toBe(200);
    const { code } = await opened.json() as {code:string};
    const linked = await fetch(base + "/api/auth/pair", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.20" }, body: JSON.stringify({ code, label: "On-demand colleague browser" }) });
    expect(linked.status).toBe(200);
    const { token } = await linked.json() as {token:string};
    const pairedSession = await fetch(base + "/api/auth/session", { headers: { authorization: `Bearer ${token}`, "x-forwarded-for": "203.0.113.20" } }).then(response => response.json());
    expect(pairedSession).toMatchObject({ kind: "session", scopes: ["client"] });
    const identity = readFileSync(join(home, "environment-id"), "utf8");
    const saved = readFileSync(join(home, "config.json"), "utf8");
    process.chdir(otherCwd);
    const second = await launchLocalWeb({ ...options, port: await freePortBlock([0, 1]) });
    expect(second.reused).toBe(true);
    expect(second.runtime).toEqual(first.runtime);
    expect(existsSync(join(otherCwd, ".openmausbot"))).toBe(false);
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe(saved);
    const denied = await fetch(base + "/api/local-runtime/stop", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.20" }, body: "{}" });
    expect([401, 403]).toContain(denied.status);
    expect(await findLocalRuntime(home)).not.toBeNull();
    const wrongRuntime = await fetch(base + "/api/local-runtime/stop", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pid: first.runtime.pid + 1, environmentId: first.runtime.environmentId }) });
    expect(wrongRuntime.status).toBe(409);
    await stop();
    expect(readFileSync(join(home, "environment-id"), "utf8")).toBe(identity);
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe(saved);
    const restarted = await launchLocalWeb(options);
    expect(restarted.runtime.pid).not.toBe(first.runtime.pid);
    base = `http://127.0.0.1:${restarted.runtime.port}`;
    expect(await localRuntimeMatches(otherCwd, port, restarted.runtime.pid)).toBe(false);
    expect(readFileSync(join(home, "environment-id"), "utf8")).toBe(identity);
  } finally {
    process.chdir(previousCwd);
    await stop();
    await removeTempDir(home);
    await removeTempDir(otherCwd);
  }
}, 180_000);

it.each([false, true])("self-hosting requires a session and ignores CLI URL flags (GitHub: %s)", async github => {
  const home = mkdtempSync(join(tmpdir(), "hattera-selfhost-auth-"));
  mkdirSync(join(home, "tmp"));
  const port = await freePortBlock([0, 1]);
  const base = `http://127.0.0.1:${port}`;
  const environment = verificationServerEnvironment({}, home, port);
  delete environment.OMB_LOOPBACK_TRUST;
  if (github) Object.assign(environment, {
    GITHUB_CLIENT_ID: "fixture-client", GITHUB_CLIENT_SECRET: "fixture-client-secret",
    BETTER_AUTH_SECRET: "fixture-secret-that-is-at-least-32-characters-long", GITHUB_OWNER_ID: "12345",
    OMB_PUBLIC_URL: base, GITHUB_REDIRECT_URI: `${base}/identity/callback/github`,
    // An inherited legacy owner override must not disable self-hosted GitHub.
    OMB_LOOPBACK_TRUST: "owner",
  });
  writeFileSync(join(home, "config.json"), JSON.stringify({ instances: {
    fixture: { driver: "claudeAgent", config: { cli: join(root, "server/testing/fake-claude-cli.ts") } },
  } }));
  const entry = process.env.OMB_VERIFY_SERVER_ENTRY ?? join(root, "server/index.ts");
  const log = join(home, "server.log"), fd = openSync(log, "w");
  const child = spawn(process.execPath, [...(entry.endsWith(".ts") ? ["--experimental-strip-types"] : []), entry], { env: environment, cwd: root, windowsHide: true, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  try {
    await expect.poll(async () => {
      try { return (await fetch(base + "/api/health", { signal: AbortSignal.timeout(2000) })).status; } catch { return 0; }
    }, { timeout: 60_000 }).toBe(200);
    const descriptor = await fetch(base + "/.well-known/openmausbot/environment?cli=1").then(response => response.json()) as {capabilities:{localCli?:boolean;githubSignIn?:boolean}};
    expect(descriptor.capabilities).not.toHaveProperty("localCli");
    expect(descriptor.capabilities.githubSignIn === true).toBe(github);
    const session = await fetch(base + "/api/auth/session?cli=1").then(response => response.json()) as {kind:string;trust?:string;scopes:string[]};
    expect(session).toMatchObject({ kind: "loopback", trust: "service" });
    expect(session.scopes).not.toContain("admin");
    expect((await fetch(base + "/api/config?cli=1")).status).toBe(403);
    expect((await fetch(base + "/api/auth/pairing?cli=1", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(403);
    if (github) {
      const start = await fetch(base + "/identity/start/github", { redirect: "manual" });
      expect(start.status).toBe(303);
      const target = new URL(start.headers.get("location")!);
      expect(target.origin).toBe("https://github.com");
      expect(target.searchParams.get("client_id")).toBe("fixture-client");
      expect((await fetch(base + "/identity/finish", { redirect: "manual" })).status).toBe(403);
    }
  } finally {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  }
}, 120_000);
