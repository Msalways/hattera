import type { RuntimeEvent } from "../../shared/runtime-events";

/**
 * The in-flight text of one thread's current turn, folded from runtime
 * frames. It is display state only: never persisted, never sent anywhere,
 * and replaced by the stored message when that lands (`item.completed`).
 * Engine-agnostic: it reads normalized RuntimeEvents and nothing else.
 *
 * Frames can be replayed after a reconnect with their original event id and
 * `createdAt`, interleaved with newer frames. Staleness is therefore decided
 * by ordering, not by remembering ids, so it holds however long the history:
 *
 *  - Turns on a thread run one after another, so a frame naming a turn other
 *    than the current one is stale unless it was created after the current
 *    turn started (`startedAt`). One timestamp, no list of past turns.
 *  - Within a turn, each stream (reasoning, reply, completions) keeps a
 *    high-water mark of `createdAt`. A frame older than the mark is a
 *    replay. A frame at exactly the mark (the clock has millisecond
 *    resolution and streams can interleave inside one) is a replay only if
 *    its id is one already applied at that millisecond.
 *
 * Memory is O(1) per thread apart from the text itself. The clock is the
 * server's wall clock: if it steps backwards a genuine frame can be taken
 * for a replay and skipped, which loses live text but never corrupts the
 * stored transcript (the finished message is authoritative).
 */
export interface Mark {
  /** createdAt (ms) of the newest frame applied on this stream; NaN-free. */
  at: number;
  /** ids applied at exactly `at` (a handful, reset whenever `at` advances). */
  ids: string[];
}

export interface LiveTurn {
  turnId: string | undefined;
  /** When the current turn started (ms): the monotonic turn mark. */
  startedAt: number;
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
  reasoningMark: Mark;
  replyMark: Mark;
  completionMark: Mark;
}

/** Per stream (reasoning, reply): enough for any realistic turn, bounded so a
 * runaway stream cannot grow client memory without limit. */
export const LIVE_TURN_MAX_CHARS = 64_000;
/** Ids kept per millisecond; far above what one millisecond can produce. */
const IDS_PER_MS_MAX = 64;

const NEVER: Mark = { at: -Infinity, ids: [] };

function fresh(turnId: string | undefined, startedAt: number, joinedMidStream: boolean): LiveTurn {
  return {
    turnId,
    startedAt,
    reasoning: "",
    reply: "",
    replyItemId: undefined,
    truncated: false,
    ended: false,
    joinedMidStream,
    reasoningMark: NEVER,
    replyMark: NEVER,
    completionMark: NEVER,
  };
}

function appendCapped(current: string, delta: string): { text: string; truncated: boolean } {
  const joined = current + delta;
  return joined.length > LIVE_TURN_MAX_CHARS
    ? { text: joined.slice(joined.length - LIVE_TURN_MAX_CHARS), truncated: true }
    : { text: joined, truncated: false };
}

function timeOf(event: RuntimeEvent): number {
  return Date.parse(event.createdAt);
}

/** Whether a frame is new for a stream: strictly newer than its mark, or at
 * the mark's millisecond with an id not yet applied. */
function isNew(mark: Mark, at: number, id: string): boolean {
  return at > mark.at || (at === mark.at && !mark.ids.includes(id));
}

function advance(mark: Mark, at: number, id: string): Mark {
  return at > mark.at ? { at, ids: [id] } : { at: mark.at, ids: [...mark.ids, id].slice(-IDS_PER_MS_MAX) };
}

/** The live turn an event belongs to: the current one, a new one when the
 * event was created after the current turn started, or null when it is
 * stale (an older turn's frame, or one whose time cannot be ordered). */
function turnFor(live: LiveTurn | undefined, event: RuntimeEvent, joinedMidStream: boolean): LiveTurn | null {
  const at = timeOf(event);
  if (!live) return fresh(event.turnId, Number.isNaN(at) ? 0 : at, joinedMidStream);
  // a frame that names no turn can only belong to the one in flight
  if (live.turnId === event.turnId || event.turnId === undefined) return live;
  if (Number.isNaN(at) || at <= live.startedAt) return null;
  return fresh(event.turnId, at, joinedMidStream);
}

/** Fold one runtime event into a thread's live turn. Pure; returns `live`
 * itself when the event changes nothing so callers can skip a re-render. */
export function foldLiveTurn(live: LiveTurn | undefined, event: RuntimeEvent): LiveTurn | undefined {
  switch (event.type) {
    case "turn.started": {
      // A replayed start (current, or older than current) changes nothing.
      const turn = turnFor(live, event, false);
      return turn === null ? live : turn;
    }
    case "content.delta": {
      if (!event.delta) return live;
      const turn = turnFor(live, event, true);
      if (turn === null || turn.ended) return live;
      const at = timeOf(event);
      const reasoning = event.streamKind === "reasoning_text";
      const mark = reasoning ? turn.reasoningMark : turn.replyMark;
      if (Number.isNaN(at) || !isNew(mark, at, event.eventId)) return live;
      const advanced = advance(mark, at, event.eventId);
      if (reasoning) {
        const next = appendCapped(turn.reasoning, event.delta);
        return { ...turn, reasoning: next.text, truncated: turn.truncated || next.truncated, reasoningMark: advanced };
      }
      // A reply belongs to one item: text for a different item starts over.
      const sameItem = !event.itemId || turn.replyItemId === undefined || turn.replyItemId === event.itemId;
      const next = appendCapped(sameItem ? turn.reply : "", event.delta);
      return {
        ...turn,
        reply: next.text,
        replyItemId: event.itemId ?? turn.replyItemId,
        truncated: turn.truncated || next.truncated,
        replyMark: advanced,
      };
    }
    case "item.completed": {
      if (event.itemType !== "assistant_text" || !live || live.ended) return live;
      const turn = turnFor(live, event, false);
      if (turn === null || turn !== live) return live;
      const at = timeOf(event);
      if (Number.isNaN(at) || !isNew(live.completionMark, at, event.eventId)) return live;
      const completionMark = advance(live.completionMark, at, event.eventId);
      // Deltas created before this completion belong to the stored message;
      // however late they are delivered they must not bring the text back.
      const replyMark = at > live.replyMark.at ? { at, ids: [event.eventId] } : live.replyMark;
      // The stored message is the authoritative copy of the reply it owns;
      // text streaming for a different item stays.
      const owns = !event.itemId || live.replyItemId === undefined || live.replyItemId === event.itemId;
      return owns
        ? { ...live, reply: "", replyItemId: undefined, completionMark, replyMark }
        : { ...live, completionMark };
    }
    case "turn.completed": {
      const turn = turnFor(live, event, false);
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
