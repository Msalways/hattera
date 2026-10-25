# Hattera identity and compatibility verification

This record covers the source rebrand, not a published or signed release.
See [the compatibility map](../rebranding.md) for intentionally retained
protocols, workspace paths, installed services and upstream notices.

## Executed checks

On Windows x64, using isolated fixtures:

- Frontend and server typechecks, the production web build, server bundles
  and companion compiler/bundles passed.
- Network helpers compiled for Windows, macOS and Linux on x64 and ARM64.
  Windows x64 and Linux x64 version probes reported Hattera. Cross-compilation
  is not a native runtime qualification of the other four targets.
- The full browser app smoke passed all 31 journeys in Microsoft Edge,
  including provider management, memory, bot settings, mobile layout and
  remote browser pairing. Providers in this smoke are synthetic fixtures.
- Desktop Node tests passed: 658 passed, 18 platform skips, zero failures.
  The Linux updater cases also ran in a disposable Linux container:
  nine passed and one platform skip.
- The focused identity, CLI, fleet, service, authentication, pairing and
  link suites passed individually. A combined run exceeded the source
  CLI's 60-second startup deadline during concurrent builds; the isolated
  CLI rerun passed 29 tests with four platform skips in about 38 seconds.
- The packaged server ran outside the repository without node_modules.
  Its search worker, proxy paths, MCP process, backup worker, desktop
  compile cache and optional enterprise-layer discovery checks passed.
- The portable npm tarball ran outside the repository on Windows x64 and
  Linux x64: local CLI launch, health, pairing, sessions and stop passed.
  Remote requests remained protected. All six binaries' architecture headers
  and notices were checked. The Linux fleet agent closed its socket on SIGTERM.
- The docs production build passed from the apps/docs working directory,
  including all 18 generated pages and Markdown export routes.
- Brand validation, all ten locale catalogs and Hattera's 52 contrast pairs
  passed. Existing skin checks retain their own previously recorded targets.
- All 159 Electron JavaScript modules passed the Electron syntax check.
- CI workflow and verification-document reference checks passed all 27 tests.

The Windows tarball check reproduced a forced-exit crash on Node 24.16.0
after a successful launcher receipt. The shared CLI shutdown helper now lets
Node drain output and handles naturally; server/exit.test.ts checks that pending
cleanup and a full piped response complete with the requested exit code.
The fleet command explicitly closes its listener before returning.
The rebuilt tarball passed the Windows check with the same installed Node.

In disposable containers with no network access or published ports:

- The current bundled server behind the self-hosted launcher reported
  Hattera, served identical canonical/legacy environment descriptors and
  kept local CLI mode disabled despite inherited canonical CLI flags.
  Synthetic GitHub configuration was present; unauthenticated settings
  and forwarded remote bot requests returned 403.
- The bundled companion ran without repository dependencies, accepted
  canonical port/data settings, served its Hattera pairing page and
  reported an empty device registry. No phone was paired.

## Reproduce

```sh
pnpm check:brand
node --test shared/product-compat.node-test.mjs
pnpm typecheck
pnpm i18n:check
pnpm check:contrast
pnpm build:server
pnpm build:companion
pnpm docs:build
node scripts/smoke-packaged-server.mjs
node scripts/testing/rebrand-container.mjs YOUR_LOCAL_SERVER_IMAGE
# Linux only, against an extracted package:
node scripts/testing/verify-fleet-shutdown.mjs /absolute/path/to/package/cli.js
```

Run the [full browser acceptance fixture](hattera-app.md) against a fresh
web build. Do not attach fixtures to a running personal workspace.
The complete [E2E command](e2e.md) also checks brand compatibility.

When a running app holds a native helper open, set HATTERA_NETWORK_DIST to
a separate build directory before running the network build and npm
assembler. HATTERA_WEB_DIST and HATTERA_SERVER_DIST can likewise select
isolated web/server outputs. Default release inputs remain unchanged.
Portable npm packaging requires all six native targets and their notices;
missing targets are an error.

## Source filename cleanup

The follow-up renamed 11 source/test/skill paths, including the development
control scripts, UI controller, Claude hook and environment-isolation helpers.
The canonical names and generated legacy aliases are listed in the
[compatibility guide](../rebranding.md). The checkout root and Docker volumes
were not renamed. Historical logs and captured evidence were not rewritten.

Verification after these renames:

- Nine focused suites passed all 158 tests, including hook-helper subprocesses,
  control commands, fixture environment isolation, UI command parsing and CI/docs
  references.
- The isolated HTTP fixture passed two tests. Four POSIX hook integration cases
  were skipped on Windows; they are not reported as executed.
- Frontend, server and E2E typechecks, lint, locale validation, brand validation
  and README file/anchor links passed.
- The server bundles rebuilt. All 13 spawned helper paths resolved, including
  the renamed hook. Canonical and generated legacy CLI help matched.
- The packaged-server smoke passed outside the repository without node_modules,
  including worker/proxy paths, MCP, backup export and desktop cache restart.

## Qualification limits

These checks do not authorize a real provider account or prove every provider's
external login service. They do not qualify a physical Tailscale network,
signed macOS upgrades, Windows installer upgrades or native mobile releases.
The DEB permission fixture models an earlier Hattera package; it is not proof
of an automatic migration from an installed upstream desktop package.
Publication requires the fork's own release credentials and configured gates.
