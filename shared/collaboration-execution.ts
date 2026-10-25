import { z } from "zod";

const id = z.string().uuid();
const text = z.string().trim().min(1).max(16_000).refine(value => !/<(?:attached-(?:file|image)\b|(?:file|image)\b[^>\n]*\bpath\s*=|cite\b)/i.test(value), "Local attachment handles and private quotes cannot be sent to another computer.");
export const executionCommand = z.discriminatedUnion("op", [
  z.object({ op: z.literal("catalog") }).strict(),
  z.object({ op: z.literal("submit"), id, targetId: id, text }).strict(),
  z.object({ op: z.literal("read"), id }).strict(),
  z.object({ op: z.literal("cancel"), id }).strict(),
]);
export type ExecutionCommand = z.infer<typeof executionCommand>;

export const executionTarget = z.object({
  id, label: z.string().max(160), botName: z.string().max(120), account: z.string().max(160),
  driver: z.string().max(100), model: z.string().max(256),
  effort: z.string().max(100).optional(), variant: z.string().max(256).optional(),
  approval: z.boolean(), ready: z.boolean(), reason: z.string().max(300).optional(),
});
export type ExecutionTarget = z.infer<typeof executionTarget>;
export const executionJob = z.object({
  id, groupId: id, targetId: id, requester: z.string().max(120), requesterKey: z.string().max(100),
  owner: z.string().max(120), ownerKey: z.string().max(100), target: executionTarget,
  text, createdAt: z.number(), updatedAt: z.number(),
  state: z.enum(["sending", "delivery-unknown", "pending-approval", "queued", "starting", "running", "awaiting-tool-approval", "cancel-requested", "succeeded", "failed", "cancelled", "denied", "uncertain"]),
  result: z.string().max(64_000).optional(), error: z.string().max(300).optional(),
  usage: z.object({ input: z.number().nonnegative(), output: z.number().nonnegative(), cachedInput: z.number().nonnegative().optional(),
    tokensReported: z.boolean().optional(), costUsd: z.number().nullable() }).optional(),
});
export type ExecutionJob = z.infer<typeof executionJob>;
export const executionReply = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("catalog"), targets: z.array(executionTarget).max(128) }).strict(),
  z.object({ kind: z.literal("job"), job: executionJob }).strict(),
]);
export type ExecutionReply = z.infer<typeof executionReply>;
export interface ExecutionPeer {
  publicKey: string; name: string; state: "checking" | "reachable" | "unreachable";
  lastContactAt?: number; targets: ExecutionTarget[];
}
export interface ExecutionStatus {
  peers: ExecutionPeer[];
  grants: Array<ExecutionTarget & { botId: string; members: string[]; enabled: boolean }>;
  incoming: Array<ExecutionJob & { botId: string; threadId?: string }>;
  outgoing: ExecutionJob[];
  error?: string;
}
export const terminalExecution = (state: ExecutionJob["state"]) =>
  ["succeeded", "failed", "cancelled", "denied", "uncertain"].includes(state);
