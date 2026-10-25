# Hattera identity and compatibility

Hattera is this fork's product name across the browser, desktop shell, public
docs, package metadata, CLI help and release artifacts. The desktop H mark and
web favicon share `public/hattera-mark.svg`. Run `npm run build:icons` to regenerate
the PNG, ICO and ICNS files without adding an image dependency.

## Commands and configuration

Build from this fork and use `node dist-server/hattera.js web`, or install its
built npm tarball to obtain the `hattera` command. `server/hattera.ts` is the
source entry point. Development control uses `scripts/control-hattera.ts` and
`pnpm control:hattera`; the Claude hook source is `server/hooks/hattera-hook.ts`.
The local verification skill is `.claude/skills/verify-hattera/SKILL.md`.
Test helpers and their imports also use Hattera filenames. The checkout root
folder is deliberately unchanged.

The installed `openmausbot` command remains an alias for `hattera`. Builds
generate `dist-server/openmausbot.js` from `server/legacy-cli.ts` and the legacy
hook bundle from the renamed hook source. These compatibility artifacts keep
existing launchers and hooks working; upstream-named source files are removed.
The `control:omb` package script remains an alias for `control:hattera`.
Both command names use the same implementation and authentication boundaries.
No public npm namespace or published installer is implied by these source changes.

`HATTERA_*` settings map to the corresponding existing `OMB_*` runtime settings.
When both are supplied, the Hattera value wins. Existing `OMB_*` deployments
continue working. The compatibility mapping is loaded before the server,
launcher and desktop read their configuration.

New native installations use `~/.hattera`. If `~/.openmausbot` exists, Hattera
reuses it, including its environment identity, account profiles, memory and
pairing state. It never moves or deletes that directory during startup. Set
`HATTERA_DATA_DIR` to explicitly choose another workspace. Desktop Chromium
profiles from existing OpenMausBot installations are also reused when present.
Compose project and volume names stay unchanged to retain mounted data.
Compose also accepts the canonical `HATTERA_*` settings before their old aliases.
Container data paths and installed service/fleet identifiers remain compatible.
After installing the fork, review service-unit script paths before replacing an
existing upstream service; a renamed package does not rewrite installed units.

New desktop chat links use `hattera://`. The desktop also accepts the historical
`openmausbot://` chat, package and settings links. Phone invitation protocols,
IPC message types, session cookie prefixes, database tables and archive formats
retain their versioned legacy identifiers for interoperability. These names are
protocol contracts, not public product branding. Existing phone app invitations
retain their compatible scheme until a separately signed mobile release.

## Releases and external services

Desktop installers and update feeds target `Msalways/hattera`. Release automation
does not mirror artifacts to upstream repositories. Enable
`HATTERA_RELEASE_ENABLED` in this repository's Actions variables only after
configuring its own signing and release credentials. Registry publishing also
requires `HATTERA_NPM_PUBLISH_ENABLED` and authorization for the package name.
Renaming source code does not publish a release or transfer signing credentials.
Fleet upgrades require `HATTERA_PACKAGE_SPEC` to name an authorized Hattera
package version or local tarball; they never install the upstream package.

The optional account control plane and managed Composio broker have no default
upstream service in Hattera. Operators can explicitly configure
`HATTERA_CONTROL_PLANE_URL` and `HATTERA_COMPOSIO_BROKER_URL`. Local providers,
API keys, pairing, GitHub authentication and Tailscale keep their existing flows.
Hattera does not advertise an unconfigured paid cloud service.

## Attribution and qualification

Preserve the original copyright, Apache license, upstream attribution and all
third-party notices. `enterprise/` retains its separate license and entitlement
checks. A rebrand does not change those terms or make inherited code original
Hattera work. See [LICENSING.md](../LICENSING.md).

Verification covers canonical and old CLI entry points, environment precedence,
workspace selection, old and new chat links, brand defaults and package metadata.
macOS signing/notarization, Windows installer upgrades and existing mobile
installations need their respective platform release checks; source tests do
not establish those release qualifications.
