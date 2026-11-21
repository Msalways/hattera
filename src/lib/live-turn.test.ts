import { describe, expect, it } from "vitest";

import type { RuntimeEvent } from "../../shared/runtime-events";
import { foldLiveTurn, LIVE_TURN_MAX_CHARS, parseFrameCursor, visibleLiveTurn, type LiveTurn } from "./live-turn";

let n = 0;
let seq = 0;
const STREAM = "stream-a";
// Each frame the helpers build gets the next SSE seq, like a real stream; a
// replay passes the same object again, so it carries its original seq.
const seqs = new Map<RuntimeEvent, number>();
const tag = (event: RuntimeEvent): RuntimeEvent => {
  seqs.set(event, ++seq);
  return event;
};
const base = (threadId = "t1", turnId: string | undefined = "turn-1") => ({
  eventId: `e${++n}`,
  provider: "any",
  threadId,
  turnId,
  // createdAt is deliberately constant: ordering must not depend on it
  createdAt: "2026-11-20T00:00:00.000Z",
});
const started = (threadId?: string, turnId?: string): RuntimeEvent => tag({ ...base(threadId, turnId), type: "turn.started" });
const completed = (threadId?: string, turnId?: string): RuntimeEvent => tag({ ...base(threadId, turnId), type: "turn.completed", ok: true });
const delta = (streamKind: "assistant_text" | "reasoning_text", text: string, extra: { threadId?: string; turnId?: string; itemId?: string; eventId?: string } = {}): RuntimeEvent =>
  tag({
    ...base(extra.threadId, extra.turnId),
    ...(extra.itemId ? { itemId: extra.itemId } : {}),
    ...(extra.eventId ? { eventId: extra.eventId } : {}),
    type: "content.delta",
    streamKind,
    delta: text,
  });
const stored = (text: string, extra: { threadId?: string; turnId?: string; itemId?: string } = {}): RuntimeEvent =>
  tag({
    ...base(extra.threadId, extra.turnId),
    ...(extra.itemId ? { itemId: extra.itemId } : {}),
    type: "item.completed",
    itemType: "assistant_text",
    text,
  });

/** Fold with the event's tagged cursor (none for an untagged event). */
const fold = (live: LiveTurn | undefined, event: RuntimeEvent): LiveTurn | undefined => {
  const at = seqs.get(event);
  return foldLiveTurn(live, event, at === undefined ? undefined : { streamId: STREAM, seq: at });
};
const run = (events: RuntimeEvent[], from?: LiveTurn): LiveTurn | undefined => events.reduce<LiveTurn | undefined>(fold, from);

