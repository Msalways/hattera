// Inline tool rows (UX-10 S4): what one tool call reads as inside the turn.
// Pure and engine-agnostic: it reads a stored tool message and nothing else.
import type { Message } from "@/state/store";
import { isStatusActivity } from "@/lib/activity-runs";
import { failedTurnCause } from "../../shared/failed-turn";

type Tool = NonNullable<Message["tool"]>;

export type ToolRowStatus = "running" | "done" | "failed" | "cancelled";
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
 * A call is `running` only while its turn is. A call with no result whose
 * turn is over is `cancelled`: the turn ending is the confirmation that it
 * never finished, so it is never left looking live and never called done.
 */
export function toolStatus(tool: Tool, turnActive: boolean): ToolRowStatus {
  if (tool.ok === true) return "done";
  if (tool.ok === false) return "failed";
  return turnActive ? "running" : "cancelled";
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

/** Tool messages of each turn: the id of its first tool and how many there
 * were. A turn is the stretch after a user message. */
export function toolCountsByTurn(messages: readonly Message[]): Map<string, number> {
  const counts = new Map<string, number>();
  let firstId: string | null = null;
  for (const message of messages) {
    if (message.role === "user") {
      firstId = null;
      continue;
    }
    if (message.kind !== "activity" || !message.tool || message.comm || message.threadRef || message.dataResult) continue;
    if (isStatusActivity(message) || failedTurnCause(message.tool.name) !== null) continue;
    if (firstId === null) firstId = message.id;
    counts.set(firstId, (counts.get(firstId) ?? 0) + 1);
  }
  return counts;
}
