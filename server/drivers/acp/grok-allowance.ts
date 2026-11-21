// Grok's subscription allowance, behind the driver allowance capability.
import { join } from "node:path";
import {
  authRejected,
  addModelWindow,
  asRecord,
  closedWindow,
  couldNotReach,
  durationLabel,
  expiredCredential,
  extraLine,
  fetchJson,
  finiteNumber,
  isoOrNull,
  missingCredential,
  okRow,
  errorRow,
  openWindow,
  parseJson,
  planLabel,
  secretString,
  signInAgain,
  sortModelWindows,
  timeMs,
  unexpectedUsage,
  PROVIDER_TIMEOUT_MS,
  FIVE_HOUR_MIN_SECONDS,
  FIVE_HOUR_MAX_SECONDS,
  WEEK_MIN_SECONDS,
  WEEK_MAX_SECONDS,
  MONTH_MIN_SECONDS,
  MONTH_MAX_SECONDS,
  type AllowanceCapability,
  type PlanAccount,
  type PlanCredential,
  type PlanModelUsage,
  type PlanProviderRow,
  type PlanUsageDeps,
  type PlanWindows,
  type PlanExtra,
} from "../../awareness/allowance-kit.ts";
import { harnessHome } from "../../env-path.ts";

const GROK_CREDITS_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

const GROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing";

const GROK_SETTINGS_URL = "https://cli-chat-proxy.grok.com/v1/settings";

function readGrokProducts(body: unknown, sample: GrokSample): Array<{ name: string; window: PlanExtra }> {
  const root = asRecord(body);
  if (!root) return [];
  const config = asRecord(root.config) ?? root;
  if (!Array.isArray(config.productUsage)) return [];
  const label = sample.slot === "fiveHour" ? "5-hour" : sample.slot === "weekly" ? "Weekly" : sample.slot === "monthly" ? "Monthly" : "Used";
  const rows: Array<{ name: string; window: PlanExtra }> = [];
  for (const item of config.productUsage) {
    const record = asRecord(item);
    if (!record) continue;
    const raw = typeof record.product === "string" ? record.product : typeof record.name === "string" ? record.name : "";
    const name = planLabel(raw.replace(/([a-z])([A-Z])/g, "$1 $2"));
    const used = finiteNumber(record.usagePercent ?? record.usedPercent ?? record.utilization);
    if (!name || used == null) continue;
    rows.push({ name, window: extraLine(label, openWindow(used, sample.resetsAt)) });
  }
  return rows;
}

type GrokSlot = "fiveHour" | "weekly" | "monthly" | "other";

interface GrokSample {
  used: number;
  slot: GrokSlot;
  resetsAt: string | null;
  seconds: number | null;
}

function classifyGrok(typeValue: unknown, seconds: number | null): GrokSlot {
  const type = typeof typeValue === "string" ? typeValue.toUpperCase() : "";
  if (type.includes("WEEK")) return "weekly";
  if (type.includes("MONTH")) return "monthly";
  if (/(^|[^A-Z0-9])(5|FIVE)[^A-Z0-9]*HOUR/.test(type)) return "fiveHour";
  if (seconds == null) return "other";
  if (seconds >= FIVE_HOUR_MIN_SECONDS && seconds <= FIVE_HOUR_MAX_SECONDS) return "fiveHour";
  if (seconds >= WEEK_MIN_SECONDS && seconds <= WEEK_MAX_SECONDS) return "weekly";
  if (seconds >= MONTH_MIN_SECONDS && seconds <= MONTH_MAX_SECONDS) return "monthly";
  return "other";
}

function readGrokSample(body: unknown): GrokSample | null {
  const root = asRecord(body);
  if (!root) return null;
  const config = asRecord(root.config) ?? root;
  let used = finiteNumber(config.creditUsagePercent);
  if (used == null) {
    const cap = finiteNumber(asRecord(config.onDemandCap)?.val ?? config.onDemandCap);
    const spent = finiteNumber(asRecord(config.onDemandUsed)?.val ?? config.onDemandUsed);
    if (cap != null && spent != null && cap > 0) used = (spent / cap) * 100;
  }
  if (used == null) return null;
  const period = asRecord(config.currentPeriod);
  const type = period?.type ?? period?.period ?? config.period ?? config.interval;
  const start = period?.start ?? period?.periodStart;
  const end = period?.end ?? period?.periodEnd ?? config.billingPeriodEnd ?? root.billingPeriodEnd;
  const startMs = timeMs(start);
  const endMs = timeMs(end);
  const seconds = startMs != null && endMs != null && endMs > startMs ? (endMs - startMs) / 1000 : null;
  return { used, slot: classifyGrok(type, seconds), resetsAt: isoOrNull(end), seconds };
}

