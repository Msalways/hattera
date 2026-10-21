import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { verificationServerEnvironment } from "../scripts/control-omb.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

it("reports an unreachable Codex auth host through the real HTTP route without leaking CLI output", async () => {
  const home = mkdtempSync(join(tmpdir(), "hattera-codex-network-"));
  mkdirSync(join(home, "tmp"));
  const port = await freePortBlock([0, 1]);
  const base = `http://127.0.0.1:${port}`;
  writeFileSync(join(home, "config.json"), JSON.stringify({ instances: {
    claude: { driver: "claudeAgent", config: { cli: join(root, "server/testing/fake-claude-cli.ts") } },
    codex: { driver: "codex", config: { cli: join(root, "server/testing/fake-codex-login-cli.ts") } },
  } }));
  const log = openSync(join(home, "server.log"), "w", 0o600);
  const env = verificationServerEnvironment({}, home, port);
  env.OMB_DEVICE_AUTH_FIXTURE = "1";
  env.OMB_DEVICE_AUTH_FIXTURE_NETWORK = "1";
  const child = spawn(process.execPath, ["--experimental-strip-types", join(root, "server/index.ts")], {
    cwd: root, env, stdio: ["ignore", log, log],
  });
  closeSync(log);
  try {
    await expect.poll(async () => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("Isolated server exited");
      return fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1_000) }).then((response) => response.ok).catch(() => false);
    }, { timeout: 30_000 }).toBe(true);
    const response = await fetch(`${base}/api/instances/codex/auth/start`, {
      method: "POST", headers: { origin: base, "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json() as { error?: string; auth?: unknown };
    expect(response.status).toBe(500);
    expect(body.error).toContain("could not reach auth.openai.com from this server");
    expect(JSON.stringify(body)).not.toMatch(/secret-token|deviceauth\/usercode/);
    expect(body).not.toHaveProperty("auth");
  } finally {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  }
}, 45_000);
