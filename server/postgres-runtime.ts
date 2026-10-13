import type { Knex } from "knex";
import type { Pool } from "pg";
import type { PostgresSync } from "./postgres-sync.ts";

export interface PostgresRuntime {
  db: Knex;
  pool: Pool;
  bridge: PostgresSync;
  cacheDir: string;
}

let active: PostgresRuntime | null = null;
export function setPostgresRuntime(runtime: PostgresRuntime): void { active = runtime; }
export function postgresRuntime(): PostgresRuntime | null { return active; }
