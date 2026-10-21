# Provider setup audit — 20 October 2026

Scope: every built-in provider driver and the browser Settings path. The evidence uses an isolated server and fake CLIs or local API substitutes. No live account or user data was imported.

## Browser evidence

1. Open **Settings → Model providers and accounts**. The isolated OpenCode card shows a runnable provider and its status; the fixture account and model are illustrative. The browser smoke also checks the model picker and an ACP reply.

   ![Isolated OpenCode provider card](../../output/playwright/hattera-opencode-provider.png)

2. Expand signed-out Codex. The same account offers browser sign-in on the server computer and a one-time code for other devices. The server rejects browser callback flows through a proxied request.

   ![Isolated Codex sign-in choices](../../output/playwright/hattera-codex-auth-options.png)

3. Expand installed Qwen with no configured provider. It remains in setup, shows the `qwen` first-run action, and links its setup guide. This check is in the built-app browser smoke.

   ![Isolated Qwen setup card](../../output/playwright/hattera-qwen-setup.png)

4. Expand MiniMax with no key. It offers the saved-key Settings path and no CLI installer. This check is in the built-app browser smoke.

   ![Isolated MiniMax setup card](../../output/playwright/hattera-minimax-setup.png)

## Contract inventory

| Provider path | Setup offered | Verification |
| --- | --- | --- |
| Claude | Server install; pasted browser code from Claude CLI | Login controller tests and provider setup component tests |
| Codex and ChatGPT plan | Server install; browser OAuth locally or one-time code remotely | Isolated HTTP method and network tests; browser choice check |
| Grok CLI | Server install; in-app code | Device-flow tests and component tests |
| Antigravity | Managed server install; Google browser flow | Managed installer and auth tests |
| OpenCode | Server install; provider login in its CLI, or supported provider key | Browser ACP reply and provider card; key-flow tests |
| Cursor, Hermes | Official server installers; vendor CLI setup | Local installer substitutes and install verification |
| Kimi, Droid, Cline | Server npm installer; vendor CLI setup | Loopback npm installer regression and setup component tests; public Cline 3.0.73 install in disposable Docker container |
| Qwen, pi | Server npm installer; `qwen` → `/auth` or `pi` → `/login` | Installer regression; Qwen signed-out browser state and catalog tests; pi driver tests |
| Gemini CLI (optional) | Server npm installer; `gemini` for enterprise or paid API-key access | Installer regression and credential-shape tests; no live enterprise account |
| OpenAI, Claude API key, xAI, OpenRouter, Mistral, Cerebras, Groq, compatible API | Settings API-key form; configured-key status and provider test | Provider key-flow and check tests; registry access-override regression |
| MiniMax API | Settings API-key form; configured-key status; optional legacy MiniMax CLI key | Isolated key-flow and driver tests; no separate read-only provider test |
| Custom ACP | User-supplied command and provider-owned account setup | Generic ACP runtime tests; no universal authentication protocol |

The registry previously dropped each instance's configured access type from `/api/instances`. Settings therefore could treat an API-key instance as a subscription provider even though runtime routing used the configured type. The registry now preserves the override in descriptions and replaces it when the instance changes. Qwen and pi previously treated an installed executable as ready without a configured model route. Their readiness now depends on a discovered route. Gemini, Qwen, and pi now advertise their interactive first-run command. A built-in-driver contract test rejects future CLI providers with no setup action.

On 20 October 2026, a disposable Linux container downloaded Cline 3.0.73 from the public npm registry through Hattera's server API. The install request returned promptly, status polling reached verified success, and the installed CLI answered `--version` as the non-root app user. This proves public registry access for Cline in that Docker environment; other vendor downloads and account sign-ins remain deployment-specific.

The account owner still supplies credentials. Fixture tests prove local installation and UI routing, not vendor OAuth success, account entitlement, or a real model reply. MiniMax checks a saved key on the first model request; custom ACP retains provider-specific manual setup because there is no universal authentication protocol. Test each desired provider account on its deployment host before calling that integration live.
