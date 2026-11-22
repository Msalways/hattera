// What the composer says after a person changes the approval level under a
// running turn: plain words for when it lands, never a silent
// change, and a notice that goes away with the turn it was about.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { clearLevelChangeNotice, levelChangeStale, setLevelChangeNotice } from "@/lib/level-change";
import { ApprovalLevelNotice } from "./ApprovalLevelNotice";

const render = (busy: boolean, saved: "ask" | "edits" | "auto" = "edits") =>
  renderToStaticMarkup(createElement(ApprovalLevelNotice, { threadId: "t1", busy, savedMode: saved }));

afterEach(() => clearLevelChangeNotice("t1"));

describe("approval level notice", () => {
  it("is a polite live region even when empty, so a first change is announced", () => {
    const html = render(true);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain("approval-level-notice");
  });
  it("says a level the engine took mid-turn applies now", () => {
    setLevelChangeNotice("t1", { status: "done", requested: "edits", effective: "edits", appliesAt: "now", resolved: 1, at: 1 });
    const html = render(true);
    expect(html).toContain('data-state="now"');
    expect(html).toMatch(/Auto-accept edits/);
    expect(html).toMatch(/1/);
  });
  it("says 'applies after this step' for an engine that cannot take it mid-turn, naming the level the step still uses", () => {
    setLevelChangeNotice("t1", { status: "done", requested: "auto", effective: "ask", appliesAt: "next-turn", resolved: 0, at: 1 });
    const html = render(true);
    expect(html).toContain('data-state="next-turn"');
    expect(html).toContain("applies after this step");
    expect(html).toMatch(/Ask for approval/);
    expect(html).toContain("wasn&#x27;t stopped");
    expect(html).toContain("The bot&#x27;s default is unchanged");
  });
  it("shows saving and failed states", () => {
    setLevelChangeNotice("t1", { status: "saving", requested: "edits", at: 1 });
    expect(render(true)).toContain('data-state="saving"');
    setLevelChangeNotice("t1", { status: "failed", requested: "edits", error: "boom", at: 2 });
    const failed = render(true);
    expect(failed).toContain('data-state="failed"');
    expect(failed).toContain("boom");
  });
  it("goes away once the turn it was about is over, except a failure", () => {
    const done = { status: "done", requested: "edits", appliesAt: "next-turn", at: 1 } as const;
    expect(levelChangeStale(done, true)).toBe(false);
    expect(levelChangeStale(done, false)).toBe(true);
    expect(levelChangeStale({ status: "failed", requested: "edits", at: 1 }, false)).toBe(false);
    expect(levelChangeStale({ status: "done", requested: "edits", appliesAt: "idle", at: 1 }, false)).toBe(false);
    expect(levelChangeStale(undefined, true)).toBe(true);
  });
});
