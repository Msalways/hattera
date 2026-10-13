# Disposable Render deployment

This Blueprint creates one free Docker web service from this fork. It starts
the existing server on loopback and Caddy on Render's public HTTP port. Render
provides HTTPS and the canonical `RENDER_EXTERNAL_URL`; the startup script
derives `OMB_PUBLIC_URL` and `GITHUB_REDIRECT_URI` from it. No local Compose
volume or `.env` is included in the image.

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
   generates a separate `BETTER_AUTH_SECRET`.
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

Render Free has an ephemeral filesystem. Its SQLite databases, session keys,
chats, workspaces, uploads, and engine logins disappear on restart, redeploy,
or idle spin-down. Use this service only for throwaway testing. The image
includes OpenCode; sign in to an engine again if the service restarts. Tailscale
is not required for this public HTTPS endpoint. See the
[hosting checklist](../../docs/hattera-hosting.md) for the durable path and
remaining gaps.
