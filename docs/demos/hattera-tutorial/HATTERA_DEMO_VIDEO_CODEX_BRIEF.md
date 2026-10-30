# Hattera demo video: recording brief

The demo shows me asking Chief to build and coordinate a coding team, then working with a colleague in a shared group. Both capabilities need visible actions: Chief proposes Builder and Reviewer, I approve setup, the bots implement and review a sample fix, and my colleague and I exchange messages and request approved work through a shared bot.

Use `ms1`, `ms2` and `ms3` as the participant labels. The subsequent recording request uses the existing three-installation Docker setup as a tutorial. Capture genuine application interactions, edit a silent video below three minutes, and prepare narration I can record later. Keep the Docker simulation disclosed throughout; this does not establish participation by three real people or a physical tailnet. Do not change the product or publish anything.

Repository: https://github.com/Msalways/hattera

Target: Nebius × NVIDIA Global AI Hackathon 2026
Suggested finished length: 165–170 seconds; never 180 seconds or longer. Finish earlier if the actions take less time.

## Deliverables

Keep these filenames in `output/hackathon-video/`:

| File | Contents |
| --- | --- |
| `hattera-demo-silent.mp4` | Genuine browser/app footage, 1920×1080, H.264, yuv420p, faststart, no audio |
| `hattera-demo-poster.jpg` | Frame from the actual video |
| `narration.md` | Editable first-person narration timed to the final shots |
| `narration.srt` | Matching subtitles |
| `shots.json` | Source and final timestamps, cuts, views, live/editorial classification, evidence references |
| `evidence.json` | Build/version, installation and rehearsal run IDs, per-shot verification, execution identities, blockers |
| `README.md` | Reproduction, recording and later audio commands; measured outcomes and readiness |

Retain uncut recordings, screenshots, test logs, diffs and redacted execution receipts alongside them. Keep keys, invitation codes, authenticated URL fragments and unrelated personal data out of all deliverables.

## Recording beats

Record complete takes before editing. These times are a guide, not a reason to pad footage. Use readable close-ups and two-window views; keep editorial labels distinct from the app.

| Final time | Actions to capture | Identity and execution shown |
| --- | --- | --- |
| 00:00–00:12 — Task | Open the disposable webhook fixture and send Chief the sample request below. Label it **Sample coding task**. | Chief's owner `ms1`, engine/provider and exact model; fixture location |
| 00:12–00:35 — Approved team setup | Chief proposes Builder and Reviewer with roles, models and team access. Show the combined review, my **Apply setup**, and the created bots. | Each bot's account owner, selected model/provider, workspace and permission scope |
| 00:35–01:30 — Coding and review | Chief assigns Builder implementation, then Reviewer a separate check of the resulting patch. Show the failing test, file change, passing regression tests, review execution and returned findings. | Chief, Builder and Reviewer identities as each acts; local tool execution versus hosted inference |
| 01:30–02:35 — Colleague collaboration | I create/open the shared group and invite `ms2`. My colleague accepts on their separate installation; show both memberships and a message from each of us. My colleague shares a dedicated bot with me. I select its owner-qualified **Run with** target and request an additional regression check. Show their pending request, approval, local execution and result on both screens. | `ms1` and `ms2` installations, selected shared bot/account, provider/model, grant and actual execution location |
| 02:35–02:50 — Results | Show Chief's returned implementation/review evidence and our shared result. Capture a real NVIDIA-model summary through Nebius, with its configuration and receipt visible. | Summary bot's owner, actual provider/model and Nebius-hosted inference; distinguish earlier coding executors |

For every segment, put the account owner, engine/provider, exact model and execution location in `shots.json` and show legible labels or settings/receipts. Human-only invitation/message shots should say no model execution. Keep labels current when switching bots or installations. A remote API performs inference remotely even when tools run on a developer's machine.

### Sample request and fixture

Send one coding request to Chief:

