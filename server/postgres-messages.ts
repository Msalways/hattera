import type { Knex } from "knex";
import type { Message } from "./store.ts";
import type { ChatFollowup, FollowupStatus, StoredCommandReceipt, MemoryFileStat, RecallRange, ThreadLatest } from "./message-db.ts";
import type { SearchHit } from "./message-search-query.ts";
import { peerProvenanceAuthor } from "./peer-provenance.ts";

export interface PostgresThreadRows {
  messages: Message[];
  activeLeafId: string | null;
  hasMore?: boolean;
}

/** PostgreSQL transcript operations; every multi-row mutation is atomic. */
export class PostgresMessages {
  private readonly db: Knex;
  constructor(db: Knex) { this.db = db; }

  private messageRow(threadId: string, message: Message) {
    return {
      thread_id: threadId, id: message.id, at: message.at,
      role: message.role, kind: message.kind, text: message.text ?? null,
      json: JSON.stringify(message),
    };
  }

  private async activeLeaf(threadId: string): Promise<string | null> {
    const row = await this.db<{ active_leaf_id: string | null }>("omb_thread_state")
      .where("thread_id", threadId).first("active_leaf_id");
    return row?.active_leaf_id ?? null;
  }

  async readThread(threadId: string): Promise<PostgresThreadRows> {
    const rows = await this.db<{ json: Message }>("omb_messages")
      .where("thread_id", threadId).orderBy("seq").select("json");
    return { messages: rows.map((row) => row.json), activeLeafId: await this.activeLeaf(threadId) };
  }

  async readThreadTail(threadId: string, limit: number): Promise<PostgresThreadRows> {
    const rows = await this.db<{ json: Message }>("omb_messages")
      .where("thread_id", threadId).orderBy("seq", "desc").limit(limit + 1).select("json");
    const hasMore = rows.length > limit;
    return { messages: rows.slice(0, limit).reverse().map((row) => row.json),
      activeLeafId: await this.activeLeaf(threadId), hasMore };
  }

  async insertMessage(threadId: string, message: Message, db?: Knex.Transaction): Promise<void> {
    if (!db) return this.db.transaction((transaction) => this.insertMessage(threadId, message, transaction));
    await db.raw("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", [`thread:${threadId}`]);
    await db("omb_messages").insert(this.messageRow(threadId, message))
      .onConflict(["thread_id", "id"]).merge(["at", "role", "kind", "text", "json"]);
  }

  async appendMessage(threadId: string, message: Message): Promise<void> {
    await this.db.transaction(async (transaction) => {
      await this.insertMessage(threadId, message, transaction);
      await this.setActiveLeaf(threadId, message.id, transaction);
    });
  }

  /** A backup only populates an empty conversation. */
  async importThread(threadId: string, messages: Message[], activeLeafId: string | null): Promise<void> {
    await this.db.transaction(async (transaction) => {
      // Serialize competing imports even when the thread has no rows yet.
      await transaction.raw("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", [`thread:${threadId}`]);
      const existing = await transaction("omb_messages").where("thread_id", threadId).first("id");
      const state = await transaction("omb_thread_state").where("thread_id", threadId).first("thread_id");
      if (existing || state) throw new Error("Cannot import over an existing conversation");
      for (const message of messages) await this.insertMessage(threadId, message, transaction);
      await this.setActiveLeaf(threadId, activeLeafId, transaction);
    });
  }

  async updateMessage(threadId: string, message: Message): Promise<void> {
    const { thread_id: _threadId, id: _id, ...fields } = this.messageRow(threadId, message);
    await this.db("omb_messages").where({ thread_id: threadId, id: message.id }).update(fields);
  }

  async setActiveLeaf(threadId: string, leafId: string | null, db?: Knex.Transaction): Promise<void> {
    if (!db) return this.db.transaction((transaction) => this.setActiveLeaf(threadId, leafId, transaction));
    await db.raw("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", [`thread:${threadId}`]);
    await db("omb_thread_state").insert({ thread_id: threadId, active_leaf_id: leafId })
      .onConflict("thread_id").merge(["active_leaf_id"]);
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.db.transaction(async (transaction) => {
      await transaction.raw("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", [`thread:${threadId}`]);
      await transaction("omb_chat_followups").where("thread_id", threadId).del();
      await transaction("omb_messages").where("thread_id", threadId).del();
      await transaction("omb_thread_state").where("thread_id", threadId).del();
    });
  }

  async workingGoalRunMessages(): Promise<Array<{ threadId: string; message: Message }>> {
    const rows = await this.db<{ thread_id: string; json: Message }>("omb_messages")
      .where("kind", "goal.run").whereRaw("json->'goalRun'->>'status' = 'working'")
      .select("thread_id", "json");
    return rows.map((row) => ({ threadId: row.thread_id, message: row.json }));
  }

