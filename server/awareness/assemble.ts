// Model Awareness Registry v1: what Hattera knows about each configured engine
// instance — whether it is available and signed in, which models it offers and
// what is known of them, and the allowance windows it reports. Pure: callers
// pass in what they read (snapshots, catalogs, allowance rows) and when. No
// provider or model is named here; a driver that reports more simply fills in
// more fields and this view shows them.
import type { ModelCatalog, ProviderSnapshot } from "../contracts.ts";
import type { PlanProviderRow, PlanWindow } from "./allowance-kit.ts";
import { known, unknown, type Fact } from "./facts.ts";

export const DEFAULT_STALE_AFTER_MS = 10 * 60_000;

/** Optional facts a catalog row may carry beyond the base contract. Read
 * structurally, so a driver that starts reporting them needs no change here. */
interface ModelRowFacts {
  contextWindow?: unknown;
  modalities?: unknown;
  cost?: unknown;
  variants?: unknown;
}

export interface AwarenessInstanceInput {
  instanceId: string;
  driverKind: string;
  displayName: string;
  /** null/absent: never read. */
  snapshot?: ProviderSnapshot | null;
  snapshotObservedAt?: string | null;
  models?: ModelCatalog | null;
  modelsObservedAt?: string | null;
  /** The allowance row for this instance; absent when its driver reports none. */
  allowance?: PlanProviderRow | null;
  allowanceObservedAt?: string | null;
}

export interface AllowanceWindowView {
  id: string;
  label: string;
  /** "account" for the plan's own windows; "model" for a model-scoped slice;
   * "extra" for any other named window. */
  scope: "account" | "model" | "extra";
  /** Set for scope "model". */
  model?: string;
  remainingPercent: number | null;
  usedPercent: number | null;
  resetsAt: string | null;
}

export interface ModelAwareness {
  id: string;
  label: string;
  contextWindow: Fact<number>;
  modalities: Fact<string[]>;
  reasoning: Fact<string[]>;
  cost: Fact<unknown>;
}

export interface InstanceAwareness {
  instanceId: string;
  driverKind: string;
  displayName: string;
  availability: Fact<"available" | "unavailable">;
  authenticated: Fact<boolean>;
  models: ModelAwareness[];
  defaultModel: Fact<string>;
  allowance: Fact<{ plan: string | null; windows: AllowanceWindowView[] }>;
}

export interface AwarenessReport {
  generatedAt: string;
  staleAfterMs: number;
  instances: InstanceAwareness[];
}

const SNAPSHOT_SOURCE = "provider-snapshot";
const CATALOG_SOURCE = "driver-model-catalog";
const ALLOWANCE_SOURCE = "allowance-report";

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return out.length === value.length && out.length > 0 ? out : null;
}

function variantIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.flatMap((entry) => {
    const id = (entry as { id?: unknown } | null)?.id;
    return typeof id === "string" && id ? [id] : [];
  });
  return ids.length ? ids : null;
}

function modelAwareness(
  option: ModelCatalog["options"][number],
  observedAt: string | null,
  now: number,
  staleAfterMs: number,
): ModelAwareness {
  const facts = option as ModelRowFacts;
  const fact = <T,>(value: T | null): Fact<T> =>
    value !== null && observedAt ? known(value, CATALOG_SOURCE, observedAt, now, staleAfterMs) : unknown(observedAt ? CATALOG_SOURCE : "none", observedAt);
  return {
    id: option.id,
    label: option.label,
    contextWindow: fact(positiveNumber(facts.contextWindow)),
    modalities: fact(stringList(facts.modalities)),
    reasoning: fact(variantIds(facts.variants)),
    cost: fact(facts.cost ?? null),
  };
}

function windowView(
  id: string,
  label: string,
  scope: AllowanceWindowView["scope"],
  window: Pick<PlanWindow, "remainingPercent" | "usedPercent" | "resetsAt">,
  model?: string,
): AllowanceWindowView {
  return {
    id,
    label,
    scope,
    ...(model ? { model } : {}),
    remainingPercent: window.remainingPercent,
    usedPercent: window.usedPercent,
    resetsAt: window.resetsAt,
  };
}

function allowanceWindows(row: PlanProviderRow): AllowanceWindowView[] {
  const windows: AllowanceWindowView[] = [];
  if (row.fiveHour.available) windows.push(windowView("five-hour", "5 hours", "account", row.fiveHour));
  if (row.weekly.available) windows.push(windowView("weekly", "Weekly", "account", row.weekly));
  for (const extra of row.extra) windows.push(windowView(`extra:${extra.label}`, extra.label, "extra", extra));
  for (const model of row.models) {
    for (const line of model.windows) {
      windows.push(windowView(`model:${model.name}:${line.label}`, line.label, "model", line, model.name));
    }
  }
  return windows;
}

function allowanceFact(
  input: AwarenessInstanceInput,
  now: number,
  staleAfterMs: number,
): InstanceAwareness["allowance"] {
  const row = input.allowance;
  if (!row) return unknown();
  const observedAt = input.allowanceObservedAt ?? null;
  if (!row.ok) return unknown(ALLOWANCE_SOURCE, observedAt, row.error ?? "Allowance could not be read");
  if (!observedAt) return unknown(ALLOWANCE_SOURCE, null, "No observation time");
  return known({ plan: row.plan, windows: allowanceWindows(row) }, ALLOWANCE_SOURCE, observedAt, now, staleAfterMs);
}

export function assembleAwareness(input: {
  instances: readonly AwarenessInstanceInput[];
  now?: number;
  staleAfterMs?: number;
}): AwarenessReport {
  const now = input.now ?? Date.now();
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const instances = input.instances.map((entry): InstanceAwareness => {
    const snapshot = entry.snapshot ?? null;
    const snapshotAt = entry.snapshotObservedAt ?? null;
    const modelsAt = entry.modelsObservedAt ?? null;
    const catalog = entry.models ?? null;
    return {
      instanceId: entry.instanceId,
      driverKind: entry.driverKind,
      displayName: entry.displayName,
      availability: snapshot && snapshotAt
        ? known(snapshot.state, SNAPSHOT_SOURCE, snapshotAt, now, staleAfterMs)
        : unknown(snapshot ? SNAPSHOT_SOURCE : "none", snapshotAt, snapshot?.reason),
      authenticated: snapshot && snapshotAt && typeof snapshot.authenticated === "boolean"
        ? known(snapshot.authenticated, SNAPSHOT_SOURCE, snapshotAt, now, staleAfterMs)
        : unknown(snapshot ? SNAPSHOT_SOURCE : "none", snapshotAt, snapshot?.authenticationUnavailableReason),
      models: catalog ? catalog.options.map((option) => modelAwareness(option, modelsAt, now, staleAfterMs)) : [],
      defaultModel: catalog?.default && modelsAt
        ? known(catalog.default, CATALOG_SOURCE, modelsAt, now, staleAfterMs)
        : unknown(catalog ? CATALOG_SOURCE : "none", modelsAt),
      allowance: allowanceFact(entry, now, staleAfterMs),
    };
  });
  return { generatedAt: new Date(now).toISOString(), staleAfterMs, instances };
}
