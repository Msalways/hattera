import { receiveMessageOnPort, MessageChannel, Worker, type MessagePort } from "node:worker_threads";
import { join } from "node:path";
import { existsSync } from "node:fs";

type Reply = { ok: true; value: unknown } | { ok: false; error: string };

/** Compatibility boundary for the server's existing synchronous store API.
 * A query completes in PostgreSQL before the caller can publish its result. */
export class PostgresSync {
  private readonly worker: Worker;
  private readonly port: MessagePort;
  private closing = false;
  private failed = false;

  constructor(url: string) {
    const { port1, port2 } = new MessageChannel();
    const bundled = join(import.meta.dirname, "postgres-sync.worker.js");
    const workerFile = existsSync(bundled) ? bundled : join(import.meta.dirname, "postgres-sync.worker.ts");
    this.port = port1;
    this.worker = new Worker(workerFile, { workerData: { url, port: port2 }, transferList: [port2],
      ...(workerFile.endsWith(".ts") ? { execArgv: ["--experimental-strip-types"] } : {}) });
    this.worker.on("error", (error) => { console.error("PostgreSQL worker failed:", error); process.exit(1); });
    this.worker.on("exit", (code) => { if (code !== 0 && !this.closing) process.exit(1); });
    this.call("ping");
  }

  call<T>(method: string, ...args: unknown[]): T {
    if (this.failed) throw new Error("PostgreSQL worker is unavailable");
    const signal = new Int32Array(new SharedArrayBuffer(4));
    this.port.postMessage({ method, args, signal });
    if (Atomics.wait(signal, 0, 0, 30_000) === "timed-out") {
      this.failed = true;
      throw new Error(`PostgreSQL ${method} timed out`);
    }
    const message = receiveMessageOnPort(this.port);
    if (!message) throw new Error(`PostgreSQL ${method} returned no result`);
    const reply = message.message as Reply;
    if (!reply.ok) throw new Error(`PostgreSQL ${method}: ${reply.error}`);
    return reply.value as T;
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.worker.terminate();
    this.port.close();
  }
}

let active: PostgresSync | null = null;
export function setPostgresSync(bridge: PostgresSync | null): void { active = bridge; }
export function postgresSync(): PostgresSync | null { return active; }
