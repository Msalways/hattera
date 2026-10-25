# Using a colleague's provider

Each installation can share explicitly selected local bots with other people in
a shared group. There is no permanent primary installation. An execution target
is qualified by group, owner signing key and grant ID, so identically named
provider accounts on different computers cannot collide.

## Browser workflow

1. Each person opens their own Hattera installation, configures their provider
   account, and connects **Settings → Private network** to the same reachable
   Tailscale network. Device login and access policy remain under their control.
2. In a group, choose **Share group** / **People**, start sharing, and create a
   separate invitation for each colleague. Each colleague accepts the invitation
   in a group on their own installation. Group membership alone grants no execution.
3. The account owner opens **Shared providers and requests**, selects a bot and
   the people allowed to use it, reads the workspace/tools/memory disclosure,
   and confirms **Share selected bot**. Per-request approval is enabled initially.
   A dedicated bot/workspace is recommended because this is real task execution.
4. A colleague chooses the owner-qualified account under **Run with**, enters a
   task, and sends it. The owner can approve or deny it in the same panel. Native
   tool approvals remain in the owner's local task, accessible with **Open local
   task and native approvals**. Granting a bot does not bypass its tool permissions.
5. Both sides see request state, bounded response text and provider-reported token
   usage. **Open shared conversation** opens that execution's group conversation.
   The owner can revoke access; the requester can cancel or retry an unconfirmed
   delivery with its original request ID.

Sharing is bidirectional only when each owner grants access. Bob can grant Alice
access without Alice granting Bob access. Multiple other people may be selected
independently. Offline/paused/revoked accounts cannot be used as local fallback.

## What crosses the connection

The encrypted, signed peer protocol carries a bounded task, an explicit target
grant, request identity, state, response and usage. The owner creates a new native
task and keeps its credentials, private transcript, paths, sessions and account
configuration locally. The task runs on the owner's computer and uses that bot's
configured workspace, tools, memory and profile context. It does not edit a
requester's local checkout. Prompts and results are published as group text;
do not include information that other group members should not see.

This delegates the existing native bot pipeline for every registered adapter;
there is no provider-specific remote login or substitute model selection.
Model, effort and variant are inherited from the shared bot. Tracked bot/account
configuration and permission changes invalidate admitted work. Automatic account recovery/fallback
is disabled for shared jobs. Provider authentication and service availability
can still fail and are not guaranteed by installing an engine.

Membership and execution grants are checked on admission, approval and dispatch.
Known revocation cancels pending work and interrupts active work. Revocation
propagates eventually across offline partitions; previously shared data cannot
be recalled. Native cancellation is best effort: uncertain cancellation or
restarting during execution requires owner review and is never replayed.

Durable request IDs prevent concurrent retries of an acknowledged or unacknowledged
submission from launching a second task. A sender interrupted during submission
retains that same retryable ID after restart. Owner records and grants stay in the nonportable
`collaboration/` directory. Missing/corrupt execution state fails closed. Peer RPC
cannot call arbitrary app routes, supply native filesystem handles, select another
local account, or approve tools. Each browser administrator controls its own
installation; separate multi-user reader roles are not implemented here.

## Verification

`npm run test:e2e` includes shared-execution contracts, three-process native
execution and browser controls. For focused checks:

```powershell
node node_modules/vitest/vitest.mjs run server/collaboration-execution.test.ts server/collaboration-execution.e2e.test.ts --maxWorkers 1
```

The native scenario uses Claude, Codex and OpenCode protocol fixtures on separate
app processes with identical local instance IDs. It checks owner approval,
the selected native adapter/model, reverse routing, usage, idempotent retries,
shared conversation projection, cancellation, independent grants, restart, and
continued work while the creator is offline. Contract cases exercise lost receipts,
configuration changes, unauthorized members, revocation and uncertain restarts.
The browser scenario grants access, selects a colleague, submits, approves and
renders a native response at phone width through visible controls.

These tests use temporary homes and a simulated peer transport. They do not
authorize real provider accounts or qualify a physical Tailscale connection.
Final live acceptance needs two consenting devices, each with its own working
provider login, reachable private network and explicit group execution grants.
Project synchronization, shared worktrees, transferring an ongoing native session,
remote attachments and a full project coding harness remain separate work.
