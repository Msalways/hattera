// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, BotEditorStore, type useStore } from "@/state/store";
import { chatgptPlanLink, codexDeviceLink, deviceFlowUnavailable, DeviceSignIn, DeviceSignInProgress, deviceSignInProvider, type DeviceSignInStatus } from "./DeviceSignIn";

afterEach(() => vi.unstubAllGlobals());

const waiting: DeviceSignInStatus = {
  phase: "waiting",
  flowId: "fixture-flow",
  authorizationUrl: "https://auth.openai.com/codex/device",
  userCode: "ABCD-12345",
  expiresAt: "2030-01-01T12:00:00.000Z",
};
const render = (auth: DeviceSignInStatus) => renderToStaticMarkup(createElement(DeviceSignInProgress, { auth }));

describe("Codex device sign-in UI", () => {
  it("offers browser SSO and a one-time code on the server computer", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const store = { refreshInstances: vi.fn(), refreshModels: vi.fn() } as unknown as ReturnType<typeof useStore>;
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: "fixture sign-in stopped" }), {
      status: 500, headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetch);
    try {
      flushSync(() => root.render(createElement(BotEditorStore, { value: store, children: createElement(DeviceSignIn, {
        instanceId: "codex", availableMethods: ["device-code", "browser-pkce"],
      }) })));
      expect(host.textContent).toContain("Browser sign-in");
      expect(host.textContent).toContain("One-time code");
      expect(host.querySelector('button[aria-pressed="true"]')?.textContent).toContain("Browser sign-in");
      flushSync(() => Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("Continue with ChatGPT"))!.click());
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(host.textContent).toContain("fixture sign-in stopped"));
      expect(JSON.parse((fetch.mock.calls[0] as unknown as [string, { body: string }])[1].body)).toEqual({ method: "browser-pkce" });
      flushSync(() => Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("One-time code"))!.click());
      expect(host.querySelector('button[aria-pressed="true"]')?.textContent).toContain("One-time code");
      flushSync(() => Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("Get one-time code"))!.click());
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      expect(JSON.parse((fetch.mock.calls[1] as unknown as [string, { body: string }])[1].body)).toEqual({ method: "device-code" });
    } finally {
      flushSync(() => root.unmount());
      host.remove();
    }
  });

  it("shows a server network error without the unrelated ChatGPT security hint", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const store = { refreshInstances: vi.fn(), refreshModels: vi.fn() } as unknown as ReturnType<typeof useStore>;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Codex sign-in could not reach auth.openai.com from this server." }), {
      status: 500, headers: { "content-type": "application/json" },
    })));
    try {
      flushSync(() => root.render(createElement(BotEditorStore, { value: store, children: createElement(DeviceSignIn, { instanceId: "codex" }) })));
      expect(host.textContent).toContain("Device-code login may need enabling");
      flushSync(() => host.querySelector("button")!.click());
      await vi.waitFor(() => expect(host.textContent).toContain("could not reach auth.openai.com"));
      expect(host.textContent).not.toContain("Device-code login may need enabling");
    } finally {
      flushSync(() => root.unmount());
      host.remove();
    }
  });

  it("shows the one-time code and an explicit official link, not a terminal command", () => {
    const html = render(waiting);
    expect(html).toContain("ABCD-12345");
    expect(html).toContain('href="https://auth.openai.com/codex/device"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("Copy sign-in code");
    expect(html).toContain("Waiting for you");
    expect(html).not.toContain("codex login");
  });

  it.each([
    "http://auth.openai.com/codex/device",
    "https://auth.openai.com.evil.test/codex/device",
    "https://evil.test/",
    "https://auth.openai.com@evil.test/codex/device",
    "https://user@auth.openai.com/codex/device",
    "https://auth.openai.com/codex/device?redirect=evil",
    "https://auth.openai.com/codex/device#token",
    "javascript:alert(1)",
  ])("does not expose an unexpected sign-in URL: %s", (url) => {
    expect(codexDeviceLink(url)).toBeNull();
    const html = render({ ...waiting, authorizationUrl: url });
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("href=");
    expect(html).not.toContain(waiting.userCode);
  });

  it("does not render an invalid code or expired challenge as actionable", () => {
    expect(render({ ...waiting, userCode: "this is not a device code" })).not.toContain("href=");
    const expired = render({ ...waiting, phase: "expired" });
    expect(expired).toContain("code expired");
    expect(expired).not.toContain(waiting.userCode);
    expect(expired).not.toContain("href=");
  });

  it.each(["succeeded", "cancelled", "failed"] as const)("renders the %s result without retaining the code", (phase) => {
    const html = render({ ...waiting, phase });
    expect(html).toContain('role="status"');
    expect(html).not.toContain(waiting.userCode);
    expect(html).not.toContain("href=");
  });

  it.each([401, 403, 404, 410])("stops an obsolete flow after HTTP %i instead of retrying forever", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "This flow no longer exists" }), { status })));
    const cause = await api("/fixture/auth/status").catch((error: unknown) => error);
    expect(cause).toBeInstanceOf(ApiError);
    expect(cause.status).toBe(status);
    expect(deviceFlowUnavailable(cause)).toBe(true);
  });

  it("keeps transient network/provider failures retryable", () => {
    expect(deviceFlowUnavailable(new Error("Network interrupted"))).toBe(false);
    expect(deviceFlowUnavailable(new ApiError("Temporarily busy", 503))).toBe(false);
    expect(deviceFlowUnavailable(new ApiError("Rate limited", 429))).toBe(false);
  });
});

