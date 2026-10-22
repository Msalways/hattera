# Hattera browser app smoke

Build the app, then launch a disposable fixture with an installed native browser engine and Chrome. On Windows PowerShell:

```powershell
& .\node_modules\.bin\vite.CMD build --configLoader runner
$env:OMB_VERIFY_BROWSER_BINARY = (Resolve-Path '.omb-scratch/verify-tools/tools/agent-browser/0.36.0-omb.1/agent-browser.exe').Path
$env:OMB_VERIFY_BROWSER_CHROME = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
node --experimental-strip-types scripts/verify-hattera-app.ts
```

The launcher exits after its browser smoke and reports 27 checks. Set `OMB_VERIFY_BROWSER_CHROME` to the Edge executable to run the same fixture in Edge. It exercises fake Claude and OpenCode replies, OpenCode model selection and provider status, unconfigured MiniMax and Qwen setup cards, both Codex sign-in choices in Settings, a Cline installation started from the browser UI against a temporary local npm registry followed by device sign-in cancellation, retry and saved-account confirmation, engine uninstall cancellation, uninstall and reinstall with account preservation, external-engine disable and restore, a Bedrock setup form, native browser navigation and release, bot creation, identity and memory edits, saved tool restrictions, command skill creation, approval level changes, browser permission, mobile layout, pairing contrast across all ten saved skins, and pairing a second browser session through a proxied remote request. It verifies saved changes through the API and confirms that the downloaded Cline launcher is in the temporary tools directory. Screenshots are written under `output/playwright/`, including the model picker, provider cards, browser, mobile chat, and pairing page in Hattera and Midnight skins. The fixture uses a temporary app home and isolated browser profiles. It never imports live app data, account credentials, or browser profiles. A visible fixture banner identifies its screenshots. This is an internal diagnostic, not a product-testing URL.

For release artifact checks, set `OMB_VERIFY_WEB_DIST` to a copy of the image's `/app/dist` directory and `OMB_VERIFY_SERVER_ENTRY` to a copy of `/app/dist-server/index.js`. The server still receives the fixture's disposable home, environment and fake providers. This also avoids slow source TypeScript imports on Windows without extending the startup timeout.

For a read-only check of the pairing page served by a running local deployment, run `node scripts/testing/pair-skin-browser.mjs http://127.0.0.1:8080 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'`. It starts a temporary Edge profile, checks the rendered GitHub and code cards under every saved skin and a phone viewport, writes light and dark screenshots under `output/playwright/`, and then removes that profile.

After building the app, run `node scripts/testing/github-origin-browser.mjs 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'` to check the GitHub button in an isolated Edge profile. The fixture opens the home page on `localhost`, clicks the button, and requires navigation to the server's GitHub start route on its configured `127.0.0.1` origin. The server identity test checks that this route sets the OAuth state cookie and redirects to GitHub even when a prior auth cookie is present. These checks do not authenticate a real GitHub account.

The [provider setup audit](provider-setup-audit.md) records the account path and verification level for every built-in driver. The built-in npm installer regression covers Claude Code, Codex (also used by ChatGPT plan), OpenCode, Cline, pi, Grok, Kimi, Droid, Qwen, and the optional enterprise Gemini CLI. It runs real npm and each engine's real install route against a temporary loopback npm registry. It verifies the downloaded package, Windows or POSIX launcher, version probe, and a second API read. A separate test enumerates every built-in driver offered a server npm button, and checks that no built-in CLI provider lacks a server installer. Cursor and Hermes use their official noninteractive installers in a Hattera-owned tools directory; their test substitutes a local script and verifies the resulting CLI. The Grok component test checks the browser install action, and the Windows resolver test covers Hermes' generated `.cmd` fallback:

```powershell
& .\node_modules\.bin\vitest.CMD run server/engine-install.e2e.test.ts server/engine-install.test.ts server/official-engine-install.test.ts server/env-path.test.ts server/harness/registry.test.ts src/components/EngineSetup.refresh.test.ts src/components/EngineSetup.grok.test.ts --configLoader runner
```

These checks prove the ten package paths without using preinstalled CLIs and the local execution path for the two official installers. The npm unit test also verifies that a failed update keeps the last working CLI active across server boot, and that a successful update selects the new copy. The component test covers the Settings button's click and success/error rendering, including a successful CLI install that still needs account setup. API-only providers, including MiniMax, do not receive a server install button. Antigravity uses its separate managed downloader. None of these checks proves that a deployment can reach public download hosts, that a vendor's current script succeeds on every supported machine, or that a real provider account can answer a prompt; those need network and account acceptance checks in that deployment.

On Windows, the PATH resolver test also checks that the npm launcher used for installation is the same accessible shim Settings detected. A separate process test passes an isolated PATH only to the child and verifies that spawning honors it. This catches inaccessible Node-manager junctions that can look like files to `stat` but cannot be opened or launched.

Codex sign-in has separate isolated HTTP regressions. They start browser OAuth and one-time-code login through the same account entry, enforce method ownership and the local callback boundary, and simulate a network failure without leaking CLI output. Neither fixture proves that a real ChatGPT account can sign in from a deployment:

```powershell
& .\node_modules\.bin\vitest.CMD run server/codex-auth-methods.e2e.test.ts server/codex-auth-network.e2e.test.ts server/provider-auth-sessions.test.ts server/drivers/codex-browser-auth.test.ts server/drivers/codex-device-auth.test.ts src/components/DeviceSignIn.test.ts --configLoader runner --maxWorkers 1
```

