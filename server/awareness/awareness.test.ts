import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import type { AnyProviderDriver, ModelCatalog, ProviderSnapshot } from "../contracts.ts";
import { createAwarenessRoutes } from "../routes/awareness.ts";
import { PASS } from "../routes/table.ts";
import {
  asRecord, closedWindow, errorRow, finiteNumber, isoOrNull, missingCredential, okRow, openWindow, parseJson,
  signInAgain, type AllowanceCapability, type PlanCredential, type PlanExtra,
} from "./allowance-kit.ts";
import { assembleAwareness, type AwarenessInstanceInput } from "./assemble.ts";
import {
  allowanceRegistry, fetchPlanUsage, fileCredentialReader, planAccountsFromInstances, type PlanFetch,
} from "../plan-usage.ts";

const NOW = 1_800_000_000_000;
const iso = (ms: number) => new Date(ms).toISOString();

const snapshot: ProviderSnapshot = { state: "available", authenticated: true };
const catalog: ModelCatalog = {
  default: "m1",
  options: [
    { id: "m1", label: "M1", contextWindow: 200_000, variants: [{ id: "low", label: "Low" }, { id: "high", label: "High" }] },
    { id: "m2", label: "M2" },
  ],
};

function instance(extra: Partial<AwarenessInstanceInput> = {}): AwarenessInstanceInput {
  return {
    instanceId: "a", driverKind: "x", displayName: "A",
    snapshot, snapshotObservedAt: iso(NOW),
    models: catalog, modelsObservedAt: iso(NOW),
    ...extra,
  };
}

/** A driver that exists only in this test: it reports a 1-hour and a 30-day
 * window. Nothing outside this block knows it. */
const ACME_USAGE_URL = "https://usage.example.invalid/v1";
const acme: AllowanceCapability = {
  id: "acme",
  product: "Acme",
  readCredential: (_account, env): PlanCredential => (env.ACME_TOKEN
    ? { token: env.ACME_TOKEN, accountId: null, expired: false }
    : missingCredential()),
  async fetchUsage(account, credential, deps) {
    const response = await deps.fetch(ACME_USAGE_URL, { headers: { Authorization: `Bearer ${credential.token}` }, signal: AbortSignal.timeout(1000) });
    const body = asRecord(parseJson(await response.text()));
    if (!response.ok || !body) return errorRow(account, signInAgain("Acme"));
    const lines: PlanExtra[] = [];
    for (const [label, used, reset] of [["1 hour", body.hour_used, body.hour_reset], ["30 days", body.month_used, body.month_reset]] as const) {
      const percent = finiteNumber(used);
      if (percent == null) continue;
      const window = openWindow(percent, isoOrNull(reset));
      lines.push({ label, remainingPercent: window.remainingPercent ?? 0, usedPercent: window.usedPercent ?? 0, resetsAt: window.resetsAt });
    }
    return okRow(account, { plan: "Team", fiveHour: closedWindow(), weekly: closedWindow(), extra: lines, models: [] });
  },
};
const acmeDriver = {
  driverKind: "acmeAgent",
  metadata: { displayName: "Acme" },
  allowance: acme,
} as unknown as AnyProviderDriver;
const plainDriver = { driverKind: "plainAgent", metadata: { displayName: "Plain" } } as unknown as AnyProviderDriver;

