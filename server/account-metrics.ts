import type { AccountMetric } from "../shared/account-usage.ts";

export const OBSERVED_METRICS_FRESH_MS = 120_000;
const snapshots = new Map<string, { at: number; source: string; metrics: AccountMetric[]; seen: Map<string, number> }>();
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function metric(id: string, label: string, values: Partial<AccountMetric> = {}): AccountMetric {
  return { id, label, scope: null, unit: "percent", used: null, remaining: null, limit: null, windowSeconds: null, resetsAt: null, ...values };
}

export function resetTimestamp(value: unknown): string | null {
  if (typeof value === "string" && /^\d{10,13}(?:\.\d+)?$/.test(value)) value = Number(value);
  else if (typeof value === "string" && !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const ms = typeof value === "number" ? value * (value < 1e12 ? 1000 : 1) : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && Math.abs(ms) < 8.64e15 ? new Date(ms).toISOString() : null;
}

export function durationLabel(seconds: number | null): string {
  if (seconds === null) return "Allowance";
  if (seconds % 86400 === 0) return `${seconds / 86400}-day`;
  if (seconds % 3600 === 0) return `${seconds / 3600}-hour`;
  if (seconds % 60 === 0) return `${seconds / 60}-minute`;
  return `${seconds}-second`;
}

export function codexMetrics(value: unknown): AccountMetric[] {
  const root = record(value);
  const buckets = record(root.rateLimitsByLimitId);
  const limits = Object.keys(buckets).length ? Object.entries(buckets) : [["codex", root.rateLimits]] as const;
  const out: AccountMetric[] = [];
  for (const [id, raw] of limits) {
    const bucket = record(raw);
    // Names from the native protocol are labels only, never HTML or commands.
    const scope = typeof bucket.limitName === "string" ? bucket.limitName.slice(0, 120) : id;
    for (const slot of ["primary", "secondary"] as const) {
      const window = record(bucket[slot]);
      const used = number(window.usedPercent);
      const minutes = number(window.windowDurationMins);
      if (used === null && minutes === null && window.resetsAt == null) continue;
      const seconds = minutes === null ? null : minutes * 60;
      out.push(metric(`${id}:${slot}`, durationLabel(seconds), { scope, used, remaining: used === null ? null : Math.max(0, 100 - used), limit: 100, windowSeconds: seconds, resetsAt: resetTimestamp(window.resetsAt) }));
    }
    const credits = record(bucket.credits);
    const balance = typeof credits.balance === "string" && credits.balance.trim() ? number(Number(credits.balance)) : number(credits.balance);
    if (balance !== null) out.push(metric(`${id}:credits`, "Credit balance", { scope, unit: "credits", remaining: balance }));
  }
  const available = number(record(root.rateLimitResetCredits).availableCount);
  if (available !== null) out.push(metric("reset-credits", "Available allowance resets", { unit: "credits", remaining: available }));
  return out;
}

export function codexActivityMetrics(value: unknown): AccountMetric[] {
  const summary = record(record(value).summary);
  return [["lifetimeTokens", "Account lifetime tokens"], ["peakDailyTokens", "Peak daily tokens"]].flatMap(([id, label]) => {
    const used = number(summary[id]);
    return used === null ? [] : [metric(`activity:${id}`, label, { unit: "tokens", used })];
  });
}

export function observeMetrics(instanceId: string, source: string, metrics: AccountMetric[], at = Date.now()): void {
  if (!metrics.length) return;
  if (!snapshots.has(instanceId) && snapshots.size >= 500) snapshots.delete(snapshots.keys().next().value!);
  const previous = snapshots.get(instanceId);
  // Updating one model must not make another model's old allowance look fresh.
  const merged = new Map(previous?.metrics.filter(entry => at - (previous.seen.get(entry.id) ?? previous.at) <= OBSERVED_METRICS_FRESH_MS).map(entry => [entry.id, entry]));
  const seen = new Map(previous?.seen);
  for (const entry of metrics) { merged.set(entry.id, entry); seen.set(entry.id, at); }
  const retained = [...merged.values()].slice(-100);
  snapshots.set(instanceId, { at, source, metrics: retained, seen: new Map(retained.map(entry => [entry.id, seen.get(entry.id)!])) });
}

export function observedMetrics(instanceId: string) {
  const snapshot = snapshots.get(instanceId);
  return snapshot && { at: snapshot.at, source: snapshot.source, metrics: snapshot.metrics };
}
export function clearObservedMetrics(instanceId?: string): void { if (instanceId) snapshots.delete(instanceId); else snapshots.clear(); }

/** Consume response metadata on real calls, including 429s; never send a paid probe. */
export function observeRateHeaders(instanceId: string, model: string, headers: Headers, at = Date.now()): void {
  const entries: AccountMetric[] = [];
  const dimensions = new Set<string>();
  for (const name of headers.keys()) {
    const match = /^x-ratelimit-(?:limit|remaining|reset)(?:-(.*))?$/.exec(name);
    if (match && (!match[1] || /^(?:(?:input-|output-|uncached-|total-)?tokens|requests)(?:-(?:minute|hour|day|second))?$/.test(match[1]))) dimensions.add(match[1] ?? "");
  }
  for (const dimension of dimensions) {
    const suffix = dimension ? `-${dimension}` : "";
    const read = (name: string) => {
      const raw = headers.get(`x-ratelimit-${name}${suffix}`);
      return raw !== null && raw.trim() !== "" ? number(Number(raw)) : null;
    };
    const limit = read("limit");
    const remaining = read("remaining");
    if (limit === null && remaining === null) continue;
    const rawReset = headers.get(`x-ratelimit-reset${suffix}`);
    let resetsAt = resetTimestamp(rawReset);
    if (rawReset && !resetsAt) {
      // Providers use compact durations (e.g. 2m59.56s), not all ISO times.
      const parts = [...rawReset.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)];
      if (parts.length && parts.map(part => part[0]).join("") === rawReset) {
        const ms = parts.reduce((sum, part) => sum + Number(part[1]) * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[part[2]] ?? 0), 0);
        resetsAt = new Date(at + ms).toISOString();
      }
    }
    const unit = dimension.includes("tokens") ? "tokens" : dimension.includes("requests") ? "requests" : "units";
    const period = /-(minute|hour|day|second)$/.exec(dimension)?.[1];
    const windowSeconds = period ? ({ second: 1, minute: 60, hour: 3600, day: 86400 }[period] ?? null) : null;
    entries.push(metric(`headers:${model}:${dimension || "rate"}`, dimension ? dimension.replaceAll("-", " ") : "Rate allowance", {
      scope: model, unit, limit, remaining, windowSeconds,
      used: limit !== null && remaining !== null ? Math.max(0, limit - remaining) : null, resetsAt,
    }));
  }
  observeMetrics(instanceId, "Provider response headers", entries, at);
}

export function observeClaudeLimit(instanceId: string, value: unknown, at = Date.now()): void {
  const info = record(value);
  const usedRatio = number(info.utilization);
  const usedPercent = number(info.used_percentage);
  const used = usedPercent ?? (usedRatio === null ? null : usedRatio * 100);
  if (typeof info.rateLimitType !== "string") return;
  const seconds = info.rateLimitType.startsWith("five_hour") ? 18_000 : info.rateLimitType.startsWith("seven_day") ? 604_800 : null;
  if (used === null && info.resetsAt == null) return;
  observeMetrics(instanceId, "Claude native rate-limit event", [metric(`claude:${info.rateLimitType}`, info.rateLimitType.replaceAll("_", " "), {
    used, remaining: used === null ? null : Math.max(0, 100 - used), limit: 100,
    windowSeconds: seconds, resetsAt: resetTimestamp(info.resetsAt),
  })], at);
}
