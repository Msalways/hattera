// The single file preview surface. Desktop (>=1024px): a nonmodal right side
// panel next to the chat. Narrower: a full-screen modal sheet. One header, one
// set of states, a type-specific body. Opening never downloads; Download is its
// own labelled action and goes through the same message-scoped request.
import { lazy, Suspense, useEffect, useId, useMemo, useReducer, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Download, ExternalLink, LoaderCircle, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useMediaQuery } from "@/lib/use-media-query";
import {
  canDownload, codeLanguage, formatBytes, NO_META, previewIdentity, previewKind, previewReducer, splitFileName, typeLabel,
  type PreviewFile, type PreviewState,
} from "@/lib/file-preview";
import { loadPreview, loadVideoUrl, PreviewLoadError, type PreviewLoadDeps } from "@/lib/file-preview-load";
import { closeFilePreview, useFilePreview } from "@/lib/file-preview-store";
import { readDocumentPreviewResponse } from "./DocumentPreview";
import { requestMessageFile, useLocalFileSave } from "./AttachmentPreview";
import { readTableResponse } from "./TableFilePreview";
import { RichTable } from "./RichTable";

const LazyChatMarkdown = lazy(() => import("./ChatMarkdown").then((m) => ({ default: m.ChatMarkdown })));

export const DESKTOP_PREVIEW = "(min-width: 1024px)";

export function realPreviewDeps(): PreviewLoadDeps {
  return {
    request: (path, message, signal) => requestMessageFile(path, message, signal),
    readText: (response, signal) => readDocumentPreviewResponse(response, signal),
    readTable: readTableResponse,
    objectUrl: (blob) => URL.createObjectURL(blob),
    parseTable: (text, delimiter, signal) => new Promise((resolve, reject) => {
      const worker = new Worker(new URL("../lib/table-file.worker.ts", import.meta.url), { type: "module" });
      const stop = () => { worker.terminate(); reject(new DOMException("Aborted", "AbortError")); };
      signal.addEventListener("abort", stop, { once: true });
      worker.onmessage = (event: MessageEvent<{ table?: { headers: string[]; rows: string[][] }; error?: string }>) => {
        signal.removeEventListener("abort", stop);
        worker.terminate();
        if (event.data.table) resolve(event.data.table); else reject(new Error(event.data.error ?? "format"));
      };
      worker.onerror = () => { signal.removeEventListener("abort", stop); worker.terminate(); reject(new Error("format")); };
      worker.postMessage({ text, delimiter });
    }),
  };
}

/** Loads one file; a slower answer for any earlier file or attempt is ignored. */
export function useFilePreviewLoad(file: PreviewFile, nonce: number, deps: PreviewLoadDeps) {
  const [state, dispatch] = useReducer(previewReducer, { status: "idle" } as PreviewState);
  const [attempt, setAttempt] = useState(0);
  const counter = useRef({ n: 0 });
  const id = previewIdentity(file);
  useEffect(() => {
    const request = ++counter.current.n;
    const controller = new AbortController();
    dispatch({ type: "open", id, request });
    loadPreview(file, deps, controller.signal).then(
      ({ meta, body }) => dispatch({ type: "settled", id, request, meta, body }),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        dispatch(error instanceof PreviewLoadError
          ? { type: "failed", id, request, failure: error.failure, meta: error.meta }
          : { type: "failed", id, request, failure: "failed" });
      },
    );
    return () => controller.abort();
    // `file` is covered by its identity; `deps` is stable per surface
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, nonce, attempt]);
  // never show a state that belongs to another file, even for one render
  const own = state.status !== "idle" && state.id === id ? state : ({ status: "loading", id, request: 0 } as PreviewState);
  return { state: own, retry: () => setAttempt((n) => n + 1) };
}

function Notice({ role = "status", title, children }: { role?: "status" | "alert"; title: string; children?: ReactNode }) {
  return (
    <div role={role} className="mx-auto max-w-sm p-6 text-center text-sm">
      <p className="font-medium text-ink">{title}</p>
      {children && <div className="mt-2 text-ink-secondary">{children}</div>}
    </div>
  );
}

const BUTTON = "inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg border border-hairline px-3 text-[13px] text-ink hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60";

function Tabs({ value, onChange }: { value: "output" | "raw"; onChange: (value: "output" | "raw") => void }) {
  const order = ["output", "raw"] as const;
  return (
    <div role="tablist" aria-label={t("filePreview.view")} className="mb-3 inline-flex rounded-lg border border-hairline p-0.5">
      {order.map((tab) => (
        <button
          key={tab}
          type="button"
          role="tab"
          id={`file-preview-tab-${tab}`}
          aria-selected={value === tab}
          aria-controls="file-preview-view"
          tabIndex={value === tab ? 0 : -1}
          onClick={() => onChange(tab)}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
              const next = order[(order.indexOf(tab) + 1) % order.length]!;
              onChange(next);
              document.getElementById(`file-preview-tab-${next}`)?.focus();
            }
          }}
          className={cn("min-h-11 rounded-md px-3 text-[13px] focus-visible:outline-2 focus-visible:outline-accent", value === tab ? "bg-raised text-ink" : "text-ink-secondary hover:text-ink")}
        >
          {t(tab === "output" ? "filePreview.output" : "filePreview.raw")}
        </button>
      ))}
    </div>
  );
}

