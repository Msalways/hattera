# Hattera local collaboration and account visibility

## Product contract

Hattera stays a personal assistant with Chief, bots, memory and existing groups.
Humans can join selected groups from their own Hattera installations. Tailscale
connects installations; no Hattera VPS or permanently primary computer is required.
Each installation owns its credentials, files and running bots. Group membership
grants visibility to shared material, never implicit permission to execute commands.
Coding projects, repository documentation, epics and worktrees are optional work
inside these groups. All Hattera configuration is available in the browser UI.

## Delivery order

1. **Account reporting:** replace the three-driver allowance filter with a report
   for every configured account. Preserve existing allowance contracts while adding
   arbitrary quota windows, balances, reporting capability, source and freshness.
   Read native protocols and documented provider endpoints before using an existing
   private endpoint. Keep missing values unknown. Collect API response limits during
   real requests without spending inference tokens to refresh a dashboard.
2. **Private networking:** package a versioned tsnet helper for Windows, macOS and
   Linux. The UI starts browser authentication, shows approval/connection state,
   detects peers and disconnects only Hattera's connection. Offer existing system
   Tailscale as an explicit alternative. No command-pasting setup, public Funnel,
   embedded admin keys, or replacement of unrelated Serve endpoints.
3. **Human group collaboration:** add human/peer membership separately from legacy
   bot memberIds. Pair installations with expiring invitations and independently
   authenticated peer identities. Replicate only selected group events and resource
   references; retain private conversations and memory locally. Persist event IDs,
   per-origin sequence cursors and an outbox; reconnect and duplicate delivery must
   be idempotent. Independent message appends merge; competing task assignments
   need an explicit conflict state. Never merge another peer's app database.
4. **Remote actions:** owners explicitly select shared bots, folders and allowed
   operations in UI. Preserve requester, executor, account owner and machine through
   Chief delegation. Execute on the chosen machine's own checkout/worktree. Check
   the grant again at execution and approval boundaries. Disconnects yield pending
   or uncertain outcomes; never automatically repeat a possibly executed action.
5. **Local coding workflow:** add a persistent `hattera web` launcher with the same
   global dashboard from any cwd. Register repositories explicitly; reuse native
   instructions, skills and permissions through selectable profiles. Maintain
   reviewed personal standards and project docs with bounded, incremental context.
   Keep native provider sessions intact; do not imply hidden reasoning or caches
   transfer between engines.

## Reporting contract

- Show every configured account, including signed-out, disabled and custom routes.
- Use a list of metrics: provider scope/model, window duration, used/remaining/limit,
  unit, reset time, source, collection time and completeness. Do not force every
  provider into five-hour and weekly slots or infer quotas from token counts.
- Keep provider-wide account snapshots separate from Hattera-observed task usage.
  Record retries and helper calls with stable event/attempt IDs; deduplicate shared
  events. Subscription price equivalents are estimates, not invoiced charges.
- Resolve wrappers such as OpenCode, Cline, pi and Hermes to their actual upstream
  billing route where that identity is known. Do not sum aliases of a shared quota.
- Prefer events, then cached read-only queries with bounded concurrency, backoff
  and provider-specific refresh periods. Refresh on account changes and UI demand.
  Preserve the last successful snapshot as stale after a transient failure.
- Full account reporting is private to its owner. Group task usage is shared with
  that group. Broader allowance visibility requires the owner's explicit choice.
- Provide reporting connection actions when extra permissions are needed, and an
  official dashboard link when a metric is unavailable. Never display unknown as
  zero, unlimited, or an available model.

## Coding harness and storage design

This section specifies later milestones; it is not an implemented feature list.

- **One local runtime:** CLI-only execution uses the same bot actions, Chief,
  memory, provider registry and persistence as the browser app. A persistent local
  launcher owns runtime lifecycle. Opening a different repository attaches to that
  runtime; it must not silently create another global memory or dashboard.
- **Explicit project registration:** store repository identity, trusted paths,
  branch/worktree references and selected group separately from global settings.
  A project's portable documents contain no provider credentials or peer grants.
- **Project records:** epics contain tasks with acceptance criteria, dependencies,
  ownership, execution attempts and verification artifacts. Record the exact
  revision and commands behind a successful check. Failed, canceled and uncertain
  attempts remain visible. Reassignment does not erase the previous execution.
- **Shared documentation:** maintain an index of reviewed architecture, interfaces,
  decisions and task context, with source paths, content hashes and revision.
  Retrieve changed sections relevant to the task instead of resending every
  document or the full conversation. Report stale references. Separate durable
  facts and accepted decisions from an agent's unverified proposals.
- **Native integration:** discover existing AGENTS.md, CLAUDE.md, skills, MCP
  configuration and native sessions. Do not overwrite them. Each adapter declares
  supported models, reasoning settings, permissions, streaming, resume, tools and
  worktree behavior for the installed version/auth route. UI controls expose those
  capabilities; unsupported settings produce an explicit explanation. Native
  provider options must not disappear merely because another provider lacks them.
- **One worktree authority per run:** either delegate worktree lifecycle to a
  qualified native provider or use Hattera's lifecycle, with the choice visible.
  Keep a mapping from task/attempt to native session and checkout. A cross-provider
  handoff transfers reviewed context, revision and artifacts; it does not claim to
  transfer hidden reasoning, provider caches or a resumable native session.
