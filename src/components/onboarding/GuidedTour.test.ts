// @vitest-environment happy-dom
// The guided tour's tip: gone after a skip, and held back while an approval
// or question is waiting for the person, so it never covers the command.
import { createElement, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_ONBOARDING, toursEnded, WELCOME_VERSION } from "@/lib/onboarding";

const store = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock("@/state/store", () => ({
  api: vi.fn(async () => ({})),
  useStore: () => ({ state: store.state, dispatch: vi.fn() }),
}));
vi.mock("@/lib/interface-mode", () => ({ readAdvancedMode: () => true }));
vi.mock("./Spotlight", () => ({
  Spotlight: ({ children, secondary }: { children: ReactNode; secondary?: { label: string; onClick: () => void } }) =>
    createElement("div", { "data-testid": "tip" }, children, secondary && createElement("button", { onClick: secondary.onClick }, secondary.label)),
}));

const { GuidedTour } = await import("./GuidedTour");
const { api } = await import("@/state/store");

const record = { ...EMPTY_ONBOARDING, completedAt: "2026-09-23T00:00:00.000Z", version: WELCOME_VERSION };
const approval = () => ({ kind: "options", card: { requestId: "r", tool: "Bash" } as { requestId: string; tool: string; answered?: string } });
const set = (onboarding: Record<string, unknown>, messages: unknown[] = []) => {
  store.state = { config: { onboarding }, welcomeOpen: false, tourOpen: true, selectedId: "bot-1", bots: [{ id: "bot-1", messages }] };
};

let host: HTMLDivElement;
let root: Root;
const render = () => flushSync(() => root.render(createElement(GuidedTour)));
const tip = () => host.querySelector('[data-testid="tip"]');

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

describe("guided tour tip", () => {
  it("is offered after the welcome flow was finished", () => {
    set({ ...record, outcome: "finished", hintsSeen: [] });
    render();
    expect(tip()).not.toBeNull();
  });

  it("is offered to a record saved before the outcome existed", () => {
    set({ ...record, hintsSeen: [] });
    render();
    expect(tip()).not.toBeNull();
  });

  it("never starts after the welcome flow was skipped", () => {
    set({ ...record, outcome: "skipped", hintsSeen: [] });
    render();
    expect(tip()).toBeNull();
  });

  it("stays hidden while an approval is waiting, and returns once it is answered", () => {
    const card = approval();
    set({ ...record, outcome: "finished", hintsSeen: [] }, [card]);
    render();
    expect(tip()).toBeNull();
    card.card.answered = "allow";
    render();
    expect(tip()).not.toBeNull();
  });

  it("stays hidden while a question is waiting", () => {
    set({ ...record, outcome: "finished", hintsSeen: [] }, [{ kind: "options", card: { requestId: "q", questionRequest: {} } }]);
    render();
    expect(tip()).toBeNull();
  });

  it.each(["approval", "question"])("stays hidden while a %s is waiting in the selected room", (kind) => {
    const card = kind === "approval" ? approval() : { kind: "options", card: { requestId: "q", questionRequest: {} } };
    store.state = {
      config: { onboarding: { ...record, outcome: "finished", hintsSeen: [] } },
      welcomeOpen: false,
      tourOpen: true,
      selectedId: "room-1",
      bots: [{ id: "bot-1", messages: [] }],
      groups: [{ id: "room-1", messages: [card] }],
    };
    render();
    expect(tip()).toBeNull();
  });

  it("Skip tour persists the shared skipped outcome", async () => {
    const saved: Record<string, unknown> = { ...record, outcome: "finished", hintsSeen: [] };
    set(saved);
    vi.mocked(api).mockClear();
    vi.mocked(api).mockImplementation((async (_path: string, options?: { body?: string }) => {
      Object.assign(saved, JSON.parse(String(options?.body)).onboarding);
      return { onboarding: { ...saved } };
    }) as never);
    render();
    const skipButton = [...host.querySelectorAll("button")].find((b) => /skip tour/i.test(b.textContent ?? ""));
    expect(skipButton).toBeDefined();
    flushSync(() => skipButton!.click());
    await expect.poll(() => vi.mocked(api).mock.calls.length).toBeGreaterThan(0);
    expect(saved.outcome).toBe("skipped");
    expect(toursEnded(saved as never)).toBe(true);
  });
});
