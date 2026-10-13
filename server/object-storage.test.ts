import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { objectStorageFromEnv } from "./object-storage.ts";

let server: Server | undefined;
let directory: string | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  if (directory) rmSync(directory, { recursive: true, force: true });
  server = undefined;
  directory = undefined;
});

it("requires complete S3 configuration and a secure remote endpoint", () => {
  expect(objectStorageFromEnv({})).toBeNull();
  expect(() => objectStorageFromEnv({ OMB_OBJECT_STORAGE_KIND: "s3" })).toThrow(/requires bucket/);
  expect(() => objectStorageFromEnv({
    OMB_OBJECT_STORAGE_KIND: "s3", OMB_S3_BUCKET: "private", OMB_S3_REGION: "us-east-1",
    OMB_S3_ACCESS_KEY_ID: "key", OMB_S3_SECRET_ACCESS_KEY: "secret",
    OMB_S3_ENDPOINT: "http://public.example.com",
  })).toThrow(/HTTPS/);
});

it("copies uploads and backup exports to a private S3-compatible endpoint", async () => {
  const objects = new Map<string, { body: Buffer; hash: string }>();
  let puts = 0;
  server = createServer(async (req, res) => {
    const key = new URL(req.url!, "http://localhost").pathname;
    if (req.method === "HEAD") {
      const object = objects.get(key);
      if (!object) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-length": object.body.length, "x-amz-meta-sha256": object.hash });
      res.end();
      return;
    }
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      objects.set(key, { body: Buffer.concat(chunks), hash: String(req.headers["x-amz-meta-sha256"]) });
      puts++;
      res.writeHead(200, { etag: '"fixture"' });
      res.end();
      return;
    }
    res.writeHead(405); res.end();
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  const storage = objectStorageFromEnv({
    OMB_OBJECT_STORAGE_KIND: "s3", OMB_S3_BUCKET: "private", OMB_S3_REGION: "us-east-1",
    OMB_S3_ACCESS_KEY_ID: "key", OMB_S3_SECRET_ACCESS_KEY: "secret", OMB_S3_PREFIX: "test",
    OMB_S3_ENDPOINT: `http://127.0.0.1:${address.port}`,
  })!;
  try {
    directory = mkdtempSync(join(tmpdir(), "omb-s3-test-"));
    const id = randomUUID();
    const attachment = join(directory, `${id}.txt`);
    const backup = join(directory, "workspace.ombbackup");
    writeFileSync(attachment, "upload bytes");
    writeFileSync(backup, "encrypted backup bytes");
    await storage.uploadAttachment(attachment);
    await storage.uploadAttachment(attachment);
    await storage.uploadBackup(id, backup);
    expect(puts).toBe(2);
    expect(objects.get(`/private/test/uploads/${id}.txt`)?.body.toString()).toBe("upload bytes");
    expect(objects.get(`/private/test/backups/${id}.ombbackup`)?.body.toString()).toBe("encrypted backup bytes");
  } finally { storage.destroy(); }
});
