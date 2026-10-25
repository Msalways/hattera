import { createHash } from "node:crypto";
import type { AccountMetric, AccountReporting } from "../shared/account-usage.ts";
import type { InstanceConfigMap, ProviderInstance } from "./contracts.ts";
import { fetchPlanUsage, planAccountsFromInstances, type PlanProviderRow } from "./plan-usage.ts";
import { metric, observedMetrics, OBSERVED_METRICS_FRESH_MS } from "./account-metrics.ts";
import { apiAccountUsage, apiReportingRoute } from "./api-account-usage.ts";
import { CLAUDE_ACCOUNT_ENV_KEYS, claudeEnvironment, readClaudeAuthSettings } from "./drivers/claude.ts";

export interface AccountUsageRow extends PlanProviderRow { reporting: AccountReporting; enabled: boolean }
export interface AccountUsageReport { fetchedAt: string; refreshing?: boolean; providers: AccountUsageRow[] }
type Config = InstanceConfigMap[string];
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const text = (value: unknown) => typeof value === "string" ? value : "";

/** Every registered engine has an explicit reporting route, including wrappers. */
export const ACCOUNT_REPORTING: Record<string, { dashboard: string; note: string }> = {
  claudeAgent: { dashboard: "https://claude.ai/settings/usage", note: "Claude account allowance" },
  codex: { dashboard: "https://chatgpt.com/codex/settings/usage", note: "Codex account allowance" },
  grokAgent: { dashboard: "https://grok.com", note: "Grok account allowance" },
  grok: { dashboard: "https://console.x.ai", note: "API usage is recorded for Hattera calls. Account totals require the provider's reporting service." },
  geminiAgent: { dashboard: "https://aistudio.google.com/usage", note: "Gemini quota depends on the selected authentication route. Hattera records the usage reported by the engine." },
  kimiAgent: { dashboard: "https://www.kimi.com/code/console", note: "Account-wide allowances are available in the Kimi dashboard. Hattera task usage appears below." },
  droidAgent: { dashboard: "https://app.factory.ai", note: "View account allowances in Factory. Hattera records the usage reported by Droid." },
  cursorAgent: { dashboard: "https://cursor.com/dashboard", note: "Account-wide reporting requires Cursor's reporting API and account permissions. Hattera records engine-reported usage." },
  antigravityAgent: { dashboard: "", note: "This connection has not reported its account credits or model allowances. Hattera task usage appears below." },
  opencodeGo: { dashboard: "", note: "Allowance belongs to the upstream account selected in OpenCode. Hattera records engine-reported usage." },
  clineAgent: { dashboard: "", note: "Allowance belongs to Cline or its selected upstream provider. Hattera records engine-reported usage." },
  piAgent: { dashboard: "", note: "Allowance belongs to the upstream account selected in pi. Hattera records engine-reported usage." },
  hermesAgent: { dashboard: "", note: "Allowance belongs to the upstream account selected in Hermes. Hattera records engine-reported usage." },
  qwenAgent: { dashboard: "", note: "Allowance depends on the selected Qwen provider. Hattera records engine-reported usage." },
  "openai-compat": { dashboard: "", note: "This API route reports usage on calls. Account-wide allowance depends on the upstream provider." },
  minimax: { dashboard: "https://platform.minimax.io/console/usage", note: "MiniMax subscription allowances and API balances use separate reporting endpoints." },
  mistral: { dashboard: "https://console.mistral.ai", note: "Rate allowances are collected from provider response headers when supplied." },
  cerebras: { dashboard: "https://cloud.cerebras.ai", note: "Rate allowances are collected from provider response headers when supplied." },
  groq: { dashboard: "https://console.groq.com/settings/limits", note: "Rate allowances are collected from provider response headers on real calls." },
  customAcp: { dashboard: "", note: "This custom engine controls which usage metrics it reports. No account allowance has been reported." },
};

function emptyRow(id: string, entry: Config): AccountUsageRow {
  const closed = () => ({ available: false, remainingPercent: null, usedPercent: null, resetsAt: null });
  const support = ACCOUNT_REPORTING[entry.driver];
  return { id, name: entry.displayName?.trim() || entry.driver, driver: entry.driver, enabled: entry.enabled !== false,
    plan: null, ok: true, error: null, fiveHour: closed(), weekly: closed(), extra: [], models: [],
    reporting: { status: "unavailable", source: "No account snapshot", collectedAt: null,
      message: support?.note ?? "This provider has not exposed account reporting.", dashboardUrl: apiReportingRoute(text(object(entry.config).url))?.dashboard || support?.dashboard || null, metrics: [] } };
}

