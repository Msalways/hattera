import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { request } from "node:http";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-hattera.ts";
import { fixtureApi } from "../scripts/testing/preview-fixture.ts";

it("removes and restores engines through isolated HTTP routes, protecting accounts and configured work", async () => {
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CODEX_MODE: "logged-out" }, undefined, undefined, undefined, undefined, undefined, ["cline", "codex"]);
  const api = fixtureApi(fixture.info.url);
  try {
    const configPath = join(fixture.info.dataDir, "config.json");
    const originalConfig = readFileSync(configPath, "utf8");
    const accountPath = join(fixture.info.dataDir, "keep-private-account.json"); writeFileSync(accountPath, "keep-private");
    const bots = (await api("GET", "/api/bots")).bots;
    const post = async (path: string, body: unknown, status: number) => {
      const response = await fetch(`${fixture.info.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json() as { error: string; instances: Array<{ instanceId: string; models: { default: string } }> };
      expect(response.status, JSON.stringify(result)).toBe(status); return result;
    };
    await post("/api/instances/cline/uninstall", {}, 400);
    await post("/api/instances/bedrock/uninstall", { confirm: true }, 404);
    await post("/api/instances/cline/restore-runtime", {}, 400);
    // The starter and server default use Claude, so removing it must be blocked.
    await post("/api/instances/claude/uninstall", { confirm: true }, 409);
    const remote = await fetch(`${fixture.info.url}/api/instances/cline/uninstall`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" }, body: JSON.stringify({ confirm: true }) });
    expect([401, 403]).toContain(remote.status);
    const removed = await post("/api/instances/cline/uninstall", { confirm: true }, 200);
    expect(removed.instances.find((item: { instanceId: string }) => item.instanceId === "cline")).toMatchObject({ snapshot: { state: "unavailable" }, models: { options: [] }, runtimeRemoval: { removed: true } });
    expect(existsSync(join(fixture.info.dataDir, "tools", "removed-engines", "cline.json"))).toBe(true);
    const restored = await post("/api/instances/cline/restore-runtime", {}, 200);
    const cline = restored.instances.find((item: { instanceId: string }) => item.instanceId === "cline");
    if (!cline) throw new Error("Cline disappeared after restore");
    expect(cline).toMatchObject({ snapshot: { state: "available" }, runtimeRemoval: { removed: false } });
    expect(readFileSync(configPath, "utf8")).toBe(originalConfig);
    expect(readFileSync(accountPath, "utf8")).toBe("keep-private");
    expect((await api("GET", "/api/bots")).bots).toEqual(bots);
    // A thread override is a dependency even when the bot default uses Claude.
    await api("PATCH", `/api/bots/${bots[0].id}/tasks/${bots[0].threadId}`, { modelSelection: { instanceId: "cline", model: cline.models.default } });
    expect((await post("/api/instances/cline/uninstall", { confirm: true }, 409)).error).toContain(bots[0].name);
    await api("PATCH", `/api/bots/${bots[0].id}/tasks/${bots[0].threadId}`, { modelSelection: bots[0].modelSelection });
    // Shared Codex/ChatGPT accounts are disabled and restored together.
    // A slow sign-in request must not start an old CLI after removal finishes.
    const authBody = JSON.stringify({ method: "device-code" });
    const pendingAuth = request(`${fixture.info.url}/api/instances/codex/auth/start`, { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(authBody) } });
    const authResult = new Promise<number | undefined>((resolve, reject) => {
      pendingAuth.once("error", reject);
      pendingAuth.once("response", response => { response.resume(); resolve(response.statusCode); });
    });
    pendingAuth.write(authBody.slice(0, 1));
    await new Promise(resolve => setTimeout(resolve, 100));
    const aliases = await post("/api/instances/codex/uninstall", { confirm: true }, 200);
    pendingAuth.end(authBody.slice(1));
    expect(await authResult).toBe(409);
    for (const id of ["codex", "chatgpt"]) expect(aliases.instances.find((item: { instanceId: string }) => item.instanceId === id)).toMatchObject({ runtimeRemoval: { removed: true }, models: { options: [] } });
    await post("/api/instances/chatgpt/restore-runtime", {}, 200);
  } finally { await fixture.close(); }
}, 120_000);