To check public downloads on this computer, run the built app from a normal PowerShell terminal outside an agent sandbox:

```powershell
& .\node_modules\.bin\vite.CMD build --configLoader runner
node --experimental-strip-types scripts/start-hattera-local.ts
```

Open the printed URL. This launcher starts with a fresh data directory under `.omb-scratch`, with no fixture providers or imported account credentials. Use Settings → AI to install a provider, then verify its status and sign-in. The launcher prints its data directory for diagnosis and keeps it after exit. Its result describes that computer's network and account state; the hermetic test above only verifies the app's install mechanism.

The earlier agent sandbox could serve the local app but could not reach `auth.openai.com` or `registry.npmjs.org`. A fresh Codex CLI with an empty credential home failed before producing a device code. A separate disposable Docker container on 20 October 2026 did reach public npm and installed Cline 3.0.73 through the server API. That Docker check verifies one public package download and the app's install flow; real provider sign-in still needs an account acceptance check.

Add `--tailscale` to the launcher command for a tailnet HTTPS URL and pairing code. The flag uses the existing server `serve --tailscale` route and refuses to replace an endpoint already on HTTPS port 443. Tailscale must be installed, running, and signed in, with HTTPS enabled for the tailnet. The current verification machine has no Tailscale CLI, so only the offline CLI/Serve lifecycle tests can run here; a real tailnet URL and remote device reachability remain unverified.

Focused checks:

```powershell
& .\node_modules\.bin\vitest.CMD run server/browser-engine.test.ts server/browser-runtime.test.ts server/browser-live.test.ts server/browser-live-routes.test.ts src/lib/browser-input-queue.test.ts src/lib/browser-control.test.ts src/lib/browser-profiles.test.ts src/components/BrowserProfilesManager.test.ts src/components/BrowserViewport.test.ts src/components/BrowserPanel.test.ts --configLoader runner
& .\node_modules\.bin\vitest.CMD run src/pair/PairPage.test.ts src/components/ApiKeys.test.ts src/components/BotSettingsDialog.simple.test.ts src/components/BotSettingsDialog.caption.test.ts src/components/ModelPicker.test.ts src/components/ModelPicker.interaction.test.ts src/components/ModelPicker.simple.test.ts src/components/onboarding/WelcomeGate.test.ts src/components/onboarding/FirstConversationTour.test.ts src/components/onboarding/beats/HelloBeat.test.ts src/lib/brand.test.ts src/lib/skins.test.ts src/lib/i18n.test.ts --configLoader runner
```

These focused checks include component and server tests; they are not full browser journeys. The full-app smoke gates **chat replies through fake Claude and fake OpenCode ACP, OpenCode model selection and provider visibility, Cline installation through the Settings UI and a local npm registry, browser navigation and release, bot settings navigation, browser permission, bot creation, identity and memory edits, saved tool selection, command skill creation, approval level changes, mobile chat layout, and remote browser pairing**. The OpenCode test provider proves Hattera's ACP path against a repository-owned fake; it does not prove the installed OpenCode CLI or any real provider account. The Cline check proves the browser-to-server installation path with a local package, not a public package download. Real OAuth, provider credentials, hosted services, public package downloads, tailnet reachability, and operating system permissions require acceptance in their deployment environments and must be reported separately from fake-engine results.

For adjacent features that require more setup than the browser smoke, run their isolated server and component regressions:

```powershell
& .\node_modules\.bin\vitest.CMD run server/routine-continuity.e2e.test.ts server/team-lifecycle.e2e.test.ts server/workspace-backup-http.test.ts server/mcp-selection.e2e.test.ts src/lib/connected-apps-cache.test.ts src/components/routines/RoutineViews.test.ts --configLoader runner --maxWorkers 1
```

This suite covers routine continuity, team persistence through restart, backup HTTP/auth controls, per-bot MCP selection, connected-app caching, and routine rendering. It uses disposable homes and local substitutes; it does not exercise those features as full Hattera browser journeys.

## Coverage inventory

| Area | Evidence here | Still needs acceptance |
| --- | --- | --- |
| Chat, models, browser, bot settings, memory, tool selection, command skills, permissions, pairing, mobile chat | Full browser smoke above; isolated fake engines and local browser page | Real model accounts and vendor services |
| CLI installation | Local npm registry and official-installer substitutes above; full browser click and downloaded Cline launcher | Public npm/vendor download hosts on each deployment OS |
| Sign-in and sessions | Remote pairing browser smoke; [session tests](../../server/remote-sessions.test.ts), [GitHub identity tests](../../server/github-identity.test.ts) | A real GitHub OAuth app and callback URL |
| Connected apps, MCP, routines, teams, backups, data, computer and VM | Separate feature fixtures indexed in [verification README](README.md); selected adjacent regression suite above | Hattera browser journeys for each enabled deployment feature and the external service or host it uses |
| Tailscale Serve | Offline CLI/status/occupied-port/lifecycle tests in [Tailscale fixture](tailscale.md) | Signed-in tailnet, HTTPS certificate, and a second device reaching the URL |

Do not treat a green smoke result as proof of the remaining acceptance items. Record the exact deployment and provider when running them.
