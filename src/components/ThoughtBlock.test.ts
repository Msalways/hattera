// @vitest-environment happy-dom
// A thought sits in the stream after the message it followed, is open while it
// streams, folds to "Thought for Ns" and stays reopenable once the turn is over.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveThoughtAnchor, type LiveTurn, type ThoughtRecord } from "@/lib/live-turn";
import { BotEditorStore } from "@/state/store";
import { ThoughtSlot } from "./ThoughtBlock";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const live = (over: Partial<LiveTurn> = {}): LiveTurn => ({
  turnId: "t1", reasoning: "", reply: "", replyItemId: undefined, truncated: false, ended: false, joinedMidStream: false,
  streamId: "s", lastSeq: 1, completedItems: [], anchorId: "m1", thoughtStartedAt: 0, thoughtEndedAt: undefined, ...over,
});
const done = (over: Partial<ThoughtRecord> = {}): ThoughtRecord => ({ turnId: "t0", anchorId: "m1", startedAt: undefined, text: "earlier thinking", seconds: 3, ...over });

let host: HTMLDivElement;
let root: Root;
const render = (state: { liveTurns?: Record<string, LiveTurn>; thoughts?: Record<string, ThoughtRecord[]> }, afterId: string | null, ids: string[] = ["m1"], at: (id: string) => number = () => 0) =>
  act(() => root.render(createElement(BotEditorStore, {
    value: { state: { liveTurns: {}, thoughts: {}, ...state }, dispatch: () => {} } as never,
    children: createElement(ThoughtSlot, { threadId: "th", afterId, resolveAnchor: (anchorId, startedAt) => resolveThoughtAnchor(ids.map((id) => ({ id, at: at(id) })), new Set(ids), anchorId, startedAt) }),
  })));
const frame = () => act(() => void vi.advanceTimersByTime(20));
const button = () => host.querySelector<HTMLButtonElement>("button")!;
const body = () => host.querySelector<HTMLElement>("p")!;

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe("ThoughtSlot", () => {
  it("is open and labelled Thinking while it streams", () => {
    render({ liveTurns: { th: live({ reasoning: "weighing options" }) } }, "m1");
    frame();
    expect(button().textContent).toContain("Thinking");
    expect(button().getAttribute("aria-expanded")).toBe("true");
    expect(body().hidden).toBe(false);
    expect(body().textContent).toBe("weighing options");
  });

  it("folds to Thought for Ns when thinking ends, and reopens by hand", () => {
    render({ liveTurns: { th: live({ reasoning: "weighing options", thoughtEndedAt: 4000 }) } }, "m1");
    frame();
    expect(button().textContent).toContain("Thought for 4s");
    expect(body().hidden).toBe(true);
    act(() => button().click());
    expect(button().getAttribute("aria-expanded")).toBe("true");
    expect(body().hidden).toBe(false);
  });

  it("says plain Thought when the time was not measured", () => {
    render({ liveTurns: { th: live({ reasoning: "x", thoughtStartedAt: undefined, thoughtEndedAt: undefined, reply: "r" }) } }, "m1");
    frame();
    expect(button().textContent?.trim()).toBe("Thought");
  });

  it("stays reopenable after the turn completed (finished record)", () => {
    render({ thoughts: { th: [done()] } }, "m1");
    expect(button().textContent).toContain("Thought for 3s");
    expect(body().hidden).toBe(true);
    act(() => button().click());
    expect(body().textContent).toBe("earlier thinking");
  });

  it("draws only after its own anchor message", () => {
    render({ thoughts: { th: [done()] } }, "m2", ["m1", "m2"]);
    expect(host.querySelector("button")).toBeNull();
  });

  it("the end slot takes thoughts whose anchor is gone and whose time places them nowhere", () => {
    render({ liveTurns: { th: live({ reasoning: "r", anchorId: "gone", thoughtStartedAt: undefined }) }, thoughts: { th: [done({ anchorId: "gone" })] } }, null, ["m1"]);
    frame();
    expect(host.querySelectorAll("button")).toHaveLength(2);
  });

  it("places a thought whose anchor was never loaded by the time it began", () => {
    const at = (id: string) => ({ m1: 100, m2: 900 })[id] ?? 0;
    const lost = done({ anchorId: undefined, startedAt: 500 });
    render({ thoughts: { th: [lost] } }, "m1", ["m1", "m2"], at);
    expect(host.querySelector("button")).not.toBeNull();
    render({ thoughts: { th: [lost] } }, "m2", ["m1", "m2"], at);
    expect(host.querySelector("button")).toBeNull();
  });

  it("the end slot leaves a live thought that has an anchor in the list to its message", () => {
    render({ liveTurns: { th: live({ reasoning: "r" }) } }, null, ["m1"]);
    frame();
    expect(host.querySelector("button")).toBeNull();
  });
});
