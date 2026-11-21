// Document preview: what a file is, how a preview load settles, and the one
// rule that keeps a slow answer from landing on the wrong file. Pure and
// engine-agnostic; the UI and the network live in the components.
//
// Authorization is never decided here. Every load goes through the same
// message-scoped request the download uses (thread + message + path), and a
// refusal from the server is the only thing that marks a file denied.

export interface PreviewFile {
  /** The path exactly as the message wrote it; only ever sent to the server. */
  path: string;
  /** The file name shown to the person. Never a local path. */
  name: string;
  /** The originating message: the grant. Without it nothing is requested. */
  message: { threadId: string; messageId: string } | undefined;
}

export type PreviewKind = "markdown" | "text" | "code" | "html-source" | "table" | "image" | "video" | "unsupported";

const TEXT_EXT = new Set(["txt", "text", "log", "rst"]);
const CODE_LANG: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  json: "json", yaml: "yaml", yml: "yaml", toml: "toml", py: "python", rs: "rust", go: "go",
  java: "java", c: "c", h: "c", cpp: "cpp", cc: "cpp", cs: "csharp", rb: "ruby", php: "php",
  sh: "bash", bash: "bash", ps1: "powershell", sql: "sql", css: "css", scss: "scss", xml: "xml",
  ini: "ini", swift: "swift", kt: "kotlin", lua: "lua", diff: "diff", patch: "diff",
};
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"]);
const VIDEO_EXT = new Set(["mp4", "webm", "mov", "m4v", "ogv"]);
const TYPE_LABEL: Record<string, string> = {
  pdf: "PDF", xlsx: "XLSX", xls: "XLS", docx: "DOCX", doc: "DOC", pptx: "PPTX", ppt: "PPT",
  zip: "ZIP", md: "Markdown", markdown: "Markdown", html: "HTML", htm: "HTML", csv: "CSV", tsv: "TSV",
};

export function fileExtension(name: string): string {
  return /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
}

/** The extension is a hint only: the server's answer decides what is shown. */
export function previewKind(name: string): PreviewKind {
  const ext = fileExtension(name);
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "html" || ext === "htm") return "html-source";
  if (ext === "csv" || ext === "tsv") return "table";
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  if (TEXT_EXT.has(ext)) return "text";
  if (CODE_LANG[ext]) return "code";
  return "unsupported";
}

export function codeLanguage(name: string): string | undefined {
  return CODE_LANG[fileExtension(name)];
}

/** A short human type label: "PDF", "Markdown", or the upper-cased extension. */
export function typeLabel(name: string): string {
  const ext = fileExtension(name);
  if (!ext) return "File";
  return TYPE_LABEL[ext] ?? (CODE_LANG[ext] ? ext.toUpperCase() : ext.toUpperCase());
}

export function formatBytes(bytes: number | null | undefined): string | null {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value >= 10 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Stem and extension, so a long name can be cut in the middle of the stem and
 * still show what kind of file it is. */
export function splitFileName(name: string): { stem: string; tail: string } {
  const dot = name.lastIndexOf(".");
  return dot > 0 && name.length - dot <= 8 ? { stem: name.slice(0, dot), tail: name.slice(dot) } : { stem: name, tail: "" };
}

/** One identity per file the person asked for: grant and path together, so two
 * files with the same name in different messages never share a load. */
export function previewIdentity(file: PreviewFile): string {
  return file.message ? `${file.message.threadId}\u0000${file.message.messageId}\u0000${file.path}` : `\u0000\u0000${file.path}`;
}

// ── how a load settles ────────────────────────────────────────────────────

export type PreviewFailure =
  /** 404: the file is gone. Nothing to download. */
  | "missing"
  /** 403 / outside the workspace / no message grant. Never fetched, never downloadable. */
  | "denied"
  /** Bigger than the preview can show and no safe prefix exists. */
  | "tooLarge"
  /** Bytes that do not parse as the type the name claims. */
  | "malformed"
  /** Anything else; retry starts a fresh authorized request. */
  | "failed"
  /** The link points at a folder, which opens its file list instead. */
  | "folder";

export interface PreviewMeta {
  bytes: number | null;
  /** The server's content type, for display only. */
  mime: string | null;
}

export type PreviewBody =
  | { kind: "text"; text: string; truncated: { bytes: boolean; lines: boolean } }
  | { kind: "table"; table: { headers: string[]; rows: string[][] } }
  | { kind: "image"; url: string }
  | { kind: "video" }
  | { kind: "none" };

export type PreviewState =
  | { status: "idle" }
  | { status: "loading"; id: string; request: number }
  | { status: "ready"; id: string; request: number; meta: PreviewMeta; body: PreviewBody }
  | { status: "failed"; id: string; request: number; failure: PreviewFailure; meta: PreviewMeta };

export type PreviewAction =
  | { type: "open"; id: string; request: number }
  | { type: "settled"; id: string; request: number; meta: PreviewMeta; body: PreviewBody }
  | { type: "failed"; id: string; request: number; failure: PreviewFailure; meta?: PreviewMeta }
  | { type: "close" };

export const NO_META: PreviewMeta = { bytes: null, mime: null };

/**
 * A settle or failure counts only if it carries the id AND request number of
 * the load now in flight. A slower answer for an earlier file, or for an
 * earlier attempt at this one, finds the state moved on and changes nothing.
 */
export function previewReducer(state: PreviewState, action: PreviewAction): PreviewState {
  switch (action.type) {
    case "open":
      return { status: "loading", id: action.id, request: action.request };
    case "close":
      return { status: "idle" };
    case "settled":
      if (state.status !== "loading" || state.id !== action.id || state.request !== action.request) return state;
      return { status: "ready", id: action.id, request: action.request, meta: action.meta, body: action.body };
    case "failed":
      if (state.status !== "loading" || state.id !== action.id || state.request !== action.request) return state;
      return { status: "failed", id: action.id, request: action.request, failure: action.failure, meta: action.meta ?? NO_META };
  }
}

/** Download is offered only when the server has not refused the file. It runs
 * the same authorized request as before; this only decides whether to show it. */
export function canDownload(state: PreviewState, file: PreviewFile): boolean {
  if (!file.message) return false;
  if (state.status !== "failed") return true;
  return state.failure !== "denied" && state.failure !== "missing" && state.failure !== "folder";
}

/** Map a failed request to what the person is told. Status and stable code come
 * from the server; its English text is never matched. */
export function classifyFailure(error: unknown): PreviewFailure {
  const { status, code } = (error ?? {}) as { status?: unknown; code?: unknown };
  if (code === "directory") return "folder";
  if (code === "outside_workspace" || status === 403) return "denied";
  if (status === 404) return "missing";
  if (status === 413) return "tooLarge";
  return "failed";
}
