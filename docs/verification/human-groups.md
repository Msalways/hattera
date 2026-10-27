# Human group sharing

Groups replicate selected text independently of each local bot's provider.
[Shared execution](shared-execution.md) separately adds explicit owner-granted
provider routing and native tasks. The project coding harness remains separate.

The [original audit](collaboration-audit.md) records the gaps that motivated
shared execution. The **People** roster supports multiple independently invited
people; **Manage Members** still manages local bots. Joining alone does not grant
provider access. Owners share selected accounts in **Shared providers and requests**;
colleagues then select an owner-qualified target under **Run with**.

## Browser flow

An installation administrator opens a group's **Share this group** control.
Connect the app's Tailscale device in the same panel, enter a display name, and
start sharing. Existing conversation text is excluded unless explicitly selected.
Generate an invitation, choose whether the person may invite others, and send the
private code to that person. In their Hattera installation they select a local
group, open sharing, enter their name and paste the invitation. Local bot members
remain local; they are not replaced by the other installation's bot IDs.

The invitation is single use and expires in five minutes. Joining and history
bootstrap run in the background. An interrupted join resumes after restart. If its
invitation expires, the person can paste a fresh invitation for the same group.
The panel shows human memberships, shared bot profiles, pending event deliveries,
last exchange and errors. Pause affects this device. Deleting its local group
pauses that binding and never recreates the deleted group from incoming events.

## Data and authority

- Each installation has separate Ed25519 signing and X25519 encryption keys.
  Packets are signed and recipient encrypted using the existing HPKE library.
  Tailnet presence supplies connectivity; it does not confer app authority.
- The signed group log is authoritative and also serves as the durable outbox.
  Membership proofs bootstrap before content. Acknowledgments are per membership
  and stream; duplicate delivery and lost acknowledgments do not repeat writes.
- A manager may invite and revoke its membership descendants. Other managers
  continue sharing while the creator is offline. Revocation is enforced on a
  device once it knows the signed revocation; offline partitions are eventual.
  Previously copied history cannot be remotely erased.
  A known former member may retrieve only the revoking manager's bounded signed
  control chain through its revocation. It cannot submit events or receive later
  controls, group content or execution records. This lets disconnected members
  and removed descendants learn that their authority ended after reconnecting.
- Only selected group text, finished bot replies and minimal bot profiles are
  exported. Private quotes, composer attachment handles, cards, raw tool payloads,
  account credentials, native sessions and global memory are excluded. Normal
  secret redaction also applies. Text over 64,000 characters is not exported.
- Imported text never starts a bot, impersonates a local signed-in person or
  grants file access. Peer bot Markdown has no local file controls or automatic
  image loading. The production message-file endpoint refuses peer-authored text.
- Identity, invitations, acknowledgments and logs stay in the private
  `collaboration/` directory and are excluded from portable backup/restore. Existing
  transcript projections remain ordinary group history. Missing keys, interrupted
  logs and verified forks fail closed; they do not silently rotate credentials.
- Remote ingress accepts only bounded encrypted peer packets; it does not create
  sessions or confer administrator scope. Managed remote-access policy and
  workspace-maintenance guards apply to background exchanges too.

## Isolated verification

```powershell
node node_modules/vitest/vitest.mjs run server/collaboration-ledger.test.ts server/collaboration-box.test.ts server/collaboration-service.test.ts server/collaboration-groups.test.ts server/private-network.test.ts --maxWorkers 1
```

Run the complete fresh-build HTTP and browser gate with:

```powershell
npm run test:e2e
```

See [E2E setup](e2e.md) for prerequisites, reports and Docker qualification. The
stdlib-only transport helper is built automatically from its source. The HTTP
scenario can also run directly with
`node node_modules/vitest/vitest.mjs run server/collaboration.e2e.test.ts --maxWorkers 1`.
A missing Go compiler or failed helper build fails the scenario instead of skipping.
This test deliberately uses a fake transport
that maps synthetic tailnet addresses to explicitly owned loopback app processes.
It performs no VPN login, accesses no live installation, and stops/removes only its
own runtimes and temporary homes. This is never reported as live network qualification.

The checks cover concurrent messages, creator stopped, manager invitation,
reconnect/restart, duplicate delivery, revocation, forged peers and credential
boundaries. Core tests also cover conflicting task assignments and explicit
resolution. The three-app browser scenario drives consent, invitations and join,
creator-offline conversation, phone roster, restart, pause/resume and revocation
using visible controls. The ordinary smoke also checks disconnected-network UI.
Neither completes a real tailnet invitation.

## Manual Tailscale confirmation

On October 26, 2026, the maintainer reported personally testing a Tailscale
connection and confirming that group collaboration worked. This is a manual
user report, separate from the automated fixtures and simulated Docker recording.
No device/OS matrix, recording or detailed scenario report accompanied it.
It confirms the reported group connection; it does not establish remote provider
account execution, credential isolation, restart/revocation recovery, or all
supported platforms.

## Remaining acceptance work

Group connectivity has the manual confirmation above; comprehensive multi-device
and OS qualification remains pending. Authorized attachment transfer, UI task assignment,
consistent transcript ordering across concurrent arrivals, live bot activity,
membership repair/rejoin after removal, and project
registration/documentation/worktree workflows remain unfinished. Do not describe
this milestone as the complete human-groups or coding-harness delivery gate.