  async latestMessageAts(threadIds: readonly string[], personOnly = false): Promise<Map<string, number>> {
    if (!threadIds.length) return new Map();
    const query = this.db("omb_messages").whereIn("thread_id", [...new Set(threadIds)])
      .groupBy("thread_id").select("thread_id").max("at as at");
    if (personOnly) query.where({ role: "user", kind: "text" })
      .whereRaw("json->>'sendId' IS NOT NULL AND json->'peerAsk' IS NULL AND json->'relayed' IS NULL");
    const rows = await query as Array<{ thread_id: string; at: string }>;
    return new Map(rows.map((row) => [row.thread_id, Number(row.at)]));
  }

  async threadsReferencing(fragment: string): Promise<string[]> {
    if (!fragment) return [];
    const rows = await this.db<{ thread_id: string }>("omb_messages")
      .distinct("thread_id").whereRaw("json::text LIKE ? ESCAPE E'\\\\'", [`%${fragment.replace(/([\\%_])/g, "\\$1")}%`]);
    return rows.map((row) => row.thread_id);
  }

  /** Literal substring search, matching the existing sidebar behavior. */
  async searchMessages(query: string, limit = 40, threadId?: string): Promise<SearchHit[]> {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const pattern = `%${needle.replace(/([\\%_])/g, "\\$1")}%`;
    const rowsQuery = this.db("omb_messages")
      .where((builder) => builder.where((text) => text.where("kind", "text").whereRaw("lower(text) LIKE ? ESCAPE E'\\\\'", [pattern]))
        .orWhere((activity) => activity.where("kind", "activity").whereRaw("lower(json->'tool'->>'name') LIKE ? ESCAPE E'\\\\'", [pattern])))
      .orderBy("at", "desc").limit(limit)
      .select("thread_id", "id", "at", "role", "kind", "text", "json");
    if (threadId) rowsQuery.where("thread_id", threadId);
    const rows = await rowsQuery as Array<{
      thread_id: string; id: string; at: string; role: string; kind: string;
      text: string | null; json: Message;
    }>;
    return rows.map((row) => {
      const haystack = row.kind === "activity" ? (row.json.tool?.name ?? "") : (row.text ?? "");
      const hitAt = Math.max(0, haystack.toLowerCase().indexOf(needle));
      const start = Math.max(0, hitAt - 60);
      const end = Math.min(haystack.length, hitAt + needle.length + 90);
      const snippet = `${start > 0 ? "…" : ""}${haystack.slice(start, end).replace(/\s+/g, " ").trim()}${end < haystack.length ? "…" : ""}`;
      const folded = needle.replace(/\s+/g, " ");
      const matchAt = snippet.toLowerCase().indexOf(folded);
      return { threadId: row.thread_id, messageId: row.id, at: Number(row.at), role: row.role,
        kind: row.kind, snippet, matchStart: matchAt < 0 ? Number(start > 0) : matchAt,
        matchLength: matchAt < 0 ? 0 : folded.length,
        ...(row.json.from?.name ? { from: row.json.from.name } : {}) };
    });
  }

  async readMessageText(threadId: string, messageId: string): Promise<{
    threadId: string; messageId: string; at: number; role: string; text: string; from?: string; peer?: string;
  } | null> {
    const row = await this.db("omb_messages")
      .where({ thread_id: threadId, id: messageId, kind: "text" }).whereNotNull("text")
      .first("at", "role", "text", "json") as { at: string; role: string; text: string; json: Message } | undefined;
    if (!row) return null;
    return { threadId, messageId, at: Number(row.at), role: row.role, text: row.text,
      ...(row.json.from?.name ? { from: row.json.from.name } : {}),
      ...((row.json.peerAsk?.name ?? peerProvenanceAuthor(row.text))
        ? { peer: row.json.peerAsk?.name ?? peerProvenanceAuthor(row.text)! } : {}) };
  }

  async recentMessages(threadIds: readonly string[], range: RecallRange, limit = 12): Promise<Array<{
    threadId: string; messageId: string; at: number; role: string; snippet: string; from?: string; peer?: string;
  }>> {
    if (!threadIds.length) return [];
    const query = this.db("omb_messages").whereIn("thread_id", [...new Set(threadIds)])
      .where({ kind: "text" }).whereNotNull("text")
      .orderBy("at", "desc").limit(limit).select("thread_id", "id", "at", "role", "text", "json");
    if (range.since !== undefined) query.where("at", ">=", range.since);
    if (range.until !== undefined) query.where("at", "<=", range.until);
    const rows = await query as Array<{ thread_id: string; id: string; at: string; role: string; text: string; json: Message }>;
    return rows.map((row) => ({ threadId: row.thread_id, messageId: row.id, at: Number(row.at), role: row.role,
      snippet: row.text.slice(0, 240).replace(/\s+/g, " ").trim(),
      ...(row.json.from?.name ? { from: row.json.from.name } : {}),
      ...(row.json.peerAsk?.name ? { peer: row.json.peerAsk.name } : {}) }));
  }

