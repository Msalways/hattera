import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";
import { fixtureApi } from "../scripts/testing/preview-fixture.ts";

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
