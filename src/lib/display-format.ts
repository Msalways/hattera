// Display-only formatters (RC-3). They turn stored values into what a person
// reads: dates, durations, reset times, model names and paths. They never
// change the value they were given — execution, storage, copy and export keep
// using the original — and they never throw: a missing or invalid value reads
// as "Unavailable" (or the reset-specific equivalent) instead of "Invalid Date".
import { activeLocale, t } from "./i18n";

export interface FormatOptions {
  /** BCP 47 tag; defaults to the language the app is showing. */
  locale?: string;
  /** Clock for "now"; defaults to Date.now(). Tests pass a fixed value. */
  now?: number;
  /** IANA zone; defaults to the device zone. Tests pass a fixed zone. */
  timeZone?: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Epoch ms for a Date, number, or date string; null when it is not a real instant. */
export function toTimestamp(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function localeOf(options?: FormatOptions): string {
  return options?.locale ?? activeLocale();
}

/** Year-month-day of an instant in the requested (or device) zone. */
function dayParts(ms: number, timeZone?: string): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(ms);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

/** Whole calendar days from `now`'s day to `ms`'s day (+1 = tomorrow, -1 = yesterday). */
function calendarDayOffset(ms: number, now: number, timeZone?: string): number {
  const a = dayParts(ms, timeZone);
  const b = dayParts(now, timeZone);
  return Math.round((Date.UTC(a.y, a.m - 1, a.d) - Date.UTC(b.y, b.m - 1, b.d)) / 86_400_000);
}

function capitalize(text: string, locale: string): string {
  return text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);
}

function clockTime(ms: number, locale: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, { timeStyle: "short", timeZone }).format(ms);
}

/** "Nov 26", or "Nov 26, 2025" when the year is not the current one. */
function calendarDate(ms: number, now: number, locale: string, timeZone?: string): string {
  const sameYear = dayParts(ms, timeZone).y === dayParts(now, timeZone).y;
  return new Intl.DateTimeFormat(locale, sameYear ? { month: "short", day: "numeric", timeZone } : { year: "numeric", month: "short", day: "numeric", timeZone }).format(ms);
}

/** The complete date, time and time zone: what focus, a tooltip or screen-reader
 * detail shows next to a shortened value. "Unavailable" when invalid. */
export function formatFullDateTime(value: unknown, options?: FormatOptions): string {
  const ms = toTimestamp(value);
  if (ms === null) return t("format.unavailable");
  return new Intl.DateTimeFormat(localeOf(options), { dateStyle: "full", timeStyle: "long", timeZone: options?.timeZone }).format(ms);
}

/** "Just now", "1 minute ago", "2 hours ago", "Yesterday", then a localized
 * date (with the year when it differs); a future instant reads "in 5 minutes".
 * Missing or invalid is "Unavailable". */
export function formatRelativeDate(value: unknown, options?: FormatOptions): string {
  const ms = toTimestamp(value);
  if (ms === null) return t("format.unavailable");
  const locale = localeOf(options);
  const now = options?.now ?? Date.now();
  const diff = now - ms;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "always", style: "long" });
  if (diff < 0) {
    const ahead = -diff;
    if (ahead < HOUR) return rtf.format(Math.max(1, Math.ceil(ahead / MINUTE)), "minute");
    if (ahead < 24 * HOUR) return rtf.format(Math.ceil(ahead / HOUR), "hour");
    return rtf.format(Math.max(1, calendarDayOffset(ms, now, options?.timeZone)), "day");
  }
  if (diff < MINUTE) return t("format.justNow");
  if (diff < HOUR) return rtf.format(-Math.floor(diff / MINUTE), "minute");
  const days = calendarDayOffset(ms, now, options?.timeZone);
  if (days === 0 && diff < 24 * HOUR) return rtf.format(-Math.floor(diff / HOUR), "hour");
  if (days === -1) return capitalize(new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-1, "day"), locale);
  return calendarDate(ms, now, locale, options?.timeZone);
}

/** A duration in milliseconds as its two largest useful units: "45 sec",
 * "2 min 10 sec", "1 hr 5 min", "2 days 3 hr". Seconds are rounded, a negative
 * or tiny elapsed time reads as zero, units are localized, a zero second unit
 * is dropped. Missing or non-finite is "Unavailable". */
