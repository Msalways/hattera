# Hattera hosting readiness

This checklist covers this fork's container deployment. The inherited [VPS guide](deploy-vps.md) describes upstream services and release packages; use the fork's [local Compose guide](../deploy/local/README.md) and [Render preview guide](../deploy/render/README.md) for Hattera.

## Already present

- The `server` target in [`Dockerfile`](../Dockerfile) builds this repository's web UI and server. It includes Caddy, the browser runtime, and the engine packages selected by the `ENGINES` build argument. `render.yaml` selects `opencode-ai`.
- [`compose.yaml`](../compose.yaml) binds the web edge to `127.0.0.1:8080` by default, runs Caddy beside the server, and mounts a named volume at `/data`. The existing `openmausbot` project and volume defaults are intentionally retained so local upgrades use the same data.
- [`render.yaml`](../render.yaml) builds this fork's `main` branch, starts the container through [`deploy/render/start.mjs`](../deploy/render/start.mjs), and checks `/api/health`. SQLite is the default for a temporary preview; add `OMB_POSTGRES_ENABLED=true` and `DATABASE_URL` to the service environment for external PostgreSQL.
- GitHub OAuth uses a separate `/identity/*` path, checks the configured numeric `GITHUB_OWNER_ID`, and leaves legacy `/api/auth/*` pairing available. The Render launcher derives the public URL and GitHub callback from `RENDER_EXTERNAL_URL`.
- `.env` is ignored by Git and excluded from the Docker build context. Render OAuth credentials belong in Render's environment settings.
- Optional `OMB_OBJECT_STORAGE_KIND=s3` mirrors uploads and encrypted SQLite-mode backup exports to any S3-compatible private bucket; it does not replace the writable `/data` volume.

## What must persist

| State | Current location or form | Consequence on an ephemeral host |
| --- | --- | --- |
| Chats and GitHub sign-in | SQLite by default; PostgreSQL with `OMB_POSTGRES_ENABLED=true` and `DATABASE_URL` | The default loses them; PostgreSQL mode retains structured records |
| Pairing sessions, bot definitions, settings, schedules, and other records | Local files by default; PostgreSQL documents and session snapshot with the flag | The default loses them; PostgreSQL mode retains structured records |
| Data tables and sheets | Per-bot DuckDB by default; PostgreSQL schemas and documents with the flag | The default loses them; PostgreSQL mode retains structured Data tables |
| Uploads, generated files, and agent workspaces | Files below `/data/.openmausbot` | Attachments and working files disappear |
| Engine sign-ins | CLI home directories below `/data` | OpenCode or other engines need sign-in again |

Render [documents that Free web services lose local file changes on spin-down, restart, and redeploy](https://render.com/docs/free). Its Free web services cannot attach a persistent disk. An external `/api/health` monitor at a 10-minute interval can reduce idle spin-down if the monitor plan supports that interval, but does not make any of this state durable or prevent maintenance restarts. Render's own health check is a readiness probe, not a keep-awake service.

The [Free web plan has 512 MB RAM and 0.1 CPU](https://render.com/docs/compute-plans), so a successful build or health response does not prove an OpenCode or browser task fits. Keeping the service warm uses the workspace's [750 Free instance hours per month](https://render.com/docs/free), shared with its other Free services.

## Paths to use

### Public Render preview

Use the Render Blueprint with GitHub OAuth and the public Render HTTPS URL. No Tailscale installation is needed on Render. SQLite mode is fully disposable. If you add an external PostgreSQL database, structured records survive container restarts, while files and engine logins remain disposable. Check `/api/health`, then test the GitHub callback, a paired browser, and an OpenCode turn after each deploy. This path has no file recovery promise.

### Persistent self-hosting

Run the existing Compose stack on an always-on VM with durable host storage behind the `/data` volume. `OMB_DATA_VOLUME` can select an existing volume backed by any Docker volume driver; `DATABASE_URL` can select any compatible PostgreSQL service. The [storage and recovery guide](storage-and-recovery.md) covers the two stores, backup, cleanup, and an isolated restore. Secure the VM and keep the OAuth callback aligned with its stable HTTPS origin. For private access, [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve) can expose the local port only inside your tailnet; GitHub OAuth must use that tailnet HTTPS origin. If you want public access instead, use a public HTTPS reverse proxy and its public callback URL.

### Split storage on an ephemeral container host

This branch implements the optional PostgreSQL switch for a **fresh installation's structured records**. Startup runs schema migrations; the existing SQLite dataset is not imported. See the [backend notes](plans/postgres-backend.md) for its exact scope and test evidence. Uploaded bytes, workspaces, browser profiles, and engine credentials still need a durable mounted filesystem. PostgreSQL alone therefore does not make a Render Free deployment durable, and an S3 bucket cannot replace the agent's writable workspace without a separate filesystem layer. Check the chosen provider's role and schema privileges for the Data feature. [Render Free PostgreSQL expires after 30 days](https://render.com/docs/free), so it is not a durable database choice.

## Release gate for durable hosting

1. Verify the optional SQLite/PostgreSQL switch against the target provider, including startup migrations and a restart of a fresh database. SQLite remains the default; an existing SQLite dataset does not automatically migrate to PostgreSQL.
2. Provide a durable `/data` volume for attachments, workspaces, browser profiles, and engine CLI credentials. Configure optional object storage copies and bucket retention using the [recovery guide](storage-and-recovery.md).
3. Restore a backup into an isolated deployment. Verify bots, chats, GitHub sign-in, pairing, uploads, agent workspaces, and an OpenCode turn after a restart.
4. Set a stable HTTPS origin and its matching GitHub callback. Keep `GITHUB_CLIENT_SECRET` and `BETTER_AUTH_SECRET` out of Git and logs. Verify an account other than the owner is rejected.
5. Monitor health and capacity, and document how to roll back an image and recover state. A passing health probe shows that the process responds; it does not prove the agent engine or storage is healthy.

## Rebranding boundary

The root README now identifies this fork and sends users to this fork's deployment instructions. Internal `openmausbot` identifiers, data directory names, health response, CLI commands, package metadata, UI copy, icons, and desktop release pipeline still inherit upstream names. Change these as a separate compatibility-aware release: renaming the existing Compose volume or app data directory without a migration would make saved data appear missing. Hattera has no separate native mobile app or published desktop binaries yet.