function VideoBody({ file, deps }: { file: PreviewFile; deps: PreviewLoadDeps }) {
  const [url, setUrl] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "loading" | "failed">("idle");
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  if (url) return <video src={url} controls autoPlay className="max-h-full max-w-full rounded-lg" aria-label={file.name} />;
  return (
    <div className="p-6 text-center text-sm">
      <button
        type="button"
        className={BUTTON}
        disabled={phase === "loading"}
        onClick={() => {
          setPhase("loading");
          void loadVideoUrl(file, deps, new AbortController().signal).then(
            (next) => setUrl(next),
            () => setPhase("failed"),
          );
        }}
      >
        {phase === "loading" ? <LoaderCircle size={14} className="animate-spin" aria-hidden="true" /> : null}
        {t("filePreview.play", { name: file.name })}
      </button>
      {phase === "failed" && <p role="alert" className="mt-2 text-danger">{t("filePreview.failed")}</p>}
    </div>
  );
}

function Body({ file, state, retry, deps, download }: { file: PreviewFile; state: PreviewState; retry: () => void; deps: PreviewLoadDeps; download: ReactNode }) {
  const kind = previewKind(file.name);
  // Output first whenever there is an output to show
  const [view, setView] = useState<"output" | "raw">("output");
  if (state.status === "idle" || state.status === "loading") {
    return <div role="status" className="flex items-center justify-center gap-2 p-10 text-sm text-ink-secondary"><LoaderCircle size={16} className="animate-spin" aria-hidden="true" />{t("filePreview.loading")}</div>;
  }
  if (state.status === "failed") {
    const f = state.failure;
    if (f === "denied") return <Notice role="alert" title={t("filePreview.denied")}>{t("filePreview.deniedHint")}</Notice>;
    if (f === "missing") return <Notice role="alert" title={t("filePreview.missing")} />;
    if (f === "folder") return <Notice title={t("filePreview.folder")} />;
    if (f === "tooLarge") return <Notice role="alert" title={t("filePreview.tooLarge")}><div className="mt-3">{download}</div></Notice>;
    if (f === "malformed") return <Notice role="alert" title={t("filePreview.malformed")}><div className="mt-3">{download}</div></Notice>;
    return (
      <Notice role="alert" title={t("filePreview.failed")}>
        <div className="mt-3 flex flex-wrap justify-center gap-2"><button type="button" className={BUTTON} onClick={retry}>{t("chat.retry")}</button>{download}</div>
      </Notice>
    );
  }
  const { body } = state;
  if (body.kind === "none") {
    return (
      <Notice title={t("filePreview.unsupported")}>
        {t("filePreview.unsupportedDetail", { type: typeLabel(file.name), size: formatBytes(state.meta.bytes) ?? t("filePreview.sizeUnknown") })}
        <div className="mt-3">{download}</div>
      </Notice>
    );
  }
  if (body.kind === "video") return <VideoBody file={file} deps={deps} />;
  if (body.kind === "image") return <div className="flex justify-center"><img src={body.url} alt={file.name} className="max-h-full max-w-full object-contain" /></div>;
  if (body.kind === "table") {
    const data = { columns: body.table.headers.map((text) => ({ text })), rows: body.table.rows.map((row) => row.map((text) => ({ text }))) };
    return <RichTable {...data} name={file.name} expanded />;
  }
  const notices: string[] = [];
  if (body.truncated.bytes) notices.push(t("filePreview.partialBytes"));
  if (body.truncated.lines) notices.push(t("filePreview.partialLines"));
  const language = codeLanguage(file.name);
  const pre = (
    <pre tabIndex={0} aria-label={language ? t("filePreview.codeLabel", { language }) : undefined} className="overflow-x-auto whitespace-pre-wrap break-words rounded-xl border border-hairline/40 bg-inset/40 p-3 text-[12px] leading-relaxed text-ink [tab-size:2]">{body.text}</pre>
  );
  return (
    <div className="min-w-0">
      {notices.length > 0 && (
        <div role="status" className="mb-3 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-ink">
          {notices.join(" ")} <span className="mt-1 block">{download}</span>
        </div>
      )}
      {kind === "markdown" && <Tabs value={view} onChange={setView} />}
      {kind === "html-source" && <p className="mb-2 text-[12px] text-ink-secondary">{t("attach.previewSourceNote")}</p>}
      <div id="file-preview-view" role={kind === "markdown" ? "tabpanel" : undefined} aria-labelledby={kind === "markdown" ? `file-preview-tab-${view}` : undefined}>
        {kind === "markdown" && view === "output" ? (
          <Suspense fallback={<div role="status" className="p-4 text-sm text-ink-secondary">{t("filePreview.loading")}</div>}>
            <LazyChatMarkdown text={body.text} portable />
          </Suspense>
        ) : pre}
      </div>
    </div>
  );
}

