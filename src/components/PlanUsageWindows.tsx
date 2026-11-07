import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { PlanProvider, PlanWindow } from "./planUsageReport";

export function formatResetDistance(resetsAt: string | null, now: number): string | null {
  if (!resetsAt) return null;
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at) || at <= now) return null;
  const minutes = Math.floor((at - now) / 60_000);
  if (minutes < 1) return "less than a minute";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}

function usageTone(used: number): string {
  if (used >= 90) return "bg-danger";
  if (used >= 70) return "bg-warning";
  return "bg-success";
}

export function windowLabel(label: string): string {
  if (label === "5-hour") return t("planUsage.fiveHour");
  if (label === "Weekly") return t("planUsage.weekly");
  return label;
}

export function WindowRow({
  label,
  window,
  now,
  usedHeadline = false,
}: {
  label: string;
  window: PlanWindow;
  now: number;
  usedHeadline?: boolean;
}) {
  const when = window.available ? formatResetDistance(window.resetsAt, now) : null;
  const used = window.usedPercent ?? 0;
  const headline = usedHeadline
    ? window.usedPercent == null ? null : t("planUsage.used", { used: Math.round(window.usedPercent) })
    : window.remainingPercent == null ? null : t("planUsage.left", { remaining: Math.round(window.remainingPercent) });
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1">
      <div className="text-[12px] text-ink-secondary">{label}</div>
      {window.available && headline ? (
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2 text-[13px] text-ink">
            <span className="tabular-nums">{headline}</span>
            {when && <span className="text-[12px] text-ink-secondary">{t("planUsage.resetsIn", { when })}</span>}
          </div>
          <div
            className="mt-1 h-1.5 overflow-hidden rounded-full bg-inset"
            role="meter"
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(Math.min(100, Math.max(0, used)))}
          >
            <div className={cn("h-full rounded-full", usageTone(used))} style={{ width: `${Math.min(100, Math.max(0, used))}%` }} />
          </div>
        </div>
      ) : (
        <div className="text-[12px] text-ink-secondary">{t("planUsage.notReported")}</div>
      )}
    </div>
  );
}

/** Legacy provider-reported windows (5-hour/weekly/extra/model slices) when the
 * provider does not supply the newer AccountReporting shape. */
export function LegacyProviderWindows({ provider, now }: { provider: PlanProvider; now: number }) {
  return (
    <div className="flex flex-col gap-2">
      <WindowRow label={t("planUsage.fiveHour")} window={provider.fiveHour} now={now} />
      <WindowRow label={t("planUsage.weekly")} window={provider.weekly} now={now} />
      {provider.extra.map((extra, index) => (
        <WindowRow
          key={`${extra.label}-${index}`}
          label={windowLabel(extra.label)}
          now={now}
          window={{
            available: true,
            remainingPercent: extra.remainingPercent,
            usedPercent: extra.usedPercent,
            resetsAt: extra.resetsAt,
          }}
        />
      ))}
      {(provider.models ?? []).length > 0 && (
        <div className="mt-1 flex flex-col gap-2">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-secondary">{t("planUsage.byModel")}</div>
          {(provider.models ?? []).map((model) => (
            <div key={model.name} className="flex flex-col gap-1">
              <div className="truncate text-[13px] font-medium text-ink">{model.name}</div>
              {model.windows.map((entry, index) => (
                <WindowRow
                  key={`${model.name}-${entry.label}-${index}`}
                  label={windowLabel(entry.label)}
                  now={now}
                  usedHeadline
                  window={{
                    available: true,
                    remainingPercent: entry.remainingPercent,
                    usedPercent: entry.usedPercent,
                    resetsAt: entry.resetsAt,
                  }}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
