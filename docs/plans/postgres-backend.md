# Optional PostgreSQL backend

## Select a fresh installation's backend

SQLite and local files remain the default. For a fresh PostgreSQL installation,
set both values in the server's secret environment:

```dotenv
OMB_POSTGRES_ENABLED=true
DATABASE_URL=postgresql://user:password@host:5432/database
```

The URL alone does not switch storage. With the flag enabled, startup applies
versioned Knex migrations before serving requests. A failed connection or
migration stops startup; it does not fall back to SQLite. `pnpm
storage:pg:migrate` also runs the migrations explicitly. Never commit the URL.
The server removes it from the environment inherited by agent CLI processes
after configuring its database clients.

There is **no SQLite-to-PostgreSQL import**. Changing the flag chooses a
different installation's records. Use a new database for a new deployment;
switching an existing SQLite installation to PostgreSQL shows an empty
workspace until its records are imported separately.

## What PostgreSQL owns

| Record | PostgreSQL mode |
| --- | --- |
| Messages, branches, followups, command receipts, and search indexes | PostgreSQL tables |
| GitHub identity | Better Auth PostgreSQL adapter |
| Pairing and account sessions | PostgreSQL session snapshot; account sessions are invalidated after an unclean stop |
| Bots, groups, settings, routines, webhooks, and other server JSON documents | PostgreSQL `omb_documents`, hydrated to a temporary local cache at boot |
| Event, decision, admin, usage, and memory journal lines | PostgreSQL `omb_file_lines`, hydrated to the cache at boot |
| Per-bot Data and result tables | DuckDB computes in memory against isolated PostgreSQL schemas |

The existing synchronous message and file APIs use a PostgreSQL worker bridge.
Each call waits for the database commit before returning. This preserves current
callers, but it blocks the Node event loop during a query and is a throughput
limit until those APIs are made asynchronous. The bridge fails closed after a
30-second timeout. A bot's Data schemas use a restricted PostgreSQL role;
the database account used to initialize them needs permission to create roles
and schemas. Check those privileges on a managed provider before deployment.

Without `OMB_POSTGRES_FILES_DIR`, the temporary cache is disposable. Compose
sets that variable to a stable path on its `/data` volume, where uploads,
workspaces, and other files persist. In either case the cache may contain
copies of sensitive JSON and logs; protect its storage. `OMB_DATA_DIR` is
replaced with that path in PostgreSQL mode. A marker prevents reuse with a
different database.
Workspace backup and cloud move endpoints return 501 in this mode because
their current implementations copy local files only.

## What still needs durable file storage

PostgreSQL does **not** hold uploads, bot workspaces and memory files, agent CLI
homes and credentials, browser profiles, or generated files. An ephemeral
container can lose these on restart. A Render Free service with only
PostgreSQL configured is therefore **not a durable Hattera deployment**. Use
a persistent volume or a designed object store and verify backup and restore
before relying on it for irreplaceable files. The command-line `access`
subcommand also edits local config and should be managed through the running
server's Settings UI in PostgreSQL mode.

## Verification

The isolated PostgreSQL tests cover migrations, documents, identity, sessions,
transcripts, receipts, search, and Data table persistence and role isolation.
Source and packaged server restart smokes have checked bot and settings
persistence against a disposable local PostgreSQL container. Keep using
disposable data and a disposable database for further checks, following
`docs/verification/README.md`; never point tests at the live app database.

Before hosting, verify a real GitHub callback, an agent turn, uploads and file
continuity, startup with the provider's actual role privileges, and recovery
after an unclean restart. Repeated migrations should apply no new changes.
