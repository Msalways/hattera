import { describe, expect, it } from "vitest";
import type { Message } from "@/state/store";
import { digestsCoveredByHeader, segmentToolRun, shownDurationMs, toolCountsByTurn, toolDiff, toolKind, toolStatus, toolTarget } from "./tool-rows";

const tool = (id: string, name: string, ok?: boolean): Message => ({ id, role: "bot", kind: "activity", at: 1, tool: { name, ok } });
const user = (id: string): Message => ({ id, role: "user", kind: "text", text: "hi", at: 1 });
const text = (id: string): Message => ({ id, role: "bot", kind: "text", text: "words", at: 1 });

describe("tool rows", () => {
  it("classifies reads and edits, including MCP-prefixed names", () => {
    expect(toolKind("Read")).toBe("read");
    expect(toolKind("mcp__fs__read_file")).toBe("read");
    expect(toolKind("Edit")).toBe("edit");
    expect(toolKind("Bash")).toBe("other");
  });
  it("derives status from the real result and whether the turn is still going", () => {
    expect(toolStatus({ name: "x", ok: true }, true)).toBe("done");
    expect(toolStatus({ name: "x", ok: false }, false)).toBe("failed");
    expect(toolStatus({ name: "x" }, true)).toBe("running");
    expect(toolStatus({ name: "x" }, false)).toBe("cancelled");
  });
  it("names the target from a JSON input, else the first line", () => {
    expect(toolTarget({ name: "Read", input: JSON.stringify({ file_path: "src/a.ts" }, null, 2) })).toBe("src/a.ts");
    expect(toolTarget({ name: "Bash", input: "echo hi" })).toBe("echo hi");
    expect(toolTarget({ name: "X", summary: "s", input: "{}" })).toBe("s");
  });
  it("finds a unified diff only in what the call recorded", () => {
    expect(toolDiff({ name: "Edit", output: "ok" })).toBeNull();
    expect(toolDiff({ name: "Edit", output: "@@ -1 +1 @@\n-a\n+b" })).toEqual(["@@ -1 +1 @@", "-a", "+b"]);
  });
  it("groups only adjacent successful reads and keeps order", () => {
    const segs = segmentToolRun([tool("1", "Read", true), tool("2", "Read", true), tool("3", "Edit", true), tool("4", "Read", true), tool("5", "Read", false), tool("6", "Read", true), tool("7", "Read", true)], false);
    expect(segs.map((s) => s.kind === "group" ? `g:${s.messages.map((m) => m.id).join("")}` : `r:${s.message.id}`)).toEqual(["g:12", "r:3", "r:4", "r:5", "g:67"]);
  });
  it("never groups a running call", () => {
    const segs = segmentToolRun([tool("1", "Read", true), tool("2", "Read", true), tool("3", "Read")], true);
    expect(segs.map((s) => s.kind)).toEqual(["group", "row"]);
  });
  it("counts tools per turn and anchors the count on the first tool", () => {
    const counts = toolCountsByTurn([user("u1"), tool("a", "Read", true), text("t"), tool("b", "Bash", true), user("u2"), text("x"), user("u3"), tool("c", "Bash", true)]);
    expect([...counts]).toEqual([["a", 2], ["c", 1]]);
  });
});

describe("one activity anchor per turn", () => {
  const digest = (id: string): Message => ({ id, role: "bot", kind: "digest", at: 1 } as Message);
  it("covers a digest chip only when the turn already has a counted tool row", () => {
    const msgs = [user("u1"), tool("a", "Read"), digest("d1"), user("u2"), digest("d2")];
    const covered = digestsCoveredByHeader(msgs);
    expect(covered.has("d1")).toBe(true);
    expect(covered.has("d2")).toBe(false);
  });
});

describe("shownDurationMs", () => {
  it("hides unmeasured and sub-0.1s durations, never showing 0s", () => {
    expect(shownDurationMs(undefined)).toBeNull();
    expect(shownDurationMs(0)).toBeNull();
    expect(shownDurationMs(99)).toBeNull();
    expect(shownDurationMs(Number.NaN)).toBeNull();
    expect(shownDurationMs(100)).toBe(100);
    expect(shownDurationMs(2500)).toBe(2500);
  });
});
