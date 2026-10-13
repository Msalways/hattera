import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import knex from "knex";
import { Pool } from "pg";

import { setStructuredDocumentSink } from "./atomic.ts";
import { postgresConnectionUrl } from "./postgres-config.ts";
import { migratePostgres } from "./postgres-schema.ts";
import { setPostgresRuntime } from "./postgres-runtime.ts";
import { PostgresSync, setPostgresSync } from "./postgres-sync.ts";

function validCachePath(path: string): boolean {
  return path.length > 0 && !isAbsolute(path) && !path.includes("\\") && !path.includes(":")
    && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

const url = postgresConnectionUrl(process.env);
if (url) {
  const db = knex({ client: "pg", connection: url, pool: { min: 0, max: 5 } });
  try {
    await migratePostgres(db);
    const environmentId = randomUUID();
    await db("omb_documents").insert({ path: "environment-id", value: JSON.stringify({ text: `${environmentId}\n` }), updated_at: Date.now() })
      .onConflict("path").ignore();
    const cacheDir = mkdtempSync(join(tmpdir(), "omb-postgres-"));
    process.env.OMB_DATA_DIR = cacheDir;
    const docs = await db<{ path: string; value: { text?: unknown } }>("omb_documents").select("path", "value");
    for (const { path, value } of docs) {
      if (typeof value?.text !== "string") continue;
      if (!validCachePath(path)) {
        throw new Error("PostgreSQL contains an invalid document path");
      }
      const destination = join(cacheDir, path);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      writeFileSync(destination, value.text, { mode: 0o600 });
      chmodSync(destination, 0o600);
    }
    const lines = await db<{ path: string; line: string }>("omb_file_lines").orderBy("seq").select("path", "line");
    for (const { path, line } of lines) {
      if (!validCachePath(path)) {
        throw new Error("PostgreSQL contains an invalid log path");
      }
      const destination = join(cacheDir, path);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      appendFileSync(destination, line, { mode: 0o600 });
    }
    const bridge = new PostgresSync(url);
    setPostgresSync(bridge);
    setStructuredDocumentSink(cacheDir, {
      write: (path, text) => bridge.call("document.write", path, { text }),
      remove: (path) => bridge.call("document.remove", path),
      removePrefix: (prefix) => bridge.call("document.removePrefix", prefix),
      append: (path, text) => bridge.call("file.append", path, text),
      replaceLog: (path, text) => bridge.call("file.replace", path, text),
      removeLog: (path) => bridge.call("file.remove", path),
      removeLogPrefix: (prefix) => bridge.call("file.removePrefix", prefix),
    });
    setPostgresRuntime({ db, pool: new Pool({ connectionString: url, max: 3 }), bridge, cacheDir });
  } catch (error) {
    await db.destroy();
    throw error;
  }
}

await import("./runtime.ts");
