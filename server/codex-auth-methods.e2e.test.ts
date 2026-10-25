import { spawn } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { verificationServerEnvironment } from "../scripts/control-hattera.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

it("offers browser SSO and device code for one Codex account, with local callback and flow ownership checks", async () => {
  const home = mkdtempSync(join(tmpdir(), "hattera-codex-methods-"));
  mkdirSync(join(home, "tmp"));
  const port = await freePortBlock([0, 1]);
  const base = `http://127.0.0.1:${port}`;
  writeFileSync(join(home, "config.json"), JSON.stringify({ instances: {
    fixture: { driver: "claudeAgent", config: { cli: join(root, "server/testing/fake-claude-cli.ts") } },
    codex: { driver: "codex", config: { cli: join(root, "server/testing/fake-codex-login-cli.ts") } },
  } }));
  const log = openSync(join(home, "server.log"), "w", 0o600);
  const env = verificationServerEnvironment({}, home, port);
  env.OMB_DEVICE_AUTH_FIXTURE = "1";
  const child = spawn(process.execPath, ["--experimental-strip-types", join(root, "server/index.ts")], {
    cwd: root, env, stdio: ["ignore", log, log],
  });
  closeSync(log);
    const api = async (path: string, body?: object, headers: Record<string, string> = {}) => {
    const response = await fetch(`${base}${path}`, { method: body ? "POST" : "GET", headers: {
      origin: base, "content-type": "application/json", ...headers,
    }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000) });
    return { status: response.status, body: await response.json() as { error?: string; code?: string; token?: string; auth?: { phase: string; flowId: string; authorizationUrl: string; userCode?: string }; instances?: Array<{ instanceId: string; authentication?: { method?: string; methods?: string[] } }> } };
  };
  try {
    await expect.poll(async () => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("Isolated server exited");
      return fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1_000) }).then((response) => response.ok).catch(() => false);
    }, { timeout: 30_000 }).toBe(true);
    const listed = await api("/api/instances");
    expect(listed.body.instances?.find(({ instanceId }) => instanceId === "codex")?.authentication?.methods).toEqual(["device-code", "browser-pkce"]);
    expect(listed.body.instances?.find(({ instanceId }) => instanceId === "codex")?.authentication?.method).toBe("browser-pkce");
    expect((await api("/api/instances/codex/auth/start", { method: "invalid" })).status).toBe(400);
    const invitation = await api("/api/auth/pairing", { scopes: ["admin", "client"] });
    const paired = await api("/api/auth/pair", { code: invitation.body.code, label: "Docker browser fixture" });
    expect(paired.body.token).toBeTruthy();
    const authorization = `Bearer ${paired.body.token}`;
    const proxyHeaders = { host: "remote.example.test", origin: "http://remote.example.test", authorization, "x-forwarded-for": "198.51.100.21" };
    const browser = await api("/api/instances/codex/auth/start", { method: "browser-pkce" }, proxyHeaders);
    expect(browser.status).toBe(200);
    expect(browser.body.auth?.phase).toBe("waiting");
    expect(browser.body.auth?.authorizationUrl).toContain("https://auth.openai.com/oauth/authorize?");
    expect(browser.body.auth?.userCode).toBeUndefined();
    const refusedSwitch = await api("/api/instances/codex/auth/start", { method: "device-code" }, proxyHeaders);
    expect(refusedSwitch.status).toBe(409);
    expect(refusedSwitch.body.error).toContain("Cancel the current sign-in");
    expect((await api("/api/instances/codex/auth/status?flowId=" + browser.body.auth!.flowId, undefined, proxyHeaders)).body.auth?.phase).toBe("waiting");
    const callback = "http://127.0.0.1:1455/auth/callback?code=fixture-code&state=fixture_123";
    for (const invalid of [
      "http://evil.test/auth/callback?code=fixture-code&state=fixture_123",
      callback.replace("fixture_123", "wrong-state"),
      callback + "&state=fixture_123",
      callback.replace("fixture-code", "fixture-code#fragment"),
    ]) {
      expect((await api("/api/instances/codex/auth/complete", { flowId: browser.body.auth!.flowId, callbackUrl: invalid }, proxyHeaders)).status).toBe(400);
    }
    expect((await api("/api/instances/codex/auth/cancel", { flowId: browser.body.auth!.flowId }, proxyHeaders)).status).toBe(200);

    const code = await api("/api/instances/codex/auth/start", { method: "device-code" });
    expect(code.status).toBe(200);
    expect(code.body.auth).toMatchObject({ phase: "waiting", authorizationUrl: "https://auth.openai.com/codex/device", userCode: "TEST-12345" });
    expect((await api("/api/instances/codex/auth/cancel", { flowId: code.body.auth!.flowId })).status).toBe(200);
  } finally {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  }
}, 60_000);
