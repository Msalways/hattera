// @vitest-environment happy-dom
// Mounts the real row, group and header. Native <details> toggling is driven
// through its `open` property; real layout is covered by the browser captures.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/state/store";
import { ActivityRun } from "./ActivityRun";
import { ToolActivity } from "./ToolActivity";
import { TurnToolsHeader } from "./TurnToolsHeader";
import { TurnPresence } from "./TurnPresence";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const msg = (id: string, name: string, extra: Partial<NonNullable<Message["tool"]>> = {}): Message => ({ id, role: "bot", kind: "activity", at: 1, tool: { name, ok: true, ...extra } });
const step = (m: Message) => createElement(ToolActivity, { tool: m.tool!, turnActive: false });
const rows = () => [...host.querySelectorAll("[data-tool-row]")].map((r) => r.getAttribute("data-status") ?? "group");

describe("inline tool rows", () => {
  it("groups adjacent reads into 'Read N files' and reveals each row on open", () => {
    act(() => root.render(createElement(ActivityRun, { messages: [msg("1", "Read", { summary: "a.ts" }), msg("2", "Read", { summary: "b.ts" }), msg("3", "Read", { summary: "c.ts" })], renderStep: step })));
    const group = host.querySelector("[data-testid=tool-group] button") as HTMLButtonElement;
    expect(group.textContent).toContain("Read 3 files");
    expect(group.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelectorAll("[data-testid=tool-activity]").length).toBe(0);
    act(() => group.click());
    expect(group.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelectorAll("[data-testid=tool-activity]").length).toBe(3);
  });

  it("keeps stream order across interleaved kinds and never groups across an edit", () => {
    act(() => root.render(createElement(ActivityRun, { messages: [msg("1", "Read"), msg("2", "Read"), msg("3", "Edit"), msg("4", "Read"), msg("5", "Bash")], renderStep: step })));
    expect(rows()).toEqual(["group", "done", "done", "done"]);
    expect([...host.querySelectorAll("[data-mid]")].map((e) => e.getAttribute("data-mid"))).toEqual(["3", "4", "5"]);
  });

  it("expands to real Input and Output, plus a diff for an edit", () => {
    const edit = msg("1", "Edit", { input: "src/a.ts", output: "@@ -1 +1 @@\n-old\n+new" });
    act(() => root.render(createElement(ToolActivity, { tool: edit.tool!, turnActive: false })));
    const details = host.querySelector("details") as HTMLDetailsElement;
    act(() => { details.open = true; details.dispatchEvent(new Event("toggle")); });
    expect(host.querySelector("summary")!.getAttribute("aria-expanded")).toBe("true");
    expect(details.textContent).toContain("Input");
    expect(details.textContent).toContain("src/a.ts");
    expect(details.textContent).toContain("Result");
    expect(host.querySelector("[data-testid=tool-diff]")!.textContent).toContain("+new");
    expect(host.querySelectorAll("[data-testid=tool-diff]").length).toBe(1);
    expect(details.querySelectorAll("pre").length).toBe(2); // input + the one diff, not raw output again
  });

  it("renders failed and cancelled honestly, from the real result and the turn ending", () => {
    act(() => root.render(createElement("div", null,
      createElement(ToolActivity, { tool: { name: "Bash", ok: false }, turnActive: false }),
      createElement(ToolActivity, { tool: { name: "Bash" }, turnActive: false }))));
    expect(rows()).toEqual(["failed", "incomplete"]);
    expect(host.textContent).toContain("Failed");
    expect(host.textContent).not.toContain("Cancelled");
    expect(host.textContent).not.toContain("Running");
    act(() => root.render(createElement(ToolActivity, { tool: { name: "Bash" }, turnState: "cancelled" })));
    expect(rows()).toEqual(["cancelled"]);
  });

  it("a duration under a second is hidden, never 0s", () => {
    act(() => root.render(createElement("div", null,
      createElement(ToolActivity, { tool: { name: "Bash", ok: true, durationMs: 250 }, turnActive: false }),
      createElement(ToolActivity, { tool: { name: "Bash", ok: true, durationMs: 2500 }, turnActive: false }))));
    const shown = [...host.querySelectorAll("[data-testid=tool-duration]")].map((e) => e.textContent);
    expect(shown).toHaveLength(1);
    expect(host.textContent).not.toContain("0s");
  });

  it("wraps a long target instead of truncating it", () => {
    const long = `src/${"deeply/nested/".repeat(20)}file.ts`;
    act(() => root.render(createElement(ToolActivity, { tool: { name: "Read", ok: true, summary: long }, turnActive: false })));
    const target = host.querySelector("[data-testid=tool-target]") as HTMLElement;
    expect(target.textContent).toBe(long);
    expect(target.className).not.toContain("truncate");
    expect(target.className).toContain("overflow-wrap:anywhere");
  });

  it("keeps keyboard focus when finished Reads regroup into one group", () => {
    const first = [msg("1", "Read", { summary: "a.ts" })];
    act(() => root.render(createElement(ActivityRun, { messages: first, renderStep: step })));
    const summary = host.querySelector("summary") as HTMLElement;
    act(() => summary.focus());
    expect(document.activeElement).toBe(summary);
    act(() => root.render(createElement(ActivityRun, { messages: [...first, msg("2", "Read", { summary: "b.ts" })], renderStep: step })));
    expect(host.contains(summary)).toBe(false);
    expect(document.activeElement).toBe(host.querySelector("[data-group-toggle]"));
  });

  it("does not take focus back from where the reader moved it", () => {
    const outside = document.createElement("button"); document.body.append(outside);
    const first = [msg("1", "Read", { summary: "a.ts" })];
    act(() => root.render(createElement(ActivityRun, { messages: first, renderStep: step })));
    act(() => (host.querySelector("summary") as HTMLElement).focus());
    act(() => outside.focus());
    act(() => root.render(createElement(ActivityRun, { messages: [...first, msg("2", "Read")], renderStep: step })));
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("a call stops reading Running once its turn is no longer active, in place", () => {
    const call = { name: "Bash" } as NonNullable<Message["tool"]>;
    act(() => root.render(createElement(ToolActivity, { tool: call, turnActive: true })));
    expect(rows()).toEqual(["running"]);
    act(() => root.render(createElement(ToolActivity, { tool: call, turnActive: false })));
    expect(rows()).toEqual(["incomplete"]);
    expect(host.querySelectorAll("[data-tool-row]").length).toBe(1);
  });

  it("uses icons for status and disclosure, never typed glyph characters", () => {
    act(() => root.render(createElement(ToolActivity, { tool: { name: "Bash", ok: true }, turnActive: false })));
    expect(host.querySelectorAll("svg").length).toBeGreaterThanOrEqual(2);
    expect(host.textContent).not.toMatch(/[?▸▾✓✗✔✖]/);
  });
});

describe("turn header and anchor", () => {
  it("shows N tools and jumps to the first tool row; zero tools renders nothing", () => {
    const scroll = vi.fn();
    (HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = scroll;
    act(() => root.render(createElement("div", null,
      createElement(TurnToolsHeader, { count: 3 }),
      createElement(ToolActivity, { tool: { name: "Bash", ok: true }, turnActive: false }))));
    const button = host.querySelector("[data-turn-tools] button") as HTMLButtonElement;
    expect(button.textContent).toBe("3 tools");
    act(() => button.click());
    expect(scroll).toHaveBeenCalled();
    expect(document.activeElement).toBe(host.querySelector("summary"));
    act(() => root.render(createElement(TurnToolsHeader, { count: 0 })));
    expect(host.querySelector("[data-turn-tools]")).toBeNull();
  });

  it("a single neutral Working… line, with no mascot or timer, before the first item", () => {
    act(() => root.render(createElement(TurnPresence, { avatar: null, visible: true, quietLabel: "Working…" })));
    expect(host.textContent).toBe("Working…");
    expect(host.querySelectorAll("[data-quiet-label]").length).toBe(1);
  });
});
