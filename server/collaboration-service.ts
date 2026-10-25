import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { collaborationCursors, collaborationEventSchema, joinProposalSchema, type CollaborationPayload, type SharedGroupStatus } from "../shared/collaboration.ts";
import { writeFileAtomic } from "./atomic.ts";
import { openCollaboration, sealCollaboration } from "./collaboration-box.ts";
import { CollaborationLedger, loadCollaborationIdentity, signCollaboration, signedJoinProposal, verifyCollaboration, type CollaborationIdentity } from "./collaboration-ledger.ts";
import { tailnetOrigin, type PrivateNetwork } from "./private-network.ts";
import { executionCommand, executionReply, type ExecutionCommand, type ExecutionReply } from "../shared/collaboration-execution.ts";
import type { CollaborationMember } from "../shared/collaboration.ts";

const id = z.string().uuid();
const key = z.string().regex(/^[A-Za-z0-9+/]{59}=$/);
const signature = z.string().regex(/^[A-Za-z0-9+/]{86}==$/);
const endpoint = z.string().max(200).refine(value => tailnetOrigin(value) === value, "Use a private Hattera tailnet address.");
const invitationBody = z.object({ version: z.literal(1), groupId: id, rootKey: key, issuer: key, encryptionKey: key, endpoint,
  invitationId: id, expiresAt: z.number().int().positive(), role: z.enum(["member", "manager"]), token: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const invitationSchema = invitationBody.extend({ signature }).strict();
const joinRequest = z.object({ action: z.literal("join"), invitation: invitationSchema, proposal: joinProposalSchema, consent: signature, cursors: collaborationCursors }).strict();
const syncRequest = z.object({ action: z.literal("sync"), grantId: id, events: z.array(collaborationEventSchema).max(100), cursors: collaborationCursors }).strict();
const executionRequest = z.object({ action: z.literal("execution"), grantId: id, command: executionCommand }).strict();
const requestSchema = z.object({ version: z.literal(1), groupId: id, nonce: id, at: z.number().int().positive(), request: z.discriminatedUnion("action", [joinRequest, syncRequest, executionRequest]) }).strict();
const executionResponse = z.object({ version: z.literal(1), groupId: id, nonce: id, result: executionReply }).strict();
const responseSchema = z.object({ version: z.literal(1), groupId: id, nonce: id, cursors: collaborationCursors, events: z.array(collaborationEventSchema).max(100) }).strict();
const pendingJoinSchema = z.object({ invitation: invitationSchema, proposal: joinProposalSchema, consent: signature }).strict();
const inviteState = z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number().int(), role: z.enum(["member", "manager"]),
  usedBy: key.optional(), proposalNonce: id.optional() }).strict();
const bindingSchema = z.object({ groupId: id, rootKey: key, localGroupId: z.string().min(1).max(100), enabled: z.boolean(),
  acknowledgments: z.record(z.string(), collaborationCursors), invitations: z.record(z.string(), inviteState),
  exportsSince: z.number().nonnegative(),
  pendingJoin: pendingJoinSchema.optional(), lastSyncedAt: z.number().optional(), error: z.string().max(300).optional(), blocked: z.boolean().optional() }).strict();
const indexSchema = z.object({ version: z.literal(1), groups: z.array(bindingSchema).max(64) }).strict();
type Binding = z.infer<typeof bindingSchema>;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const sameToken = (value: string, expected: string) => timingSafeEqual(Buffer.from(hash(value), "hex"), Buffer.from(expected, "hex"));

/** Membership authenticates transport. Execution is delegated only to the
 * separate owner-grant handler; membership alone never starts a provider. */
export class CollaborationService {
  private readonly options: { dataDir: string; network: Pick<PrivateNetwork, "status" | "peer">; changed?: (groupId: string) => void; allowed?: () => string | null };
  private readonly directory: string;
  private identity?: CollaborationIdentity;
  private bindings: Binding[] = [];
  private ledgers = new Map<string, CollaborationLedger>();
  private inbound = 0;
  private running = new Set<string>();
  private retry = new Map<string, { at: number; failures: number }>();
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private writeFailed = false;
  private rotation = 0;
  private initializationError?: string;
  private execution?: (groupId: string, member: CollaborationMember, command: ExecutionCommand) => Promise<ExecutionReply>;
  private contacts = new Map<string, number>();