- **Account routing:** choose accounts explicitly, retaining their native auth
  isolation. Report shared upstream quota identities when known. A colleague's
  grant authorizes work on their machine with their locally held account; it never
  exports their login files or silently rotates through accounts after a refusal.
- **Persistence:** preserve existing JSON configuration and data compatibility.
  Append durable collaboration/execution events with stable IDs and sequences;
  use DuckDB for queryable indexes/usage views that can be rebuilt. Define one
  authoritative record for each fact instead of independently mutating JSON and a
  database copy. Migration and rollback tests precede stored-path changes.

## Delivery gates

| Milestone | Required before describing it as complete |
| --- | --- |
| Account visibility | Reporting row for every configured account; collector and permission status for every engine/auth route; real-account qualification for supported snapshots; no invented quota values |
| Private networking | Clean packaged setup on each OS, completed sign-in, approval/restart/disconnect and a second device reaching the authenticated app |
| Human groups | Three independent installations; creator offline; selected data only; concurrent changes, reconnect, revocation and attachment authorization |
| Remote work | Owner-defined grants; requester/executor/account attribution; approval, cancellation, grant revocation and uncertain execution without duplicate replay |
| Coding harness | Same runtime in CLI/browser; native capability coverage; documentation freshness and token measurements; verified project/worktree lifecycle and provider handoff |

Tailscale supplies connectivity and device identity. It does not supply Hattera
group replication or consent to actions. An offline computer cannot execute work;
queues and other connected members can continue without electing a permanent host.
Provider-reported allowances can be displayed when exposed and authorized; a
provider's undisclosed limits cannot be recovered accurately from token counters.

## Verification and acceptance

Use docs/verification/README.md and temporary homes/data only. No fixture providers
or credentials may appear in the user's running product. Keep existing OMB_*
configuration, auth URLs, data paths, Compose volumes and protocol IDs compatible.

- Contract-test all registered drivers: every configured account has an explicit
  reporting result. Cover arbitrary windows, model limits, zero vs missing, credits,
  expired credentials, 401/403/429, timeouts, stale snapshots and unknown fields.
- Test native Codex account reporting without launching a turn. Test provider rate
  headers on success and failure and ensure no credentials enter report JSON/logs.
- Run network setup from clean Windows/Linux/macOS environments with no Tailscale
  client, then with an existing client. Exercise sign-in cancellation, restart,
  approval required, offline operation, private reachability and disconnect.
- Use at least three isolated instances for group replication, concurrent updates,
  creator offline, reconnect, revocation and duplicate events. Verify private data,
  search, attachments, streams and provider credentials stay inaccessible.
- Exercise remote-action grants, human approvals, cancellation and uncertain
  outcomes. Verify no delegation widens permissions and no replay repeats work.
- Browser-test desktop/mobile in Edge and Firefox, then typecheck, localization,
  contrast, web/docs builds. Record fixture evidence separately from live-account
  qualification. A mocked API or preinstalled CLI is not evidence of real setup.

## Research status

### First implementation milestone

Account reporting foundations and the app-owned Tailscale setup UI are implemented.
See [verification and remaining collector coverage](../verification/account-network.md).
The [provider matrix](../verification/provider-coverage.md) records all 20 engines,
API subroutes and the provider-specific work still required, including native
account/profile UI creation and reporting permissions.
The account lifecycle now also exposes private account creation for 19 built-in
engines, per-account setup, rename and removal. The arbitrary custom ACP adapter
does not invent a safe vendor profile. A persistent `web` launcher reuses the same
runtime across working folders, using the existing data-directory lease and verified
runtime discovery. See [profile and launcher verification](../verification/profiles-runtime.md).

The implementation includes a native helper in Docker/desktop/npm packaging,
background reporting, per-account history and credential/backup boundaries. This
milestone does not complete project registration/coding execution,
all provider quota collectors, or every human-group acceptance criterion. Those remain tracked
in the delivery order above; no live user workspace is used for their verification.

The baseline account-limit collector supported only Claude, Codex and Grok.
The first milestone expands the reporting contract and adds OpenRouter and
observed native/API limits; it is not complete collector coverage. Native protocol/version checks and real account qualification
are required for expanded reporting. An additional signed, encrypted peer service
now adds expiring invitations, selected group text/bot-profile replication,
durable retries, revocation and existing-group UI. Three isolated application
processes have passed the creator-offline and restart fixture using simulated
transport. This is distinct from the earlier Tailscale Serve integration.
See [human-group verification and unfinished acceptance work](../verification/human-groups.md).

Owner-granted provider execution is now implemented separately from text
replication: a group/owner/grant-qualified target runs a new native task on the
owner's installation, retaining its account/model, tools and native approvals.
Grants select explicit people, and requests support owner approval, denial,
cancellation, durable retry IDs and usage attribution. See
[shared-execution verification](../verification/shared-execution.md) for the
three-adapter fixture, browser workflow and live-device qualification boundary.
This does not transfer ongoing provider sessions or synchronize project worktrees.

Tailscale uses its own coordination/relay services. Offline machines cannot execute
their bots/tools. Provider account-sharing rules still apply; human collaboration
does not turn individual subscription allowances into a transferable quota pool.
