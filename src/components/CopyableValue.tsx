import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useCopyFeedback } from "@/lib/copy-text";

/** A copy action that writes exactly `value` (the original command or path,
 * never a shortened display form) and says so to assistive technology. */
export function CopyButton({ value, label, className }: { value: string; label: string; className?: string }) {
  const { state, copy } = useCopyFeedback(value);
  return (
    <>
      <button
        type="button"
        onClick={copy}
        aria-label={label}
        title={label}
        className={cn("flex min-h-8 min-w-8 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink", className)}
      >
        {state === "copied" ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
      </button>
      <span role="status" className="sr-only">{state === "copied" ? t("chat.export.copied") : state === "failed" ? t("common.copyFailed") : ""}</span>
    </>
  );
}

/** A literal value (command, path) in its own code element, followed by a copy
 * action. `display` is what shows (possibly shortened); `value` is what is
 * copied and what the title/aria text carries in full. */
export function CopyableValue({
  value,
  display,
  copyLabel,
  className,
}: {
  value: string;
  display?: string;
  copyLabel: string;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex min-w-0 max-w-full items-center gap-1.5 align-middle", className)}>
      <code
        className="min-w-0 break-all rounded bg-inset px-1.5 py-0.5 font-mono text-[12px] text-ink"
        title={value}
        // Focusable so the full value is reachable by keyboard, not only hover.
        tabIndex={display !== undefined && display !== value ? 0 : undefined}
        aria-label={display !== undefined && display !== value ? `${t("path.fullLabel")}: ${value}` : undefined}
      >{display ?? value}</code>
      <CopyButton value={value} label={copyLabel} />
    </span>
  );
}
