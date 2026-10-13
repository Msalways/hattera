import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import knex from "knex";
import { expect, it } from "vitest";
import { migratePostgres } from "../postgres-schema.ts";
import { createDataEngine } from "./engine.ts";

const url = process.env.OMB_TEST_DATABASE_URL;

it.skipIf(!url)("keeps bot Data tables and results in PostgreSQL across engine restarts", async () => {
  const parsed = new URL(url!);
  if (parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/ombtest") {
    throw new Error("OMB_TEST_DATABASE_URL must point to the disposable 127.0.0.1/ombtest database");
  }
  const dir = mkdtempSync(join(tmpdir(), "omb-pg-data-"));
  const botId = randomUUID();
  const otherBotId = randomUUID();
  const owner = knex({ client: "pg", connection: url, pool: { min: 0, max: 2 } });
  try { await migratePostgres(owner); } finally { await owner.destroy(); }
  // Keep DuckDB's loaded extension DLL outside the disposable bot folder on Windows.
  const extensionCache = join(process.cwd(), "node_modules", ".cache", "omb-duckdb-pg-test");
  const open = () => createDataEngine({ postgresUrl: url, dataDir: extensionCache, botFolder: (id) => join(dir, id) });
  const first = open();
  try {
    const db = await first.forBot(botId);
    await db.run("CREATE TABLE events AS SELECT 1 AS id, 'durable' AS name", { connection: "bot" });
    expect((await db.materialise("SELECT * FROM events", "q_1", { connection: "bot" })).rowCount).toBe(1);
    expect(await db.listTables()).toMatchObject([{ name: "events", rowCount: 1 }]);
    await expect(db.run("SELECT * FROM postgres_query('bot_data', 'SELECT * FROM omb_documents')", { connection: "bot" }))
      .rejects.toThrow(/permission denied/);
    const other = await first.forBot(otherBotId);
    expect(await other.listTables()).toEqual([]);
    const firstSchema = `omb_data_${createHash("sha256").update(botId).digest("hex").slice(0, 32)}`;
    await expect(other.run(`SELECT * FROM postgres_query('bot_data', 'SELECT * FROM ${firstSchema}.events')`, { connection: "bot" }))
      .rejects.toThrow(/permission denied/);
    await first.deleteBot(otherBotId);
  } finally { await first.closeAll(); }
  const second = open();
  try {
    const db = await second.forBot(botId);
    expect((await db.run("SELECT * FROM events", { connection: "panel" })).rows).toEqual([[1, "durable"]]);
    expect((await db.run("SELECT * FROM omb_results.q_1", { connection: "bot" })).rows).toEqual([[1, "durable"]]);
    expect((await db.page("events", { offset: 0, limit: 10 })).rows).toEqual([[1, "durable"]]);
    await second.deleteBot(botId);
  } finally {
    await second.closeAll();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
