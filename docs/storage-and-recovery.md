# Storage and recovery

Hattera uses two kinds of durable storage. Set `OMB_POSTGRES_ENABLED=true` and
`DATABASE_URL` to keep structured records in any compatible PostgreSQL service;
leave the flag false to keep the default local SQLite records. Both modes need
a durable filesystem for uploads, agent workspaces, browser profiles, and CLI
sign-ins. In PostgreSQL mode Compose uses `OMB_POSTGRES_FILES_DIR` under `/data`.
The server rejects a file directory marked for a different database.

## Choose a filesystem provider

Compose creates a named volume unless configured otherwise. To use a volume
created by a storage provider or a Docker volume driver, set these in `.env`:

```dotenv
OMB_DATA_VOLUME=my-durable-volume
OMB_DATA_EXTERNAL=true
```

Create and mount the volume on the Docker host before starting Compose. The
volume must allow normal POSIX file writes, directory creation, and renames;
it is mounted at `/data`. A host bind mount can also be supplied through a
local Compose override. Keep one writable server instance per database and
volume. The database and volume are a pair: restore them to the same point in
time, rather than attaching an old volume to a newer database.

An S3-compatible bucket is useful as a backup destination. It cannot directly
stand in for this volume: OpenCode and other agent processes write files to
workspace paths themselves, and browser and CLI profiles also expect a
filesystem. A service without a durable mount, including Render Free, is a
preview even when `DATABASE_URL` points to durable PostgreSQL.

## Back up and restore

1. Stop the application with `docker compose stop`. Keep the volume; avoid
   `docker compose down -v`.
2. In PostgreSQL mode, take a provider snapshot or a `pg_dump` of the database.
   In SQLite mode, the database is part of the stopped `/data` volume.
3. Archive the stopped `/data` volume and store the archive away from the host.
   Record which database backup belongs with the archive. Encrypt backups that
   contain agent credentials or private chats.
4. Restore both into a **separate** database and volume. Point a separate
   Compose project at them, start it, and verify sign-in, a chat, an uploaded
   file, a workspace file, and an agent turn after another restart.

For cleanup, use the app's delete controls for bots, chats, and uploads. Keep
regular backup retention in the storage provider, and periodically review
old backups, unused external volumes, and old databases. Do not delete the
active volume to clear temporary files; it also holds credentials and
workspaces.
