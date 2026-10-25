# People, shared groups and colleague-provider audit

Historical audit captured 24 October 2026 before shared execution was added. See
[shared execution](shared-execution.md) for the subsequent implementation,
verification procedure and remaining live-device qualification. Findings and
screenshots below preserve the original audit; they are not the current release report.

The requested
journey is: several people join a project group, see one another and their shared
resources, and explicitly choose whose machine/account performs a task.

The current implementation completes part of this journey. Group text replication
and local account profiles are separate working features. Selecting a colleague's
account, authorizing execution and running a task on that colleague's machine are
not implemented. This affects every provider; it is not a Codex-specific failure.

## Current way to see people

Open the group and select the branching **Share this group** icon in its header.
Its roster lists invited people and their membership roles. **Manage Members**,
opened from the bot icons, lists local bots only. Tailscale's device list is in
Settings and does not provide a group-scoped list of usable provider accounts.

A manager creates a separate, single-use invitation for each colleague. In the
fresh browser fixture Alice invited Bob and Chris independently. Both joined the
same logical group from separate installations. Removing Bob left Chris active.
This verifies more than one invited person; it does not establish unlimited scale.
The ledger currently limits a group to 200 membership grants, including retained
revoked grants, and an installation to 64 group bindings. Invitations have their
own 32-active-invitation limit and five-minute expiry.

## Fresh evidence

Three owned application processes, three private homes, Edge, desktop 1280x900
and phone 390x844. Providers and peer transport were simulated. No real provider
account or physical tailnet was authorized. The peer executable is the existing
repository fixture, not the user's Tailscale daemon. All fixture apps were closed.

Local screenshot/DOM evidence and the machine-readable manifest are under
`output/playwright/collaboration-audit-2026-10-24T03-05-23-501Z/`.
These artifacts are local and ignored by Git. The capture recipe is retained at
`.omb-scratch/collaboration-audit/capture.ts`.

| Step | Action | Result / health |
| --- | --- | --- |
| 1 | Open an ordinary group | Works; sharing starts from an icon without a visible People label. |
| 2 | Alice invites Bob and Chris separately | Both memberships become active; the closed group header still shows only local bot membership. |
| 3 | Open Manage Members | Incomplete for the requested task: only local bots appear. |
| 4 | Open Share this group | All three people and shared bot names appear; no shared account or execution controls. |
| 5 | Inspect the people roster at phone width | The sharing panel fits after layout settles; the same account/presence gaps remain. |
| 6 | Open the local bot's model picker | Only Alice's local instance is returned and selectable; Bob/Chris have no execution targets. |
| 7 | Stop Bob's application | Bob still has the role Member; there is no per-person application availability or last-successful exchange. |
| 8 | Remove Bob | Bob becomes Removed and independently invited Chris stays Member. Bob's old bot profile remains listed without an inactive marker. |

![1. Group entry](../../output/playwright/collaboration-audit-2026-10-24T03-05-23-501Z/01-group-entry.png)
![2. Group after two colleagues joined](../../output/playwright/collaboration-audit-2026-10-24T03-05-23-501Z/02-three-person-group-header.png)
![3. Manage Members lists bots](../../output/playwright/collaboration-audit-2026-10-24T03-05-23-501Z/03-manage-members.png)
![4. Three-person sharing roster](../../output/playwright/collaboration-audit-2026-10-24T03-05-23-501Z/04-people-roster-desktop.png)
![5. Phone people roster](../../output/playwright/collaboration-audit-2026-10-24T03-05-23-501Z/05-people-roster-phone.png)
![6. Local account picker](../../output/playwright/collaboration-audit-2026-10-24T03-05-23-501Z/06-provider-picker.png)
![7. Bob application stopped](../../output/playwright/collaboration-audit-2026-10-24T03-05-23-501Z/07-bob-app-offline.png)
![8. Bob removed, Chris remains](../../output/playwright/collaboration-audit-2026-10-24T03-05-23-501Z/08-bob-revoked-chris-stays.png)

## Findings

P0 denotes a blocker to the requested product journey, not a claim of an exposed
credential or an exploitable vulnerability.

