import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { t } from "@/lib/i18n";
import { useModalDialog } from "@/hooks/use-modal-dialog";
import { cn } from "@/lib/cn";

/** One dialog anatomy: an opaque surface over an overlay, a labelled title, a
 * close button, an optional description, a scrolling body and a footer with a
 * secondary Cancel and a primary action. Focus moves to the first field,
 * stays inside, and returns to the opener; Escape and the overlay dismiss
 * unless `busy`. On a narrow screen the surface fits the viewport with a
 * margin and only the body scrolls, so the footer stays reachable. */
export function SharedDialog({
  title, description, onClose, busy = false, children, cancelLabel, primary, initialFocus, size = "md", onSubmit, testId,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  /** A request is in flight: dismissal is held back. */
  busy?: boolean;
  children: ReactNode;
  cancelLabel?: string;
  primary: { label: string; disabled?: boolean };
  /** The field that takes focus on open; defaults to the first field in the body. */
  initialFocus?: RefObject<HTMLElement | null>;
  size?: "md" | "lg";
  /** Enter in a field and the primary action both come here. */
  onSubmit: () => void;
  testId?: string;
}) {
  const id = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const close = () => { if (!busy) onClose(); };
  useModalDialog(dialog, close);
  useEffect(() => {
    const field = initialFocus?.current
      ?? body.current?.querySelector<HTMLElement>("input:not([disabled]), select:not([disabled]), textarea:not([disabled])");
    field?.focus();
  }, [initialFocus]);
  return createPortal(
    <div data-thread-overlay className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 sm:p-4"
      onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div ref={dialog} role="dialog" aria-modal="true" tabIndex={-1} aria-labelledby={`${id}-title`}
        aria-describedby={description ? `${id}-desc` : undefined} aria-busy={busy || undefined} data-testid={testId}
        className={cn("flex max-h-[calc(100dvh-1.5rem)] w-full flex-col overflow-hidden rounded-2xl border border-hairline bg-panel text-ink shadow-2xl outline-none sm:max-h-[min(720px,calc(100dvh-2rem))]", size === "lg" ? "max-w-[520px]" : "max-w-[430px]")}>
        <form noValidate className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => { event.preventDefault(); if (!busy) onSubmit(); }}>
          <div className="flex shrink-0 items-start justify-between gap-3 px-5 pb-2 pt-5">
            <div className="min-w-0">
              <h2 id={`${id}-title`} className="break-words text-[17px] font-semibold">{title}</h2>
              {description && <p id={`${id}-desc`} className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{description}</p>}
            </div>
            <button type="button" aria-label={t("common.close")} disabled={busy} onClick={close}
              className="-mr-1.5 -mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised sm:h-9 sm:w-9"><X size={18} /></button>
          </div>
          <div ref={body} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-2 pt-2">{children}</div>
          <div className="flex shrink-0 justify-end gap-2 border-t border-hairline/50 px-5 py-3">
            <button type="button" disabled={busy} onClick={close}
              className="min-h-11 rounded-lg px-4 text-[13px] text-ink-secondary hover:bg-raised sm:min-h-9">{cancelLabel ?? t("common.cancel")}</button>
            <button type="submit" disabled={busy || primary.disabled}
              className="min-h-11 rounded-lg bg-accent px-4 text-[13px] font-medium text-white disabled:opacity-40 sm:min-h-9">{primary.label}</button>
          </div>
        </form>
      </div>
    </div>, document.body);
}

/** A labelled field with persistent label, optional help and an inline error
 * tied to the control. Pass the control a `describedBy` and `invalid`. */
export function DialogField({ label, help, error, children }: {
  label: string;
  help?: string;
  error?: string | null;
  children: (props: { id: string; "aria-describedby": string | undefined; "aria-invalid": true | undefined }) => ReactNode;
}) {
  const id = useId();
  const describedBy = [help ? `${id}-help` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="mb-3">
      <label htmlFor={id} className="mb-1 block text-[13px] font-medium text-ink">{label}</label>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {help && <p id={`${id}-help`} className="mt-1 text-[12px] text-ink-secondary">{help}</p>}
      {error && <p id={`${id}-error`} role="alert" className="mt-1 text-[13px] text-danger">{error}</p>}
    </div>
  );
}

/** Classes for a text input or select inside a DialogField; the border turns
 * to the danger colour only with an error, and an icon-free text message
 * carries it as well, so colour is not the only signal. */
export function dialogControlClass(invalid: boolean): string {
  return cn("w-full rounded-lg border bg-inset px-3 py-2 text-[14px] text-ink min-h-11 sm:min-h-9", invalid ? "border-danger" : "border-hairline");
}
