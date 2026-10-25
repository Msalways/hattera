import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { CollaborationService } from "./collaboration-service.ts";
import { createCollaborationIdentity } from "./collaboration-ledger.ts";
import { sealCollaboration } from "./collaboration-box.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import type { PrivateNetworkState } from "../shared/private-network.ts";

const directories: string[] = [], services: CollaborationService[] = [], servers: Server[] = [];
afterEach(async () => {
  services.splice(0).forEach(service => service.close());
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
  await Promise.all(directories.splice(0).map(removeTempDir));
});
const peers = new Map<string, string>();
async function fixture(address: string) {
  const directory = mkdtempSync(join(tmpdir(), "hattera-group-service-")); directories.push(directory);
  let online = true, loseReply = false;
  const network = {
    async status(): Promise<PrivateNetworkState> { return { available: true, enabled: online, state: online ? "connected" : "disconnected", origin: online ? address : null, peerTransport: true, authorizationUrl: null, message: null, peers: [] }; },
    async peer(endpoint: string, body: unknown) {
      if (!online) throw new Error("Fixture offline");
      const target = peers.get(endpoint); if (!target) throw new Error("Fixture peer unavailable");
      const response = await fetch(`${target}/api/collaboration/peer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const result = { status: response.status, body: await response.json() };
      if (loseReply) { loseReply = false; throw new Error("Fixture lost response after durable admission"); }
      return result;
    },
  };
  let service = new CollaborationService({ dataDir: directory, network }); services.push(service);
  const server = createServer(async (req, res) => {
    try {
      if (req.url !== "/api/collaboration/peer" || req.method !== "POST") { res.writeHead(404).end(); return; }
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
      const packet = await service.handlePeer(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(packet));
    } catch { res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "Peer exchange refused" })); }
  }); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`; peers.set(address, url);
  return { directory, url, get service() { return service; }, offline(value: boolean) { online = !value; }, loseReply() { loseReply = true; },
    restart() { service.close(); service = new CollaborationService({ dataDir: directory, network }); services.push(service); } };
}
const post = (text: string) => ({ type: "message.upsert" as const, topicId: "feature", topicTitle: "Feature", messageId: randomUUID(), text, role: "human" as const, authorLabel: "A human" });
function grant(service: CollaborationService, groupId: string, name: string) { return service.ledger(groupId).members().find(member => member.name === name)!.grantId; }

it("three HTTP peers join, synchronize without the creator, recover lost replies and revoke access", async () => {
  const a = await fixture("http://100.64.0.1"), b = await fixture("http://100.64.0.2"), c = await fixture("http://100.64.0.3");
  const group = await a.service.share("local-a", "Shared feature", "Alice");
  const invitation = await a.service.invite(group, "manager");
  await b.service.join(invitation, "local-b", "Bob");
  b.loseReply();
  await expect(b.service.synchronize(group)).rejects.toThrow(/lost response/);
  expect(a.service.ledger(group).members()).toHaveLength(2);
  b.restart();
  await b.service.synchronize(group);
  expect(b.service.status()[0]?.joining).toBeUndefined();
  expect(a.service.ledger(group).members()).toHaveLength(2);
  // The invitation is single use even if another consenting identity sees it.
  await c.service.join(invitation, "wrong-local-c", "Uninvited identity");
  await expect(c.service.synchronize(group)).rejects.toThrow(/not accepted/);
  expect(a.service.ledger(group).members()).toHaveLength(2);
  // Use a separate fixture after the intentionally refused membership.
  const d = await fixture("http://100.64.0.4");
  a.offline(true);
  await d.service.join(await b.service.invite(group, "manager"), "local-d", "Chris");
  await d.service.synchronize(group);
  const bob = grant(b.service, group, "Bob"), chris = grant(b.service, group, "Chris");
  b.service.append(group, post("Bob while Alice is offline"));
  d.service.append(group, post("Chris while Alice is offline"));
  await d.service.synchronize(group, bob);
  await b.service.synchronize(group, chris);
  expect(b.service.ledger(group).messages().map(event => event.id)).toEqual(d.service.ledger(group).messages().map(event => event.id));
  expect(d.service.ledger(group).messages()).toHaveLength(2);
  b.restart();
  await b.service.synchronize(group, chris);
  expect(b.service.ledger(group).messages()).toHaveLength(2);
  expect(readFileSync(join(b.directory, "collaboration/index.json"), "utf8")).not.toContain(JSON.parse(Buffer.from(invitation, "base64url").toString()).token);
  a.offline(false);
  await b.service.synchronize(group, group);
  expect(a.service.ledger(group).messages()).toHaveLength(2);
  a.service.revoke(group, bob);
  a.service.append(group, post("Private content after removal"));
  const before = a.service.ledger(group).events.length;
  b.service.append(group, post("Must not be admitted after removal"));
  await expect(b.service.synchronize(group, group)).rejects.toThrow(/not accepted/);
  await expect(d.service.synchronize(group, group)).rejects.toThrow(/not accepted/);
  expect(b.service.ledger(group).localGrant()).toBeUndefined();
  expect(d.service.ledger(group).localGrant()).toBeUndefined();
  expect(b.service.ledger(group).messages().some(event => event.payload.type === "message.upsert" && event.payload.text === "Private content after removal")).toBe(false);
  expect(a.service.ledger(group).events).toHaveLength(before);
  // No group packet is authorized by app session, tailnet IP or forged key.
  const stranger = createCollaborationIdentity(), owner = a.service.ledger(group).members()[0]!;
  const packet = await sealCollaboration(stranger, owner.encryptionKey, group, { version: 1, groupId: group, nonce: randomUUID(), at: Date.now(), request: { action: "sync", grantId: group, cursors: {}, events: [] } });
  expect((await fetch(`${a.url}/api/collaboration/peer`, { method: "POST", body: JSON.stringify(packet) })).status).toBe(403);
  expect(a.service.ledger(group).events).toHaveLength(before);
}, 20_000);

it("bootstraps membership before a large history and preserves pending join across restart", async () => {
  const a = await fixture("http://100.64.1.1"), b = await fixture("http://100.64.1.2");
  const group = await a.service.share("a", "Long lived group", "Alice");
  for (let i = 0; i < 105; i++) a.service.append(group, { type: "member.address", endpoint: "http://100.64.1.1" });
  for (let i = 0; i < 4; i++) a.service.append(group, post("x".repeat(60_000)));
  await b.service.join(await a.service.invite(group), "b", "Bob");
  await b.service.synchronize(group);
  expect(b.service.status()[0]?.joining).toBe(true);
  expect(b.service.ledger(group).messages()).toHaveLength(0);
  b.restart(); await b.service.synchronize(group);
  expect(b.service.status()[0]?.joining).toBeUndefined();
  expect(b.service.ledger(group).messages()).toHaveLength(0);
  await b.service.synchronize(group, group);
  expect(b.service.ledger(group).messages()).toHaveLength(4);
  await expect(b.service.invite(group)).rejects.toThrow(/manager/);
  b.service.setEnabled(group, false);
  await expect(b.service.synchronize(group, group)).rejects.toThrow(/paused/);
  b.restart(); expect(b.service.status()[0]?.enabled).toBe(false);
  unlinkSync(join(b.directory, "collaboration/identity.json"));
  b.restart();
  expect(b.service.status()[0]).toMatchObject({ blocked: true, error: expect.stringMatching(/identity needs repair/) });
  await expect(b.service.synchronize(group, group)).rejects.toThrow(/paused/);
  await expect(b.service.share("other", "Other group", "Bob")).rejects.toThrow(/identity needs repair/);
}, 20_000);
