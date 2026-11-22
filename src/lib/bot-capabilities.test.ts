import { describe, expect, it } from "vitest";
import { browserStatus, type BotCapabilities, type BrowserReason } from "./bot-capabilities";

const caps = (availableReason: BrowserReason, mounts = false): BotCapabilities => ({
  browser: {
    mounts, reason: availableReason === "ready" && !mounts ? "destination-off" : availableReason,
    available: availableReason === "ready", availableReason, message: availableReason,
    switches: { workspaceOn: true, botOn: true, engineSupports: true, engineInstalled: true },
  },
  thisPc: { control: { ready: false }, shell: { available: false } },
});

describe("browserStatus", () => {
  it("is unknown until the server answers, with a next step", () => {
    const s = browserStatus(null, false);
    expect(s.state).toBe("unknown");
    expect(s.nextKey).toBeTruthy();
  });
  it("says not installed (never off) and names the way forward", () => {
    const install = browserStatus(caps("not-installed"), true);
    expect(install).toMatchObject({ state: "needs-action", reason: "not-installed", titleKey: "capability.browser.notInstalled.title", nextKey: "capability.browser.notInstalled.nextInstall" });
    expect(browserStatus(caps("not-installed"), false).nextKey).toBe("capability.browser.notInstalled.nextCli");
  });
  it("keeps configured, available and needs-action distinct", () => {
    expect(browserStatus(caps("ready", true), false)).toMatchObject({ state: "available", nextKey: null });
    expect(browserStatus(caps("ready", false), false).state).toBe("configured");
    for (const reason of ["workspace-off", "bot-off", "engine-unsupported"] as const) {
      const s = browserStatus(caps(reason), false);
      expect(s.state).toBe("needs-action");
      expect(s.nextKey).toBeTruthy();
    }
  });
});
