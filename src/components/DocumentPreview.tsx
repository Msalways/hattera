// Reading a document response with hard byte and line caps. The preview surface
// (FilePreviewSurface) owns the UI; this module owns the bounded read.
// Uses the same message-scoped file authorization as downloads; never requests
// transcript paths directly.

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
