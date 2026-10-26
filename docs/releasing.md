# Releasing Hattera

All product artifacts and update feeds belong to Msalways/hattera. The fork's
workflows never upload to the upstream repository or its legacy release mirror.
Upstream copyright, license files and dependency notices remain in packages.

## Prepare this repository

Configure this fork's own platform signing and notarization credentials using
the secret names referenced in .github/workflows/release.yml. No upstream
certificate, signing identity, registry authorization or hosting account is
implied by the rebrand. macOS signing must match the new com.hattera.app identity.

Set the repository Actions variable HATTERA_RELEASE_ENABLED=true when the release
configuration is ready. Without it the release jobs remain disabled. The default
release is a draft for review. HATTERA_NPM_PUBLISH_ENABLED=true enables automatic
npm publishing for matching version tags after npm authorization is configured.
Manual npm publication uses the Publish checkbox described below and does not
require the desktop release flag. Local builds and tarballs need neither flag.

## Publish the npm package from Actions

1. Confirm you own the npm name `hattera`. npm versions cannot be overwritten.
2. Configure npm trusted publishing for GitHub owner **Msalways**, repository
   **hattera**, workflow **npm-package.yml**, with **Allow npm publish** enabled.
   See [npm's trusted publisher setup](https://docs.npmjs.com/trusted-publishers/).
   For a first publication before a trusted publisher exists, add a granular npm
   publishing token as the GitHub repository secret **NPM_TOKEN**, with the
   package creation/write and CI 2FA permissions your npm account requires.
   Remove that secret after switching to trusted publishing. Never put tokens in
   source files or workflow inputs.
3. Open **Actions → Publish npm package → Run workflow**, select `main`, choose
   **Version change** and check **Publish**. The default is **patch**:

   | Selection | Example from 0.1.107 |
   | --- | --- |
   | patch | 0.1.108 |
   | minor | 0.2.0 |
   | major | 1.0.0 |
   | current | 0.1.107, unchanged |

   Version arithmetic uses npm's own SemVer rules. Choose **current** when
   publishing an already prepared version tag. Leaving **Publish** unchecked
   previews and tests the selected version without committing or publishing it.
4. The chosen version is applied before building the UI, server and npm tarball.
   All eight native installation jobs test that artifact. After they pass, a
   separate job commits `package.json` and creates `vVERSION` on `main` for a
   bump, using one atomic push. Builds and tests have read-only repository access.
   Only then is the same tested tarball published, with provenance. Stable
   versions use `latest`; prereleases use `next`.

Repository rules must permit the workflow's version commit/tag. A rejected push
or a main branch that changes during qualification stops publication without
overwriting anyone's changes. If npm authentication/publication fails after the
version was recorded, fix that issue and rerun on the created `vVERSION` tag with
**current**; do not increment again merely to retry. The separate **Prepare next
release** PR flow remains available when main requires a reviewed version change.

An optional `v*` tag push publishes automatically only when
**HATTERA_NPM_PUBLISH_ENABLED=true**. The desktop Release workflow forwards that
same setting explicitly when dispatching npm publication. The npm token is
available only to the publish step, never to package builds or provider fixtures.

Render deployment is a separate, optional manual action. See the
[Render deployment guide](../deploy/render/README.md#manual-deployment-from-github-actions).

## Build and verify

Run npm run build:icons, npm run check:brand, localization and contrast checks,
focused regressions, typechecks and the web/server/docs builds. For an npm
artifact, run npm run build:network -- --all and
node scripts/build-npm-package.mjs after building the server and web app.
Pack the release/npm directory and verify that both hattera and openmausbot
commands start its bundled CLI without checkout dependencies.

Use the isolated fixture procedure in docs/verification/README.md for app
verification. Confirm new and existing workspace selection, provider setup,
authentication, old and new links and saved sessions. Never use live user data
as a release fixture. See docs/rebranding.md for retained compatibility contracts.

## Assemble and publish

Use Actions -> Prepare next release to prepare a version change, or Actions ->
Release to build an explicitly selected ref. The platform jobs keep their server,
CUA, browser sandbox, signature, installer, feed hash and checksum checks.
Assemble creates one draft in this fork. Review the platform installers and
feeds before choosing publication. Hattera-named installers and the hattera npm
tarball are separate from upstream products; do not substitute upstream assets.

macOS notarization, signed Windows upgrades and Linux AppImage/DEB installation
must be qualified on their supported platforms. Source checks on Windows do not
prove signing or native installation elsewhere. Existing OpenMausBot users must
install the Hattera fork deliberately; its upstream updater is not redirected.

Publishing and uploading are separate authorized release actions. This guide
and the rebranding changes do not publish any package, image, release or site.
