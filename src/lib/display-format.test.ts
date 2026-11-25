import { describe, expect, it } from "vitest";
import {
  formatDuration,
  formatFullDateTime,
  formatModelName,
  formatRelativeDate,
  formatResetTime,
  toTimestamp,
  truncatePathMiddle,
} from "./display-format";

const NOW = Date.UTC(2026, 10, 25, 15, 0, 0); // 25 Nov 2026 15:00 UTC
const opts = { locale: "en-US", timeZone: "UTC", now: NOW };
const ago = (ms: number) => NOW - ms;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const en = { locale: "en-US" };

describe("toTimestamp", () => {
  it("accepts dates, numbers and parseable strings", () => {
    expect(toTimestamp(new Date(NOW))).toBe(NOW);
    expect(toTimestamp(NOW)).toBe(NOW);
    expect(toTimestamp("2026-11-25T15:00:00Z")).toBe(NOW);
  });
  it("rejects missing and invalid values", () => {
    for (const bad of [null, undefined, "", "not a date", NaN, Infinity, new Date("x"), {}, true]) expect(toTimestamp(bad)).toBeNull();
  });
});

describe("formatRelativeDate", () => {
  it("reads under a minute as Just now", () => {
    expect(formatRelativeDate(ago(0), opts)).toBe("Just now");
    expect(formatRelativeDate(ago(59_000), opts)).toBe("Just now");
  });
  it("reads minutes and hours", () => {
    expect(formatRelativeDate(ago(MIN), opts)).toBe("1 minute ago");
    expect(formatRelativeDate(ago(5 * MIN), opts)).toBe("5 minutes ago");
    expect(formatRelativeDate(ago(2 * HOUR), opts)).toBe("2 hours ago");
  });
  it("reads the previous calendar day as Yesterday", () => {
    expect(formatRelativeDate(Date.UTC(2026, 10, 24, 20, 0, 0), opts)).toBe("Yesterday");
  });
  it("reads older dates as a localized date, with the year only when it differs", () => {
    expect(formatRelativeDate(Date.UTC(2026, 10, 20, 9, 0, 0), opts)).toBe("Nov 20");
    expect(formatRelativeDate(Date.UTC(2025, 10, 20, 9, 0, 0), opts)).toBe("Nov 20, 2025");
  });
  it("reads a future instant as in …", () => {
    expect(formatRelativeDate(NOW + 5 * MIN, opts)).toBe("in 5 minutes");
    expect(formatRelativeDate(NOW + 3 * HOUR, opts)).toBe("in 3 hours");
    expect(formatRelativeDate(NOW + 2 * DAY, opts)).toBe("in 2 days");
  });
  it("is Unavailable for missing or invalid values, never Invalid Date", () => {
    for (const bad of [null, undefined, "", "garbage", NaN]) expect(formatRelativeDate(bad, opts)).toBe("Unavailable");
  });
  it("follows the requested locale", () => {
    expect(formatRelativeDate(ago(2 * HOUR), { ...opts, locale: "de" })).toBe("vor 2 Stunden");
  });
});

describe("formatFullDateTime", () => {
  it("gives the full date, time and zone", () => {
    const text = formatFullDateTime(NOW, opts);
    expect(text).toContain("November 25, 2026");
    expect(text).toContain("UTC");
  });
  it("is Unavailable when invalid", () => {
    expect(formatFullDateTime("nope", opts)).toBe("Unavailable");
    expect(formatFullDateTime(undefined, opts)).toBe("Unavailable");
  });
});

describe("formatDuration", () => {
  it("shows the largest two useful units", () => {
    expect(formatDuration(45_000, en)).toBe("45 sec");
    expect(formatDuration(130_000, en)).toBe("2 min 10 sec");
    expect(formatDuration(65 * MIN, en)).toBe("1 hr 5 min");
    expect(formatDuration(2 * DAY + 3 * HOUR + 4 * MIN, en)).toBe("2 days 3 hr");
  });
  it("drops a zero second unit", () => {
    expect(formatDuration(2 * HOUR, en)).toBe("2 hr");
    expect(formatDuration(3 * MIN, en)).toBe("3 min");
  });
  it("rounds seconds", () => {
    expect(formatDuration(1_400, en)).toBe("1 sec");
    expect(formatDuration(1_600, en)).toBe("2 sec");
    expect(formatDuration(59_600, en)).toBe("1 min");
  });
  it("clamps negative and tiny elapsed time to zero", () => {
    expect(formatDuration(-5_000, en)).toBe("0 sec");
    expect(formatDuration(0, en)).toBe("0 sec");
    expect(formatDuration(200, en)).toBe("0 sec");
  });
  it("is Unavailable for non-numbers and non-finite numbers", () => {
    for (const bad of [null, undefined, "5", NaN, Infinity]) expect(formatDuration(bad, en)).toBe("Unavailable");
  });
  it("localizes the units", () => {
    expect(formatDuration(130_000, { locale: "de" })).not.toBe("2 min 10 sec");
    expect(formatDuration(130_000, { locale: "de" })).toMatch(/2\D+10/);
  });
});

