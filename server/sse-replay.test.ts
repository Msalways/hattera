// Unit test for the SSE resume buffer: streamed text deltas must not be
// retained (they would evict durable frames within seconds of a turn), while
// everything else still replays in order after a reconnect. Lives beside
// sse-fanout.test.ts for the same reason: runtime.ts starts a server on
// import, so this logic is in its own file.
import { describe, expect, it } from "vitest";

import { createReplayBuffer, isStreamDelta, type ReplayEntry } from "./sse-replay.ts";

const delta = (seq: number) => ({ kind: "runtime", event: { type: "content.delta", streamKind: "assistant_text", delta: "x", seq } });
const durable = (seq: number, kind = "message") => ({ kind, seq });
const entryFor = (payload: Record<string, unknown>, seq: number): ReplayEntry => ({
  seq,
  kind: String(payload.kind),
  frame: `id: s:${seq}`,
  clientFrame: `id: s:${seq}`,
  payload,
});

/** Mirrors broadcast(): every frame takes the next seq, then is offered. */
function feed(buffer: ReturnType<typeof createReplayBuffer>, payloads: Record<string, unknown>[]): number {
  let seq = 0;
  for (const payload of payloads) buffer.push(entryFor(payload, ++seq), payload);
  return seq;
}

describe("isStreamDelta", () => {
  it("matches only runtime content.delta frames", () => {
    expect(isStreamDelta(delta(1))).toBe(true);
    expect(isStreamDelta({ kind: "runtime", event: { type: "item.completed" } })).toBe(false);
    expect(isStreamDelta({ kind: "runtime" })).toBe(false);
    expect(isStreamDelta({ kind: "message", event: { type: "content.delta" } })).toBe(false);
  });
});

describe("replay buffer", () => {
  it("does not retain content.delta frames", () => {
    const buffer = createReplayBuffer(500);
    feed(buffer, [delta(1), delta(2), delta(3)]);
    expect(buffer.entries).toHaveLength(0);
  });

  it("replays non-delta frames in order, skipping the deltas between them", () => {
    const buffer = createReplayBuffer(500);
    const last = feed(buffer, [durable(1, "message"), delta(2), delta(3), durable(4, "bot.queued"), delta(5), durable(6, "message")]);
    expect(buffer.canResume(0, last)).toBe(true);
    expect(buffer.entries.map((e) => e.seq)).toEqual([1, 4, 6]);
    // a client that last saw seq 3 resumes with exactly the later durable frames
    expect(buffer.entries.filter((e) => e.seq > 3).map((e) => e.seq)).toEqual([4, 6]);
  });

  it("a long delta stream never pushes durable frames out", () => {
    const buffer = createReplayBuffer(500);
    const payloads: Record<string, unknown>[] = [durable(1)];
    for (let i = 0; i < 2000; i++) payloads.push(delta(i));
    payloads.push(durable(0));
    const last = feed(buffer, payloads);
    expect(buffer.entries.map((e) => e.seq)).toEqual([1, last]);
    // a cursor from before the burst can still resume: only deltas were skipped
    expect(buffer.canResume(1, last)).toBe(true);
    expect(buffer.canResume(0, last)).toBe(true);
  });

  it("still refuses a cursor older than an evicted durable frame", () => {
    const buffer = createReplayBuffer(3);
    const last = feed(buffer, [durable(1), durable(2), durable(3), durable(4), durable(5)]);
    expect(buffer.entries.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(buffer.canResume(1, last)).toBe(false); // frame 2 is gone
    expect(buffer.canResume(2, last)).toBe(true); // next frame, 3, is held
    expect(buffer.canResume(last, last)).toBe(true);
  });

  it("refuses a cursor from the future", () => {
    const buffer = createReplayBuffer(5);
    const last = feed(buffer, [durable(1)]);
    expect(buffer.canResume(last + 1, last)).toBe(false);
  });

  it("keeps screen-style placeholder slots counting toward the bound", () => {
    const buffer = createReplayBuffer(2);
    const screen = (seq: number): ReplayEntry => ({ seq, kind: "screen", frame: null, clientFrame: null, payload: null });
    const p = { kind: "screen" };
    buffer.push(screen(1), p);
    buffer.push(screen(2), p);
    buffer.push(screen(3), p);
    expect(buffer.entries.map((e) => e.seq)).toEqual([2, 3]);
    expect(buffer.canResume(0, 3)).toBe(false);
  });
});
