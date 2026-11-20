import type { RuntimeEvent } from "../../shared/runtime-events";

/**
 * The in-flight text of one thread's current turn, folded from runtime
 * frames. It is display state only: never persisted, never sent anywhere,
 * and replaced by the stored message when that lands (`item.completed`).
 * Engine-agnostic: it reads normalized RuntimeEvents and nothing else.
 */
export interface LiveTurn {
  turnId: string | undefined;
  /** Streamed reasoning text for the turn (tail-capped). */
  reasoning: string;
  /** Streamed reply text not yet stored as a message (tail-capped). */
  reply: string;
  /** Text was dropped from the front to stay within LIVE_TURN_MAX_CHARS. */
  truncated: boolean;
  /** The turn finished; kept as a tombstone so a late or replayed delta for
   * it cannot start a phantom stream. Show nothing while this is true. */
  ended: boolean;
  /** First seen from a delta rather than `turn.started`, so earlier text of
   * this turn may be missing (e.g. after a refused resume). */
  joinedMidStream: boolean;
  /** Reply items already stored; late/duplicate deltas for them are ignored. */
  completedItems: string[];
  /** eventId of the last delta folded, to drop an exact duplicate delivery. */
  lastDeltaEventId: string | undefined;
}

/** Per stream (reasoning, reply): enough for any realistic turn, bounded so a
 * runaway stream cannot grow client memory without limit. */
export const LIVE_TURN_MAX_CHARS = 64_000;
const COMPLETED_ITEMS_MAX = 16;

function fresh(turnId: string | undefined, joinedMidStream: boolean): LiveTurn {
  return {
    turnId,
    reasoning: "",
    reply: "",
    truncated: false,
    ended: false,
    joinedMidStream,
    completedItems: [],
    lastDeltaEventId: undefined,
  };
}

function appendCapped(current: string, delta: string): { text: string; truncated: boolean } {
  const joined = current + delta;
  return joined.length > LIVE_TURN_MAX_CHARS
    ? { text: joined.slice(joined.length - LIVE_TURN_MAX_CHARS), truncated: true }
    : { text: joined, truncated: false };
}

/** Fold one runtime event into a thread's live turn. Pure; returns `live`
 * itself when the event changes nothing so callers can skip a re-render. */
export function foldLiveTurn(live: LiveTurn | undefined, event: RuntimeEvent): LiveTurn | undefined {
  switch (event.type) {
    case "turn.started":
      // A replayed start for the turn already in flight must not wipe it,
      // and a stale start for a turn that already ended must not revive it.
      if (live && live.turnId === event.turnId) return live;
      return fresh(event.turnId, false);
    case "content.delta": {
      if (!event.delta) return live;
      let base = live;
      if (base && base.turnId !== event.turnId) base = undefined; // a newer turn we saw no start for
      if (base?.ended) return live; // late delta for a finished turn
      if (base?.lastDeltaEventId === event.eventId) return live; // duplicate delivery
      if (event.itemId && base?.completedItems.includes(event.itemId)) return live; // already stored
      const current = base ?? fresh(event.turnId, true);
      if (event.streamKind === "reasoning_text") {
        const next = appendCapped(current.reasoning, event.delta);
        return { ...current, reasoning: next.text, truncated: current.truncated || next.truncated, lastDeltaEventId: event.eventId };
      }
      const next = appendCapped(current.reply, event.delta);
      return { ...current, reply: next.text, truncated: current.truncated || next.truncated, lastDeltaEventId: event.eventId };
    }
    case "item.completed": {
      if (event.itemType !== "assistant_text" || !live || live.ended) return live;
      if (live.turnId !== event.turnId) return live;
      // The stored message is the authoritative copy; the live reply goes.
      const completedItems = event.itemId
        ? [...live.completedItems, event.itemId].slice(-COMPLETED_ITEMS_MAX)
        : live.completedItems;
      return { ...live, reply: "", completedItems, lastDeltaEventId: undefined };
    }
    case "turn.completed":
      // Also tombstones a turn we never saw start (completed before its
      // first delta was delivered), so a straggler delta cannot reopen it.
      if (live && !live.ended && live.turnId !== event.turnId) return live;
      return { ...fresh(event.turnId, live?.joinedMidStream ?? false), ended: true };
    default:
      return live;
  }
}

/** What to render for a thread: null when nothing is streaming. */
export function visibleLiveTurn(live: LiveTurn | undefined): LiveTurn | null {
  return live && !live.ended && (live.reasoning || live.reply) ? live : null;
}
