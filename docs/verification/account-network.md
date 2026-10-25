# Account reporting and app-managed Tailscale

This is the first implementation milestone of the
[local collaboration plan](../plans/hattera-local-collaboration.md). Human group
membership and peer synchronization now have a separate [implementation and
verification record](human-groups.md); remote group actions and the project harness
remain unfinished. The persistent launcher and account
profile lifecycle now have [their own verification](profiles-runtime.md).
Connecting a tailnet does not implement group collaboration.

## Implemented behavior

- Settings → Account includes Usage in Simple mode. Every configured provider
  instance has a reporting row, including unavailable and custom engines.
- Account snapshots support arbitrary windows, model/product scopes, balances,
  unknown values, sources, collection times and stale data. The old percent-window
  response fields remain available for compatible clients where representable.
- Codex reads limits and activity in one bounded, read-only app-server process.
  Native probes are serialized and deferred during active provider work. HTTP
  requests return cached/initial rows immediately while a background refresh runs.
- Claude/Grok retain their existing account endpoints. OpenRouter adds its
  documented current-key budget API. API response headers and Claude/Codex native
  events update observed limits without paid inference probes.
- Kimi API connections add quota windows and wallet reporting; MiniMax adds plan
  windows and API balances using each connection's effective key/region. See the
  [complete provider matrix](provider-coverage.md) for auth-route limitations and
  the distinction between Kimi API-key reporting and native managed OAuth.
- Usage history can group by named account. New ledger rows distinguish missing
  token telemetry from real zero usage; CSV exports include the account and token
  reporting status, with blank token cells for unreported usage.
- Settings → Computers → Remote access includes an app-owned Tailscale connection,
  browser sign-in, approval state, peer presence and disconnect. It uses a packaged
  tsnet executable, not the host's VPN installation. It starts disabled and restores
  an explicitly enabled connection after restart.
- `OMB_TAILSCALE_ENABLED=1` enables the connection on first launch; a subsequent UI
  choice is persisted. `OMB_NETWORK_HELPER` is an operator-only executable override.
  The browser cannot choose an executable, state path, upstream or auth key.
- Tailnet requests retain the app's existing pairing/sign-in requirements. Forwarded
  requests cannot acquire loopback-owner privileges, even with a forged Host. Scoped
  clients cannot administer networking or inspect private account allowances.
- Tailscale state is excluded from workspace export/restore. Provider credentials
  are not passed to the helper. No public Funnel or existing host VPN configuration
  is changed. The helper's private HTTP traffic is carried over Tailscale encryption;
  this milestone does not add tailnet HTTPS certificate provisioning.

## Build and run the checks

Contributors need Go 1.27.3+ and Node 24+. End-user packages include the executable
and its generated dependency notices. Docker builds the Linux component in a
separate Go stage. Desktop packages select their matching OS/architecture. npm
packaging refuses to proceed unless all six supported OS/architecture artifacts
and notices are present.

```powershell
node scripts/prepare-network.mjs --current
node node_modules/vitest/vitest.mjs run server/account-usage.test.ts server/plan-usage.test.ts server/private-network.test.ts server/tailscale.test.ts server/usage-ledger.test.ts server/workspace-backup-policy.test.ts src/components/PlanUsage.test.ts src/components/UsageHistory.test.ts src/components/SettingsModal.simple.test.ts server/drivers/codex-identity.test.ts --maxWorkers 1
node --experimental-strip-types scripts/verify-account-network.ts
```

The HTTP script uses `launchVerificationServer`: isolated home, data, ports and
fake provider CLIs. It verifies native Codex reporting through the adapter, complete
configured-account coverage, remote/client denial, and networking disabled by
default. Native protocol tests assert that reads never start a thread/model call.

An optional public-network check uses a fresh app-specific Tailscale state folder:

```powershell
node --experimental-strip-types scripts/verify-account-network.ts --live-network
```

