import { z } from "zod";

const id = z.string().uuid();
const publicKey = z.string().regex(/^[A-Za-z0-9+/]{59}=$/);
const signature = z.string().regex(/^[A-Za-z0-9+/]{86}==$/);
const label = z.string().trim().min(1).max(120).refine(value => !/[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(value));
const reference = z.string().regex(/^[\w-]{1,100}$/);
const sequence = z.number().int().nonnegative().max(1_000_000_000);
export const collaborationCursors = z.record(z.string().regex(/^[\da-f-]{36}\/(?:control|content)$/i), sequence).refine(value => Object.keys(value).length <= 400);

export const joinProposalSchema = z.object({
  groupId: id, invitationId: id, publicKey, encryptionKey: publicKey, name: label,
  endpoint: z.string().url().max(200), at: z.number().int().positive(), nonce: id,
}).strict();

export const collaborationPayload = z.discriminatedUnion("type", [
  z.object({ type: z.literal("group.created"), name: label, nameOfCreator: label, encryptionKey: publicKey, endpoint: z.string().url().max(200) }).strict(),
  z.object({ type: z.literal("member.added"), grantId: id, role: z.enum(["member", "manager"]),
    proposal: joinProposalSchema, consent: signature }).strict(),
  z.object({ type: z.literal("member.revoked"), grantId: id, cutoffs: collaborationCursors }).strict(),
  z.object({ type: z.literal("member.address"), endpoint: z.string().url().max(200) }).strict(),
  z.object({ type: z.literal("bots.catalog"), bots: z.array(z.object({ id: reference, name: label, title: z.string().max(200), color: z.string().max(30) }).strict()).max(100) }).strict(),
  z.object({ type: z.literal("message.upsert"), topicId: reference, topicTitle: z.string().max(80), messageId: reference,
    text: z.string().max(64_000), role: z.enum(["human", "bot"]), authorLabel: label,
    replyTo: z.object({ grantId: id, messageId: reference }).strict().optional(),
  }).strict(),
  z.object({ type: z.literal("task.assignment"), taskId: reference, assignmentId: id,
    supersedes: z.array(id).max(32), assignee: publicKey.nullable() }).strict(),
]);

export const collaborationEventBody = z.object({
  version: z.literal(1), groupId: id, grantId: id, origin: publicKey, sequence: sequence.refine(value => value > 0),
  stream: z.enum(["control", "content"]),
  previous: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  lamport: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), at: z.number().int().positive(), payload: collaborationPayload,
}).strict();
export const collaborationEventSchema = collaborationEventBody.extend({
  id: z.string().regex(/^[a-f0-9]{64}$/), signature,
}).strict();
export type CollaborationEvent = z.infer<typeof collaborationEventSchema>;
export type CollaborationPayload = z.infer<typeof collaborationPayload>;
export type JoinProposal = z.infer<typeof joinProposalSchema>;

export interface CollaborationMember {
  grantId: string;
  publicKey: string;
  encryptionKey: string;
  name: string;
  endpoint: string;
  role: "member" | "manager";
  parent: string | null;
  active: boolean;
  lastContactAt?: number;
}

export interface SharedGroupStatus {
  groupId: string;
  name: string;
  localGroupId: string;
  enabled: boolean;
  joining?: boolean;
  blocked?: boolean;
  localPublicKey: string;
  bots: Array<{ origin: string; id: string; name: string; title: string; color: string }>;
  members: CollaborationMember[];
  pending: number;
  lastSyncedAt?: number;
  error?: string;
}
