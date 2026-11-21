// A thought: the engine's reasoning text in a quiet, reopenable block. Open
// while it streams, "Thought for Ns" once thinking ends. It is drawn in the
// stream where the thinking happened (see ThoughtSlot), not at the bottom.
import { useLayoutEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";
import { visibleLiveTurn } from "@/lib/live-turn";
import { useFrameValue } from "./LiveTurn";

export function ThoughtBlock({ id, text, streaming, seconds }: { id: string; text: string; streaming: boolean; seconds: number | null }) {
  // Open while the thinking streams and folded once it ends. A person's own
  // toggle wins from then on for this block.
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? streaming;
  const label = streaming
    ? t("chat.live.thinking")
    : seconds === null ? t("chat.live.thought") : t("chat.live.thoughtFor", { seconds });
  const bodyRef = useRef<HTMLParagraphElement>(null);
  const bodyId = `thought-${id}`;
  useLayoutEffect(() => {
    // keep the newest line of a long thought in view inside its own box
    const body = bodyRef.current;
    if (body && streaming && open) body.scrollTop = body.scrollHeight;
  }, [text, streaming, open]);
  return (
    <div data-live-thought data-state={streaming ? "streaming" : "done"} className="min-w-0 max-w-[min(42rem,78%)] text-[13px] text-ink-tertiary">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setManual(!open)}
        className="flex min-h-11 items-center gap-1 rounded-md py-0.5 pe-1 text-ink-tertiary hover:text-ink-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <ChevronRight size={13} aria-hidden="true" className={cn("shrink-0 motion-safe:transition-transform", open && "rotate-90")} />
        <span>{label}</span>
      </button>
      <p
        id={bodyId}
        ref={bodyRef}
        hidden={!open}
        // the text is not a live region: per-token announcements are noise
        aria-live="off"
        className="mt-1 max-h-40 overflow-y-auto border-s border-hairline/40 ps-3 leading-relaxed whitespace-pre-wrap break-words"
      >
        {text}
      </p>
    </div>
  );
}

/** The thoughts that belong right after one stored message: this thread's
 * finished ones, then the one still streaming. `afterId` null is the end of the
 * transcript, for a thought whose anchor message is not in the list. */
export function ThoughtSlot({ threadId, afterId, resolveAnchor }: { threadId: string | undefined; afterId: string | null; resolveAnchor: (anchorId: string | undefined, startedAt: number | undefined) => string | null }) {
  const { state } = useStore();
  const key = threadId ?? "";
  const liveNow = visibleLiveTurn(state.liveTurns[key]);
  const framed = useFrameValue(liveNow?.reasoning ? liveNow : null);
  // the throttled copy can trail by a frame, and across a switch of thread it
  // would be another thread's turn: it only stands in for its own turn
  const live = liveNow?.reasoning ? (framed && framed.turnId === liveNow.turnId ? framed : liveNow) : null;
  const here = (anchor: string | undefined, startedAt: number | undefined) => resolveAnchor(anchor, startedAt) === afterId;
  const done = (state.thoughts[key] ?? []).filter((thought) => here(thought.anchorId, thought.startedAt));
  const streaming = live && here(live.anchorId, live.thoughtStartedAt) ? live : null;
  if (!done.length && !streaming) return null;
  return (
    <>
      {done.map((thought, index) => (
        <div key={`${thought.turnId ?? "turn"}:${index}`} className="flex justify-start">
          <ThoughtBlock id={`${afterId}-${thought.turnId ?? index}`} text={thought.text} streaming={false} seconds={thought.seconds} />
        </div>
      ))}
      {streaming && (
        <div className="flex justify-start" data-live-thought-slot>
          <ThoughtBlock key={streaming.turnId ?? "turn"} id={`live-${streaming.turnId ?? "turn"}`} text={streaming.reasoning} streaming={streaming.thoughtEndedAt === undefined && streaming.reply === ""} seconds={thoughtSecondsOf(streaming)} />
        </div>
      )}
    </>
  );
}

function thoughtSecondsOf(live: { thoughtStartedAt: number | undefined; thoughtEndedAt: number | undefined }): number | null {
  if (live.thoughtStartedAt === undefined || live.thoughtEndedAt === undefined) return null;
  return Math.max(1, Math.round((live.thoughtEndedAt - live.thoughtStartedAt) / 1000));
}