function Header({ file, state, titleRef, titleId, onClose, save }: {
  file: PreviewFile; state: PreviewState; titleRef: RefObject<HTMLHeadingElement | null>; titleId: string; onClose: () => void;
  save: ReturnType<typeof useLocalFileSave>;
}) {
  const meta = state.status === "ready" || state.status === "failed" ? state.meta : NO_META;
  const { stem, tail } = splitFileName(file.name);
  const size = formatBytes(meta.bytes) ?? t("filePreview.sizeUnknown");
  const allowed = canDownload(state, file);
  return (
    <header className="flex shrink-0 items-start gap-2 border-b border-hairline/40 px-3 pb-2 pt-[max(0.625rem,env(safe-area-inset-top))] sm:px-4">
      <div className="min-w-0 flex-1">
        <h2 id={titleId} ref={titleRef} tabIndex={-1} title={file.name} aria-label={file.name} className="flex min-w-0 text-sm font-medium outline-none focus-visible:underline">
          <span className="min-w-0 truncate" dir="auto">{stem}</span><span className="shrink-0">{tail}</span>
        </h2>
        <p className="text-[12px] text-ink-secondary">{typeLabel(file.name)} · {size}</p>
      </div>
      <button type="button" className={BUTTON} disabled={!allowed || save.state === "saving"} onClick={() => void save.save()} aria-label={t("attach.saveAria", { name: file.name })}>
        <Download size={14} aria-hidden="true" /><span>{t("attach.download")}</span>
      </button>
      <button type="button" className={cn(BUTTON, "max-sm:hidden")} disabled aria-disabled="true" title={t("filePreview.newTabUnavailable")} aria-label={`${t("filePreview.newTab")}. ${t("filePreview.newTabUnavailable")}`}>
        <ExternalLink size={14} aria-hidden="true" /><span>{t("filePreview.newTab")}</span>
      </button>
      <button type="button" className={BUTTON} onClick={onClose} aria-label={t("attach.closePreview")}>
        <X size={16} aria-hidden="true" />
      </button>
    </header>
  );
}

function Surface({ file, nonce, onClose, modal }: { file: PreviewFile; nonce: number; onClose: () => void; modal: boolean }) {
  const deps = useMemo(realPreviewDeps, []);
  const { state, retry } = useFilePreviewLoad(file, nonce, deps);
  const save = useLocalFileSave(file.path, file.name, file.message);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const identity = previewIdentity(file);
  useEffect(() => { titleRef.current?.focus(); }, [nonce, identity]);
  const allowed = canDownload(state, file);
  const download = (
    <button type="button" className={BUTTON} disabled={!allowed || save.state === "saving"} onClick={() => void save.save()} aria-label={t("attach.saveAria", { name: file.name })}>
      <Download size={14} aria-hidden="true" />{t("attach.download")}
    </button>
  );
  const content = (
    <>
      <Header file={file} state={state} titleRef={titleRef} titleId={titleId} onClose={onClose} save={save} />
      {save.state === "failed" && <p role="alert" className="px-4 py-1 text-[12px] text-danger">{save.reason}</p>}
      <div data-testid="file-preview-body" className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:p-4">
        <Body key={`${identity}:${nonce}`} file={file} state={state} retry={retry} deps={deps} download={download} />
      </div>
    </>
  );
  if (modal) return <SheetDialog titleId={titleId} onClose={onClose}>{content}</SheetDialog>;
  return (
    <aside
      aria-labelledby={titleId}
      data-file-preview
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}
      className="flex h-full min-w-0 shrink-0 basis-[min(520px,42vw)] flex-col border-s border-hairline/40 bg-panel text-ink"
    >
      {content}
    </aside>
  );
}

/** Native modal: focus containment, inert background and Escape for free. */
function SheetDialog({ titleId, onClose, children }: { titleId: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);
  return createPortal(
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      data-file-preview
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      className="m-0 flex h-dvh max-h-none w-screen max-w-none flex-col overflow-hidden border-0 bg-panel p-0 text-ink ps-[env(safe-area-inset-left)] pe-[env(safe-area-inset-right)] backdrop:bg-black/55"
    >
      {children}
    </dialog>,
    document.body,
  );
}

/** Mounted once. Renders nothing until a file is opened. */
export function FilePreviewSurface() {
  const open = useFilePreview();
  const desktop = useMediaQuery(DESKTOP_PREVIEW, true);
  if (!open) return null;
  const close = () => {
    const back = closeFilePreview();
    if (back?.isConnected) queueMicrotask(() => back.focus());
  };
  return <Surface key={desktop ? "panel" : "sheet"} file={open.file} nonce={open.nonce} onClose={close} modal={!desktop} />;
}
