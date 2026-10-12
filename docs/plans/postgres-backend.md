# Optional PostgreSQL backend

## Current implementation status

The first safe slice is implemented: `knex` and `pg` are installed, the opt-in
environment is validated, and `pnpm storage:pg:migrate` applies a versioned
initial PostgreSQL schema. The command requires both
`OMB_POSTGRES_ENABLED=true` and `DATABASE_URL`. The migration command is
idempotent and is included in the packaged server bundle as
`dist-server/postgres-migrate.js`.

**Do not enable the flag on a running server or Render yet.** The server
deliberately rejects it before creating its data directory. The active chat,
bot, settings, session, and Data-table stores still use synchronous SQLite,
DuckDB, and JSON files. The new PostgreSQL tables are not yet active stores,
and existing data is not imported. Startup migration on deployment belongs
with the completed backend switch; running schema migrations alone would not
make an ephemeral deployment durable.

## Decision

SQLite remains the default for local installations. PostgreSQL is an opt-in
backend for **all server-owned structured records**, including transcripts,
search data, bot and group records, settings, routines, device sessions, and
GitHub identity. Enabling it must not leave any of these records authoritative
on the container's local disk.

PostgreSQL does not store the agent's working directory, uploaded file bytes,
CLI login homes, or browser profiles. Those need a separate durable file store
or persistent volume. Per-bot DuckDB Data tables are structured user data and
must also migrate into PostgreSQL mode; a local DuckDB cache may be rebuilt
from PostgreSQL, but cannot be authoritative. A Render Free container with
only PostgreSQL configured is still an incomplete durable deployment.

## Configuration contract

```dotenv
# Omitted or false: existing SQLite and JSON behavior.
OMB_POSTGRES_ENABLED=true
DATABASE_URL=postgresql://user:password@host:5432/database
```

`POSTGRES_DB` is already a conventional PostgreSQL container variable for the
database *name*, so it is not the backend switch. The application must validate
the flag and URL at startup. If PostgreSQL is selected but unavailable or the
schema is incompatible, startup fails with a useful error. It must never fall
back to SQLite, silently create a second workspace, or print credentials.

The service uses one bounded connection pool. `DATABASE_URL` is a secret and
must come from the host's secret environment, never a committed file. The
PostgreSQL provider can be Supabase, Neon, or a self-hosted server; no
provider-specific SDK is required for the core data path.

## Data ownership

| Records | SQLite mode today | PostgreSQL mode target |
| --- | --- | --- |
| Messages, branch heads, queued followups, command receipts | `messages.db` | PostgreSQL tables and transactions |
| GitHub users, accounts, OAuth sessions | `github-identity.sqlite` | Better Auth PostgreSQL adapter and schema |
| Bots, groups, config, routines, webhooks, permissions, session registry, and other server JSON state | Files below `OMB_DATA_DIR` | PostgreSQL tables for frequently queried records; a versioned JSONB document table for the remaining named records |
| Message and memory search | SQLite FTS5 | PostgreSQL full-text indexes, with behavior checked against the SQLite tests |
| Per-bot Data tables and sheets | `data.duckdb` and sheet files | PostgreSQL tables and metadata; report unsupported DuckDB SQL before cutover |
| Uploads, workspaces, engine credentials | Files below `/data` or `HOME` | A separate durable file storage design; PostgreSQL mode alone does not migrate these |

Inventory every server-owned JSON write before declaring PostgreSQL mode
complete. In particular, `server/atomic.ts` is a common write path, while some
modules use `node:fs` directly. Moving just `messages.db` and Better Auth would
leave bots, settings, and sessions behind. Do not put whole SQLite database
files into a PostgreSQL blob: PostgreSQL must be the active store in its mode.

The current `Store` and many callers use synchronous SQLite and filesystem
methods. PostgreSQL queries are asynchronous, so introduce an async persistence
boundary and update callers through that boundary. Avoid blocking the Node
event loop with a synchronous worker or hidden whole-directory snapshots.
Keep API URLs and response shapes unchanged in both modes.

## Initialization and migration

1. Add versioned, transactional PostgreSQL schema migrations. At startup,
   acquire a PostgreSQL advisory lock, apply pending schema versions, then
   accept requests. Concurrent instances must not race the migrations.
2. Add an explicit `storage:migrate` command for **SQLite/JSON to PostgreSQL**.
   It reads an offline or locked source data directory. It first reports the
   source inventory and target status in a dry run, without changing either.
3. Require a consistent SQLite backup and stop application writes for the
   import. Import structured records in dependency order with stable IDs and
   timestamps. Record the source fingerprint and migration ID in PostgreSQL.
   Each batch is transactional and safely resumable after interruption.
4. Verify row counts, representative checksums, referential links, search
   results, Data tables, and authentication ownership before cutover. Keep the original
   SQLite and JSON files intact as the rollback source; never delete them as
   part of import.
5. Start with `OMB_POSTGRES_ENABLED=true` only after verification. A repeated
   migration must refuse a different source or an already active target rather
   than duplicate records. Rollback to the untouched source is safe only before
   PostgreSQL accepts new writes. After that, recovery uses PostgreSQL backups
   or an explicit reverse export; it is not an automatic dual-write mode.

Better Auth's schema migration is distinct from importing its existing users
and accounts. Auth records and app sessions must be handled explicitly; if a
session cannot be transferred safely, require a fresh GitHub sign-in and say
so in the cutover report. The configured GitHub owner ID remains the
authorization check in either backend.

## Cleanup and retention

- Expired sessions, OAuth verifications, and abandoned followups can be
  removed in bounded batches. Retain audit and usage data according to the
  existing configured policy.
- Do not age-delete chats, bot memory, workspaces, or committed uploads.
  Delete them only through an explicit user action or a documented retention
  setting. File cleanup first marks unreferenced objects, waits a grace
  period, and rechecks references before deletion.
- Run cleanup from one scheduled job or a single elected worker. Make it
  idempotent, observable, and safe if interrupted. A health-check request must
  never be the only cleanup trigger.
- Back up PostgreSQL and file storage together, encrypt the backups, and test
  restore into an isolated instance. Database backup alone is insufficient.

## Acceptance gates

- SQLite mode passes its existing tests with the flag absent and does not
  require a PostgreSQL driver or connection at runtime.
- PostgreSQL mode initializes an empty database, persists all structured
  records across a server restart, and fails closed when its connection drops.
- An isolated fixture with messages, branches, bots, settings, routines,
  sessions, GitHub identity, and per-bot Data tables migrates without missing
  or duplicated data.
  A second run is safe; a partially failed run resumes or refuses cleanly.
- Legacy `/api/auth/*` routes, pairing, logout, GitHub owner rejection, search,
  command receipts, and live turns behave the same in both modes.
- The file store and backup/restore gate are completed before calling a
  PostgreSQL-enabled ephemeral deployment durable.
- All mutation checks use disposable data and a disposable PostgreSQL
  database, following `docs/verification/README.md`; never the live app data.

## Implementation order

1. Inventory server-owned structured files and create shared async store
   contracts while keeping SQLite behavior and tests intact.
2. Add PostgreSQL schema, migrations, and implementations for messages,
   search, documents, sessions, and Better Auth.
3. Add the one-time importer and cutover verification.
4. Add file storage, cleanup, and backup/restore for the chosen host.
5. Enable the environment flag after both backend test suites and an isolated
   end-to-end migration pass.
