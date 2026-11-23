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
// A refresh is tracked per conversation: while one is in flight the hook
// answers null ("checking"), never the previous value, and each request has a
// generation so a late reply from an older request cannot overwrite a newer one.
const cache = new Map<string, BotCapabilities>();
const pending = new Set<string>();
const generation = new Map<string, number>();
const listeners = new Set<() => void>();
const keyOf = (botId: string, threadId: string | undefined) => `${botId}:${threadId ?? ""}`;
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const notify = () => { for (const listener of listeners) listener(); };
const looksValid = (value: unknown): value is BotCapabilities => {
  const v = value as Partial<BotCapabilities> | null;
  return Boolean(v && typeof v === "object" && v.browser && typeof v.browser.available === "boolean" && v.thisPc?.shell && v.thisPc?.control);
};

export function seedBotCapabilities(botId: string, threadId: string | undefined, value: BotCapabilities | null): void {
  const key = keyOf(botId, threadId);
  if (value) cache.set(key, value); else cache.delete(key);
  // A seeded answer is the latest word: any request still in flight is stale.
  generation.set(key, (generation.get(key) ?? 0) + 1);
  pending.delete(key);
  notify();
}

/** The answer for one bot and conversation; fetched again whenever
 * `refreshKey` changes (a switch, the engine or the place changed). null until
 * it arrives, while a refresh is in flight, after a failed refresh, or when the
 * server predates the route. */
export function useBotCapabilities(botId: string | undefined, threadId: string | undefined, refreshKey: string): BotCapabilities | null {
  const key = botId ? keyOf(botId, threadId) : "";
  const read = () => (pending.has(key) ? null : cache.get(key) ?? null);
  const value = useSyncExternalStore(subscribe, read, read);
  useEffect(() => {
    if (!botId) return;
    const mine = (generation.get(key) ?? 0) + 1;
    generation.set(key, mine);
    pending.add(key);
    notify();
    const suffix = threadId ? `?threadId=${encodeURIComponent(threadId)}` : "";
    const settle = (next: BotCapabilities | null) => {
      if (generation.get(key) !== mine) return; // a newer request or seed owns the answer
      pending.delete(key);
      if (next) cache.set(key, next); else cache.delete(key); // a failed refresh must not leave the old answer standing
      notify();
    };
    void api<unknown>(`/api/bots/${botId}/capabilities${suffix}`)
      .then((next) => settle(looksValid(next) ? next : null))
      .catch(() => settle(null));
  }, [botId, threadId, refreshKey, key]);
  return value;
}

/** Is the browser engine installed here, from the server's answer: true or
 * false once it arrived, null while it is still being asked ("checking", not
 * a guess from config). */
export function browserEngineInstalled(caps: BotCapabilities | null): boolean | null {
  return caps ? caps.browser.switches.engineInstalled : null;
}

/** The browser facts every place view takes, from the one answer. While the
 * answer is still being asked (null) the browser is "checking", not off: every
 * surface that builds a place view spreads this, so none of them can read a
 * missing answer as "off". */
export function browserFacts(caps: BotCapabilities | null): { browserOn: boolean; browserMissing: boolean; browserChecking: boolean } {
  return {
    browserOn: caps?.browser.available === true,
    browserMissing: caps?.browser.availableReason === "not-installed",
    browserChecking: caps === null,
  };
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
