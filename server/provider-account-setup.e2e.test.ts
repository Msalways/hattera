import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-hattera.ts";
import { fixtureApi } from "../scripts/testing/preview-fixture.ts";
import { PROFILE_DRIVERS } from "./provider-profiles.ts";

it("saves hosted provider accounts through the HTTP API without returning keys or requiring a terminal", async () => {
  const fixture = await launchVerificationServer(undefined, undefined, undefined, undefined, undefined, undefined, ["droid", "qwen"]);
  const api = fixtureApi(fixture.info.url);
  try {
    const initial = await api("GET", "/api/instances");
    expect(initial.instances.find((item: { instanceId: string }) => item.instanceId === "bedrock")).toMatchObject({ displayName: "Amazon Bedrock", snapshot: { state: "unavailable" } });
    const response = await api("POST", "/api/instances/bedrock/account", { key: "bedrock-account-fixture-private", region: "us-east-1", model: "us.anthropic.fixture-v1:0" });
    expect(response.instances.find((item: { instanceId: string }) => item.instanceId === "bedrock")).toMatchObject({ access: "api", snapshot: { state: "available" }, models: { options: [{ id: "us.anthropic.fixture-v1:0" }] } });
    await api("POST", "/api/instances/droid/account", { key: "factory-account-fixture-private" });
    const disk = JSON.parse(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8"));
    expect(disk.instances.droid.environment.FACTORY_API_KEY).toBe("factory-account-fixture-private");
    expect(disk.instances.bedrock.config.key).toBe("bedrock-account-fixture-private");
    const publicData = JSON.stringify([response, await api("GET", "/api/instances"), await api("GET", "/api/config")]);
    expect(publicData).not.toContain("bedrock-account-fixture-private");
    expect(publicData).not.toContain("factory-account-fixture-private");
    const denied = await fetch(`${fixture.info.url}/api/instances/bedrock/account`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" }, body: JSON.stringify({ key: "must-not-save", region: "us-east-1", model: "fixture" }) });
    expect([401, 403]).toContain(denied.status);
    expect(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8")).not.toContain("must-not-save");
  } finally { await fixture.close(); }
}, 90_000);

it("creates, configures, renames and removes independent native and API accounts through real HTTP", async () => {
  const fixture = await launchVerificationServer(undefined, undefined, undefined, undefined, undefined, undefined, ["droid", "qwen", "grok", "kimi", "gemini", "grok-api", "antigravity"]);
  const api = fixtureApi(fixture.info.url);
  const path = join(fixture.info.dataDir, "config.json");
  const disk = () => JSON.parse(readFileSync(path, "utf8"));
  try {
    const forbidden = await fetch(`${fixture.info.url}/api/instances/accounts`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.8" }, body: JSON.stringify({ displayName: "Forbidden", sourceInstanceId: "bedrock" }) });
    expect([401, 403]).toContain(forbidden.status);
    for (const source of ["bedrock", "mistral", "droid", "qwen", "opencodeGo", "pi"]) {
      const added = await api("POST", "/api/instances/accounts", { sourceInstanceId: source, displayName: `${source} work` });
      const id = added.instanceId;
      expect(id).toMatch(/^account-/);
      expect(added.instances.find((entry: { instanceId: string }) => entry.instanceId === id)).toMatchObject({
        displayName: `${source} work`, accountProfile: { isolated: true, removable: true, canAdd: true },
      });
      expect(disk().instances[id].environment).toBeUndefined();
      const setup = source === "bedrock" ? { key: "profile-secret", region: "eu-west-1", model: "fixture-model" }
        : ["mistral", "droid"].includes(source) ? { key: "profile-secret" }
        : { key: "profile-secret", url: "https://models.example.test/v1", model: "fixture-model" };
      const configured = await api("POST", `/api/instances/${id}/account`, setup);
      expect(JSON.stringify(configured)).not.toContain("profile-secret");
      expect(JSON.stringify(await api("GET", "/api/config"))).not.toContain("profile-secret");
      if (source === "bedrock") expect(disk().instances[id].config).toMatchObject({ catalog: "bedrock", url: "https://bedrock-runtime.eu-west-1.amazonaws.com", key: "profile-secret" });
      if (source === "bedrock") {
        const created = await api("POST", "/api/bots", { name: "Assigned account fixture", modelSelection: { instanceId: id, model: "fixture-model" } });
        const removal = await fetch(`${fixture.info.url}/api/instances/${id}`, { method: "DELETE" });
        expect(removal.status).toBe(409);
        expect(disk().instances[id]).toBeDefined();
        await api("DELETE", `/api/bots/${created.bot.id}`);
      }
      if (source === "droid") expect(disk().instances[id].environment).toEqual({ FACTORY_API_KEY: "profile-secret" });
      await api("PATCH", `/api/instances/${id}`, { displayName: `${source} renamed` });
      expect(disk().instances[id].displayName).toBe(`${source} renamed`);
      await api("DELETE", `/api/instances/${id}`);
      expect(disk().instances[id]).toBeUndefined();
    }
    expect((await api("GET", "/api/instances")).instances.some((entry: { displayName: string }) => entry.displayName === "Forbidden")).toBe(false);
    // Exercise the same HTTP lifecycle for every remaining registered
    // account family, including those requiring the person's native login.
    const candidates = (await api("GET", "/api/instances")).instances;
    const sources = new Map<string, string>();
    for (const entry of candidates) if (entry.accountProfile?.canAdd) sources.set(entry.driverKind, entry.instanceId);
    expect([...sources.keys()].sort()).toEqual([...PROFILE_DRIVERS].sort());
    for (const [driver, sourceInstanceId] of sources) {
      const created = await api("POST", "/api/instances/accounts", { sourceInstanceId, displayName: `${driver} isolated` });
      expect(created.instances.find((entry: { instanceId: string }) => entry.instanceId === created.instanceId)).toMatchObject({ driverKind: driver, accountProfile: { isolated: true, removable: true } });
      expect(disk().instances[created.instanceId].environment).toBeUndefined();
      await api("PATCH", `/api/instances/${created.instanceId}`, { displayName: `${driver} renamed` });
      expect(disk().instances[created.instanceId].displayName).toBe(`${driver} renamed`);
      await api("DELETE", `/api/instances/${created.instanceId}`);
      expect(disk().instances[created.instanceId]).toBeUndefined();
    }
  } finally { await fixture.close(); }
}, 180_000);
