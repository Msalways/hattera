// Shared vocabulary for driver allowance reporting: the types and pure helpers
// every driver's usage parser is built from. Nothing here names a provider; a
// driver describes itself by exporting an AllowanceCapability.
export interface PlanWindow {
  available: boolean;
  remainingPercent: number | null;
  usedPercent: number | null;
  resetsAt: string | null;
}

export interface PlanExtra {
  label: string;
  remainingPercent: number;
  usedPercent: number;
  resetsAt: string | null;
}

/** A model- or product-scoped slice of the plan. `windows` are that slice's
 * own 5-hour, weekly, or other allowance — not a share of the account total. */
export interface PlanModelUsage {
  name: string;
  windows: PlanExtra[];
}

export interface PlanWindows {
  plan: string | null;
  fiveHour: PlanWindow;
  weekly: PlanWindow;
  extra: PlanExtra[];
  models: PlanModelUsage[];
}

export interface PlanProviderRow {
  id: string;
  name: string;
  driver: string;
  plan: string | null;
  ok: boolean;
  error: string | null;
  fiveHour: PlanWindow;
  weekly: PlanWindow;
  extra: PlanExtra[];
  models: PlanModelUsage[];
}

export interface PlanUsageReport {
  fetchedAt: string;
  providers: PlanProviderRow[];
}

export interface PlanAccount {
  id: string;
  name: string;
  driver: string;
  environment: Record<string, string | undefined>;
  configDir?: string;
}

export interface PlanCredential {
  token: string | null;
  accountId: string | null;
  expired: boolean;
}

export interface CredentialReader {
  read(account: PlanAccount): PlanCredential | Promise<PlanCredential>;
}

export interface PlanResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type PlanFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<PlanResponse>;

/** driverKind -> allowance capability, for the drivers that report one. */
export type AllowanceRegistry = ReadonlyMap<string, AllowanceCapability>;

export interface PlanUsageDeps {
  fetch: PlanFetch;
  /** Which drivers report allowance. Defaults to the built-in drivers. */
  capabilities?: AllowanceRegistry;
  credentials: CredentialReader;
  now?: () => number;
  timeoutMs?: number;
}

export interface CredentialSource {
  readText: (path: string) => string | null;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** macOS login keychain, read-only. Tests inject this so `security` is never spawned. */
  readClaudeKeychain?: (service: string) => string | null | Promise<string | null>;
}

export const PROVIDER_TIMEOUT_MS = 8_000;

export const CREDENTIAL_READ_MAX_BYTES = 1_000_000;

export const FIVE_HOUR_MIN_SECONDS = 3 * 3600;

export const FIVE_HOUR_MAX_SECONDS = 8 * 3600;

export const WEEK_MIN_SECONDS = 5 * 86400;

export const WEEK_MAX_SECONDS = 9 * 86400;

export const MONTH_MIN_SECONDS = 27 * 86400;

export const MONTH_MAX_SECONDS = 32 * 86400;

export function closedWindow(): PlanWindow {
  return { available: false, remainingPercent: null, usedPercent: null, resetsAt: null };
}

export function openWindow(usedPercent: number, resetsAt: string | null): PlanWindow {
  const used = clampPercent(usedPercent);
  return {
    available: true,
    usedPercent: used,
    remainingPercent: clampPercent(100 - used),
    resetsAt,
  };
}

export function extraLine(label: string, window: PlanWindow): PlanExtra {
  return {
    label,
    remainingPercent: window.remainingPercent ?? 0,
    usedPercent: window.usedPercent ?? 0,
    resetsAt: window.resetsAt,
  };
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function finiteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

export function timeMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.abs(value) >= 1e12 ? value : value * 1000;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 80) return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return timeMs(Number(trimmed));
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isoOrNull(value: unknown): string | null {
  const ms = timeMs(value);
  if (ms == null) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function planLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 80 || /[\r\n]/.test(trimmed)) return null;
  if (/bearer\s|access_token|refresh_token|sk-ant-|eyJ[a-zA-Z0-9_-]{8,}/i.test(trimmed)) return null;
  return trimmed;
}

export function secretString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 16_000 || /[\r\n]/.test(trimmed)) return null;
  return trimmed;
}

