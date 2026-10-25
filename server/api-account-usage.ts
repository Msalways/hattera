// Reporting uses the same resolved URL/key as inference, never another engine's login.
import { durationLabel, metric, resetTimestamp } from "./account-metrics.ts";
import type { AccountMetric } from "../shared/account-usage.ts";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (value: unknown): number | null => {
  if (typeof value === "string" && value.trim()) value = Number(value);
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
};

export function apiReportingRoute(address: string) {
  // Exact, official endpoints only. A proxy or lookalike is a separate connection.
  const routes: Record<string, { kind: "kimi" | "minimax"; origin: string; dashboard: string }> = {
    "https://api.kimi.com/coding/v1": { kind: "kimi", origin: "https://api.kimi.com", dashboard: "https://www.kimi.com/code/console" },
    "https://api.kimi.ai/coding/v1": { kind: "kimi", origin: "https://api.kimi.ai", dashboard: "https://www.kimi.ai/code/console" },
    ...Object.fromEntries(["api.minimax.io", "api.minimax.cn", "api.minimaxi.com"].map(host => [`https://${host}/v1`, {
      kind: "minimax" as const, origin: `https://${host}`, dashboard: host === "api.minimax.io" ? "https://platform.minimax.io/console/usage" : "https://platform.minimax.cn/console/usage",
    }])),
  };
  return routes[address.replace(/\/+$/, "")];
}

export function kimiApiMetrics(raw: unknown): AccountMetric[] {
  const body = object(raw), usages = object(body.usages);
  const out: AccountMetric[] = [];
  const windows: Record<string, [string, number | null]> = {
    limit_5h: ["5-hour", 18_000], limit_7d: ["7-day", 604_800],
    limit_month_total: ["Monthly total", null], limit_month_code: ["Monthly coding", null],
  };
  for (const [key, value] of Object.entries(usages).slice(0, 50)) {
    const entry = object(value), ratio = count(entry.used_ratio);
    if (ratio === null) continue;
    const [label, windowSeconds] = windows[key] ?? [key, null];
    const used = ratio * 100;
    out.push(metric(`kimi:${key}`, label, { used, remaining: Math.max(0, 100 - used), limit: 100, windowSeconds, resetsAt: resetTimestamp(entry.reset_time) }));
  }
  const wallet = object(body.boosterWallet), balance = object(wallet.balance);
  if (balance.type === "BOOSTER") {
    const limit = object(wallet.monthlyChargeLimit), spent = object(wallet.monthlyUsed);
    const currency = typeof limit.currency === "string" && /^[A-Z]{3}$/.test(limit.currency) ? limit.currency
      : typeof spent.currency === "string" && /^[A-Z]{3}$/.test(spent.currency) ? spent.currency : null;
    const money = { unit: currency ? "currency" as const : "units" as const, ...(currency ? { currency } : {}) };
    const left = count(balance.amountLeft), total = count(balance.amount);
    if (left !== null || total !== null) out.push(metric("kimi:wallet", "Extra usage balance", { ...money,
      remaining: left === null ? null : left / 100_000_000, limit: total === null ? null : total / 100_000_000 }));
    const used = count(spent.priceInCents), cap = count(limit.priceInCents);
    if (used !== null || wallet.monthlyChargeLimitEnabled === true && cap !== null) out.push(metric("kimi:wallet-month", "Monthly extra usage", {
      ...money, used: used === null ? null : used / 100, limit: wallet.monthlyChargeLimitEnabled === true && cap !== null ? cap / 100 : null,
    }));
  }
  return out;
}

