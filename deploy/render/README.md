# Disposable Render deployment

This Blueprint creates one free Docker web service from this fork. It starts
the existing server on loopback and Caddy on Render's public HTTP port. Render
provides HTTPS and the canonical `RENDER_EXTERNAL_URL`; the startup script
derives `OMB_PUBLIC_URL` and `GITHUB_REDIRECT_URI` from it. No local Compose
volume or `.env` is included in the image.

1. Push this branch to a GitHub repository you control, then open
   [Render Blueprints](https://dashboard.render.com/blueprints) and create a
   Blueprint from that repository's `render.yaml` on this branch. Confirm the
   service plan is **Free**.
2. Enter `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and the numeric
   `GITHUB_OWNER_ID` when Render prompts. You can use the existing local OAuth
   app's credentials for this initial deploy. Set them in Render's dashboard,
   not in Git or chat. The Blueprint generates a separate `BETTER_AUTH_SECRET`.
3. After Render assigns the service URL, register a separate GitHub OAuth app
   for this deployment. Set its Homepage URL to the Render HTTPS origin and
   its callback URL to `https://<service>.onrender.com/identity/callback/github`.
   Replace Render's client ID and secret with that app's values. A separate
   OAuth app keeps the local callback registration working. GitHub sign-in
   on Render will work after its callback and environment agree.
4. Visit `https://<service>.onrender.com/api/health`; it should return HTTP 200
   with `{"app":"openmausbot"}`. Then visit `/pair` and use GitHub sign-in.
5. In UptimeRobot, create an **HTTP(s)** monitor for the same `/api/health`
   URL. Its free plan checks every 5 minutes, which is frequent enough to
   prevent Render's 15-minute idle sleep under normal operation. Render's own
   `healthCheckPath` checks readiness while the service is running; it does
   not keep an idle Free service awake.

Render Free has an ephemeral filesystem. Its SQLite databases, session keys,
chats, workspaces, uploads, and engine logins disappear on restart, redeploy,
or idle spin-down. The external monitor only reduces idle spin-down; it cannot
prevent maintenance restarts or preserve files. Use this service only for
throwaway testing. The image includes OpenCode; sign in to an engine again if
the service restarts.
