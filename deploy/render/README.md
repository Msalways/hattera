# Render deployment

This Blueprint creates one free Docker web service from this fork. It starts
the existing server on loopback and Caddy on Render's public HTTP port. Render
provides HTTPS and the canonical `RENDER_EXTERNAL_URL`; the startup script
derives `OMB_PUBLIC_URL` and `GITHUB_REDIRECT_URI` from it. No local Compose
volume or `.env` is included in the image.

1. Create a fresh external PostgreSQL database. Its connection URL must be
   available to Render as `DATABASE_URL`; do not use Render Free PostgreSQL
   for data you need to keep, because that database expires after 30 days.
   The database user needs permission to create roles and schemas for the
   app's Data feature. This is a new installation: enabling PostgreSQL does
   not import records from the local SQLite installation.
2. Create a separate GitHub OAuth app for Render with temporary Homepage URL
   `http://127.0.0.1:8080` and callback
   `http://127.0.0.1:8080/identity/callback/github`. Copy its client ID and
   secret privately. Update these URLs after Render gives the service its URL.
3. Push the reviewed changes to `Msalways/hattera` `main`, then open
   [Render Blueprints](https://dashboard.render.com/blueprints) and create a
   Blueprint from that repository's `render.yaml`. Confirm the
   service plan is **Free**. When prompted, enter the OAuth app's
   `DATABASE_URL`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and your numeric
   `GITHUB_OWNER_ID`. Set them in Render, not in Git or chat. The Blueprint
   enables PostgreSQL and generates a separate `BETTER_AUTH_SECRET`.
4. After Render assigns the service URL, update the GitHub OAuth app's
   Homepage URL to that HTTPS origin and its callback URL to
   `https://<service>.onrender.com/identity/callback/github`. The startup
   script derives `OMB_PUBLIC_URL` and `GITHUB_REDIRECT_URI` from the same
   Render URL. A separate OAuth app keeps local sign-in working.
5. Visit `https://<service>.onrender.com/api/health`; it should return HTTP 200
   with `{"app":"openmausbot"}`. Then visit `/pair` and use GitHub sign-in.
6. Optionally create an external HTTP(s) monitor for `/api/health` with a
   10-minute interval, if your monitor plan supports it. This can reduce idle
   spin-down, but it does not prevent Render from restarting the service.
   Render's own `healthCheckPath` checks readiness while the service is
   running; it does not keep an idle Free service awake. A continuously warm
   service also consumes the workspace's Free instance hours.

Render Free has an ephemeral filesystem. This Blueprint stores structured
records in PostgreSQL, but uploads, workspaces, generated files, browser
profiles, and engine logins still disappear on restart, redeploy, or idle
spin-down. Do not use this deployment for irreplaceable files or bot work.
The image includes OpenCode; its login may need to be repeated after a
restart. Optional S3 storage only mirrors uploads and backups; it does not
restore the live bot workspace. Tailscale is not required for this public
HTTPS endpoint. See the
[hosting checklist](../../docs/hattera-hosting.md) for the durable path and
remaining gaps.
