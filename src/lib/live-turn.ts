import type { RuntimeEvent } from "../../shared/runtime-events";

/**
 * The in-flight text of one thread's current turn, folded from runtime
 * frames. It is display state only: never persisted, never sent anywhere,
 * and replaced by the stored message when that lands (`item.completed`).
 * Engine-agnostic: it reads normalized RuntimeEvents and nothing else.
 *
 * Frames can be replayed after a reconnect with their original content,
 * interleaved with newer frames. Order is decided by the SSE frame cursor
 * (`<streamId>:<seq>`), never by `createdAt` (millisecond resolution, not a
 * total order) and never by remembering ids:
 *
 *  - `seq` is assigned once per broadcast, strictly increasing within one
 *    server run (`streamId`), and a replayed frame keeps its original `seq`.
 *    So a frame at or below the newest `seq` already applied on this thread
 *    is a replay and is skipped. One number, however long the history.
 *  - A different `streamId` is a different server run: `seq` restarts, so
 *    everything held is dropped and the frame starts over (the store also
 *    clears all live turns when it hydrates a fresh snapshot).
 *  - A frame without a cursor cannot be ordered. It is applied, and the turn
 *    is flagged `joinedMidStream` instead of guessing at ordering.
 *  - Within the current turn, the ids of items already stored as messages
 *    are remembered so an undelivered delta for one of them cannot bring its
 *    text back, whatever its `seq`. Cleared with the turn.
 *
 * Memory is bounded: the text (tail-capped) plus a capped list of item ids.
 */
export interface LiveCursor {
  streamId: string;
  seq: number;
}

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
  /** First seen from a delta (or a frame with no cursor) rather than
   * `turn.started`, so earlier text of this turn may be missing. */
  joinedMidStream: boolean;
  /** Server run the cursor below belongs to; undefined until a cursor is seen. */
  streamId: string | undefined;
  /** Newest `seq` applied on this thread within `streamId`; -1 before any. */
  lastSeq: number;
  /** Assistant items of this turn already stored as messages (capped). */
  completedItems: string[];
}

/** Per stream (reasoning, reply): enough for any realistic turn, bounded so a
 * runaway stream cannot grow client memory without limit. */
export const LIVE_TURN_MAX_CHARS = 64_000;
/** Completed item ids kept for one turn; far above any realistic turn. */
const COMPLETED_ITEMS_MAX = 256;

/** Parse an SSE `id:` value, `<streamId>:<seq>`. Null when it is not one. */
export function parseFrameCursor(lastEventId: string | undefined | null): LiveCursor | undefined {
  if (!lastEventId) return undefined;
  const colon = lastEventId.lastIndexOf(":");
  if (colon <= 0) return undefined;
  const seq = Number(lastEventId.slice(colon + 1));
  return Number.isSafeInteger(seq) && seq >= 0 ? { streamId: lastEventId.slice(0, colon), seq } : undefined;
}

function fresh(turnId: string | undefined, cursor: LiveCursor | undefined, joinedMidStream: boolean): LiveTurn {
  return {
    turnId,
    reasoning: "",
    reply: "",
    replyItemId: undefined,
    truncated: false,
    ended: false,
    // no cursor: ordering is unknown, so earlier text may be missing
    joinedMidStream: joinedMidStream || !cursor,
    streamId: cursor?.streamId,
    lastSeq: cursor ? cursor.seq : -1,
    completedItems: [],
  };
}

function appendCapped(current: string, delta: string): { text: string; truncated: boolean } {
  const joined = current + delta;
  return joined.length > LIVE_TURN_MAX_CHARS
    ? { text: joined.slice(joined.length - LIVE_TURN_MAX_CHARS), truncated: true }
    : { text: joined, truncated: false };
}

/** Stamp a turn with the cursor it has now applied. */
function stamp(turn: LiveTurn, cursor: LiveCursor | undefined): LiveTurn {
  return cursor ? { ...turn, streamId: cursor.streamId, lastSeq: cursor.seq } : turn;
}

