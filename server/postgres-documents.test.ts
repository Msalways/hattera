import { randomUUID } from "node:crypto";
import knex from "knex";
import { expect, it } from "vitest";
import { PostgresDocuments } from "./postgres-documents.ts";
import { migratePostgres } from "./postgres-schema.ts";

const url = process.env.OMB_TEST_DATABASE_URL;

it.skipIf(!url)("persists named JSON records across PostgreSQL connections", async () => {
  const parsed = new URL(url!);
  if (parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/ombtest") {
    throw new Error("OMB_TEST_DATABASE_URL must point to the disposable 127.0.0.1/ombtest database");
  }
  const key = `test/${randomUUID()}`;
  const open = () => knex({ client: "pg", connection: url, pool: { min: 0, max: 2 } });
  const first = open();
  try {
    await migratePostgres(first);
    const documents = new PostgresDocuments(first);
    expect(await documents.read(key)).toBeUndefined();
    await documents.write(key, { bots: ["one"], nested: { enabled: true } });
  } finally { await first.destroy(); }
  const second = open();
  try {
    expect(await migratePostgres(second)).toEqual([]);
    const documents = new PostgresDocuments(second);
    expect(await documents.read(key)).toEqual({ bots: ["one"], nested: { enabled: true } });
    await documents.write(key, { bots: ["two"] });
    expect(await documents.read(key)).toEqual({ bots: ["two"] });
    await documents.remove(key);
    expect(await documents.read(key)).toBeUndefined();
  } finally { await second.destroy(); }
});
