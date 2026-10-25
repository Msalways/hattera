// Where a person enters the one-time code that signs an engine's CLI in on
// the machine running Hattera (`codex login --device-auth`, `grok login
// --device-auth`). The server reads the page and the code from the CLI's
// output with these rules, and the app checks them again before it shows a
// link. Neither ever turns arbitrary output into a link, or lets a token ride
// along in one.

export type DeviceSignInProvider = "codex" | "grok" | "cline" | "kimi" | "cursor";

export function cursorBrowserSignInLink(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const allowed = ["challenge", "uuid", "mode", "redirectTarget", "supportsSelectedTeamLogin"];
    return url.origin === "https://cursor.com" && url.pathname === "/loginDeepControl" &&
      !url.username && !url.password && !url.hash &&
      [...url.searchParams.keys()].every(key => allowed.includes(key) && url.searchParams.getAll(key).length === 1) &&
      /^[A-Za-z0-9_-]{32,128}$/.test(url.searchParams.get("challenge") ?? "") &&
      /^[0-9a-f-]{36}$/i.test(url.searchParams.get("uuid") ?? "") &&
      url.searchParams.get("mode") === "login" && url.searchParams.get("redirectTarget") === "cli" &&
      (!url.searchParams.has("supportsSelectedTeamLogin") || ["true", "false"].includes(url.searchParams.get("supportsSelectedTeamLogin")!)) ? url.href : null;
  } catch { return null; }
}

export function cursorBrowserSignInPrompt(text: string): { authorizationUrl: string } | null {
  for (const line of text.split(/\r?\n/).slice(0, -1)) {
    const authorizationUrl = cursorBrowserSignInLink(line.trim().replace(/^Open a browser and navigate to this link:\s*/, ""));
    if (authorizationUrl) return { authorizationUrl };
  }
  return null;
}

const CODEX_PAGE = "https://auth.openai.com/codex/device";

/** Codex CLI's local browser callback. Only the official authorization
 * endpoint and the CLI's loopback callback may be opened by the app. */
export function codexBrowserSignInLink(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const callback = new URL(url.searchParams.get("redirect_uri") ?? "");
    const required = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state"];
    return url.origin === "https://auth.openai.com" && url.pathname === "/oauth/authorize" &&
      !url.username && !url.password && !url.hash &&
      required.every((key) => url.searchParams.getAll(key).length === 1) &&
      url.searchParams.get("response_type") === "code" &&
      url.searchParams.get("code_challenge_method") === "S256" &&
      /^[A-Za-z0-9_-]+$/.test(url.searchParams.get("client_id") ?? "") &&
      /^[A-Za-z0-9_-]+$/.test(url.searchParams.get("code_challenge") ?? "") &&
      /^[A-Za-z0-9_-]+$/.test(url.searchParams.get("state") ?? "") &&
      callback.origin === "http://127.0.0.1:1455" && callback.pathname === "/auth/callback" &&
      !callback.username && !callback.password && !callback.search && !callback.hash ? url.href : null;
  } catch { return null; }
}

/** Read only a complete CLI output line; chunks can end midway through a URL. */
export function codexBrowserSignInPrompt(text: string): { authorizationUrl: string } | null {
  for (const line of text.split(/\r?\n/).slice(0, -1)) {
    const authorizationUrl = codexBrowserSignInLink(line.trim());
    if (authorizationUrl) return { authorizationUrl };
  }
  return null;
}

const RULES: Record<DeviceSignInProvider, { page(value: string): string | null; code: RegExp }> = {
  cursor: { page: value => cursorBrowserSignInLink(value), code: /^$/ },
  kimi: {
    page: (value) => {
      let url: URL;
      try { url = new URL(value); } catch { return null; }
      return ["https://www.kimi.com", "https://www.kimi.ai"].includes(url.origin) && url.pathname === "/code/authorize_device" &&
        !url.username && !url.password && !url.hash && url.searchParams.getAll("user_code").length === 1 &&
        [...url.searchParams.keys()].every(key => key === "user_code") ? url.href : null;
    },
    code: /^[A-Z0-9]{4}-[A-Z0-9]{4}$/,
  },
  codex: {
    page: (value) => (/^https:\/\/auth\.openai\.com\/codex\/device\/?$/.test(value) ? CODEX_PAGE : null),
    code: /^[A-Z0-9]{4,8}-[A-Z0-9]{4,8}$/,
  },
  grok: {
    // xAI's own sign-in hosts. The page may carry the code itself (the
    // provider's "complete" link); nothing else may ride in its query.
    page: (value) => {
      if (!/^https:\/\/[^\s#]+$/.test(value)) return null;
      let url: URL;
      try { url = new URL(value); } catch { return null; }
      if (url.username || url.password || url.port || !/(^|\.)(x\.ai|grok\.com)$/.test(url.hostname)) return null;
      return [...url.searchParams.keys()].every((key) => key === "user_code") ? url.href : null;
    },
    code: /^[A-Z0-9]{4,12}(?:-[A-Z0-9]{2,12}){0,3}$/,
  },
  cline: {
    page: (value) => {
      let url: URL;
      try { url = new URL(value); } catch { return null; }
      return url.origin === "https://authkit.cline.bot" && url.pathname === "/device" &&
        !url.username && !url.password && !url.hash &&
        url.searchParams.getAll("user_code").length === 1 &&
        [...url.searchParams.keys()].every((key) => key === "user_code") ? url.href : null;
    },
    code: /^[A-Z0-9]{4}-[A-Z0-9]{4}$/,
  },
};

/** The provider's own page for entering `userCode`, or null for anything
 * else. A code carried in the page's link must be that same code. */
export function deviceSignInLink(provider: DeviceSignInProvider, value: string | null | undefined, userCode?: string): string | null {
  const page = value ? RULES[provider].page(value) : null;
  if (!page) return null;
  return [...new URL(page).searchParams.values()].every((carried) => carried === userCode) ? page : null;
}

/** A one-time code as this provider formats it. */
export function isDeviceSignInCode(provider: DeviceSignInProvider, value: string | null | undefined): value is string {
  return typeof value === "string" && RULES[provider].code.test(value);
}

/** The page and the code from a CLI's output, once both lines have arrived
 * whole: output arrives in chunks that may stop halfway through a code, so
 * the last, unfinished line is never read. `text` is already free of
 * terminal styling. */
export function deviceSignInPrompt(provider: DeviceSignInProvider, text: string): { authorizationUrl: string; userCode: string } | null {
  const lines = text.split(/\r?\n/).slice(0, -1).map((line) => line.trim());
  if (provider === "cline" || provider === "kimi") {
    for (const line of lines) {
      const candidate = provider === "cline" ? line.replace(/^\[auth\]\s*/, "") : line.replace(/^Opening browser for Kimi device login:\s*/, "");
      const page = RULES[provider].page(candidate);
      const userCode = page ? new URL(page).searchParams.get("user_code") : null;
      if (page && isDeviceSignInCode(provider, userCode)) return { authorizationUrl: page, userCode };
    }
    return null;
  }
  const at = lines.findIndex((line) => RULES[provider].page(line) !== null);
  if (at < 0) return null;
  const userCode = lines.slice(at + 1).map((line) => line.replace(/^code:\s*/i, "")).find((line) => isDeviceSignInCode(provider, line));
  const authorizationUrl = userCode ? deviceSignInLink(provider, lines[at], userCode) : null;
  return authorizationUrl && userCode ? { authorizationUrl, userCode } : null;
}
