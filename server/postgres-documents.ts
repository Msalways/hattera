import type { Knex } from "knex";

/** Named JSON records that are currently saved as files in SQLite mode. */
export class PostgresDocuments {
  private readonly db: Knex;
  constructor(db: Knex) { this.db = db; }

  async read<T>(path: string): Promise<T | undefined> {
    const row = await this.db<{ value: T }>("omb_documents").where("path", path).first("value");
    return row?.value;
  }

  async write(path: string, value: unknown): Promise<void> {
    if (value === undefined) throw new TypeError("PostgreSQL documents require a JSON value");
    await this.db("omb_documents")
      .insert({ path, value: JSON.stringify(value), updated_at: Date.now() })
      .onConflict("path")
      .merge(["value", "updated_at"]);
  }

  async remove(path: string): Promise<void> {
    await this.db("omb_documents").where({ path }).del();
  }
}
