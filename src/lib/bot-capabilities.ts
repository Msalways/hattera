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
    /** Each switch alone (the reason names only the first one that is off). */
    switches: { workspaceOn: boolean; botOn: boolean; engineSupports: boolean; engineInstalled: boolean };
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

/** Is the browser engine installed here, from the server's answer: true or
 * false once it arrived, null while it is still being asked ("checking", not
 * a guess from config). */
export function browserEngineInstalled(caps: BotCapabilities | null): boolean | null {
  return caps ? caps.browser.switches.engineInstalled : null;
}

/** The Designer's four states for a capability: it is on and usable now
 * ("available"), set up but not where this conversation works ("configured"),
 * blocked on something the person can do ("needs-action"), or not answered yet
 * ("unknown"). Each carries its reason and a next step as locale keys; the
 * words come from the server's reason, never from config flags. */
export type CapabilityState = "available" | "configured" | "needs-action" | "unknown";
export interface BrowserStatus {
  state: CapabilityState;
  reason: BrowserReason | "unknown";
  /** Locale keys (en.json "capability.browser.*"). */
  titleKey: string;
  reasonKey: string;
  /** null when nothing is left to do. */
  nextKey: string | null;
}

/** `canInstall`: this server can install the browser engine from the app. */
export function browserStatus(caps: BotCapabilities | null, canInstall: boolean): BrowserStatus {
  if (!caps) return { state: "unknown", reason: "unknown", titleKey: "capability.browser.unknown.title", reasonKey: "capability.browser.unknown.reason", nextKey: "capability.browser.unknown.next" };
  const reason = caps.browser.availableReason;
  const key = (name: string) => `capability.browser.${name}`;
  switch (reason) {
    case "ready":
      return caps.browser.mounts
        ? { state: "available", reason, titleKey: key("ready.title"), reasonKey: key("ready.reason"), nextKey: null }
        : { state: "configured", reason: caps.browser.reason, titleKey: key("configured.title"), reasonKey: key("configured.reason"), nextKey: key("configured.next") };
    case "not-installed":
      return { state: "needs-action", reason, titleKey: key("notInstalled.title"), reasonKey: key("notInstalled.reason"), nextKey: canInstall ? key("notInstalled.nextInstall") : key("notInstalled.nextCli") };
    case "workspace-off":
      return { state: "needs-action", reason, titleKey: key("workspaceOff.title"), reasonKey: key("workspaceOff.reason"), nextKey: key("workspaceOff.next") };
    case "bot-off":
      return { state: "needs-action", reason, titleKey: key("botOff.title"), reasonKey: key("botOff.reason"), nextKey: key("botOff.next") };
    case "engine-unsupported":
      return { state: "needs-action", reason, titleKey: key("engineUnsupported.title"), reasonKey: key("engineUnsupported.reason"), nextKey: key("engineUnsupported.next") };
    default:
      return { state: "needs-action", reason, titleKey: key("workspaceOff.title"), reasonKey: key("workspaceOff.reason"), nextKey: key("workspaceOff.next") };
  }
}
