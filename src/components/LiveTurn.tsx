// The in-flight reply, drawn from what the engine streams, as markdown in an
// assistant bubble. Its reasoning is not drawn here: a thought sits in the
// stream where the thinking happened (ThoughtBlock). Display only: the stored
// message replaces it when it lands, and nothing here is persisted.
//
// Engine-agnostic. It shows reasoning text only when the engine sent some and
// never invents any; an engine without a reasoning stream just shows the reply.
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import { closeOpenFence } from "@/lib/live-turn-view";
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

  // Announce twice per turn, never per token: when thinking begins and when
  // the thought folds because the reply has started.
  const [said, setSaid] = useState({ text: "", count: 0 });
  const [announced] = useState<{ turnId: string | undefined; start: boolean; done: boolean }>(() => ({ turnId, start: false, done: false }));
  if (announced.turnId !== turnId) Object.assign(announced, { turnId, start: false, done: false });
  const replying = reply !== "";
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
