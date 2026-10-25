import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { collaborationEventBody, collaborationEventSchema, joinProposalSchema,
  type CollaborationEvent, type CollaborationMember, type CollaborationPayload, type JoinProposal } from "../shared/collaboration.ts";
import { writeFileAtomic } from "./atomic.ts";

export interface CollaborationIdentity { publicKey: string; privateKey: string; encryptionPublicKey: string; encryptionPrivateKey: string }

/** Stable signing bytes independent of object insertion order. Protocol v1
 * contains only JSON primitives, arrays and schema-validated plain objects. */
export function collaborationJson(value: unknown): string {
  const sorted = (part: any): any => Array.isArray(part) ? part.map(sorted)
    : part && typeof part === "object" ? Object.fromEntries(Object.keys(part).sort().map(key => [key, sorted(part[key])])) : part;
  return JSON.stringify(sorted(value));
}

const digest = (value: unknown) => createHash("sha256").update(collaborationJson(value)).digest("hex");
const streamFor = (payload: CollaborationPayload) => payload.type === "group.created" || payload.type.startsWith("member.") ? "control" as const : "content" as const;
const streamKey = (grantId: string, stream: "control" | "content") => `${grantId}/${stream}`;
const privateKey = (identity: CollaborationIdentity) => createPrivateKey({ key: Buffer.from(identity.privateKey, "base64"), format: "der", type: "pkcs8" });
export const peerFingerprint = (key: string) => createHash("sha256").update(key).digest("hex");

