# OpenCode team prototype

This checkout already has OpenCode ACP, Codex, and Claude drivers in
`server/drivers/builtIn.ts`. Its `coordinate_bots` tool can send work from a
lead to 1–4 teammates and return their results to the original thread. The
first prototype uses those paths directly; it does not need a new orchestrator.

## Run locally on Windows

Requirements: Node 24, pnpm 10.33.0, and the OpenCode CLI on `PATH`.
The launcher also configures Codex from `PATH` and Claude Code from
`../mausbot-tools` when installed. Install the latter with
`npm install --prefix ../mausbot-tools @anthropic-ai/claude-code`.

From this repository, run in separate PowerShell terminals:

```powershell
corepack pnpm install --frozen-lockfile --ignore-scripts
./scripts/start-prototype.ps1
```

```powershell
$env:OMB_PORT = '20701'
corepack pnpm dev
```

Open <http://127.0.0.1:5199/>. The starter script keeps Hattera data in
`../mausbot-real-prototype`, uses a separate OpenCode home, and removes
provider-key variables from the server process. It does not need a CopilotKit
key. The OpenCode model `opencode/space-bunny-free` completed a real turn from
an empty temporary profile during this prototype run. Free-model availability
is controlled by OpenCode and can change.

**Settings → Engines** lists OpenCode, Codex, and Claude Code. Codex and Claude
Code require their own supported sign-in before they can run turns; an engine
may be installed but unauthenticated. The launcher keeps a separate prototype
home, so sign in through the prototype's engine settings.

The launcher sets Codex's native Windows sandbox to `elevated` in its isolated
`CODEX_HOME/config.toml` when that file does not exist. Codex otherwise resolves
the app's workspace-write request to read-only and stops before the turn. An
existing Codex config is left under your control.

The Codex card opens Codex's standard browser sign-in and waits for its local
callback. This does not require enabling device-code sign-in in ChatGPT security
settings. If browser sign-in from the card cannot start, use a normal PowerShell
with the same isolated Codex home as the prototype:

```powershell
$env:CODEX_HOME = (Resolve-Path '../mausbot-real-prototype/home/.codex').Path
codex.cmd login
codex.cmd login status
```

Refresh **Settings → Engines** after signing in. Do not copy or share files
from that Codex home; they may contain access tokens.

Create a Chief in **Leadership** and Builder and Reviewer in **Engineering**.
Give the Chief the **Chief of Staff** role and access to Engineering. New bots
in this checkout default to `opencode/space-bunny-free`. If a bot was created
before this fix, set its **bot default model** to that model; changing only one
existing thread does not change new teammate threads. Ask the Chief to use
`list_room_targets` and `coordinate_bots` to get separate answers from Builder
and Reviewer. The existing live data folder contains a completed example with
these three bots.

For a credential-free, deterministic orchestration check, run:

```powershell
node --experimental-strip-types scripts/prototype-team.ts --once
```

That command uses disposable data and a scripted engine. It verifies the
Chief → Builder → Reviewer → Builder → Chief handoff, not real-model quality.
The live run separately verified real OpenCode ACP turns for all three bots
and the Chief's final synthesis. The focused regression commands are:

```powershell
corepack pnpm exec vitest run server/drivers/acp/opencode-go.test.ts server/direct-coordination.e2e.test.ts -t 'prefers OpenCode|coordinates a lead and its specialist from ordinary chat'
corepack pnpm typecheck
```

## What remains before replacing the OpenDots plan

This prototype demonstrates runtime execution and team handoff. The Spec Kit
requirements for explicit task-label routing, an OpenDots-managed capability
catalog and OAuth MCP bridge, deterministic automations, and mobile pairing
have not been verified in this fork. Keep them as separate acceptance items.
The mobile app is a companion to a running host, as described in
`docs/self-hosting.md`. The open-source core and `enterprise/` have different
licenses; see `LICENSING.md`.
