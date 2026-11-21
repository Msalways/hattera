// A stretch of finished tool calls, inline and in order (UX-10 S4).
//
// Nothing is hidden behind a generic "N steps" pill any more: every call is
// its own row at its own position. Only adjacent, successful Read calls
// collapse into one "Read N files" disclosure, which reveals each row. A
// search hit inside a group opens it.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronRight } from "lucide-react";
import type { Message } from "@/state/store";
import { segmentToolRun } from "@/lib/tool-rows";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";

export function ReadGroup({ id, messages, forceOpen = false, renderStep }: { id?: string; messages: Message[]; forceOpen?: boolean; renderStep: (message: Message) => React.ReactNode }) {
  const [open, setOpen] = useState(forceOpen);
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);
  return (
    <div className="flex flex-col gap-1" data-testid="tool-group" data-tool-row data-group-id={id}>
      <button
        type="button"
        data-group-toggle
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
  // Keyboard focus survives a regroup. When consecutive Reads finish they stop
  // being separate rows and become one group, which unmounts the row that held
  // focus and would drop the reader to the page. Remember which row focus was
  // in; if it was unmounted by a render, hand focus to the control that now
  // stands for it (the group's toggle). Focus that the reader moved elsewhere
  // is never taken back.
  const root = useRef<HTMLDivElement>(null);
  const focused = useRef<{ element: HTMLElement; messageId: string | undefined } | null>(null);
  useLayoutEffect(() => {
    const held = focused.current;
    if (!held || held.element.isConnected) return;
    const active = document.activeElement;
    if (active && active !== document.body) {
      focused.current = null;
      return;
    }
    const group = segments.find((segment) => segment.kind === "group" && segment.messages.some((message) => message.id === held.messageId));
    const container = root.current;
    const target = container && (group?.kind === "group"
      ? [...container.querySelectorAll<HTMLElement>("[data-group-id]")].find((node) => node.dataset.groupId === group.id)?.querySelector<HTMLElement>("[data-group-toggle]")
      : held.messageId
        ? [...container.querySelectorAll<HTMLElement>("[data-mid]")].find((node) => node.dataset.mid === held.messageId)?.querySelector<HTMLElement>("summary, button, [tabindex]")
        : null);
    if (target) {
      target.focus();
      focused.current = { element: target, messageId: held.messageId };
    } else focused.current = null;
  });
  return (
    <div
      ref={root}
      className="flex flex-col gap-1"
      onFocusCapture={(event) => {
        const element = event.target as HTMLElement;
        const row = element.closest<HTMLElement>("[data-mid]");
        focused.current = { element, messageId: row?.dataset.mid ?? focused.current?.messageId };
      }}
      onBlurCapture={(event) => {
        // a blur because the row was removed keeps the memory; one to somewhere else clears it
        const element = event.target as HTMLElement;
        if (event.relatedTarget) focused.current = null;
        else queueMicrotask(() => {
          if (focused.current?.element === element && element.isConnected) focused.current = null;
        });
      }}
    >
      {segments.map((segment) =>
        segment.kind === "group" ? (
          <ReadGroup key={segment.id} id={segment.id} messages={segment.messages} forceOpen={segment.messages.some((message) => message.id === focusedId)} renderStep={renderStep} />
        ) : (
          <div key={segment.message.id} className="contents" data-mid={segment.message.id}>{renderStep(segment.message)}</div>
        ),
      )}
    </div>
  );
}
