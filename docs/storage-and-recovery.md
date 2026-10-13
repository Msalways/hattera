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

## Optional object storage copies

Set `OMB_OBJECT_STORAGE_KIND=s3` in `.env` to copy attachments and encrypted
workspace backup exports to a **private** S3-compatible bucket. Supply
`OMB_S3_BUCKET`, `OMB_S3_REGION`, `OMB_S3_ACCESS_KEY_ID`, and
`OMB_S3_SECRET_ACCESS_KEY`. Set `OMB_S3_ENDPOINT` for a provider other than AWS;
use `OMB_S3_FORCE_PATH_STYLE=true` when that provider requires path-style URLs.
`OMB_S3_PREFIX` separates this installation from other data in the bucket.
The credentials need `HeadObject` and `PutObject` permission for that prefix.
On AWS S3, allow `ListBucket` for missing-key HEAD responses; large backup
exports also need multipart upload and abort permissions.
The server rejects incomplete settings and non-HTTPS public endpoints.

New HTTP uploads are copied when saved. A startup sweep and a 10-minute sweep
retry failed copies and include files created by bot tools. Files stay at their
normal local paths, and an upload still succeeds if its offsite copy fails;
check server logs for `object storage: ... failed`. Exporting an encrypted
workspace backup waits for its bucket copy and fails if that copy fails.
Object keys are `<prefix>/uploads/<generated filename>` and
`<prefix>/backups/<backup-id>.ombbackup`. Use provider tools to download a
backup export, then the app's Backups upload/restore flow to restore it into an
isolated **SQLite-mode** installation. The app does not auto-hydrate a lost
volume from the bucket or list bucket backups in its UI.

PostgreSQL mode stores structured records externally, but the current app
backup export endpoint is unavailable in that mode. Use a PostgreSQL snapshot
or `pg_dump` together with a stopped `/data` volume archive. Object storage
copies alone are not a complete PostgreSQL-mode backup. Set a bucket lifecycle
policy for old backup exports after verifying restore; keep referenced uploads
until their chats are retired. Deleting an upload in the app does not currently
delete its offsite copy, so periodically review bucket retention and access.

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