describe("foldLiveTurn", () => {
  it("accumulates reasoning and reply separately, in order", () => {
    const live = run([started(), delta("reasoning_text", "think "), delta("reasoning_text", "more"), delta("assistant_text", "Hel"), delta("assistant_text", "lo")]);
    expect(live).toMatchObject({ reasoning: "think more", reply: "Hello", ended: false, joinedMidStream: false });
    expect(visibleLiveTurn(live)).toBe(live);
  });

  it("resets on turn.started for a new turn", () => {
    const first = run([started(undefined, "a"), delta("reasoning_text", "old", { turnId: "a" })]);
    const next = fold(first, started(undefined, "b"));
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
    expect(fold(undefined, stored("hi"))).toBeUndefined();
    expect(fold(run([started()]), stored("hi"))).toMatchObject({ reply: "" });
  });

  it("ignores empty deltas and unrelated events without changing state", () => {
    const live = run([started(), delta("assistant_text", "a")])!;
    expect(fold(live, delta("assistant_text", ""))).toBe(live);
    expect(fold(live, { ...base(), type: "session.exited" })).toBe(live);
    expect(fold(live, { ...base(), type: "item.completed", itemType: "tool", ok: true })).toBe(live);
  });

  describe("duplicate and out-of-order frames after a reconnect", () => {
    it("drops an exact duplicate delta delivery", () => {
      const start = started();
      const dup = delta("assistant_text", "once", { eventId: "same" });
      expect(run([start, dup, dup])?.reply).toBe("once");
    });

    // Replayed frames keep their original event ids, whatever has arrived since.
    it("a non-adjacent duplicate delta is applied once (H, i, H replayed → Hi)", () => {
      const start = started();
      const h = delta("assistant_text", "H", { itemId: "m1" });
      expect(run([start, h, delta("assistant_text", "i", { itemId: "m1" }), h])?.reply).toBe("Hi");
    });

    it("a replayed delta of an older turn cannot displace the current turn", () => {
      const startA = started(undefined, "a");
      const late = delta("assistant_text", "old", { turnId: "a", itemId: "a1" });
      const live = run([startA, late, completed(undefined, "a"), started(undefined, "b"), delta("assistant_text", "new", { turnId: "b", itemId: "b1" }), late]);
      expect(live).toMatchObject({ turnId: "b", reply: "new", ended: false });
    });

    it("a replayed turn.started of an older turn cannot reset the current turn", () => {
      const oldStart = started(undefined, "a");
      const live = run([oldStart, completed(undefined, "a"), started(undefined, "b"), delta("assistant_text", "new", { turnId: "b" }), oldStart]);
      expect(live).toMatchObject({ turnId: "b", reply: "new" });
    });

    it("a replayed completion of an older item cannot erase a different item's live reply", () => {
      const start = started();
      const streamed = delta("assistant_text", "first", { itemId: "m1" });
      const first = stored("first", { itemId: "m1" });
      const live = run([start, streamed, first, delta("assistant_text", "second", { itemId: "m2" }), first]);
      expect(live?.reply).toBe("second");
      // even a re-issued completion for m1 (new event id) is idempotent
      expect(fold(live, stored("first", { itemId: "m1" }))?.reply).toBe("second");
    });

    it("completing item A does not clear item B's live reply", () => {
      const live = run([started(), delta("assistant_text", "B text", { itemId: "m2" }), stored("A", { itemId: "m1" })]);
      expect(live?.reply).toBe("B text");
    });

    it("a replayed older-turn completion cannot end the current turn", () => {
      const startA = started(undefined, "a");
      const done = completed(undefined, "a");
      const live = run([startA, done, started(undefined, "b"), delta("assistant_text", "new", { turnId: "b" }), done]);
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
      // created before the stored message, delivered after it
      const start = started();
      const first = delta("assistant_text", "do", { itemId: "m1" });
      const straggler = delta("assistant_text", "done", { itemId: "m1" });
      const live = run([start, first, straggler, stored("done", { itemId: "m1" }), straggler]);
      expect(live?.reply).toBe("");
      const start2 = started();
      const first2 = delta("assistant_text", "do", { itemId: "m1" });
      const reordered = delta("assistant_text", "ne", { itemId: "m1" });
      expect(run([start2, first2, reordered, stored("done", { itemId: "m1" }), reordered])?.reply).toBe("");
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

  describe("replays from beyond any bounded history", () => {
    it("a duplicate delta after 600 newer frames is still applied once", () => {
      const start = started();
      const h = delta("assistant_text", "H", { itemId: "m" });
      let live = run([start, h]);
      for (let i = 0; i < 600; i++) live = fold(live, delta("assistant_text", "i", { itemId: "m" }));
      const before = live!.reply;
      expect(before).toHaveLength(601);
      expect(fold(live, h)?.reply).toBe(before);
      expect(fold(live, h)).toBe(live);
    });

    it("an old turn.started after 40 newer turns cannot displace the current turn", () => {
      const old = started(undefined, "old");
      let live = fold(undefined, old);
      for (let i = 0; i < 40; i++) live = fold(live, started(undefined, "turn-" + i));
      live = fold(live, delta("assistant_text", "new", { turnId: "turn-39", itemId: "m" }));
      const replayed = fold(live, old);
      expect(replayed).toBe(live);
      expect(replayed).toMatchObject({ turnId: "turn-39", reply: "new" });
    });

    it("old-turn deltas and completions after 40 newer turns are ignored too", () => {
      const oldStart = started(undefined, "old");
      const oldDelta = delta("assistant_text", "old", { turnId: "old", itemId: "o1" });
      const oldDone = completed(undefined, "old");
      let live = run([oldStart, oldDelta]);
      for (let i = 0; i < 40; i++) live = fold(live, started(undefined, "turn-" + i));
      live = fold(live, delta("assistant_text", "new", { turnId: "turn-39" }));
      expect(fold(fold(live, oldDelta), oldDone)).toBe(live);
    });

    it("a replayed completion of an old item after many newer items is a no-op", () => {
      const start = started();
      const streamed = delta("assistant_text", "first", { itemId: "m0" });
      const first = stored("first", { itemId: "m0" });
      let live = run([start, streamed, first]);
      for (let i = 1; i <= 40; i++) {
        live = fold(live, delta("assistant_text", "t" + i, { itemId: "m" + i }));
        live = fold(live, stored("t" + i, { itemId: "m" + i }));
      }
      live = fold(live, delta("assistant_text", "live", { itemId: "m99" }));
      expect(fold(live, first)).toBe(live);
    });

    it("memory stays bounded however many frames arrive", () => {
      let live = run([started()]);
      for (let i = 0; i < 5000; i++) live = fold(live, delta("reasoning_text", "r"));
      expect(live!.completedItems.length).toBe(0);
      expect(Object.keys(live!).length).toBeLessThan(20);
      // the completed-item list is capped within one turn
      for (let i = 0; i < 400; i++) live = fold(live, stored("x", { itemId: "item-" + i }));
      expect(live!.completedItems.length).toBeLessThanOrEqual(256);
    });
  });

  // Order comes from the SSE cursor, not from createdAt. These are the cases
  // createdAt (millisecond precision, not a total order) cannot decide.
  describe("ordering by the SSE frame cursor", () => {
    const at = (streamId: string, seq: number) => ({ streamId, seq });
    const ev = (type: "turn.started" | "turn.completed" | "delta" | "stored", turnId: string, extra: { text?: string; itemId?: string; createdAt?: string } = {}): RuntimeEvent => {
      const common = { eventId: `x${++n}`, provider: "any", threadId: "t1", turnId, createdAt: extra.createdAt ?? "2026-11-20T00:00:00.000Z" };
      if (type === "turn.started") return { ...common, type };
      if (type === "turn.completed") return { ...common, type, ok: true };
      if (type === "stored") return { ...common, type: "item.completed", itemType: "assistant_text", itemId: extra.itemId ?? "m", text: "stored" };
      return { ...common, type: "content.delta", streamKind: "assistant_text", delta: extra.text ?? "x", itemId: extra.itemId ?? "m" };
    };

    it("65 deltas in one millisecond: replaying the first does not apply it again", () => {
      const first = ev("delta", "a", { text: "H" });
      let live = foldLiveTurn(undefined, ev("turn.started", "a"), at("s", 1));
      live = foldLiveTurn(live, first, at("s", 2));
      for (let i = 0; i < 64; i++) live = foldLiveTurn(live, ev("delta", "a", { text: "i" }), at("s", 3 + i));
      expect(live?.reply).toBe("H" + "i".repeat(64));
      expect(foldLiveTurn(live, first, at("s", 2))).toBe(live);
    });

    it("turn A starts, A completes, B starts in the same millisecond: B streams", () => {
      let live = foldLiveTurn(undefined, ev("turn.started", "a"), at("s", 1));
      live = foldLiveTurn(live, ev("turn.completed", "a"), at("s", 2));
      live = foldLiveTurn(live, ev("turn.started", "b"), at("s", 3));
      live = foldLiveTurn(live, ev("delta", "b", { text: "new" }), at("s", 4));
      expect(live).toMatchObject({ turnId: "b", reply: "new", ended: false });
    });

    it("an undelivered delta for a stored item, equal time, does not bring the reply back", () => {
      let live = foldLiveTurn(undefined, ev("turn.started", "a"), at("s", 1));
      live = foldLiveTurn(live, ev("stored", "a", { itemId: "m" }), at("s", 3));
      // seq 2 was created before the stored message but delivered after it
      expect(foldLiveTurn(live, ev("delta", "a", { text: "old", itemId: "m" }), at("s", 2))?.reply).toBe("");
      // a newer seq for the same completed item is ignored too
      expect(foldLiveTurn(live, ev("delta", "a", { text: "again", itemId: "m" }), at("s", 4))?.reply).toBe("");
      // but a different item in the turn still streams
      expect(foldLiveTurn(live, ev("delta", "a", { text: "next", itemId: "m2" }), at("s", 5))?.reply).toBe("next");
    });

    it("a turn.completed with an invalid createdAt is ordered by its cursor, not its time", () => {
      let live = foldLiveTurn(undefined, ev("turn.started", "a"), at("s", 1));
      live = foldLiveTurn(live, ev("delta", "a", { text: "live" }), at("s", 2));
      // createdAt plays no part: a replay with a garbage time is still a replay
      const garbled = ev("turn.completed", "a", { createdAt: "invalid" });
      expect(foldLiveTurn(live, garbled, at("s", 2))).toBe(live);
      expect(foldLiveTurn(live, garbled, at("s", 3))).toMatchObject({ ended: true, reply: "" });
    });

    it("createdAt is ignored: a clock stepping backwards does not drop a genuine frame", () => {
      let live = foldLiveTurn(undefined, ev("turn.started", "a", { createdAt: "2026-11-20T00:00:10.000Z" }), at("s", 1));
      live = foldLiveTurn(live, ev("delta", "a", { text: "ok", createdAt: "2026-11-20T00:00:05.000Z" }), at("s", 2));
      expect(live?.reply).toBe("ok");
    });

    it("a new stream id resets everything; the old run's seq is not comparable", () => {
      let live = foldLiveTurn(undefined, ev("turn.started", "a"), at("run-1", 1));
      live = foldLiveTurn(live, ev("delta", "a", { text: "old" }), at("run-1", 900));
      // the server restarted: seq starts over, so seq 2 is new, not a replay
      live = foldLiveTurn(live, ev("delta", "b", { text: "fresh" }), at("run-2", 2));
      expect(live).toMatchObject({ turnId: "b", reply: "fresh", streamId: "run-2", joinedMidStream: true });
      // within the new run the usual replay rule applies again
      expect(foldLiveTurn(live, ev("delta", "b", { text: "again" }), at("run-2", 2))).toBe(live);
    });

    it("a frame with no cursor is applied but flagged, not ordered by guesswork", () => {
      expect(foldLiveTurn(undefined, ev("delta", "a", { text: "x" }))).toMatchObject({ reply: "x", joinedMidStream: true });
      expect(foldLiveTurn(undefined, ev("turn.started", "a"))?.joinedMidStream).toBe(true);
    });

    it("parseFrameCursor reads the SSE id, and nothing else", () => {
      expect(parseFrameCursor("abcd1234:57")).toEqual({ streamId: "abcd1234", seq: 57 });
      for (const bad of [undefined, "", "abcd1234", ":5", "s:x", "s:-1", "s:1.5"]) expect(parseFrameCursor(bad)).toBeUndefined();
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
