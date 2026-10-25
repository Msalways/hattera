import { readFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";

const RECORD = "hattera-runtime.json";
export interface LocalRuntime { version: 1; nonce: string; pid: number; port: number; environmentId: string }

export function readLocalRuntime(dataDir: string): LocalRuntime | null {
  try {
    const raw = readFileSync(join(dataDir, RECORD), "utf8");
    if (raw.length > 4096) return null;
    const value = JSON.parse(raw);
    return value.version === 1 && typeof value.nonce === "string" && /^[\da-f-]{36}$/i.test(value.nonce)
      && Number.isInteger(value.pid) && value.pid > 0 && value.pid <= 0x7fffffff
      && Number.isInteger(value.port) && value.port > 0 && value.port < 65536
      && typeof value.environmentId === "string" && /^[\da-f-]{36}$/i.test(value.environmentId) ? value : null;
  } catch { return null; }
}

/** Discovery only. The existing data-directory lease remains the sole writer lock. */
export function publishLocalRuntime(dataDir: string, port: number, environmentId: string): () => void {
  const record: LocalRuntime = { version: 1, nonce: randomUUID(), pid: process.pid, port, environmentId };
  writeFileAtomic(join(dataDir, RECORD), JSON.stringify(record) + "\n", { mode: 0o600 });
  return () => {
    if (readLocalRuntime(dataDir)?.nonce === record.nonce) {
      try { unlinkSync(join(dataDir, RECORD)); } catch { /* Already removed during exit. */ }
    }
  };
}

/** Neither a port number nor a live PID proves ownership of this workspace. */
export async function localRuntimeMatches(dataDir: string, port: number, pid?: number): Promise<boolean> {
  try {
    const expected = readFileSync(join(dataDir, "environment-id"), "utf8").trim();
    if (!/^[\da-f-]{36}$/i.test(expected)) return false;
    const base = `http://127.0.0.1:${port}`;
    const get = async (path: string) => {
      const response = await fetch(base + path, { redirect: "error", signal: AbortSignal.timeout(1500) });
      if (!response.ok) throw new Error("Runtime is unavailable");
      const value: unknown = await response.json();
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid runtime identity");
      return value as Record<string, unknown>;
    };
    const health = await get("/api/health");
    if (health?.app !== "openmausbot" || pid !== undefined && health.pid !== pid) return false;
    const descriptor = await get("/.well-known/openmausbot/environment");
    return descriptor?.environmentId === expected;
  } catch { return false; }
}

export async function findLocalRuntime(dataDir: string): Promise<LocalRuntime | null> {
  const record = readLocalRuntime(dataDir);
  if (!record || !await localRuntimeMatches(dataDir, record.port, record.pid)) return null;
  // A copied descriptor must not attach to the source installation.
  try { return readFileSync(join(dataDir, "environment-id"), "utf8").trim() === record.environmentId ? record : null; }
  catch { return null; }
}