describe("awareness assembly", () => {
  it("reports availability, auth, models and context window with source and time", () => {
    const report = assembleAwareness({ instances: [instance()], now: NOW });
    const row = report.instances[0]!;
    expect(row.availability).toEqual({ status: "known", value: "available", source: "provider-snapshot", observedAt: iso(NOW), stale: false });
    expect(row.authenticated).toMatchObject({ status: "known", value: true });
    expect(row.models[0]!.contextWindow).toMatchObject({ status: "known", value: 200_000, source: "driver-model-catalog" });
    expect(row.models[0]!.reasoning).toMatchObject({ status: "known", value: ["low", "high"] });
    expect(row.defaultModel).toMatchObject({ status: "known", value: "m1" });
  });

  it("marks what nobody reported as unknown, never a default", () => {
    const row = assembleAwareness({ instances: [instance()], now: NOW }).instances[0]!;
    const bare = row.models[1]!;
    expect(bare.contextWindow.status).toBe("unknown");
    expect(bare.modalities.status).toBe("unknown");
    expect(bare.reasoning.status).toBe("unknown");
    expect(bare.cost.status).toBe("unknown");
    // modalities and cost are read when a driver supplies them, with no change here
    const rich = assembleAwareness({
      instances: [instance({ models: { default: "m1", options: [{ id: "m1", label: "M1", modalities: ["text", "image"], cost: { class: "paid" } } as never] } })],
      now: NOW,
    }).instances[0]!.models[0]!;
    expect(rich.modalities).toMatchObject({ status: "known", value: ["text", "image"] });
    expect(rich.cost).toMatchObject({ status: "known", value: { class: "paid" } });
  });

  it("an instance never read is unknown on every fact, with source none", () => {
    const row = assembleAwareness({ instances: [{ instanceId: "z", driverKind: "x", displayName: "Z" }], now: NOW }).instances[0]!;
    expect(row.availability).toEqual({ status: "unknown", source: "none", observedAt: null });
    expect(row.authenticated.status).toBe("unknown");
    expect(row.models).toEqual([]);
    expect(row.allowance).toEqual({ status: "unknown", source: "none", observedAt: null });
  });

  it("flags a fact older than the freshness window as stale", () => {
    const old = iso(NOW - 11 * 60_000);
    const row = assembleAwareness({ instances: [instance({ snapshotObservedAt: old, modelsObservedAt: old })], now: NOW }).instances[0]!;
    expect(row.availability).toMatchObject({ status: "known", stale: true, observedAt: old });
    expect(row.models[0]!.contextWindow).toMatchObject({ stale: true });
    const fresh = assembleAwareness({ instances: [instance({ snapshotObservedAt: old })], now: NOW, staleAfterMs: 20 * 60_000 }).instances[0]!;
    expect(fresh.availability).toMatchObject({ stale: false });
  });

  it("a driver without the capability has unknown allowance; a failed read says why", () => {
    expect(allowanceRegistry([plainDriver]).size).toBe(0);
    expect(planAccountsFromInstances({ p: { driver: "plainAgent" } }, allowanceRegistry([plainDriver]))).toEqual([]);
    const failed = assembleAwareness({
      instances: [instance({
        allowance: errorRow({ id: "a", name: "A", driver: "acme", environment: {} }, signInAgain("Acme")),
        allowanceObservedAt: iso(NOW),
      })],
      now: NOW,
    }).instances[0]!;
    expect(failed.allowance).toEqual({ status: "unknown", source: "allowance-report", observedAt: iso(NOW), reason: "Sign in again in Acme" });
  });
});

