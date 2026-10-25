import { randomUUID, createHash } from "node:crypto";
import { mkdtempSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { CollaborationLedger, createCollaborationIdentity, signedJoinProposal, signCollaboration, collaborationJson } from "./collaboration-ledger.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import type { CollaborationEvent, CollaborationPayload } from "../shared/collaboration.ts";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(removeTempDir)); });
function directory() { const path = mkdtempSync(join(tmpdir(), "hattera-peer-ledger-")); dirs.push(path); return path; }
const message = (text: string): CollaborationPayload => ({ type: "message.upsert", topicId: "topic", topicTitle: "A feature", messageId: randomUUID(), text, role: "human", authorLabel: "A person" });
function add(manager: CollaborationLedger, identity: ReturnType<typeof createCollaborationIdentity>, name: string) {
  const grantId = randomUUID();
  const consent = signedJoinProposal(identity, { groupId: manager.groupId, invitationId: randomUUID(), name, endpoint: "http://100.64.0.2", at: Date.now(), nonce: randomUUID() });
  manager.append({ type: "member.added", grantId, role: "manager", ...consent });
  return grantId;
}
function replicate(from: CollaborationLedger, to: CollaborationLedger) { return to.receive(from.delta(to.cursors())); }

it("three independent ledgers merge concurrent messages and assignments while the creator is offline", () => {
  const alice = createCollaborationIdentity(), bob = createCollaborationIdentity(), chris = createCollaborationIdentity();
  const a = CollaborationLedger.create({ directory: directory(), identity: alice, name: "Feature group", memberName: "Alice", endpoint: "http://100.64.0.1" });
  add(a, bob, "Bob");
  const b = new CollaborationLedger({ directory: directory(), identity: bob, groupId: a.groupId, rootKey: alice.publicKey });
  replicate(a, b);
  // Alice is now absent. Bob can invite another consenting human and both
  // installations retain their own group data and signing identities.
  add(b, chris, "Chris");
  const c = new CollaborationLedger({ directory: directory(), identity: chris, groupId: a.groupId, rootKey: alice.publicKey });
  replicate(b, c);
  b.append(message("Bob's independent message")); c.append(message("Chris's independent message"));
  replicate(b, c); replicate(c, b);
  expect(b.messages().map(event => event.id)).toEqual(c.messages().map(event => event.id));
  expect(b.messages()).toHaveLength(2);
  expect(replicate(c, b)).toBe(0);
  const one = randomUUID(), two = randomUUID();
  b.append({ type: "task.assignment", taskId: "feature", assignmentId: one, supersedes: [], assignee: bob.publicKey });
  c.append({ type: "task.assignment", taskId: "feature", assignmentId: two, supersedes: [], assignee: chris.publicKey });
  replicate(b, c); replicate(c, b);
  expect(b.assignment("feature").state).toBe("conflict");
  expect(c.assignment("feature").state).toBe("conflict");
  b.append({ type: "task.assignment", taskId: "feature", assignmentId: randomUUID(), supersedes: [one, two], assignee: chris.publicKey });
  replicate(b, c);
  expect(c.assignment("feature").state).toBe("assigned");
  expect(c.assignment("feature").heads).toHaveLength(1);
  const reloaded = new CollaborationLedger(b.options);
  expect(reloaded.cursors()).toEqual(b.cursors());
  expect(reloaded.members()).toHaveLength(3);
  expect(reloaded.messages()).toEqual(b.messages());
  expect(reloaded.assignment("feature")).toEqual(b.assignment("feature"));
  replicate(b, a);
  const grant = a.members().find(member => member.publicKey === bob.publicKey)!;
  a.append({ type: "member.revoked", grantId: grant.grantId, cutoffs: a.cursors() });
  replicate(a, b); replicate(a, c);
  expect(b.localGrant()).toBeUndefined(); expect(c.localGrant()).toBeUndefined();
  expect(() => b.append(message("Do not send after revocation"))).toThrow(/no longer belongs/);
  expect(c.messages()).toHaveLength(2);
});

it("rejects forged, out-of-order and conflicting events without overwriting durable history", () => {
  const identity = createCollaborationIdentity();
  const a = CollaborationLedger.create({ directory: directory(), identity, name: "Private group", memberName: "Owner", endpoint: "http://100.64.0.1" });
  const b = new CollaborationLedger({ directory: directory(), identity: createCollaborationIdentity(), groupId: a.groupId, rootKey: identity.publicKey });
  replicate(a, b);
  const first = a.append(message("First")), second = a.append(message("Second"));
  expect(() => b.receive([second])).toThrow(/missing/);
  expect(() => b.receive([{ ...first, payload: message("Forged") }])).toThrow(/signature/);
  b.receive([first, second]);
  const { id: _id, signature: _signature, ...body } = second;
  const changed = { ...body, payload: message("Authentic fork") };
  const fork = { ...changed, id: createHash("sha256").update(collaborationJson(changed)).digest("hex"), signature: signCollaboration(identity, changed) };
  expect(() => b.receive([fork])).toThrow(/Conflicting/);
  expect(b.messages()).toHaveLength(2);
  expect(readFileSync(join(b.options.directory, `${a.groupId}.jsonl`), "utf8")).not.toContain("Authentic fork");
  expect(() => b.receive([{ ...second, providerKey: "must-not-store" }])).toThrow();
});

it("requires fresh peer consent for each grant and fails closed on an interrupted log", () => {
  const identity = createCollaborationIdentity(), peer = createCollaborationIdentity();
  const a = CollaborationLedger.create({ directory: directory(), identity, name: "Group", memberName: "Owner", endpoint: "http://100.64.0.1" });
  add(a, peer, "Peer");
  const added = a.events.at(-1)!;
  expect(added.payload.type).toBe("member.added");
  if (added.payload.type !== "member.added") throw new Error("Missing grant");
  const payload = added.payload;
  expect(() => a.append({ ...payload, grantId: randomUUID() })).toThrow(/consent/);
  const invalidClock: CollaborationEvent = { ...added, lamport: Number.MAX_SAFE_INTEGER };
  expect(() => a.receive([invalidClock])).toThrow();
  appendFileSync(join(a.options.directory, `${a.groupId}.jsonl`), "{interrupted");
  expect(() => new CollaborationLedger(a.options)).toThrow(/interrupted write/);
});
