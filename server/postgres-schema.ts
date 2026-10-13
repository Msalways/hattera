import type { Knex } from "knex";

// Kept in code so the packaged server can run migrations without shipping
// source files or depending on its working directory.
const initial: Knex.Migration = {
  async up(db) {
    await db.schema.createTable("omb_documents", (table) => {
      table.text("path").primary();
      table.jsonb("value").notNullable();
      table.bigInteger("updated_at").notNullable();
    });
    await db.schema.createTable("omb_messages", (table) => {
      table.text("thread_id").notNullable();
      table.text("id").notNullable();
      table.bigInteger("at").notNullable();
      table.text("role").notNullable();
      table.text("kind").notNullable();
      table.text("text").nullable();
      table.jsonb("json").notNullable();
      table.primary(["thread_id", "id"]);
      table.index(["thread_id", "at"], "omb_messages_thread_at");
    });
    await db.raw("CREATE INDEX omb_messages_fts ON omb_messages USING GIN (to_tsvector('simple', coalesce(text, '')))");
    await db.schema.createTable("omb_thread_state", (table) => {
      table.text("thread_id").primary();
      table.text("active_leaf_id").nullable();
    });
    await db.schema.createTable("omb_chat_followups", (table) => {
      table.text("id").primary();
      table.text("kind").notNullable();
      table.text("owner_id").notNullable();
      table.text("thread_id").notNullable();
      table.text("send_id").nullable();
      table.text("status").notNullable();
      table.jsonb("payload").notNullable();
      table.index(["kind", "owner_id", "thread_id", "send_id"], "omb_followups_receipt");
    });
    await db.schema.createTable("omb_command_receipts", (table) => {
      table.text("kind").notNullable();
      table.text("key").notNullable();
      table.bigInteger("at").notNullable();
      table.jsonb("result").notNullable();
      table.primary(["kind", "key"]);
    });
    await db.schema.createTable("omb_memory_files", (table) => {
      table.text("bot_id").notNullable();
      table.text("path").notNullable();
      table.text("text").notNullable();
      table.bigInteger("mtime_ms").notNullable();
      table.bigInteger("bytes").notNullable();
      table.primary(["bot_id", "path"]);
    });
    await db.raw("CREATE INDEX omb_memory_fts ON omb_memory_files USING GIN (to_tsvector('simple', text))");
  },
  async down(db) {
    for (const table of ["omb_memory_files", "omb_command_receipts", "omb_chat_followups", "omb_thread_state", "omb_messages", "omb_documents"]) {
      await db.schema.dropTable(table);
    }
  },
};

const messageOrder: Knex.Migration = {
  async up(db) {
    // SQLite reads transcripts in insertion order (rowid), including lines
    // sharing one timestamp. Keep that order across PostgreSQL restarts.
    await db.raw("ALTER TABLE omb_messages ADD COLUMN seq BIGSERIAL");
    await db.raw("CREATE INDEX omb_messages_thread_seq ON omb_messages (thread_id, seq)");
  },
  async down(db) {
    await db.raw("DROP INDEX omb_messages_thread_seq");
    await db.schema.alterTable("omb_messages", (table) => table.dropColumn("seq"));
  },
};

const followupOrder: Knex.Migration = {
  async up(db) {
    await db.raw("ALTER TABLE omb_chat_followups ADD COLUMN seq BIGSERIAL");
    await db.raw("CREATE INDEX omb_followups_seq ON omb_chat_followups (seq)");
  },
  async down(db) {
    await db.raw("DROP INDEX omb_followups_seq");
    await db.schema.alterTable("omb_chat_followups", (table) => table.dropColumn("seq"));
  },
};

const dataRoleSecret: Knex.Migration = {
  async up(db) {
    await db.schema.createTable("omb_data_role_secret", (table) => {
      table.integer("id").primary();
      table.text("secret").notNullable();
    });
  },
  async down(db) { await db.schema.dropTable("omb_data_role_secret"); },
};

const fileLines: Knex.Migration = {
  async up(db) {
    await db.schema.createTable("omb_file_lines", (table) => {
      table.bigIncrements("seq").primary();
      table.text("path").notNullable();
      table.text("line").notNullable();
      table.index(["path", "seq"], "omb_file_lines_path_seq");
    });
  },
  async down(db) { await db.schema.dropTable("omb_file_lines"); },
};

const migrations = new Map([
  ["001_initial_postgres_storage", initial],
  ["002_message_order", messageOrder],
  ["003_followup_order", followupOrder],
  ["004_data_role_secret", dataRoleSecret],
  ["005_file_lines", fileLines],
]);

/** Knex owns its migration lock and version table; repeated deploys are safe. */
export const postgresMigrationSource: Knex.MigrationSource<string> = {
  async getMigrations() { return [...migrations.keys()]; },
  getMigrationName(name) { return name; },
  async getMigration(name) {
    const migration = migrations.get(name);
    if (!migration) throw new Error(`Unknown PostgreSQL migration ${name}`);
    return migration;
  },
};

export async function migratePostgres(db: Knex): Promise<string[]> {
  const [, names] = await db.migrate.latest({ migrationSource: postgresMigrationSource, tableName: "omb_schema_migrations" });
  return names as string[];
}
