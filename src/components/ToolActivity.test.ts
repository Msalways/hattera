import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToolActivity } from "./ToolActivity";

describe("ToolActivity", () => {
  it("starts collapsed with an accessible status and escaped input/output", () => {
    const html = renderToStaticMarkup(createElement(ToolActivity, { tool: { name: "Bash", ok: true, input: "echo hi", output: "<script>unsafe()</script>" } }));
    expect(html).toContain("<details");
    expect(html).not.toContain(" open=");
    expect(html).toContain("Bash · Done · Tool details");
    expect(html).toContain('role="button"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("echo hi");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
  it("distinguishes running, failed, cancelled and unrecorded output", () => {
    const render = (ok: boolean | undefined, turnActive = true) => renderToStaticMarkup(createElement(ToolActivity, { tool: { name: "Read", ok }, turnActive }));
    expect(render(undefined)).toContain("Waiting for the tool to finish");
    expect(render(undefined)).toContain("Running");
    expect(render(undefined, false)).toContain("Cancelled");
    expect(render(undefined, false)).not.toContain("Running");
    expect(render(false)).toContain("Failed");
    expect(render(false)).toContain("No output was recorded");
    expect(render(true)).toContain("No output was recorded");
  });
  it("shows a duration only when one was measured, and never for a running call", () => {
    const render = (tool: Parameters<typeof ToolActivity>[0]["tool"]) => renderToStaticMarkup(createElement(ToolActivity, { tool }));
    expect(render({ name: "Bash", ok: true, durationMs: 2400 })).toContain("· 2s");
    expect(render({ name: "Bash", ok: true })).not.toContain("tool-duration");
    expect(render({ name: "Bash", durationMs: 900 })).not.toContain("tool-duration");
  });
  it("offers a diff for an edit, or says it is unavailable", () => {
    const withDiff = renderToStaticMarkup(createElement(ToolActivity, { tool: { name: "Edit", ok: true, input: "src/a.ts", output: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new" } }));
    expect(withDiff).toContain('data-testid="tool-diff"');
    expect(withDiff).toContain("+new");
    const without = renderToStaticMarkup(createElement(ToolActivity, { tool: { name: "Edit", ok: true, input: "src/a.ts" } }));
    expect(without).toContain("Diff unavailable");
    expect(renderToStaticMarkup(createElement(ToolActivity, { tool: { name: "Bash", ok: true } }))).not.toContain("Diff unavailable");
  });
});
