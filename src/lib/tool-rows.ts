// Inline tool rows (UX-10 S4): what one tool call reads as inside the turn.
// Pure and engine-agnostic: it reads a stored tool message and nothing else.
import type { Message } from "@/state/store";
import { isStatusActivity } from "@/lib/activity-runs";
import { isCancelledTranscriptRow } from "../../shared/client-cancel";
import { failedTurnCause } from "../../shared/failed-turn";

type Tool = NonNullable<Message["tool"]>;

export type ToolRowStatus = "running" | "done" | "failed" | "cancelled" | "incomplete";
export type ToolKind = "read" | "edit" | "other";

/** The tool's own name without an MCP server prefix (`mcp__fs__read_file`). */
function bareName(name: string): string {
  const parts = name.split("__");
  return (parts[parts.length - 1] ?? name).trim();
}

const READ_NAMES = /^(read|read_file|readfile|view|view_file|open_file|cat)$/i;
const EDIT_NAMES = /^(edit|multiedit|write|write_file|writefile|str_replace|str_replace_editor|apply_patch|patch|notebookedit|replace)$/i;

export function toolKind(name: string): ToolKind {
  const bare = bareName(name);
  if (READ_NAMES.test(bare)) return "read";
  if (EDIT_NAMES.test(bare)) return "edit";
  return "other";
}

/**
 * What is known about the turn that owns a call that has no result yet:
 *  - `active`: the turn is still going, so the call may still finish;
 *  - `cancelled`: the turn was stopped (a stop row of that turn confirms it);
 *  - `unknown`: the turn is over, or its history is incomplete, and nothing
 *    says why the call never reported.
 */
export type ToolTurnState = "active" | "cancelled" | "unknown";

/**
 * A call with a result is `done` or `failed`. One without is `running` while
 * its own turn is, `cancelled` only when that turn was confirmed stopped, and
 * otherwise `incomplete`: a missing result does not prove a cancellation (a
 * disconnect, a failed turn or partial history leave it the same way), so it
 * is never left looking live, never called done, and never claimed cancelled.
 * A bare boolean is `active` (true) or `unknown` (false).
 */
export function toolStatus(tool: Tool, turn: ToolTurnState | boolean): ToolRowStatus {
  if (tool.ok === true) return "done";
  if (tool.ok === false) return "failed";
  const state: ToolTurnState = turn === true ? "active" : turn === false ? "unknown" : turn;
  return state === "active" ? "running" : state === "cancelled" ? "cancelled" : "incomplete";
}

/** The one field of a JSON tool input that names what the call acts on. */
const TARGET_FIELDS = ["file_path", "path", "command", "pattern", "query", "url"] as const;
function inputTarget(input: string | undefined): string {
  if (!input?.trimStart().startsWith("{")) return "";
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    for (const field of TARGET_FIELDS) {
      const value = parsed[field];
      if (typeof value === "string" && value.trim()) return value.trim().split(String.fromCharCode(10))[0]!.slice(0, 240);
    }
  } catch { /* not JSON: fall through to the first line */ }
  return "";
}

/** What the call acted on: the recorded one-line summary, else the first
 * line of the input. Empty when neither says anything beyond the name. */
export function toolTarget(tool: Tool): string {
  const summary = tool.summary?.trim();
  if (summary && summary !== tool.name) return summary;
  const fromJson = inputTarget(tool.input);
  if (fromJson) return fromJson;
  const first = tool.input?.split("\n").find((line) => line.trim())?.trim();
  return first && first !== tool.name ? first.slice(0, 240) : "";
}

/** A unified diff inside the call's own recorded text, or null. Never built
 * from anything but what the call produced. */
