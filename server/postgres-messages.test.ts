import { randomUUID } from "node:crypto";
import knex from "knex";
import { expect, it } from "vitest";
import type { Message } from "./store.ts";
import { PostgresMessages } from "./postgres-messages.ts";
import { migratePostgres } from "./postgres-schema.ts";

const url = process.env.OMB_TEST_DATABASE_URL;

it.skipIf(!url)("keeps transcript order, branch head, and updates across PostgreSQL connections", async () => {
  const parsed = new URL(url!);
  if (parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/ombtest") {
    throw new Error("OMB_TEST_DATABASE_URL must point to the disposable 127.0.0.1/ombtest database");
  }
  const threadId = `test-${randomUUID()}`;
  const message = (id: string, text = id) => ({ id, at: 123, role: "user", kind: "text", text }) as Message;
  const open = () => knex({ client: "pg", connection: url, pool: { min: 0, max: 2 } });
  const first = open();
  try {
    await migratePostgres(first);
    const transcripts = new PostgresMessages(first);
    await transcripts.appendMessage(threadId, message("z"));
    await transcripts.appendMessage(threadId, message("a"));
    await expect(transcripts.appendMessage(threadId, { ...message("bad"), kind: undefined } as unknown as Message)).rejects.toThrow();
    await transcripts.insertMessage(threadId, message("z", "edited"));
    expect(await transcripts.readThreadTail(threadId, 1)).toMatchObject({
      messages: [{ id: "a" }], activeLeafId: "a", hasMore: true,
    });
  } finally { await first.destroy(); }
  const second = open();
  try {
    const transcripts = new PostgresMessages(second);
    expect(await transcripts.readThread(threadId)).toMatchObject({
      messages: [{ id: "z", text: "edited" }, { id: "a" }], activeLeafId: "a",
    });
    await transcripts.updateMessage(threadId, message("a", "changed"));
    await transcripts.setActiveLeaf(threadId, "z");
    expect(await transcripts.readThread(threadId)).toMatchObject({
      messages: [{ id: "z" }, { id: "a", text: "changed" }], activeLeafId: "z",
    });
    await transcripts.deleteThread(threadId);
    expect(await transcripts.readThread(threadId)).toEqual({ messages: [], activeLeafId: null });
  } finally { await second.destroy(); }
});
