# Render deployment

This Blueprint creates one free Docker web service from this fork. It starts
the existing server on loopback and Caddy on Render's public HTTP port. Render
provides HTTPS and the canonical `RENDER_EXTERNAL_URL`; the startup script
derives `OMB_PUBLIC_URL` and `GITHUB_REDIRECT_URI` from it. No local Compose
volume or `.env` is included in the image.

If you create a Docker web service manually instead of using the Blueprint,
leave **Docker Command** empty so the image uses its default startup. Add
`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, numeric `GITHUB_OWNER_ID`, and a
random `BETTER_AUTH_SECRET` of at least 32 characters in its Environment
page. The Blueprint generates the secret for you. The default startup
derives `OMB_PUBLIC_URL` and `GITHUB_REDIRECT_URI` from
Render's `RENDER_EXTERNAL_URL`; entering those two values manually is not
needed. Engine CLIs are installed from **Manage AI accounts** when needed.
For a custom image that includes selected CLIs, `ENGINES` is an optional
build argument; the default image includes none.
Remove any `ENGINES` value from an existing Render service to use this default.

## If deployment reports 502 or out of memory

Check the runtime log before changing proxy ports. `dial tcp
127.0.0.1:8799: connect: connection refused` means Caddy cannot reach the
backend; it does not identify why the backend stopped. In the October 21
`f75c973` deployment, Render explicitly reported `Out of memory (used over
512Mi)`. Its build log also showed Claude, Codex and OpenCode installed by
an `ENGINES` override, despite this repository's empty default.

For a disposable preview, remove `ENGINES` from the service's Environment
settings and redeploy the latest commit. Check the new build log: the
server stage's engine-install loop must have no package names. This keeps
engine installation available in the app; it does not make provider CLIs,
their installers or Chromium fit the Free instance's memory limit. For
those workloads, use a server with more memory and durable storage. A
smaller Node heap does not cap native engine processes.

Use `/api/health` for the Render health check. The edge also maps legacy
`/health` checks to that same backend endpoint; a successful check must
return `{"app":"openmausbot"}`, not the application's HTML. The Caddy admin
listener is disabled because this image uses process signals for shutdown,
so Render's port scanner cannot mistake it for the public app.

The Docker workflow checks cold startup and restart of the default image
with 512 MiB, no swap, 0.1 CPU and a disposable data volume. This proves
preview readiness only, not engine installation, sign-in or chat capacity
within that budget.

### Verification on October 22, 2026

All containers used disposable `/data` volumes, fake GitHub configuration,
no network and no swap. The engine comparison used the current compiled
app and current installed CLIs, rather than the failed deployment's exact
image or provider releases.

| Fixture | Memory / CPU limit | Result |
| --- | --- | --- |
| Default preview, no engine CLIs | 512 MiB / 0.1 CPU | Cold start, restart, UI and both health paths passed; peak 159 MiB, no OOM |
| Claude, Codex and OpenCode discoverable | 512 MiB / 1 CPU | Reached 512 MiB; Docker recorded an OOM kill |
| Same three discoverable engines | 1 GiB / 1 CPU | Backend became ready; peak 596 MiB, no OOM |

The preview check also proved the admin port was closed and that suspending
the backend did not produce a successful health response. The 1 GiB result
is startup evidence only; it does not qualify concurrent chats, installs or
browser sessions at that size.

## Create the service

1. Create a separate GitHub OAuth app for Render with temporary Homepage URL
   `http://127.0.0.1:8080` and callback
   `http://127.0.0.1:8080/identity/callback/github`. Copy its client ID and
   secret privately. Update these URLs after Render gives the service its URL.
2. Push the reviewed changes to `Msalways/hattera` `main`, then open
   [Render Blueprints](https://dashboard.render.com/blueprints) and create a
   Blueprint from that repository's `render.yaml`. Confirm the
   service plan is **Free**. When prompted, enter the OAuth app's
   `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and your numeric
   `GITHUB_OWNER_ID`. Set them in Render, not in Git or chat. The Blueprint
   generates a separate `BETTER_AUTH_SECRET`. It uses disposable SQLite
   storage unless you enable PostgreSQL in the service environment.
3. After Render assigns the service URL, update the GitHub OAuth app's
   Homepage URL to that HTTPS origin and its callback URL to
   `https://<service>.onrender.com/identity/callback/github`. The startup
   script derives `OMB_PUBLIC_URL` and `GITHUB_REDIRECT_URI` from the same
   Render URL. A separate OAuth app keeps local sign-in working.
4. Visit `https://<service>.onrender.com/api/health`; it should return HTTP 200
   with `{"app":"openmausbot"}`. Then visit `/pair` and use GitHub sign-in.
   Use **Manage AI accounts** to install and sign in to an engine when needed.
   For Codex on a remote server, first enable
   device-code sign-in in your ChatGPT account's Security Settings (or ask
   your workspace admin to allow it), then start Codex sign-in in the app.
5. Optionally create an external HTTP(s) monitor for `/api/health` with a
   10-minute interval, if your monitor plan supports it. This can reduce idle
   spin-down, but it does not prevent Render from restarting the service.
   Render's own `healthCheckPath` checks readiness while the service is
   running; it does not keep an idle Free service awake. A continuously warm
   service also consumes the workspace's Free instance hours.

Render Free has an ephemeral filesystem. In the default SQLite mode, all
local records, uploads, workspaces, generated files, browser profiles, and
engine logins disappear on restart, redeploy, or idle spin-down. For an
external PostgreSQL database, add `OMB_POSTGRES_ENABLED=true` and a secret
`DATABASE_URL` in the service's Environment page. The database user needs
permission to create roles and schemas for the app's Data feature. This is a
fresh installation; it does not import existing SQLite data. Do not use
either Render Free mode for irreplaceable files or bot work. Optional S3
storage only mirrors uploads and backups; it does not restore the live bot
workspace. Tailscale is not required for this public HTTPS endpoint. See the
[hosting checklist](../../docs/hattera-hosting.md) for the durable path and
remaining gaps.
