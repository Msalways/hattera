import { afterEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_REPORTING, AccountUsageCollector, openRouterMetrics } from "./account-usage.ts";
import { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";
import { CLAUDE_ACCOUNT_ENV_KEYS } from "./drivers/claude.ts";
import { clearObservedMetrics, codexMetrics, observeRateHeaders } from "./account-metrics.ts";
import type { ProviderInstance } from "./contracts.ts";

afterEach(() => { clearObservedMetrics(); vi.unstubAllEnvs(); });

describe("account reporting coverage", () => {
  it("never substitutes the server's OpenRouter key for an explicitly empty account key", async () => {
    vi.stubEnv("OPENAI_COMPAT_API_KEY", "other-account-secret");
    const request = vi.fn(async () => { throw new Error("Must not query another account"); });
    const report = await new AccountUsageCollector({ fetch: request }).load({ private: {
      driver: "openai-compat", config: { url: "https://openrouter.ai/api/v1", key: "" }, environment: { OPENAI_COMPAT_API_KEY: "" },
    } });
    expect(request).not.toHaveBeenCalled();
    expect(report.providers[0].reporting.status).toBe("sign-in-required");
    expect(JSON.stringify(report)).not.toContain("other-account-secret");
  });
  it("has an explicit reporting result for every registered engine and custom routes", async () => {
    const instances = Object.fromEntries(BUILT_IN_DRIVERS.map(driver => {
      expect(ACCOUNT_REPORTING[driver.driverKind], driver.driverKind).toBeDefined();
      return [driver.driverKind, { driver: driver.driverKind, enabled: false }];
    }));
    instances.future = { driver: "future-engine", enabled: false };
    const report = await new AccountUsageCollector().load(instances);
    expect(report.providers).toHaveLength(BUILT_IN_DRIVERS.length + 1);
    expect(report.providers.every(row => row.reporting.status === "unavailable" && row.reporting.metrics.length === 0)).toBe(true);
    expect(JSON.stringify(report)).not.toContain('"remaining":100');
  });

  it("keeps native quota durations, named buckets, unknown values and zero distinct", () => {
    const rows = codexMetrics({ rateLimitsByLimitId: {
      fast: { limitName: "Fast model", primary: { usedPercent: 0, windowDurationMins: 480, resetsAt: 1_900_000_000 }, secondary: { windowDurationMins: 10080 } },
      other: { primary: { usedPercent: 31, windowDurationMins: 15 } },
    } });
    expect(rows[0]).toMatchObject({ label: "8-hour", used: 0, remaining: 100, windowSeconds: 28800, scope: "Fast model" });
    expect(rows[1]).toMatchObject({ used: null, remaining: null, label: "7-day" });
    expect(rows[2]).toMatchObject({ label: "15-minute", used: 31 });
  });

  it("keeps multiple enabled accounts for every engine distinct without making inference probes", async () => {
    const legacy = async (accounts: Array<{ id: string; name: string; driver: string }>) => ({ fetchedAt: new Date().toISOString(), providers: accounts.map(account => ({
      ...account, plan: null, ok: false, error: "Sign in to this fixture", fiveHour: { available: false, remainingPercent: null, usedPercent: null, resetsAt: null },
      weekly: { available: false, remainingPercent: null, usedPercent: null, resetsAt: null }, extra: [], models: [],
    })) });
    const instances = Object.fromEntries(BUILT_IN_DRIVERS.flatMap(driver => ["personal", "work"].map(name => [`${driver.driverKind}-${name}`, {
      driver: driver.driverKind, displayName: `${driver.metadata.displayName} ${name}`, environment: { HOME: `${process.cwd()}/.omb-scratch/nonexistent-account-${name}`, USERPROFILE: `${process.cwd()}/.omb-scratch/nonexistent-account-${name}` },
    }])));
    const collector = new AccountUsageCollector({ legacy, fetch: async () => { throw new Error("Unexpected reporting network request"); } });
    const report = await collector.load(instances);
    expect(new Set(report.providers.map(row => row.id)).size).toBe(BUILT_IN_DRIVERS.length * 2);
    for (const [id, entry] of Object.entries(instances)) expect(report.providers.find(row => row.id === id)).toMatchObject({ enabled: true, name: entry.displayName, reporting: { status: expect.any(String), metrics: [] } });
  });

  it("never reads another stored Claude subscription for an explicit billing route", async () => {
    let calls = 0;
    const collector = new AccountUsageCollector({ legacy: async () => { calls++; throw new Error("Should not read stored credentials"); } });
    const report = await collector.load({ external: { driver: "claudeAgent", environment: { ANTHROPIC_API_KEY: "fixture-secret", ANTHROPIC_BASE_URL: "https://gateway.invalid" } } });
    expect(calls).toBe(0);
    expect(report.providers[0].reporting).toMatchObject({ status: "not-supported", dashboardUrl: null, metrics: [] });
    expect(JSON.stringify(report)).not.toContain("fixture-secret");
  });

  it("honors the native Claude environment when an ambient OAuth token owns the connection", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fixture-ambient-token");
    let reads = 0;
    const collector = new AccountUsageCollector({ legacy: async () => { reads++; throw new Error("Stored subscription must not be queried"); } });
    const report = await collector.load({ own: { driver: "claudeAgent" } });
    expect(reads).toBe(0);
    expect(report.providers[0].reporting.metrics).toEqual([]);
    expect(JSON.stringify(report)).not.toContain("fixture-ambient-token");
  });

  it("drops a previous subscription snapshot when the same instance changes its effective billing route", async () => {
    for (const key of CLAUDE_ACCOUNT_ENV_KEYS) vi.stubEnv(key, "");
    let now = Date.now();
    const window = { available: true, remainingPercent: 90, usedPercent: 10, resetsAt: null };
    const collector = new AccountUsageCollector({ now: () => now, legacy: async () => ({ fetchedAt: new Date().toISOString(), providers: [{
      id: "one", name: "One", driver: "claude", plan: null, ok: true, error: null, fiveHour: window, weekly: window, extra: [], models: [],
    }] }) });
    const entries = { one: { driver: "claudeAgent", environment: { HOME: `${process.cwd()}/.omb-scratch/no-account-settings` } } };
    expect((await collector.load(entries)).providers[0].reporting.metrics.length).toBeGreaterThan(0);
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fixture-different-account");
    now += 6000;
    expect((await collector.load(entries, true)).providers[0].reporting).toMatchObject({ status: "not-supported", metrics: [] });
  });

  it("records real response headers without guessing request windows or making a request", async () => {
    const now = 1_800_000_000_000;
    observeRateHeaders("groq-one", "model", new Headers({ "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "2m30s" }), now);
    const report = await new AccountUsageCollector({ now: () => now }).load({ "groq-one": { driver: "groq" } });
    expect(report.providers[0].reporting).toMatchObject({ status: "partial", metrics: [expect.objectContaining({ used: 100, remaining: 0, limit: 100, windowSeconds: null, resetsAt: new Date(now + 150_000).toISOString() })] });
  });

  it("deduplicates concurrent refreshes, retains a stale success and isolates account edits", async () => {
    let now = 1_800_000_000_000, calls = 0, fail = false;
    const collector = new AccountUsageCollector({ now: () => now, instance: () => ({ accountUsage: async () => {
      calls++;
      if (fail) throw new Error("upstream secret");
      return { metrics: codexMetrics({ rateLimits: { primary: { usedPercent: 20, windowDurationMins: 300 } } }), source: "Native test protocol" };
    } }) as unknown as ProviderInstance });
    const configs = { one: { driver: "codex", environment: { CODEX_HOME: "fixture-only" } } };
    await Promise.all([collector.load(configs), collector.load(configs)]);
    expect(calls).toBe(1);
    now += 60_000; fail = true;
    const stale = (await collector.load(configs)).providers[0];
    expect(stale.reporting.status).toBe("stale");
    expect(stale.reporting.metrics[0].used).toBe(20);
    expect(JSON.stringify(stale)).not.toContain("upstream secret");
    const changed = (await collector.load({ one: { driver: "codex", environment: { CODEX_HOME: "another-fixture" } } })).providers[0];
    expect(changed.reporting.metrics).toEqual([]);
  });

  it("reads OpenRouter only at its pinned host and never leaks the key", async () => {
    let calls = 0;
    const collector = new AccountUsageCollector({ fetch: async (url, init) => {
      calls++;
      expect(url).toBe("https://openrouter.ai/api/v1/key");
      expect(init?.redirect).toBe("error");
      return new Response(JSON.stringify({ data: { usage: 2, limit: 10, limit_remaining: 8, usage_daily: 0 } }));
    } });
    const report = await collector.load({ router: { driver: "openai-compat", config: { url: "https://openrouter.ai/api/v1", key: "fixture-secret" } }, custom: { driver: "openai-compat", config: { url: "https://openrouter.ai.evil.invalid/api/v1", key: "other-secret" } } });
    expect(calls).toBe(1);
    expect(report.providers[0].reporting.metrics[0]).toMatchObject({ unit: "USD", used: 2, remaining: 8 });
    expect(JSON.stringify(report)).not.toMatch(/fixture-secret|other-secret/);
    expect(openRouterMetrics({ data: { limit: null, usage_daily: 0 } })).toEqual([expect.objectContaining({ id: "usage_daily", used: 0, limit: null, remaining: null })]);
    expect(openRouterMetrics({ data: { budgets: [], effective_budget: { scope: "member", limit_usd: 50, remaining_usd: 0 } } })).toEqual([expect.objectContaining({ scope: "member", limit: 50, remaining: 0 })]);
    const resetting = openRouterMetrics({ data: { usage: 1000, limit: 10, limit_remaining: 7, limit_reset: "weekly", byok_usage: 4 } });
    expect(resetting[0]).toMatchObject({ used: 3, remaining: 7, limit: 10, windowSeconds: 604800 });
    expect(resetting).toEqual(expect.arrayContaining([expect.objectContaining({ id: "usage", used: 1000, limit: null }), expect.objectContaining({ id: "byok_usage", used: 4 })]));
  });

  it("does not repopulate a previous account snapshot after sign-out during a refresh", async () => {
    let finish!: (value: { metrics: ReturnType<typeof codexMetrics>; source: string }) => void;
    let started!: () => void;
    const whenStarted = new Promise<void>(resolve => { started = resolve; });
    const collector = new AccountUsageCollector({ instance: () => ({ accountUsage: () => new Promise(resolve => { finish = resolve; started(); }) }) as ProviderInstance });
    const pending = collector.load({ personal: { driver: "codex" } });
    await whenStarted;
    collector.invalidate();
    finish({ metrics: codexMetrics({ rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300 } } }), source: "Old account" });
    expect((await pending).providers[0].reporting.metrics).toEqual([]);
  });

  it("returns immediately while a slow native account refresh runs and serializes native probes", async () => {
    let active = 0, maximum = 0;
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const collector = new AccountUsageCollector({ instance: () => ({ accountUsage: async () => {
      active++; maximum = Math.max(maximum, active);
      await gate; active--;
      return { metrics: [], source: "Native account" };
    } }) as unknown as ProviderInstance });
    const instances = { one: { driver: "codex" }, two: { driver: "codex" } };
    const immediate = await collector.load(instances, false, true);
    expect(immediate.refreshing).toBe(true);
    expect(immediate.providers).toHaveLength(2);
    finish();
    await collector.load(instances);
    expect(maximum).toBe(1);
  });

  it("does not serialize HTTP-only snapshots behind native process probes or defer them during inference", async () => {
    let active = 0, peak = 0;
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const collector = new AccountUsageCollector({ nativeBusy: () => true, instance: () => ({
      accountUsageTransport: "http", displayName: "Same account",
      async accountUsage(this: { displayName: string }) {
        expect(this.displayName).toBe("Same account");
        active++; peak = Math.max(peak, active);
        await gate; active--;
        return { metrics: [], source: "HTTP account endpoint" };
      },
    }) as unknown as ProviderInstance });
    const pending = collector.load({ one: { driver: "minimax" }, two: { driver: "minimax" } });
    await Promise.resolve();
    expect(peak).toBe(2);
    finish();
    await pending;
  });

  it("keeps independently supplied rate windows and leaves unspecified units unknown", async () => {
    observeRateHeaders("api", "model", new Headers({
      "x-ratelimit-limit-requests-day": "1000", "x-ratelimit-remaining-requests-day": "990",
      "x-ratelimit-limit-tokens-minute": "2000", "x-ratelimit-remaining-tokens-minute": "1000",
      "x-ratelimit-remaining": "42",
    }));
    const report = await new AccountUsageCollector().load({ api: { driver: "cerebras" } });
    expect(report.providers[0].reporting.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ unit: "requests", windowSeconds: 86400, remaining: 990 }),
      expect.objectContaining({ unit: "tokens", windowSeconds: 60, remaining: 1000 }),
      expect.objectContaining({ unit: "units", windowSeconds: null, remaining: 42 }),
    ]));
  });

  it("does not refresh an old model's allowance when another model reports new headers", async () => {
    const now = 1_800_000_000_000;
    const headers = new Headers({ "x-ratelimit-remaining-tokens": "10" });
    observeRateHeaders("api", "old-model", headers, now);
    observeRateHeaders("api", "active-model", headers, now + 121_000);
    const report = await new AccountUsageCollector({ now: () => now + 121_000 }).load({ api: { driver: "groq" } });
    expect(report.providers[0].reporting.metrics.map(entry => entry.scope)).toEqual(["active-model"]);
  });
});