export function toolDiff(tool: Tool): string[] | null {
  for (const text of [tool.output, tool.input]) {
    if (!text) continue;
    const lines = text.split("\n");
    const start = lines.findIndex((line, i) => line.startsWith("@@") || (line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")));
    if (start < 0) continue;
    const diff = lines.slice(start);
    if (diff.some((line) => /^[+-][^+-]/.test(line) || /^[+-]$/.test(line))) return diff;
  }
  return null;
}

export type ToolSegment =
  | { kind: "row"; message: Message }
  | { kind: "group"; id: string; messages: Message[] };

/** Only adjacent, same-kind (Read), finished and successful calls fold. A
 * failed, cancelled or still-running call is never part of a group, and a
 * group never spans anything else, so event order is unchanged. */
export function segmentToolRun(messages: readonly Message[], turnActive: boolean): ToolSegment[] {
  const segments: ToolSegment[] = [];
  let run: Message[] = [];
  const flush = () => {
    if (run.length > 1) segments.push({ kind: "group", id: `reads:${run[0]!.id}`, messages: run });
    else for (const message of run) segments.push({ kind: "row", message });
    run = [];
  };
  for (const message of messages) {
    const tool = message.tool;
    const groupable = !!tool && toolKind(tool.name) === "read" && toolStatus(tool, turnActive) === "done";
    if (groupable) {
      run.push(message);
      continue;
    }
    flush();
    segments.push({ kind: "row", message });
  }
  flush();
  return segments;
}

/** A user row that starts a new request. One sent INTO a running turn
 * (`steered`) or folded into it by a peer (`aside`) belongs to that turn. */
function startsTurn(message: Message): boolean {
  return message.role === "user" && !message.steered && !message.aside;
}

/**
 * The turn each message belongs to, as an index (messages of no turn are not
 * listed). A turn is the provider turn that produced a message (`turnId`); a
 * request row that starts a new turn closes the previous one. Where a stored
 * message has no `turnId` (older history) it joins the stretch after the last
 * request row, and a steered or aside user row never ends that stretch. When
 * a message names the same `turnId` the stretch was already carrying, it stays
 * in it even if a request row sits between (the row was not a new turn).
 */
function turnIndexes(messages: readonly Message[]): Array<number | undefined> {
  const turns: Array<number | undefined> = [];
  let index = -1;
  let turnId: string | undefined;
  let closed = true;
  for (const message of messages) {
    if (message.role === "user") {
      if (startsTurn(message)) closed = true;
      turns.push(undefined);
      continue;
    }
    if (closed && !(message.turnId !== undefined && message.turnId === turnId)) {
      index += 1;
      turnId = undefined;
    }
    closed = false;
    if (message.turnId !== undefined) turnId = message.turnId;
    turns.push(index);
  }
  return turns;
}

/** A tool row the turn header counts: not a bot-to-bot chip, a status line or a failed turn. */
function countedTool(message: Message): boolean {
  if (message.kind !== "activity" || !message.tool || message.comm || message.threadRef || message.dataResult) return false;
  return !isStatusActivity(message) && failedTurnCause(message.tool.name) === null;
}

/** Tool messages of each turn: the id of its first tool and how many there
 * were. Counted by turn identity (see `turnIndexes`), so a steered message in
 * the middle of one turn does not make a second header. */
export function toolCountsByTurn(messages: readonly Message[]): Map<string, number> {
  const counts = new Map<string, number>();
  const turns = turnIndexes(messages);
  const firstOfTurn = new Map<number, string>();
  messages.forEach((message, i) => {
    const turn = turns[i];
    if (turn === undefined || !countedTool(message)) return;
    const first = firstOfTurn.get(turn) ?? message.id;
    firstOfTurn.set(turn, first);
    counts.set(first, (counts.get(first) ?? 0) + 1);
  });
  return counts;
}

/** Digest rows whose turn already shows its tool count in the turn header.
 * The digest would say the same thing again ("Did N tool calls"), so one
 * activity anchor stays per turn; a digest with no header above it (an older
 * conversation with no tool rows) still shows. */
export function digestsCoveredByHeader(messages: readonly Message[]): Set<string> {
  const covered = new Set<string>();
  const turns = turnIndexes(messages);
  const counted = new Set<number>();
  messages.forEach((message, i) => {
    const turn = turns[i];
    if (turn === undefined) return;
    if (message.kind === "digest") {
      if (counted.has(turn)) covered.add(message.id);
      return;
    }
    if (countedTool(message)) counted.add(turn);
  });
  return covered;
}

/**
 * What each unfinished call can be said about, by its own turn. Only the
 * newest turn can be active, and only while the chat is busy; a call is
 * confirmed `cancelled` only when a stop row of the same turn follows it;
 * anything else with no result stays `unknown`. A call that has its result is
 * not listed.
 */
export function toolTurnStates(messages: readonly Message[], busy: boolean): Map<string, ToolTurnState> {
  const states = new Map<string, ToolTurnState>();
  const turns = turnIndexes(messages);
  const newest = turns.reduce<number>((max, turn) => (turn !== undefined && turn > max ? turn : max), -1);
  const stoppedAfter = new Set<number>();
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    const turn = turns[i];
    if (turn === undefined) continue;
    if (message.tool && message.kind === "activity" && message.tool.ok === undefined) {
      states.set(message.id, busy && turn === newest ? "active" : stoppedAfter.has(turn) ? "cancelled" : "unknown");
    }
    if (isCancelledTranscriptRow(message)) stoppedAfter.add(turn);
  }
  return states;
}

/** Under this a call's time reads as noise, and a whole-second label would
 * say "0s" for it, so no duration is shown below one second. */
export const MIN_SHOWN_DURATION_MS = 1000;

/** The duration to show for a finished call, or null when it is unmeasured or
 * too short to mean anything. */
export function shownDurationMs(durationMs: number | undefined): number | null {
  return durationMs === undefined || !Number.isFinite(durationMs) || durationMs < MIN_SHOWN_DURATION_MS ? null : durationMs;
}
