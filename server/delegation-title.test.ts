import { describe, expect, it } from "vitest";
import { DELEGATED_SUMMARY_MAX, delegatedTaskSummary, delegatedThreadTitle } from "./delegation-title.ts";

describe("delegatedTaskSummary", () => {
  it("takes the first sentence", () => {
    expect(delegatedTaskSummary("Review the pricing page copy. Then send me notes.")).toBe("Review the pricing page copy");
  });
  it("skips blank lines, headings, list markers and markdown decoration", () => {
    expect(delegatedTaskSummary("\n\n## **Draft** the `release` notes\nmore")).toBe("Draft the release notes");
    expect(delegatedTaskSummary("- 1. Fix the login redirect")).toBe("Fix the login redirect");
  });
  it("collapses whitespace", () => {
    expect(delegatedTaskSummary("Check   the\t build   output")).toBe("Check the build output");
  });
  it("cuts a long sentence at 60 characters with an ellipsis", () => {
    const out = delegatedTaskSummary(`Investigate ${"intermittent ".repeat(10)}failures in the nightly job`)!;
    expect(Array.from(out).length).toBeLessThanOrEqual(DELEGATED_SUMMARY_MAX);
    expect(out.endsWith("…")).toBe(true);
  });
  it("does not split a surrogate pair when cutting", () => {
    const out = delegatedTaskSummary("é😀".repeat(100))!;
    expect(Array.from(out).length).toBe(DELEGATED_SUMMARY_MAX);
    expect(out).not.toMatch(/[\uD800-\uDBFF]$/);
  });
  it("returns null when there is nothing meaningful", () => {
    for (const bad of [undefined, null, "", "   \n  ", "***", "---\n>>>", 42 as unknown as string]) expect(delegatedTaskSummary(bad)).toBeNull();
  });
});

describe("delegatedThreadTitle", () => {
  it("names two different requests differently", () => {
    const a = delegatedThreadTitle("Lead", "Write the migration plan.");
    const b = delegatedThreadTitle("Lead", "Audit the billing webhooks.");
    expect(a).toBe("@Lead · Write the migration plan");
    expect(b).toBe("@Lead · Audit the billing webhooks");
    expect(a).not.toBe(b);
  });
  it("falls back to Delegated task", () => {
    expect(delegatedThreadTitle("Lead", "")).toBe("@Lead · Delegated task");
    expect(delegatedThreadTitle("Lead", "###")).toBe("@Lead · Delegated task");
  });
});
