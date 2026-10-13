import { randomUUID } from "node:crypto";
import { afterAll, expect, test } from "vitest";
import knex from "knex";
import { migratePostgres } from "./postgres-schema.ts";
import { PostgresSync, setPostgresSync } from "./postgres-sync.ts";
import * as messages from "./message-db.ts";

const url = process.env.OMB_TEST_DATABASE_URL;
const testIfDatabase = url ? test : test.skip;
let bridge: PostgresSync | null = null;
afterAll(async () => { setPostgresSync(null); await bridge?.close(); });

testIfDatabase("synchronous transcript API persists in PostgreSQL across worker restarts", async () => {
  const db = knex({ client: "pg", connection: url });
  try { await migratePostgres(db); } finally { await db.destroy(); }
  bridge = new PostgresSync(url!);
  setPostgresSync(bridge);
  const thread = `sync-${randomUUID()}`;
  const logPath = `events/${thread}.ndjson`;
  bridge.call("file.append", logPath, "{\"step\":1}\n");
  bridge.call("file.append", logPath, "{\"step\":2}\n");
  const message = { id: randomUUID(), role: "user" as const, kind: "text" as const, at: Date.now(), text: "durable bridge proof" };
  messages.appendMessage(thread, message);
  expect(messages.readThread(thread, "unused").messages).toEqual([message]);
  expect(messages.searchMessages("bridge proof", 10, thread)).toHaveLength(1);
  expect(messages.recallMessages("durable", [thread])[0]?.snippet).toContain("[durable]");
  messages.indexMemoryFile(thread, "MEMORY.md", "durable memory fact", { mtimeMs: Date.now(), bytes: 19 });
  expect(messages.recallMemory("durable", thread)[0]?.snippet).toContain("[durable]");
  const first = messages.withCommandReceipt("sync-test", thread, () => {
    messages.insertMessage(thread, { ...message, id: randomUUID(), text: "second line" });
    return '"done"';
  }, Date.now());
  expect(first).toEqual({ result: '"done"', replayed: false });
  expect(messages.withCommandReceipt("sync-test", thread, () => { throw new Error("replayed"); }, Date.now()))
    .toEqual({ result: '"done"', replayed: true });
  setPostgresSync(null);
  await bridge.close();
  bridge = new PostgresSync(url!);
  setPostgresSync(bridge);
  expect(messages.readThread(thread, "unused").messages).toHaveLength(2);
  expect(messages.latestMessageAts([thread]).get(thread)).toBe(message.at);
  const verify = knex({ client: "pg", connection: url });
  try {
    const rows = await verify("omb_file_lines").where("path", logPath).orderBy("seq").select("line") as Array<{ line: string }>;
    expect(rows.map((row) => row.line).join("")).toBe('{"step":1}\n{"step":2}\n');
  } finally { await verify.destroy(); }
  bridge.call("file.remove", logPath);
});