| Priority | Gap | Evidence and consequence |
| --- | --- | --- |
| P0 | No colleague-account execution | Step 6. The picker uses `state.instances`; `ModelSelection` contains a local `instanceId`, model and native options. The runtime resolves it with the local registry. There is no owner/machine/grant-qualified route. |
| P0 | No owner sharing/permission workflow | Steps 4 and 6. The collaboration protocol includes membership, text, bot labels and assignment events. It has no account advertisement, execution grant, job submission, cancellation or approval messages. A Tailscale connection or group invitation cannot substitute for these missing permissions. |
| P1 | People and bots have contradictory entry points | Steps 2–4. The group header's member count and Manage Members describe bots; the people roster is hidden under Share this group. No visible People count or unified roster leads the user to the right place. |
| P1 | Membership is not availability | Step 7. Member/Removed are grant states. Status exposes group-level pending/error/last-sync, not each person's app reachability, last seen or shared-account readiness. Another peer can update the group's last-sync while Bob is offline. |
| P1 | Revoked profiles remain visually usable | Step 8. Historical bot catalogs remain visible with the same presentation after their owner's removal. Retaining history is appropriate; resource availability needs an explicit inactive/revoked state. |
| P1 | Human identity is represented by an installation identity | Each membership binds a signing key and user-entered name to an endpoint. There is no separate person-to-multiple-devices model or distinct humans using one installation. Names are not unique identifiers. |
| P1 | Roster reading is coupled to administrator authority | `GroupSharing` hides itself without admin scope, and GET `/api/collaboration` also requires admin. A group reader/client has no separate authorized membership-read view. Removing the guard wholesale would expose private group information; read and management permissions need distinct checks. |
| P1 | Remote sessions, work and usage are absent | Remote text is imported inertly. Shared catalogs contain name/title/color, not executable bot/session capabilities. Completed reply text does not convey native session control, pending approvals, project/worktree identity or owner-attributed token usage. |
| P0 | A green fixture run did not cover the missing journey | The existing acceptance command verifies local setup and implemented group text behavior. It never selects Bob's provider and proves Bob's machine executed the task. Its success must not be described as completion of shared-provider collaboration. |

Source anchors:

- [Group sharing UI](../../src/components/GroupSharing.tsx),
  [bot-only member management](../../src/components/ManageMembersPanel.tsx),
  [group header](../../src/components/GroupView.tsx).
- [Local model picker](../../src/components/ModelPicker.tsx),
  [model selection contract](../../shared/wire.ts),
  [local model validation/routing](../../server/runtime.ts).
- [Collaboration protocol/status](../../shared/collaboration.ts),
  [replication-only service](../../server/collaboration-service.ts),
  [inert message projection](../../server/collaboration-groups.ts),
  [membership authorization and limits](../../server/collaboration-ledger.ts),
  [administrator-only collaboration routes](../../server/routes/collaboration.ts).

## Completion contract

1. Add a visible **People** entry/count on a shared group. Show people, their
   devices, roles, app availability and last contact separately from bots.
   Preserve an authorized read view without granting administrative controls.
2. Add owner-controlled **Share execution** settings. An owner chooses the
   account/bot, permitted group members, projects/folders, allowed operations,
   approval requirements and expiry. Private credentials remain on that machine.
   Revocation must distinguish group visibility from execution permission.
3. Add a provider-neutral **Run with** selector: this machine, Bob's machine,
   Chris's machine, followed by the explicitly shared account/model. Namespace
   targets by installation and grant; never merge identical local instance IDs.
   Preserve native model/effort/variant/permission capabilities per target.
   Offline, signed-out, unsupported and revoked targets need explicit reasons.
4. Implement authenticated remote jobs on the owner's runtime and selected
   checkout/worktree. Record requester, executor, account owner, group, task and
   attempt. Recheck grants at execution and approval boundaries. Persist job IDs;
   a lost acknowledgment must produce an uncertain state rather than repeat work.
   Owner and requester need the allowed approval/cancel/recovery actions in UI.
5. Show remote progress/results and task-scoped usage with owner attribution.
   Full account allowances remain private unless separately shared. Preserve
   unknown metrics, native sessions and provider-specific limitations.
6. Release against the complete business journey below. Keep peer-to-peer
   operation and creator-offline behavior; no installation becomes a permanent
   mandatory host just to dispatch work.

## Required acceptance before calling provider sharing complete

- At least three installations: Alice can choose her own, Bob's and Chris's
  separately authorized targets. Bob and Chris can use different drivers, the
  same driver, identical local account IDs, and duplicate display names.
- The chosen owner's fake native process records the request; the other two
  native processes do not. The reply, native options and usage retain ownership.
  Repeat the routing contract across every applicable registered adapter.
- Create, narrow, expire and revoke grants through the real UI. Revoke a queued
  request and a running/approval-waiting request. Unapproved account/folder/action
  combinations are denied by the executing machine, not just hidden by the UI.
- Disconnect after submission, after start and after completion but before its
  acknowledgment. Restart/reconnect must not duplicate execution or usage.
- Removing an independently invited Bob leaves Chris functional. Removing a
  manager must preview which descendant memberships lose access.
- Verify concurrent human tasks, assignment conflicts, native session handoff,
  correct project/worktree selection and owner/requester cancellation.
- Test authorized readers versus managers, keyboard/screen-reader navigation,
  narrow/zoom layouts and many people/devices. Three fixture peers do not qualify
  the maximum-size group or a real signed-in tailnet.

## Evidence and accessibility limits

The settled desktop and phone captures support the roster/picker findings. The
Share trigger has an accessible name and Escape handling in source; member
removal buttons all have the generic accessible name Remove, without the person's
name. Code also makes the roster administrator-only. Screen-reader behavior,
full keyboard coverage, numerical contrast, zoom, large rosters and real physical
device presence were not qualified in this audit.

Earlier capture attempts were rejected where onboarding covered the target or a
resize was still animating. A first rapid repeat-invitation click also raced a
roster refresh and hit a moved control. The successful capture waits for the
current roster, dismisses onboarding through UI and waits for finite animations.
That isolated timing observation is not evidence of a one-invite limit.
