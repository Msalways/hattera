// The server's answer to "what does this bot's turn really get": the built-in
// browser and This PC. The Computer panel, the place chip and the Access line
// read this; they do not work it out again from config flags (the old copies
// disagreed with the mount and with each other). Mirrors server/runtime.ts
// botCapabilities, which reads server/turn-capabilities.ts.
import { useEffect, useSyncExternalStore } from "react";
import { api } from "@/state/store";

export type BrowserReason =
  | "ready" | "workspace-off" | "bot-off" | "engine-unsupported" | "not-installed" | "destination-off" | "computer-chosen";

export interface BotCapabilities {
  browser: {
    /** Browser tools are mounted on this conversation's next turn. */
    mounts: boolean;
    reason: BrowserReason;
    /** Every switch is on and the engine is installed: the bot can have it. */
    available: boolean;
    /** Why not available (or "ready"), ignoring where the bot works. */
    availableReason: BrowserReason;
    message: string;
  };
  thisPc: {
    /** Computer control (desktop bridge) is set up for this bot. */
    control: { ready: boolean };
    /** The bot's engine can run commands on this PC. */
    shell: { available: boolean };
  };
}

// One small cache shared by the Computer panel and the place chip, so both
// show the same answer for the same conversation. Tests seed it directly.
const cache = new Map<string, BotCapabilities>();
const listeners = new Set<() => void>();
const keyOf = (botId: string, threadId: string | undefined) => `${botId}:${threadId ?? ""}`;
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const looksValid = (value: unknown): value is BotCapabilities => {
  const v = value as Partial<BotCapabilities> | null;
  return Boolean(v && typeof v === "object" && v.browser && typeof v.browser.available === "boolean" && v.thisPc?.shell && v.thisPc?.control);
};

export function seedBotCapabilities(botId: string, threadId: string | undefined, value: BotCapabilities | null): void {
  if (value) cache.set(keyOf(botId, threadId), value); else cache.delete(keyOf(botId, threadId));
  for (const listener of listeners) listener();
}

/** The answer for one bot and conversation; fetched again whenever
 * `refreshKey` changes (a switch, the engine or the place changed). null until
 * it arrives or when the server predates the route. */
export function useBotCapabilities(botId: string | undefined, threadId: string | undefined, refreshKey: string): BotCapabilities | null {
  const key = botId ? keyOf(botId, threadId) : "";
  const value = useSyncExternalStore(subscribe, () => cache.get(key) ?? null, () => cache.get(key) ?? null);
  useEffect(() => {
    if (!botId) return;
    let active = true;
    const suffix = threadId ? `?threadId=${encodeURIComponent(threadId)}` : "";
    void api<unknown>(`/api/bots/${botId}/capabilities${suffix}`)
      .then((next) => { if (active && looksValid(next)) seedBotCapabilities(botId, threadId, next); })
      .catch(() => {});
    return () => { active = false; };
  }, [botId, threadId, refreshKey]);
  return value;
}
