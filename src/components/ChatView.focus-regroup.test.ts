// @vitest-environment happy-dom
// Keyboard focus survives the transcript regrouping a finished call into a
// "Read N files" group: the row that held focus is unmounted and focus must not
// fall to the page. Real ChatView, store and ToolActivity.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => true }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));
import { ChatView } from "./ChatView";
import { BotEditorStore, initialState } from "@/state/store";

it("keeps focus when a formerly running row joins a completed Read group", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const at = Date.now();
  const u = { id: "u", role: "user", kind: "text", at, text: "Read both" } as never;
  const a = { id: "a", parentId: "u", role: "bot", kind: "activity", turnId: "turn", at: at + 1, tool: { name: "Read", itemId: "a", summary: "a.ts" } } as never;
  const b = { id: "b", parentId: "a", role: "bot", kind: "activity", turnId: "turn", at: at + 2, tool: { name: "Read", itemId: "b", summary: "b.ts", ok: true } } as never;
  const draw = async (done: boolean) => {
    const bot = { id: "fixture", threadId: "thread", name: "Fixture", title: "", description: "", color: "green", notifications: true, unread: false, busy: !done, activity: done ? "idle" : "working", messages: [u, done ? { ...(a as object), tool: { ...(a as { tool: object }).tool, ok: true } } : a, b], activeLeafId: "b", modelSelection: { instanceId: "test", model: "fixture" } } as never;
    const state = { ...initialState, connected: true, selectedId: "fixture", bots: [bot], instances: [{ instanceId: "test", driverKind: "codex", displayName: "Fixture", snapshot: { state: "available" } }], config: { features: { showToolCalls: true } } } as never;
    await act(async () => {
      root.render(createElement(BotEditorStore, { value: { state, dispatch: vi.fn(), flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} } as never, children: createElement(ChatView, { bot }) }));
      await new Promise((r) => setTimeout(r, 0));
    });
  };
  try {
    await draw(false);
    const summary = host.querySelector<HTMLElement>('[data-mid="a"] summary');
    expect(summary).not.toBeNull();
    summary!.focus();
    expect(document.activeElement).toBe(summary);
    await draw(true);
    expect(host.querySelector('[data-testid="tool-group"]')).not.toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(host.contains(document.activeElement)).toBe(true);
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it.each([["no thought", false], ["a thought hung off the request row", true]])("puts the one tool count in the turn header, above the turn's first row and any thought, and jumps to the first tool (%s)", async (_label, withThought) => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  (HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const at = Date.now();
  const u = { id: "u", role: "user", kind: "text", at, text: "Look around" } as never;
  const intro = { id: "intro", parentId: "u", role: "bot", kind: "text", turnId: "turn", at: at + 1, text: "Let me check." } as never;
  const a = { id: "a", parentId: "intro", role: "bot", kind: "activity", turnId: "turn", at: at + 2, tool: { name: "Bash", itemId: "a", summary: "ls", ok: true } } as never;
  const mid = { id: "mid", parentId: "a", role: "bot", kind: "text", turnId: "turn", at: at + 3, text: "Now the second." } as never;
  const b = { id: "b", parentId: "mid", role: "bot", kind: "activity", turnId: "turn", at: at + 4, tool: { name: "Bash", itemId: "b", summary: "pwd", ok: true } } as never;
  const bot = { id: "fixture", threadId: "thread", name: "Fixture", title: "", description: "", color: "green", notifications: true, unread: false, busy: false, activity: "idle", messages: [u, intro, a, mid, b], activeLeafId: "b", modelSelection: { instanceId: "test", model: "fixture" } } as never;
  const state = { ...initialState, thoughts: withThought ? { thread: [{ turnId: "turn", anchorId: "u", startedAt: undefined, text: "plan", seconds: 1 }] } : {}, connected: true, selectedId: "fixture", bots: [bot], instances: [{ instanceId: "test", driverKind: "codex", displayName: "Fixture", snapshot: { state: "available" } }], config: { features: { showToolCalls: true } } } as never;
  try {
    await act(async () => {
      root.render(createElement(BotEditorStore, { value: { state, dispatch: vi.fn(), flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} } as never, children: createElement(ChatView, { bot }) }));
      await new Promise((r) => setTimeout(r, 0));
    });
    const headers = host.querySelectorAll("[data-turn-tools]");
    expect(headers.length).toBe(1);
    expect(headers[0]!.textContent).toBe("2 tools");
    if (withThought) {
      const all = host.textContent ?? "";
      expect(all).toContain("Thought for 1s");
      expect(all.indexOf("2 tools")).toBeLessThan(all.indexOf("Thought for 1s"));
    }
    const firstTool = host.querySelector('[data-mid="a"]')!;
    const text = host.textContent ?? "";
    expect(text.indexOf("2 tools")).toBeGreaterThan(-1);
    expect(text.indexOf("2 tools")).toBeLessThan(text.indexOf("Let me check."));
    expect(headers[0]!.compareDocumentPosition(firstTool) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    act(() => headers[0]!.querySelector("button")!.click());
    expect(document.activeElement).toBe(firstTool.querySelector("summary"));
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
