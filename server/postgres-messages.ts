import type { Knex } from "knex";
import type { Message } from "./store.ts";

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

  async insertMessage(threadId: string, message: Message, db: Knex | Knex.Transaction = this.db): Promise<void> {
    await db("omb_messages").insert(this.messageRow(threadId, message))
      .onConflict(["thread_id", "id"]).merge(["at", "role", "kind", "text", "json"]);
  }

  async appendMessage(threadId: string, message: Message): Promise<void> {
    await this.db.transaction(async (transaction) => {
      await this.insertMessage(threadId, message, transaction);
      await this.setActiveLeaf(threadId, message.id, transaction);
    });
  }

  async updateMessage(threadId: string, message: Message): Promise<void> {
    const { thread_id: _threadId, id: _id, ...fields } = this.messageRow(threadId, message);
    await this.db("omb_messages").where({ thread_id: threadId, id: message.id }).update(fields);
  }

  async setActiveLeaf(threadId: string, leafId: string | null, db: Knex | Knex.Transaction = this.db): Promise<void> {
    await db("omb_thread_state").insert({ thread_id: threadId, active_leaf_id: leafId })
      .onConflict("thread_id").merge(["active_leaf_id"]);
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.db.transaction(async (transaction) => {
      await transaction("omb_chat_followups").where("thread_id", threadId).del();
      await transaction("omb_messages").where("thread_id", threadId).del();
      await transaction("omb_thread_state").where("thread_id", threadId).del();
    });
  }
}