describe("formatResetTime", () => {
  it("says today, tomorrow or the date", () => {
    expect(formatResetTime(Date.UTC(2026, 10, 25, 18, 30), opts)).toMatch(/^Resets today at 6:30\sPM$/);
    expect(formatResetTime(Date.UTC(2026, 10, 26, 18, 30), opts)).toMatch(/^Resets tomorrow at 6:30\sPM$/);
    expect(formatResetTime(Date.UTC(2026, 10, 28, 18, 30), opts)).toMatch(/^Resets Nov 28 at 6:30\sPM$/);
  });
  it("shows the year when it is not this one", () => {
    expect(formatResetTime(Date.UTC(2027, 0, 3, 8, 0), opts)).toMatch(/^Resets Jan 3, 2027 at 8:00\sAM$/);
  });
  it("uses the device zone for the calendar day", () => {
    // 03:00 UTC on the 26th is tomorrow in UTC, but already today in Tokyo (now is 00:00 on the 26th there).
    const at = Date.UTC(2026, 10, 26, 3, 0);
    expect(formatResetTime(at, opts)).toMatch(/^Resets tomorrow at 3:00\sAM$/);
    expect(formatResetTime(at, { ...opts, timeZone: "Asia/Tokyo" })).toMatch(/^Resets today at 12:00\sPM$/);
  });
  it("is Reset time unavailable when missing or invalid", () => {
    for (const bad of [null, undefined, "", "soon", NaN]) expect(formatResetTime(bad, opts)).toBe("Reset time unavailable");
  });
  it("still reads a time already past with its date", () => {
    expect(formatResetTime(Date.UTC(2026, 10, 25, 9, 0), opts)).toMatch(/^Resets today at 9:00\sAM$/);
    expect(formatResetTime(Date.UTC(2026, 10, 20, 9, 0), opts)).toMatch(/^Resets Nov 20 at 9:00\sAM$/);
  });
});

describe("formatModelName", () => {
  it("prefers the provider's display name and keeps the real id", () => {
    expect(formatModelName("claude-sonnet-5", "Claude Sonnet 5")).toEqual({ label: "Claude Sonnet 5", id: "claude-sonnet-5" });
  });
  it("falls back to the exact id, never inventing a version", () => {
    expect(formatModelName("claude-sonnet-5")).toEqual({ label: "claude-sonnet-5", id: "claude-sonnet-5" });
    expect(formatModelName("gpt-x", "   ")).toEqual({ label: "gpt-x", id: "gpt-x" });
    expect(formatModelName("gpt-x", null)).toEqual({ label: "gpt-x", id: "gpt-x" });
  });
  it("copes with a missing id", () => {
    expect(formatModelName(undefined, undefined)).toEqual({ label: "", id: "" });
    expect(formatModelName(null, "Display")).toEqual({ label: "Display", id: "" });
  });
});

describe("truncatePathMiddle", () => {
  it("leaves a path that fits exactly as it is", () => {
    expect(truncatePathMiddle("C:\\Users\\shant\\a.md", 48)).toBe("C:\\Users\\shant\\a.md");
    expect(truncatePathMiddle("/home/a/b.txt", 48)).toBe("/home/a/b.txt");
  });
  it("returns empty text for missing or empty input", () => {
    for (const bad of [null, undefined, ""]) expect(truncatePathMiddle(bad)).toBe("");
  });
  it("keeps the root and the identifying end of a long Windows path", () => {
    const path = "C:\\Users\\shant\\.openmausbot\\task-workspaces\\4d135042-86c7-499c-aa31-d7c2766c09c5\\9dd06e77-7c91-41e8-a0d2-cd0fd5c8e164\\report.md";
    const out = truncatePathMiddle(path, 48);
    expect(out.length).toBeLessThanOrEqual(48);
    expect(out.startsWith("C:\\Users\\shant\\")).toBe(true);
    expect(out).toContain("…");
    expect(out.endsWith("\\report.md")).toBe(true);
  });
  it("keeps the root and the end of a long POSIX path", () => {
    const out = truncatePathMiddle("/home/shant/projects/some/deeply/nested/folder/structure/final-dir/notes.txt", 44);
    expect(out.length).toBeLessThanOrEqual(44);
    expect(out.startsWith("/home/shant/")).toBe(true);
    expect(out.endsWith("/notes.txt")).toBe(true);
  });
  it("keeps the beginning and extension of a very long final component", () => {
    const name = `${"quarterly-financial-summary-".repeat(5)}.xlsx`;
    const out = truncatePathMiddle(`C:\\Users\\shant\\docs\\${name}`, 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.endsWith(".xlsx")).toBe(true);
    expect(out).toContain("…");
  });
  it("shortens a single long name that has no directories", () => {
    const out = truncatePathMiddle(`${"x".repeat(80)}.md`, 30);
    expect(out.length).toBeLessThanOrEqual(30);
    expect(out.endsWith(".md")).toBe(true);
  });
  it("never modifies its input", () => {
    const path = "C:\\Users\\shant\\.openmausbot\\task-workspaces\\x\\y\\z\\file-with-a-long-name.md";
    const copy = `${path}`;
    truncatePathMiddle(path, 30);
    expect(path).toBe(copy);
  });
});
