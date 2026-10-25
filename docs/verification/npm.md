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
uses `--with-deps`, which installs OS libraries and requires root or working sudo.
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

Publication additionally requires this fork's npm package ownership/trusted
publisher and the explicit `HATTERA_NPM_PUBLISH_ENABLED` repository setting.
Neither a local test nor a manual qualification dispatch publishes to npm.

For current local evidence, use the JSON reports under `output/npm-install/`.
Linux Docker checks and Windows checks must be reported separately. A Windows
attempt on 25 October 2026 installed and launched successfully but exhausted C:
during Data operations; that attempt does not qualify Windows end to end.
