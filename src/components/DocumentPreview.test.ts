import { describe, expect, it } from "vitest";
import {
  countTextLines,
  documentPreviewKind,
  isDocumentPreviewable,
  readDocumentPreviewResponse,
  truncateToLines,
  DOCUMENT_PREVIEW_MAX_BYTES,
  DOCUMENT_PREVIEW_MAX_LINES,
} from "./DocumentPreview";

function streamResponse(chunks: Uint8Array[], headers: Record<string, string> = {}): Response {
  let i = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]!);
      else controller.close();
    },
  }), { headers });
}

describe("document preview detection", () => {
  it("detects markdown, text, and html source", () => {
    expect(documentPreviewKind("plan.md")).toBe("markdown");
    expect(documentPreviewKind("notes.MARKDOWN")).toBe("markdown");
    expect(documentPreviewKind("readme.txt")).toBe("text");
    expect(documentPreviewKind("report.html")).toBe("html-source");
    expect(documentPreviewKind("index.htm")).toBe("html-source");
  });

  it("ignores unsupported and table formats", () => {
    expect(documentPreviewKind("data.csv")).toBeNull();
    expect(documentPreviewKind("data.tsv")).toBeNull();
    expect(documentPreviewKind("image.png")).toBeNull();
    expect(documentPreviewKind("archive.zip")).toBeNull();
    expect(isDocumentPreviewable("/tmp/plan.md")).toBe(true);
    expect(isDocumentPreviewable("/tmp/data.csv")).toBe(false);
  });
});

describe("document preview limits", () => {
  it("counts and truncates lines", () => {
    expect(countTextLines("")).toBe(0);
    expect(countTextLines("one")).toBe(1);
    expect(countTextLines("one\ntwo\nthree")).toBe(3);
    expect(truncateToLines("a\nb\nc\nd", 2)).toEqual({ text: "a\nb", truncated: true });
    expect(truncateToLines("a\nb", 5)).toEqual({ text: "a\nb", truncated: false });
  });

  it("enforces streamed byte caps", async () => {
    const big = new Uint8Array(DOCUMENT_PREVIEW_MAX_BYTES + 64).fill(97);
    const result = await readDocumentPreviewResponse(streamResponse([big]), new AbortController().signal, {
      maxBytes: DOCUMENT_PREVIEW_MAX_BYTES,
      maxLines: DOCUMENT_PREVIEW_MAX_LINES,
    });
    expect(result.truncatedBytes).toBe(true);
    expect(new TextEncoder().encode(result.text).byteLength).toBeLessThanOrEqual(DOCUMENT_PREVIEW_MAX_BYTES);
  });

  it("enforces rendered line caps", async () => {
    const text = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    const result = await readDocumentPreviewResponse(
      streamResponse([new TextEncoder().encode(text)]),
      new AbortController().signal,
      { maxBytes: 1024, maxLines: 3 },
    );
    expect(result.truncatedLines).toBe(true);
    expect(countTextLines(result.text)).toBeLessThanOrEqual(3);
  });

  it("aborts reads", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(readDocumentPreviewResponse(streamResponse([new Uint8Array([1])]), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
