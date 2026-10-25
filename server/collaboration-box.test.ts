import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createCollaborationIdentity } from "./collaboration-ledger.ts";
import { openCollaboration, sealCollaboration } from "./collaboration-box.ts";

it("discloses a group payload only to its pinned recipient and authenticates both peers", async () => {
  const a = createCollaborationIdentity(), b = createCollaborationIdentity(), other = createCollaborationIdentity();
  const groupId = randomUUID();
  const packet = await sealCollaboration(a, b.encryptionPublicKey, groupId, { text: "Only this group", requestNonce: randomUUID() });
  expect(JSON.stringify(packet)).not.toContain("Only this group");
  expect(await openCollaboration(b, packet, a.publicKey)).toMatchObject({ groupId, sender: a.publicKey, value: { text: "Only this group" } });
  await expect(openCollaboration(other, packet)).rejects.toThrow(/recipient/);
  await expect(openCollaboration(b, packet, other.publicKey)).rejects.toThrow(/sender/);
  await expect(openCollaboration(b, { ...packet, groupId: randomUUID() })).rejects.toThrow();
  await expect(openCollaboration(b, { ...packet, ciphertext: packet.ciphertext.slice(4) })).rejects.toThrow();
  await expect(openCollaboration(b, { ...packet, from: other.publicKey })).rejects.toThrow();
  expect((await sealCollaboration(a, b.encryptionPublicKey, groupId, { text: "Only this group" })).enc).not.toBe(packet.enc);
});
