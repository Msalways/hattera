import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import knex from "knex";
import { postgresConnectionUrl } from "./postgres-config.ts";
import { migratePostgres } from "./postgres-schema.ts";

export async function runPostgresMigrations(env: NodeJS.ProcessEnv): Promise<string[]> {
  const connection = postgresConnectionUrl(env);
  if (!connection) throw new Error("Set OMB_POSTGRES_ENABLED=true and DATABASE_URL to prepare PostgreSQL");
  const db = knex({ client: "pg", connection, pool: { min: 0, max: 4 }, acquireConnectionTimeout: 15_000 });
  try { return await migratePostgres(db); }
  finally { await db.destroy(); }
}

function isEntry(): boolean {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]!))).href; }
  catch { return false; }
}

if (isEntry()) {
  void runPostgresMigrations(process.env)
    .then((names) => console.log(`[postgres] ${names.length} schema migration(s) applied`))
    .catch((error: unknown) => {
      const code = error && typeof error === "object" && "code" in error ? ` (${String(error.code)})` : "";
      console.error(`[postgres] migration failed${code}; check OMB_POSTGRES_ENABLED, DATABASE_URL, and database availability`);
      process.exitCode = 1;
    });
}
