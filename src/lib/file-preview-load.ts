// Loading one preview. Every network, decoding and worker detail is injected so
// the rules (what is requested, what a refusal means, what is never fetched)
// can be tested without a browser. The component supplies the real ones.
import { classifyFailure, previewKind, type PreviewBody, type PreviewFailure, type PreviewFile, type PreviewMeta } from "./file-preview";

export interface PreviewLoadDeps {
  /** The message-scoped file request: the same one a download makes. */
  request(path: string, message: { threadId: string; messageId: string }, signal: AbortSignal): Promise<Response>;
  readText(response: Response, signal: AbortSignal): Promise<{ text: string; truncatedBytes: boolean; truncatedLines: boolean }>;
  readTable(response: Response, signal: AbortSignal): Promise<string>;
  parseTable(text: string, delimiter: "," | "\t", signal: AbortSignal): Promise<{ headers: string[]; rows: string[][] }>;
  objectUrl(blob: Blob): string;
}

export class PreviewLoadError extends Error {
  constructor(readonly failure: PreviewFailure, readonly meta?: PreviewMeta) {
    super(failure);
  }
}

export function metaOf(response: Response): PreviewMeta {
  const length = response.headers.get("content-length");
  const bytes = length !== null && length !== "" && Number.isFinite(Number(length)) && Number(length) >= 0 ? Number(length) : null;
  const mime = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() || null;
  return { bytes, mime };
}

async function drop(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}

/** Text with a NUL in it is not text, whatever its name says. */
function looksBinary(text: string): boolean {
  return text.includes("\u0000");
}

export async function loadPreview(
  file: PreviewFile,
  deps: PreviewLoadDeps,
  signal: AbortSignal,
): Promise<{ meta: PreviewMeta; body: PreviewBody }> {
  // No message, no grant: nothing is requested at all.
  if (!file.message) throw new PreviewLoadError("denied");
  const kind = previewKind(file.name);
  let response: Response;
  try {
    response = await deps.request(file.path, file.message, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    throw new PreviewLoadError(classifyFailure(error));
  }
  const meta = metaOf(response);
  try {
    switch (kind) {
      case "unsupported": {
        // The request proves the grant and gives the size; the bytes are not wanted.
        await drop(response);
        return { meta, body: { kind: "none" } };
      }
      case "video": {
        await drop(response);
        return { meta, body: { kind: "video" } };
      }
      case "image": {
        const blob = await response.blob();
        signal.throwIfAborted();
        const mime = blob.type || meta.mime || "";
        if (!mime.startsWith("image/")) throw new PreviewLoadError("malformed", meta);
        return { meta, body: { kind: "image", url: deps.objectUrl(blob) } };
      }
      case "table": {
        let text: string;
        try {
          text = await deps.readTable(response, signal);
        } catch (error) {
          if (signal.aborted) throw error;
          if (error instanceof Error && error.message === "size") throw new PreviewLoadError("tooLarge", meta);
          // a strict UTF-8 decode that fails is a file that is not a text table
          if (error instanceof TypeError) throw new PreviewLoadError("malformed", meta);
          throw error;
        }
        signal.throwIfAborted();
        try {
          const table = await deps.parseTable(text, file.name.toLowerCase().endsWith(".tsv") ? "\t" : ",", signal);
          return { meta, body: { kind: "table", table } };
        } catch (error) {
          if (signal.aborted) throw error;
          const reason = error instanceof Error ? error.message : "";
          throw new PreviewLoadError(reason === "size" ? "tooLarge" : reason === "columns" || reason === "format" ? "malformed" : "failed", meta);
        }
      }
      default: {
        const read = await deps.readText(response, signal);
        signal.throwIfAborted();
        if (looksBinary(read.text)) throw new PreviewLoadError("malformed", meta);
        return { meta, body: { kind: "text", text: read.text, truncated: { bytes: read.truncatedBytes, lines: read.truncatedLines } } };
      }
    }
  } catch (error) {
    if (error instanceof PreviewLoadError || signal.aborted) throw error;
    throw new PreviewLoadError("failed", meta);
  }
}

/** Click-to-play: the video is requested only now, under the same grant. */
export async function loadVideoUrl(file: PreviewFile, deps: PreviewLoadDeps, signal: AbortSignal): Promise<string> {
  if (!file.message) throw new PreviewLoadError("denied");
  let response: Response;
  try {
    response = await deps.request(file.path, file.message, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    throw new PreviewLoadError(classifyFailure(error));
  }
  const blob = await response.blob();
  signal.throwIfAborted();
  if (!(blob.type || metaOf(response).mime || "").startsWith("video/")) throw new PreviewLoadError("malformed");
  return deps.objectUrl(blob);
}
