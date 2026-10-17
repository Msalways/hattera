# Oracle Always Free VM

Run the existing Hattera server and Caddy on an Ampere A1 (Linux Arm64) VM.
This Compose overlay adds a private PostgreSQL container. PostgreSQL keeps
structured records; the app volume still holds workspaces, uploads, browser
profiles, and engine sign-ins. Engine CLIs remain optional and install from
**Manage AI accounts** when requested.

## Prepare the VM

1. Choose an Always Free eligible A1 shape and Ubuntu Arm64 image in the
   account's home region. Attach a durable block volume. Mount it before Docker
   starts and put Docker's `data-root` on that mounted filesystem, so **both**
   critical named volumes (`hattera_data` and `hattera_postgres_data`) survive VM
   replacement. Confirm the mount after every reboot before starting Compose.
2. Install Docker Engine with the Compose plugin and Tailscale on the host.
   Keep OCI ingress closed for ports 80, 443, and 5432 when using private
   Tailscale access. Restrict SSH to your own IP or tailnet.
3. Clone this fork. Copy `.env.example` in this directory to `.env`, set
   `POSTGRES_PASSWORD` to a URL-safe random value, fill the GitHub OAuth values,
   and make `.env` readable only by the VM account. Do not commit it.

For private access, replace the local URLs in `.env` with one stable Tailscale
HTTPS origin. The three values must agree:

```dotenv
OMB_PUBLIC_URL=https://machine.tailnet.ts.net
OMB_HTTPS_HOST=machine.tailnet.ts.net
GITHUB_REDIRECT_URI=https://machine.tailnet.ts.net/identity/callback/github
```

Register that exact callback in a **separate** GitHub OAuth app. Browser and
phone devices must be in the tailnet. Third-party webhooks cannot reach a
Tailscale Serve-only URL.

Tailscale Serve obtains a Let's Encrypt certificate for the tailnet hostname
and handles renewal automatically. Enable MagicDNS and HTTPS certificates in
the tailnet before running `tailscale serve`. There is no certificate file or
80-day renewal job to maintain. See [Tailscale's HTTPS guide](https://tailscale.com/docs/how-to/set-up-https-certificates).

### Optional public domain

If the app should be reachable outside the tailnet, point a DNS `A` record at
the VM's public IPv4 address and open TCP 80 and 443 in both the OCI ingress
rules and the VM firewall. Use an `AAAA` record only when public IPv6 actually
works. In `.env`, set `OMB_PUBLIC_HOST=app.example.com`,
`OMB_PUBLIC_URL=https://app.example.com`, and
`GITHUB_REDIRECT_URI=https://app.example.com/identity/callback/github`; leave
`OMB_HTTPS_HOST` empty. Register that callback in the GitHub OAuth app. Then
start the public overlay from the repository root:

```sh
docker compose --env-file deploy/oracle/.env -f compose.yaml -f deploy/oracle/compose.yaml -f deploy/oracle/public.compose.yaml up -d --build
```

The public overlay makes Caddy listen on 80 and 443 and use Let's Encrypt for
the named host. Caddy renews certificates automatically before expiry, so a
fixed 80-day scheduler is unnecessary. Its `caddy_data` volume stores the ACME
account and certificates; keep that volume on the durable Docker filesystem.
This mode exposes the app to the internet, protected by its sign-in. See
[Caddy's automatic HTTPS guide](https://caddyserver.com/docs/automatic-https).

### Optional public IPv4 without a domain

Let's Encrypt also issues certificates for public IP addresses. These use its
`shortlived` profile and last about **six days**, so an 80-day renewal schedule
would fail. Caddy can request the profile and renew the certificate itself.
Oracle assigns an ephemeral public IPv4 address by default when the VM launches
in a public subnet. It lasts for the instance, but changes if that instance is
replaced. For a durable literal-IP URL and GitHub callback, assign an OCI
reserved public IP before configuring the app. Private or Tailscale IP
addresses cannot pass the public ACME challenge. Open TCP 80 and 443 in OCI
and the VM firewall.
In `.env`, set:

```dotenv
OMB_PUBLIC_HOST=203.0.113.10
OMB_PUBLIC_URL=https://203.0.113.10
OMB_HTTPS_HOST=
GITHUB_REDIRECT_URI=https://203.0.113.10/identity/callback/github
```

Replace the documentation address with the VM's actual public IP, and register
that exact GitHub callback. Start from the repository root:

```sh
docker compose --env-file deploy/oracle/.env -f compose.yaml -f deploy/oracle/compose.yaml -f deploy/oracle/public-ip.compose.yaml up -d --build
```

The IP overlay sets Caddy's default TLS name for browsers that omit SNI when
connecting to an IP. Its certificate and ACME account remain in `caddy_data`.
See [Let's Encrypt's IP certificate announcement](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)
and [Caddy's ACME profile setting](https://caddyserver.com/docs/caddyfile/directives/tls).

## Start and verify private mode

Run these commands from the repository root:

```sh
docker compose --env-file deploy/oracle/.env -f compose.yaml -f deploy/oracle/compose.yaml config --quiet
docker compose --env-file deploy/oracle/.env -f compose.yaml -f deploy/oracle/compose.yaml up -d --build
curl -fsS http://127.0.0.1:8080/api/health
tailscale serve --bg 8080
tailscale serve status
```

Caddy shares the app's network namespace and forwards only to the server's
loopback listeners. In private mode, Tailscale Serve supplies HTTPS to Caddy's
`127.0.0.1:8080` host port. `OMB_HTTPS_HOST` makes Caddy forward HTTPS origin
semantics for that exact hostname. PostgreSQL publishes no host port. For
public mode, use the relevant three-file command above instead of this two-file
command and do not run `tailscale serve` for the app.

Verify GitHub owner sign-in, rejected non-owner sign-in, legacy pairing and
logout, an on-demand OpenCode install and turn, and a restart that retains a
chat and a workspace file. For an isolated local test, use a distinct Compose
project and volumes, local `127.0.0.1` URLs, and fake OAuth credentials; never
point the fixture at live app data.

## Keep the data

Back up PostgreSQL and the app volume as a pair. Stop the app during the copy,
take a PostgreSQL dump and an archive of the app volume, then store encrypted
copies outside the VM. In public mode, include `caddy_data` to preserve the
ACME account and certificates. Test restoring into separate volumes and a
separate database. The S3 upload mirror alone does not restore workspaces or
PostgreSQL.
See [storage and recovery](../../docs/storage-and-recovery.md).

To update, rebuild and recreate the stack with the same Compose command.
For a manual restart, use `docker compose` with the same environment and file
arguments as above and run `restart omb`. Compose waits for the app to become
healthy and then restarts Caddy in the app's current network namespace. If
Docker restarts the app after a crash, Caddy checks the app health endpoint and
restarts itself when its old network namespace can no longer reach the app.
`docker compose down` leaves the volumes; `down -v` deletes them. A fresh
PostgreSQL installation does not import existing SQLite or Render data.
