# Codex sign-in audit — 21 October 2026

Scope: a signed-out Codex CLI account in Hattera's model picker and AI settings. The user-provided model-picker screenshot is the before state; the after states are from the isolated built app in Chrome. No real account credentials or live app data were used.

## Flow evidence

1. **Open Codex while signed out — broken.** The model picker offered only device-code retry, then a generic failure that also suggested a ChatGPT security setting. The screen did not separate a server network failure from a disabled device-code method. The screenshot does not reveal the underlying CLI output, so the cause was checked separately with an empty credential home.

   ![User-provided Codex sign-in failure](../../output/playwright/hattera-codex-auth-before.png)

2. **Choose a method in the web app — corrected.** The same Codex account card now offers browser sign-in and a one-time code. Docker Compose forwards the fixed localhost callback to the CLI for a browser on the server computer. A browser on another computer can paste the final callback address into Hattera; the server verifies its origin, path, and OAuth state before passing it to that CLI. A remote browser can choose either method.

   ![Isolated Chrome capture of both Codex methods](../../output/playwright/hattera-codex-auth-options.png)

3. **Choose a one-time code — corrected.** Selecting the code changes the main action to **Get one-time code**. The server starts `codex login --device-auth`; browser sign-in starts `codex login`. Both use the same installed CLI, credential home, sign-in lock, confirmation check, and sign-out action. Switching while a challenge is active is blocked until cancellation.

   ![Isolated Chrome capture of the code choice](../../output/playwright/hattera-codex-auth-code.png)

## Root causes and checks

- Browser OAuth already existed in `CodexBrowserAuthController`, but regular Codex instances always constructed only the device controller. The browser controller was selected only through a separate `browser-cli` configuration mode; the UI and API exposed one method per instance.
- The app's local review process could not reach `auth.openai.com` or the npm registry. A fresh real Codex CLI failed before producing a code. That environment cannot establish a real provider sign-in, regardless of which button is chosen.
- The default device failure text guessed that device-code login was disabled. The shared controller now identifies known transport failures without exposing CLI output; unknown failures point to the server's Codex login log instead of guessing a cause. The account-settings hint is hidden after a failed attempt.
- Isolated HTTP tests exercise both methods, invalid method rejection, a proxied browser attempt, callback validation and completion, switching during an active flow, cancellation, and a redacted network error. The component test checks the selected method sent by the card. The built-app Chrome smoke completed 18 checks, including the Codex card and both choices.

## Docker callback verification

The updated production image was started with a disposable `/data` volume and the local Compose Caddy sidecar. The installed Codex CLI started `browser-pkce` and returned OpenAI's authorization host with `http://127.0.0.1:1455/auth/callback` as its redirect. From the Windows Docker host, an intentionally invalid callback reached Codex and returned HTTP 400; `/other` returned Caddy's HTTP 404. The test flow was cancelled and the fixture containers and volumes were removed. No real OpenAI account was authorized in this audit.

The separate ChatGPT plan account uses a dynamic localhost port. Its browser callback can also be pasted into the web app; an isolated signed OIDC fixture confirmed the matching callback completes the account, while mismatched hosts and state are rejected. The focused Codex and ChatGPT browser suites passed 73 tests after this change.

The browser captures show layout and visible copy. `aria-pressed` and the sign-in-method group label are verified in the rendered UI, but screenshots alone do not establish screen-reader behavior or keyboard focus order. A real ChatGPT account, the public authentication service, and a remote deployment remain acceptance checks on a host with outbound HTTPS.
