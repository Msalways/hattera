// The in-flight turn, drawn from what the engine streams: its reasoning in a
// quiet block that folds to "Thought for Ns" once the reply starts, then the
// reply itself as markdown in an assistant bubble. Display only: the stored
// message replaces it when it lands, and nothing here is persisted.
//
// Engine-agnostic. It shows reasoning text only when the engine sent some and
// never invents any; an engine without a reasoning stream just shows the reply.
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { closeOpenFence, thoughtSeconds } from "@/lib/live-turn-view";
import type { LiveTurn as LiveTurnState } from "@/lib/live-turn";
import { ChatMarkdown } from "./ChatMarkdown";

type Peers = Parameters<typeof ChatMarkdown>[0]["mentionPeers"];

/**
 * Follow a value at most once per animation frame. The first value, and a
 * return to nothing, show at once; in between only the newest value of each
 * frame is drawn, so a burst of deltas costs one render.
 */
export function useFrameValue<T>(value: T | null): T | null {
  const [shown, setShown] = useState<T | null>(value);
  const latest = useRef(value);
  latest.current = value;
  const frame = useRef<number | null>(null);
  useEffect(() => {
    if (value === null) {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      setShown(null);
      return;
    }
    if (shown === null) {
      setShown(value);
      return;
    }
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      setShown(latest.current);
    });
    // `shown` is read for the first-value case only; a new frame is driven by `value`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
  }, []);
  return value === null ? null : shown ?? value;
}

function ThoughtBlock({ text, streaming, seconds }: { text: string; streaming: boolean; seconds: number | null }) {
  // Open while the thinking streams and folded once the reply starts. A
  // person's own toggle wins from then on for this turn.
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? streaming;
  const label = streaming ? t("chat.live.thinking") : t("chat.live.thoughtFor", { seconds: seconds ?? 1 });
  const bodyRef = useRef<HTMLParagraphElement>(null);
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
        aria-controls="live-thought-body"
        onClick={() => setManual(!open)}
        className="flex items-center gap-1 rounded-md py-0.5 pe-1 text-ink-tertiary hover:text-ink-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <ChevronRight size={13} aria-hidden="true" className={cn("shrink-0 motion-safe:transition-transform", open && "rotate-90")} />
        <span>{label}</span>
      </button>
      <p
        id="live-thought-body"
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

export const LiveTurn = memo(function LiveTurn({
  live,
  botName,
  mentionPeers,
  onGrow,
}: {
  /** What `visibleLiveTurn` returned for this thread, or null. */
  live: LiveTurnState | null;
  botName: string;
  mentionPeers?: Peers;
  /** Called after each drawn update, so the caller can keep following the end. */
  onGrow?: () => void;
}) {
  const shown = useFrameValue(live);
  const reasoning = shown?.reasoning ?? "";
  const reply = shown?.reply ?? "";
  const turnId = shown?.turnId;

  // Real timing: the client clock from the first reasoning text it saw to the
  // first reply text. Nothing is estimated.
  // (a mutable holder in state, not a ref: it must not be position-bound)
  const [clock] = useState<{ turnId: string | undefined; start: number | null; end: number | null }>(() => ({ turnId, start: null, end: null }));
  if (clock.turnId !== turnId) Object.assign(clock, { turnId, start: null, end: null });
  if (reasoning && clock.start === null) clock.start = Date.now();
  if (reply && clock.start !== null && clock.end === null) clock.end = Date.now();
  const replying = reply !== "";
  const seconds = clock.start !== null && clock.end !== null ? thoughtSeconds(clock.start, clock.end) : null;

  // Announce twice per turn, never per token: when thinking begins and when
  // the thought folds because the reply has started.
  const [said, setSaid] = useState({ text: "", count: 0 });
  const [announced] = useState<{ turnId: string | undefined; start: boolean; done: boolean }>(() => ({ turnId, start: false, done: false }));
  if (announced.turnId !== turnId) Object.assign(announced, { turnId, start: false, done: false });
  const hasReasoning = reasoning !== "";
  useEffect(() => {
    const memory = announced;
    if (hasReasoning && !memory.start) {
      memory.start = true;
      setSaid((previous) => ({ text: t("chat.live.startAnnounce", { name: botName }), count: previous.count + 1 }));
    } else if (hasReasoning && replying && !memory.done) {
      memory.done = true;
      setSaid((previous) => ({ text: t("chat.live.doneAnnounce", { name: botName }), count: previous.count + 1 }));
    }
  }, [hasReasoning, replying, botName, turnId, announced]);

  // after each drawn update, let the caller keep the end in view
  const grow = useRef(onGrow);
  grow.current = onGrow;
  useLayoutEffect(() => {
    if (reasoning || reply) grow.current?.();
  }, [reasoning, reply]);

  const status = (
    <p role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="live-turn-announcer">
      {said.text && <span key={said.count}>{said.text}</span>}
    </p>
  );
  if (!shown) return status;
  return (
    <div data-live-turn className="flex flex-col items-start gap-2">
      {shown.joinedMidStream && (
        <p data-live-joined className="text-[12px] text-ink-tertiary">{t("chat.live.joined")}</p>
      )}
      {hasReasoning && <ThoughtBlock key={turnId ?? "turn"} text={reasoning} streaming={!replying} seconds={seconds} />}
      {replying && (
        <div
          data-chat-bubble
          data-live-reply
          aria-label={t("chat.live.reply")}
          // aria-live stays off: the bubble is rewritten many times a second
          aria-live="off"
          className="w-fit max-w-[min(42rem,78%)] rounded-2xl bg-card px-4 py-2.5 text-[15px] leading-relaxed text-ink"
        >
          <ChatMarkdown text={closeOpenFence(reply)} mentionPeers={mentionPeers} />
        </div>
      )}
      {status}
    </div>
  );
});

/** A callback that scrolls to the end only while the reader is already there. */
export function useGrowToEnd(following: boolean, scrollRef: { current: HTMLElement | null }) {
  const followingRef = useRef(following);
  followingRef.current = following;
  return useCallback(() => {
    const el = scrollRef.current;
    if (el && followingRef.current) el.scrollTo({ top: el.scrollHeight });
  }, [scrollRef]);
}