describe("ChatGPT plan browser sign-in", () => {
  const authorizationUrl = "https://auth.openai.com/api/accounts/authorize?client_id=dynamic_agent_client&state=fixture&code_challenge=fixture";
  const renderBrowser = (auth: DeviceSignInStatus) => renderToStaticMarkup(createElement(DeviceSignInProgress, { auth, browserPkce: true }));

  it("uses the official browser flow without a device code or terminal command", () => {
    expect(chatgptPlanLink(authorizationUrl)).toBe(authorizationUrl);
    const html = renderBrowser({ ...waiting, authorizationUrl, userCode: undefined });
    expect(html).toContain("Continue with ChatGPT");
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("Waiting for you");
    expect(html).not.toContain("Copy sign-in code");
    expect(html).not.toContain("codex login");
  });

  it("opens a validated Codex CLI browser login", () => {
    const cliUrl = "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_fixture&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback&code_challenge=fixture_abc&code_challenge_method=S256&state=fixture_123";
    expect(chatgptPlanLink(cliUrl)).toBe(cliUrl);
    const html = renderBrowser({ ...waiting, authorizationUrl: cliUrl, userCode: undefined });
    expect(html).toContain("Continue with ChatGPT");
    expect(html).toContain("href=");
    expect(html).not.toContain("Copy sign-in code");
  });

  it.each([
    "http://auth.openai.com/api/accounts/authorize",
    "https://auth.openai.com.evil.test/api/accounts/authorize",
    "https://user@auth.openai.com/api/accounts/authorize",
    "https://auth.openai.com/api/accounts/authorize#secret",
    "https://auth.openai.com/codex/device",
    "https://auth.openai.com/api/accounts/authorize/",
    "javascript:alert(1)",
  ])("does not expose an unexpected browser sign-in URL: %s", (url) => {
    expect(chatgptPlanLink(url)).toBeNull();
    const html = renderBrowser({ ...waiting, authorizationUrl: url });
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("href=");
  });

  it("has browser-specific cancellation and expiry text", () => {
    expect(renderBrowser({ ...waiting, phase: "cancelled" })).not.toContain("new code");
    expect(renderBrowser({ ...waiting, phase: "expired" })).not.toContain("code expired");
  });
});

describe("Grok Build device sign-in UI", () => {
  const grok: DeviceSignInStatus = { ...waiting, authorizationUrl: "https://accounts.x.ai/device", userCode: "WDJB-MJHT" };
  const renderGrok = (auth: DeviceSignInStatus) => renderToStaticMarkup(createElement(DeviceSignInProgress, { auth, provider: "grok" }));

  it("shows the code and xAI's own page, in Grok's words, not ChatGPT's", () => {
    expect(deviceSignInProvider("grokAgent")).toBe("grok");
    expect(deviceSignInProvider("codex")).toBe("codex");
    const html = renderGrok(grok);
    expect(html).toContain("WDJB-MJHT");
    expect(html).toContain('href="https://accounts.x.ai/device"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("Enter this one-time code on xAI&#x27;s sign-in page");
    expect(html).toContain("Open Grok sign-in");
    expect(html).toContain("grok.com subscription");
    expect(html).not.toMatch(/ChatGPT|OpenAI/);
  });

  it("follows the page that carries the code, only for that code", () => {
    const complete = "https://accounts.x.ai/device?user_code=WDJB-MJHT";
    expect(renderGrok({ ...grok, authorizationUrl: complete })).toContain(`href="${complete}"`);
    expect(renderGrok({ ...grok, authorizationUrl: "https://accounts.x.ai/device?user_code=ZZZZ-ZZZZ" })).not.toContain("href=");
  });

  it.each([
    "https://x.ai.evil.test/device",
    "https://accounts.x.ai/device?token=secret",
    "https://accounts.x.ai/device#token",
    "https://auth.openai.com/codex/device",
    "javascript:alert(1)",
  ])("does not expose an unexpected Grok sign-in URL: %s", (url) => {
    const html = renderGrok({ ...grok, authorizationUrl: url });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Grok did not return a valid xAI sign-in link and code");
    expect(html).not.toContain("href=");
    expect(html).not.toContain(grok.userCode);
  });

  it.each([
    ["failed", { message: "Grok sign-in was declined in the browser. Start sign-in again to try once more." }, "declined in the browser"],
    ["expired", {}, "This code expired"],
    ["cancelled", {}, "Sign-in cancelled"],
    ["succeeded", {}, "Grok connected"],
  ] as const)("ends a %s sign-in with one plain line and no code", (phase, extra, line) => {
    const html = renderGrok({ ...grok, phase, ...extra });
    expect(html).toContain(line);
    expect(html).not.toContain(grok.userCode);
    expect(html).not.toContain("href=");
  });
});