> Set up Builder to implement and Reviewer to check this sample webhook service. Show me the team setup for approval first. Then reproduce the duplicate-webhook bug, have Builder apply a small fix and run the regression tests, and have Reviewer independently inspect the patch and run the checks before you report back.

Use a disposable service with `src/webhook.mjs`, `test/webhook.test.mjs` and synthetic `logs/payment-retries.log`. Delivering the same `eventId` twice initially creates two invoices. Tests should assert one invoice for a repeated ID, continued processing of distinct IDs, and preserved amounts. Node's built-in `node --test` is enough. Label this a sample, without a fictional customer incident or invented production history.

Give Builder and Reviewer explicit access to the same demo-only checkout on `ms1`, or document another real, accessible review path. Chief must actually assign both jobs and receive both results. A reviewer repeating Builder's explanation does not establish a separate review. Retain before/after files, diff, exact test commands, exit codes and both bots' execution logs. A memory lookup cannot replace this coding sequence.

For `ms2`'s additional check, explicitly provide the small patch/test content and a disposable local fixture copy through a demonstrated transfer method. Show that preparation or identify the manual copy in a caption. Do not imply that joining the group copies the repository. A useful shared-bot request is: “In your prepared sample checkout, apply this supplied patch and independently check that repeated event IDs are ignored and distinct IDs still create invoices. Report the exact command and result.” Send only content intended for everyone in the group.

### What the actions mean

Chief can discover authorized teammates with `list_room_targets` and assign work with `coordinate_bots`. Reviewed team creation uses `list_team_setup` and `propose_team_setup`. Use ordinary language in the filmed request. Confirm the model actually follows it; deterministic scripted-provider tests establish plumbing, not live execution.

Team setup approval establishes the reviewed bots and scope. Chief's assignments use those bots' existing permissions. Neither action gives access to another person's provider account.

Group text and finished replies are shared between installations. Group membership alone grants no execution rights. The colleague separately shares a selected bot with selected people through **Shared providers and requests**; retain per-request approval. The requester chooses the owner-qualified **Run with** target, and the owner approves the request. Native tool approvals still apply on the owner's installation. Shared execution creates an owner-side native task. Do not imply native Claude/Codex session transfer, synchronized worktrees, or automatic file access across machines.

## Nebius/NVIDIA segment

Use Hattera's existing OpenAI-compatible configuration; do not build a duplicate adapter. The repository documents `https://api.tokenfactory.nebius.com/v1/`. Confirm the endpoint and an available NVIDIA open model in the authorized account before recording. Supply `NEBIUS_API_KEY` outside Git and captured material.

Make a successful request through Hattera's normal harness using the actual coding/review findings. Capture configuration, prompt, genuine response and a redacted receipt containing model ID, provider, timing, success and usage if available.

The owner subsequently authorized `nvidia/Nemotron-3-Ultra-550b-a55b` as Chief through `https://api.tokenfactory.us-central1.nebius.com/v1/`. Show its genuine setup and assignment calls before attributing coordination to it. Attribute Builder and Reviewer execution separately to their actual models. NVIDIA inference at a different provider does not establish Nebius use.

## Rehearsal and recording commands

Run commands from the Hattera repository root (`OpenMausBot-main` in this workspace). Read `AGENTS.md` and `docs/verification/README.md` first. Use only isolated homes, data directories, provider profiles and synthetic demo workspaces. Never verify mutations against the owner's live app/data or mount unrelated repositories, home directories or tokens into containers.

Check these sources before recording:

- `docs/verification/team-setup.md` and `room-coordination.md` in the same directory: reviewed setup and assignment semantics.
- `docs/verification/human-groups.md` and `shared-execution.md` in the same directory: invitations, grants, approvals and limitations.
- `PROTOTYPE.md`: existing Chief/Builder/Reviewer paths; its scripted prototype is not live-model proof.
- `docs/verification/container-team.md`, the scripts below and `docs/hackathon-nebius-review.md`: rehearsal scope and outstanding qualification.

