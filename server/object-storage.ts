import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

const ATTACHMENT_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-z0-9]+$/i;
const BACKUP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Optional offsite copies. Local file paths remain authoritative for agent CLIs. */
export class S3ObjectStorage {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly copied = new Map<string, { size: number; modified: number }>();
  constructor(client: S3Client, bucket: string, prefix: string) {
    this.client = client;
    this.bucket = bucket;
    this.prefix = prefix;
  }

  private key(kind: "uploads" | "backups", name: string): string {
    return [this.prefix, kind, name].filter(Boolean).join("/");
  }

  private async upload(path: string, key: string): Promise<void> {
    const stat = statSync(path);
    const size = stat.size;
    const previous = this.copied.get(key);
    if (previous?.size === size && previous.modified === stat.mtimeMs) return;
    const digest = await sha256(path);
    try {
      const remote = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      if (remote.ContentLength === size && remote.Metadata?.sha256 === digest) {
        this.copied.set(key, { size, modified: stat.mtimeMs });
        return;
      }
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status !== 404) throw error;
    }
    await new Upload({ client: this.client, params: {
      Bucket: this.bucket, Key: key, Body: createReadStream(path), ContentLength: size,
      Metadata: { sha256: digest },
    }, leavePartsOnError: false }).done();
    this.copied.set(key, { size, modified: stat.mtimeMs });
  }

  async uploadAttachment(path: string): Promise<void> {
    const name = basename(path);
    if (!ATTACHMENT_NAME.test(name)) throw new Error("Invalid attachment name for object storage");
    await this.upload(path, this.key("uploads", name));
  }

  async uploadBackup(id: string, path: string): Promise<void> {
    if (!BACKUP_ID.test(id) || basename(path) !== "workspace.ombbackup") {
      throw new Error("Invalid workspace backup for object storage");
    }
    await this.upload(path, this.key("backups", `${id}.ombbackup`));
  }

  async mirrorAttachments(directory: string): Promise<number> {
    if (!existsSync(directory)) return 0;
    let mirrored = 0;
    let failed = 0;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !ATTACHMENT_NAME.test(entry.name)) continue;
      try {
        await this.uploadAttachment(join(directory, entry.name));
        mirrored++;
      } catch { failed++; }
    }
    if (failed) throw new Error(`${failed} attachment object copy/copies failed`);
    return mirrored;
  }

  destroy(): void { this.client.destroy(); }
}

/** No provider-specific values are baked in; any S3-compatible endpoint works. */
export function objectStorageFromEnv(env: NodeJS.ProcessEnv = process.env): S3ObjectStorage | null {
  const kind = env.OMB_OBJECT_STORAGE_KIND?.trim() || "local";
  if (kind === "local") return null;
  if (kind !== "s3") throw new Error("OMB_OBJECT_STORAGE_KIND must be local or s3");
  const bucket = env.OMB_S3_BUCKET?.trim();
  const region = env.OMB_S3_REGION?.trim();
  const accessKeyId = env.OMB_S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.OMB_S3_SECRET_ACCESS_KEY?.trim();
  const prefix = env.OMB_S3_PREFIX?.trim().replace(/^\/+|\/+$/g, "") ?? "";
  if (!bucket || !region || !accessKeyId || !secretAccessKey) {
    throw new Error("S3 object storage requires bucket, region, access key ID and secret access key");
  }
  if (prefix && prefix.split("/").some((part) => !/^[A-Za-z0-9._-]+$/.test(part) || part === "." || part === "..")) {
    throw new Error("OMB_S3_PREFIX must contain only safe path segments");
  }
  const rawEndpoint = env.OMB_S3_ENDPOINT?.trim();
  if (rawEndpoint) {
    const endpoint = new URL(rawEndpoint);
    if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["127.0.0.1", "localhost"].includes(endpoint.hostname))) {
      throw new Error("OMB_S3_ENDPOINT must use HTTPS, except for loopback testing");
    }
  }
  const client = new S3Client({
    region, ...(rawEndpoint ? { endpoint: rawEndpoint } : {}), forcePathStyle: env.OMB_S3_FORCE_PATH_STYLE !== "false",
    credentials: { accessKeyId, secretAccessKey }, requestChecksumCalculation: "WHEN_REQUIRED",
  });
  return new S3ObjectStorage(client, bucket, prefix);
}