  setExecutionHandler(handler: NonNullable<CollaborationService["execution"]>) { this.execution = handler; }
  member(groupId: string, publicKey: string): CollaborationMember {
    const binding = this.binding(groupId); this.ready(binding);
    const ledger = this.ledger(groupId);
    const member = ledger.members().find(value => value.publicKey === publicKey && value.active);
    if (!member || !ledger.localGrant() || binding.pendingJoin) throw new Error("An active group membership is required.");
    return member;
  }
  localMember(groupId: string) { return this.member(groupId, this.getIdentity().publicKey); }
  async callExecution(groupId: string, owner: string, command: ExecutionCommand): Promise<ExecutionReply> {
    const local = this.localMember(groupId), peer = this.member(groupId, owner);
    if (local.publicKey === peer.publicKey) throw new Error("Choose another person's shared provider.");
    await this.origin();
    const nonce = randomUUID(), identity = this.getIdentity();
    const packet = await sealCollaboration(identity, peer.encryptionKey, groupId, { version: 1, groupId, nonce, at: Date.now(),
      request: { action: "execution", grantId: local.grantId, command: executionCommand.parse(command) } });
    const response = await this.options.network.peer(peer.endpoint, packet);
    if (response.status !== 200) throw new Error("The owner could not accept this request. Check their connection and sharing permission.");
    const opened = await openCollaboration(identity, response.body, peer.publicKey), data = executionResponse.parse(opened.value);
    if (opened.groupId !== groupId || data.groupId !== groupId || data.nonce !== nonce) throw new Error("The execution response belongs to another exchange.");
    this.member(groupId, owner);
    this.contacts.set(`${groupId}/${peer.publicKey}`, Date.now());
    return data.result;
  }

  constructor(options: { dataDir: string; network: Pick<PrivateNetwork, "status" | "peer">; changed?: (groupId: string) => void; allowed?: () => string | null }) {
    this.options = options;
    this.directory = join(options.dataDir, "collaboration");
    const path = join(this.directory, "index.json");
    if (existsSync(path)) {
      try { this.bindings = indexSchema.parse(JSON.parse(readFileSync(path, "utf8"))).groups; }
      catch { this.initializationError = "The shared group index needs repair. Restore its original file before reconnecting."; return; }
      try {
        if (!existsSync(join(this.directory, "identity.json"))) throw new Error("The shared group identity is missing. Restore its original key before reconnecting.");
        this.getIdentity();
      } catch {
        this.initializationError = "The shared group identity needs repair. Restore its original key before reconnecting.";
        for (const binding of this.bindings) { binding.blocked = true; binding.error = this.initializationError; }
        return;
      }
      for (const binding of this.bindings) {
        try { if (!this.ledger(binding.groupId).events.length && !binding.pendingJoin) throw new Error("Missing shared log"); }
        catch { binding.blocked = true; binding.error = "The shared group log needs repair. Sharing is paused; no action was replayed."; }
      }
    }
  }

