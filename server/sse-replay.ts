/**
 * The SSE resume buffer: the last N durable frames, so a reconnecting client
 * can ask for what it missed instead of re-hydrating.
 *
 * Streamed text deltas (`content.delta`) are replaceable: the finished
 * message (`item.completed`) is the authoritative copy, and a client that
 * reconnects mid-turn recovers from it. They arrive at ~16 frames/s per
 * streaming thread, so retaining them would push durable frames (messages,
 * config, tool results) out of the buffer within ~30 s of a turn and make
 * the client re-hydrate for no good reason. They are therefore never
 * retained, and they do not count as lost when judging whether a cursor can
 * still be honoured.
 */

export type ReplayEntry = {
  seq: number;
  kind: string;
  frame: string | null;
  clientFrame: string | null;
  payload: Record<string, unknown> | null;
};

/** A runtime frame carrying only a streamed fragment of text. */
export function isStreamDelta(payload: Record<string, unknown>): boolean {
  if (payload.kind !== "runtime") return false;
  const event = payload.event as { type?: unknown } | null | undefined;
  return event?.type === "content.delta";
}

export function createReplayBuffer(max: number) {
  const entries: ReplayEntry[] = [];
  // Sequence of the newest retained frame that was evicted. A cursor below
  // it has missed something that can no longer be replayed.
  let evictedThrough = 0;
  return {
    entries,
    /** Retain a frame. Stream deltas are skipped outright (no slot). */
    push(entry: ReplayEntry, payload: Record<string, unknown>): void {
      if (isStreamDelta(payload)) return;
      entries.push(entry);
      if (entries.length > max) evictedThrough = entries.shift()!.seq;
    },
    /** Whether everything after `since` that is replayable is still held. */
    canResume(since: number, lastSeq: number): boolean {
      return since <= lastSeq && since >= evictedThrough;
    },
  };
}
