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

it.skipIf(!url)("persists followups and receipts atomically across PostgreSQL connections", async () => {
  const parsed = new URL(url!);
  if (parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/ombtest") {
    throw new Error("OMB_TEST_DATABASE_URL must point to the disposable 127.0.0.1/ombtest database");
  }
  const threadId = `test-${randomUUID()}`;
  const receiptKey = randomUUID();
  const followupId = randomUUID();
  const open = () => knex({ client: "pg", connection: url, pool: { min: 0, max: 2 } });
  const first = open();
  try {
    await migratePostgres(first);
    const transcripts = new PostgresMessages(first);
    await transcripts.saveChatFollowup({ id: followupId, kind: "bot", ownerId: "owner", threadId,
      payload: { text: "waiting", sendId: "send" } });
    await expect(transcripts.withCommandReceipt("send", receiptKey, async (transaction) => {
      await transcripts.insertMessage(threadId, { id: "bad", at: 1, role: "user", kind: undefined } as unknown as Message, transaction);
      return "should not commit";
    }, 1)).rejects.toThrow();
    expect(await transcripts.readCommandReceipt("send", receiptKey)).toBeNull();
    const firstResult = await transcripts.withCommandReceipt("send", receiptKey, async (transaction) => {
      await transcripts.insertMessage(threadId, { id: "one", at: 1, role: "user", kind: "text", text: "hello", sendId: "send" } as Message, transaction);
      return JSON.stringify({ ok: true });
    }, 1);
    expect(firstResult).toEqual({ result: '{"ok":true}', replayed: false });
    expect(await transcripts.withCommandReceipt("send", receiptKey, async () => { throw new Error("replayed command ran"); }, 1))
      .toEqual({ result: '{"ok":true}', replayed: true });
    expect(await transcripts.latestMessageAts([threadId])).toEqual(new Map([[threadId, 1]]));
    expect(await transcripts.latestMessageAts([threadId], true)).toEqual(new Map([[threadId, 1]]));
    expect(await transcripts.searchMessages("HELLO", 2, threadId)).toMatchObject([{ messageId: "one", snippet: "hello" }]);
    expect(await transcripts.searchMessages("%", 2, threadId)).toEqual([]);
    expect(await transcripts.readMessageText(threadId, "one")).toMatchObject({ text: "hello", at: 1 });
    expect(await transcripts.recentMessages([threadId], { since: 1 }, 2)).toMatchObject([{ messageId: "one" }]);
    await transcripts.indexMemoryFile("bot", `memory/${threadId}.md`, "durable memory", { mtimeMs: 3, bytes: 14 });
    await transcripts.insertMessage(threadId, { id: "two", at: 2, role: "bot", kind: "text", text: "hello from bot" } as Message);
    expect(await transcripts.latestSaidByBot([threadId], "bot", 0)).toMatchObject([{ messageId: "two", head: "hello from bot" }]);
  } finally { await first.destroy(); }
  const second = open();
  try {
    const transcripts = new PostgresMessages(second);
    expect(await transcripts.readCommandReceipt("send", receiptKey)).toMatchObject({ result: '{"ok":true}', at: 1 });
    expect(await transcripts.chatFollowups("bot")).toContainEqual({ id: followupId, kind: "bot", ownerId: "owner",
      threadId, status: "pending", payload: { text: "waiting", sendId: "send" } });
    await transcripts.settleChatFollowups([followupId], "cancelled");
    expect(await transcripts.cancelledChatFollowup("bot", "owner", threadId, "send")).toBe(true);
    expect(await transcripts.threadsReferencing("hello")).toContain(threadId);
    expect(await transcripts.indexedMemoryFiles("bot")).toContainEqual({ path: `memory/${threadId}.md`, mtimeMs: 3, bytes: 14 });
    await transcripts.removeMemoryFile("bot", `memory/${threadId}.md`);
    expect(await transcripts.indexedMemoryFiles("bot")).not.toContainEqual(expect.objectContaining({ path: `memory/${threadId}.md` }));
    await expect(transcripts.importThread(threadId, [], null)).rejects.toThrow("existing conversation");
    await transcripts.deleteThread(threadId);
    expect(await transcripts.chatFollowups("bot")).not.toContainEqual(expect.objectContaining({ id: followupId }));
    const imported = `${threadId}-import`;
    await transcripts.importThread(imported, [{ id: "copied", at: 3, role: "user", kind: "text", text: "backup" } as Message], "copied");
    expect(await transcripts.readThread(imported)).toMatchObject({ messages: [{ id: "copied" }], activeLeafId: "copied" });
    await transcripts.deleteThread(imported);
  } finally { await second.destroy(); }
});
