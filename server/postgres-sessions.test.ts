import knex from "knex";
import { expect, it } from "vitest";
import { PostgresDocuments } from "./postgres-documents.ts";
import { migratePostgres } from "./postgres-schema.ts";
import { openPostgresSessions } from "./postgres-sessions.ts";
import { SessionRegistry } from "./sessions.ts";

const url = process.env.OMB_TEST_DATABASE_URL;

it.skipIf(!url)("keeps paired sessions but rejects account sessions after an unclean PostgreSQL restart", async () => {
  const parsed = new URL(url!);
  if (parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/ombtest") {
    throw new Error("OMB_TEST_DATABASE_URL must point to the disposable 127.0.0.1/ombtest database");
  }
  const db = knex({ client: "pg", connection: url, pool: { min: 0, max: 2 } });
  try {
    await migratePostgres(db);
    const documents = new PostgresDocuments(db);
    await documents.remove("sessions.json");
    await documents.remove("sessions.open");
    const open = async () => new SessionRegistry({ file: "unused-in-postgres-mode", external: await openPostgresSessions(db) });
    const first = await open();
    const account = first.issue({ label: "owner", scopes: ["admin", "client"], userId: "github:123" });
    const pairing = first.openPairing();
    const paired = first.exchange({ code: pairing.code, label: "phone", source: "test" });
    expect(paired.ok).toBe(true);
    await first.flush();
    // Simulate a process crash: the first registry deliberately does not close.
    const second = await open();
    expect(second.authenticate(account.token)).toBeNull();
    if (!paired.ok) throw new Error("pairing did not succeed");
    expect(second.authenticate(paired.token)?.label).toBe("phone");
    await second.closeAsync();
    const third = await open();
    expect(third.authenticate(paired.token)?.label).toBe("phone");
    const cleanAccount = third.issue({ label: "new owner", scopes: ["admin"], userId: "github:123" });
    await third.closeAsync();
    const fourth = await open();
    expect(fourth.authenticate(cleanAccount.token)?.label).toBe("new owner");
    await fourth.closeAsync();
    await documents.remove("sessions.json");
  } finally { await db.destroy(); }
});
