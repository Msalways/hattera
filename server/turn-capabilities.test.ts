import { describe, expect, it } from "vitest";
import { resolveSurface } from "./surface.ts";
import { browserCapability, browserReasonText, browserSwitchReason, type BrowserSwitches } from "./turn-capabilities.ts";

const ready: BrowserSwitches = { workspaceOn: true, botOn: true, engineSupports: true, engineInstalled: true };
const autoPlan = (browserOn: boolean) => resolveSurface({ browserOn });

describe("browserCapability: one rule for the mount, readiness, room turns and the panel", () => {
  it("mounts on Auto when nothing else was reached", () => {
    expect(browserCapability(ready, autoPlan(true))).toEqual({ mounts: true, reason: "ready" });
  });

  it("does not mount on Auto when a computer was reached, and readiness says the same", () => {
    expect(browserCapability(ready, autoPlan(true), "cloud")).toEqual({ mounts: false, reason: "computer-chosen" });
    // select_computer asks about the browser destination: that is a pin, so it mounts
    expect(browserCapability(ready, resolveSurface({ destination: "browser", browserOn: true }))).toEqual({ mounts: true, reason: "ready" });
  });

  it.each([
    ["workspace off", { ...ready, workspaceOn: false }, "workspace-off"],
    ["bot off", { ...ready, botOn: false }, "bot-off"],
    ["engine unsupported", { ...ready, engineSupports: false }, "engine-unsupported"],
    ["engine not installed (integration fails)", { ...ready, engineInstalled: false }, "not-installed"],
  ] as const)("%s: never mounts, for any destination", (_name, switches, reason) => {
    for (const plan of [autoPlan(false), resolveSurface({ destination: "browser", browserOn: false }), autoPlan(true)]) {
      expect(browserCapability(switches, plan)).toEqual({ mounts: false, reason });
    }
    expect(browserSwitchReason(switches)).toBe(reason);
  });

  it("Works on Off mounts nothing", () => {
    expect(browserCapability(ready, resolveSurface({ destination: "off", browserOn: true }))).toEqual({ mounts: false, reason: "destination-off" });
  });

  it("every reason has words", () => {
    for (const reason of ["ready", "workspace-off", "bot-off", "engine-unsupported", "not-installed", "destination-off", "computer-chosen"] as const) {
      expect(browserReasonText(reason, "Sunny").length).toBeGreaterThan(10);
    }
  });
});
