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
