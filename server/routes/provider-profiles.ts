import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { InstanceConfig, InstanceConfigMap } from "../contracts.ts";
import { newProviderProfile } from "../provider-profiles.ts";
import { PASS, type RouteHandler } from "./table.ts";

const input = z.object({
  displayName: z.string().trim().min(1).max(80).refine(value => !/[\p{Cc}\p{Cf}]/u.test(value)),
  sourceInstanceId: z.string().min(1).max(200),
}).strict();

export function createProviderProfileRoutes(deps: {
  dataDir: string;
  instances(): InstanceConfigMap;
  source?(id: string): InstanceConfig | undefined;
  describe(): Promise<Array<{ instanceId: string; readOnly?: boolean }>>;
  persist(id: string, entries: InstanceConfigMap): Promise<void>;
  exclusive<T>(work: () => Promise<T>): Promise<T> | null;
}): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== "/api/instances/accounts" || method !== "POST") return PASS;
    if (!auth.scopes.includes("admin")) return json(res, 403, { error: "Only this installation's administrator can add provider accounts." });
    if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return json(res, 415, { error: "content-type must be application/json" });
    const parsed = input.safeParse(await readBody(req, 8192));
    if (!parsed.success) return json(res, 400, { error: "Enter an account name (up to 80 characters) and select a provider." });
    const answer = deps.exclusive(async () => {
      const entries = deps.instances();
      const source = deps.source ? deps.source(parsed.data.sourceInstanceId) : entries[parsed.data.sourceInstanceId];
      const described = (await deps.describe()).find(entry => entry.instanceId === parsed.data.sourceInstanceId);
      if (!source || !described) return json(res, 404, { error: "This provider is no longer available. Refresh and try again." });
      if (described.readOnly) return json(res, 403, { error: "Managed provider accounts cannot be copied." });
      let entry;
      try { entry = newProviderProfile(source, parsed.data.displayName); }
      catch (error) { return json(res, 400, { error: error instanceof Error ? error.message : "This provider cannot create an independent account." }); }
      const instanceId = `account-${randomUUID()}`;
      mkdirSync(join(deps.dataDir, "providers", "accounts", instanceId, "home"), { recursive: true, mode: 0o700 });
      entries[instanceId] = entry;
      await deps.persist(instanceId, entries);
      res.setHeader("cache-control", "no-store");
      return json(res, 201, { instanceId, instances: await deps.describe() });
    });
    if (!answer) return json(res, 409, { error: "Provider settings are already being updated. Try again shortly." });
    return answer;
  };
}
