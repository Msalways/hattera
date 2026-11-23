// What a turn really gets. The rule for "does this bot have the built-in
// browser" used to be written out five times in runtime.ts (the dispatch
// mount, a room turn's mount, select_computer's readiness, the prompt preview
// and the surface plan), and the copies disagreed: readiness ignored whether
// Auto had already reached a computer and whether the engine was installed, so
// teammates were told "browser ready" and were given no browser tools. This is
// the one rule. The mount, readiness, room turns, the prompt preview and the
// Computer panel's answer all read it.
import type { Surface, SurfacePlan } from "./surface.ts";

/** Why the built-in browser is or is not mounted. */
export type BrowserReason =
  | "ready"
  | "workspace-off"      // Settings → Computers → Built-in browser is off
  | "bot-off"            // this bot's own switch is off
  | "engine-unsupported" // the bot's model cannot use MCP browser tools
  | "not-installed"      // the agent-browser engine is not installed here
  | "destination-off"    // Works on is Off
  | "computer-chosen";   // Auto reached a computer; web work happens there

export interface BrowserSwitches {
  /** builtInBrowserEnabled(cfg) */
  workspaceOn: boolean;
  /** bot.browser !== false */
  botOn: boolean;
  /** the engine's browserMcp capability */
  engineSupports: boolean;
  /** the agent-browser engine is installed and ready on this server */
  engineInstalled: boolean;
}

export interface BrowserCapability {
  /** Browser tools will be mounted this turn. */
  mounts: boolean;
  reason: BrowserReason;
}

/** The switches alone: could this bot be given the browser at all. Auto's
 * "a computer was reached" and Off are the plan's business, below. */
export function browserSwitchReason(s: BrowserSwitches): BrowserReason {
  if (!s.workspaceOn) return "workspace-off";
  if (!s.botOn) return "bot-off";
  if (!s.engineSupports) return "engine-unsupported";
  if (!s.engineInstalled) return "not-installed";
  return "ready";
}

/** A previewed place counts as "a computer was reached" only when it is one;
 * the browser and Off are not. Readiness reads this from the same preview the
 * Computer panel shows, the mount from the computer the dispatch reached. */
export function reachedComputer(place: Surface | "off" | null | undefined): Surface | null {
  return place === undefined || place === null || place === "off" || place === "browser" ? null : place;
}

/** The one decision. `plan` is the turn's resolved surface plan;
 * `mountedComputer` is the computer an Auto turn actually reached, if any. */
export function browserCapability(s: BrowserSwitches, plan: Pick<SurfacePlan, "computer" | "browser">, mountedComputer?: Surface | null): BrowserCapability {
  const reason = browserSwitchReason(s);
  if (reason !== "ready") return { mounts: false, reason };
  if (plan.computer === "off" && !plan.browser) return { mounts: false, reason: "destination-off" };
  // One place per turn: on Auto a reached computer carries the web work.
  if (plan.computer === undefined && mountedComputer) return { mounts: false, reason: "computer-chosen" };
  if (!plan.browser) return { mounts: false, reason: "destination-off" };
  return { mounts: true, reason: "ready" };
}

/** Plain words for a reason, for a tool reason or a panel. */
export function browserReasonText(reason: BrowserReason, botName?: string): string {
  const who = botName ?? "this bot";
  switch (reason) {
    case "ready": return "The built-in browser is ready.";
    case "workspace-off": return "The built-in browser is switched off for the workspace (Settings → Computers).";
    case "bot-off": return `The built-in browser is switched off for ${who}.`;
    case "engine-unsupported": return `${who}'s model cannot use the built-in browser. Choose a model that can.`;
    case "not-installed": return "The browser engine is not installed on this server yet.";
    case "destination-off": return `${who} works on Off, so no browser is mounted.`;
    case "computer-chosen": return "Another computer was reached on Auto, so web work happens in that computer's own browser.";
  }
}