describe("a driver gaining allowance reporting", () => {
  const registry = allowanceRegistry([acmeDriver, plainDriver]);
  const instances = { acme: { driver: "acmeAgent", environment: { ACME_TOKEN: "tok" } }, plain: { driver: "plainAgent" } };

  it("is discovered from its own capability, with no edit to plan-usage", async () => {
    const accounts = planAccountsFromInstances(instances, registry);
    expect(accounts).toEqual([{ id: "acme", name: "Acme", driver: "acme", environment: { ACME_TOKEN: "tok" } }]);
    const seen: string[] = [];
    const fetch: PlanFetch = async (url, init) => {
      seen.push(`${url}|${(init?.headers as Record<string, string>).Authorization}`);
      return { ok: true, status: 200, text: async () => JSON.stringify({ hour_used: 25, hour_reset: iso(NOW + 3_600_000), month_used: 60 }) };
    };
    const report = await fetchPlanUsage(accounts, {
      fetch, capabilities: registry, now: () => NOW,
      credentials: fileCredentialReader({ readText: () => null, env: {}, now: () => NOW }, registry),
    });
    expect(seen).toEqual([`${ACME_USAGE_URL}|Bearer tok`]);
    const row = report.providers[0]!;
    expect(row).toMatchObject({ ok: true, driver: "acme", plan: "Team" });
    expect(JSON.stringify(report)).not.toContain("tok\"");

    const view = assembleAwareness({
      instances: [instance({ instanceId: "acme", driverKind: "acmeAgent", allowance: row, allowanceObservedAt: report.fetchedAt })],
      now: NOW,
    }).instances[0]!;
    expect(view.allowance).toMatchObject({ status: "known", source: "allowance-report" });
    const windows = view.allowance.status === "known" ? view.allowance.value.windows : [];
    expect(windows.map((w) => [w.label, w.scope, w.usedPercent, w.remainingPercent])).toEqual([
      ["1 hour", "extra", 25, 75],
      ["30 days", "extra", 60, 40],
    ]);
  });

  it("a driver id nobody registered yields an error row, never a throw", async () => {
    const report = await fetchPlanUsage(
      [{ id: "ghost", name: "Ghost", driver: "no-such-driver", environment: {} }],
      { fetch: async () => { throw new Error("must not be called"); }, credentials: { read: async () => ({ token: "t", accountId: null, expired: false }) }, capabilities: registry },
    );
    expect(report.providers[0]).toMatchObject({ ok: false, error: "Could not reach Ghost" });
  });

  it("an unconfigured credential reads as sign-in, not a crash", async () => {
    const accounts = planAccountsFromInstances({ acme: { driver: "acmeAgent" } }, registry);
    const report = await fetchPlanUsage(accounts, {
      fetch: async () => { throw new Error("must not be called"); },
      capabilities: registry, now: () => NOW,
      credentials: fileCredentialReader({ readText: () => null, env: {}, now: () => NOW }, registry),
    });
    expect(report.providers[0]).toMatchObject({ ok: false, error: "Sign in again in Acme" });
  });
});

describe("GET /api/awareness", () => {
  function call(handler: ReturnType<typeof createAwarenessRoutes>, method: string, path: string) {
    let status = 0;
    let body: unknown;
    const headers: Record<string, string> = {};
    const res = { setHeader: (k: string, v: string) => { headers[k] = v; } } as unknown as ServerResponse;
    const url = new URL(path, "http://localhost");
    const result = handler({
      req: {} as IncomingMessage, res, url, path: url.pathname, method,
      auth: { kind: "loopback", scopes: ["admin"] } as never,
      json: ((_res: unknown, code: number, payload: unknown) => { status = code; body = payload; }) as never,
      readBody: (async () => ({})) as never,
    });
    return result.then((out) => ({ out, status, body, headers }));
  }
  const deps = {
    describe: async () => [{ instanceId: "a", driverKind: "x", displayName: "A", snapshot, models: catalog }],
    allowance: async () => ({ fetchedAt: iso(NOW), providers: [] }),
    now: () => NOW,
  };

  it("answers only its own path and method", async () => {
    const handler = createAwarenessRoutes(deps);
    expect((await call(handler, "POST", "/api/awareness")).out).toBe(PASS);
    expect((await call(handler, "GET", "/api/awareness/other")).out).toBe(PASS);
    expect((await call(handler, "GET", "/api/plan-usage")).out).toBe(PASS);
  });

  it("returns the assembled view, uncached, and survives an allowance failure", async () => {
    const handler = createAwarenessRoutes({ ...deps, allowance: async () => { throw new Error("boom"); } });
    const { status, body, headers } = await call(handler, "GET", "/api/awareness");
    expect(status).toBe(200);
    expect(headers["cache-control"]).toBe("no-store");
    const report = body as { instances: Array<{ instanceId: string; allowance: { status: string } }> };
    expect(report.instances[0]).toMatchObject({ instanceId: "a", allowance: { status: "unknown" } });
  });

  it("passes refresh through to the allowance read", async () => {
    const asked: boolean[] = [];
    const handler = createAwarenessRoutes({ ...deps, allowance: async (refresh) => { asked.push(refresh); return { fetchedAt: iso(NOW), providers: [] }; } });
    await call(handler, "GET", "/api/awareness");
    await call(handler, "GET", "/api/awareness?refresh=1");
    expect(asked).toEqual([false, true]);
  });
});
