import { describe, expect, it } from "vitest";

import type { RuntimeEvent } from "../../shared/runtime-events";
import { foldLiveTurn, LIVE_TURN_MAX_CHARS, visibleLiveTurn, type LiveTurn } from "./live-turn";

let n = 0;
const base = (threadId = "t1", turnId: string | undefined = "turn-1") => ({
  eventId: `e${++n}`,
  provider: "any",
  threadId,
  turnId,
  createdAt: "2026-11-20T00:00:00Z",
});
const started = (threadId?: string, turnId?: string): RuntimeEvent => ({ ...base(threadId, turnId), type: "turn.started" });
const completed = (threadId?: string, turnId?: string): RuntimeEvent => ({ ...base(threadId, turnId), type: "turn.completed", ok: true });
const delta = (streamKind: "assistant_text" | "reasoning_text", text: string, extra: { threadId?: string; turnId?: string; itemId?: string; eventId?: string } = {}): RuntimeEvent => ({
  ...base(extra.threadId, extra.turnId),
  ...(extra.itemId ? { itemId: extra.itemId } : {}),
  ...(extra.eventId ? { eventId: extra.eventId } : {}),
  type: "content.delta",
  streamKind,
  delta: text,
});
const stored = (text: string, extra: { threadId?: string; turnId?: string; itemId?: string } = {}): RuntimeEvent => ({
  ...base(extra.threadId, extra.turnId),
  ...(extra.itemId ? { itemId: extra.itemId } : {}),
  type: "item.completed",
  itemType: "assistant_text",
  text,
});

const run = (events: RuntimeEvent[], from?: LiveTurn): LiveTurn | undefined => events.reduce<LiveTurn | undefined>(foldLiveTurn, from);

