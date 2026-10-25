import { createElement, type EffectCallback } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ effects: [] as EffectCallback[], pair: vi.fn() }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useEffect: (effect: EffectCallback) => { f.effects.push(effect); } }));
vi.mock("../lib/session", async original => ({ ...await original<typeof import("../lib/session")>(), pairWithCode: f.pair, readSessionState: vi.fn().mockResolvedValue({ kind: "unauthenticated", error: "" }) }));
vi.mock("../components/DesktopWorkspaceSwitcher", () => ({ DesktopWorkspaceSwitcher: () => null }));
import { PairPage, githubSignInTarget, pairIntro, pairsAutomatically } from "./PairPage";
import en from "../locales/en.json";

const code = "ABCD-EFGH-JK23";
const render = (initialCode: string | null) => { f.effects = []; return renderToStaticMarkup(createElement(PairPage, { initialCode })); };
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
let replaced: string[];
beforeEach(() => {
  f.pair.mockReset(); replaced = [];
  vi.stubGlobal("location", { replace: (url: string) => replaced.push(url) });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
});
afterEach(() => vi.unstubAllGlobals());

it("in the desktop app, a code the link carried connects at once; a browser still asks", () => {
  expect(pairsAutomatically(code, true)).toBe(true);
  expect(pairsAutomatically(code, false)).toBe(false);
  expect(pairsAutomatically(null, true)).toBe(false);
});

it("only explicitly generated loopback CLI links connect automatically", () => {
  for (const hostname of ["localhost", "127.0.0.1", "[::1]"]) {
    expect(pairsAutomatically(code, false, "?cli=1", hostname, true)).toBe(true);
    expect(pairsAutomatically(code, false, "?cli=1", hostname, false)).toBe(false);
    expect(pairsAutomatically(null, false, "?cli=1", hostname, true)).toBe(false);
    expect(pairsAutomatically(code, false, "", hostname, true)).toBe(false);
  }
  for (const hostname of ["example.com", "100.65.0.2", "127.0.0.1.example.com", ""]) {
    expect(pairsAutomatically(code, false, "?cli=1", hostname, true)).toBe(false);
  }
});

it("a CLI query flag cannot skip authentication without the server's launcher capability", async () => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("location", { hostname: "127.0.0.1", search: "?cli=1", replace: (url: string) => replaced.push(url) });
  f.pair.mockResolvedValue({ ok: true });
  expect(render(code)).toContain("<form");
  f.effects[0](); await flush();
  expect(f.pair).not.toHaveBeenCalled();
  expect(replaced).toEqual([]);
});

it("moves GitHub sign-in to the callback origin before starting OAuth", () => {
  expect(githubSignInTarget("http://localhost:8080", "http://127.0.0.1:8080"))
    .toBe("http://127.0.0.1:8080/pair?githubStart=1");
  expect(githubSignInTarget("http://127.0.0.1:8080", "http://127.0.0.1:8080")).toBeNull();
});

it("explains a GitHub callback that lost its browser session", () => {
  vi.stubGlobal("location", { search: "?github=state", replace: (url: string) => replaced.push(url) });
  expect(render(null)).toContain("GitHub sign-in lost its browser session. Start again from this page.");
});

it("opening My Cloud from the app needs no click and no code to type", async () => {
  vi.stubGlobal("window", { ogb: { workspaces: {} } });
  f.pair.mockResolvedValue({ ok: true });
  const html = render(code);
  expect(html).toContain("Connecting to this Hattera server…");
  expect(html).not.toContain("Pairing code"); expect(html).not.toContain("<form");
  f.effects[0](); await flush();
  expect(f.pair).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code }));
  expect(replaced).toEqual(["/"]);
});

it("a code that no longer works falls back to the form, with the reason", async () => {
  vi.stubGlobal("window", { ogb: { workspaces: {} } });
  f.pair.mockResolvedValue({ ok: false, error: "That pairing code has expired." });
  render(code); f.effects[0](); await flush();
  expect(replaced).toEqual([]);
});

it("a browser keeps the code in the form for the person to confirm", () => {
  vi.stubGlobal("window", {});
  const html = render(code);
  expect(html).toContain(`value="${code}"`); expect(html).toContain(">Connect</button>");
  f.effects[0]?.(); expect(f.pair).not.toHaveBeenCalled();
});

it("My Cloud says where its connection starts, never 'the code shown on the server'", () => {
  const cloud = pairIntro({ mode: "code", sent: false, email: "", cloudHome: true });
  // It names the app's own button and Settings section, as they are labelled.
  expect(cloud).toContain(`choose ${en["cloudHome.connect"]} in the desktop app`);
  expect(cloud).toContain(`Settings → ${en["settings.section.cloudAccount"]}`);
  expect(cloud).toContain("on your Plan page");
  expect(cloud).not.toContain("shown on the server");
  expect(pairIntro({ mode: "code", sent: false, email: "", cloudHome: false })).toContain("shown on the server");
  expect(pairIntro({ mode: "email", sent: true, email: "a@b.test", cloudHome: false })).toContain("a@b.test");
});