function legacyMetrics(row: PlanProviderRow): AccountMetric[] {
  const out: AccountMetric[] = [];
  const add = (id: string, label: string, window: { usedPercent: number | null; remainingPercent: number | null; resetsAt: string | null }, scope: string | null = null) => {
    if (window.usedPercent === null && window.remainingPercent === null) return;
    out.push(metric(id, label, { used: window.usedPercent, remaining: window.remainingPercent, limit: 100, scope, resetsAt: window.resetsAt }));
  };
  if (row.fiveHour.available) add("five-hour", "5-hour", row.fiveHour);
  if (row.weekly.available) add("weekly", "Weekly", row.weekly);
  row.extra.forEach((window, i) => add(`extra:${i}`, window.label, window));
  row.models.forEach(model => model.windows.forEach((window, i) => add(`model:${model.name}:${i}`, window.label, window, model.name)));
  return out;
}

function projectLegacyWindows(row: AccountUsageRow): void {
  for (const entry of row.reporting.metrics) {
    if (entry.unit !== "percent" || entry.used === null || entry.remaining === null) continue;
    const window = { available: true, usedPercent: entry.used, remainingPercent: entry.remaining, resetsAt: entry.resetsAt };
    const account = entry.scope === null || entry.scope === "codex";
    if (account && entry.windowSeconds === 18000 && !row.fiveHour.available) row.fiveHour = window;
    else if (account && entry.windowSeconds === 604800 && !row.weekly.available) row.weekly = window;
    else row.extra.push({ label: `${entry.scope ? `${entry.scope} · ` : ""}${entry.label}`, usedPercent: entry.used, remainingPercent: entry.remaining, resetsAt: entry.resetsAt });
  }
}

export function openRouterMetrics(body: unknown): AccountMetric[] {
  const data = object(object(body).data);
  const out: AccountMetric[] = [];
  const lifetime = finite(data.usage), remaining = finite(data.limit_remaining), limit = finite(data.limit);
  const reset = text(data.limit_reset);
  // Lifetime spending is not the amount consumed from a resetting key budget.
  const used = limit !== null && remaining !== null ? Math.max(0, limit - remaining) : reset ? null : lifetime;
  if (remaining !== null || limit !== null) out.push(metric("key-budget", `${reset ? `${reset} ` : ""}API key budget`, { unit: "USD", used, remaining, limit,
    windowSeconds: reset === "daily" ? 86400 : reset === "weekly" ? 604800 : null }));
  for (const [field, label] of [["usage", "Lifetime spend"], ["usage_daily", "Daily spend"], ["usage_weekly", "Weekly spend"], ["usage_monthly", "Monthly spend"],
    ["byok_usage", "Lifetime BYOK spend"], ["byok_usage_daily", "Daily BYOK spend"], ["byok_usage_weekly", "Weekly BYOK spend"], ["byok_usage_monthly", "Monthly BYOK spend"]]) {
    const amount = finite(data[field]);
    if (amount !== null) out.push(metric(field, label, { unit: "USD", used: amount }));
  }
  const budgets = [...(Array.isArray(data.budgets) ? data.budgets : []), ...(data.effective_budget ? [data.effective_budget] : [])];
  const seenBudgets = new Set<string>();
  budgets.slice(0, 50).forEach((raw, i) => {
    const budget = object(raw);
    const key = JSON.stringify([budget.budget_id, budget.guardrail_id, budget.scope, budget.reset_interval, budget.limit_usd, budget.remaining_usd, budget.resets_at]);
    if (seenBudgets.has(key)) return;
    seenBudgets.add(key);
    out.push(metric(`budget:${i}`, `${text(budget.reset_interval) || "Account"} budget`, { unit: "USD", scope: text(budget.scope) || null,
      used: finite(budget.spend_usd), remaining: finite(budget.remaining_usd), limit: finite(budget.limit_usd),
      resetsAt: typeof budget.resets_at === "string" && Number.isFinite(Date.parse(budget.resets_at)) ? new Date(budget.resets_at).toISOString() : null }));
  });
  const free = object(data.free_model_daily_requests);
  if (Object.keys(free).length) out.push(metric("free-models", "Free models daily requests", { unit: "requests", used: finite(free.used), remaining: finite(free.remaining), limit: finite(free.limit), windowSeconds: 86400 }));
  return out;
}

