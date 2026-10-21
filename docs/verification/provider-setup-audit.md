# Provider setup audit — 21 October 2026

Scope: every built-in provider driver and the browser Settings path. The evidence uses an isolated server and fake CLIs or local API substitutes. No live account or user data was imported.

## 21 October verification results

- 202 focused provider/setup tests passed; the built-app Edge smoke passed all 23 checks. Typechecks, lint, locale validation, web image build and public docs build passed.
- In a separate Docker container with an empty credential home, real Cline 3.0.73, Claude Code 2.1.304 and Codex 0.163.0 obtained official authorization challenges. Cline, Claude, Codex browser sign-in and Codex device sign-in each stayed waiting, cancelled, and restarted successfully. No account was authorized. These CLIs came from the image; this is authentication evidence, not installation evidence.
- The separate ENGINES-empty public installation attempt encountered sustained slow vendor downloads. Cursor timed out after 30 minutes; Antigravity's download terminated. No complete public installation matrix is claimed for that attempt. npm logs are retained locally under `output/provider-install-attempt-logs/`.
- Cursor's timeout exposed zombie-only Linux process groups being mistaken for active installers. The shared process-stop check now confirms whether any group member can still execute. The Docker regression runs without a reaping init and proves both a live root and an already exited root can have their stubborn helpers stopped, with safe repeated stops. Windows process-stop regressions also passed.
- Antigravity's pinned download now resumes interrupted transfers with validated HTTP byte ranges, retries at most three times within its existing deadline, restarts safely if the host ignores Range, and retains the pinned SHA-256 and size checks. Regressions cover complete, resumed and restarted extraction, invalid ranges and exhausted network retries. This is recovery evidence using a local substitute, not a claim that the public download succeeded on this network.

## Browser evidence

1. Open **Settings → Model providers and accounts**. The isolated OpenCode card shows a runnable provider and its status; the fixture account and model are illustrative. The browser smoke also checks the model picker and an ACP reply.

   ![Isolated OpenCode provider card](../../output/playwright/hattera-opencode-provider.png)

2. Expand signed-out Codex. The same account offers browser sign-in on the server computer and a one-time code for other devices. The server rejects browser callback flows through a proxied request.

   ![Isolated Codex sign-in choices](../../output/playwright/hattera-codex-auth-options.png)

3. Expand installed Qwen with no configured provider. It remains in setup and offers provider URL, model and API-key inputs. A terminal command does not count as a hosted setup path.

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
| OpenCode | Server install; supported provider keys in its Settings card; existing native accounts retained | Browser ACP reply and provider card; key-flow tests |
| Cursor | Official server installer; in-app browser sign-in or Cursor API key | Shared login controller, strict vendor-link validation and component checks |
| Kimi, Cline | Server npm installer; in-app device sign-in; Cline also supports compatible API setup | Native prompt validation, private login lifecycle and component checks; Cline confirmation/failure/cancellation regressions |
| Droid | Server npm installer; Factory API-key form | Fixed credential mapping and setup component tests |
| Qwen, pi, Hermes | Server npm or official installer; provider URL, model and key form | Native configuration preservation, discovery and setup component tests |
| Gemini CLI (optional) | Server npm installer; Gemini API-key form | Fixed credential mapping, component and credential-shape tests; no live enterprise account |
| Amazon Bedrock | No installer; region, model/inference profile ID and Bedrock API-key form | Isolated HTTP setup/private-key checks; local native Converse reply, image/tool translation and cancellation tests |
| OpenAI, Claude API key, xAI, OpenRouter, Mistral, Cerebras, Groq, compatible API | Settings API-key form; configured-key status and provider test | Provider key-flow and check tests; registry access-override regression |
| MiniMax API | Settings API-key form; configured-key status; optional legacy MiniMax CLI key | Isolated key-flow and driver tests; no separate read-only provider test |
| Custom ACP | User-supplied command and provider-owned account setup | Generic ACP runtime tests; no universal authentication protocol |

The built-in-driver contract now requires a browser account form, a native in-app login controller, or managed app setup. A terminal command alone cannot satisfy the check. Configured access types are preserved, and Qwen, pi and Hermes readiness requires a usable route. Key fields are write-only; account updates are admin-scoped and blocked during active provider work or sign-in. Existing provider files are preserved, and malformed documents are not overwritten.

Cline's CLI attempts to launch `xdg-open` during device sign-in. In a headless Linux container this can crash after publishing a valid code. Hattera supplies a private no-op browser launcher only to the explicit login child; the browser app opens the validated official link. Cursor uses its supported `NO_OPEN_BROWSER` flag. Starting a flow never pre-authorizes the user's account.

Bedrock uses native Converse with one explicitly configured model or inference profile. The API-key path does not implement IAM role credentials, automatic model discovery or incremental streaming. Existing native vendor accounts remain usable, but the new compatible-provider forms do not implement every optional OAuth method offered by the vendor CLIs.

On 20 October 2026, a disposable Linux container downloaded Cline 3.0.73 from the public npm registry through Hattera's server API. The install request returned promptly, status polling reached verified success, and the installed CLI answered `--version` as the non-root app user. This proves public registry access for Cline in that Docker environment; other vendor downloads and account sign-ins remain deployment-specific.

The account owner still supplies credentials. Fixture tests prove local installation and UI routing, not vendor OAuth success, account entitlement, or a real model reply. MiniMax checks a saved key on the first model request; custom ACP retains provider-specific manual setup because there is no universal authentication protocol. Test each desired provider account on its deployment host before calling that integration live.
