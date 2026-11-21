import { Ban, Check, ChevronRight, Loader2, X } from "lucide-react";
import { useState } from "react";
import type { Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { placeLabelKey, type Place } from "@/lib/place";
import { shownDurationMs, toolDiff, toolKind, toolStatus, toolTarget, type ToolRowStatus } from "@/lib/tool-rows";
import { formatElapsed } from "@/lib/working-time";
import { nameIsCommand } from "@/lib/verify-steps";
import { PlaceIcon } from "./PlaceIcon";

const STATUS_KEY = {
  running: "toolRow.running",
  done: "toolRow.done",
  failed: "toolRow.failed",
  cancelled: "toolRow.cancelled",
} as const satisfies Record<ToolRowStatus, string>;

/** The status as a glyph. Always paired with the status word, so neither
 * colour nor motion carries the meaning alone. Icons, never typed characters. */
function StatusGlyph({ status }: { status: ToolRowStatus }) {
  if (status === "running") return <Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />;
  if (status === "failed") return <X size={13} aria-hidden="true" />;
  if (status === "cancelled") return <Ban size={13} aria-hidden="true" />;
  return <Check size={13} className="text-success" aria-hidden="true" />;
}

function DiffPreview({ lines }: { lines: string[] }) {
  return (
    <pre dir="ltr" data-testid="tool-diff" tabIndex={0} aria-label={t("toolRow.diff")} className="max-h-56 overflow-auto rounded-lg bg-inset p-2.5 font-mono text-xs text-ink">
      {lines.map((line, i) => (
        <span key={i} className={cn("block whitespace-pre", line.startsWith("+") && !line.startsWith("+++") && "text-success", line.startsWith("-") && !line.startsWith("---") && "text-danger", line.startsWith("@@") && "text-ink-secondary")}>{line || " "}</span>
      ))}
    </pre>
  );
}

/** One tool call, inline in the turn at the position it started. A native
 * disclosure: status word, verb, target and (only when measured) duration on
 * the row; real Input and Result, and a diff for an edit, when opened. The
 * same row updates in place as the call's status changes. */
export function ToolActivity({
  tool,
  place = null,
  turnActive = true,
}: {
  tool: NonNullable<Message["tool"]>;
  /** where a screen or page tool ran, so the transcript shows the place of every step */
  place?: Place | null;
  /** the turn this call belongs to is still going; false turns an unfinished call into Cancelled */
  turnActive?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const status = toolStatus(tool, turnActive);
  const statusText = t(STATUS_KEY[status]);
  const kind = toolKind(tool.name);
  const target = nameIsCommand(tool.name) ? "" : toolTarget(tool);
  const diff = kind === "edit" ? toolDiff(tool) : null;
  // the result already is the diff: show it once, as the diff, not again as raw text
  const outputIsDiff = diff !== null && !!tool.output && toolDiff({ name: tool.name, output: tool.output }) !== null;
  const measured = status === "running" ? null : shownDurationMs(tool.durationMs);
  const duration = measured === null ? null : formatElapsed(measured);
  return (
    <details onToggle={(event) => setExpanded(event.currentTarget.open)} className="group/tool w-full max-w-full rounded-xl border border-hairline/40 bg-panel text-[13px]" data-testid="tool-activity" data-tool-row data-status={status}>
      <summary
        role="button"
        aria-expanded={expanded}
        aria-label={t("toolRow.label", { name: tool.name, status: statusText })}
        className={cn("flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-1.5 hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden", status === "failed" ? "text-danger" : "text-ink-secondary")}
      >
        <ChevronRight size={13} className="shrink-0 group-open/tool:rotate-90 rtl:rotate-180" aria-hidden="true" />
        {place && <PlaceIcon place={place} size={13} className="shrink-0 opacity-70" role="img" aria-label={t(placeLabelKey(place))} data-testid="tool-place" />}
        <span className="min-w-0 max-w-[30rem] truncate font-mono">{tool.name}</span>
        {target && <span className="min-w-0 flex-1 truncate font-mono text-ink-tertiary" title={target}>{target}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[12px]" data-testid="tool-status">
          <StatusGlyph status={status} />
          <span>{statusText}</span>
          {duration && <span className="text-ink-tertiary" data-testid="tool-duration">· {duration}</span>}
        </span>
      </summary>
      <div className="space-y-3 border-t border-hairline/40 p-3 text-ink-secondary">
        <div>
          <div className="mb-1 text-[11px] font-medium">{t("toolDetail.input")}</div>
          <pre dir="ltr" className="max-h-52 overflow-auto rounded-lg bg-inset p-2.5 font-mono text-xs whitespace-pre-wrap break-words text-ink">{tool.input ?? tool.summary ?? tool.name}</pre>
        </div>
        <div>
          <div className="mb-1 text-[11px] font-medium">{t("toolDetail.output")}</div>
          {outputIsDiff && diff ? <DiffPreview lines={diff} /> : tool.output ? <pre dir="ltr" className="max-h-64 overflow-auto rounded-lg bg-inset p-2.5 font-mono text-xs whitespace-pre-wrap break-words text-ink">{tool.output}</pre> : <p className="text-xs">{status === "running" ? t("toolDetail.waiting") : status === "cancelled" ? t("toolRow.noResultCancelled") : t("toolDetail.noOutput")}</p>}
        </div>
        {kind === "edit" && !outputIsDiff && (
          <div>
            {diff ? <DiffPreview lines={diff} /> : <p className="text-xs" data-testid="tool-diff-unavailable">{t("toolRow.diffUnavailable")}</p>}
          </div>
        )}
        <p className="text-[11px] text-ink-secondary">{t("toolDetail.previewHint")}</p>
      </div>
    </details>
  );
}
