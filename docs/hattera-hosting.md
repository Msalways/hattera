# Hattera hosting readiness

This checklist covers this fork's container deployment. The inherited [VPS guide](deploy-vps.md) describes upstream services and release packages; use the fork's [local Compose guide](../deploy/local/README.md) and [Render preview guide](../deploy/render/README.md) for Hattera.

## Already present

- The `server` target in [`Dockerfile`](../Dockerfile) builds this repository's web UI and server. It includes Caddy, the browser runtime, and the engine packages selected by the `ENGINES` build argument. `render.yaml` selects `opencode-ai`.
- [`compose.yaml`](../compose.yaml) binds the web edge to `127.0.0.1:8080` by default, runs Caddy beside the server, and mounts a named volume at `/data`. The existing `openmausbot` project and volume defaults are intentionally retained so local upgrades use the same data.
- [`render.yaml`](../render.yaml) builds this fork's `main` branch, starts the container through [`deploy/render/start.mjs`](../deploy/render/start.mjs), and checks `/api/health`.
- GitHub OAuth uses a separate `/identity/*` path, checks the configured numeric `GITHUB_OWNER_ID`, and leaves legacy `/api/auth/*` pairing available. The Render launcher derives the public URL and GitHub callback from `RENDER_EXTERNAL_URL`.
- `.env` is ignored by Git and excluded from the Docker build context. Render OAuth credentials belong in Render's environment settings.

## What must persist

| State | Current location or form | Consequence on an ephemeral host |
| --- | --- | --- |
| Chats and GitHub sign-in | SQLite files under `/data/.openmausbot` | Conversations and GitHub sessions disappear |
| Pairing sessions, bot definitions, settings, schedules, and other records | JSON and other local files under `/data/.openmausbot` | Devices and bots lose their saved state |
| Data tables and sheets | Per-bot DuckDB and `sheet.json` | Bot data work disappears |
| Uploads, generated files, and agent workspaces | Files below `/data/.openmausbot` | Attachments and working files disappear |
| Engine sign-ins | CLI home directories below `/data` | OpenCode or other engines need sign-in again |

Render [documents that Free web services lose local file changes on spin-down, restart, and redeploy](https://render.com/docs/free). Its Free web services cannot attach a persistent disk. An external `/api/health` monitor at a 10-minute interval can reduce idle spin-down if the monitor plan supports that interval, but does not make any of this state durable or prevent maintenance restarts. Render's own health check is a readiness probe, not a keep-awake service.

The [Free web plan has 512 MB RAM and 0.1 CPU](https://render.com/docs/compute-plans), so a successful build or health response does not prove an OpenCode or browser task fits. Keeping the service warm uses the workspace's [750 Free instance hours per month](https://render.com/docs/free), shared with its other Free services.

## Paths to use

### Disposable public preview

Use the Render Blueprint with GitHub OAuth and the public Render HTTPS URL. No Tailscale installation is needed on Render. Treat chats, files, and logins as disposable. Check `/api/health`, then test the GitHub callback, a paired browser, and an OpenCode turn after each deploy. This path has no recovery promise.

### Persistent self-hosting

Run the existing Compose stack on an always-on VM with durable host storage behind the `/data` volume. Back up that volume regularly, keep backup copies off the VM, and test a restore into a separate volume before trusting it. Secure the VM and keep the OAuth callback aligned with its stable HTTPS origin. For private access, [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve) can expose the local port only inside your tailnet; GitHub OAuth must use that tailnet HTTPS origin. If you want public access instead, use a public HTTPS reverse proxy and its public callback URL.

### Future split storage on an ephemeral container host

The optional PostgreSQL backend is still being developed on a separate branch. The deployable `main` branch has no production-ready `OMB_POSTGRES_ENABLED` switch. PostgreSQL must cover **all** structured state before it can replace the local records for this use case; Better Auth alone is insufficient. DuckDB files, uploads, workspaces, and engine credentials also need durable storage or a redesign. Do not enable a PostgreSQL flag in the Render Blueprint until the runtime switch and restart tests are complete. [Render Free PostgreSQL expires after 30 days](https://render.com/docs/free), so it is not a durable database choice.

## Release gate for durable hosting

1. Finish and verify the optional SQLite/PostgreSQL switch, including startup schema setup and fresh database initialization. Keep SQLite as the default; an existing SQLite dataset does not automatically migrate to PostgreSQL.
2. Decide where DuckDB, attachments, workspaces, and engine CLI credentials persist, and define cleanup and retention rules for each. A database URL alone does not solve those files.
3. Restore a backup into an isolated deployment. Verify bots, chats, GitHub sign-in, pairing, uploads, agent workspaces, and an OpenCode turn after a restart.
4. Set a stable HTTPS origin and its matching GitHub callback. Keep `GITHUB_CLIENT_SECRET` and `BETTER_AUTH_SECRET` out of Git and logs. Verify an account other than the owner is rejected.
5. Monitor health and capacity, and document how to roll back an image and recover state. A passing health probe shows that the process responds; it does not prove the agent engine or storage is healthy.

## Rebranding boundary

The root README now identifies this fork and sends users to this fork's deployment instructions. Internal `openmausbot` identifiers, data directory names, health response, CLI commands, package metadata, UI copy, icons, and desktop release pipeline still inherit upstream names. Change these as a separate compatibility-aware release: renaming the existing Compose volume or app data directory without a migration would make saved data appear missing. Hattera has no separate native mobile app or published desktop binaries yet.
