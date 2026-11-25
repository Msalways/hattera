import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// A-11: the Remote access switch. Checked means paired devices may connect.
const f = vi.hoisted(() => ({ state: null as object | null }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: {} } }) }));
vi.mock("./PhoneSetupFlow", () => ({
  companionBridge: () => ({}),
  usePhoneSetupController: () => ({ state: f.state, busy: false, accountBusy: false, account: null, accountError: null, error: null, localFallback: false, tailscaleFallback: false, tailscaleAvailable: false, hostedReady: false }),
  PhoneSetupFlowView: () => null,
  companionAccountActionError: () => null,
  loadCompanionBridgeState: () => null,
  shouldHydrateCompanionEmail: () => false,
}));
import { CompanionSection } from "./CompanionSection";

const toggle = (enabled: boolean) => {
  f.state = { enabled, devices: [], port: 8810 };
  const markup = renderToStaticMarkup(createElement(() => CompanionSection({})));
  return { markup, button: markup.match(/<button[^>]*aria-label="Remote access"[^>]*>/)?.[0] };
};

describe("Remote access switch", () => {
  it.each([[true, "true"], [false, "false"]])("exposes role=switch with aria-checked=%s matching enabled", (enabled, checked) => {
    const { button } = toggle(enabled);
    expect(button).toBeDefined();
    expect(button).toContain('role="switch"');
    expect(button).toContain(`aria-checked="${checked}"`);
  });

  it("explains both states in one sentence beside the switch", () => {
    expect(toggle(true).markup).toContain("Allow paired devices to connect to this computer. When off, remote-device connections are disabled.");
  });
});
