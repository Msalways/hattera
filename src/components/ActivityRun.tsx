// A stretch of finished tool calls, inline and in order (UX-10 S4).
//
// Nothing is hidden behind a generic "N steps" pill any more: every call is
// its own row at its own position. Only adjacent, successful Read calls
// collapse into one "Read N files" disclosure, which reveals each row. A
// search hit inside a group opens it.
import { useEffect, useState } from "react";
import { Check, ChevronRight } from "lucide-react";
import type { Message } from "@/state/store";
import { segmentToolRun } from "@/lib/tool-rows";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";

export function ReadGroup({ messages, forceOpen = false, renderStep }: { messages: Message[]; forceOpen?: boolean; renderStep: (message: Message) => React.ReactNode }) {
  const [open, setOpen] = useState(forceOpen);
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);
  return (
    <div className="flex flex-col gap-1" data-testid="tool-group" data-tool-row>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex min-h-11 w-full items-center gap-2 rounded-xl border border-hairline/40 bg-panel px-3 py-1.5 text-left text-[13px] text-ink-secondary hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <ChevronRight size={13} className={cn("shrink-0 rtl:rotate-180", open && "rotate-90")} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{t("toolRow.readFiles", { count: messages.length })}</span>
        <span className="flex shrink-0 items-center gap-1.5 text-[12px]">
          <Check size={13} className="text-success" aria-hidden="true" />
          <span>{t("toolRow.done")}</span>
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-1 ps-4">
          {messages.map((message) => (
            <div key={message.id} className="contents" data-mid={message.id}>{renderStep(message)}</div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ActivityRun({
  messages,
  focusedId = null,
  renderStep,
}: {
  messages: Message[];
  /** the step a search hit is landing on, so the group holding it opens */
  focusedId?: string | null;
  /** one row, rendered by whichever transcript owns it */
  renderStep: (message: Message) => React.ReactNode;
}) {
  const segments = segmentToolRun(messages, false);
  return (
    <div className="flex flex-col gap-1">
      {segments.map((segment) =>
        segment.kind === "group" ? (
          <ReadGroup key={segment.id} messages={segment.messages} forceOpen={segment.messages.some((message) => message.id === focusedId)} renderStep={renderStep} />
        ) : (
          <div key={segment.message.id} className="contents" data-mid={segment.message.id}>{renderStep(segment.message)}</div>
        ),
      )}
    </div>
  );
}