export function minimaxApiMetrics(raw: unknown): AccountMetric[] {
  const body = object(raw);
  if (object(body.base_resp).status_code !== undefined && object(body.base_resp).status_code !== 0) throw new Error("MiniMax reporting rejected");
  const out: AccountMetric[] = [];
  for (const [i, rawModel] of (Array.isArray(body.model_remains) ? body.model_remains : []).slice(0, 100).entries()) {
    const model = object(rawModel);
    const scope = typeof model.model_name === "string" ? model.model_name.slice(0, 120) : null;
    const unavailable = model.current_interval_status === 3 && model.current_weekly_status === 3 && model.current_interval_total_count === 0 && model.current_weekly_total_count === 0;
    for (const [prefix, start, end] of [["current_interval", "start_time", "end_time"], ["current_weekly", "weekly_start_time", "weekly_end_time"]]) {
      const begins = resetTimestamp(model[start]), resetsAt = resetTimestamp(model[end]);
      const seconds = begins && resetsAt && Date.parse(resetsAt) > Date.parse(begins) ? (Date.parse(resetsAt) - Date.parse(begins)) / 1000 : null;
      const label = prefix === "current_weekly" ? "Weekly" : durationLabel(seconds);
      const id = `minimax:${i}:${prefix}`;
      if (unavailable || model[`${prefix}_status`] === 3) {
        out.push(metric(id, label, { scope, availability: unavailable ? "not-in-plan" : "unlimited", windowSeconds: seconds, resetsAt }));
        continue;
      }
      const total = count(model[`${prefix}_total_count`]), counter = count(model[`${prefix}_usage_count`]), percent = count(model[`${prefix}_remaining_percent`]);
      if (total === null && counter === null && percent === null) continue;
      // The native CLI reconciles legacy remaining counters and newer consumed
      // counters against the authoritative percentage. Conflicting data stays unknown.
      let remaining: number | null = null;
      if (total !== null && total > 0 && counter !== null && counter <= total) {
        if (percent === null) remaining = counter;
        else {
          const leftDistance = Math.abs(counter / total * 100 - percent), usedDistance = Math.abs((total - counter) / total * 100 - percent);
          if (Math.min(leftDistance, usedDistance) <= 1) remaining = usedDistance < leftDistance ? total - counter : counter;
        }
      }
      out.push(metric(id, label, { scope, unit: "units", used: remaining !== null && total !== null ? total - remaining : null, remaining, limit: total, windowSeconds: seconds, resetsAt }));
      if (percent !== null) {
        const boost = prefix === "current_weekly" ? count(model.weekly_boost_permille) : null;
        const left = percent * (boost === null ? 1 : boost / 1000);
        out.push(metric(`${id}:percent`, `${label} remaining`, { scope, used: left <= 100 ? 100 - left : null, remaining: left, limit: 100, windowSeconds: seconds, resetsAt }));
      }
    }
  }
  // Balance endpoints do not declare a currency; never silently label them USD.
  for (const [key, label] of [["available_amount", "Available balance"], ["cash_balance", "Cash balance"], ["voucher_balance", "Voucher balance"], ["credit_balance", "Credit balance"], ["owed_amount", "Amount owed"]]) {
    const amount = count(body[key]);
    if (amount !== null) out.push(metric(`minimax:${key}`, label, { unit: "units", remaining: amount }));
  }
  return out;
}

export function apiAccountUsage(address: string, key: string, fetchImpl?: typeof fetch) {
  const route = apiReportingRoute(address);
  if (!route) return undefined;
  return async () => {
    if (!key) throw new Error("Reporting requires this account's key");
    const endpoint = route.kind === "kimi" ? `${route.origin}/coding/v1/usages`
      : `${route.origin}${key.startsWith("sk-api-") ? "/account/query_balance" : "/v1/token_plan/remains"}`;
    const response = await (fetchImpl ?? fetch)(endpoint, { headers: { authorization: `Bearer ${key}`, accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error("Account reporting unavailable");
    const body: unknown = await response.json();
    return { metrics: route.kind === "kimi" ? kimiApiMetrics(body) : minimaxApiMetrics(body), source: route.kind === "kimi" ? "Kimi account usage API" : "MiniMax account usage API" };
  };
}
