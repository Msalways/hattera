# Provider coverage and remaining qualification

Reviewed against all **20 registered drivers** in `server/drivers/builtIn.ts` on
23 October 2026. A reporting row, an installed executable and a successful mock
turn are separate pieces of evidence. None proves a real vendor account works.

## What is shared

- Account rows/cache keys use the instance ID, not the engine name. Tests cover
  two enabled accounts for every registered driver. Disabled and future/custom
  accounts remain visible without invented limits.
- The existing native model selection, effort, approvals, resume and MCP paths
  remain authoritative. This change does not replace them with one provider's
  options. Features the native adapter does not implement still need qualification.
- All six API adapters use the same usage and response-header handling. Every ACP
  adapter uses the same normalization of result usage. pi, Claude and Codex carry
  the same completeness marker. Missing fields, malformed counts and unreported
  API tool rounds cannot be silently presented as fully measured token totals.
- The marker follows direct and group turns into durable usage history and CSV.
  A provider's reported price remains usable even when tokens are incomplete;
  missing tokens cannot produce an estimated bill. Known subtotals are preserved.
- API cache reads and reported USD response prices survive normalization. Prices
  are summed only when every returned model step supplies a price. Missing
  telemetry or a failed attempt marks the total incomplete; a known earlier
  subtotal cannot masquerade as the whole bill. Quota snapshots remain separate
  from these Hattera-observed calls.
- Networking and future human grants identify the executing machine and account
  instance; they must not distribute provider login files or imply access to
  another member's allowances. Human group text replication is implemented;
  remote action execution remains unfinished. See [group acceptance](human-groups.md).

## Current account-reporting matrix

“Native usage” below means telemetry supplied by the installed engine, when it
supplies it. It does not imply every tool call, retry or native helper is fully
accounted for. Remaining completeness work must be qualified per protocol/version.

| Registered engine | Execution path retained | Account allowances in Hattera | Remaining qualification / limitation |
| --- | --- | --- | --- |
| Claude (`claudeAgent`) | Native stream protocol | Existing subscription account endpoint and native limit events | Explicit API/gateway/cloud/key-helper routes must not read an unrelated stored subscription; native OAuth/live account qualification remains |
| Codex (`codex`) | Native app-server | Native limit buckets and available account activity | Approved ChatGPT-plan auth is a separate lifecycle; not every account/auth route supports these reads |
| Grok CLI (`grokAgent`) | ACP | Existing subscription endpoint | Live endpoint/auth qualification; local/custom model routes are not separate subscription pools |
| Grok API (`grok`) | Shared chat runtime | Observed response headers | No account-wide management collector configured |
| Gemini CLI (`geminiAgent`) | ACP | Native turn usage only | Auth-route/model-specific quota collector and live qualification still required |
| Kimi CLI (`kimiAgent`) | ACP | Native turn usage; dashboard link | Native managed OAuth quota/wallet integration remains; do not borrow an API connection's key or parse another account's token slot |
| Droid (`droidAgent`) | ACP session configuration | Native turn usage; dashboard link | Factory rolling limits/Core/Extra Usage collector not implemented |
| Cursor (`cursorAgent`) | ACP | Native turn usage; dashboard link | Enterprise/admin reporting needs separate authorized credentials and UI; individual account quotas must not be inferred from team analytics |
| Antigravity (`antigravityAgent`) | Its existing native/ACP bridge | Native turn usage only | Google account/model credits and quotas require a qualified collector |
| OpenCode (`opencodeGo`) | ACP, native model variants | Native result usage | Resolve the selected upstream account before claiming its remaining allowance; no independent OpenCode quota is invented |
| Cline (`clineAgent`) | ACP | Native result usage | Cline credits and upstream-provider quotas are separate sources; upstream identity/reporting remains |
| Qwen (`qwenAgent`) | ACP | Native result usage | OAuth/BYOK routes differ; native quota collector remains |
| Hermes (`hermesAgent`) | ACP | Native result usage | Portal and BYOK upstream identities/reporting remain |
| pi (`piAgent`) | Native RPC | Native token fields, with incomplete fields marked | No independent pi quota pool; upstream identity and complete multi-step/helper accounting still need qualification |
| OpenAI-compatible (`openai-compat`) | Shared chat runtime | OpenRouter current-key budgets; Kimi key quota/wallet; MiniMax plan/balance on recognized official routes; observed headers | Custom proxies/local servers do not inherit another service's reporting endpoint |
| MiniMax (`minimax`) | Shared chat runtime | Plan windows or API balance using the same effective key/region as inference | Legacy/new counter semantics reconciled against explicit percentage; live account/region qualification required |
| Mistral (`mistral`) | Shared chat runtime | Observed headers | Optional admin reporting permissions/connection not implemented |
| Cerebras (`cerebras`) | Shared chat runtime | Observed independent token/request windows | Organization/model limits can differ; no guessed quota from catalog values |
| Groq (`groq`) | Shared chat runtime | Observed token/request/reset headers | Headers are snapshots from real calls, not a full account billing dashboard |
| Custom ACP (`customAcp`) | Configured ACP runtime | Whatever usage its protocol supplies | No assumed vendor, login method, account allowance or model capability |

### Routes inside the API driver

