// Narrowly scoped document preview for delivered/authorized text plans.
// Uses the same message-scoped file authorization as downloads; never requests
// transcript paths directly.
import { lazy, Suspense, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Eye, LoaderCircle, X } from "lucide-react";
import type { MessageAttachmentContext } from "./AttachmentPreview";
import { t } from "@/lib/i18n";

const LazyChatMarkdown = lazy(() => import("./ChatMarkdown").then((m) => ({ default: m.ChatMarkdown })));

export const DOCUMENT_PREVIEW_MAX_BYTES = 1024 * 1024;
export const DOCUMENT_PREVIEW_MAX_LINES = 20_000;

export type DocumentPreviewKind = "markdown" | "text" | "html-source";

function extOf(name: string): string {
  return /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
}

/** Previewable delivered/linked text documents. CSV/TSV use the existing table
 *  machinery where it fits and are not handled here. */
export function documentPreviewKind(nameOrPath: string): DocumentPreviewKind | null {
  const ext = extOf(nameOrPath);
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "txt" || ext === "text") return "text";
  if (ext === "html" || ext === "htm") return "html-source";
  return null;
}

export function isDocumentPreviewable(nameOrPath: string): boolean {
  return documentPreviewKind(nameOrPath) !== null;
}

export interface DocumentPreviewResult {
  text: string;
  truncatedBytes: boolean;
  truncatedLines: boolean;
}

/** Count line breaks without splitting the whole text into an array copy. */
export function countTextLines(text: string): number {
  if (!text) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
  return lines;
}

/** Trim to at most maxLines, returning the prefix and whether it was cut. */
export function truncateToLines(text: string, maxLines: number): { text: string; truncated: boolean } {
  if (maxLines <= 0) return { text: "", truncated: text.length > 0 };
  let seen = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      seen++;
      if (seen >= maxLines) return { text: text.slice(0, i), truncated: true };
    }
  }
  return { text, truncated: false };
}

const MB = 1024 * 1024;
function byteLimitLabel(bytes: number): string {
  return `${Math.round(bytes / MB)} MiB`;
}

function utf8SafePrefixLength(bytes: Uint8Array): number {
  let end = bytes.length;
  // If the final byte starts a multi-byte sequence or continues one, back up to
  // a code-point boundary so decoding never produces U+FFFD/lone surrogates.
  while (end > 0) {
    const b = bytes[end - 1]!;
    if ((b & 0x80) === 0) return end; // ASCII
    if ((b & 0xc0) === 0xc0) {
      // Lead byte: keep only if the full sequence is present.
      const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2;
      return end - 1 + need <= bytes.length ? end : end - 1;
    }
    // Continuation byte (10xxxxxx): find its lead byte.
    let lead = end - 1;
    while (lead > 0 && (bytes[lead - 1]! & 0xc0) === 0x80) lead--;
    if (lead === 0) return 0;
    const lb = bytes[lead - 1]!;
    if ((lb & 0xc0) !== 0xc0) return end; // malformed, let decoder handle prefix
    const need = lb >= 0xf0 ? 4 : lb >= 0xe0 ? 3 : 2;
    const have = end - (lead - 1);
    if (have >= need) return end;
    end = lead - 1;
  }
  return 0;
}

/** Stream response text with hard byte and rendered-line caps. Bytes are sliced
 *  exactly before decoding; an incomplete UTF-8 scalar at the cap is dropped. */
export async function readDocumentPreviewResponse(
  response: Response,
  signal: AbortSignal,
  { maxBytes = DOCUMENT_PREVIEW_MAX_BYTES, maxLines = DOCUMENT_PREVIEW_MAX_LINES } = {},
): Promise<DocumentPreviewResult> {
  const reader = response.body?.getReader();
  if (!reader) return { text: "", truncatedBytes: false, truncatedLines: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncatedBytes = false;
  try {
    while (true) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const { value, done } = await reader.read();
      if (done) break;
      if (total >= maxBytes) {
        truncatedBytes = true;
        break;
      }
      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        chunks.push(value.slice(0, remaining));
        total += remaining;
        truncatedBytes = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const safe = bytes.subarray(0, utf8SafePrefixLength(bytes));
  let text = new TextDecoder("utf-8").decode(safe);
  let truncatedLines = false;
  if (countTextLines(text) > maxLines) {
    const cut = truncateToLines(text, maxLines);
    text = cut.text;
    truncatedLines = cut.truncated;
  }
  return { text, truncatedBytes, truncatedLines };
}

function tSafe(key: string, params?: Record<string, string | number>): string {
  return (t as (k: string, p?: Record<string, string | number>) => string)(key, params);
}

/** Native dialog supplies focus containment, Escape, inertness, and restoration. */
export function DocumentPreviewDialog({ title, onClose, children, returnFocus }: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  returnFocus: HTMLElement | null;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      if (returnFocus?.isConnected) returnFocus.focus();
    };
  }, [returnFocus]);
  return createPortal(
    <dialog
      ref={ref}
      aria-labelledby={id}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClose={onClose}
      onKeyDown={(event) => { if (event.key === "Escape") event.stopPropagation(); }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="m-auto flex h-[min(92dvh,52rem)] max-h-[92dvh] w-[min(96vw,56rem)] min-w-0 max-w-none flex-col overflow-hidden rounded-2xl border border-hairline bg-panel p-0 text-ink shadow-2xl backdrop:bg-black/55 max-[360px]:w-[calc(100vw-0.5rem)] max-[360px]:max-h-[calc(100dvh-0.5rem)] max-[360px]:rounded-xl"
    >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-hairline/40 px-3 py-2.5 sm:px-4 sm:py-3">
        <h2 id={id} className="min-w-0 truncate text-sm font-medium" title={title}>{title}</h2>
        <button
          type="button"
          autoFocus
          onClick={onClose}
          className="flex size-11 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          aria-label={tSafe("attach.closePreview")}
        >
          <X size={18} />
        </button>
      </header>
      <div className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain p-3 sm:p-4">{children}</div>
    </dialog>,
    document.body,
  );
}

