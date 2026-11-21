import { describe, expect, it } from "vitest";
import {
  canDownload, classifyFailure, formatBytes, NO_META, previewIdentity, previewKind, previewReducer, splitFileName, typeLabel,
  type PreviewFile, type PreviewState,
} from "./file-preview";

const grant = { threadId: "t1", messageId: "m1" };
const file = (over: Partial<PreviewFile> = {}): PreviewFile => ({ path: "/w/a.md", name: "a.md", message: grant, ...over });
const body = { kind: "text", text: "x", truncated: { bytes: false, lines: false } } as const;

describe("previewKind", () => {
  it.each([
    ["a.md", "markdown"], ["a.MARKDOWN", "markdown"], ["a.txt", "text"], ["a.ts", "code"], ["a.html", "html-source"],
    ["a.csv", "table"], ["a.tsv", "table"], ["a.png", "image"], ["a.mp4", "video"],
    ["a.pdf", "unsupported"], ["a.xlsx", "unsupported"], ["a.docx", "unsupported"], ["a.pptx", "unsupported"], ["a.bin", "unsupported"], ["noext", "unsupported"],
  ])("%s is %s", (name, kind) => expect(previewKind(name)).toBe(kind));
});

describe("labels", () => {
  it("formats sizes and refuses nonsense", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(null)).toBeNull();
    expect(formatBytes(-1)).toBeNull();
  });
  it("labels types and splits a name around its extension", () => {
    expect(typeLabel("x.docx")).toBe("DOCX");
    expect(typeLabel("x.md")).toBe("Markdown");
    expect(typeLabel("README")).toBe("File");
    expect(splitFileName("quarterly-report.final.pdf")).toEqual({ stem: "quarterly-report.final", tail: ".pdf" });
    expect(splitFileName("Makefile")).toEqual({ stem: "Makefile", tail: "" });
  });
});

describe("previewIdentity", () => {
  it("separates the same name in different messages and threads", () => {
    const a = previewIdentity(file());
    expect(previewIdentity(file({ message: { threadId: "t1", messageId: "m2" } }))).not.toBe(a);
    expect(previewIdentity(file({ message: { threadId: "t2", messageId: "m1" } }))).not.toBe(a);
    expect(previewIdentity(file())).toBe(a);
  });
});

describe("previewReducer", () => {
  const loading = (id: string, request: number): PreviewState => ({ status: "loading", id, request });
  it("settles only the load in flight", () => {
    const next = previewReducer(loading("a", 2), { type: "settled", id: "a", request: 2, meta: NO_META, body });
    expect(next.status).toBe("ready");
  });
  it("ignores a slower answer for another file", () => {
    const state = loading("b", 3);
    expect(previewReducer(state, { type: "settled", id: "a", request: 2, meta: NO_META, body })).toBe(state);
    expect(previewReducer(state, { type: "failed", id: "a", request: 2, failure: "failed" })).toBe(state);
  });
  it("ignores a slower answer for an earlier attempt at the same file", () => {
    const state = loading("a", 4);
    expect(previewReducer(state, { type: "settled", id: "a", request: 3, meta: NO_META, body })).toBe(state);
  });
  it("never settles after a failure or after close", () => {
    const failed = previewReducer(loading("a", 1), { type: "failed", id: "a", request: 1, failure: "missing" });
    expect(failed).toMatchObject({ status: "failed", failure: "missing" });
    expect(previewReducer(failed, { type: "settled", id: "a", request: 1, meta: NO_META, body })).toBe(failed);
    expect(previewReducer(failed, { type: "close" })).toEqual({ status: "idle" });
  });
  it("starts over on open, whatever came before", () => {
    const ready = previewReducer(loading("a", 1), { type: "settled", id: "a", request: 1, meta: NO_META, body });
    expect(previewReducer(ready, { type: "open", id: "b", request: 2 })).toEqual(loading("b", 2));
  });
});

describe("authorisation outcomes", () => {
  it("maps server answers by status and stable code, never by message text", () => {
    expect(classifyFailure({ code: "outside_workspace", status: 403 })).toBe("denied");
    expect(classifyFailure({ status: 403 })).toBe("denied");
    expect(classifyFailure({ status: 404 })).toBe("missing");
    expect(classifyFailure({ status: 413 })).toBe("tooLarge");
    expect(classifyFailure({ code: "directory", status: 400 })).toBe("folder");
    expect(classifyFailure(new Error("outside this workspace"))).toBe("failed");
    expect(classifyFailure(null)).toBe("failed");
  });
  it("offers Download unless the file is refused, missing, a folder or has no grant", () => {
    const f = file();
    const failed = (failure: "denied" | "missing" | "folder" | "tooLarge" | "malformed" | "failed"): PreviewState => ({ status: "failed", id: "a", request: 1, failure, meta: NO_META });
    expect(canDownload({ status: "loading", id: "a", request: 1 }, f)).toBe(true);
    expect(canDownload(failed("tooLarge"), f)).toBe(true);
    expect(canDownload(failed("malformed"), f)).toBe(true);
    expect(canDownload(failed("failed"), f)).toBe(true);
    expect(canDownload(failed("denied"), f)).toBe(false);
    expect(canDownload(failed("missing"), f)).toBe(false);
    expect(canDownload(failed("folder"), f)).toBe(false);
    expect(canDownload({ status: "loading", id: "a", request: 1 }, file({ message: undefined }))).toBe(false);
  });
});