describe("foldLiveTurn", () => {
  it("accumulates reasoning and reply separately, in order", () => {
    const live = run([started(), delta("reasoning_text", "think "), delta("reasoning_text", "more"), delta("assistant_text", "Hel"), delta("assistant_text", "lo")]);
    expect(live).toMatchObject({ reasoning: "think more", reply: "Hello", ended: false, joinedMidStream: false });
    expect(visibleLiveTurn(live)).toBe(live);
  });

  it("resets on turn.started for a new turn", () => {
    const first = run([started(undefined, "a"), delta("reasoning_text", "old", { turnId: "a" })]);
    const next = foldLiveTurn(first, started(undefined, "b"));
    expect(next).toMatchObject({ turnId: "b", reasoning: "", reply: "" });
  });

  it("drops the reply, not the reasoning, when the stored message lands", () => {
    const live = run([started(), delta("reasoning_text", "why"), delta("assistant_text", "answer", { itemId: "m1" }), stored("answer", { itemId: "m1" })]);
    expect(live).toMatchObject({ reasoning: "why", reply: "" });
    expect(visibleLiveTurn(live)?.reasoning).toBe("why");
  });

  it("shows nothing once the turn completes", () => {
    const live = run([started(), delta("assistant_text", "x"), completed()]);
    expect(live).toMatchObject({ ended: true, reasoning: "", reply: "" });
    expect(visibleLiveTurn(live)).toBeNull();
  });

  it("a turn that never streams stays empty and invisible", () => {
    const live = run([started(), completed()]);
    expect(visibleLiveTurn(run([started()]))).toBeNull();
    expect(visibleLiveTurn(live)).toBeNull();
    // a stored message with no live stream is harmless
    expect(foldLiveTurn(undefined, stored("hi"))).toBeUndefined();
    expect(foldLiveTurn(run([started()]), stored("hi"))).toMatchObject({ reply: "" });
  });

  it("ignores empty deltas and unrelated events without changing state", () => {
    const live = run([started(), delta("assistant_text", "a")])!;
    expect(foldLiveTurn(live, delta("assistant_text", ""))).toBe(live);
    expect(foldLiveTurn(live, { ...base(), type: "session.exited" })).toBe(live);
    expect(foldLiveTurn(live, { ...base(), type: "item.completed", itemType: "tool", ok: true })).toBe(live);
  });

  describe("duplicate and out-of-order frames after a reconnect", () => {
    it("drops an exact duplicate delta delivery", () => {
      const dup = delta("assistant_text", "once", { eventId: "same" });
      expect(run([started(), dup, dup])?.reply).toBe("once");
    });

    // Replayed frames keep their original event ids, whatever has arrived since.
    it("a non-adjacent duplicate delta is applied once (H, i, H replayed → Hi)", () => {
      const h = delta("assistant_text", "H", { itemId: "m1" });
      expect(run([started(), h, delta("assistant_text", "i", { itemId: "m1" }), h])?.reply).toBe("Hi");
    });

    it("a replayed delta of an older turn cannot displace the current turn", () => {
      const late = delta("assistant_text", "old", { turnId: "a", itemId: "a1" });
      const live = run([started(undefined, "a"), late, completed(undefined, "a"), started(undefined, "b"), delta("assistant_text", "new", { turnId: "b", itemId: "b1" }), late]);
      expect(live).toMatchObject({ turnId: "b", reply: "new", ended: false });
    });

    it("a replayed turn.started of an older turn cannot reset the current turn", () => {
      const oldStart = started(undefined, "a");
      const live = run([oldStart, completed(undefined, "a"), started(undefined, "b"), delta("assistant_text", "new", { turnId: "b" }), oldStart]);
      expect(live).toMatchObject({ turnId: "b", reply: "new" });
    });

    it("a replayed completion of an older item cannot erase a different item's live reply", () => {
      const first = stored("first", { itemId: "m1" });
      const live = run([started(), delta("assistant_text", "first", { itemId: "m1" }), first, delta("assistant_text", "second", { itemId: "m2" }), first]);
      expect(live?.reply).toBe("second");
      // even a re-issued completion for m1 (new event id) is idempotent
      expect(foldLiveTurn(live, stored("first", { itemId: "m1" }))?.reply).toBe("second");
    });

    it("completing item A does not clear item B's live reply", () => {
      const live = run([started(), delta("assistant_text", "B text", { itemId: "m2" }), stored("A", { itemId: "m1" })]);
      expect(live?.reply).toBe("B text");
    });

    it("a replayed older-turn completion cannot end the current turn", () => {
      const done = completed(undefined, "a");
      const live = run([started(undefined, "a"), done, started(undefined, "b"), delta("assistant_text", "new", { turnId: "b" }), done]);
      expect(live).toMatchObject({ turnId: "b", reply: "new", ended: false });
    });

    it("a replayed turn.started does not wipe the turn in flight", () => {
      const start = started();
      expect(run([start, delta("assistant_text", "kept"), start])?.reply).toBe("kept");
    });

    it("a stale turn.started cannot revive a finished turn", () => {
      const start = started();
      const live = run([start, delta("assistant_text", "x"), completed(), start]);
      expect(live?.ended).toBe(true);
      expect(visibleLiveTurn(live)).toBeNull();
    });

    it("a late delta for a finished turn is ignored", () => {
      const live = run([started(), completed(), delta("assistant_text", "late"), delta("reasoning_text", "late")]);
      expect(live).toMatchObject({ ended: true, reply: "", reasoning: "" });
    });

    it("a delta that beats its own turn.completed, then the completion, leaves nothing", () => {
      const live = run([delta("assistant_text", "early"), completed()]);
      expect(live?.ended).toBe(true);
    });

    it("a late delta for a reply already stored does not resurrect it", () => {
      const live = run([started(), delta("assistant_text", "done", { itemId: "m1" }), stored("done", { itemId: "m1" }), delta("assistant_text", "done", { itemId: "m1" })]);
      expect(live?.reply).toBe("");
    });

    it("a second reply item in the same turn streams after the first is stored", () => {
      const live = run([started(), delta("assistant_text", "one", { itemId: "m1" }), stored("one", { itemId: "m1" }), delta("assistant_text", "two", { itemId: "m2" })]);
      expect(live?.reply).toBe("two");
    });

    it("joins a turn whose start was missed and flags it", () => {
      const live = run([delta("assistant_text", "mid", { turnId: "unseen" })]);
      expect(live).toMatchObject({ turnId: "unseen", reply: "mid", joinedMidStream: true });
    });

    it("deltas of a newer unseen turn replace the previous turn's text", () => {
      const live = run([started(undefined, "a"), delta("assistant_text", "old", { turnId: "a" }), delta("assistant_text", "new", { turnId: "b" })]);
      expect(live).toMatchObject({ turnId: "b", reply: "new" });
    });

    it("a stored message for another turn leaves this turn's reply alone", () => {
      const live = run([started(undefined, "a"), delta("assistant_text", "mine", { turnId: "a" }), stored("other", { turnId: "z" })]);
      expect(live?.reply).toBe("mine");
    });
  });

  it("caps each stream at the tail and flags truncation", () => {
    const chunk = "x".repeat(LIVE_TURN_MAX_CHARS);
    const live = run([started(), delta("assistant_text", chunk), delta("assistant_text", "END")]);
    expect(live?.reply).toHaveLength(LIVE_TURN_MAX_CHARS);
    expect(live?.reply.endsWith("END")).toBe(true);
    expect(live?.truncated).toBe(true);
    // the other stream is capped independently
    expect(run([started(), delta("reasoning_text", "r")], live)?.reasoning).toBe("r");
  });
});
