// What happened when a person changed a thread's approval level under a
// running turn, kept per thread so the composer can say it in words: what was
// asked for, what the running step uses now, and when the change lands.
//
// It is the server's answer (PATCH .../tasks/:id -> levelChange), never a
// guess: "now" means the engine confirmed it, "next-turn" means the level is
// saved and the running step carries on at the old one.
import { useSyncExternalStore } from "react";

import type { ApprovalMode } from "../../shared/approval-mode";

export interface LevelChangeNotice {
  status: "saving" | "done" | "failed";
  requested: ApprovalMode;
  /** the level the running step uses (the old one until the engine takes the new) */
  effective?: ApprovalMode;
  appliesAt?: "now" | "next-turn" | "idle";
  /** waiting approvals the new level answered */
  resolved?: number;
  error?: string;
  at: number;
}

/** The server's answer to a level change. */
export interface LevelChangeResult {
  requested: ApprovalMode;
  effective: ApprovalMode;
  appliesAt: "now" | "next-turn" | "idle";
  resolved: number;
}

const notices = new Map<string, LevelChangeNotice>();
const listeners = new Set<() => void>();
let version = 0;
const emit = () => {
  version += 1;
  for (const listener of Array.from(listeners)) listener();
};

export function setLevelChangeNotice(threadId: string, notice: LevelChangeNotice): void {
  notices.set(threadId, notice);
  emit();
}

export function clearLevelChangeNotice(threadId: string): void {
  if (notices.delete(threadId)) emit();
}

export function levelChangeNotice(threadId: string): LevelChangeNotice | undefined {
  return notices.get(threadId);
}

/** The notice for one thread, re-rendering when it changes. */
export function useLevelChangeNotice(threadId: string | undefined): LevelChangeNotice | undefined {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
    () => version,
  );
  return threadId ? notices.get(threadId) : undefined;
}

/** A notice that is only about the running step goes away on its own once
 * the turn it was about is over: the next turn simply runs at the new level. */
export function levelChangeStale(notice: LevelChangeNotice | undefined, busy: boolean): boolean {
  return !notice || (!busy && notice.status === "done" && notice.appliesAt !== "idle");
}