/** Per-account cache isolates credentials/config changes and retains last good data. */
export class AccountUsageCollector {
  private backgroundJob: Promise<AccountUsageReport> | null = null;
  private nativeQueue: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private cache = new Map<string, { at: number; retryAt: number; row: AccountUsageRow; pending?: Promise<AccountUsageRow> }>();
  private readonly deps: {
    instance?(id: string): ProviderInstance | null;
    nativeBusy?(id: string): boolean;
    fetch?: typeof fetch;
    now?: () => number;
    legacy?: typeof fetchPlanUsage;
  };
  constructor(deps: AccountUsageCollector["deps"] = {}) { this.deps = deps; }

  invalidate(): void { this.generation++; this.cache.clear(); }

  async load(instances: InstanceConfigMap, refresh = false, background = false): Promise<AccountUsageReport> {
    const now = this.deps.now?.() ?? Date.now();
    const generation = this.generation;
    const entries = Object.entries(instances);
    if (background) {
      const rows = entries.map(([id, entry]) => {
        const key = createHash("sha256").update(JSON.stringify([id, entry])).digest("hex");
        const cached = this.cache.get(key);
        return { cached, row: this.withObserved(cached?.row ?? emptyRow(id, entry), now) };
      });
      const needsRefresh = rows.some(({ cached }) => !cached || !cached.pending && now >= cached.retryAt && (refresh || now - cached.at >= 45_000));
      if (needsRefresh && !this.backgroundJob) {
        this.backgroundJob = this.load(instances, refresh).finally(() => { this.backgroundJob = null; });
        void this.backgroundJob.catch(() => {});
      }
      return { fetchedAt: new Date(now).toISOString(), refreshing: Boolean(this.backgroundJob), providers: rows.map(({ row }) => row) };
    }
    const rows: AccountUsageRow[] = [];
    let index = 0;
    // Bound both native processes and HTTP requests; one slow account cannot block others indefinitely.
    await Promise.all(Array.from({ length: Math.min(4, entries.length) }, async () => {
      while (index < entries.length) {
        const slot = index++;
        const [id, entry] = entries[slot];
        const key = createHash("sha256").update(JSON.stringify([id, entry])).digest("hex");
        const cached = this.cache.get(key);
        if (cached?.pending) { rows[slot] = await cached.pending; continue; }
        if (cached && (now < cached.retryAt || !refresh && now - cached.at < 45_000)) { rows[slot] = this.withObserved(cached.row, now); continue; }
        const pending = this.read(id, entry, now).then(row => {
          if (this.generation !== generation) return emptyRow(id, entry);
          if ((row.reporting.status === "unavailable" || row.reporting.status === "sign-in-required") && cached?.row.reporting.metrics.length) {
            row.reporting = { ...cached.row.reporting, status: "stale", message: row.reporting.message };
          }
          this.cache.set(key, { at: now, retryAt: now + (row.reporting.status === "stale" ? 30_000 : 5_000), row });
          return this.withObserved(row, now);
        });
        this.cache.set(key, { at: cached?.at ?? now, retryAt: now, row: cached?.row ?? emptyRow(id, entry), pending });
        rows[slot] = await pending;
      }
    }));
    const active = new Set(entries.map(([id, entry]) => createHash("sha256").update(JSON.stringify([id, entry])).digest("hex")));
    for (const key of this.cache.keys()) if (!active.has(key)) this.cache.delete(key);
    return { fetchedAt: new Date(now).toISOString(), providers: rows };
  }

  private withObserved(row: AccountUsageRow, now: number): AccountUsageRow {
    if (!row.enabled) return row;
    const observed = observedMetrics(row.id);
    if (!observed || row.reporting.collectedAt && Date.parse(row.reporting.collectedAt) > observed.at) return row;
    // Never represent an old provider response as a live remaining balance after its reset.
    const recentBase = row.reporting.collectedAt && now - Date.parse(row.reporting.collectedAt) <= OBSERVED_METRICS_FRESH_MS ? row.reporting.metrics : [];
    const metrics = [...new Map([...recentBase, ...observed.metrics].map(entry => [entry.id, entry])).values()].filter(entry => !entry.resetsAt || Date.parse(entry.resetsAt) > now);
    if (!metrics.length) return row;
    return { ...row, reporting: { ...row.reporting, metrics, source: observed.source, collectedAt: new Date(observed.at).toISOString(),
      status: now - observed.at > OBSERVED_METRICS_FRESH_MS ? "stale" : "partial", message: "Observed on provider calls; other account-wide limits may also apply." } };
  }

