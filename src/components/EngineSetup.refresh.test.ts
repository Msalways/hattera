// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BotEditorStore, initialState, type InstanceInfo, type useStore } from "@/state/store";
import { EngineSetup } from "./EngineSetup";
import { RefreshEngines } from "./EngineLibrary";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const refresh = vi.fn();
const dispatch = vi.fn();
const refreshModels = vi.fn().mockResolvedValue(undefined);
const engine: InstanceInfo = {
  instanceId: "kimi", driverKind: "kimiAgent", displayName: "Kimi",
  snapshot: { state: "unavailable", reason: "Fixture missing CLI" }, models: { default: "", options: [] },
  install: { platform: "linux", command: { linux: "fixture-install" }, signInCommand: "kimi login", server: { package: "kimi-fixture" } },
};
function mount(child: ReactNode = createElement(RefreshEngines)) {
  const store = { state: initialState, dispatch, refreshInstances: refresh, refreshModels } as unknown as ReturnType<typeof useStore>;
  act(() => root.render(createElement(BotEditorStore, { value: store, children: child })));
}
const button = (name: string) => Array.from(host.querySelectorAll("button")).find((node) => node.textContent?.includes(name))!;
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  refresh.mockReset(); dispatch.mockReset(); refreshModels.mockClear();
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("shows refresh failure and offers a working retry", async () => {
  refresh.mockRejectedValueOnce(new Error("Fixture server offline")).mockResolvedValueOnce(undefined);
  mount();
  await act(async () => button("Check again").click());
  expect(refresh).toHaveBeenCalledWith({ reportErrors: true });
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("previous status is still shown");
  expect(button("Check again").disabled).toBe(false);
  await act(async () => button("Check again").click());
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.querySelector('[role="status"]')?.textContent).toContain("refreshed");
});

it("disables recheck while a probe is running", async () => {
  let finish!: () => void;
  refresh.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
  mount();
  act(() => button("Check again").click());
  expect(button("Checking").disabled).toBe(true);
  await act(async () => finish());
  expect(button("Check again").disabled).toBe(false);
});

it("confirms the CLI install even when account setup keeps the provider unavailable", async () => {
  vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => Promise.resolve(new Response(JSON.stringify(
    url.endsWith("/install/status") ? { install: { state: "succeeded", instances: [engine] } } : { install: { state: "running" } },
  )))));
  mount(createElement(EngineSetup, { instance: engine }));
  await act(async () => button("Install Kimi on this server").click());
  expect(host.textContent).toContain("Installation verified. Sign in if requested.");
  expect(host.textContent).not.toContain("installer finished, but the provider is not usable yet");
  expect(refreshModels).not.toHaveBeenCalled();
  expect(dispatch).toHaveBeenCalledWith({ type: "instances", instances: [engine] });
});

it("uses the verified install response instead of relying on another status request", async () => {
  const installed = { ...engine, snapshot: { state: "available", authenticated: false } };
  vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => Promise.resolve(new Response(JSON.stringify(
    url.endsWith("/install/status") ? { install: { state: "succeeded", instances: [installed] } } : { install: { state: "running" } },
  )))));
  mount(createElement(EngineSetup, { instance: engine }));
  await act(async () => button("Install Kimi on this server").click());
  expect(dispatch).toHaveBeenCalledWith({ type: "instances", instances: [installed] });
  expect(refresh).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Installation verified. Sign in if requested.");
});

it("shows an asynchronous installer failure and allows a retry", async () => {
  let checks = 0;
  vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => Promise.resolve(new Response(JSON.stringify(
    url.endsWith("/install/status")
      ? { install: ++checks === 1 ? { state: "idle" } : { state: "failed", error: "Package download failed" } }
      : { install: { state: "running" } },
  )))));
  mount(createElement(EngineSetup, { instance: engine }));
  await act(async () => button("Install Kimi on this server").click());
  expect(host.textContent).toContain("Package download failed");
  expect(button("Install Kimi on this server").disabled).toBe(false);
});

it("resumes an installation already running when Settings is reopened", async () => {
  let checks = 0;
  const fetcher = vi.fn().mockImplementation((url: string) => Promise.resolve(new Response(JSON.stringify(
    url.endsWith("/install/status")
      ? { install: ++checks === 1 ? { state: "running" } : { state: "succeeded", instances: [engine] } }
      : { install: { state: "running" } },
  ))));
  vi.stubGlobal("fetch", fetcher);
  await act(async () => mount(createElement(EngineSetup, { instance: engine })));
  expect(host.textContent).toContain("Installation verified. Sign in if requested.");
  expect(fetcher.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
});

it("never opens a local terminal to install on a paired remote server", () => {
  vi.stubGlobal("window", Object.assign(window, { ogb: { platform: "win32", openInstallTerminal: vi.fn(), remoteClient: { active: true } } }));
  mount(createElement(EngineSetup, { instance: engine }));
  expect(host.textContent).not.toContain("Open install in Terminal");
  expect(host.textContent).toContain("Install Kimi on this server");
  expect(host.textContent).not.toContain("fixture-install");
  expect(host.textContent).toContain("installation happens on the server");
});
