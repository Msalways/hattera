// @vitest-environment happy-dom
// Mounts the real surface against a stubbed fetch. Only fetch and the native
// dialog methods are substituted; this does not establish browser focus
// containment, inertness or real 390px geometry (the live run covers those).
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilePreviewSurface } from "./FilePreviewSurface";
import { AttachedFileChips } from "./AttachmentPreview";
import { closeFilePreview, openFilePreview, resetFilePreview } from "@/lib/file-preview-store";

let root: Root;
let host: HTMLDivElement;
const network = vi.fn<typeof fetch>();
const grant = (messageId: string) => ({ threadId: "fixture-thread", messageId });
const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };
const open = (path: string, messageId = "m1", from?: HTMLElement) => act(() => openFilePreview({ path, name: path.split("/").pop()!, message: grant(messageId) }, from));
const surface = () => document.querySelector("[data-file-preview]");
const deferred = () => {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>((r) => { resolve = r; });
  return { promise, resolve };
};
const refusal = (status: number, code?: string) => new Response(JSON.stringify({ error: "server words", code }), { status });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", network);
  network.mockReset();
  vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(function (this: HTMLDialogElement) { this.open = true; });
  vi.spyOn(HTMLDialogElement.prototype, "close").mockImplementation(function (this: HTMLDialogElement) { this.open = false; });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root.render(createElement(FilePreviewSurface)));
});
afterEach(() => { act(() => resetFilePreview()); act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("file preview surface", () => {
  it("renders nothing until a file is opened, and opening requests the file once with its message grant", async () => {
    expect(surface()).toBeNull();
    network.mockResolvedValue(new Response("# Plan\n\nReadable steps.", { headers: { "content-length": "23" } }));
    await open("/w/plan.md");
    await vi.waitFor(async () => { await settle(); expect(surface()?.querySelector(".chat-md")?.textContent).toContain("Readable steps."); }, { timeout: 10000 });
    expect(network).toHaveBeenCalledTimes(1);
    expect(network.mock.calls[0]![0]).toBe("/api/threads/fixture-thread/messages/m1/file");
    expect(JSON.parse(network.mock.calls[0]![1]!.body as string)).toEqual({ path: "/w/plan.md" });
    expect(document.querySelector("a[download]")).toBeNull();
  });

  it("opens Markdown on Output and switches to Raw source", async () => {
    network.mockResolvedValue(new Response("# Title\n\nbody"));
    await open("/w/plan.md");
    await vi.waitFor(async () => { await settle(); expect(surface()?.querySelector("[role=tab][aria-selected=true]")?.textContent).toBe("Output"); }, { timeout: 10000 });
    const raw = [...surface()!.querySelectorAll("[role=tab]")].find((tab) => tab.textContent === "Raw") as HTMLButtonElement;
    await act(async () => raw.click());
    expect(surface()!.querySelector("pre")?.textContent).toBe("# Title\n\nbody");
    expect(raw.getAttribute("aria-selected")).toBe("true");
  });

  it("opens HTML on Raw as literal source, never as markup, and Output says it is not available yet", async () => {
    network.mockResolvedValue(new Response("<script>alert(1)</script><b>hi</b>"));
    await open("/w/page.html");
    await vi.waitFor(async () => { await settle(); expect(surface()?.querySelector("[role=tab][aria-selected=true]")?.textContent).toBe("Raw"); });
    expect(surface()!.querySelector("pre")?.textContent).toBe("<script>alert(1)</script><b>hi</b>");
    expect(surface()!.querySelector("script, iframe")).toBeNull();
    const output = [...surface()!.querySelectorAll("[role=tab]")].find((tab) => tab.textContent === "Output") as HTMLButtonElement;
    await act(async () => output.click());
    expect(surface()!.textContent).toContain("Rendered HTML is not available yet.");
    expect(surface()!.querySelector("pre")).toBeNull();
    expect(surface()!.querySelector("script, iframe")).toBeNull();
    expect(network).toHaveBeenCalledTimes(1);
  });

  it("keeps Close and Download reachable in the header for a very long file name", async () => {
    const name = `${"quarterly-launch-planning-notes-".repeat(8)}final.md`;
    network.mockResolvedValue(new Response("# x"));
    await act(() => openFilePreview({ path: `/w/${name}`, name, message: grant("m1") }));
    await vi.waitFor(async () => { await settle(); expect(surface()?.querySelector("[role=tab]")).not.toBeNull(); });
    const header = surface()!.querySelector("[data-testid=file-preview-header]") as HTMLElement;
    const close = header.querySelector(`button[aria-label="Close preview"]`) as HTMLButtonElement;
    const download = header.querySelector(`button[aria-label="Save a copy of ${name}"]`) as HTMLButtonElement;
    for (const button of [close, download]) {
      expect(button).not.toBeNull();
      expect(button.disabled).toBe(false);
      expect(button.className).toContain("shrink-0");
      expect(button.className).not.toMatch(/\bhidden\b/);
    }
    // the title column is the only part allowed to give way: it truncates and may shrink to zero
    const title = header.querySelector("h2")!;
    expect(title.parentElement!.className).toMatch(/\bmin-w-0\b/);
    expect(title.querySelector(".truncate")).not.toBeNull();
    expect(header.className).toMatch(/\bmin-w-0\b/);
    expect(surface()!.className).toContain("overflow-hidden");
    // buttons keep their accessible names when the labels collapse to icons
    expect(download.querySelector(".sr-only, [class*='sr-only']")).not.toBeNull();
    act(() => close.click());
    expect(surface()).toBeNull();
  });

  it("says Preview not available for DOCX with type, size and Download, and never reads the bytes", async () => {
    network.mockResolvedValue(new Response("PK", { headers: { "content-length": "2048" } }));
    await open("/w/brief.docx");
    await vi.waitFor(async () => { await settle(); expect(surface()?.textContent).toContain("Preview not available"); });
    expect(surface()!.textContent).toContain("DOCX · 2 KB");
    expect([...surface()!.querySelectorAll("button")].some((b) => b.textContent === "Download")).toBe(true);
    expect(surface()!.textContent).not.toContain("/w/");
  });

  it.each([
    [403, "outside_workspace", "the files this conversation can reach"],
    [404, undefined, "no longer exists"],
  ])("a %s answer is a calm state with no Download", async (status, code, text) => {
    network.mockResolvedValue(refusal(status, code));
    await open("/Users/secret/hidden.txt");
    await vi.waitFor(async () => { await settle(); expect(surface()?.querySelector("[role=alert]")?.textContent).toContain(text); });
    const body = surface()!.querySelector("[data-testid=file-preview-body]")!;
    expect([...body.querySelectorAll("button")].some((b) => b.textContent === "Download")).toBe(false);
    expect(surface()!.textContent).not.toContain("/Users/secret");
    expect(surface()!.textContent).not.toContain("server words");
    expect(surface()!.querySelector("header button[disabled]")).not.toBeNull();
  });

  it("retries a failed load through a fresh request", async () => {
    network.mockResolvedValueOnce(refusal(500)).mockResolvedValue(new Response("Recovered"));
    await open("/w/a.txt");
    await vi.waitFor(async () => { await settle(); expect(surface()?.querySelector("[role=alert]")).not.toBeNull(); });
    const retry = [...surface()!.querySelectorAll("button")].find((b) => b.textContent === "Retry")!;
    await act(async () => retry.click());
    await vi.waitFor(async () => { await settle(); expect(surface()?.querySelector("pre")?.textContent).toBe("Recovered"); });
    expect(network).toHaveBeenCalledTimes(2);
  });

  it("never shows an earlier file's late answer after switching, even for the same name", async () => {
    const slow = deferred();
    network.mockReturnValueOnce(slow.promise).mockResolvedValue(new Response("SECOND"));
    await open("/w/notes.txt", "m1");
    await vi.waitFor(() => expect(network).toHaveBeenCalledTimes(1));
    const first = network.mock.calls[0]![1]!.signal!;
    await open("/w/notes.txt", "m2");
    expect(first.aborted).toBe(true);
    await vi.waitFor(async () => { await settle(); expect(surface()?.querySelector("pre")?.textContent).toBe("SECOND"); });
    slow.resolve(new Response("FIRST SECRET")); await settle();
    expect(document.body.textContent).not.toContain("FIRST SECRET");
    // each request carried its own message's grant
    expect(network.mock.calls[0]![0]).toContain("/messages/m1/file");
    expect(network.mock.calls[1]![0]).toContain("/messages/m2/file");
  });

  it("aborts the request on close and returns focus to the control that opened it", async () => {
    const pending = deferred(); network.mockReturnValue(pending.promise);
    const trigger = document.createElement("button"); document.body.append(trigger); trigger.focus();
    await open("/w/a.txt", "m1", trigger);
    await vi.waitFor(() => expect(network).toHaveBeenCalledTimes(1));
    const signal = network.mock.calls[0]![1]!.signal!;
    const close = surface()!.querySelector("button[aria-label='Close preview']") as HTMLButtonElement;
    await act(async () => close.click());
    await settle();
    expect(signal.aborted).toBe(true);
    expect(surface()).toBeNull();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("moves focus to the title on open and closes on Escape", async () => {
    network.mockResolvedValue(new Response("x"));
    await open("/w/a.txt");
    await settle();
    expect(document.activeElement?.tagName).toBe("H2");
    await act(async () => { surface()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(surface()).toBeNull();
    act(() => closeFilePreview());
  });

  it("uses a modal dialog sheet below the desktop breakpoint", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }));
    act(() => root.render(createElement(FilePreviewSurface)));
    network.mockResolvedValue(new Response("x"));
    await open("/w/a.txt");
    await settle();
    expect(surface()?.tagName).toBe("DIALOG");
    expect((surface() as HTMLDialogElement).open).toBe(true);
  });

  describe("image object URLs", () => {
    let seq = 0;
    let created: string[];
    let revoked: string[];
    const png = () => new Response(new Blob(["x"], { type: "image/png" }), { headers: { "content-type": "image/png" } });
    beforeEach(() => {
      seq = 0; created = []; revoked = [];
      URL.createObjectURL = vi.fn(() => { const url = `blob:fixture/${++seq}`; created.push(url); return url; }) as typeof URL.createObjectURL;
      URL.revokeObjectURL = vi.fn((url: string) => { revoked.push(url); }) as typeof URL.revokeObjectURL;
    });
    const shown = () => surface()?.querySelector("img")?.getAttribute("src");

    it("revokes the image URL when the preview is closed", async () => {
      network.mockResolvedValue(png());
      await open("/w/a.png");
      await vi.waitFor(async () => { await settle(); expect(shown()).toBe("blob:fixture/1"); });
      expect(revoked).toEqual([]);
      await act(async () => (surface()!.querySelector("button[aria-label='Close preview']") as HTMLButtonElement).click());
      await settle();
      expect(revoked).toEqual(["blob:fixture/1"]);
    });

    it("revokes the first image URL when another file replaces it", async () => {
      network.mockResolvedValueOnce(png()).mockResolvedValueOnce(png());
      await open("/w/a.png");
      await vi.waitFor(async () => { await settle(); expect(shown()).toBe("blob:fixture/1"); });
      await open("/w/b.png", "m2");
      await vi.waitFor(async () => { await settle(); expect(shown()).toBe("blob:fixture/2"); });
      expect(revoked).toEqual(["blob:fixture/1"]);
    });

    it("creates no URL for an image answer that arrives after close, and keeps fresh content after reopen", async () => {
      const old = deferred();
      network.mockReturnValueOnce(old.promise).mockResolvedValueOnce(png());
      await open("/w/a.png");
      await vi.waitFor(() => expect(network).toHaveBeenCalledTimes(1));
      await act(async () => (surface()!.querySelector("button[aria-label='Close preview']") as HTMLButtonElement).click());
      await open("/w/a.png");
      await vi.waitFor(async () => { await settle(); expect(shown()).toBe("blob:fixture/1"); });
      old.resolve(png()); await settle();
      expect(created).toEqual(["blob:fixture/1"]);
      expect(shown()).toBe("blob:fixture/1");
      expect(revoked).toEqual([]);
    });
  });

  it("keeps the fresh text when the closed request, which ignores abort, answers after reopening the same file", async () => {
    const old = deferred();
    network.mockReturnValueOnce(old.promise).mockResolvedValueOnce(new Response("Fresh plan"));
    await open("/w/plan.txt");
    await vi.waitFor(() => expect(network).toHaveBeenCalledTimes(1));
    const signal = network.mock.calls[0]![1]!.signal!;
    await act(async () => (surface()!.querySelector("button[aria-label='Close preview']") as HTMLButtonElement).click());
    expect(signal.aborted).toBe(true);
    expect(surface()).toBeNull();
    await open("/w/plan.txt");
    await vi.waitFor(async () => { await settle(); expect(surface()?.querySelector("pre")?.textContent).toBe("Fresh plan"); });
    old.resolve(new Response("STALE SECRET")); await settle();
    expect(document.body.textContent).not.toContain("STALE SECRET");
    expect(surface()?.querySelector("pre")?.textContent).toBe("Fresh plan");
  });

  it("opens from the real attached-file chip with one message-scoped request and no download", async () => {
    network.mockResolvedValue(new Response("Chip body"));
    const chips = document.createElement("div"); document.body.append(chips);
    const chipRoot = createRoot(chips);
    act(() => chipRoot.render(createElement(AttachedFileChips, { files: [{ path: "/w/notes.txt", name: "notes.txt", private: true }], message: grant("m9") })));
    const chip = chips.querySelector("button[aria-label='Open notes.txt']") as HTMLButtonElement | null ?? chips.querySelector("button") as HTMLButtonElement;
    await act(async () => chip.click());
    await vi.waitFor(async () => { await settle(); expect(surface()?.querySelector("pre")?.textContent).toBe("Chip body"); });
    expect(network).toHaveBeenCalledTimes(1);
    expect(network.mock.calls[0]![0]).toBe("/api/threads/fixture-thread/messages/m9/file");
    expect(JSON.parse(network.mock.calls[0]![1]!.body as string)).toEqual({ path: "/w/notes.txt" });
    expect(document.querySelector("a[download]")).toBeNull();
    act(() => chipRoot.unmount()); chips.remove();
  });
});
