import type { AccountMetric, AccountReporting } from "../../shared/account-usage";
import { t } from "@/lib/i18n";

function valueText(value: number | null, unit: AccountMetric["unit"], currency?: string): string {
  if (value === null) return t("accountUsage.unknown");
  if (unit === "USD") return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(value);
  if (unit === "currency" && currency && /^[A-Z]{3}$/.test(currency)) return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 4 }).format(value);
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)}${unit === "percent" ? "%" : ` ${unit}`}`;
}

export function AccountReportingView({ reporting, now }: { reporting: AccountReporting; now: number }) {
  return <div className="flex flex-col gap-3">
    {reporting.message && <p role={reporting.status === "stale" ? "status" : undefined} className="text-[12px] leading-relaxed text-ink-secondary">{reporting.message}</p>}
    {reporting.metrics.map(entry => {
      const percent = entry.availability ? null : entry.unit === "percent" ? entry.used : entry.used !== null && entry.limit !== null && entry.limit > 0 ? 100 * entry.used / entry.limit : null;
      const expired = entry.resetsAt !== null && Date.parse(entry.resetsAt) <= now;
      const label = `${entry.scope ? `${entry.scope} · ` : ""}${entry.label}`;
      return <div key={entry.id} className="min-w-0">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-[13px]">
          <span className="break-words font-medium text-ink">{label}</span>
          <span className="tabular-nums text-ink-secondary">
            {expired ? t("accountUsage.lastKnown") + ": " : ""}{entry.availability === "unlimited" ? t("accountUsage.unlimited") : entry.availability === "not-in-plan" ? t("accountUsage.notInPlan") : entry.remaining !== null ? t("accountUsage.remaining", { value: valueText(entry.remaining, entry.unit, entry.currency) }) : entry.used !== null ? t("accountUsage.used", { value: valueText(entry.used, entry.unit, entry.currency) }) : t("accountUsage.unknown")}
            {entry.limit !== null && entry.unit !== "percent" && ` / ${valueText(entry.limit, entry.unit, entry.currency)}`}
            {entry.estimated && ` · ${t("accountUsage.estimated")}`}
          </span>
        </div>
        {percent !== null && !expired && <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.max(0, percent))} className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-inset">
          <div className={`h-full rounded-full ${percent >= 90 ? "bg-danger" : percent >= 70 ? "bg-warning" : "bg-success"}`} style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
        </div>}
        {entry.resetsAt && <p className="mt-1 text-[11px] text-ink-secondary">{expired ? t("accountUsage.awaitingReset") : t("accountUsage.resetAt", { when: new Date(entry.resetsAt).toLocaleString() })}</p>}
      </div>;
    })}
    <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-ink-secondary">
      <span>{reporting.source}{reporting.collectedAt && ` · ${new Date(reporting.collectedAt).toLocaleString()}`}{reporting.status === "stale" && ` · ${t("accountUsage.stale")}`}</span>
      {reporting.dashboardUrl && <a href={reporting.dashboardUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">{t("accountUsage.dashboard")} ↗</a>}
    </div>
  </div>;
}
