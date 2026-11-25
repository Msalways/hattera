// The title of a thread a bot opens on a teammate (UX-01). Every delegated
// thread used to read "@Sender · work"; this names the thread after what was
// asked, from the first meaningful sentence of the request, so two different
// delegations from one bot are told apart in the sidebar.

export const DELEGATED_TASK_FALLBACK = "Delegated task";
/** The task summary is cut here, ellipsis included. */
export const DELEGATED_SUMMARY_MAX = 60;

/** The first sentence of `message` worth reading: markdown, list markers and
 * blank lines skipped; whitespace collapsed; cut at DELEGATED_SUMMARY_MAX.
 * Null when there is nothing but decoration. */
export function delegatedTaskSummary(message: string | null | undefined): string | null {
  if (typeof message !== "string") return null;
  for (const raw of message.split(/\r?\n/)) {
    const line = raw
      .replace(/^\s*(?:(?:[#>*\-+•]+|\d+[.)])\s*)+/, "")
      .replace(/[*_`~]+/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!/[\p{L}\p{N}]/u.test(line)) continue;
    // First sentence: up to ., ! or ? followed by a space or the end of the line.
    const sentence = (/^(.*?[.!?])(?:\s|$)/u.exec(line)?.[1] ?? line).replace(/[.!?]+$/u, "").trim();
    if (!/[\p{L}\p{N}]/u.test(sentence)) continue;
    const chars = Array.from(sentence);
    return chars.length > DELEGATED_SUMMARY_MAX ? `${chars.slice(0, DELEGATED_SUMMARY_MAX - 1).join("").trimEnd()}…` : sentence;
  }
  return null;
}

/** "@{botName} · {task summary}", or "@{botName} · Delegated task". */
export function delegatedThreadTitle(botName: string, message: string | null | undefined): string {
  return `@${botName} · ${delegatedTaskSummary(message) ?? DELEGATED_TASK_FALLBACK}`;
}
