/** PostgreSQL is opt-in. A configured URL alone must never switch storage. */
export function postgresConnectionUrl(env: NodeJS.ProcessEnv): string | null {
  const enabled = env.OMB_POSTGRES_ENABLED?.trim();
  if (enabled === undefined || enabled === "" || enabled === "false") return null;
  if (enabled !== "true") throw new Error("OMB_POSTGRES_ENABLED must be true or false");

  const value = env.DATABASE_URL?.trim();
  if (!value) throw new Error("OMB_POSTGRES_ENABLED=true requires DATABASE_URL");
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL"); }
  if ((url.protocol !== "postgres:" && url.protocol !== "postgresql:") || !url.hostname || url.pathname.length < 2) {
    throw new Error("DATABASE_URL must be a PostgreSQL connection URL with a database name");
  }
  return value;
}