/** The live turn an event belongs to: the current one, or a new one when the
 * event names a different turn (it is newer, or the cursor would have
 * rejected it as a replay). */
function turnFor(live: LiveTurn | undefined, event: RuntimeEvent, cursor: LiveCursor | undefined, joinedMidStream: boolean): LiveTurn {
  if (!live) return fresh(event.turnId, cursor, joinedMidStream);
  // a frame that names no turn can only belong to the one in flight
  if (live.turnId === event.turnId || event.turnId === undefined) return live;
  return fresh(event.turnId, cursor, joinedMidStream);
}

/**
 * Fold one runtime event into a thread's live turn. Pure; returns `live`
 * itself when the event changes nothing so callers can skip a re-render.
 * `cursor` is the frame's SSE cursor (see `parseFrameCursor`).
 */
export function foldLiveTurn(live: LiveTurn | undefined, event: RuntimeEvent, cursor?: LiveCursor): LiveTurn | undefined {
  if (cursor && live) {
    // a different server run restarts `seq`: nothing held is comparable
    if (live.streamId !== undefined && live.streamId !== cursor.streamId) live = undefined;
    // at or below what this thread already applied: a replay
    else if (live.streamId !== undefined && cursor.seq <= live.lastSeq) return live;
  }
  switch (event.type) {
    case "turn.started": {
      const turn = turnFor(live, event, cursor, false);
      // a start for the turn already in flight changes nothing
      return turn === live ? live : turn;
    }
    case "content.delta": {
      if (!event.delta) return live;
      const turn = turnFor(live, event, cursor, true);
      if (turn.ended) return live;
      // an item already stored as a message must not stream again
      if (event.itemId && turn.completedItems.includes(event.itemId)) return live;
      if (event.streamKind === "reasoning_text") {
        const next = appendCapped(turn.reasoning, event.delta);
        return stamp({ ...turn, reasoning: next.text, truncated: turn.truncated || next.truncated }, cursor);
      }
      // A reply belongs to one item: text for a different item starts over.
      const sameItem = !event.itemId || turn.replyItemId === undefined || turn.replyItemId === event.itemId;
      const next = appendCapped(sameItem ? turn.reply : "", event.delta);
      return stamp(
        { ...turn, reply: next.text, replyItemId: event.itemId ?? turn.replyItemId, truncated: turn.truncated || next.truncated },
        cursor,
      );
    }
    case "item.completed": {
      if (event.itemType !== "assistant_text" || !live || live.ended) return live;
      // a stored message for another turn leaves this turn's reply alone
      if (event.turnId !== undefined && event.turnId !== live.turnId) return live;
      const completedItems = event.itemId && !live.completedItems.includes(event.itemId)
        ? [...live.completedItems, event.itemId].slice(-COMPLETED_ITEMS_MAX)
        : live.completedItems;
      // The stored message is the authoritative copy of the reply it owns;
      // text streaming for a different item stays.
      const owns = !event.itemId || live.replyItemId === undefined || live.replyItemId === event.itemId;
      return stamp(owns ? { ...live, reply: "", replyItemId: undefined, completedItems } : { ...live, completedItems }, cursor);
    }
    case "turn.completed": {
      const turn = turnFor(live, event, cursor, false);
      if (turn === live && live.ended) return live;
      // Also tombstones a turn we never saw start, so a straggler delta
      // cannot reopen it.
      return stamp({ ...turn, reasoning: "", reply: "", replyItemId: undefined, ended: true }, cursor);
    }
    default:
      return live;
  }
}

/** What to render for a thread: null when nothing is streaming. */
export function visibleLiveTurn(live: LiveTurn | undefined): LiveTurn | null {
  return live && !live.ended && (live.reasoning || live.reply) ? live : null;
}