  private async read(id: string, entry: Config, now: number): Promise<AccountUsageRow> {
    const row = emptyRow(id, entry);
    if (!row.enabled) { row.reporting.message = "This account is disabled. Enable it in Model providers and accounts to refresh its reporting."; return row; }
    try {
      if (entry.driver === "claudeAgent") {
        const config = object(entry.config);
        const env = claudeEnvironment(undefined, { ...process.env, ...entry.environment }, typeof config.configDir === "string" ? config.configDir : undefined, entry.environment);
        const auth = readClaudeAuthSettings(env, entry.environment);
        const routing = { ...env, ...auth.env };
        if (config.managed || config.requireApiKey || auth.apiKeyHelper || CLAUDE_ACCOUNT_ENV_KEYS.some(key => key !== "CLAUDE_CODE_OAUTH_SCOPES" && routing[key] && routing[key] !== "0")) {
          row.reporting.status = "not-supported";
          row.reporting.message = "Allowances for this connection are managed by its selected billing provider. Hattera task usage appears below.";
          row.reporting.dashboardUrl = null;
          return row;
        }
      }
      const instance = this.deps.instance?.(id);
      const config = object(entry.config);
      const route = entry.driver === "openai-compat" ? apiReportingRoute(text(config.url)) : undefined;
      const envName = text(config.apiKeyEnv) || "OPENAI_COMPAT_API_KEY";
      const accountKey = typeof config.key === "string" ? config.key : entry.environment?.[envName] ?? process.env[envName] ?? "";
      const native = instance?.accountUsage?.bind(instance) ?? (route ? apiAccountUsage(text(config.url), accountKey, this.deps.fetch) : undefined);
      if (native) {
        const http = instance?.accountUsageTransport === "http" || !instance?.accountUsage && Boolean(route);
        if (!http && this.deps.nativeBusy?.(id)) {
          row.reporting.message = "Account snapshots refresh when this provider is idle. Usage reported by active calls appears as it arrives.";
          return this.withObserved(row, now);
        }
        // One native process at a time, including across overlapping HTTP refreshes.
        const request = http ? native() : this.nativeQueue.then(() => this.deps.nativeBusy?.(id) ? { metrics: [], source: "Waiting for provider to be idle" } : native());
        if (!http) this.nativeQueue = request.catch(() => {});
        const result = await request;
        row.reporting.metrics = result.metrics;
        row.reporting.source = result.source;
        projectLegacyWindows(row);
      } else if (entry.driver === "openai-compat" && /^https:\/\/openrouter\.ai\/api\/v1\/?$/.test(text(object(entry.config).url))) {
        const key = accountKey;
        row.reporting.dashboardUrl = "https://openrouter.ai/activity";
        if (!key) { row.reporting.status = "sign-in-required"; row.reporting.message = "Connect this account's OpenRouter API key to read its budget."; return row; }
        const response = await (this.deps.fetch ?? fetch)("https://openrouter.ai/api/v1/key", { headers: { authorization: `Bearer ${key}` }, redirect: "error", signal: AbortSignal.timeout(8_000) });
        if (!response.ok) throw new Error("report unavailable");
        row.reporting.metrics = openRouterMetrics(await response.json());
        row.reporting.source = "OpenRouter current-key API";
      } else {
        const accounts = planAccountsFromInstances({ [id]: entry });
        if (accounts.length) {
          const legacy = (await (this.deps.legacy ?? fetchPlanUsage)(accounts, { fetch: this.deps.fetch ?? fetch, credentials: (await import("./plan-usage.ts")).defaultCredentialReader(), now: () => now })).providers[0];
          Object.assign(row, legacy);
          row.reporting.metrics = legacyMetrics(legacy);
          row.reporting.source = "Provider account endpoint";
          if (!legacy.ok) { row.reporting.status = /^sign in/i.test(legacy.error ?? "") ? "sign-in-required" : "unavailable"; row.reporting.message = legacy.error; return row; }
        }
      }
      if (row.reporting.metrics.length) { row.reporting.status = "current"; row.reporting.collectedAt = new Date(now).toISOString(); row.reporting.message = null; }
    } catch {
      // Never surface upstream errors: they can include account IDs, tokens or private URLs.
      row.reporting.status = "unavailable";
      row.reporting.message = "Account reporting could not refresh. Check this account's connection or open its provider dashboard.";
    }
    return row;
  }
}