  private getIdentity() { if (this.initializationError) throw new Error(this.initializationError); return this.identity ??= loadCollaborationIdentity(this.directory); }
  private save() {
    if (this.writeFailed) throw new Error("The shared group state has an uncertain write. Restart before retrying.");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    try { writeFileAtomic(join(this.directory, "index.json"), JSON.stringify({ version: 1, groups: this.bindings }) + "\n", { mode: 0o600 }); }
    catch (error) { this.writeFailed = true; throw error; }
  }
  private binding(groupId: string) {
    const value = this.bindings.find(item => item.groupId === groupId);
    if (!value) throw new Error("This installation does not share that group.");
    return value;
  }
  ledger(groupId: string): CollaborationLedger {
    const binding = this.binding(groupId);
    let ledger = this.ledgers.get(groupId);
    if (!ledger) {
      ledger = new CollaborationLedger({ directory: this.directory, groupId, rootKey: binding.rootKey, identity: this.getIdentity() });
      this.ledgers.set(groupId, ledger);
    }
    return ledger;
  }
  private ready(binding: Binding) {
    const refusal = this.options.allowed?.(); if (refusal) throw new Error(refusal);
    if (this.closed || this.writeFailed || !binding.enabled || binding.blocked) throw new Error("Sharing is paused for this group.");
  }
  private async origin() {
    const refusal = this.options.allowed?.(); if (refusal) throw new Error(refusal);
    if (this.initializationError) throw new Error(this.initializationError);
    const network = await this.options.network.status();
    if (network.state !== "connected" || !network.origin || !tailnetOrigin(network.origin) || !network.peerTransport) throw new Error("Connect Hattera to Tailscale with the current network helper before sharing a group.");
    return tailnetOrigin(network.origin)!;
  }
  status(): SharedGroupStatus[] {
    return this.bindings.map(binding => {
      const ledger = this.ledgers.get(binding.groupId);
      const peers = ledger?.members().filter(member => member.active && member.publicKey !== this.identity?.publicKey) ?? [];
      const catalogs = new Map<string, Extract<CollaborationPayload, { type: "bots.catalog" }> >();
      for (const event of ledger?.events ?? []) if (event.payload.type === "bots.catalog" && ledger?.visible(event)) catalogs.set(event.origin, event.payload);
      return { groupId: binding.groupId, localGroupId: binding.localGroupId, name: ledger?.name ?? "Shared group unavailable", enabled: binding.enabled, localPublicKey: this.identity?.publicKey ?? "",
        bots: [...catalogs].flatMap(([origin, catalog]) => catalog.bots.map(bot => ({ origin, ...bot }))),
        members: (ledger?.members() ?? []).map(member => ({ ...member, lastContactAt: this.contacts.get(`${binding.groupId}/${member.publicKey}`) })), pending: peers.reduce((total, peer) => total + (ledger?.events.filter(event => event.sequence > (binding.acknowledgments[peer.grantId]?.[`${event.grantId}/${event.stream}`] ?? 0)).length ?? 0), 0),
        ...(binding.blocked ? { blocked: true } : {}),
        ...(binding.pendingJoin ? { joining: true } : {}), ...(binding.lastSyncedAt ? { lastSyncedAt: binding.lastSyncedAt } : {}), ...(binding.error ? { error: binding.error } : {}) };
    });
  }
  get error() { return this.initializationError; }
  async share(localGroupId: string, name: string, memberName: string, includeHistory = false) {
    if (this.bindings.some(binding => binding.localGroupId === localGroupId)) throw new Error("This group already has a sharing identity.");
    if (this.bindings.length >= 64) throw new Error("This installation already shares the supported maximum of 64 groups.");
    const endpoint = await this.origin();
    const ledger = CollaborationLedger.create({ directory: this.directory, identity: this.getIdentity(), name, memberName, endpoint });
    this.bindings.push(bindingSchema.parse({ groupId: ledger.groupId, rootKey: this.getIdentity().publicKey, localGroupId, enabled: true, exportsSince: includeHistory ? 0 : Date.now(), acknowledgments: {}, invitations: {} }));
    this.ledgers.set(ledger.groupId, ledger); this.save();
    return ledger.groupId;
  }
  async invite(groupId: string, role: "member" | "manager" = "member") {
    const binding = this.binding(groupId); this.ready(binding);
    const ledger = this.ledger(groupId), identity = this.getIdentity();
    if (ledger.localGrant()?.role !== "manager") throw new Error("Only an active group manager can invite people.");
    const origin = await this.origin();
    binding.invitations = Object.fromEntries(Object.entries(binding.invitations).filter(([, value]) => value.expiresAt > Date.now()));
    if (Object.keys(binding.invitations).length >= 32) throw new Error("Too many active invitations. Wait for one to expire.");
    const body = invitationBody.parse({ version: 1, groupId, rootKey: binding.rootKey, issuer: identity.publicKey, encryptionKey: identity.encryptionPublicKey,
      endpoint: origin, invitationId: randomUUID(), expiresAt: Date.now() + 5 * 60_000, role, token: randomBytes(32).toString("hex") });
    binding.invitations[body.invitationId] = { hash: hash(body.token), expiresAt: body.expiresAt, role };
    this.save();
    return Buffer.from(JSON.stringify({ ...body, signature: signCollaboration(identity, body) })).toString("base64url");
  }
  async join(code: string, localGroupId: string, memberName: string): Promise<string> {
    if (code.length > 4096) throw new Error("Invalid shared group invitation.");
    const invitation = invitationSchema.parse(JSON.parse(Buffer.from(code, "base64url").toString("utf8")));
    const { signature, ...body } = invitation;
    if (!verifyCollaboration(invitation.issuer, body, signature) || invitation.expiresAt <= Date.now()) throw new Error("This group invitation is invalid or expired.");
    const existing = this.bindings.find(binding => binding.groupId === invitation.groupId || binding.localGroupId === localGroupId);
    if (existing && (!existing.pendingJoin || existing.blocked || existing.groupId !== invitation.groupId || existing.localGroupId !== localGroupId || existing.rootKey !== invitation.rootKey)) throw new Error("This group already has a different sharing identity.");
    if (!existing && this.bindings.length >= 64) throw new Error("This installation already shares 64 groups.");
    const endpoint = await this.origin(), identity = this.getIdentity();
    if (invitation.issuer === identity.publicKey) throw new Error("Join this invitation from the other person's Hattera installation.");
    const consent = signedJoinProposal(identity, { groupId: invitation.groupId, invitationId: invitation.invitationId, name: memberName, endpoint, at: Date.now(), nonce: randomUUID() });
    if (existing) { existing.pendingJoin = { invitation, ...consent }; existing.enabled = true; delete existing.error; }
    else this.bindings.push(bindingSchema.parse({ groupId: invitation.groupId, rootKey: invitation.rootKey, localGroupId, enabled: true, exportsSince: Date.now(), acknowledgments: {}, invitations: {}, pendingJoin: { invitation, ...consent } }));
    this.save(); this.ledger(invitation.groupId);
    return invitation.groupId;
  }
  setEnabled(groupId: string, enabled: boolean) { const binding = this.binding(groupId); binding.enabled = enabled; this.save(); }
  exportsSince(groupId: string) { return this.binding(groupId).exportsSince; }
  append(groupId: string, payload: CollaborationPayload) {
    const binding = this.binding(groupId); this.ready(binding);
    if (binding.pendingJoin) throw new Error("Wait for this installation to finish joining the group.");
    try { const event = this.ledger(groupId).append(payload); this.options.changed?.(groupId); return event; }
    catch (error) {
      if (error instanceof Error && /uncertain outcome|last write/.test(error.message)) { binding.blocked = true; binding.error = "The group's last write has an uncertain outcome. Sharing is paused until its log is reloaded."; this.save(); }
      throw error;
    }
  }
  revoke(groupId: string, grantId: string) { return this.append(groupId, { type: "member.revoked", grantId, cutoffs: this.ledger(groupId).cursors() }); }

