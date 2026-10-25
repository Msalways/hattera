import { randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { executionCommand, executionJob, executionTarget, terminalExecution, type ExecutionCommand, type ExecutionJob, type ExecutionReply, type ExecutionStatus, type ExecutionTarget } from "../shared/collaboration-execution.ts";
import type { CollaborationMember } from "../shared/collaboration.ts";
import type { CollaborationService } from "./collaboration-service.ts";
import { writeFileAtomic } from "./atomic.ts";
import { redactSecretsInText } from "../shared/redact.ts";
import { splitTranscriptAttachments } from "../src/lib/composer-attachments.ts";
import { splitTranscriptCitations } from "../src/lib/citations.ts";

const uuid = z.string().uuid();
const grantSchema = z.object({ id: uuid, groupId: uuid, botId: z.string().min(1).max(100), label: z.string().trim().min(1).max(160),
  members: z.array(z.string().min(1).max(100)).min(1).max(200), enabled: z.boolean(), approval: z.boolean() }).strict();
type Grant = z.infer<typeof grantSchema>;
const ownedSchema = executionJob.extend({ botId: z.string(), fingerprint: z.string(), threadId: z.string().optional(), roomThreadId: z.string().optional(), published: z.boolean().optional() });
type Owned = z.infer<typeof ownedSchema>;
const stateSchema = z.object({ version: z.literal(1), grants: z.array(grantSchema).max(128), incoming: z.array(ownedSchema).max(2000), outgoing: z.array(executionJob).max(2000) }).strict();
export type BotExecutionDescription = Omit<ExecutionTarget, "id" | "label" | "approval"> & { fingerprint: string };
export interface ExecutionRuntime {
  describe(botId: string, cached?: boolean): Promise<BotExecutionDescription>;
  fingerprint(botId: string): string;
  prepare(job: ExecutionJob, botId: string): { threadId: string; roomThreadId: string };
  start(job: Owned): Promise<void>;
  inspect(job: Owned): { busy: boolean; waiting: boolean; succeeded: boolean; result: string; usage?: ExecutionJob["usage"] };
  stop(job: Owned): Promise<void>;
  publish(job: Owned): void;
  capacity(botId: string): boolean;
}
const portable = (text: string) => redactSecretsInText(splitTranscriptAttachments(splitTranscriptCitations(text).display, false).display)
  .replace(/^.*<(?:attached-(?:file|image)|file|image)\b[^\n]*\bpath\s*=.*$/gmi, "[Local attachment omitted]").slice(0, 64_000);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Grants and exactly-once admission stay on the executing installation.
 * The peer channel carries bounded job records, never native auth or sessions. */
export class CollaborationExecution {
  private data: z.infer<typeof stateSchema> = { version: 1, grants: [], incoming: [], outgoing: [] };
  private peers = new Map<string, ExecutionStatus["peers"][number]>();
  private checked = new Map<string, number>();
  private working = new Set<string>();
  private ticking = false;
  private closed = false;
  private timer: ReturnType<typeof setInterval>;
  private error?: string;
  private pollRotation = 0;
  private path: string;
  private options: { dataDir: string; service: CollaborationService; runtime: ExecutionRuntime };
  constructor(options: { dataDir: string; service: CollaborationService; runtime: ExecutionRuntime }) {
    this.options = options;
    this.path = join(options.dataDir, "collaboration", "execution.json");
    if (existsSync(this.path)) {
      try { this.data = stateSchema.parse(JSON.parse(readFileSync(this.path, "utf8"))); }
      catch { this.error = "Shared execution records need repair. Execution is disabled; no job was replayed."; }
    }
    if (!this.error) {
      let changed = false;
      for (const job of this.data.incoming) if (["starting", "running", "awaiting-tool-approval", "cancel-requested"].includes(job.state)) {
        job.state = "uncertain"; job.error = "Hattera restarted during this request. Review the owner's task before submitting new work."; changed = true;
      }
      for (const job of this.data.outgoing) if (job.state === "sending") {
        job.state = "delivery-unknown"; job.error = "Hattera restarted before delivery was confirmed. Retry this same request ID or refresh its status."; changed = true;
      }
      if (changed) this.save();
    }
    options.service.setExecutionHandler((groupId, member, command) => this.receive(groupId, member, command));
    this.timer = setInterval(() => { void this.reconcile(); }, 1500); this.timer.unref();
  }
  private available() { if (this.error || this.closed) throw new Error(this.error ?? "Shared execution is stopping."); }
  private save() {
    if (this.error) throw new Error(this.error);
    mkdirSync(join(this.options.dataDir, "collaboration"), { recursive: true, mode: 0o700 });
    try { writeFileAtomic(this.path, JSON.stringify(this.data) + "\n", { mode: 0o600 }); }
    catch { this.error = "Shared execution state has an uncertain write. Restart and review before retrying."; throw new Error(this.error); }
  }
  private grantFor(groupId: string, targetId: string, requester: string) {
    this.available();
    this.options.service.localMember(groupId); this.options.service.member(groupId, requester);
    const grant = this.data.grants.find(value => value.id === targetId && value.groupId === groupId && value.enabled && value.members.includes(requester));
    if (!grant) throw new Error("The owner has not granted this person access to that bot/account.");
    return grant;
  }
  private valid(job: Owned) {
    const grant = this.grantFor(job.groupId, job.targetId, job.requesterKey);
    if (grant.botId !== job.botId || this.options.runtime.fingerprint(job.botId) !== job.fingerprint) throw new Error("The shared bot's configuration or permission changed. Request fresh approval.");
    return grant;
  }
  assertThread(threadId: string) {
    const job = this.data.incoming.find(value => value.threadId === threadId);
    if (!job) return;
    if (!['starting', 'running', 'awaiting-tool-approval'].includes(job.state)) throw new Error("This shared execution is no longer authorized. Start a new request.");
    this.valid(job);
  }
  private publicJob(job: Owned): ExecutionJob { return executionJob.parse(job); }
  private async target(grant: Grant) {
    const description = await this.options.runtime.describe(grant.botId, true);
    return executionTarget.parse({ ...description, id: grant.id, label: grant.label, approval: grant.approval });
  }
  async grant(input: { groupId: string; botId: string; label: string; members: string[]; approval: boolean }) {
    this.available();
    const owner = this.options.service.localMember(input.groupId);
    for (const key of input.members) { const member = this.options.service.member(input.groupId, key); if (member.publicKey === owner.publicKey) throw new Error("Choose other group members to share with."); }
    await this.options.runtime.describe(input.botId, true);
    if (this.data.grants.length >= 128) throw new Error("This installation has reached its shared execution grant limit.");
    const grant = grantSchema.parse({ ...input, id: randomUUID(), enabled: true });
    this.data.grants.push(grant); this.save(); return grant.id;
  }
  revoke(groupId: string, id: string) {
    this.available(); this.options.service.localMember(groupId);
    const grant = this.data.grants.find(value => value.id === id && value.groupId === groupId);
    if (!grant) throw new Error("This execution permission belongs to another installation.");
    grant.enabled = false; this.save(); void this.reconcile();
  }
  async receive(groupId: string, member: CollaborationMember, command: ExecutionCommand): Promise<ExecutionReply> {
    this.available(); this.options.service.member(groupId, member.publicKey);
    if (command.op === "catalog") {
      const grants = this.data.grants.filter(value => value.groupId === groupId && value.enabled && value.members.includes(member.publicKey));
      const targets = await Promise.all(grants.map(async grant => {
        try { return await this.target(grant); }
        catch { return null; }
      }));
      return { kind: "catalog", targets: targets.filter((value): value is ExecutionTarget => value !== null) };
    }
    let job = this.data.incoming.find(value => value.id === command.id);
    if (job && (job.groupId !== groupId || job.requesterKey !== member.publicKey)) throw new Error("This request belongs to another person or group.");
    if (command.op === "submit") {
      if (job) {
        if (job.targetId !== command.targetId || digest(job.text) !== digest(command.text)) throw new Error("This request ID already names different work.");
        return { kind: "job", job: this.publicJob(job) };
      }
      const grant = this.grantFor(groupId, command.targetId, member.publicKey);
      const description = await this.options.runtime.describe(grant.botId, true);
      this.grantFor(groupId, command.targetId, member.publicKey);
      if (this.options.runtime.fingerprint(grant.botId) !== description.fingerprint) throw new Error("The shared bot changed during admission. Refresh and request again.");
      // Description can await native CLI probes. Another copy may have been
      // durably admitted meanwhile; never enqueue a second native dispatch.
      const admitted = this.data.incoming.find(value => value.id === command.id);
      if (admitted) {
        if (admitted.groupId !== groupId || admitted.requesterKey !== member.publicKey || admitted.targetId !== command.targetId || digest(admitted.text) !== digest(command.text)) throw new Error("This request ID already names different work.");
        return { kind: "job", job: this.publicJob(admitted) };
      }
      if (!description.ready) throw new Error(description.reason ?? "This provider account needs setup on the owner's computer.");
      if (this.data.incoming.length >= 2000 || this.data.incoming.filter(value => !terminalExecution(value.state)).length >= 32) throw new Error("The owner's shared request queue is full.");
      const owner = this.options.service.localMember(groupId), now = Date.now();
      job = { id: command.id, groupId, targetId: grant.id, requester: member.name, requesterKey: member.publicKey,
        owner: owner.name, ownerKey: owner.publicKey, target: executionTarget.parse({ ...description, id: grant.id, label: grant.label, approval: grant.approval }), text: command.text, createdAt: now, updatedAt: now,
        state: grant.approval ? "pending-approval" : "queued", botId: grant.botId, fingerprint: description.fingerprint };
      this.data.incoming.push(job); this.save();
    }
    if (!job) throw new Error("This request was not received by the owner.");
    if (command.op === "cancel") await this.cancelOwned(job);
    return { kind: "job", job: this.publicJob(job) };
  }
  async decide(groupId: string, id: string, allow: boolean) {
    this.available(); this.options.service.localMember(groupId);
    const job = this.data.incoming.find(value => value.id === id && value.groupId === groupId);
    if (!job || job.state !== "pending-approval") throw new Error("This request no longer awaits approval.");
    if (allow) this.valid(job);
    job.state = allow ? "queued" : "denied"; job.updatedAt = Date.now(); this.save();
  }
  private async cancelOwned(job: Owned) {
    if (terminalExecution(job.state)) return;
    if (!job.threadId) { job.state = "cancelled"; job.updatedAt = Date.now(); this.save(); return; }
    job.state = "cancel-requested"; job.updatedAt = Date.now(); this.save();
    try { await this.options.runtime.stop(job); if (!this.options.runtime.inspect(job).busy) { job.state = "cancelled"; this.save(); } }
    catch { job.state = "uncertain"; job.error = "Cancellation could not be confirmed. Review the owner's task."; this.save(); }
  }
  async cancel(groupId: string, id: string, incoming: boolean) {
    this.available(); this.options.service.localMember(groupId);
    if (incoming) {
      const job = this.data.incoming.find(value => value.id === id && value.groupId === groupId);
      if (!job) throw new Error("Unknown local execution request.");
      await this.cancelOwned(job); return;
    }
    const job = this.data.outgoing.find(value => value.id === id && value.groupId === groupId);
    if (!job) throw new Error("Unknown sent execution request.");
    const reply = await this.options.service.callExecution(groupId, job.ownerKey, { op: "cancel", id });
    if (reply.kind !== "job") throw new Error("Unexpected cancellation response.");
    this.updateOutgoing(job, reply.job);
  }
  async request(input: { groupId: string; ownerKey: string; targetId: string; text: string; id: string }) {
    this.available(); const requester = this.options.service.localMember(input.groupId), owner = this.options.service.member(input.groupId, input.ownerKey);
    const command = executionCommand.parse({ op: "submit", id: input.id, targetId: input.targetId, text: input.text.trim() });
    if (command.op !== "submit") throw new Error("Expected a task request.");
    let job = this.data.outgoing.find(value => value.id === input.id);
    if (job && (job.groupId !== input.groupId || job.ownerKey !== input.ownerKey || job.targetId !== input.targetId || job.text !== command.text)) throw new Error("This request ID already names different work.");
    if (!job) {
      if (this.data.outgoing.length >= 2000) throw new Error("The sent request archive is full.");
      const target = this.peers.get(`${input.groupId}/${input.ownerKey}`)?.targets.find(value => value.id === input.targetId);
      if (!target) throw new Error("Refresh the shared provider list before choosing this target.");
      job = executionJob.parse({ ...input, target, requester: requester.name, requesterKey: requester.publicKey, owner: owner.name, createdAt: Date.now(), updatedAt: Date.now(), state: "sending" });
      this.data.outgoing.push(job); this.save();
    }
    try {
      const reply = await this.options.service.callExecution(input.groupId, owner.publicKey, command);
      if (reply.kind !== "job") throw new Error("Unexpected execution receipt.");
      this.updateOutgoing(job, reply.job);
    } catch (error) {
      console.warn(`[shared-execution] Delivery unconfirmed for ${job.id}: ${redactSecretsInText(error instanceof Error ? error.message : "Peer unavailable").slice(0, 300)}`);
      job.state = "delivery-unknown"; job.error = "Delivery could not be confirmed. Refresh status or retry this same request ID; no local fallback was started."; job.updatedAt = Date.now(); this.save();
    }
    return job;
  }
  private updateOutgoing(job: ExecutionJob, reply: ExecutionJob) {
    if (reply.id !== job.id || reply.groupId !== job.groupId || reply.ownerKey !== job.ownerKey || reply.requesterKey !== job.requesterKey || reply.targetId !== job.targetId || reply.text !== job.text) throw new Error("The owner returned another request's record.");
    if (terminalExecution(job.state) && !terminalExecution(reply.state)) return;
    if (digest(job) === digest(reply)) return;
    Object.assign(job, reply); if (!reply.error) delete job.error; this.save();
  }
  private async refresh(groupId: string) {
    const key = `refresh:${groupId}`;
    if (this.working.has(key) || this.closed || this.error || Date.now() - (this.checked.get(groupId) ?? 0) < 8000) return;
    this.working.add(key); this.checked.set(groupId, Date.now());
    try {
      const local = this.options.service.localMember(groupId);
      for (const member of this.options.service.ledger(groupId).members().filter(value => value.active && value.publicKey !== local.publicKey)) {
        const peerKey = `${groupId}/${member.publicKey}`, previous = this.peers.get(peerKey);
        this.peers.set(peerKey, { publicKey: member.publicKey, name: member.name, targets: previous?.targets ?? [], lastContactAt: previous?.lastContactAt, state: "checking" });
        try {
          const reply = await this.options.service.callExecution(groupId, member.publicKey, { op: "catalog" });
          if (reply.kind !== "catalog") throw new Error("Unexpected provider catalog.");
          this.peers.set(peerKey, { publicKey: member.publicKey, name: member.name, targets: reply.targets, state: "reachable", lastContactAt: Date.now() });
        } catch { this.peers.set(peerKey, { publicKey: member.publicKey, name: member.name, targets: previous?.targets ?? [], lastContactAt: previous?.lastContactAt, state: "unreachable" }); }
      }
    } catch { /* Paused/revoked groups are hidden by status. */ }
    finally { this.working.delete(key); }
  }
  async status(groupId: string): Promise<ExecutionStatus> {
    this.options.service.localMember(groupId);
    if (this.error) return { peers: [], grants: [], incoming: [], outgoing: [], error: this.error };
    void this.refresh(groupId);
    const active = new Set(this.options.service.ledger(groupId).members().filter(value => value.active).map(value => value.publicKey));
    const grants = await Promise.all(this.data.grants.filter(value => value.groupId === groupId).map(async grant => {
      const target = await this.target(grant).catch(() => ({ id: grant.id, label: grant.label, botName: "Removed bot", account: "Unavailable", driver: "unknown", model: "Unavailable", approval: grant.approval, ready: false, reason: "The shared bot is no longer available." }));
      return { ...target, botId: grant.botId, members: grant.members, enabled: grant.enabled };
    }));
    return { peers: [...this.peers.entries()].filter(([key, peer]) => key.startsWith(`${groupId}/`) && active.has(peer.publicKey)).map(([, peer]) => peer), grants,
      incoming: this.data.incoming.filter(value => value.groupId === groupId).slice(-50).map(value => ({ ...this.publicJob(value), botId: value.botId, threadId: value.threadId })),
      outgoing: this.data.outgoing.filter(value => value.groupId === groupId).slice(-50) };
  }
  async reconcile() {
    if (this.ticking || this.closed || this.error) return;
    this.ticking = true;
    try {
      for (const job of this.data.incoming) {
        if (terminalExecution(job.state)) {
          if (!job.published && job.roomThreadId) { this.options.runtime.publish(job); job.published = true; this.save(); }
          continue;
        }
        try { this.valid(job); }
        catch { await this.cancelOwned(job); continue; }
        if (job.state === "queued") {
          if (!this.options.runtime.capacity(job.botId)) continue;
          const description = await this.options.runtime.describe(job.botId);
          if (this.closed || job.state !== "queued" || !this.options.runtime.capacity(job.botId)) continue;
          this.valid(job);
          if (!description.ready) { job.state = "failed"; job.error = "The owner's provider account is no longer ready."; this.save(); continue; }
          const prepared = this.options.runtime.prepare(this.publicJob(job), job.botId);
          Object.assign(job, prepared, { state: "starting", updatedAt: Date.now() }); this.save();
          void this.options.runtime.start(job).then(() => {
            if (job.state === "starting") job.state = "running";
            job.updatedAt = Date.now(); this.save();
          }).catch(() => { if (!this.error && !terminalExecution(job.state)) { job.state = "failed"; job.error = "The owner's provider could not complete this request. Review its local task."; job.updatedAt = Date.now(); this.save(); } }).catch(() => { /* The sticky write error disables further dispatch. */ });
        } else if (job.threadId && job.state !== "starting") {
          const result = this.options.runtime.inspect(job);
          if (!result.busy) {
            job.state = job.state === "cancel-requested" ? "cancelled" : result.succeeded ? "succeeded" : "failed";
            job.result = portable(result.result); job.usage = result.usage; job.updatedAt = Date.now(); this.save();
          } else if (job.state !== "cancel-requested") {
            const next = result.waiting ? "awaiting-tool-approval" : "running";
            if (job.state !== next) { job.state = next; job.updatedAt = Date.now(); this.save(); }
          }
        }
      }
      const pending = this.data.outgoing.filter(value => !terminalExecution(value.state));
      const chosen = pending.length ? [pending[this.pollRotation++ % pending.length]!] : [];
      for (const job of chosen) {
        const key = `poll:${job.id}`; if (this.working.has(key)) continue;
        this.working.add(key);
        void this.options.service.callExecution(job.groupId, job.ownerKey, { op: "read", id: job.id }).then(reply => {
          if (reply.kind === "job") this.updateOutgoing(job, reply.job);
        }).catch(error => {
          // Keep the last known outcome; a failed status read never replays work.
          const warning = `warning:${job.id}`;
          if (Date.now() - (this.checked.get(warning) ?? 0) > 30_000) {
            this.checked.set(warning, Date.now());
            console.warn(`[shared-execution] Status unavailable for ${job.id}: ${redactSecretsInText(error instanceof Error ? error.message : "Peer unavailable").slice(0, 300)}`);
          }
        }).finally(() => this.working.delete(key));
      }
    } catch { /* Fail closed; queued work is revalidated next tick. */ }
    finally { this.ticking = false; }
  }
  close() { this.closed = true; clearInterval(this.timer); }
}
