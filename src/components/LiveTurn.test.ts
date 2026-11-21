// @vitest-environment happy-dom
// The live turn: the reply streams as markdown; its reasoning is drawn by
// ThoughtBlock; one announcement at each end; at most one draw per animation frame.
import { act, createElement, Profiler } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LiveTurn as LiveTurnState } from "@/lib/live-turn";
import { LiveTurn, useGrowToEnd } from "./LiveTurn";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const turn = (over: Partial<LiveTurnState> = {}): LiveTurnState => ({
  turnId: "turn-1",
  reasoning: "",
  reply: "",
  replyItemId: undefined,
  truncated: false,
  ended: false,
  joinedMidStream: false,
  streamId: "s",
  lastSeq: 1,
  completedItems: [],
  anchorId: undefined,
  thoughtStartedAt: undefined,
  thoughtEndedAt: undefined,
  thoughtBoundary: false,
  thoughts: [],
  ...over,
});

let host: HTMLDivElement;
let root: Root;

const show = (live: LiveTurnState | null, extra: Record<string, unknown> = {}) =>
  act(() => root.render(createElement(LiveTurn, { live, botName: "Builder", ...extra })));
/** Let the one-frame throttle draw the newest value. */
const frame = () => act(() => void vi.advanceTimersByTime(20));
const thought = () => host.querySelector<HTMLElement>("[data-live-thought]");
const announcer = () => host.querySelector("[data-testid=live-turn-announcer]")!.textContent;

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

describe("live thinking", () => {
  it("draws no thought itself: a thought sits in the stream (ThoughtBlock), the reply stays here", () => {
    show(turn({ reasoning: "Checking the registry shape", reply: "Here is the answer" }));
    frame();
    expect(thought()).toBeNull();
    expect(host.textContent).not.toContain("Checking the registry shape");
    expect(host.querySelector("[data-live-reply]")?.textContent).toBe("Here is the answer");
  });
});

describe("live reply", () => {
  it("renders the reply as markdown in an assistant bubble", () => {
    show(turn({ reply: "Hello **world**\n\n- one\n- two" }));
    const bubble = host.querySelector("[data-live-reply]")!;
    expect(bubble.className).toContain("bg-card");
    expect(bubble.querySelector("strong")?.textContent).toBe("world");
    expect(bubble.querySelectorAll("li")).toHaveLength(2);
    expect(bubble.getAttribute("aria-live")).toBe("off");
  });

  it("an unclosed code fence renders as one complete block and leaves the rest alone", () => {
    show(turn({ reply: "Run this:\n\n```ts\nconst a = 1;\nconst b =" }));
    const bubble = host.querySelector("[data-live-reply]")!;
    expect(bubble.querySelectorAll("pre")).toHaveLength(1);
    expect(bubble.textContent).toContain("Run this:");
    expect(bubble.textContent).toContain("const b =");
    // the closing fence the stream has not reached yet never shows as text
    expect(bubble.textContent).not.toContain("```");
  });

  it("is gone the moment the stored message takes over, leaving nothing behind", () => {
    show(turn({ reasoning: "t", reply: "streaming text" }));
    frame();
    expect(host.querySelector("[data-live-reply]")).not.toBeNull();
    // item.completed folds the reply to "" and the live turn is no longer visible
    show(null);
    expect(host.querySelector("[data-live-turn]")).toBeNull();
    expect(host.querySelector("[data-live-reply]")).toBeNull();
    expect(thought()).toBeNull();
  });

  it("shows no thought block for an engine that sends no reasoning", () => {
    show(turn({ reply: "Just the answer" }));
    expect(thought()).toBeNull();
    expect(host.textContent).toContain("Just the answer");
    expect(host.textContent).not.toMatch(/Thinking|Thought/);
  });

  it("notes a turn joined mid-stream, and only then", () => {
    show(turn({ reply: "tail of the answer", joinedMidStream: true }));
    expect(host.querySelector("[data-live-joined]")?.textContent).toBe("Joined mid-reply. Earlier text is not shown.");
    show(turn({ reply: "tail of the answer", joinedMidStream: false }));
    frame();
    expect(host.querySelector("[data-live-joined]")).toBeNull();
  });
});

