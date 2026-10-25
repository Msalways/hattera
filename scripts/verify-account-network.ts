// Isolated HTTP integration. Optional --live-network obtains an official
// Tailscale sign-in challenge in a new app identity; it never authorizes an account.
import assert from "node:assert/strict";
import { launchVerificationServer } from "./control-hattera.ts";
import type { AccountUsageReport } from "../server/account-usage.ts";
import type { PrivateNetworkState } from "../shared/private-network.ts";

const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, ["codex", "opencode", "qwen"]);
const base = fixture.info.url;
const checks: string[] = [];
const api = async <T>(path: string, body?: unknown): Promise<T> => {
  const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { origin: base, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(40_000) });
  assert.equal(response.status, 200, `${path} returned ${response.status}`);
  return response.json() as Promise<T>;
};

try {
  const instances = await api<{ instances: Array<{ instanceId: string }> }>("/api/instances");
  let usage = await api<AccountUsageReport>("/api/plan-usage");
  const reportingDeadline = Date.now() + 40_000;
  while (usage.refreshing && Date.now() < reportingDeadline) {
    await new Promise(resolve => setTimeout(resolve, 500));
    usage = await api<AccountUsageReport>("/api/plan-usage");
  }
  assert.equal(usage.refreshing, false, "Account refresh did not settle");
  for (const instance of instances.instances) assert.ok(usage.providers.some(row => row.id === instance.instanceId), `Usage omitted ${instance.instanceId}`);
  assert.ok(usage.providers.some(row => row.id === "opencodeGo"));
  const native = usage.providers.find(row => row.id === "codex")!;
  assert.equal(native.reporting.source, "Codex app-server");
  assert.ok(native.reporting.metrics.some(row => row.label === "8-hour" && row.used === 25));
  assert.ok(native.reporting.metrics.some(row => row.id === "activity:lifetimeTokens" && row.used === 12345));
  checks.push("all-configured-account-coverage", "native-codex-account-reporting");

  for (const path of ["/api/private-network", "/api/plan-usage"]) {
    const response = await fetch(base + path, { headers: { host: "hattera.tailnet", "x-forwarded-proto": "http", "x-forwarded-for": "100.90.1.2" } });
    assert.ok(response.status === 401 || response.status === 403, `${path} trusted a forwarded peer as local owner`);
  }
  checks.push("remote-account-and-network-access-denied");

  const pairing = await api<{ code: string }>("/api/auth/pairing", { label: "Isolated scoped client", scopes: ["client"] });
  const paired = await api<{ token: string }>("/api/auth/pair", { code: pairing.code, label: "Isolated client" });
  assert.ok(paired.token);
  for (const [path, method] of [["/api/private-network", "GET"], ["/api/private-network/connect", "POST"], ["/api/plan-usage", "GET"]]) {
    const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${paired.token}`, "content-type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) });
    assert.equal(response.status, 403, `Scoped client could access ${path}`);
  }
  checks.push("scoped-client-cannot-manage-network-or-read-account-allowances");

  const network = await api<PrivateNetworkState>("/api/private-network");
  assert.equal(network.enabled, false);
  assert.equal(network.state, "disconnected");
  checks.push("private-network-disabled-by-default");
  if (process.argv.includes("--live-network")) {
    assert.equal(network.available, true, "Build the bundled helper with pnpm build:network --current first");
    await api<PrivateNetworkState>("/api/private-network/connect", {});
    const deadline = Date.now() + 45_000;
    let state = await api<PrivateNetworkState>("/api/private-network");
    while (!state.authorizationUrl && Date.now() < deadline && state.state !== "error") {
      await new Promise(resolve => setTimeout(resolve, 1000));
      state = await api<PrivateNetworkState>("/api/private-network");
    }
    assert.equal(new URL(state.authorizationUrl ?? "https://invalid.example").hostname, "login.tailscale.com", state.message ?? "No official sign-in challenge");
    assert.notEqual(state.state, "connected", "A fresh fixture unexpectedly inherited an account");
    const disconnected = await api<PrivateNetworkState>("/api/private-network/disconnect", {});
    assert.equal(disconnected.enabled, false);
    checks.push("fresh-bundled-network-official-browser-challenge", "network-disconnect-without-account-authorization");
  }
  console.log(JSON.stringify({ ok: true, simulatedProviders: true, accountAuthorized: false, checks }, null, 2));
} finally { await fixture.close(); }
