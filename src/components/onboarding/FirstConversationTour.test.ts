import { createElement, type EffectCallback, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTourFinished } from "@/lib/guided-tour";
import { EMPTY_ONBOARDING, WELCOME_VERSION } from "@/lib/onboarding";

const fixture = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[] }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = typeof initial === "function" ? initial() : initial;
    return [fixture.values[index], (next: unknown) => {
      fixture.values[index] = typeof next === "function" ? next(fixture.values[index]) : next;
    }];
  },
  useRef: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = { current: initial };
    return fixture.values[index];
  },
  useEffect: (effect: EffectCallback) => {
    fixture.effects.push(effect);
  },
}));
const store = vi.hoisted(() => ({ state: {} as Record<string, unknown>, api: vi.fn() }));
vi.mock("@/state/store", () => ({
  api: store.api,
  useStore: () => ({ state: store.state, dispatch: vi.fn() }),
}));
vi.mock("@/lib/analytics", () => ({ emailGateDone: () => false }));
vi.mock("./Spotlight", () => ({ Spotlight: () => null }));
import { FirstConversationTour } from "./FirstConversationTour";
import { Spotlight } from "./Spotlight";

function render(quiet: boolean) {
  fixture.index = 0;
  fixture.effects = [];
  let tree: ReactNode = null;
  function Capture() {
    tree = FirstConversationTour({ quiet });
    return tree;
  }
  renderToStaticMarkup(createElement(Capture));
  return tree as { type?: unknown } | null;
}

const approval = { kind: "options", card: { requestId: "r", tool: "Bash", answered: undefined } };
const connector = { kind: "connector", connector: { status: "required" } };
const record = () => ({ ...EMPTY_ONBOARDING, completedAt: "2026-09-23T00:00:00.000Z", version: WELCOME_VERSION });
const setChat = (messages: unknown[], onboarding: Record<string, unknown> = { ...record(), hintsSeen: withTourFinished(record()) }) => {
  store.state = {
    config: { onboarding },
    welcomeOpen: false,
    selectedId: "bot-1",
    bots: [{ id: "bot-1", threadId: "t-1", busy: false, messages }],
  };
};

beforeEach(() => {
  fixture.values = [];
  store.api.mockReset();
  vi.stubGlobal("window", {});
  setChat([connector]);
});

describe("first-conversation spotlights", () => {
  it("explain the connect-app card as before", () => {
    render(false);
    for (const effect of fixture.effects) effect();
    expect(render(false)?.type).toBe(Spotlight);
  });

  it("show no tip while an approval is waiting for the person", () => {
    setChat([approval]);
    render(false);
    for (const effect of fixture.effects) effect();
    expect(render(false)).toBeNull();
  });

  it("show no tip while a question is waiting for the person", () => {
    setChat([connector, { kind: "options", card: { requestId: "q", questionRequest: {}, options: ["a", "b"] } }]);
    render(false);
    for (const effect of fixture.effects) effect();
    expect(render(false)).toBeNull();
  });

  it("come back once the approval is answered", () => {
    setChat([connector, approval]);
    render(false);
    for (const effect of fixture.effects) effect();
    expect(render(false)).toBeNull();
    (store.state.bots as Array<{ messages: Array<{ card?: { answered?: string } }> }>)[0].messages[1]!.card!.answered = "allow";
    render(false);
    for (const effect of fixture.effects) effect();
    expect(render(false)?.type).toBe(Spotlight);
  });

  it("stay away after the welcome flow was skipped", () => {
    setChat([connector], { ...record(), outcome: "skipped", hintsSeen: [] });
    render(false);
    for (const effect of fixture.effects) effect();
    expect(render(false)).toBeNull();
    expect(store.api).not.toHaveBeenCalled();
  });

  it("stay away from a hosted member, who could never dismiss them for good", () => {
    render(true);
    for (const effect of fixture.effects) effect();
    expect(render(true)).toBeNull();
    expect(store.api).not.toHaveBeenCalled();
  });
});