It obtains an official browser authorization challenge and disconnects without
authorizing an account. It does not import a host's existing Tailscale identity.
This is evidence for clean setup/challenge delivery, not successful sign-in, peer
reachability or multi-human collaboration. The same fixture protocol verifies
account reporting with synthetic data, not real provider limits.

The full-app smoke in [hattera-app.md](hattera-app.md) additionally opens the built
Usage and Private network screens and records screenshots. Use the existing
`OMB_VERIFY_BROWSER_BINARY` and `OMB_VERIFY_BROWSER_CHROME` configuration. Test
providers stay in the disposable fixture; never add them to the running product.

### Clean Docker check

```powershell
docker build --target server --build-arg ENGINES= -t hattera-collaboration-verification .
node scripts/verify-network-container.mjs --live-network
```

The runner resolves the image's app UID/GID, creates its own random container with
a 512 MiB limit and an empty tmpfs home, and removes only that container afterward.
It checks no provider CLI or system Tailscale is installed, packaged networking is
available and disabled, and forwarded requests cannot gain local-owner access.
`--live-network` additionally obtains an official authorization challenge and
disconnects without signing in. No live Compose service or volume is accessed.

### Recorded evidence — 22 October 2026

- 129 focused tests across ten account, provider, network, backup and UI test files
  passed. The OpenRouter lifetime-versus-resetting-budget assertion was rerun after
  the final parser change (eight account-reporting tests passed).
- The separate real-turn usage-ledger API fixture passed. The isolated account/
  network HTTP fixture passed seven checks, including native Codex protocol data,
  scoped-client denial and a fresh Windows Tailscale browser challenge. Provider
  data in these fixtures is synthetic.
- The 29-journey Edge smoke passed, including signed-out account reporting without
  a fabricated allowance, all configured account rows and packaged network
  controls. Desktop and 390-pixel phone screenshots were inspected. Successful
  native metrics were tested through HTTP and component tests; this browser
  journey deliberately leaves Codex signed out for its setup checks.
- The clean Linux Docker check above passed as a non-root user at 512 MiB, without
  preinstalled engines, host VPN state, privileged mode or a TUN device. It obtained
  a public sign-in challenge and disconnected without account authorization.
- Frontend/server typechecks and the final server bundle passed. Go tests and
  Windows/Linux native helper builds passed. Web and public docs
  builds passed; locale catalog validation passed for all ten languages. Hattera
  skin contrast checks passed. The existing Midnight skin has contrast failures;
  those are not reported as passing.

These checks do not qualify real provider accounts, completed Tailscale sign-in,
peer reachability, Firefox/macOS execution, or human group collaboration.

## Coverage still required

Listing an account is not completed quota integration. Additional collectors and
their UI reporting connections are still required for Kimi native OAuth quota/wallet,
Gemini/Antigravity native quotas, Cursor reporting
permissions, AWS account/region metrics, and wrapper-selected upstream accounts.
Approved ChatGPT-plan connections use a separate auth lifecycle; their reporting
needs explicit qualification and must not reuse unrelated native login files.

Relevant provider sources:

- [Codex account APIs](https://learn.chatgpt.com/docs/app-server)
- [Claude native usage fields](https://code.claude.com/docs/en/statusline)
- [Kimi managed-account quota API](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/server-api.html)
- [OpenRouter key budgets](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key)
- [Groq response limits](https://console.groq.com/docs/rate-limits)
- [Mistral reporting permissions and limits](https://docs.mistral.ai/admin/admin-api/usage-metrics)
- [Bedrock metrics and their limitations](https://docs.aws.amazon.com/en_en/bedrock/latest/userguide/monitoring-runtime-metrics.html)
- [Embedded Tailscale authentication](https://tailscale.com/docs/features/tsnet)

Real-account qualification, signed-in multi-device tests, Windows/macOS/Linux
release execution, and three-peer group/action tests must be recorded before the
overall collaboration feature is described as complete.
