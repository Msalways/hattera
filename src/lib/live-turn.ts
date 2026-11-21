import type { RuntimeEvent } from "../../shared/runtime-events";

/**
 * The in-flight text of one thread's current turn, folded from runtime
 * frames. It is display state only: never persisted, never sent anywhere,
 * and replaced by the stored message when that lands (`item.completed`).
 * Engine-agnostic: it reads normalized RuntimeEvents and nothing else.
 *
 * Frames can be replayed after a reconnect with their original event ids, in
 * any interleaving with newer frames. The fold is therefore idempotent
 * (an applied event id is never applied twice), monotonic across turns (a
 * frame from a turn that was current before can never displace the current
 * one), and item-scoped (a completion only clears the reply its item owns).
 */
export interface LiveTurn {
  turnId: string | undefined;
  /** Streamed reasoning text for the turn (tail-capped). */
  reasoning: string;
  /** Streamed reply text not yet stored as a message (tail-capped). */
  reply: string;
  /** The reply item the current `reply` text belongs to, when frames say. */
  replyItemId: string | undefined;
  /** Text was dropped from the front to stay within LIVE_TURN_MAX_CHARS. */
  truncated: boolean;
  /** The turn finished; kept as a tombstone so a late or replayed frame for
   * it cannot start a phantom stream. Show nothing while this is true. */
  ended: boolean;
  /** First seen from a delta rather than `turn.started`, so earlier text of
   * this turn may be missing (e.g. after a refused resume). */
  joinedMidStream: boolean;
  /** Reply items already stored; late/duplicate frames for them are ignored. */
  completedItems: string[];
  /** Turns that were current before this one, oldest first (bounded). Any
   * frame for one of them is stale. */
  seenTurns: string[];
  /** Event ids already folded into this turn (bounded), for idempotence. */
  appliedEventIds: string[];
}

/** Per stream (reasoning, reply): enough for any realistic turn, bounded so a
 * runaway stream cannot grow client memory without limit. */
export const LIVE_TURN_MAX_CHARS = 64_000;
const COMPLETED_ITEMS_MAX = 16;
const SEEN_TURNS_MAX = 32;
const APPLIED_EVENTS_MAX = 512;

function fresh(turnId: string | undefined, joinedMidStream: boolean, previous?: LiveTurn): LiveTurn {
  const seenTurns = previous
    ? [...previous.seenTurns, ...(previous.turnId === undefined ? [] : [previous.turnId])].slice(-SEEN_TURNS_MAX)
    : [];
  return {
    turnId,
    reasoning: "",
    reply: "",
    replyItemId: undefined,
    truncated: false,
    ended: false,
    joinedMidStream,
    completedItems: [],
    seenTurns,
    appliedEventIds: [],
  };
}

function appendCapped(current: string, delta: string): { text: string; truncated: boolean } {
  const joined = current + delta;
  return joined.length > LIVE_TURN_MAX_CHARS
    ? { text: joined.slice(joined.length - LIVE_TURN_MAX_CHARS), truncated: true }
    : { text: joined, truncated: false };
}

/** The live turn an event belongs to: the current one, a new one when the
 * event names a turn not seen before, or null when the event is stale (it
 * names a turn that was already current before). */
function turnFor(live: LiveTurn | undefined, turnId: string | undefined, joinedMidStream: boolean): LiveTurn | null {
  if (!live) return fresh(turnId, joinedMidStream);
  // a frame that names no turn can only belong to the one in flight
  if (live.turnId === turnId || turnId === undefined) return live;
  if (live.seenTurns.includes(turnId)) return null;
  return fresh(turnId, joinedMidStream, live);
}

function markApplied(turn: LiveTurn, eventId: string): string[] {
  return [...turn.appliedEventIds, eventId].slice(-APPLIED_EVENTS_MAX);
}

/** Fold one runtime event into a thread's live turn. Pure; returns `live`
 * itself when the event changes nothing so callers can skip a re-render. */
export function foldLiveTurn(live: LiveTurn | undefined, event: RuntimeEvent): LiveTurn | undefined {
  switch (event.type) {
    case "turn.started": {
      // A replayed start (current, or older than current) changes nothing.
      const turn = turnFor(live, event.turnId, false);
      return turn === null ? live : turn;
    }
    case "content.delta": {
      if (!event.delta) return live;
      const turn = turnFor(live, event.turnId, true);
      if (turn === null || turn.ended) return live;
      if (turn.appliedEventIds.includes(event.eventId)) return live;
      if (event.itemId && turn.completedItems.includes(event.itemId)) return live;
      const appliedEventIds = markApplied(turn, event.eventId);
      if (event.streamKind === "reasoning_text") {
        const next = appendCapped(turn.reasoning, event.delta);
        return { ...turn, reasoning: next.text, truncated: turn.truncated || next.truncated, appliedEventIds };
      }
      // A reply belongs to one item: text for a different item starts over.
      const sameItem = !event.itemId || turn.replyItemId === undefined || turn.replyItemId === event.itemId;
      const next = appendCapped(sameItem ? turn.reply : "", event.delta);
      return {
        ...turn,
        reply: next.text,
        replyItemId: event.itemId ?? turn.replyItemId,
        truncated: turn.truncated || next.truncated,
        appliedEventIds,
      };
    }
    case "item.completed": {
      if (event.itemType !== "assistant_text" || !live) return live;
      const turn = turnFor(live, event.turnId, false);
      if (turn === null || turn !== live || live.ended) return live;
      if (live.appliedEventIds.includes(event.eventId)) return live;
      // Completing an item twice is a replay: nothing to clear the second time.
      if (event.itemId && live.completedItems.includes(event.itemId)) return live;
      const appliedEventIds = markApplied(live, event.eventId);
      const completedItems = event.itemId
        ? [...live.completedItems, event.itemId].slice(-COMPLETED_ITEMS_MAX)
        : live.completedItems;
      // The stored message is the authoritative copy of the reply it owns;
      // text streaming for a different item stays.
      const owns = !event.itemId || live.replyItemId === undefined || live.replyItemId === event.itemId;
      return owns
        ? { ...live, reply: "", replyItemId: undefined, completedItems, appliedEventIds }
        : { ...live, completedItems, appliedEventIds };
    }
    case "turn.completed": {
      const turn = turnFor(live, event.turnId, false);
      if (turn === null || (turn === live && live.ended)) return live;
      // Also tombstones a turn we never saw start, so a straggler delta
      // cannot reopen it.
      return { ...turn, reasoning: "", reply: "", replyItemId: undefined, ended: true };
    }
    default:
      return live;
  }
}

/** What to render for a thread: null when nothing is streaming. */
export function visibleLiveTurn(live: LiveTurn | undefined): LiveTurn | null {
  return live && !live.ended && (live.reasoning || live.reply) ? live : null;
}