  async latestSaidByBot(threadIds: readonly string[], botId: string, since: number, limit = 20): Promise<ThreadLatest[]> {
    if (!threadIds.length) return [];
    const rows = await this.db("omb_messages")
      .distinctOn("thread_id").whereIn("thread_id", [...new Set(threadIds)])
      .where({ kind: "text", role: "bot" }).whereNotNull("text").where("at", ">=", since)
      .whereRaw("(json->'from'->>'botId' IS NULL OR json->'from'->>'botId' = ?)", [botId])
      .orderBy("thread_id").orderBy("at", "desc")
      .select("thread_id", "id", "at", "text") as Array<{ thread_id: string; id: string; at: string; text: string }>;
    return rows.sort((a, b) => Number(b.at) - Number(a.at)).slice(0, limit).map((row) => ({
      threadId: row.thread_id, messageId: row.id, at: Number(row.at), head: row.text.slice(0, 400).replace(/\s+/g, " ").trim(),
    }));
  }

  async indexMemoryFile(botId: string, path: string, text: string, stat: { mtimeMs: number; bytes: number }): Promise<void> {
    await this.db("omb_memory_files").insert({ bot_id: botId, path, text,
      mtime_ms: stat.mtimeMs, bytes: stat.bytes }).onConflict(["bot_id", "path"]).merge(["text", "mtime_ms", "bytes"]);
  }

  async removeMemoryFile(botId: string, path: string): Promise<void> {
    await this.db("omb_memory_files").where({ bot_id: botId, path }).del();
  }

  async deleteBotMemoryFiles(botId: string): Promise<void> {
    await this.db("omb_memory_files").where("bot_id", botId).del();
  }

  async indexedMemoryFiles(botId: string): Promise<MemoryFileStat[]> {
    const rows = await this.db("omb_memory_files").where("bot_id", botId)
      .select("path", "mtime_ms", "bytes") as Array<{ path: string; mtime_ms: string; bytes: string }>;
    return rows.map((row) => ({ path: row.path, mtimeMs: Number(row.mtime_ms), bytes: Number(row.bytes) }));
  }

  async saveChatFollowup(followup: Omit<ChatFollowup, "status">): Promise<void> {
    await this.db("omb_chat_followups").insert({
      id: followup.id, kind: followup.kind, owner_id: followup.ownerId,
      thread_id: followup.threadId, send_id: followup.payload.sendId ?? null,
      status: "pending", payload: JSON.stringify(followup.payload),
    });
  }

  async settleChatFollowups(ids: string[], status: FollowupStatus | null): Promise<void> {
    if (!ids.length) return;
    const query = this.db("omb_chat_followups").whereIn("id", ids);
    if (status === null) await query.del();
    else await query.update(status === "cancelled"
      ? { status, payload: JSON.stringify({ text: "" }) }
      : { status });
  }

  async chatFollowups(kind?: ChatFollowup["kind"]): Promise<ChatFollowup[]> {
    const query = this.db("omb_chat_followups").orderBy("seq");
    if (kind) query.where("kind", kind);
    const rows = await query.select("id", "kind", "owner_id", "thread_id", "status", "payload") as Array<{
      id: string; kind: ChatFollowup["kind"]; owner_id: string; thread_id: string;
      status: FollowupStatus; payload: ChatFollowup["payload"];
    }>;
    return rows.map((row) => ({ id: row.id, kind: row.kind, ownerId: row.owner_id,
      threadId: row.thread_id, status: row.status, payload: row.payload }));
  }

  async cancelledChatFollowup(kind: ChatFollowup["kind"], ownerId: string, threadId: string, sendId: string): Promise<boolean> {
    const row = await this.db("omb_chat_followups").where({ kind, owner_id: ownerId,
      thread_id: threadId, send_id: sendId, status: "cancelled" }).first("id");
    return Boolean(row);
  }

  async readCommandReceipt(kind: string, key: string): Promise<StoredCommandReceipt | null> {
    const row = await this.db<{ kind: string; key: string; at: string; result: string }>("omb_command_receipts")
      .where({ kind, key }).first("kind", "key", "at", "result");
    return row ? { ...row, at: Number(row.at) } : null;
  }

  /** The callback must write through this transaction for receipt atomicity. */
  async withCommandReceipt(kind: string, key: string, apply: (transaction: Knex.Transaction) => Promise<string>, at: number): Promise<{ result: string; replayed: boolean }> {
    return this.db.transaction(async (transaction) => {
      await transaction.raw("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", [`receipt:${kind}:${key}`]);
      const existing = await transaction("omb_command_receipts").where({ kind, key }).first("result") as { result: string } | undefined;
      if (existing) return { result: existing.result, replayed: true };
      const result = await apply(transaction);
      await transaction("omb_command_receipts").insert({ kind, key, at, result: JSON.stringify(result) });
      return { result, replayed: false };
    });
  }
}
