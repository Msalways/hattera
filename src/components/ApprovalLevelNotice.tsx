import { useEffect, useState } from "react";

import { approvalModeFor, type ApprovalMode } from "../../shared/approval-mode";
import { levelChangeStale, useLevelChangeNotice } from "@/lib/level-change";
import { t } from "@/lib/i18n";
import { approvalModeOptions } from "./ApprovalModeSelector";

/** How long a level change may take before the notice says it is slow. */
const SLOW_MS = 4000;

const levelLabel = (mode: ApprovalMode | undefined) =>
  approvalModeOptions().find((option) => option.mode === mode)?.label ?? mode ?? "";

/** The line under the composer after a person changes a thread's approval
 * level: what it affects (this thread, not the bot's default), what the
 * running step uses now, and when the change lands. Announced politely to
 * screen readers. It says "applies after this step" for an engine that can't
 * take the level mid-turn, and never implies the running step was stopped. */
export function ApprovalLevelNotice({ threadId, busy, savedMode }: { threadId: string; busy: boolean; savedMode: ApprovalMode }) {
  const notice = useLevelChangeNotice(threadId);
  const [slow, setSlow] = useState(false);
  const saving = notice?.status === "saving";
  useEffect(() => {
    setSlow(false);
    if (!saving) return;
    const timer = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(timer);
  }, [saving, notice?.at]);
  if (!notice || levelChangeStale(notice, busy)) return <div role="status" aria-live="polite" className="sr-only" />;
  const level = levelLabel(notice.requested);
  let text: string;
  if (notice.status === "saving") {
    text = slow
      ? t("approvalMode.notice.slow", { level, effective: levelLabel(savedMode) })
      : t("approvalMode.notice.saving", { level });
  } else if (notice.status === "failed") {
    text = t("approvalMode.notice.failed", { level, error: notice.error ?? "", effective: levelLabel(savedMode) });
  } else if (notice.appliesAt === "next-turn") {
    text = t("approvalMode.notice.nextTurn", { level, effective: levelLabel(notice.effective ?? approvalModeFor({})) });
  } else if (notice.appliesAt === "now") {
    text = t("approvalMode.notice.now", { level });
  } else {
    text = t("approvalMode.notice.idle", { level });
  }
  const resolved = notice.status === "done" && notice.resolved ? ` ${t("approvalMode.notice.resolved", { count: String(notice.resolved) })}` : "";
  const open = notice.status === "done" && notice.stillOpen ? ` ${t("approvalMode.notice.stillOpen", { count: String(notice.stillOpen) })}` : "";
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="approval-level-notice"
      data-state={notice.status === "done" ? notice.appliesAt : notice.status}
      className={notice.status === "failed" ? "px-3 pt-1.5 text-[12.5px] text-danger" : "px-3 pt-1.5 text-[12.5px] text-ink-secondary"}
    >
      {text}{resolved}{open}
    </div>
  );
}