Prerequisites: Node 24+, pnpm 10.33.0, Docker, Go, Chromium/Edge, FFmpeg with `libx264`/`drawtext` and ffprobe. Set `OMB_VERIFY_BROWSER_CHROME` if Edge is elsewhere and `OMB_VIDEO_FONT` if needed.

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm build:server

docker build --file Dockerfile --target server --build-arg "ENGINES=opencode-ai@1.19.0" --tag hattera-render-opencode-default:local .

node --experimental-strip-types scripts/verify-collaboration-containers.ts
# Use the report path printed by the fixture:
node --experimental-strip-types scripts/verify-collaboration-container-ui.ts output/hattera-team-<run-id>/report.json --execute

node --experimental-strip-types scripts/record-collaboration-demo.ts output/hattera-team-<run-id>/report.json
# Use the .omb-scratch/...-recording-<id> directory printed by the recorder:
$env:FFMPEG_BINARY = 'C:\path\to\ffmpeg.exe'
node scripts/testing/compose-team-video.mjs <recording-directory> output/hackathon-video/baseline-team-silent.mp4 output/hackathon-video/baseline-team-poster.jpg
```

Replace angle-bracket placeholders before running. Keep the fixture alive during recording. Use its separate profiles on ports 18081–18083 and fresh legitimate local CLI links. The base `compose.yaml` does not create this three-owner fixture.

These commands rehearse a memory-based request, approval and shared reply. They do not capture the complete five-beat demo. Preserve `docs/demos/three-cli-team.mp4` and its evidence unchanged. Keep the proven recorder/compositor intact; use a separate capture/edit pipeline for the new takes and `ms1`/`ms2` labels. The existing compositor has three 640×900 panels and hard-coded OpenCode/MiMo attribution.

For the subsequently requested Docker tutorial, disclose **“Three isolated Docker installations; Tailscale transport simulated.”** Demonstrate invitations, messages, selected-bot grants, owner approval and results across the separate installations. Record what was tested; do not turn Docker evidence into a claim about physical devices or human colleague participation.

Capture continuous sources, preferably 12–30 fps where practical; the existing recorder samples about every 500 ms. Log dropped samples and source timing. Cut idle waits while preserving action order, approvals and results; identify material time jumps. Do not fabricate UI, replies, test output or intermediate frames.

## Narration to record after editing

Use these five first-person cues, revising them to match the captured shots. Replace brackets with verified identities and read the script aloud against the edit. Allow pauses for setup review, approval and test output.

**Task**

> I ask Chief to set up Builder and Reviewer, then reproduce, fix, test and review this sample duplicate-webhook bug.

**Approved team setup**

> Chief proposes Builder and Reviewer with their roles and models. I check the setup and approve it here. The bots now appear in my team, and Chief can assign them work within the permissions I've approved.

**Coding and review**

> Chief sends the implementation to Builder. Here is the failing test, the change to the handler and the passing regression run. Chief then asks Reviewer to inspect the patch and run the checks separately. I can open each assignment and see what happened.

**Colleague collaboration**

> Now I invite ms2 into a shared group. My colleague joins from their own installation, and we exchange messages. They share a dedicated bot with me. I've supplied the patch and a sample fixture for another regression check. I select their bot and send the request. My colleague approves it, and the bot runs the check on their installation. We both see the returned result in the group.

**Results**

> I have the patch, tests, review and our shared result. I'm using NVIDIA [verified model name] through Nebius Token Factory to summarize the evidence.

## Later human audio

Lock the silent edit first. Record `output/hackathon-video/voiceover.wav` at 48 kHz; a continuous take or assembled cues are fine. Shorten narration or retime shots if needed. Do not generate a voice and represent it as mine.

Run this duration guard before muxing. It rejects unreadable durations and stops if speech would exceed the video; `-shortest` alone would truncate a longer recording.

```powershell
$videoSeconds = & ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 output/hackathon-video/hattera-demo-silent.mp4
if ($LASTEXITCODE -ne 0) { throw 'Cannot measure silent video.' }
$voiceSeconds = & ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 output/hackathon-video/voiceover.wav
if ($LASTEXITCODE -ne 0) { throw 'Cannot measure voiceover.' }
$videoSeconds = [double]::Parse($videoSeconds, [cultureinfo]::InvariantCulture)
$voiceSeconds = [double]::Parse($voiceSeconds, [cultureinfo]::InvariantCulture)
if (-not ($videoSeconds -gt 0 -and $videoSeconds -lt 180 -and $voiceSeconds -gt 0 -and $voiceSeconds -le $videoSeconds)) {
  throw 'Invalid duration or voiceover exceeds video. Shorten speech or retime the edit below 180 seconds.'
}

