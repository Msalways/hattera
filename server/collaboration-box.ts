import { createPrivateKey, createPublicKey } from "node:crypto";
import { Aes256Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/core";
import { z } from "zod";
import { collaborationJson, signCollaboration, verifyCollaboration, type CollaborationIdentity } from "./collaboration-ledger.ts";

const key = z.string().regex(/^[A-Za-z0-9+/]{59}=$/);
const header = z.object({ version: z.literal(1), groupId: z.string().uuid(), from: key, to: key }).strict();
const packetSchema = header.extend({ ciphertext: z.string().max(768 * 1024).regex(/^[A-Za-z0-9+/]*={0,2}$/),
  enc: z.string().regex(/^[A-Za-z0-9+/]{43}=$/), signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/) }).strict();
const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });
const INFO = new TextEncoder().encode("Hattera peer exchange v1");
const publicKey = async (key: string) => {
  const parsed = createPublicKey({ key: Buffer.from(key, "base64"), format: "der", type: "spki" });
  if (parsed.asymmetricKeyType !== "x25519") throw new Error("The recipient has no valid peer encryption key.");
  return suite.kem.importKey("jwk", parsed.export({ format: "jwk" }), true);
};

/** Signed, recipient-encrypted group packets. Tailnet connectivity alone does
 * not authenticate the application or authorize disclosure of a group. */
export async function sealCollaboration(identity: CollaborationIdentity, recipient: string, groupId: string, value: unknown) {
  const plaintext = Buffer.from(collaborationJson(value));
  if (plaintext.length > 512 * 1024) throw new Error("This group exchange exceeds the supported packet size.");
  const meta = header.parse({ version: 1, groupId, from: identity.publicKey, to: recipient });
  const sealed = await suite.seal({ recipientPublicKey: await publicKey(recipient), info: INFO }, plaintext, Buffer.from(collaborationJson(meta)));
  const packet = { ...meta, ciphertext: Buffer.from(sealed.ct).toString("base64"), enc: Buffer.from(sealed.enc).toString("base64") };
  return { ...packet, signature: signCollaboration(identity, packet) };
}

export async function openCollaboration(identity: CollaborationIdentity, raw: unknown, expectedSender?: string): Promise<{ groupId: string; sender: string; value: unknown }> {
  const packet = packetSchema.parse(raw);
  const { signature, ciphertext, enc, ...meta } = packet;
  if (packet.to !== identity.encryptionPublicKey || expectedSender && packet.from !== expectedSender
    || !verifyCollaboration(packet.from, { ...meta, ciphertext, enc }, signature)) throw new Error("This peer exchange has an invalid sender or recipient.");
  const key = createPrivateKey({ key: Buffer.from(identity.encryptionPrivateKey, "base64"), format: "der", type: "pkcs8" });
  if (key.asymmetricKeyType !== "x25519") throw new Error("Invalid peer encryption key.");
  const recipientKey = await suite.kem.importKey("jwk", key.export({ format: "jwk" }), false);
  const plaintext = Buffer.from(await suite.open({ recipientKey, enc: Buffer.from(enc, "base64"), info: INFO }, Buffer.from(ciphertext, "base64"), Buffer.from(collaborationJson(meta))));
  if (plaintext.length > 512 * 1024) throw new Error("This peer exchange exceeds the supported packet size.");
  return { groupId: packet.groupId, sender: packet.from, value: JSON.parse(plaintext.toString("utf8")) };
}