describe("announcements", () => {
  it("says it once when thinking starts and once when it folds, never per token", () => {
    show(turn({ reasoning: "a" }));
    expect(announcer()).toBe("Builder is thinking.");
    const region = host.querySelector("[data-testid=live-turn-announcer]")!;
    expect(region.getAttribute("role")).toBe("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    const mutations: string[] = [];
    const watcher = new MutationObserver((records) => records.forEach(() => mutations.push(region.textContent ?? "")));
    watcher.observe(region, { childList: true, subtree: true, characterData: true });
    for (const text of ["ab", "abc", "abcd", "abcde"]) {
      show(turn({ reasoning: text }));
      frame();
    }
    expect(announcer()).toBe("Builder is thinking.");
    show(turn({ reasoning: "abcde", reply: "r" }));
    frame();
    expect(announcer()).toBe("Builder finished thinking.");
    for (const text of ["r1", "r12", "r123"]) {
      show(turn({ reasoning: "abcde", reply: text }));
      frame();
    }
    expect(announcer()).toBe("Builder finished thinking.");
    // exactly one change at the fold, none per streamed token before or after
    return Promise.resolve().then(() => {
      expect(watcher.takeRecords().length + mutations.length).toBeLessThanOrEqual(2);
      watcher.disconnect();
    });
  });

  it("no live-region attribute sits on any streaming text", () => {
    show(turn({ reasoning: "a", reply: "b" }));
    frame();
    const polite = Array.from(host.querySelectorAll("[aria-live=polite],[role=log]")).map((node) => node.getAttribute("data-testid"));
    expect(polite).toEqual(["live-turn-announcer"]);
  });
});

describe("frame throttle", () => {
  it("a burst of deltas inside one frame draws once, with the newest text", () => {
    show(turn({ reply: "a" }));
    expect(host.textContent).toContain("a");
    for (const text of ["ab", "abc", "abcd", "abcde"]) show(turn({ reply: text }));
    // not drawn yet: still the previous frame's text
    expect(host.querySelector("[data-live-reply]")?.textContent).toBe("a");
    frame();
    expect(host.querySelector("[data-live-reply]")?.textContent).toBe("abcde");
  });

  it("draws the first text at once and drops back to nothing at once", () => {
    show(turn({ reply: "first" }));
    expect(host.querySelector("[data-live-reply]")?.textContent).toBe("first");
    show(null);
    expect(host.querySelector("[data-live-reply]")).toBeNull();
  });

  it("shows another turn's reply at once, never the previous turn's last frame", () => {
    show(turn({ turnId: "turn-A", reply: "thread A reply" }));
    show(turn({ turnId: "turn-B", reply: "thread B reply" }));
    expect(host.querySelector("[data-live-reply]")?.textContent).toBe("thread B reply");
    show(turn({ turnId: "turn-C", reply: "" }));
    expect(host.querySelector("[data-live-reply]")).toBeNull();
  });

  it("hides a completed reply item in the same render, without waiting for a frame", () => {
    show(turn({ replyItemId: "item-1", reply: "answer" }));
    frame();
    // item.completed folds the reply to "" while the turn stays live
    show(turn({ replyItemId: undefined, reply: "", completedItems: ["item-1"] }));
    expect(host.querySelector("[data-live-reply]")).toBeNull();
  });

  it("keys by thread in the parent, so a switch remounts: the throttled copy cannot cross threads", () => {
    show(turn({ reply: "thread A" }), { key: "A" });
    show(turn({ turnId: "turn-9", reply: "" }), { key: "B" });
    expect(host.querySelector("[data-live-reply]")).toBeNull();
  });

  it("commits at most once per props change and parses markdown at most once per frame", () => {
    const commits: number[] = [];
    const onRender = () => void commits.push(1);
    const profiled = (live: LiveTurnState) => createElement(Profiler, { id: "live", onRender }, createElement(LiveTurn, { live, botName: "Builder" }));
    act(() => root.render(profiled(turn({ reply: "a" }))));
    commits.length = 0;
    act(() => {
      for (const text of ["ab", "abc", "abcd", "abcde"]) root.render(profiled(turn({ reply: text })));
    });
    // one batched commit for the burst; the paced copy then lands in a later one
    expect(commits.length).toBeLessThanOrEqual(1);
    commits.length = 0;
    frame();
    expect(commits.length).toBeLessThanOrEqual(1);
    expect(host.querySelector("[data-live-reply]")?.textContent).toBe("abcde");
  });

  it("asks the caller to follow the end after each drawn update", () => {
    const onGrow = vi.fn();
    show(turn({ reply: "a" }), { onGrow });
    const first = onGrow.mock.calls.length;
    expect(first).toBeGreaterThan(0);
    show(turn({ reply: "ab" }), { onGrow });
    expect(onGrow.mock.calls.length).toBe(first);
    frame();
    expect(onGrow.mock.calls.length).toBeGreaterThan(first);
  });
});

describe("motion", () => {
  it("animates nothing unless motion is allowed, and text still arrives", () => {
    show(turn({ reasoning: "slow thought", reply: "visible text" }));
    frame();
    const animated = Array.from(host.querySelectorAll("[class]")).filter((node) => /(^|\s)(transition|animate)-/.test(node.getAttribute("class") ?? ""));
    expect(animated).toEqual([]);
    expect(host.querySelector("[data-live-reply]")?.textContent).toBe("visible text");
  });
});

describe("following the end", () => {
  function Probe({ following, el }: { following: boolean; el: HTMLElement }) {
    const grow = useGrowToEnd(following, { current: el });
    return createElement("button", { onClick: grow });
  }

  it("scrolls to the end only while the reader is already at the end", () => {
    const el = document.createElement("div");
    Object.defineProperty(el, "scrollHeight", { value: 900 });
    const scrollTo = vi.fn();
    el.scrollTo = scrollTo as unknown as typeof el.scrollTo;
    act(() => root.render(createElement(Probe, { following: false, el })));
    act(() => host.querySelector("button")!.click());
    expect(scrollTo).not.toHaveBeenCalled();
    act(() => root.render(createElement(Probe, { following: true, el })));
    act(() => host.querySelector("button")!.click());
    expect(scrollTo).toHaveBeenCalledWith({ top: 900 });
  });
});
