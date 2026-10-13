import { workerData } from "node:worker_threads";
import knex, { type Knex } from "knex";
import { PostgresMessages } from "./postgres-messages.ts";
import { PostgresDocuments } from "./postgres-documents.ts";

const { url, port } = workerData as { url: string; port: import("node:worker_threads").MessagePort };
const db = knex({ client: "pg", connection: url, pool: { min: 0, max: 3 } });
const messages = new PostgresMessages(db);
const documents = new PostgresDocuments(db);
let receiptTransaction: Knex.Transaction | null = null;

async function perform(method: string, args: unknown[]): Promise<unknown> {
  if (method === "ping") { await db.raw("SELECT 1"); return true; }
  if (method === "document.write") return documents.write(args[0] as string, args[1]);
  if (method === "document.remove") return documents.remove(args[0] as string);
  if (method === "document.removePrefix") return db("omb_documents").whereRaw("left(path, length(?)) = ?", [args[0] as string, args[0] as string]).del();
  if (method === "document.all") return db("omb_documents").select("path", "value");
  if (method === "file.append") {
    await db("omb_file_lines").insert({ path: args[0] as string, line: args[1] as string });
    return true;
  }
  if (method === "file.remove") return db("omb_file_lines").where("path", args[0] as string).del();
  if (method === "file.removePrefix") return db("omb_file_lines").whereRaw("left(path, length(?)) = ?", [args[0] as string, args[0] as string]).del();
  if (method === "file.replace") return db.transaction(async (trx) => {
    await trx.raw("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", [`file:${args[0]}`]);
    await trx("omb_file_lines").where("path", args[0] as string).del();
    if (args[1]) await trx("omb_file_lines").insert({ path: args[0] as string, line: args[1] as string });
  });
  if (method === "receipt.begin") {
    if (receiptTransaction) throw new Error("Nested PostgreSQL command receipt");
    const trx = await db.transaction();
    try {
      const [kind, key] = args as [string, string];
      await trx.raw("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", [`receipt:${kind}:${key}`]);
      const existing = await trx("omb_command_receipts").where({ kind, key }).first("result") as { result: string } | undefined;
      if (existing) { await trx.commit(); return existing.result; }
      receiptTransaction = trx;
      return null;
    } catch (error) { await trx.rollback(); throw error; }
  }
  if (method === "receipt.commit") {
    const trx = receiptTransaction;
    if (!trx) throw new Error("No PostgreSQL command receipt is open");
    receiptTransaction = null;
    const [kind, key, at, result] = args as [string, string, number, string];
    try {
      await trx("omb_command_receipts").insert({ kind, key, at, result: JSON.stringify(result) });
      await trx.commit();
    } catch (error) { await trx.rollback(); throw error; }
    return true;
  }
  if (method === "receipt.rollback") {
    const trx = receiptTransaction;
    receiptTransaction = null;
    if (trx) await trx.rollback();
    return true;
  }
  if (method === "latestPersonLineAts") {
    return [...(await messages.latestMessageAts(args[0] as string[], true)).entries()];
  }
  if (method === "latestMessageAts") return [...(await messages.latestMessageAts(args[0] as string[])).entries()];
  if (method === "readThreadTail") return messages.readThreadTail(args[0] as string, args[1] as number);
  if (method === "appendMessage" && receiptTransaction) return messages.appendMessage(args[0] as string, args[1] as never, receiptTransaction);
  if (method === "updateMessage" && receiptTransaction) return messages.updateMessage(args[0] as string, args[1] as never, receiptTransaction);
  if (method === "insertMessage" && receiptTransaction) return messages.insertMessage(args[0] as string, args[1] as never, receiptTransaction);
  if (method === "setActiveLeaf" && receiptTransaction) return messages.setActiveLeaf(args[0] as string, args[1] as string | null, receiptTransaction);
  const target = messages as unknown as Record<string, (...arguments_: unknown[]) => Promise<unknown>>;
  if (!Object.hasOwn(target.constructor.prototype, method)) throw new Error(`Unknown PostgreSQL operation ${method}`);
  return target[method]!(...args);
}

port.on("message", async ({ method, args, signal }: { method: string; args: unknown[]; signal: Int32Array }) => {
  let reply: { ok: true; value: unknown } | { ok: false; error: string };
  try { reply = { ok: true, value: await perform(method, args) }; }
  catch (error) { reply = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  port.postMessage(reply);
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
});
