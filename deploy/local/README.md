# Local Docker Compose

From the repository root, run `docker compose up -d --build`, then open
http://localhost:8080. Docker with Linux containers is required.
Compose supplies defaults; no `.env` file is required.
The application container uses Docker's init process to reap orphaned agent
subprocesses.

To customize, copy `.env.example` to `.env` in the repository root.
The `.env` file is ignored by Git. Shell environment variables take precedence.
`OMB_HTTP_PORT` changes the host port and the default public URL.
Internal service ports remain fixed inside the shared network namespace.
Compose builds this checkout's `Dockerfile` server target. `ENGINES` selects
space-separated npm packages; the default includes OpenCode, Claude Code,
Codex, and Cline. An empty value skips CLI installation. These default CLIs
are baked into the image, so the running container does not need npm registry
access to start them. Provider sign-in still happens after the container starts.
An existing `.env` with `ENGINES=` overrides this default; add `cline` to that
list and rebuild if you want Cline baked into an existing local deployment.

For Tailscale Serve, set `OMB_PUBLIC_URL` to your HTTPS URL and
`OMB_HTTPS_HOST` to its hostname without scheme or path. Configure Tailscale
Serve on the host to forward to the chosen localhost HTTP port.
Keep the default `OMB_BIND_ADDRESS=127.0.0.1`. Caddy refuses to start when
`OMB_HTTPS_HOST` is set with any other bind address, so direct remote HTTP
clients cannot claim HTTPS semantics by supplying that hostname.
The hostname mapping preserves HTTPS
semantics for that host while localhost access continues to use HTTP.
Private tailnet webhook URLs are only reachable by callers on that tailnet.
Without `OMB_HTTPS_HOST`, the bind address can be changed for HTTP access.
Only use HTTPS hostname mapping with a trusted local TLS-terminating proxy.

For GitHub sign-in, set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`,
`BETTER_AUTH_SECRET`, and your stable numeric `GITHUB_OWNER_ID` in `.env`.
Set `GITHUB_REDIRECT_URI` to
`https://<tailnet-host>/identity/callback/github` and register that exact
callback in the GitHub OAuth app. `OMB_PUBLIC_URL` must use the same HTTPS
origin. For testing only on this computer, use `OMB_PUBLIC_URL=http://127.0.0.1:8080`
and `GITHUB_REDIRECT_URI=http://127.0.0.1:8080/identity/callback/github`.
Open the app at `http://127.0.0.1:8080`; keep `OMB_BIND_ADDRESS=127.0.0.1`
and `OMB_HTTPS_HOST` empty. GitHub's OAuth app Homepage URL can be
`http://127.0.0.1:8080`. These values are passed to the server; its identity
database lives on the persistent `/data` volume.

Open Hattera on the server computer at `http://127.0.0.1:8080`. In
**Settings → AI → Model providers and accounts**, expand a provider to install
its CLI and complete the sign-in it supports. For another device, use
**Settings → Remote access → Create pairing code** and open the pairing link on
that device. Provider authorization still requires your account.

Codex browser sign-in starts in the web app. Compose publishes its fixed
`127.0.0.1:1455` callback on the Docker host's loopback address and Caddy
forwards that callback to the CLI inside the container. Local browser sign-in
then finishes automatically. On another computer, the final localhost page
may fail to load; copy its full address from the browser and paste it into
**Final browser address** in Hattera. This forwards only the callback for the
sign-in you started. Keep the address private. The one-time-code option remains
available when your ChatGPT account permits it.

For terminal-based setup or recovery, the equivalent commands are:

```sh
docker compose exec omb codex login --device-auth
docker compose exec omb node dist-server/openmausbot.js pair
```

On Windows, `./maus.ps1` forwards arguments to Compose using the repository
directory. It respects Docker's selected context and `DOCKER_CONTEXT`.

Data and engine credentials persist in the named data volume. For an existing
volume, set `OMB_DATA_VOLUME` to its name and `OMB_DATA_EXTERNAL=true`.
Fresh installs create their volume automatically. The external volume may use
any Docker volume driver that presents a durable POSIX filesystem at `/data`;
the app does not depend on a particular storage vendor. See the
[storage and recovery guide](../../docs/storage-and-recovery.md) before moving
to another host.

For a fresh PostgreSQL installation, set `OMB_POSTGRES_ENABLED=true` and
`DATABASE_URL` in the local `.env`. The server runs Knex migrations at startup.
Compose passes `OMB_POSTGRES_FILES_DIR=/data/.openmausbot-postgres`, so uploads,
bot workspaces, and engine credentials remain on the named `/data` volume.
Keep that volume even though PostgreSQL stores chats and other structured
records. The server checks the file directory's database marker and refuses
to mix it with a different database. Switching an existing SQLite install to
PostgreSQL does not import its data.

For offsite copies of uploads and encrypted SQLite-mode workspace backup
exports, set `OMB_OBJECT_STORAGE_KIND=s3` and the `OMB_S3_*` values in `.env`.
Any S3-compatible private bucket can be used. The `/data` volume remains
required; see the [recovery guide](../../docs/storage-and-recovery.md) for
restore scope and retention.

Update with `docker compose build --pull` followed by `docker compose up -d`.
Stop with `docker compose stop`. `docker compose down -v` deletes managed volumes.
