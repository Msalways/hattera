# Three-container OpenCode team

This local demo runs three installations with separate named volumes and real
OpenCode profiles. It refreshes the application from the current `dist` and
`dist-server` builds. No host account credentials or live app volumes are mounted.
Each container starts the actual `node /app/dist-server/hattera.js web --cli-only`
launcher. The fixture removes inherited CLI, persistence and trust flags first;
the launcher must establish its own local mode and background runtime. The
controller checks the runtime receipt, local owner session and CLI capability.
The real OpenCode CLI uses an explicitly selected public free model; availability
is checked by executing tasks, rather than treating a model catalog as proof.

The app's signed, encrypted peer packets cross an isolated Docker bridge using
the existing fixture network helper and fixed loopback forwards. Tailscale login,
ACLs and physical-device connectivity are simulated, not qualified by this demo.

Run from the repository root with Node.js 24+, Go, Docker and fresh application
builds. The local runtime image must contain OpenCode 1.19.0:

```powershell
node --experimental-strip-types scripts/verify-collaboration-containers.ts
```

The current local image is `hattera-render-opencode-default:local`. On a clean
machine it can be built with the repository Dockerfile, target `server`,
`--build-arg ENGINES=opencode-ai@1.19.0`, and that image tag. The demo's derived
image copies fresh application files over those runtime/CLI layers.

The scenario creates Alice, Bob and Chris, each with a bot, private memory and a
local copy of one shared group. Each owner grants explicit per-person execution
permission and requires approval. The controller then checks:

- Alice requests Bob's memory through Bob's real OpenCode; the expected fact is
  not included in the request.
- Bob requests Alice's memory in the reverse direction.
- Bob requests Chris's memory while Alice's container is stopped.
- An update to Bob's memory survives Bob's container restart and is recalled by
  a subsequent remote execution.
- Bob's private memory is not copied into Alice's memory file. Native turns and
  admitted job records stay qualified by owner and request ID.

This delegates work to the owner's bot and its memory. It does not replicate
private memory databases, import another provider's native session, or synchronize
project checkouts. Only the requested response is shared with the group.

The report and logs are under `output/hattera-team-<id>/`. Containers remain up
for inspection on loopback ports **18081**, **18082**, and **18083**. The ordinary
local application on port 8080 is untouched. Browser ingress requires normal
session authentication; it never inherits the controller's loopback administrator access.

Generate fresh, five-minute local launch links for those exact labeled containers:

```powershell
node --experimental-strip-types scripts/verify-collaboration-containers.ts --links output/hattera-team-<id>/report.json --open
```

Run the browser verification against a successful report:

```powershell
node --experimental-strip-types scripts/verify-collaboration-container-ui.ts output/hattera-team-<id>/report.json
```

Open the generated link directly: no login, code entry or Connect click is needed.
The local CLI link redeems a one-use code from its URL fragment, obtains the
normal authenticated session and removes the credential from the address bar.
An invalid or expired link falls back to pairing; run `--links --open` with the
report path as shown above for fresh links opened immediately. A connected
browser keeps its authenticated session after the launch code expires; reload
the root page instead of reopening the consumed link. Omit `--open` to print
links without opening them. The helper validates the exact fixture labels and
loopback port mappings and starts only this run's stopped containers.
This automatic connection is limited to explicit `?cli=1` links on loopback hosts
and servers advertising the local CLI capability. The disposable demo explicitly
uses local CLI launches; production Docker/Render hosting does not enable it.
Remote pairing and GitHub sign-in retain their existing authentication.
The ordinary native `hattera web` launcher already opens the local app directly.

The browser scenario connects all three installations without a login click,
rejects an invalid CLI link, opens their groups, verifies visible routing to each
selected teammate's account,
three human memberships and two colleague-provider choices per installation, and
captures screenshots. Set `OMB_VERIFY_BROWSER_CHROME` when Edge is not at its
standard Windows path.