export function parseJson(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export function missingCredential(): PlanCredential {
  return { token: null, accountId: null, expired: false };
}

export function expiredCredential(): PlanCredential {
  return { token: null, accountId: null, expired: true };
}

export function addModelWindow(models: PlanModelUsage[], name: string, line: PlanExtra): void {
  const found = models.find((model) => model.name.toLowerCase() === name.toLowerCase());
  if (found) found.windows.push(line);
  else models.push({ name, windows: [line] });
}

export function sortModelWindows(models: PlanModelUsage[]): void {
  const rank = (label: string) => (label === "5-hour" ? 0 : label === "Weekly" ? 1 : 2);
  for (const model of models) model.windows.sort((a, b) => rank(a.label) - rank(b.label));
}

export interface DurationWindow {
  used: number;
  seconds: number;
  resetsAt: string | null;
}

export function readDurationWindow(value: unknown): DurationWindow | null {
  const record = asRecord(value);
  if (!record) return null;
  const used = finiteNumber(record.used_percent);
  let seconds = finiteNumber(record.limit_window_seconds);
  if (seconds == null) {
    const minutes = finiteNumber(record.window_minutes);
    if (minutes != null) seconds = minutes * 60;
  }
  if (used == null || seconds == null || seconds <= 0) return null;
  return { used, seconds, resetsAt: isoOrNull(record.reset_at ?? record.resetAt) };
}

/** Primary and secondary windows, or one flat window when those keys are absent. */
export function durationWindows(node: unknown): DurationWindow[] {
  const record = asRecord(node);
  if (!record) return [];
  const source = asRecord(record.rate_limit) ?? record;
  const windows: DurationWindow[] = [];
  for (const key of ["primary_window", "secondary_window"]) {
    const window = readDurationWindow(source[key]);
    if (window) windows.push(window);
  }
  if (windows.length === 0) {
    const self = readDurationWindow(source);
    if (self) windows.push(self);
  }
  return windows;
}

export function durationLabel(seconds: number): string {
  if (seconds >= 86400) return `${Math.max(1, Math.round(seconds / 86400))}-day`;
  if (seconds >= 3600) return `${Math.max(1, Math.round(seconds / 3600))}-hour`;
  return `${Math.max(1, Math.round(seconds / 60))}-minute`;
}

export function assignDurationWindows(windows: DurationWindow[]): PlanWindows {
  let fiveHour = closedWindow();
  let weekly = closedWindow();
  const extra: PlanExtra[] = [];
  for (const window of windows) {
    const open = openWindow(window.used, window.resetsAt);
    const fiveHourSlot = window.seconds >= FIVE_HOUR_MIN_SECONDS && window.seconds <= FIVE_HOUR_MAX_SECONDS;
    const weeklySlot = window.seconds >= WEEK_MIN_SECONDS && window.seconds <= WEEK_MAX_SECONDS;
    if (fiveHourSlot && !fiveHour.available) fiveHour = open;
    else if (weeklySlot && !weekly.available) weekly = open;
    else extra.push(extraLine(durationLabel(window.seconds), open));
  }
  return { plan: null, fiveHour, weekly, extra, models: [] };
}

export function pushAssignedLines(assigned: PlanWindows, into: PlanExtra[]): void {
  if (assigned.fiveHour.available) into.push(extraLine("5-hour", assigned.fiveHour));
  if (assigned.weekly.available) into.push(extraLine("Weekly", assigned.weekly));
  into.push(...assigned.extra);
}

export interface HttpResult {
  status: number;
  ok: boolean;
  body: unknown;
}

export async function fetchJson(
  fetchImpl: PlanFetch,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<HttpResult> {
  try {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    let text = "";
    try {
      text = await response.text();
    } catch {
      text = "";
    }
    let body: unknown = null;
    if (text.trim()) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = null;
      }
    }
    return { status: response.status, ok: response.ok, body };
  } catch {
    return { status: 0, ok: false, body: null };
  }
}

export function authRejected(status: number): boolean {
  return status === 401 || status === 403;
}

export function errorRow(account: PlanAccount, error: string): PlanProviderRow {
  return {
    id: account.id,
    name: account.name,
    driver: account.driver,
    plan: null,
    ok: false,
    error,
    fiveHour: closedWindow(),
    weekly: closedWindow(),
    extra: [],
    models: [],
  };
}

export function okRow(account: PlanAccount, windows: PlanWindows): PlanProviderRow {
  return {
    id: account.id,
    name: account.name,
    driver: account.driver,
    plan: windows.plan,
    ok: true,
    error: null,
    fiveHour: windows.fiveHour,
    weekly: windows.weekly,
    extra: windows.extra,
    models: windows.models,
  };
}

/** What a driver adds to report subscription allowance windows. Optional: a
 * driver without it is simply not listed by plan-usage or the awareness view. */
export interface AllowanceCapability {
  /** Stable id carried on PlanAccount.driver and PlanProviderRow.driver. */
  readonly id: string;
  /** Product name shown when an instance has no display name. */
  readonly product: string;
  /** Extra credential-source facilities this driver wants by default (e.g. an
   * OS keychain reader). Merged into defaultCredentialReader. */
  defaultSource?(): Partial<CredentialSource>;
  /** Read the sign-in this driver's usage endpoint needs. `env` already has the
   * instance environment merged in. */
  readCredential(
    account: PlanAccount,
    env: NodeJS.ProcessEnv,
    source: CredentialSource,
    now: number,
  ): Promise<PlanCredential> | PlanCredential;
  /** Fetch and parse usage into a row. May throw; the caller turns that into
   * a "could not reach" row. */
  fetchUsage(account: PlanAccount, credential: PlanCredential, deps: PlanUsageDeps): Promise<PlanProviderRow>;
}

export function signInAgain(product: string): string {
  return `Sign in again in ${product}`;
}

export function couldNotReach(product: string): string {
  return `Could not reach ${product}`;
}

export function unexpectedUsage(product: string): string {
  return `${product} returned an unexpected usage response`;
}
