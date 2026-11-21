// What Hattera knows about each configured engine instance: availability and
// sign-in, models, and allowance windows, every fact with its source and time.
// Read-only over what the registry and the allowance report already read; it
// writes nothing and names no provider. Admin scope by default, like every
// route not opened to clients (server/request-auth.ts).
//
// GET /api/awareness            (add ?refresh=1 to bypass the allowance cache)
import { assembleAwareness, type AwarenessInstanceInput } from "../awareness/assemble.ts";
import type { PlanProviderRow, PlanUsageReport } from "../awareness/allowance-kit.ts";
import type { ModelCatalog, ProviderSnapshot } from "../contracts.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface AwarenessRouteDeps {
  /** The live instances, as the registry describes them. */
  describe(): Promise<ReadonlyArray<{
    instanceId: string;
    driverKind: string;
    displayName: string;
    /** How the instance is reached (subscription, api, custom), when the registry says. */
    access?: string;
    snapshot: ProviderSnapshot;
    models: ModelCatalog;
  }>>;
  /** Allowance rows for the instances whose driver reports allowance. */
  allowance(refresh: boolean): Promise<PlanUsageReport>;
  now?(): number;
}

export function createAwarenessRoutes(deps: AwarenessRouteDeps): RouteHandler {
  return async ({ res, url, path, method, json }) => {
    if (!(method === "GET" && path === "/api/awareness")) return PASS;
    const now = deps.now?.() ?? Date.now();
    const observedAt = new Date(now).toISOString();
    const refresh = url.searchParams.get("refresh") === "1";
    const [described, allowance] = await Promise.all([
      deps.describe(),
      // An allowance failure leaves allowance unknown; it never fails the view.
      deps.allowance(refresh).catch((): PlanUsageReport => ({ fetchedAt: observedAt, providers: [] })),
    ]);
    const rows = new Map<string, PlanProviderRow>(allowance.providers.map((row) => [row.id, row]));
    const instances: AwarenessInstanceInput[] = described.map((instance) => ({
      instanceId: instance.instanceId,
      driverKind: instance.driverKind,
      displayName: instance.displayName,
      access: instance.access ?? null,
      snapshot: instance.snapshot,
      snapshotObservedAt: observedAt,
      models: instance.models,
      modelsObservedAt: observedAt,
      allowance: rows.get(instance.instanceId) ?? null,
      allowanceObservedAt: allowance.fetchedAt,
    }));
    res.setHeader("cache-control", "no-store");
    return json(res, 200, assembleAwareness({ instances, now }));
  };
}
