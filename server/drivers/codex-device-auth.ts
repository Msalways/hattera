// Codex's half of the in-app device-code sign-in (device-auth.ts): `codex
// login --device-auth` for a ChatGPT account, with `codex login status` to
// keep a working login and to confirm the new one, and `codex logout` for
// Settings' sign-out.
import { stripVTControlCharacters } from "node:util";
import { codexBrowserSignInLink, codexBrowserSignInPrompt, deviceSignInPrompt } from "../../shared/device-sign-in.ts";
import { DeviceAuthController, type DeviceAuthOptions, type DeviceSignIn } from "./device-auth.ts";

export function codexDevicePrompt(output: string): { authorizationUrl: string; userCode: string } | null {
  return deviceSignInPrompt("codex", stripVTControlCharacters(output));
}

function loginFailure(output: string): string {
  if (/(unexpected argument|unrecognized (argument|option)|unknown option).*device-auth/i.test(output)) {
    return "This server's Codex CLI needs updating for browser sign-in. Run npm install -g @openai/codex@latest on the server, then try again.";
  }
  if (/device.{0,40}(disabled|not enabled|not allowed)|enable.{0,40}device/i.test(output)) {
    return "Enable device-code login in your ChatGPT security settings or ask your workspace admin to allow it, then try again.";
  }
  if (/expired|expiration|timed out/i.test(output)) {
    return "The ChatGPT sign-in code expired. Start sign-in again for a new code.";
  }
  return "Codex could not complete sign-in. Check the server's Codex login log for the cause, then try again.";
}

export const CODEX_DEVICE_SIGN_IN: DeviceSignIn = {
  provider: "codex",
  product: "Codex",
  account: "ChatGPT",
  authHost: "auth.openai.com",
  homeEnv: "CODEX_HOME",
  homeDir: ".codex",
  loginArgs: ["login", "--device-auth"],
  install: "Run npm install -g @openai/codex@latest on the server, then try again.",
  failure: loginFailure,
  status: {
    args: ["login", "status"],
    read: (code, output) =>
      code === 0 && /^logged in.*chatgpt\b/im.test(output) ? "signed-in"
      : code === 0 && /^logged in\b/im.test(output) ? "other"
      : code !== 0 && /^not logged in\b/im.test(output) ? "signed-out"
      : "unknown",
  },
  logoutArgs: ["logout"],
};

export class CodexDeviceAuthController extends DeviceAuthController {
  constructor(options: DeviceAuthOptions) { super(CODEX_DEVICE_SIGN_IN, options); }
}

export const CODEX_BROWSER_SIGN_IN: DeviceSignIn = {
  ...CODEX_DEVICE_SIGN_IN,
  loginArgs: ["login"],
  prompt: codexBrowserSignInPrompt,
  failure: (output) => /expired|expiration|timed out/i.test(output)
    ? "The ChatGPT browser sign-in expired. Start sign-in again."
    : "ChatGPT browser sign-in did not finish. Check the server's connection and try again.",
};

export class CodexBrowserAuthController extends DeviceAuthController {
  constructor(options: DeviceAuthOptions) { super(CODEX_BROWSER_SIGN_IN, options); }

  /** Finish a browser login opened on another computer. The authorization
   * URL came from this CLI; the pasted redirect must match its state exactly.
   * Forward only to the fixed local callback, never to a caller-selected host. */
  async complete(flowId: string, callbackUrl: string): Promise<void> {
    const status = await this.get(flowId);
    const authorizationUrl = codexBrowserSignInLink(status.authorizationUrl);
    const invalid = (message: string) => Object.assign(new Error(message), { status: 400 });
    if (status.phase !== "waiting" || !authorizationUrl) throw invalid("This browser sign-in has ended. Start a new sign-in.");
    if (callbackUrl.length > 8192) throw invalid("The callback URL is too long. Copy the address from the sign-in browser again.");
    let callback: URL;
    try { callback = new URL(callbackUrl.trim()); }
    catch { throw invalid("Paste the complete localhost callback URL from the sign-in browser."); }
    const expectedState = new URL(authorizationUrl).searchParams.get("state");
    const params = callback.searchParams;
    if (callback.origin !== "http://127.0.0.1:1455" || callback.pathname !== "/auth/callback" ||
        callback.username || callback.password || callback.hash ||
        params.getAll("code").length !== 1 || !params.get("code") ||
        params.getAll("state").length !== 1 || params.get("state") !== expectedState ||
        [...params.keys()].some((key) => key !== "code" && key !== "state")) {
      throw invalid("That callback does not match this sign-in. Copy the complete localhost address from the browser tab you opened here.");
    }
    let response: Response;
    try { response = await fetch(callback.href, { redirect: "manual", signal: AbortSignal.timeout(15_000) }); }
    catch { throw new Error("Codex's callback listener is unavailable on this server. Restart browser sign-in and try again."); }
    if (response.status < 200 || response.status >= 400) throw new Error("Codex did not accept the browser callback. Start a new sign-in.");
    for (let attempt = 0; attempt < 100; attempt++) {
      const current = await this.get(flowId);
      if (current.phase === "succeeded") return;
      if (current.phase !== "waiting") throw new Error(current.message ?? "Codex did not finish browser sign-in. Start a new sign-in.");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Codex is still finishing browser sign-in. Check its status in this browser.");
  }
}
