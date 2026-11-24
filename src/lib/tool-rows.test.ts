import { describe, expect, it } from "vitest";
import type { Message } from "@/state/store";
import { digestsCoveredByHeader, segmentToolRun, shownDurationMs, toolCountsByTurn, toolDiff, toolKind, toolStatus, toolTarget, toolTurnStates } from "./tool-rows";

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
    // a missing result never proves a cancellation
    expect(toolStatus({ name: "x" }, false)).toBe("incomplete");
    expect(toolStatus({ name: "x" }, "unknown")).toBe("incomplete");
    expect(toolStatus({ name: "x" }, "cancelled")).toBe("cancelled");
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
  it("counts tools per turn and anchors the count on the turn's first row, not its first tool", () => {
    const counts = toolCountsByTurn([user("u1"), text("t0"), tool("a", "Read", true), text("t"), tool("b", "Bash", true), user("u2"), text("x"), user("u3"), tool("c", "Bash", true)]);
    expect([...counts]).toEqual([["t0", 2], ["c", 1]]);
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
  it("hides unmeasured and sub-second durations, so a whole-second label never reads 0s", () => {
    expect(shownDurationMs(undefined)).toBeNull();
    expect(shownDurationMs(0)).toBeNull();
    expect(shownDurationMs(99)).toBeNull();
    expect(shownDurationMs(250)).toBeNull();
    expect(shownDurationMs(999)).toBeNull();
    expect(shownDurationMs(Number.NaN)).toBeNull();
    expect(shownDurationMs(1000)).toBe(1000);
    expect(shownDurationMs(2500)).toBe(2500);
  });
});

describe("one turn, one header (steered rows)", () => {
  const steer = (id: string): Message => ({ ...user(id), steered: true });
  const inTurn = (m: Message, turnId: string): Message => ({ ...m, turnId });
  it("a steered user row in the middle of a turn does not start a second header", () => {
    const counts = toolCountsByTurn([user("u1"), tool("a", "Read", true), steer("s1"), tool("b", "Bash", true)]);
    expect([...counts]).toEqual([["a", 2]]);
  });
  it("by turnId: the same turn keeps one header even across a request-looking row", () => {
    const counts = toolCountsByTurn([user("u1"), inTurn(tool("a", "Read", true), "t1"), user("u2"), inTurn(tool("b", "Bash", true), "t1")]);
    expect([...counts]).toEqual([["a", 2]]);
  });
  it("two real requests are two turns", () => {
    const counts = toolCountsByTurn([user("u1"), inTurn(tool("a", "Read", true), "t1"), user("u2"), inTurn(tool("b", "Bash", true), "t2")]);
    expect([...counts]).toEqual([["a", 1], ["b", 1]]);
  });
  it("covers the digest of a turn that a steered row split", () => {
    const digest = { id: "d", role: "bot", kind: "digest", at: 1 } as Message;
    expect(digestsCoveredByHeader([user("u1"), tool("a", "Read", true), steer("s1"), digest]).has("d")).toBe(true);
  });
});

describe("toolTurnStates", () => {
  const stopped: Message = { id: "stop", role: "bot", kind: "activity", at: 1, tool: { name: "stopped: by you" } };
  it("only the newest turn can be active, and only while the chat is busy", () => {
    const msgs = [user("u1"), tool("a", "Bash"), user("u2"), tool("b", "Bash")];
    expect(toolTurnStates(msgs, true).get("a")).toBe("unknown");
    expect(toolTurnStates(msgs, true).get("b")).toBe("active");
    expect(toolTurnStates(msgs, false).get("b")).toBe("unknown");
  });
  it("a missing result is cancelled only when a stop row of that turn follows", () => {
    const msgs = [user("u1"), tool("a", "Bash"), stopped, user("u2"), tool("b", "Bash")];
    const states = toolTurnStates(msgs, false);
    expect(states.get("a")).toBe("cancelled");
    expect(states.get("b")).toBe("unknown");
  });
  it("does not list a call that has its result", () => {
    expect(toolTurnStates([user("u1"), tool("a", "Bash", true)], true).has("a")).toBe(false);
  });
});

describe("two provider turns after one stored prompt", () => {
  const row = (id: string, turnId: string) => ({ id, turnId, role: "bot", kind: "activity", at: 1, tool: { name: "Read", itemId: id } }) as Message;
  it("keeps separate tool anchors when the explicit turnId changes without a new user row", () => {
    const rows = [
      { id: "u", role: "user", kind: "text", at: 0, text: "Work" } as Message,
      row("a", "turn-1"),
      { id: "reply", role: "bot", kind: "text", at: 2, text: "First turn done", turnId: "turn-1", turnTerminal: true } as Message,
      row("b", "turn-2"),
    ];
    expect([...toolCountsByTurn(rows)]).toEqual([["a", 1], ["b", 1]]);
  });
  it("does not revive an unfinished call of an older turn while a newer one runs", () => {
    const rows = [{ id: "u", role: "user", kind: "text", at: 0, text: "Work" } as Message, row("a", "turn-1"), row("b", "turn-2")];
    const state = toolTurnStates(rows, true);
    expect(state.get("a")).toBe("unknown");
    expect(state.get("b")).toBe("active");
  });
  it("still groups legacy rows without turn ids after one request row", () => {
    const legacy = (id: string) => ({ id, role: "bot", kind: "activity", at: 1, tool: { name: "Read", itemId: id } }) as Message;
    expect([...toolCountsByTurn([{ id: "u", role: "user", kind: "text", at: 0, text: "x" } as Message, legacy("a"), legacy("b")])]).toEqual([["a", 2]]);
  });
});
