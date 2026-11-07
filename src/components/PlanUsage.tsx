// Settings → Usage: remaining subscription allowance. This is not the token
// ledger below it — each provider reports its own 5-hour and weekly windows.
import { Loader2, RefreshCw } from "lucide-react";
import { t } from "@/lib/i18n";
import { Card } from "./SettingsPrimitives";
import { AccountReportingView } from "./AccountReporting";
import { LegacyProviderWindows } from "./PlanUsageWindows";
import { usePlanUsageReport } from "./usePlanUsageReport";

export function PlanUsage() {
  const { report, loading, error, now, load } = usePlanUsageReport();

  return (
    <Card title={t("planUsage.title")} subtitle={t("accountUsage.subtitle")}>
      <div className="mb-3 flex justify-end">
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={loading}
          aria-label={t("planUsage.refresh")}
          title={t("planUsage.refresh")}
          className="rounded-md p-2 text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        </button>
      </div>
      {loading && !report && <p role="status" className="text-[13px] text-ink-secondary">{t("planUsage.loading")}</p>}
      {report?.refreshing && <p role="status" className="mb-3 text-[12px] text-ink-secondary">{t("accountUsage.refreshing")}</p>}
      {error && <p role="alert" className="mb-3 text-[13px] text-danger">{error}</p>}
      {report && report.providers.length === 0 && (
        <p className="text-[13px] text-ink-secondary">{t("accountUsage.empty")}</p>
      )}
      {report && report.providers.length > 0 && (
        <div className="flex flex-col gap-4">
          {report.providers.map((provider) => (
            <div key={provider.id} data-account-usage={provider.id} className="border-t border-hairline/30 pt-3 first:border-t-0 first:pt-0">
              <div className="mb-2 flex min-w-0 items-baseline gap-2">
                <span className="truncate text-[14px] font-medium text-ink">{provider.name}</span>
                {provider.plan && <span className="truncate text-[12px] text-ink-secondary">{provider.plan}</span>}
              </div>
              {provider.reporting ? <AccountReportingView reporting={provider.reporting} now={now} /> : provider.ok ? (
                <LegacyProviderWindows provider={provider} now={now} />
              ) : (
                <p className="text-[13px] text-danger">{provider.error}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