To also submit a new request through Alice's real browser selector and approve
it through Bob's browser, use:

```powershell
node --experimental-strip-types scripts/verify-collaboration-container-ui.ts output/hattera-team-<id>/report.json --execute
```

That run asks for Bob's private memory fact without putting the expected answer
in the prompt. It verifies the pinned account profile/model, one native turn on
Bob only, owner approval and exactly one replicated reply on all three group
copies. Screenshots include the approval and the actual completed conversation.
The free OpenCode profiles are separate execution identities, not proof of
distinct paid vendor or billing accounts. Tailscale transport remains simulated.

## Record the three-browser walkthrough

The [side-by-side video](../demos/three-cli-team.mp4) records three independent
Edge profiles at 640 by 900 pixels each. The output is a 1920 by 1080 MP4 with
English captions and a disclosure of the simulated transport. It has no audio.
All visible states come from the running app; walkthrough timing follows wall
time without cuts. The initial negative case uses an invalid code rather than
waiting five minutes for expiry. Navigation can briefly interrupt screenshot
sampling; any dropped samples are logged, never replaced with invented frames.
The published passing recording has no dropped samples. Its evidence also
checks the sharing panel stays inside the viewport at 390, 640, 768 and 1280 pixels.
The [published evidence](../demos/three-cli-team.json) records the exact execution
and video checksum. The MP4 is 2 minutes 23 seconds and decodes completely with
FFmpeg; it demonstrates OpenCode rather than the hackathon's required technology.

With the successful fixture still available:

```powershell
node --experimental-strip-types scripts/record-collaboration-demo.ts output/hattera-team-<id>/report.json
```

This creates a new local group on each isolated installation, records rejected
invalid links and successful fresh CLI links, checks authenticated reloads, and
uses the UI to invite both colleagues and grant Bob's bot to selected members.
It then requests Bob's private memory through the browser, approves on Bob,
checks exactly one native turn and one shared reply per member, and opens the
actual conversation in each browser. The expected answer is absent from the
request. No host credentials or main-app data are used.

The command prints its `.omb-scratch/...-recording-<id>` directory. Its
`evidence.json` must have `ok: true`; failures and dropped screenshot samples
are retained. Set `OMB_VERIFY_BROWSER_CHROME` for another Chromium executable.
Compose the captured frames with an installed FFmpeg binary:

```powershell
$env:FFMPEG_BINARY = 'C:\path\to\ffmpeg.exe'
node scripts/testing/compose-team-video.mjs <recording-directory> docs/demos/three-cli-team.mp4 docs/demos/three-cli-team.jpg
```

The composer requires FFmpeg with libx264 and drawtext, plus a readable font
(`OMB_VIDEO_FONT` overrides the system default). Do not publish a failed
recording or a synthetic compositor smoke test as product evidence. This video
demonstrates collaboration with OpenCode; the hackathon additionally requires a
real Nebius/NVIDIA workflow and a public YouTube demonstration under three
minutes. See the [readiness review](../hackathon-nebius-review.md).

Provider discovery must not hold peer requests open while running CLI health
probes: some take 30 seconds while the peer transport times out after 12 seconds.
The registry coalesces probes per account, refreshes discovery after eight seconds
and exposes a bounded last-known result while refreshing (at most 40 seconds).
Cold/unknown accounts stay unavailable until checked. Native dispatch always
awaits a fresh account check and current permission/configuration validation.

If a run is interrupted, its own labeled containers can be resumed with
`--resume output/hattera-team-<id>/report.json`. Unconfirmed delivery retries reuse
the original request ID, and native-turn checks require a single execution.
Failures and previous attempts remain in the report; a live provider error is not
reclassified as a successful mock answer.

To stop the demo, use `docker stop` with the three exact container names recorded
in the report. Its named volumes retain the isolated profiles for inspection or
later restart. No general Docker cleanup or live volume deletion is performed.
