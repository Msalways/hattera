# npm installation qualification

Publish the generated `release/npm` artifact, not the private development root.
Node.js 24 or later is required. The artifact contains the bundled server, web
app, skills and all six private-network helper targets. npm installs the pinned
DuckDB and resvg dependencies, including their platform-specific native addons.
They cannot be inlined by the server bundler; leaving them out breaks Data and
PNG charts even when startup succeeds.

## Reproduce

Build fresh release inputs, then pack and install the result:

```sh
pnpm build:network --all
pnpm build:server
pnpm exec vite build
node scripts/build-npm-package.mjs
npm pack ./release/npm --pack-destination ./release
node scripts/testing/verify-npm-install.mjs ./release/hattera-VERSION.tgz ./output/npm-install/report.json
```

Use the actual version in the tarball filename. The verification script runs
real `npm install --global --prefix` in a temporary directory outside the
checkout. Its prefix includes spaces. Both installed bin commands are exercised
through npm's platform shell, including the Windows `.cmd` shims. Temporary
homes, npm configuration, cache and a limited PATH prevent using personal
accounts or preinstalled user CLIs. A successful install is followed by:

- Local launcher startup and reuse from another project; static JS retrieval.
- Canonical and legacy discovery, pairing, status and session commands.
- Forwarded remote requests remain authenticated in local CLI mode.
- All default provider entries remain visible, including OpenCode and Bedrock.
- CSV import, schema inspection, SQL totals and rejected destructive SQL.
- Table/chart cards, CSV export, SVG and native PNG rendering.
- Restart persistence of bots, source tables and result cards.
- Execution of the installed platform's private-network helper.
- A separate self-hosted runtime still requires authentication.
- npm uninstall removes both commands and preserves workspace files; cached
  `npx` then executes the tarball without a global Hattera command available.

The script stops its own runtime and removes its temporary installation before
writing the JSON report. Reports include the tarball SHA-256, Node version,
platform, passed checks and remaining qualification. Allow at least **2 GB free
space** for a normal install check, and more for public engine/browser downloads.
Disk exhaustion is a failed qualification, never a passing result.

## Public downloads

The following opt-ins exercise real external downloads in the same private home:

```sh
HATTERA_VERIFY_NPM_PROVIDERS=1 HATTERA_VERIFY_NPM_BROWSER=1 node scripts/testing/verify-npm-install.mjs ./release/hattera-VERSION.tgz ./output/npm-install/downloads.json
```

On PowerShell, set those variables with `$env:NAME = '1'` for the command's
session. Use a disposable Linux container for this check: Linux browser setup
uses `--with-deps`, which installs OS libraries. The current vendor installer
requires working `sudo` even for root, plus system CA certificates. A minimal
Debian Node image needs `apt-get update && apt-get install -y sudo ca-certificates`
before this check. Neither engines nor Chromium should be preinstalled.
The provider check enumerates every offered npm engine installer and requests
each download through the same HTTP route used by Settings, starting without
managed engines. Alias accounts are not duplicate downloads. Official shell
installers and Antigravity's separate downloader have their own regression suites;
this npm download check does not qualify their current public services.

Browser qualification downloads the managed engine and Chromium, opens the
isolated app in a real headless browser, reads its title and closes the session.
These checks do not authorize provider accounts, prove vendor quotas, or join a
real Tailscale network. Downloads require working access to the public registries
and vendor hosts. Windows ARM64 currently has no managed browser-engine release.
Native desktop controls and native phone applications are separate distributions.

## Release gate

[npm-package.yml](../../.github/workflows/npm-package.yml) builds one tarball,
then installs that same artifact on native x64 and ARM64 runners for Windows,
Linux and macOS. Linux also checks Node 26 and fleet-agent shutdown. Release tags
and manual qualification enable the public npm engine and browser downloads on
Linux x64. Every matrix installation must pass before the publish job can run.
Cross-compiling a network helper does not qualify the application's runtime on
that platform. A configured matrix is not evidence that its jobs have passed.

Publication requires this fork's npm package ownership and authorized trusted
publisher or bootstrap token. In **Actions → Publish npm package**, checking
**Publish** explicitly enables publication after verification; leaving it
unchecked performs qualification only. Matching version-tag pushes additionally
require `HATTERA_NPM_PUBLISH_ENABLED=true` to publish automatically. See the
[npm publishing setup](../releasing.md#publish-the-npm-package-from-actions).

For current local evidence, use the JSON reports under `output/npm-install/`.
Linux Docker checks and Windows checks must be reported separately. A Windows
attempt on 25 October 2026 installed and launched successfully but exhausted C:
during Data operations; that attempt does not qualify Windows end to end.

## Executed qualification: 25 October 2026

[Workflow 40209844280](https://github.com/Msalways/hattera/actions/runs/40209844280)
passed all eight native platform/version jobs at source commit `c5e9247e`.
Each job installed and exercised the same tarball, with SHA-256
`c7302fea7779dac120e980429e6f6f3df0771409f37dcfec3ed16ba45bd7f807`.

| Platform | Architecture | Node.js | Result |
| --- | --- | --- | --- |
| Windows | x64 | 24.22.1 | Passed |
| Windows | ARM64 | 24.22.1 | Passed |
| macOS | x64 | 24.19.0 | Passed |
| macOS | ARM64 | 24.20.0 | Passed |
| Linux | x64 | 24.0.0 | Passed |
| Linux | x64 | 24.21.0 | Passed |
| Linux | x64 | 26.12.1 | Passed |
| Linux | ARM64 | 24.21.0 | Passed |

All eight jobs passed the ten core installation checks above, including native
Data/PNG operations, hosted authentication, uninstall and cached npx execution.
The Linux x64 Node 24 job additionally passed public installs of Grok, Kimi,
Droid, Claude Code, Codex, OpenCode, Qwen, Cline and pi, plus managed browser
installation and a real headless app launch. Its fleet shutdown check passed.
The public downloads are qualified on Linux x64, not on the other five targets.

Locally, four focused installer/registry/shutdown suites passed 41 tests, with
ten platform skips. Lint, typecheck and all ten locale catalogs passed. A native
Windows probe also executed DuckDB and rendered PNG using the npm-installed
addons; the full local Windows attempt remained disk-limited. The clean Windows
CI jobs above completed the full app checks independently of that limitation.

A minimal Debian Node container completed browser download and launch after
installing sudo and CA certificates. A later local repeat did not complete the
browser-install command within its ten-minute test deadline. The failed report
is retained alongside the successful local core and CI reports; it is not counted
as a pass. External downloads still depend on the deployment's network and OS
prerequisites. No real provider account was authorized, no physical tailnet was
joined, and no npm package was published by this qualification.
