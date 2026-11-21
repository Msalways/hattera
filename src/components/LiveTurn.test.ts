// @vitest-environment happy-dom
// The live turn: reasoning streams in a quiet block and folds to "Thought for
// Ns" when the reply starts; the reply streams as markdown; one announcement
// at each end; at most one draw per animation frame.
import { act, createElement } from "react";
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
  ...over,
});

let host: HTMLDivElement;
let root: Root;

const show = (live: LiveTurnState | null, extra: Record<string, unknown> = {}) =>
  act(() => root.render(createElement(LiveTurn, { live, botName: "Builder", ...extra })));
/** Let the one-frame throttle draw the newest value. */
const frame = () => act(() => void vi.advanceTimersByTime(20));
const thought = () => host.querySelector<HTMLElement>("[data-live-thought]");
const toggle = () => host.querySelector<HTMLButtonElement>("[data-live-thought] button");
const body = () => host.querySelector<HTMLElement>("#live-thought-body");
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
  it("shows streamed reasoning in an open, muted block that is not a live region", () => {
    show(turn({ reasoning: "Checking the registry shape" }));
    expect(thought()?.dataset.state).toBe("streaming");
    expect(toggle()?.textContent).toContain("Thinking…");
    expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
    expect(body()?.textContent).toBe("Checking the registry shape");
    expect(body()?.hidden).toBe(false);
    expect(body()?.getAttribute("aria-live")).toBe("off");
    expect(thought()?.className).toContain("text-ink-tertiary");
  });

  it("collapses to Thought for Ns, from real elapsed time, when the reply starts", () => {
    show(turn({ reasoning: "step one" }));
    act(() => void vi.advanceTimersByTime(2400));
    show(turn({ reasoning: "step one step two" }));
    frame();
    act(() => void vi.advanceTimersByTime(600));
    show(turn({ reasoning: "step one step two", reply: "Here is the answer" }));
    frame();
    expect(thought()?.dataset.state).toBe("done");
    expect(toggle()?.textContent).toContain("Thought for 3s");
    expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
    expect(body()?.hidden).toBe(true);
  });

  it("never reads below 1s", () => {
    show(turn({ reasoning: "quick" }));
    show(turn({ reasoning: "quick", reply: "done" }));
    frame();
    expect(toggle()?.textContent).toContain("Thought for 1s");
  });

  it("reopens from the keyboard-reachable button, and the person's choice sticks", () => {
    show(turn({ reasoning: "hidden detail", reply: "answer" }));
    frame();
    const button = toggle()!;
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("aria-controls")).toBe("live-thought-body");
    act(() => button.click());
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(body()?.hidden).toBe(false);
    // more text arrives: their choice is not overridden
    show(turn({ reasoning: "hidden detail more", reply: "answer" }));
    frame();
    expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
    act(() => toggle()!.click());
    expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
  });

  it("a person who folds it while it streams keeps it folded", () => {
    show(turn({ reasoning: "a" }));
    act(() => toggle()!.click());
    show(turn({ reasoning: "ab" }));
    frame();
    expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
  });

  it("starts a fresh clock and a fresh block for the next turn", () => {
    show(turn({ reasoning: "one", reply: "r" }));
    frame();
    act(() => void vi.advanceTimersByTime(5000));
    show(turn({ turnId: "turn-2", reasoning: "two" }));
    frame();
    expect(thought()?.dataset.state).toBe("streaming");
    show(turn({ turnId: "turn-2", reasoning: "two", reply: "r2" }));
    frame();
    expect(toggle()?.textContent).toContain("Thought for 1s");
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
    expect(host.querySelector("svg")?.getAttribute("class")).toContain("motion-safe:transition-transform");
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