ffmpeg -i output/hackathon-video/hattera-demo-silent.mp4 -i output/hackathon-video/voiceover.wav `
  -filter_complex "[1:a]loudnorm=I=-16:TP=-1.5:LRA=11,apad[a]" `
  -map 0:v:0 -map "[a]" -c:v copy -c:a aac -b:a 192k -shortest `
  output/hackathon-video/hattera-demo-final.mp4

ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1 output/hackathon-video/hattera-demo-final.mp4
ffmpeg -v error -i output/hackathon-video/hattera-demo-final.mp4 -f null -
```

`apad` fills remaining video time after shorter speech. Review the complete narrated file for audible endings, shot alignment, readable subtitles and measured runtime; check loudness around -16 LUFS / -1.5 dBTP. Match subtitles to the recorded delivery.

## Evidence, acceptance and failure checklist

Use one checklist in `evidence.json`/`README.md`, with evidence paths and explicit pass/fail per item:

- [ ] Chief's genuine proposal, user setup approval, created Builder/Reviewer and actual implementation/review assignments are captured.
- [ ] The sample bug fails before the change; a real patch and passing regressions follow; a separate reviewer executes checks. Missing coding or review means **incomplete**; memory-only footage cannot substitute.
- [ ] For this Docker tutorial, actual invitation/join, messages, memberships and shared results are captured across separate installations. Human colleague participation remains unqualified; a future physical-device demo must capture it separately.
- [ ] The colleague's selected-bot grant, pending request, owner approval, native tool permissions, owner-side execution and returned result are evidenced. Joining or Chief assigning work is not account permission.
- [ ] Each shot identifies provider, exact model, account owner, execution location and role. Distinguish separate profiles from separate paid accounts. Claims match receipts and tool logs.
- [ ] A real NVIDIA open model succeeds through Nebius in Hattera. Record `realNebiusInference`, `nvidiaModelId` and `nebiusEndpoint`. Missing credentials, failed inference or another host means **incomplete/non-qualifying**.
- [ ] Record `chiefSetupApproved`, `implementationAssigned`, `reviewAssigned`, `failingTestObserved`, `patchApplied`, `passingTestObserved`, `independentReviewExecuted`, `colleagueParticipated`, `crossOwnerApproval`, `actualOwnerExecution` and `resultReplicated` without optimistic defaults.
- [ ] Rehearsal reports have `ok: true`, the approved rehearsal request has exactly one native owner turn and one reply per member, and raw logs survive failures. Record transport separately per segment; Docker has `physicalTailnetQualified=false` and its disclosure.
- [ ] Tool/workspace/network/provider failures retain logs and block the affected claim. No synthetic replacement or relabelled success. Mark `submissionReady=false` and list blockers if any required capability is missing.
- [ ] All artifacts exist; source timestamps/cuts and redactions are documented; no secrets leak. Silent master is 1080p H.264 with no audio, below 180 seconds, and fully decodes. Inspect frames and the entire final cut.
- [ ] Narration matches visible actions, has been read aloud, fits each cue and passes the duration guard before muxing. Final narrated output is also checked.
- [ ] Reproduction instructions and judge-access limitations are stated. Human review precedes any later upload/submission; this brief authorizes neither.

Hand off measured runtime/format, artifact paths, setup/coding/review/collaboration outcomes, actual Nebius model and role, transport scope and explicit readiness blockers. Do not describe planned footage as completed evidence.