  private receive(binding: Binding, events: unknown[]) {
    try { const count = this.ledger(binding.groupId).receive(events); if (count) this.options.changed?.(binding.groupId); }
    catch (error) {
      // Only a verified fork or uncertain disk write requires a durable pause.
      // Invalid unsigned network input cannot pause a group for its owner.
      if (error instanceof Error && /Conflicting shared event sequence|uncertain outcome|last write/.test(error.message)) {
        binding.blocked = true; binding.error = "Conflicting or uncertain group history. Sharing is paused; no action was replayed."; this.save();
      }
      throw error;
    }
  }
  async handlePeer(raw: unknown): Promise<unknown> {
    if (this.inbound >= 4) throw new Error("The peer is busy. Retry later.");
    const groupId = z.object({ groupId: id }).parse(raw).groupId;
    const binding = this.binding(groupId); this.ready(binding);
    this.inbound++;
    try {
      await this.origin();
      const identity = this.getIdentity(), opened = await openCollaboration(identity, raw);
      const input = requestSchema.parse(opened.value);
      if (input.groupId !== groupId || Math.abs(Date.now() - input.at) > 5 * 60_000) throw new Error("Invalid or expired peer request.");
      this.ready(binding);
      const ledger = this.ledger(groupId), request = input.request;
      let recipient: string;
      if (request.action === "join") {
        const invitation = request.invitation, saved = binding.invitations[invitation.invitationId];
        const { signature, ...body } = invitation;
        const manager = ledger.localGrant();
        if (!manager || manager.role !== "manager" || invitation.groupId !== groupId || invitation.rootKey !== binding.rootKey || invitation.issuer !== identity.publicKey
          || invitation.encryptionKey !== identity.encryptionPublicKey || !verifyCollaboration(identity.publicKey, body, signature)
          || !saved || invitation.expiresAt !== saved.expiresAt || invitation.role !== saved.role || saved.expiresAt <= Date.now() || !sameToken(invitation.token, saved.hash)
          || request.proposal.groupId !== groupId || request.proposal.invitationId !== invitation.invitationId || request.proposal.publicKey !== opened.sender
          || !tailnetOrigin(request.proposal.endpoint) || !verifyCollaboration(opened.sender, request.proposal, request.consent)) throw new Error("This group invitation or consent is invalid.");
        // The signed membership log is authoritative even if the previous
        // response or the index update was interrupted after admission.
        const existing = ledger.events.find(event => event.payload.type === "member.added" && event.payload.proposal.invitationId === invitation.invitationId);
        if (existing?.payload.type === "member.added") {
          if (existing.payload.proposal.publicKey !== opened.sender || existing.payload.consent !== request.consent || !ledger.active(existing.payload.grantId)) throw new Error("This invitation has already been used.");
        } else {
          if (saved.usedBy) throw new Error("This invitation has already been used.");
          ledger.append({ type: "member.added", grantId: randomUUID(), role: invitation.role, proposal: request.proposal, consent: request.consent });
          this.options.changed?.(groupId);
        }
        saved.usedBy = opened.sender; saved.proposalNonce = request.proposal.nonce; this.save();
        recipient = request.proposal.encryptionKey;
      } else {
        const member = ledger.members().find(member => member.grantId === request.grantId && member.publicKey === opened.sender);
        if (!member || !ledger.localGrant() || binding.pendingJoin) throw new Error("This peer has no active membership here.");
        recipient = member.encryptionKey;
        if (!member.active) {
          if (request.action !== "sync") throw new Error("This peer's membership has ended.");
          const events = ledger.revocationDelta(member.grantId, request.cursors);
          return await sealCollaboration(identity, recipient, groupId, { version: 1, groupId, nonce: input.nonce, events,
            cursors: Object.fromEntries(events.map(event=>[`${event.grantId}/${event.stream}`,event.sequence])) });
        }
        this.contacts.set(`${groupId}/${member.publicKey}`, Date.now());
        if (request.action === "execution") {
          if (!this.execution) throw new Error("This Hattera installation does not support shared execution.");
          const result = executionReply.parse(await this.execution(groupId, member, request.command));
          this.member(groupId, member.publicKey);
          return await sealCollaboration(identity, recipient, groupId, { version: 1, groupId, nonce: input.nonce, result });
        }
        this.receive(binding, request.events);
        // The request itself may contain a valid revocation. Do not disclose
        // further data after either party loses its membership.
        if (!ledger.active(member.grantId) || !ledger.localGrant()) throw new Error("This peer's membership has ended.");
        binding.acknowledgments[member.grantId] = request.cursors;
        binding.lastSyncedAt = Date.now(); this.save();
      }
      return await sealCollaboration(identity, recipient, groupId, { version: 1, groupId, nonce: input.nonce, cursors: ledger.cursors(), events: ledger.delta(request.cursors, undefined, request.action === "join") });
    } finally { this.inbound--; }
  }