export function createCollaborationIdentity(): CollaborationIdentity {
  const key = generateKeyPairSync("ed25519");
  const encryption = generateKeyPairSync("x25519");
  return { publicKey: key.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKey: key.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    encryptionPublicKey: encryption.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    encryptionPrivateKey: encryption.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64") };
}

export function loadCollaborationIdentity(directory: string): CollaborationIdentity {
  const path = join(directory, "identity.json");
  if (existsSync(path)) {
    const saved = JSON.parse(readFileSync(path, "utf8")) as CollaborationIdentity;
    const key = privateKey(saved);
    if (key.asymmetricKeyType !== "ed25519" || createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64") !== saved.publicKey) throw new Error("The local peer identity is invalid. Restore its original key before reconnecting groups.");
    const encryption = createPrivateKey({ key: Buffer.from(saved.encryptionPrivateKey, "base64"), format: "der", type: "pkcs8" });
    if (encryption.asymmetricKeyType !== "x25519" || createPublicKey(encryption).export({ format: "der", type: "spki" }).toString("base64") !== saved.encryptionPublicKey) throw new Error("The local peer encryption key is invalid. Restore its original key before reconnecting groups.");
    return saved;
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const identity = createCollaborationIdentity();
  writeFileAtomic(path, JSON.stringify(identity) + "\n", { mode: 0o600 });
  return identity;
}

export function signCollaboration(identity: CollaborationIdentity, value: unknown): string {
  return sign(null, Buffer.from(collaborationJson(value)), privateKey(identity)).toString("base64");
}

export function verifyCollaboration(key: string, value: unknown, signature: string): boolean {
  try {
    const publicKey = createPublicKey({ key: Buffer.from(key, "base64"), format: "der", type: "spki" });
    return publicKey.asymmetricKeyType === "ed25519" && verify(null, Buffer.from(collaborationJson(value)), publicKey, Buffer.from(signature, "base64"));
  } catch { return false; }
}

export function signedJoinProposal(identity: CollaborationIdentity, input: Omit<JoinProposal, "publicKey" | "encryptionKey">) {
  const proposal = joinProposalSchema.parse({ ...input, publicKey: identity.publicKey, encryptionKey: identity.encryptionPublicKey });
  return { proposal, consent: signCollaboration(identity, proposal) };
}

/** One durable log is the authority and the outbox. Native sessions, provider
 * files, memory and app databases are never merged into it. */
export class CollaborationLedger {
  readonly options: { directory: string; groupId: string; rootKey: string; identity: CollaborationIdentity };
  readonly events: CollaborationEvent[] = [];
  private streams = new Map<string, CollaborationEvent>();
  private byId = new Map<string, CollaborationEvent>();
  private grants = new Map<string, CollaborationMember>();
  private revocations: Array<CollaborationEvent & { payload: Extract<CollaborationPayload, { type: "member.revoked" }> }> = [];
  private clock = 0;
  private bytes = 0;
  private writeFailed = false;
  private invitations = new Set<string>();
  private readonly file: string;

  constructor(options: { directory: string; groupId: string; rootKey: string; identity: CollaborationIdentity }) {
    this.options = options;
    if (!/^[\da-f-]{36}$/i.test(options.groupId)) throw new Error("Invalid shared group ID.");
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    this.file = join(options.directory, `${options.groupId}.jsonl`);
    if (existsSync(this.file)) {
      if (statSync(this.file).size > 512 * 1024 * 1024) throw new Error("This group's collaboration log exceeds the supported size.");
      const text = readFileSync(this.file, "utf8");
      // An interrupted final append must be repaired explicitly, rather than
      // silently skipping a signed event and reusing its sequence number.
      if (text && !text.endsWith("\n")) throw new Error("The shared group log has an interrupted write. Restore the log before reconnecting.");
      for (const line of text.split("\n").filter(Boolean)) this.accept(JSON.parse(line), false);
      this.bytes = Buffer.byteLength(text);
    }
  }

  get groupId() { return this.options.groupId; }
  get name() { const event = this.events[0]; return event?.payload.type === "group.created" ? event.payload.name : "Shared group"; }

  static create(options: Omit<ConstructorParameters<typeof CollaborationLedger>[0], "groupId" | "rootKey"> & { name: string; memberName: string; endpoint: string }) {
    const groupId = randomUUID();
    const ledger = new CollaborationLedger({ ...options, groupId, rootKey: options.identity.publicKey });
    ledger.append({ type: "group.created", name: options.name, nameOfCreator: options.memberName, endpoint: options.endpoint, encryptionKey: options.identity.encryptionPublicKey });
    return ledger;
  }

  cursors(): Record<string, number> { return Object.fromEntries([...this.streams].map(([id, event]) => [id, event.sequence])); }

  members(): CollaborationMember[] { return [...this.grants.values()].map(value => ({ ...value, active: this.active(value.grantId) })); }

  private ancestor(parent: string, child: string): boolean {
    let current = this.grants.get(child);
    const seen = new Set<string>();
    while (current && !seen.has(current.grantId)) {
      if (current.grantId === parent) return true;
      seen.add(current.grantId);
      current = current.parent ? this.grants.get(current.parent) : undefined;
    }
    return false;
  }

  private applicableRevocations(grantId: string) {
    return this.revocations.filter(event => this.ancestor(event.payload.grantId, grantId));
  }

  active(grantId: string): boolean {
    const grant = this.grants.get(grantId);
    if (!grant) return false;
    return this.applicableRevocations(grantId).length === 0;
  }

  /** Already shared history is retained; a revoked stream has an explicit
   * signed high-water mark and cannot append new authorized material. */
  visible(event: CollaborationEvent): boolean {
    const revoked = this.applicableRevocations(event.grantId);
    return revoked.length === 0 || event.sequence <= Math.min(...revoked.map(item => item.payload.cutoffs[streamKey(event.grantId, event.stream)] ?? 0));
  }

  localGrant(): CollaborationMember | undefined {
    return this.members().findLast(member => member.publicKey === this.options.identity.publicKey && member.active);
  }

  append(payload: CollaborationPayload): CollaborationEvent {
    const grant = this.localGrant();
    if (payload.type !== "group.created" && !grant) throw new Error("This installation no longer belongs to this shared group.");
    if ((payload.type === "member.added" || payload.type === "member.revoked") && grant?.role !== "manager") throw new Error("Only a group manager can change membership.");
    const grantId = grant?.grantId ?? this.groupId;
    const stream = streamFor(payload);
    const last = this.streams.get(streamKey(grantId, stream));
    const body = collaborationEventBody.parse({ version: 1, groupId: this.groupId, grantId, origin: this.options.identity.publicKey, stream,
      sequence: (last?.sequence ?? 0) + 1, previous: last?.id ?? null, lamport: Math.min(this.clock + 1, Number.MAX_SAFE_INTEGER), at: Date.now(), payload });
    const event = { ...body, id: digest(body), signature: signCollaboration(this.options.identity, body) };
    this.accept(event, true);
    return event;
  }

  receive(events: unknown[]): number {
    if (events.length > 100) throw new Error("Too many shared events in one request.");
    let count = 0;
    for (const event of events) if (this.accept(event, true)) count++;
    return count;
  }

  private accept(raw: unknown, persist: boolean): boolean {
    const event = collaborationEventSchema.parse(raw);
    const { id, signature, ...body } = event;
    if (event.groupId !== this.groupId || digest(body) !== id || !verifyCollaboration(event.origin, body, signature)) throw new Error("Invalid shared event identity or signature.");
    if (this.byId.has(id)) return false;
    if (event.stream !== streamFor(event.payload)) throw new Error("Invalid shared event stream.");
    const last = this.streams.get(streamKey(event.grantId, event.stream));
    if (last && event.sequence <= last.sequence) throw new Error("Conflicting shared event sequence. No action was replayed.");
    if (event.sequence !== (last?.sequence ?? 0) + 1 || event.previous !== (last?.id ?? null)) throw new Error("Shared events are missing. Synchronize the earlier events first.");
    if (last && event.lamport < last.lamport) throw new Error("Invalid shared event causal clock.");
    const payload = event.payload;
    if (payload.type === "group.created") {
      if (this.events.length || event.grantId !== this.groupId || event.origin !== this.options.rootKey) throw new Error("This group does not have the expected founding identity.");
    } else {
      const grant = this.grants.get(event.grantId);
      if (!grant || grant.publicKey !== event.origin) throw new Error("This event has no authenticated group membership.");
      if (payload.type === "member.added") {
        if (grant.role !== "manager" || this.grants.has(payload.grantId) || this.grants.size >= 200 || this.invitations.has(payload.proposal.invitationId)
          || payload.proposal.groupId !== this.groupId || !verifyCollaboration(payload.proposal.publicKey, payload.proposal, payload.consent)) throw new Error("Invalid membership or missing peer consent.");
      }
      if (payload.type === "member.revoked") {
        if (grant.role !== "manager" || payload.grantId === this.groupId || !this.ancestor(grant.grantId, payload.grantId)) throw new Error("A manager may revoke only memberships invited through its own grant.");
      }
      if (payload.type === "task.assignment") {
        const previous = this.events.filter(item => item.payload.type === "task.assignment" && item.payload.taskId === payload.taskId);
        if (payload.supersedes.includes(payload.assignmentId) || previous.some(item => item.payload.type === "task.assignment" && item.payload.assignmentId === payload.assignmentId)
          || payload.supersedes.some(id => !previous.some(item => item.payload.type === "task.assignment" && item.payload.assignmentId === id))) throw new Error("An assignment must reference this task's existing assignments.");
      }
    }
    const line = JSON.stringify(event) + "\n";
    const bytes = Buffer.byteLength(line);
    if (persist) {
      if (this.writeFailed) throw new Error("This group's last write has an uncertain outcome. Reload its log before sending more events.");
      if (this.bytes + bytes > 512 * 1024 * 1024) throw new Error("This shared group's log is full. No event was sent.");
      try { appendFileSync(this.file, line, { mode: 0o600, flush: true }); }
      catch (error) { this.writeFailed = true; throw new Error("This group's last write has an uncertain outcome. Reload its log before sending more events.", { cause: error }); }
    }
    this.events.push(event); this.byId.set(id, event); this.streams.set(streamKey(event.grantId, event.stream), event);
    this.bytes += bytes;
    this.clock = Math.max(this.clock, event.lamport);
    if (payload.type === "group.created") this.grants.set(event.grantId, { grantId: event.grantId, publicKey: event.origin, encryptionKey: payload.encryptionKey,
      name: payload.nameOfCreator, endpoint: payload.endpoint, role: "manager", parent: null, active: true });
    if (payload.type === "member.added") {
      this.invitations.add(payload.proposal.invitationId);
      this.grants.set(payload.grantId, { grantId: payload.grantId, publicKey: payload.proposal.publicKey, encryptionKey: payload.proposal.encryptionKey,
        name: payload.proposal.name, endpoint: payload.proposal.endpoint, role: payload.role, parent: event.grantId, active: true });
    }
    if (payload.type === "member.revoked") this.revocations.push(event as typeof this.revocations[number]);
    if (payload.type === "member.address") this.grants.get(event.grantId)!.endpoint = payload.endpoint;
    return true;
  }

  delta(cursors: Record<string, number>, maxBytes = 448 * 1024, controlOnly = false): CollaborationEvent[] {
    const result: CollaborationEvent[] = [];
    let bytes = 0;
    // Membership proofs bootstrap independently of a group's chat history.
    // Both streams retain their own signed contiguous sequence/hash chain.
    const ordered = [...this.events.filter(event => event.stream === "control"), ...(!controlOnly ? this.events.filter(event => event.stream === "content") : [])];
    for (const event of ordered) {
      if (event.sequence <= (cursors[streamKey(event.grantId, event.stream)] ?? 0)) continue;
      const size = Buffer.byteLength(JSON.stringify(event));
      if (bytes + size > maxBytes || result.length >= 100) break;
      result.push(event); bytes += size;
    }
    return result;
  }

  /** A former member may learn why its grant ended, without reading new group
   * content or submitting events. Only the revoking manager's signed control
   * chain through that revocation is needed; later controls stay private. */
  revocationDelta(grantId: string, cursors: Record<string, number>): CollaborationEvent[] {
    const revoked = this.applicableRevocations(grantId)[0];
    if (!revoked) return [];
    const result: CollaborationEvent[] = []; let bytes = 0;
    for (const event of this.events) {
      if (event.grantId !== revoked.grantId || event.stream !== "control" || event.sequence > revoked.sequence
        || event.sequence <= (cursors[streamKey(event.grantId, event.stream)] ?? 0)) continue;
      const size = Buffer.byteLength(JSON.stringify(event));
      if (bytes + size > 448 * 1024 || result.length >= 100) break;
      result.push(event); bytes += size;
    }
    return result;
  }

  messages(): CollaborationEvent[] {
    const latest = new Map<string, CollaborationEvent>();
    const initial = new Map<string, number>();
    for (const event of this.events) {
      if (event.payload.type !== "message.upsert" || !this.visible(event)) continue;
      const key = `${event.origin}/${event.payload.messageId}`;
      initial.set(key, Math.min(initial.get(key) ?? Infinity, event.lamport));
      const before = latest.get(key);
      if (!before || event.grantId === before.grantId && event.sequence > before.sequence || event.lamport > before.lamport
        || event.lamport === before.lamport && event.grantId !== before.grantId && event.id > before.id) latest.set(key, event);
    }
    return [...latest.entries()].sort(([a], [b]) => initial.get(a)! - initial.get(b)! || (a < b ? -1 : a > b ? 1 : 0)).map(([, event]) => event);
  }

  assignment(taskId: string): { state: "unassigned" | "assigned" | "conflict"; heads: CollaborationEvent[] } {
    const events = this.events.filter(event => event.payload.type === "task.assignment" && event.payload.taskId === taskId && this.visible(event));
    const superseded = new Set(events.flatMap(event => event.payload.type === "task.assignment" ? event.payload.supersedes : []));
    const heads = events.filter(event => event.payload.type === "task.assignment" && !superseded.has(event.payload.assignmentId));
    return { state: heads.length > 1 ? "conflict" : heads.length === 0 || heads[0].payload.type === "task.assignment" && heads[0].payload.assignee === null ? "unassigned" : "assigned", heads };
  }
}
