// @vitest-environment happy-dom
// Real mounted regression for ChatUsageDetails modal lifecycle: the dialog must
// mount only while open so the actual useModalDialog hook attaches, traps Tab,
// closes on Escape, restores focus to the trigger, and works on reopen.
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

vi.mock("@/state/store", () => ({ api: vi.fn(async () => ({ fetchedAt: "", providers: [] })) }));
vi.mock("@/lib/i18n", () => ({ t: (key: string) => key }));
vi.mock("./AccountReporting", () => ({ AccountReportingView: () => null }));
vi.mock("./PlanUsageWindows", () => ({ LegacyProviderWindows: () => null }));
vi.mock("./usePlanUsageReport", () => ({
  usePlanUsageReport: () => ({ report: null, loading: false, error: "", now: 0, load: vi.fn(async () => {}) }),
}));

const { ChatUsageEntry } = await import("./ChatUsageDetails");

function key(target: Element, name: string, opts: { shiftKey?: boolean } = {}) {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, shiftKey: !!opts.shiftKey });
  target.dispatchEvent(event);
  return event;
}

const bot = {
  id: "bot1",
  name: "Bot",
  threadId: "thread1",
  modelSelection: { instanceId: "inst1", model: "m" },
  tasks: [{ threadId: "thread1", usage: { input: 10, output: 5, costUsd: null, turns: 1, context: { tokens: 500, window: 1000 } } }],
} as unknown as Bot;

let root: Root;
let container: HTMLDivElement;

afterEach(() => {
  if (root) act(() => { root.unmount(); });
  container?.remove();
  document.body.innerHTML = "";
});

describe("ChatUsageDetails modal lifecycle", () => {
  it("attaches real modal behavior on open, close, and reopen", async () => {
    container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(ChatUsageEntry, { bot, instances: [{ instanceId: "inst1", displayName: "Account", snapshot: { billing: "subscription" } }] as any }));
    });

    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="chat-usage-entry"]');
    expect(trigger).not.toBeNull();
    trigger!.focus();
    expect(document.activeElement).toBe(trigger);
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    // open
    await act(async () => { trigger!.click(); });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.contains(document.activeElement) || document.activeElement === dialog).toBe(true);

    const controls = Array.from(dialog!.querySelectorAll<HTMLElement>('button:not([disabled])')).filter((el) => !el.hasAttribute("hidden"));
    expect(controls.length).toBeGreaterThanOrEqual(1);
    const first = controls[0]!;
    const last = controls[controls.length - 1]!;

    // Tab boundary trap
    last.focus();
    expect(key(dialog!, "Tab").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    expect(key(dialog!, "Tab", { shiftKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
    dialog!.focus();
    expect(key(dialog!, "Tab", { shiftKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);

    // Escape closes and returns focus to trigger
    expect(key(dialog!, "Escape").defaultPrevented).toBe(true);
    await act(async () => {});
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    // reopen and repeat
    await act(async () => { trigger!.click(); });
    const dialog2 = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog2).not.toBeNull();
    expect(dialog2!.contains(document.activeElement) || document.activeElement === dialog2).toBe(true);
    expect(key(dialog2!, "Escape").defaultPrevented).toBe(true);
    await act(async () => {});
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
