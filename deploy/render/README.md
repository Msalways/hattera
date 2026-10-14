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
needed. The image includes OpenCode and Codex by default; set `ENGINES` only
when you want a different list of engine CLI packages, and rebuild after
changing it. If the service already has an `ENGINES` environment value, set
it to `opencode-ai @openai/codex` to match this default.

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
