import { describe, expect, it, vi } from "vitest";
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

// A refresh of a populated cache: the hook is exercised with React mocked out,
// the way the surfaces use it (effects run after render).
describe("useBotCapabilities refresh", () => {
  type Deferred = { resolve: (v: unknown) => void; reject: (e: unknown) => void };
  const setup = async () => {
    vi.resetModules();
    const effects: Array<() => void> = [];
    const calls: Deferred[] = [];
    vi.doMock("react", () => ({ useEffect: (fn: () => void) => { effects.push(fn); }, useSyncExternalStore: (_s: unknown, get: () => unknown) => get() }));
    vi.doMock("@/state/store", () => ({ api: () => new Promise((resolve, reject) => { calls.push({ resolve, reject }); }) }));
    const mod = await import("./bot-capabilities");
    const render = (key: string) => { const v = mod.useBotCapabilities("b", "t", key); effects.splice(0).forEach((fn) => fn()); return v; };
    const peek = () => mod.useBotCapabilities("b", "t", "x");
    return { mod, render, peek, calls };
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("answers null while refreshing a populated cache, then the new answer", async () => {
    const { mod, render, peek, calls } = await setup();
    mod.seedBotCapabilities("b", "t", caps("ready", true));
    render("k2");
    expect(peek()).toBeNull();
    expect(mod.browserFacts(peek()).browserChecking).toBe(true);
    calls[0].resolve(caps("bot-off"));
    await flush();
    expect(peek()?.browser.availableReason).toBe("bot-off");
  });
  it("does not keep the old answer after a failed refresh", async () => {
    const { mod, render, peek, calls } = await setup();
    mod.seedBotCapabilities("b", "t", caps("ready", true));
    render("k2");
    calls[0].reject(new Error("down"));
    await flush();
    expect(peek()).toBeNull();
  });
  it("ignores a late reply from an older request", async () => {
    const { mod, render, peek, calls } = await setup();
    mod.seedBotCapabilities("b", "t", caps("ready", true));
    render("k2");
    render("k3");
    calls[1].resolve(caps("workspace-off"));
    await flush();
    calls[0].resolve(caps("bot-off"));
    await flush();
    expect(peek()?.browser.availableReason).toBe("workspace-off");
  });
});
