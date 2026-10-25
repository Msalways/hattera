import { z } from "zod";
import type { CollaborationService } from "../collaboration-service.ts";
import type { CollaborationGroups } from "../collaboration-groups.ts";
import type { Store } from "../store.ts";
import { PASS, type RouteHandler } from "./table.ts";
import type { CollaborationExecution } from "../collaboration-execution.ts";

export function createCollaborationRoutes(service: CollaborationService, groups: CollaborationGroups, store: Store, allowed: () => string | null, execution?: CollaborationExecution): RouteHandler {
  return async ({ path, method, req, res, json, readBody, auth }) => {
    if (!path.startsWith("/api/collaboration")) return PASS;
    res.setHeader("cache-control", "no-store");
    if (!auth.scopes.includes("admin")) return json(res, 403, { error: "Only this installation's administrator can choose groups to share." });
    const refusal = allowed();
    if (refusal) return json(res, 403, { error: refusal });
    if (path === "/api/collaboration" && method === "GET") return json(res, 200, { groups: service.status(), ...(service.error ? { error: service.error } : {}) });
    try {
      const target = /^\/api\/collaboration\/([\da-f-]{36})\/execution(?:\/(grants|revoke|requests|decide|cancel))?$/.exec(path);
      if (target && execution) {
        const groupId = z.string().uuid().parse(target[1]);
        if (method === "GET" && !target[2]) return json(res, 200, await execution.status(groupId));
        if (method !== "POST") return json(res, 405, { error: "Use POST for shared execution actions." });
        const raw = await readBody(req, 24_000);
        if (target[2] === "grants") {
          const input = z.object({ botId: z.string().min(1).max(100), label: z.string().trim().min(1).max(160),
            members: z.array(z.string().min(1).max(100)).min(1).max(200), approval: z.boolean(), acknowledge: z.literal(true) }).strict().parse(raw);
          const { acknowledge: _acknowledge, ...grant } = input;
          return json(res, 201, { id: await execution.grant({ ...grant, groupId }) });
        }
        if (target[2] === "requests") {
          const input = z.object({ id: z.string().uuid(), ownerKey: z.string().min(1).max(100), targetId: z.string().uuid(), text: z.string().trim().min(1).max(16_000) }).strict().parse(raw);
          return json(res, 202, { job: await execution.request({ ...input, groupId }) });
        }
        if (target[2] === "decide") {
          const input = z.object({ id: z.string().uuid(), allow: z.boolean() }).strict().parse(raw);
          await execution.decide(groupId, input.id, input.allow); return json(res, 200, { ok: true });
        }
        if (target[2] === "cancel") {
          const input = z.object({ id: z.string().uuid(), incoming: z.boolean() }).strict().parse(raw);
          await execution.cancel(groupId, input.id, input.incoming); return json(res, 200, { ok: true });
        }
        if (target[2] === "revoke") {
          const input = z.object({ id: z.string().uuid() }).strict().parse(raw);
          execution.revoke(groupId, input.id); return json(res, 200, { ok: true });
        }
        return json(res, 404, { error: "Unknown execution action." });
      }
      if (method !== "POST") return json(res, 404, { error: "Shared group action not found." });
      const body = await readBody(req, 8192);
      const names = { localGroupId: z.string().regex(/^[\w-]{1,100}$/), memberName: z.string().trim().min(1).max(120) };
      if (path === "/api/collaboration/share" || path === "/api/collaboration/join") {
        const input = (path.endsWith("/share") ? z.object({ ...names, includeHistory: z.boolean() }).strict()
          : z.object({ ...names, invitation: z.string().min(1).max(4096) }).strict()).parse(body);
        const group = store.group(input.localGroupId);
        if (!group || group.dm) return json(res, 404, { error: "Choose a local group to share." });
        const binding = service.status().find(value => value.localGroupId === group.id);
        // Portable history may retain its former group reference; its private
        // membership is deliberately not restored onto this installation.
        if (binding && !("invitation" in input && binding.joining)) return json(res, 409, { error: "This group already has a sharing identity." });
        const groupId = "invitation" in input
          ? await service.join(input.invitation, group.id, input.memberName)
          : await service.share(group.id, group.name, input.memberName, input.includeHistory);
        store.patchGroup(group.id, { sharedGroupId: groupId, setupCompletedAt: Date.now() });
        groups.recover(); service.start();
        return json(res, 202, { groupId, groups: service.status() });
      }
      if (path === "/api/collaboration/invite") {
        const input = z.object({ groupId: z.string().uuid(), role: z.enum(["member", "manager"]) }).strict().parse(body);
        return json(res, 200, { invitation: await service.invite(input.groupId, input.role), expiresInSeconds: 300 });
      }
      if (path === "/api/collaboration/enabled") {
        const input = z.object({ groupId: z.string().uuid(), enabled: z.boolean() }).strict().parse(body);
        service.setEnabled(input.groupId, input.enabled); if (input.enabled) { groups.recover(); service.start(); }
        return json(res, 200, { groups: service.status() });
      }
      if (path === "/api/collaboration/revoke") {
        const input = z.object({ groupId: z.string().uuid(), grantId: z.string().uuid() }).strict().parse(body);
        service.revoke(input.groupId, input.grantId); return json(res, 200, { groups: service.status() });
      }
      return json(res, 404, { error: "Shared group action not found." });
    } catch (error) {
      return json(res, error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 409,
        { error: error instanceof z.ZodError || error instanceof SyntaxError ? "Check the shared group details and invitation." : error instanceof Error ? error.message : "The shared group action could not finish." });
    }
  };
}
