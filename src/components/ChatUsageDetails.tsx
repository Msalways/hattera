import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Gauge, Loader2, RefreshCw, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useModalDialog } from "@/hooks/use-modal-dialog";
import type { AppState, Bot, TaskUsage } from "@/state/store";
import {
  contextChip,
  contextDetail,
  contextShare,
  costCaption,
  formatUsageTokens,
  formatUsd,
  hasFiniteCost,
  lastTurnDetail,
  tokensColumnLabel,
  usageDetail,
} from "@/lib/usage";
import { AccountReportingView } from "./AccountReporting";
import { LegacyProviderWindows } from "./PlanUsageWindows";
import { planProviderForInstance } from "./planUsageReport";
import { usePlanUsageReport } from "./usePlanUsageReport";

function taskUsageForThread(bot: Bot): TaskUsage | undefined {
  return bot.tasks?.find((task) => task.threadId === bot.threadId)?.usage;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-secondary">{title}</h3>
      {children}
    </section>
  );
}

function MetricRow({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 text-[13px]">
      <span className="text-ink-secondary">{label}</span>
      <span className="min-w-0 text-right tabular-nums text-ink" title={detail}>{value}</span>
    </div>
  );
}

function ContextOccupancy({ usage }: { usage: TaskUsage | undefined }) {
  const share = usage ? contextShare(usage) : null;
  if (!usage || usage.turns === 0 && usage.input + usage.output === 0) {
    return <p className="text-[13px] leading-relaxed text-ink-secondary">{t("chat.usage.details.noTelemetry")}</p>;
  }
  if (!share) {
    return <p className="text-[13px] leading-relaxed text-ink-secondary">{t("chat.usage.details.contextUnavailable")}</p>;
  }
  const tone = share.tone === "danger" ? "text-danger" : share.tone === "warning" ? "text-warning" : "text-ink";
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className={cn("text-[15px] font-semibold tabular-nums", tone)}>{share.percent !== undefined ? `${share.percent}%` : contextChip(usage)}</span>
        <span className="text-[12px] text-ink-secondary">{contextDetail(usage)}</span>
      </div>
      {share.window && share.percent !== undefined && (
        <div className="h-1.5 overflow-hidden rounded-full bg-inset" role="meter" aria-label={t("chat.usage.details.contextOccupancy")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.max(0, share.percent))}>
          <div className={cn("h-full rounded-full", share.tone === "danger" ? "bg-danger" : share.tone === "warning" ? "bg-warning" : "bg-success")} style={{ width: `${Math.min(100, Math.max(0, share.percent))}%` }} />
        </div>
      )}
      <p className="text-[12px] leading-relaxed text-ink-secondary">{t("chat.usage.details.contextNote")}</p>
    </div>
  );
}

function Ledger({ usage, instances, bot }: { usage: TaskUsage | undefined; instances: AppState["instances"]; bot: Bot }) {
  if (!usage || usage.turns === 0 && usage.input + usage.output === 0) {
    return <p className="text-[13px] leading-relaxed text-ink-secondary">{t("chat.usage.details.noLedger")}</p>;
  }
  const billing = instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId)?.snapshot.billing;
  const last = lastTurnDetail(usage);
  return (
    <div className="flex flex-col gap-1.5">
      <MetricRow label={t("usage.colTurns")} value={String(usage.turns)} />
      <MetricRow label={tokensColumnLabel(usage)} value={formatUsageTokens(usage)} detail={usageDetail(usage)} />
      <MetricRow label={t("usage.colCost")} value={hasFiniteCost(usage.costUsd) ? `${formatUsd(usage.costUsd)} ${costCaption(billing)}` : "—"} />
      {last && <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">{last}</p>}
      <p className="text-[12px] leading-relaxed text-ink-secondary">{t("chat.usage.details.ledgerNote")}</p>
    </div>
  );
}

