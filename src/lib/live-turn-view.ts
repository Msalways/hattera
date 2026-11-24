/** Display helpers for the live turn: pure, engine-agnostic. */

/**
 * Close a code fence the stream has opened but not yet finished, so a half
 * received block renders as a complete block instead of swallowing the rest
 * of the layout. Follows CommonMark: a fence opens with 3+ backticks or
 * tildes at the start of a line (up to 3 spaces of indent) and closes with the
 * same character, at least as long, and nothing else on the line.
 */
export function closeOpenFence(text: string): string {
  let open: { char: string; length: number } | null = null;
  for (const line of text.split("\n")) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    const run = match[1]!;
    if (!open) {
      // a backtick fence cannot have a backtick in its info string
      if (run[0] === "`" && match[2]!.includes("`")) continue;
      open = { char: run[0]!, length: run.length };
    } else if (run[0] === open.char && run.length >= open.length && match[2]!.trim() === "") {
      open = null;
    }
  }
  if (!open) return text;
  return `${text}${text.endsWith("\n") ? "" : "\n"}${open.char.repeat(open.length)}`;
}

/** Whole seconds a block of thinking took, never below 1. */
export function thoughtSeconds(startMs: number, endMs: number): number {
  return Math.max(1, Math.round((endMs - startMs) / 1000));
}