  /** One bounded exchange; the signed log remains the outbox across restart. */
  async synchronize(groupId: string, peerGrantId?: string): Promise<void> {
    const binding = this.binding(groupId); this.ready(binding);
    const runKey = `${groupId}/${peerGrantId ?? "join"}`;
    if (this.running.has(runKey)) return;
    if (this.running.size >= 2) return;
    this.running.add(runKey);
    try {
      const ledger = this.ledger(groupId), identity = this.getIdentity(), origin = await this.origin();
      let peer: { publicKey: string; encryptionKey: string; endpoint: string; grantId?: string }, request: z.infer<typeof requestSchema>["request"];
      const pending = binding.pendingJoin;
      if (pending) {
        peer = { publicKey: pending.invitation.issuer, encryptionKey: pending.invitation.encryptionKey, endpoint: pending.invitation.endpoint };
        request = { action: "join", ...pending, cursors: ledger.cursors() };
      } else {
        const local = ledger.localGrant();
        if (!local) throw new Error("This installation's group membership has ended.");
        if (local.endpoint !== origin) ledger.append({ type: "member.address", endpoint: origin });
        const found = ledger.members().find(member => member.grantId === peerGrantId && member.active && member.publicKey !== identity.publicKey);
        if (!found) throw new Error("Choose an active member of this group.");
        peer = found;
        request = { action: "sync", grantId: local.grantId, events: ledger.delta(binding.acknowledgments[found.grantId] ?? {}), cursors: ledger.cursors() };
      }
      if (!tailnetOrigin(peer.endpoint)) throw new Error("This peer has no valid private address.");
      const nonce = randomUUID();
      const packet = await sealCollaboration(identity, peer.encryptionKey, groupId, { version: 1, groupId, nonce, at: Date.now(), request });
      const response = await this.options.network.peer(peer.endpoint, packet);
      if (response.status !== 200) throw new Error("The peer is offline, sharing is paused, or membership was not accepted. Retry when it is available.");
      const opened = await openCollaboration(identity, response.body, peer.publicKey), data = responseSchema.parse(opened.value);
      if (opened.groupId !== groupId || data.groupId !== groupId || data.nonce !== nonce) throw new Error("The peer returned a response for another exchange.");
      this.ready(binding); this.receive(binding, data.events);
      if (!pending && !ledger.localGrant()) throw new Error("This installation's membership was not accepted: its sharing grant has ended.");
      if (pending && ledger.localGrant()) {
        const inviter = ledger.members().find(member => member.publicKey === peer.publicKey && member.encryptionKey === peer.encryptionKey && member.active && member.role === "manager");
        if (!inviter) throw new Error("The inviter no longer has the expected group authority.");
        delete binding.pendingJoin;
      }
      if (peer.grantId) binding.acknowledgments[peer.grantId] = data.cursors;
      this.contacts.set(`${groupId}/${peer.publicKey}`, Date.now());
      binding.lastSyncedAt = Date.now(); delete binding.error; this.save(); this.retry.delete(runKey); this.options.changed?.(groupId);
    } catch (error) {
      binding.error ??= error instanceof Error ? error.message.slice(0, 300) : "The group could not synchronize.";
      const failures = (this.retry.get(runKey)?.failures ?? 0) + 1;
      this.retry.set(runKey, { failures, at: Date.now() + Math.min(60_000, 2000 * 2 ** Math.min(failures - 1, 5)) });
      this.save(); throw error;
    } finally { this.running.delete(runKey); }
  }
  start() {
    if (this.timer || this.closed || !this.bindings.some(binding => binding.enabled && !binding.blocked)) return;
    this.timer = setInterval(() => {
      const jobs = this.bindings.filter(binding => binding.enabled && !binding.blocked).flatMap(binding => binding.pendingJoin
        ? [{ groupId: binding.groupId, grantId: undefined as string | undefined }]
        : !this.ledgers.get(binding.groupId)?.localGrant() ? []
        : (this.ledgers.get(binding.groupId)?.members() ?? []).filter(member => member.active && member.publicKey !== this.identity?.publicKey).map(member => ({ groupId: binding.groupId, grantId: member.grantId })));
      for (let offset = 0; offset < jobs.length && this.running.size < 2; offset++) {
        const job = jobs[(this.rotation + offset) % jobs.length]!;
        const runKey = `${job.groupId}/${job.grantId ?? "join"}`;
        if ((this.retry.get(runKey)?.at ?? 0) > Date.now() || this.running.has(runKey)) continue;
        void this.synchronize(job.groupId, job.grantId).catch(() => {});
      }
      this.rotation++;
    }, 2000); this.timer.unref();
  }
  close() { this.closed = true; clearInterval(this.timer); }
}
