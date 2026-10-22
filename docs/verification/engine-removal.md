# Engine removal

Use disposable fixtures only. Never remove engines from the live workspace to verify this feature.

## Server and component checks

```powershell
node node_modules/vitest/vitest.mjs run server/engine-removal.test.ts server/harness/registry-removal.test.ts server/engine-removal.e2e.test.ts src/components/EngineRuntimeRemoval.test.ts server/request-auth.test.ts --maxWorkers 1
```

These checks cover the built-in CLI inventory, app-owned version and legacy launcher removal, shared accounts, restart persistence, successful and failed reinstall, failure to stop safely, symlink boundaries, credentials beside Hermes and Cursor runtimes, Antigravity profile preservation, explicit restoration, bot/thread dependencies, admin authorization, and a sign-in request arriving across removal.

API-only providers and custom ACP commands have no universal software uninstaller. Image-bundled and external binaries are disabled persistently; Hattera never deletes their files.

## Browser journey

Run the [built app smoke](hattera-app.md). Its local npm registry supplies a synthetic Cline package. The real browser installs it, starts/cancels/retries synthetic device sign-in, verifies removal is blocked during sign-in, cancels an uninstall confirmation, uninstalls, reloads, then reinstalls with the saved account intact. Qwen's external fixture CLI is disabled and explicitly restored. No real provider account is authorized.

The complete smoke reports 27 checks. The provider fixture proves the local installer and UI lifecycle; it does not establish that every public vendor host is reachable.

## Linux container and bundled fallback

Build the image, then mount the fixture script into a separate container. This creates synthetic credentials and an app-owned Cline runtime in a fresh anonymous data volume. The image also contains the real bundled Cline binary. No host ports or network access are granted.

```powershell
docker compose build omb
$fixtureScript = (Resolve-Path 'scripts/testing/engine-removal-container.mjs').Path
docker run -d --name hattera-engine-removal-verify --network none --env HATTERA_REMOVAL_FIXTURE=1 --mount "type=bind,source=$fixtureScript,target=/tmp/engine-removal-container.mjs,readonly" --entrypoint node openmausbot-local:latest /tmp/engine-removal-container.mjs serve
docker inspect hattera-engine-removal-verify --format '{{.State.Health.Status}}'
```

Wait until health is `healthy`, then run:

```powershell
docker exec hattera-engine-removal-verify node /tmp/engine-removal-container.mjs remove
docker restart hattera-engine-removal-verify
```

Wait for `healthy` again, then:

```powershell
docker exec hattera-engine-removal-verify node /tmp/engine-removal-container.mjs restore
docker rm -fv hattera-engine-removal-verify
```

Both phases must report `ok: true`. Removal checks actual deletion and unchanged bots, configuration and credentials. After restart, the provider must remain unavailable with no models while the image's real `cline --version` still works. Explicit restoration must enable that bundled binary with the credentials unchanged. Removing this named fixture container also removes its own anonymous volume; the live Compose volume is never attached.

Disabling an image-bundled engine does not reclaim image layers. To reduce the image, rebuild with a smaller `ENGINES` argument and retain the existing app data volume.
