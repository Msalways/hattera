// The handful of outward links the app offers from the profile menu and the
// About dialog. They are collected here so "where does Help go?" has one
// answer rather than one per call site.
export const APP_NAME = "Hattera";
export const APP_REPOSITORY = "https://github.com/Msalways/hattera";
export const HATTERA_REPOSITORY = "https://github.com/Msalways/hattera";
export const HATTERA_DOCS_URL = `${HATTERA_REPOSITORY}/tree/main/apps/docs/content/docs`;
export const HATTERA_FEEDBACK_URL = `${HATTERA_REPOSITORY}/issues`;
export function repositoryGuide(path: string): string {
  return `${typeof window !== "undefined" && window.ogb?.platform ? APP_REPOSITORY : HATTERA_REPOSITORY}/blob/main/docs/${path}`;
}
/** The docs tree is the help centre, and it is where openmausbot.com sends
 * people too — one destination, not two competing ones. */
export const DOCS_URL = `${APP_REPOSITORY}/tree/main/docs`;
export const HELP_CENTER_URL = DOCS_URL;
export const APPROVAL_LEVELS_URL = `${APP_REPOSITORY}/blob/main/docs/approval-levels.md`;
/** Feedback goes to the community rather than the issue tracker: most of it
 * is a question or a "does anyone else see this", and those get an answer in
 * Discord in minutes instead of sitting open as an issue. */
export const FEEDBACK_URL = `${APP_REPOSITORY}/issues`;
export const RELEASES_URL = `${APP_REPOSITORY}/releases`;
/** Every Hattera Cloud plan side by side (Personal, Pro, Max). */
export const PRICING_URL = `${APP_REPOSITORY}#project-status`;
/** A link to the website or the Cloud page, tagged with where in the app it
 * was opened (`src`, one of lib/cloud-plan's sources), for the counts. */
export function withSource(url: string, source: string): string {
  const target = new URL(url);
  target.searchParams.set("src", source);
  return target.href;
}
export const LICENSE_URL = `${APP_REPOSITORY}/blob/main/LICENSE`;
/** The version Vite inlined from package.json; "dev" when the define is
 * missing (a bare `tsc`/test run outside the bundler). */
export function appVersion(): string {
  return typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
}

const PLATFORM_NAMES: Record<string, string> = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
};

/** "macOS", "Windows", "Linux" — or nothing at all in the browser, where the
 * host OS is not ours to claim. */
export function platformLabel(platform?: string): string | null {
  return (platform && PLATFORM_NAMES[platform]) ?? null;
}

/** Hands a link to the default browser through the preload bridge, falling
 * back to a new tab when the app runs in a plain browser. */
export async function openExternalLink(url: string): Promise<void> {
  if (window.ogb?.openExternal) {
    await window.ogb.openExternal(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