Amazon Bedrock is an `openai-compat` catalog/Converse route, not a missing extra
registered CLI. Missing Converse usage remains missing, and relevant response
headers survive translation. AWS region/account service quotas and billing
metrics still need their own IAM-authorized collector; tokens cannot determine
those limits. OpenRouter, Kimi keys, MiniMax keys and local servers likewise keep
their actual configured account identity.

Kimi key reporting recognizes only the official CN/global `/coding/v1` routes.
It renders supplied 5-hour, weekly, monthly-total/monthly-code and future windows,
plus available wallet fields. Calendar months are not replaced with a fixed
seconds count. Currency is displayed only when reported.

MiniMax reporting distinguishes subscription keys and `sk-api-` keys using the
official CLI's endpoint selection. It preserves model scope, supplied window
times, boosted remaining percentages, explicit unlimited/not-in-plan status and
unknown values. Balance responses without a currency stay provider units.
Custom gateways and redirects never acquire reporting credentials for an inferred
vendor endpoint. No inference request is made to populate an allowance dashboard.

## Verification

```powershell
node node_modules/vitest/vitest.mjs run server/api-account-usage.test.ts server/drivers/provider-usage.test.ts server/account-usage.test.ts server/drivers/acp/acp.test.ts server/drivers/pi.test.ts server/drivers/bedrock-converse.test.ts server/drivers/openai-chat.test.ts src/components/PlanUsage.test.ts server/usage-ledger.test.ts --maxWorkers 1
```

The API matrix executes actual Grok, MiniMax, Mistral, Cerebras, Groq and
OpenAI-compatible adapters against synthetic responses. ACP/pi tests launch
repository-owned fake CLIs. Reporting tests pin official URLs and isolate keys,
exercise zero/missing/conflicting values and reject lookalikes. These tests are
not real provider login, quota or public-install acceptance.

Use the [isolated fixture procedure](README.md) for HTTP/browser checks. Keep
provider fixtures out of the user's running app. Further protocol coverage lives
in each adapter's existing tests (including Claude/Codex, OpenCode, Cline, Hermes,
Qwen, Cursor and Antigravity); passing a shared-core test does not qualify every
vendor-specific extension.

### Recorded checks — 23 October 2026

- Main shared suite: **342 passed** across nine files, including all six API
  adapters, ACP, pi, Bedrock, reporting, presentation and ledger behavior.
- Latest reporting/API/UI follow-up: **39 passed** across four files, including two
  enabled accounts per registered driver, native-method binding, separate HTTP
  concurrency, suppression of unrelated stored subscription snapshots, cache/price
  preservation and per-model allowance freshness.
- Focused Claude/Codex token/cache/aggregation regressions: **24 passed**. The
  filter intentionally left 391 other native tests unselected; this is not a claim
  that the entire native suite ran.
- Isolated usage-ledger HTTP suite: **2 passed**, including a partial native result
  through a real fixture turn, durable ledger, account grouping and blank/false
  CSV fields. No real provider account was used.
- Edge: **29 journeys passed** against the rebuilt web app and an isolated
  server, including desktop/phone settings, model/provider setup, chat, browser
  control, pairing and local-registry installation/removal. The first attempt
  timed out packing its local fixture before browser startup; the unchanged
  launcher passed after the heavy builds finished. Successful Kimi/MiniMax quota
  payloads were tested in parsers/adapters and component rendering, not through
  signed-in vendor accounts in this browser journey.
- Frontend/server typechecks, the final server bundle, web build, focused lint,
  locale validation (ten languages) and whitespace checks passed. Existing Vite
  CSS/chunk-size warnings remain; this is not a zero-warning web build claim.

The two installer assertions corrected in the shared suite were outdated relative
to the already-implemented Kimi/Droid npm installers. Current vendor documentation
was checked before changing their expectations. This does not substitute for
public-download/install acceptance on each OS.

## Still required for the full product

- Platform and real-account qualification for the new private-profile UI across
  all 19 applicable built-in engines. Creation, setup, rename and removal are now
  implemented; the custom ACP adapter does not infer a vendor profile. See
  [profile and launcher checks](profiles-runtime.md).
- Native quota collectors/reporting connections identified in the table, plus
  upstream identity resolution for wrappers. Never sum aliases of shared quotas.
- Retry/helper/multi-step usage qualification per native protocol, without
  double-counting cumulative context or treating an unknown subtotal as complete.
- Real-account and clean-install qualification on each supported OS, followed by
  signed-in multi-device networking and three-peer group/action acceptance.

## Primary references reviewed

- [Kimi reporting protocol and counter/wallet conversion](https://github.com/MoonshotAI/kimi-code/blob/main/packages/oauth/src/managed-usage.ts)
- [Kimi managed OAuth usage API](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/server-api.html)
- [MiniMax quota and balance endpoint selection](https://github.com/MiniMax-AI/cli/blob/main/src/client/endpoints.ts)
- [MiniMax count-version reconciliation](https://github.com/MiniMax-AI/cli/blob/main/src/utils/quota.ts)
- [MiniMax quota statuses and boosts](https://github.com/MiniMax-AI/cli/blob/main/src/output/quota-table.ts)
- [MiniMax plan/key distinctions](https://platform.minimax.io/docs/m-plan/faq)
- [Cursor analytics access](https://cursor.com/docs/account/teams/analytics)
- [Factory rolling limits and usage pools](https://docs.factory.ai/pricing/individuals)
- [Droid npm installation](https://docs.factory.com/droid-cli/quickstart)
- [Kimi npm installation](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started)
