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
release is a draft for review. HATTERA_NPM_PUBLISH_ENABLED=true additionally
permits registry publishing after the package name and npm trusted publisher are
authorized for this repository. Local builds and tarballs need neither flag.

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
