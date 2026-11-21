import { describe, expect, it, vi } from "vitest";
import { loadPreview, loadVideoUrl, metaOf, PreviewLoadError, type PreviewLoadDeps } from "./file-preview-load";
import type { PreviewFile } from "./file-preview";

const grant = { threadId: "t1", messageId: "m1" };
const file = (name: string, message: PreviewFile["message"] = grant): PreviewFile => ({ path: `/secret/dir/${name}`, name, message });
const signal = () => new AbortController().signal;

function deps(over: Partial<PreviewLoadDeps> = {}, make: () => Response = () => new Response("hello", { headers: { "content-length": "5", "content-type": "text/plain" } })) {
  const base: PreviewLoadDeps = {
    request: vi.fn(async () => make()),
    readText: vi.fn(async (r: Response) => ({ text: await r.text(), truncatedBytes: false, truncatedLines: false })),
    readTable: vi.fn(async (r: Response) => r.text()),
    parseTable: vi.fn(async () => ({ headers: ["a"], rows: [["1"]] })),
    objectUrl: vi.fn(() => "blob:fixture"),
  };
  return { ...base, ...over };
}
const failure = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as PreviewLoadError;

describe("authorisation", () => {
  it("requests nothing at all without a message grant", async () => {
    const d = deps();
    expect((await failure(loadPreview({ ...file("a.md"), message: undefined }, d, signal()))).failure).toBe("denied");
    expect(d.request).not.toHaveBeenCalled();
    expect((await failure(loadVideoUrl({ ...file("a.mp4"), message: undefined }, d, signal()))).failure).toBe("denied");
    expect(d.request).not.toHaveBeenCalled();
  });
  it("sends the path only through the message-scoped request, with that message's grant", async () => {
    const d = deps();
    await loadPreview(file("a.md"), d, signal());
    expect(d.request).toHaveBeenCalledWith("/secret/dir/a.md", grant, expect.any(AbortSignal));
  });
  it.each([
    [{ status: 403, code: "outside_workspace" }, "denied"],
    [{ status: 404 }, "missing"],
    [{ status: 413 }, "tooLarge"],
    [{ status: 400, code: "directory" }, "folder"],
    [{ status: 500 }, "failed"],
  ])("a refusal %j is %s and the body is never read", async (error, expected) => {
    const d = deps({ request: vi.fn(async () => { throw Object.assign(new Error("server words"), error); }) });
    const got = await failure(loadPreview(file("a.md"), d, signal()));
    expect(got.failure).toBe(expected);
    expect(d.readText).not.toHaveBeenCalled();
  });
});

describe("bodies", () => {
  it("reads text and reports truncation", async () => {
    const d = deps({ readText: vi.fn(async () => ({ text: "part", truncatedBytes: true, truncatedLines: false })) });
    const { body } = await loadPreview(file("a.txt"), d, signal());
    expect(body).toEqual({ kind: "text", text: "part", truncated: { bytes: true, lines: false } });
  });
  it("treats NUL bytes in a text file as malformed", async () => {
    const d = deps({ readText: vi.fn(async () => ({ text: "a\u0000b", truncatedBytes: false, truncatedLines: false })) });
    expect((await failure(loadPreview(file("a.txt"), d, signal()))).failure).toBe("malformed");
  });
  it("shows a previewless type honestly: size and type known, bytes never read", async () => {
    const response = () => new Response("PK", { headers: { "content-length": "2048", "content-type": "application/vnd.openxmlformats" } });
    const d = deps({}, response);
    const out = await loadPreview(file("a.docx"), d, signal());
    expect(out.body).toEqual({ kind: "none" });
    expect(out.meta.bytes).toBe(2048);
    expect(d.readText).not.toHaveBeenCalled();
  });
  it.each(["a.pdf", "a.xlsx", "a.pptx", "a.bin"])("%s is not previewable", async (name) => {
    expect((await loadPreview(file(name), deps(), signal())).body.kind).toBe("none");
  });
  it("parses CSV and TSV with the right delimiter", async () => {
    const d = deps();
    await loadPreview(file("a.csv"), d, signal());
    await loadPreview(file("a.tsv"), d, signal());
    expect(d.parseTable).toHaveBeenNthCalledWith(1, "hello", ",", expect.any(AbortSignal));
    expect(d.parseTable).toHaveBeenNthCalledWith(2, "hello", "\t", expect.any(AbortSignal));
  });
  it("maps table size, shape and decode failures", async () => {
    const size = deps({ readTable: vi.fn(async () => { throw new Error("size"); }) });
    expect((await failure(loadPreview(file("a.csv"), size, signal()))).failure).toBe("tooLarge");
    const decode = deps({ readTable: vi.fn(async () => { throw new TypeError("not utf-8"); }) });
    expect((await failure(loadPreview(file("a.csv"), decode, signal()))).failure).toBe("malformed");
    const shape = deps({ parseTable: vi.fn(async () => { throw new Error("columns"); }) });
    expect((await failure(loadPreview(file("a.csv"), shape, signal()))).failure).toBe("malformed");
  });
  it("accepts an image only if it is one", async () => {
    const ok = deps({}, () => new Response(new Blob(["x"], { type: "image/png" })));
    expect((await loadPreview(file("a.png"), ok, signal())).body).toEqual({ kind: "image", url: "blob:fixture" });
    const bad = deps({}, () => new Response("<html>", { headers: { "content-type": "text/html" } }));
    expect((await failure(loadPreview(file("a.png"), bad, signal()))).failure).toBe("malformed");
  });
  it("does not fetch a video until asked, and then only under the same grant", async () => {
    const d = deps({}, () => new Response(new Blob(["v"], { type: "video/mp4" })));
    expect((await loadPreview(file("a.mp4"), d, signal())).body).toEqual({ kind: "video" });
    expect(d.objectUrl).not.toHaveBeenCalled();
    expect(await loadVideoUrl(file("a.mp4"), d, signal())).toBe("blob:fixture");
    expect(d.request).toHaveBeenLastCalledWith("/secret/dir/a.mp4", grant, expect.any(AbortSignal));
  });
  it("lets an abort through unchanged", async () => {
    const controller = new AbortController();
    const d = deps({ request: vi.fn(async () => { controller.abort(); throw new DOMException("Aborted", "AbortError"); }) });
    expect(await failure(loadPreview(file("a.md"), d, controller.signal))).toBeInstanceOf(DOMException);
  });
});

describe("metaOf", () => {
  it("reads size and type, and says null when unknown", () => {
    expect(metaOf(new Response("", { headers: { "content-length": "12", "content-type": "Text/Plain; charset=utf-8" } }))).toEqual({ bytes: 12, mime: "text/plain" });
    expect(metaOf(new Response(null))).toEqual({ bytes: null, mime: null });
  });
});