function AccountAllowance({ instanceId, instanceName, open }: { instanceId: string | undefined; instanceName: string; open: boolean }) {
  const { report, loading, error, now, load } = usePlanUsageReport({ enabled: open });
  const provider = planProviderForInstance(report, instanceId);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-[12px] text-ink-secondary">{instanceName || instanceId || t("chat.usage.details.unknownAccount")}</p>
        <button type="button" onClick={() => void load(true)} disabled={loading || !open} aria-label={t("planUsage.refresh")} title={t("planUsage.refresh")} className="rounded-md p-2 text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50 min-h-11 min-w-11 flex items-center justify-center">
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        </button>
      </div>
      {loading && !report && <p role="status" className="text-[13px] text-ink-secondary">{t("planUsage.loading")}</p>}
      {report?.refreshing && <p role="status" className="text-[12px] text-ink-secondary">{t("accountUsage.refreshing")}</p>}
      {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
      {!loading && report && !provider && <p className="text-[13px] leading-relaxed text-ink-secondary">{t("chat.usage.details.allowanceUnavailable")}</p>}
      {provider?.reporting ? <AccountReportingView reporting={provider.reporting} now={now} /> : provider?.ok ? (
        <LegacyProviderWindows provider={provider} now={now} />
      ) : provider ? (
        <p className="text-[13px] text-danger">{provider.error || t("chat.usage.details.allowanceUnavailable")}</p>
      ) : null}
    </div>
  );
}

export function ChatUsageDetailsDialog({
  open,
  bot,
  instances,
  onClose,
}: {
  open: boolean;
  bot: Bot;
  instances: AppState["instances"];
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalDialog(dialogRef, onClose);
  const usage = taskUsageForThread(bot);
  const instanceId = bot.modelSelection.instanceId;
  const instanceName = instances.find((instance) => instance.instanceId === instanceId)?.displayName ?? instanceId;

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/40 p-3 sm:items-center" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="chat-usage-details-title"
        tabIndex={-1}
        className="max-h-[min(85vh,40rem)] w-full max-w-[28rem] overflow-y-auto rounded-2xl border border-hairline/50 bg-panel p-4 shadow-2xl outline-none"
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="chat-usage-details-title" className="text-[15px] font-semibold text-ink">{t("chat.usage.details.title")}</h2>
            <p className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{t("chat.usage.details.subtitle")}</p>
          </div>
          <button type="button" onClick={onClose} aria-label={t("common.close")} className="rounded-md p-2 text-ink-secondary hover:bg-control hover:text-ink min-h-11 min-w-11 flex items-center justify-center shrink-0">
            <X size={16} />
          </button>
        </div>
        <div className="flex flex-col gap-5">
          <Section title={t("chat.usage.details.contextOccupancy")}>
            <ContextOccupancy usage={usage} />
          </Section>
          <Section title={t("chat.usage.details.ledger")}>
            <Ledger usage={usage} instances={instances} bot={bot} />
          </Section>
          <Section title={t("chat.usage.details.allowance")}>
            <AccountAllowance instanceId={instanceId} instanceName={instanceName} open={open} />
          </Section>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function ChatUsageEntry({ bot, instances }: { bot: Bot; instances: AppState["instances"] }) {
  const [open, setOpen] = useState(false);
  const usage = taskUsageForThread(bot);
  const share = usage ? contextShare(usage) : null;
  const hasUsage = Boolean(usage && (usage.turns > 0 || usage.input + usage.output > 0));
  const compact = share?.percent !== undefined
    ? t("chat.usage.contextShort", { value: `${share.percent}%` })
    : share
      ? contextChip(usage!)
      : hasUsage
        ? t("chat.usage.menu")
        : t("chat.usage.details.title");
  const tone = share?.tone === "danger" ? "text-danger border-danger/30" : share?.tone === "warning" ? "text-warning border-warning/30" : "text-ink-secondary border-hairline/40 hover:text-ink";
  const labelText = share ? compact : hasUsage ? t("chat.usage.menu") : t("chat.usage.details.title");

  return (
    <>
      <button
        type="button"
        data-testid="chat-usage-entry"
        onClick={() => setOpen(true)}
        className={cn("flex min-h-11 items-center gap-1.5 rounded-full border bg-raised/60 px-3 text-[12px] hover:bg-raised", tone)}
        title={t("chat.usage.details.title")}
        aria-label={t("chat.usage.details.openAria")}
      >
        <Gauge size={14} className="shrink-0" />
        <span className="tabular-nums">{labelText}</span>
      </button>
      {open && <ChatUsageDetailsDialog open={open} bot={bot} instances={instances} onClose={() => setOpen(false)} />}
    </>
  );
}
