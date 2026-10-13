import type { Knex } from "knex";
import { PostgresDocuments } from "./postgres-documents.ts";
import type { SessionStoreOptions } from "./sessions.ts";

/** Establish the unclean-restart marker before any saved bearer is accepted. */
export async function openPostgresSessions(db: Knex): Promise<NonNullable<SessionStoreOptions["external"]>> {
  const documents = new PostgresDocuments(db);
  const initial = await documents.read("sessions.json");
  const unclean = await documents.read("sessions.open");
  await documents.write("sessions.open", { openedAt: Date.now() });
  return {
    initial,
    restoreAccounts: unclean === undefined,
    save: (snapshot) => documents.write("sessions.json", snapshot),
    close: () => documents.remove("sessions.open"),
  };
}
