import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ report: null as unknown }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => [initial === null ? fixture.report : initial === true ? false : typeof initial === "function" ? (initial as () => unknown)() : initial, () => {}],
}));
vi.mock("@/state/store", () => ({ api: vi.fn() }));
import { PlanUsage } from "./PlanUsage";

describe("Plan usage presentation", () => {
  it("shows provider-declared availability and wallet currency without a fabricated meter", () => {
    fixture.report = { providers: [{ id: "wallet", name: "Provider", ok: true, reporting: { status: "current", source: "Account API", metrics: [
      { id: "unlimited", label: "Weekly", availability: "unlimited", unit: "units", used: null, remaining: null, limit: null, resetsAt: null },
      { id: "excluded", label: "Video", availability: "not-in-plan", unit: "units", used: null, remaining: null, limit: null, resetsAt: null },
      { id: "wallet", label: "Wallet", unit: "currency", currency: "CNY", remaining: 5, used: null, limit: null, resetsAt: null },
    ] } }] };
    const html = renderToStaticMarkup(createElement(PlanUsage));
    expect(html).toContain("Unlimited (provider reported)");
    expect(html).toContain("Not included in this plan");
    expect(html).not.toContain('role="meter"');
    expect(html).toMatch(/CN|CNY|¥/);
    expect(html).not.toContain("$5");
  });
  it("shows arbitrary reporting metrics and stale data without inventing missing allowances", () => {
    fixture.report = { providers: [{ id: "all", name: "Configured account", ok: true, reporting: {
      status: "stale", source: "Native account protocol", collectedAt: "2026-10-02T09:00:00Z", message: "Connection offline", dashboardUrl: "https://example.com/usage",
      metrics: [{ id: "model:8h", label: "8-hour", scope: "Model A", unit: "percent", used: 25, remaining: 75, limit: 100, windowSeconds: 28800, resetsAt: null },
        { id: "unknown", label: "Monthly", scope: null, unit: "tokens", used: null, remaining: null, limit: null, windowSeconds: null, resetsAt: null }],
    } }] };
    const html = renderToStaticMarkup(createElement(PlanUsage));
    expect(html).toContain("75% remaining");
    expect(html).toContain("8-hour");
    expect(html).toContain("last known snapshot");
    expect(html).toContain("Not reported");
    expect(html).not.toContain("5-hour");
    expect(html).not.toContain("0 tokens");
  });
  it("distinguishes remaining account allowance, per-model usage, and unavailable windows", () => {
    fixture.report = {
      fetchedAt: "2026-10-02T09:00:00Z",
      providers: [{
        id: "fixture", name: "Fixture provider", driver: "claude", plan: "Pro", ok: true, error: null,
        fiveHour: { available: true, remainingPercent: 68, usedPercent: 32, resetsAt: null },
        weekly: { available: false, remainingPercent: null, usedPercent: null, resetsAt: null }, extra: [],
        models: [{ name: "Sonnet", windows: [{ label: "Weekly", remainingPercent: 30, usedPercent: 70, resetsAt: null }] }],
      }],
    };
    const html = renderToStaticMarkup(createElement(PlanUsage));
    expect(html).toContain("68% left");
    expect(html).toContain("70% used");
    expect(html).toContain("Not reported by this plan");
    expect(html).not.toContain("100% left");
    expect(html).toContain('aria-valuenow="32"');
    expect(html).toContain('aria-valuenow="70"');
  });

  it("shows an account error without inventing zero usage", () => {
    fixture.report = { providers: [{ id: "fixture", name: "Fixture provider", ok: false, error: "Sign in to this account." }] };
    const html = renderToStaticMarkup(createElement(PlanUsage));
    expect(html).toContain("Sign in to this account.");
    expect(html).not.toContain('role="meter"');
    expect(html).not.toContain("100% left");
  });
});
