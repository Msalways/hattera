# Account profiles and the persistent local launcher

These checks use disposable homes and repository fake engines. They do not
authorize real provider accounts or modify the running Docker installation.

## Account lifecycle

Model providers and accounts offers **Add another account** for the 19 built-in
engines whose credential storage Hattera understands. The arbitrary custom ACP
adapter has no inferred vendor identity or safe automatic profile setup.

New accounts get distinct native homes and no copied keys, login files, provider
headers or auth-selecting CLI arguments. An existing executable can be reused;
custom wrapper commands can be selected explicitly on the new account's card.
Workspace credentials and routing are suppressed for private accounts. The same
resolved environment reaches native setup, auth, model discovery, inference and
account reporting. API forms write only the chosen account's credential; native
wrapper settings are written only in that account's home.

Profiles can be renamed or removed in the UI. Removal refuses selected defaults,
bot/fallback/thread references and active sign-ins/installations. It removes the
configuration entry and retains history, native credentials and shared engine
files. A new account always receives a fresh ID and cannot silently reuse those
retained credentials. Existing Claude/ChatGPT/Antigravity auth URLs remain valid.

```powershell
node node_modules/vitest/vitest.mjs run server/provider-profiles.test.ts server/provider-account-setup.test.ts server/account-usage.test.ts --maxWorkers 1
$env:OMB_VERIFY_SERVER_ENTRY = (Resolve-Path dist-server/index.js).Path
node node_modules/vitest/vitest.mjs run server/provider-account-setup.e2e.test.ts --maxWorkers 1
```

The matrix covers all registered engines, empty versus inherited credentials,
private native settings for Cline/Qwen/pi/Hermes/OpenCode and per-account API keys.
The real HTTP fixture exercises creation, renaming and deletion for all 19
account-profile families. Supported account forms additionally exercise configuration
and credential redaction, including Bedrock region routing. Run these together
with the browser checks through [the E2E command](e2e.md).
The full Edge smoke also creates, renames and removes a profile through the real
UI, then verifies the original engine and account still exist (31 journeys).

## Persistent runtime

`node dist-server/hattera.js web --no-open` starts the existing `serve`
supervisor in the background. `web --cli-only` suppresses browser opening; it
does not yet provide the planned terminal coding/task interface. Packaged npm
builds add a `hattera` executable alias and retain `openmausbot` compatibility.
No upstream npm release is implied by these source changes.

The local browser opened by `hattera web` enters the app directly, including on
the first launch. It skips both GitHub sign-in and pairing. The launcher marks
that process as local CLI mode; a URL such as `?cli=1` cannot enable the mode.
Forwarded requests and other computers still require a session.
Provider authorization is separate and remains necessary when a provider asks
for it. The launcher fixture checks both unauthenticated local administrator
access and denial of a forwarded caller without a session.

Self-hosted `serve`, Docker and Render installations require authentication by
default, including from their own host. Configured GitHub sign-in remains the
entry gate; the Render entry point explicitly removes any inherited local CLI
marker. A legacy `OMB_LOOPBACK_TRUST=owner` override cannot skip configured
self-hosted GitHub authentication. Without GitHub, that explicit operator override
retains its legacy meaning; it is not the default. The `serve` CLI can still print
the first pairing code through its private bootstrap capability, and that code
must be redeemed before the browser can administer the server.

Runtime discovery contains only a port, PID, nonce and environment identity.
Before reuse, the launcher checks both HTTP process identity and the installation's
environment ID. Opening from another cwd or asking for another port reuses a
verified existing runtime. The existing data-directory lease remains the single
writer authority, including concurrent and old-version launches. Discovery is
excluded from backup/restore. Its cleanup cannot remove a successor's record.
The supervisor retains the existing restart handling. `hattera stop` and the
background-runtime Settings control use the admin HTTP shutdown path; foreground
and desktop-owned runtimes cannot be stopped by this path.

```powershell
$env:OMB_VERIFY_SERVER_ENTRY = (Resolve-Path dist-server/index.js).Path
node node_modules/vitest/vitest.mjs run server/local-runtime.e2e.test.ts server/workspace-backup-policy.test.ts --maxWorkers 1
```

The real-process fixture changes cwd, requests a different port, checks reuse,
denies forwarded shutdown, stops/restarts and verifies unchanged config and
environment identity. It also launches separate self-hosted processes with and
without synthetic GitHub configuration, rejects CLI URL flags and unauthenticated
administration, and verifies the real GitHub authorization redirect without
logging in. No user data or real provider login is used.

The renderer's GitHub button, callback-origin navigation and rejection of a
forged CLI query flag are checked separately with a loopback identity fixture:

```powershell
node scripts/testing/github-origin-browser.mjs 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
```

Real-account authorization, provider-reported allowances, platform-specific native
keychain behavior and native wrapper installations still require the qualification
listed in [provider coverage](provider-coverage.md). Group membership and replication
are covered by [human groups](human-groups.md); owner-approved account delegation
is covered by [shared execution](shared-execution.md). The terminal coding/task
interface and project harness remain separate work.
