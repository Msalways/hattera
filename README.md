# Hattera

Hattera is a self-hosted AI agent chat prototype based on [OpenMausBot](https://github.com/milind-soni/OpenMausBot). This fork adds owner-only GitHub sign-in, a Docker Compose setup built from this repository, an OpenCode-enabled server image, and a Render Free preview configuration.

The browser app and public docs use the Hattera identity. Package IDs, CLI commands, protocol identifiers, `OMB_*` settings, stored paths, and Compose volumes retain upstream names for compatibility. Upstream desktop release downloads are not Hattera releases.

## Run locally

Install Docker with Linux containers, then from the repository root:

```sh
docker compose up -d --build
```

Open `http://127.0.0.1:8080/pair`. Compose builds this checkout's server image and saves app data and engine sign-ins in the named Docker volume. The existing Compose project and volume names stay `openmausbot` so current local data remains attached.

For a fresh, separate browser-app run from this checkout, build the web app and start the local launcher. Add `--tailscale` to publish it to signed-in devices on your tailnet through Tailscale Serve:

```sh
npm run build
node --experimental-strip-types scripts/start-hattera-local.ts --tailscale
```

The flag uses the existing `serve --tailscale` integration, prints the HTTPS and pairing links, and turns off the endpoint on normal shutdown. Tailscale must be installed, running, signed in, and able to issue HTTPS certificates for the tailnet. Hattera refuses to replace an endpoint already using HTTPS port 443. If a crashed process leaves Serve active, run `tailscale serve --https=443 off` after confirming that it is Hattera's endpoint. Omit `--tailscale` for local-only use. This launcher writes a fresh data directory under `.omb-scratch`; it does not attach to the Compose volume.

The launcher reports whether its process can reach the Codex sign-in and npm registry hosts. A reachable host does not prove that an account is authorized or a provider is installed. The server needs outbound HTTPS for provider sign-in and downloads; proxy and trusted CA settings must be available to the server process.

For a Codex CLI account, Hattera offers browser sign-in and a one-time code in the web app. Local Docker Compose forwards Codex's callback automatically. From another device, paste the final localhost callback address into Hattera if the browser cannot open it; Hattera verifies that it belongs to the sign-in started in that session. Both choices require the server to reach OpenAI's authentication service, and the person signing in must authorize their own account. API-key providers use their separate key setup.

To enable GitHub sign-in, copy `.env.example` to `.env` and set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `BETTER_AUTH_SECRET`, and the allowed account's numeric `GITHUB_OWNER_ID`. For local OAuth, set `OMB_PUBLIC_URL=http://127.0.0.1:8080` and `GITHUB_REDIRECT_URI=http://127.0.0.1:8080/identity/callback/github`; register that exact callback in your GitHub OAuth app. Keep `.env` out of Git. See [local deployment](deploy/local/README.md) for pairing, CLI login, port changes, and optional Tailscale Serve.

## Hosting choices

| Setup | Availability | Data location | Intended use |
| --- | --- | --- | --- |
| Local Compose | While your computer is on | Named Docker volume | Development and private use |
| [Render Free preview](deploy/render/README.md) | Can sleep or restart | Ephemeral container filesystem | Disposable testing only |
| [Oracle Always Free VM](deploy/oracle/README.md) | While the VM runs | PostgreSQL and VM-backed Docker volumes | Durable private hosting with backups |

The included [Render Blueprint](render.yaml) builds the `main` branch of this fork as a Docker web service. Render supplies a public HTTPS URL; the server's own health endpoint is `GET /api/health`. Set GitHub OAuth credentials in Render's dashboard and register `https://<service>.onrender.com/identity/callback/github` for that deployment. A public Render URL does not require Tailscale. On a VM, Tailscale Serve can instead make the app reachable only to devices on your tailnet.

**Do not put important data on Render Free.** SQLite is the default. The optional PostgreSQL backend can retain structured records, and an optional S3-compatible bucket can copy uploads and encrypted backup exports, but bot workspaces and CLI credentials still need a durable `/data` filesystem. Render Free does not provide a persistent disk; restarts, redeploys, and idle spin-down can erase those files. An external uptime monitor cannot preserve them. See the [hosting readiness checklist](docs/hattera-hosting.md) before using Hattera with data you need to keep.

## Project status

This is an early fork for one GitHub owner. A production deployment still needs durable storage for **all** structured records and files, backup and restore testing, and a deployment environment that can run agent CLIs and their long-lived work. Desktop release identity, native mobile branding, and the proposed SDK are separate future work.

## Upstream and license

Hattera derives from [OpenMausBot](https://github.com/milind-soni/OpenMausBot) by Milind Soni and contributors. The open-source portion is under [Apache License 2.0](LICENSE); `enterprise/` has its [own license](enterprise/LICENSE). See [LICENSING.md](LICENSING.md) and bundled third-party notices for details. Upstream documentation remains useful for inherited features, but upstream services and releases are not operated by this fork.