export function formatDuration(ms: unknown, options?: Pick<FormatOptions, "locale">): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return t("format.unavailable");
  const locale = options?.locale ?? activeLocale();
  const total = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const unit = (value: number, name: "day" | "hour" | "minute" | "second") =>
    new Intl.NumberFormat(locale, { style: "unit", unit: name, unitDisplay: "short" }).format(value);
  const ladder: Array<[number, "day" | "hour" | "minute" | "second"]> = [[days, "day"], [hours, "hour"], [minutes, "minute"], [seconds, "second"]];
  const first = ladder.findIndex(([value]) => value > 0);
  if (first === -1) return unit(0, "second");
  const parts = ladder.slice(first, first + 2).filter(([value]) => value > 0);
  return parts.map(([value, name]) => unit(value, name)).join(" ");
}

/** "Resets today at 3:30 PM", "Resets tomorrow at 3:30 PM", "Resets Nov 26 at
 * 3:30 PM" (with the year when it is not this one). Missing or invalid is
 * "Reset time unavailable". A time already past reads with its date, never "in
 * the past": callers decide whether it is expired. */
export function formatResetTime(value: unknown, options?: FormatOptions): string {
  const ms = toTimestamp(value);
  if (ms === null) return t("format.resetUnavailable");
  const locale = localeOf(options);
  const now = options?.now ?? Date.now();
  const time = clockTime(ms, locale, options?.timeZone);
  const days = calendarDayOffset(ms, now, options?.timeZone);
  if (days === 0) return t("format.resetsToday", { time });
  if (days === 1) return t("format.resetsTomorrow", { time });
  return t("format.resetsOn", { date: calendarDate(ms, now, locale, options?.timeZone), time });
}

export interface ModelDisplay {
  /** What to show. */
  label: string;
  /** The real model ID, kept for details and tooltips; never altered. */
  id: string;
}

/** Prefer the provider's own display name; otherwise the actual model ID,
 * unchanged. A version is never inferred from the ID. */
export function formatModelName(id: string | null | undefined, displayName?: string | null): ModelDisplay {
  const realId = typeof id === "string" ? id : "";
  const provided = typeof displayName === "string" ? displayName.trim() : "";
  return { label: provided || realId, id: realId };
}

const ELLIPSIS = "…";

function splitExtension(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf(".");
  // A leading dot (".env") or a very long "extension" is part of the name.
  if (dot <= 0 || name.length - dot > 12) return { stem: name, ext: "" };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

/** Middle-truncate a path to `max` characters, keeping the root and context at
 * the front and the identifying end: `C:\Users\shant\…\task-workspaces\report.md`.
 * A final component that is itself too long keeps its beginning and its
 * extension. The input is never modified; a path that fits comes back as is. */
export function truncatePathMiddle(path: string | null | undefined, max = 48): string {
  if (typeof path !== "string" || path === "") return "";
  const limit = Math.max(8, Math.floor(max));
  if (path.length <= limit) return path;
  const sep = path.includes("\\") && !path.includes("/") ? "\\" : path.includes("\\") && path.lastIndexOf("\\") > path.lastIndexOf("/") ? "\\" : "/";
  const segments = path.split(sep);
  const last = segments[segments.length - 1] ?? "";
  // No directory structure to keep: shorten the one component.
  if (segments.length < 3 || (segments.length === 2 && segments[0] === "")) return shortenName(path, limit);
  // Root plus its first two context segments ("C:\Users\shant", "/home/shant"),
  // fewer when the final component needs the room.
  const rooted = segments[0] === "" || segments[0]!.endsWith(":");
  let headCount = Math.min(rooted ? 3 : 1, segments.length - 1);
  while (headCount > 1 && [...segments.slice(0, headCount), ELLIPSIS, last].join(sep).length > limit) headCount--;
  const head = segments.slice(0, headCount);
  const tail: string[] = [last];
  const build = () => [...head, ELLIPSIS, ...tail].join(sep);
  let candidate = build();
  // Grow the tail with the parent directories that still fit (the identifying end).
  for (let i = segments.length - 2; i >= head.length; i--) {
    const trial = [...head, ELLIPSIS, segments[i]!, ...tail].join(sep);
    if (trial.length > limit) break;
    tail.unshift(segments[i]!);
    candidate = build();
  }
  if (candidate.length <= limit) return candidate;
  // Even root + ellipsis + final component is too long: shorten the final component.
  const prefix = [...head, ELLIPSIS].join(sep) + sep;
  const room = limit - prefix.length;
  return room >= 6 ? prefix + shortenName(last, room) : shortenName(path, limit);
}

/** Keep the beginning and the extension of one long name. */
function shortenName(name: string, max: number): string {
  if (name.length <= max) return name;
  const { stem, ext } = splitExtension(name);
  const keep = max - ext.length - ELLIPSIS.length;
  if (keep < 3) return name.slice(0, Math.max(1, max - ELLIPSIS.length)) + ELLIPSIS;
  return stem.slice(0, keep) + ELLIPSIS + ext;
}