function PreviewBody({ text, kind }: { text: string; kind: DocumentPreviewKind }) {
  if (kind === "html-source" || kind === "text") {
    return (
      <div className="min-w-0">
        {kind === "html-source" && (
          <p className="mb-2 text-[12px] text-ink-secondary">{tSafe("attach.previewSourceNote")}</p>
        )}
        <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-xl border border-hairline/40 bg-inset/40 p-3 text-[12px] leading-relaxed text-ink [tab-size:2]">
          {text}
        </pre>
      </div>
    );
  }
  return (
    <div className="min-w-0">
      <Suspense fallback={<div role="status" className="p-4 text-sm text-ink-secondary">{tSafe("attach.previewLoadingDocument")}</div>}>
        <LazyChatMarkdown text={text} portable />
      </Suspense>
    </div>
  );
}

export function DocumentPreviewContent({ path, name, message, kind }: {
  path: string;
  name: string;
  message: MessageAttachmentContext;
  kind: DocumentPreviewKind;
}) {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; result: DocumentPreviewResult }
    | { status: "failed"; message: string }
  >({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    const id = ++generation.current;
    const controller = new AbortController();
    setState({ status: "loading" });
    void (async () => {
      try {
        const { requestMessageFile } = await import("./AttachmentPreview");
        const response = await requestMessageFile(path, message, controller.signal);
        const result = await readDocumentPreviewResponse(response, controller.signal);
        if (controller.signal.aborted || generation.current !== id) return;
        setState({ status: "ready", result });
      } catch (reason) {
        if (controller.signal.aborted || generation.current !== id) return;
        setState({
          status: "failed",
          message: reason instanceof Error ? reason.message : tSafe("attach.previewUnavailableDocument"),
        });
      }
    })();
    return () => {
      controller.abort();
    };
  }, [path, name, message.threadId, message.messageId, kind, attempt]);

  if (state.status === "loading") {
    return (
      <div role="status" className="flex items-center justify-center gap-2 p-10 text-sm text-ink-secondary">
        <LoaderCircle size={16} className="animate-spin" />
        {tSafe("attach.previewLoadingDocument")}
      </div>
    );
  }
  if (state.status === "failed") {
    return (
      <div className="p-6 text-center text-sm">
        <p role="alert" className="mb-3 text-ink-secondary">{state.message}</p>
        <button
          type="button"
          className="rounded-lg border border-hairline px-3 py-2 hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          onClick={() => setAttempt((n) => n + 1)}
        >
          {t("chat.retry")}
        </button>
      </div>
    );
  }
  const { result } = state;
  const notices: string[] = [];
  if (result.truncatedBytes) notices.push(tSafe("attach.previewTruncatedBytes", { limit: byteLimitLabel(DOCUMENT_PREVIEW_MAX_BYTES) }));
  if (result.truncatedLines) notices.push(tSafe("attach.previewTruncatedLines", { limit: DOCUMENT_PREVIEW_MAX_LINES.toLocaleString() }));
  return (
    <div className="min-w-0">
      {notices.length > 0 && (
        <div role="status" className="mb-3 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-ink">
          {notices.join(" ")}
        </div>
      )}
      <PreviewBody text={result.text} kind={kind} />
    </div>
  );
}

export function DocumentPreviewButton({ path, name, message, className }: {
  path: string;
  name: string;
  message: MessageAttachmentContext;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const kind = documentPreviewKind(name) ?? documentPreviewKind(path);
  if (!kind) return null;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={className ?? "table-action"}
        title={tSafe("attach.previewAriaDocument", { name })}
        aria-label={tSafe("attach.previewAriaDocument", { name })}
        onClick={() => setOpen(true)}
      >
        <Eye size={14} />
      </button>
      {open && (
        <DocumentPreviewDialog title={name} returnFocus={trigger.current} onClose={() => setOpen(false)}>
          <DocumentPreviewContent key={`${message.threadId}:${message.messageId}:${path}:${kind}`} path={path} name={name} message={message} kind={kind} />
        </DocumentPreviewDialog>
      )}
    </>
  );
}