function grokPlan(settings: unknown): string | null {
  const root = asRecord(settings);
  if (!root) return null;
  const nested = asRecord(root.settings);
  return planLabel(nested?.subscription_tier_display ?? root.subscription_tier_display);
}

export function parseGrokUsage(credits: unknown, billing?: unknown, settings?: unknown): PlanWindows {
  let fiveHour = closedWindow();
  let weekly = closedWindow();
  const extra: PlanExtra[] = [];
  const models: PlanModelUsage[] = [];
  let sawMonthly = false;
  const place = (sample: GrokSample | null) => {
    if (!sample) return;
    const window = openWindow(sample.used, sample.resetsAt);
    if (sample.slot === "fiveHour") {
      if (!fiveHour.available) fiveHour = window;
    } else if (sample.slot === "weekly") {
      if (!weekly.available) weekly = window;
    } else if (sample.slot === "monthly") {
      if (!sawMonthly) {
        sawMonthly = true;
        extra.push(extraLine("Monthly", window));
      }
    } else {
      extra.push(extraLine(sample.seconds == null ? "Credits" : durationLabel(sample.seconds), window));
    }
  };
  const creditSample = readGrokSample(credits);
  place(creditSample);
  const productSample = creditSample ?? { used: 0, slot: "other" as const, resetsAt: null, seconds: null };
  for (const model of readGrokProducts(credits, productSample)) addModelWindow(models, model.name, model.window);
  if (billing !== undefined) place(readGrokSample(billing));
  sortModelWindows(models);
  return { plan: grokPlan(settings), fiveHour, weekly, extra, models };
}

interface GrokCandidate {
  token: string;
  expiresAt: number | null;
}

function grokCandidate(record: Record<string, unknown>): GrokCandidate | null {
  const token = secretString(record.access_token) ?? secretString(record.key);
  if (!token) return null;
  return { token, expiresAt: timeMs(record.expires_at ?? record.expiresAt) };
}

function readGrokCredential(
  env: NodeJS.ProcessEnv,
  readText: (path: string) => string | null,
  now: number,
): PlanCredential {
  const rootDir = env.GROK_HOME?.trim() || harnessHome("grok", env);
  const root = asRecord(parseJson(readText(join(rootDir, "auth.json"))));
  if (!root) return missingCredential();
  const direct = grokCandidate(root);
  if (direct) {
    if (direct.expiresAt != null && direct.expiresAt <= now) return expiredCredential();
    return { token: direct.token, accountId: null, expired: false };
  }
  let sawExpired = false;
  let best: GrokCandidate | null = null;
  for (const value of Object.values(root)) {
    const record = asRecord(value);
    if (!record) continue;
    const candidate = grokCandidate(record);
    if (!candidate) continue;
    if (candidate.expiresAt != null && candidate.expiresAt <= now) {
      sawExpired = true;
      continue;
    }
    const bestStamp = best?.expiresAt ?? Number.NEGATIVE_INFINITY;
    const stamp = candidate.expiresAt ?? Number.NEGATIVE_INFINITY;
    if (!best || stamp >= bestStamp) best = candidate;
  }
  if (best) return { token: best.token, accountId: null, expired: false };
  return sawExpired ? expiredCredential() : missingCredential();
}

async function fetchGrok(account: PlanAccount, token: string, deps: PlanUsageDeps): Promise<PlanProviderRow> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "X-XAI-Token-Auth": "xai-grok-cli",
  };
  const timeout = deps.timeoutMs ?? PROVIDER_TIMEOUT_MS;
  const [credits, billing, settings] = await Promise.all([
    fetchJson(deps.fetch, GROK_CREDITS_URL, headers, timeout),
    fetchJson(deps.fetch, GROK_BILLING_URL, headers, timeout),
    fetchJson(deps.fetch, GROK_SETTINGS_URL, headers, timeout),
  ]);
  if (authRejected(credits.status) || (authRejected(billing.status) && !credits.ok)) {
    return errorRow(account, signInAgain("Grok"));
  }
  const creditsBody = credits.ok ? credits.body : null;
  const billingBody = billing.ok && !authRejected(billing.status) ? billing.body : null;
  if (creditsBody === null && billingBody === null) {
    return errorRow(account, credits.status === 0 || credits.status >= 500 || billing.status === 0 || billing.status >= 500
      ? couldNotReach("Grok")
      : unexpectedUsage("Grok"));
  }
  const windows = parseGrokUsage(creditsBody, billingBody ?? undefined, settings.ok ? settings.body : undefined);
  return okRow(account, windows);
}

export const grokAllowance: AllowanceCapability = {
  id: "grok",
  product: "Grok",
  readCredential: (_account, env, source, now) => readGrokCredential(env, source.readText, now),
  fetchUsage: (account, credential, deps) => fetchGrok(account, credential.token ?? "", deps),
};
