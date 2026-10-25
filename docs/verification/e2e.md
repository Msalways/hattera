# Hattera E2E setup

From the repository root, with dependencies installed, Node.js 24+ and Go
available:

```sh
npm run test:e2e
```

This command checks types, locales and contrast; builds fresh web/server/network
artifacts; prepares the browser and peer fixture; and runs required application
contracts plus browser journeys. It does not accept a live app URL or discover a
running personal installation. Each app and browser uses a new temporary home.
No provider needs to be preinstalled or logged in for these fixtures.

The Go helper is prepared automatically from its source. A missing executable or
failed prerequisite fails the command. The three-app scenario no longer silently
skips when `OMB_VERIFY_PEER_HELPER` is absent. Package-manager installation uses
the version declared in `package.json`; no global pnpm executable is needed once
the repository dependencies are installed.

## Coverage

- All 19 supported account-profile families: HTTP creation, credential isolation,
  rename and removal. Bedrock and the supported key/model forms also exercise
  configuration, selected-account removal guards and public-response redaction.
- Native install contracts cover every registered CLI installer, verification,
  failure/retry and removal. All ten npm installers also run through the real
  HTTP route and npm against an isolated registry. POSIX/Windows-specific cases are recorded separately
  in `platform-tests.json` and run on their matching CI platform.
- Provider authentication session ownership, cancellation/retry, both Codex
  methods, browser callback handling, startup network errors and saved setup.
- Durable usage, missing telemetry, API/CSV results, background launcher reuse,
  wrong-process shutdown denial and restart persistence.
- The existing 31-journey browser smoke covers chat, models, settings, tools,
  memory, skills, provider setup, install/remove/reinstall, pairing and skin/layout
  checks. Its CLI download uses a disposable local npm registry.
- Three independent apps are driven through their real sharing UI: consent,
  invitation/join, creator offline, another manager's invitation, bidirectional
  conversation, phone roster, restart/reconnect, pause/resume and revocation.
  Pointer clicks must reach visible controls; covered or disabled controls fail.
- HTTP checks cover forged peers, file-access denial, duplicate delivery and
  lost-key recovery without breaking ordinary local app startup.
- [Shared provider execution](shared-execution.md): three native adapters on
  independent installations, owner approval, reverse routing, no permanent
  primary, identical local instance IDs, usage, cancellation, revocation and
  durable retry/restart rules. Browser checks grant a bot to a specific person,
  select their target, approve and render the response at phone width.

Required application scenarios must execute with zero skipped/pending tests.
This gate is distinct from the platform-specific installer contracts. The Windows,
Linux and macOS CI matrix runs the same `npm run test:e2e` command and uploads its
reports even on failure. The Linux job additionally enables the clean Docker gate.

## Results and failures

Every run has a new directory under `output/e2e/` containing:

- `report.json`: stage results, durations, log paths and the run's qualification
  limits. `ok` becomes true only after all requested stages succeed.
- `tests.json`: required test results; `platform-tests.json`: explicit platform
  applicability and results.
- Stage logs, app screenshots and collaboration screenshots. Failed collaboration
  checks retain peer logs and screenshots before teardown.

A failed step exits nonzero. Fixture app processes are owned by their launcher,
and test-parent loss closes their private IPC lifeline. They do not borrow an
existing runtime. No live data, account credentials or Compose volumes are used.

## Edge or another installed Chromium browser

Browser tools are prepared automatically. To use Edge explicitly on Windows:

```powershell
$env:OMB_VERIFY_BROWSER_CHROME = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
npm.cmd run test:e2e
```

The selected executable still receives a fresh browser profile. The command does
not use its existing cookies or signed-in account.

## Packaged Docker and official sign-in challenge

```sh
npm run test:e2e -- --docker --live-network
```

Docker must be running. This builds a uniquely tagged server image from the
current checkout with `ENGINES` empty, then starts only an owned disposable
container with a private tmpfs data directory. It checks non-root operation,
forwarded-request denial, packaged networking and absence of preinstalled provider
CLIs. The container and uniquely tagged image are removed afterwards.

`--live-network` obtains and cancels an official Tailscale browser challenge using
a fresh app identity on the host and, with `--docker`, in the container. It does
not authorize an account. Public vendor CLI download/auth probes remain separate
qualification checks in [provider coverage](provider-coverage.md).

## What a green run establishes

A green run does not establish selecting or executing through a colleague's
provider account. That workflow is unimplemented across providers: remote account
advertisement, owner grants, target selection and remote job execution are absent.
See the [people and provider audit](collaboration-audit.md) for the full acceptance
contract. Local multi-account tests and group text tests do not cover that journey.

Provider responses and peer connectivity are simulated in the normal application
and browser fixtures. This proves the implemented app flows and boundaries; it
does not prove a person's subscription login, real quotas, public provider
downloads, or communication between signed-in physical devices. The report states
these limits explicitly. Use [human-group acceptance](human-groups.md) for the live
two-device checklist and unfinished product features; unavailable roadmap features
are not counted as passing E2E functionality.
