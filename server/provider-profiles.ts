import { existsSync } from "node:fs";
import { join } from "node:path";
import type { InstanceConfig } from "./contracts.ts";
import { PROVIDER_KEY_ENV, providerAccountForm, type ProviderAccountForm } from "../shared/provider-account-setup.ts";

/** This list describes account isolation, not login or quota support. */
export const PROFILE_DRIVERS = new Set([
  "claudeAgent", "codex", "antigravityAgent", "grokAgent", "kimiAgent", "droidAgent",
  "cursorAgent", "geminiAgent", "opencodeGo", "qwenAgent", "hermesAgent", "clineAgent", "piAgent",
  "openai-compat", "grok", "mistral", "minimax", "cerebras", "groq",
]);

export function profileConfig(entry: InstanceConfig): Record<string, unknown> {
  return entry.config && typeof entry.config === "object" && !Array.isArray(entry.config)
    ? entry.config as Record<string, unknown> : {};
}

export function profileAccountForm(id: string, entry: InstanceConfig): ProviderAccountForm | null {
  if (entry.accountProfile === "isolated") {
    if (entry.driver === "openai-compat") return profileConfig(entry).catalog === "bedrock" ? "bedrock" : "model";
    if (PROVIDER_KEY_ENV[entry.driver] || entry.driver === "claudeAgent" && profileConfig(entry).requireApiKey) return "key";
    if (entry.driver === "opencodeGo") return "model";
  }
  return providerAccountForm(entry.driver, id);
}

export function publicAccountSetup(id: string, entry: InstanceConfig) {
  const form = profileAccountForm(id, entry);
  if (!form) return undefined;
  const raw = profileConfig(entry);
  let url: string | undefined;
  try {
    const parsed = new URL(typeof raw.url === "string" ? raw.url : "");
    if (!parsed.username && !parsed.password && !parsed.search && !parsed.hash) url = parsed.href;
  } catch { /* Missing or credential-bearing routes are never echoed. */ }
  const region = form === "bedrock" ? /^https:\/\/bedrock-runtime\.([a-z0-9-]+)\.amazonaws\.com\/?$/.exec(url ?? "")?.[1] : undefined;
  return { form, ...(typeof raw.model === "string" ? { model: raw.model } : {}), ...(url ? { url } : {}), ...(region ? { region } : {}) };
}

/** Generate a new identity. Never clone keys, login files, custom headers, or
 * command arguments (which may select a different credential directory). */
export function newProviderProfile(source: InstanceConfig, displayName: string): InstanceConfig {
  if (!PROFILE_DRIVERS.has(source.driver)) throw new Error("This provider does not support separate account profiles.");
  const raw = profileConfig(source);
  const config: Record<string, unknown> = {};
  for (const key of ["url", "model", "catalog", "provider", "authMode", "requireApiKey", "tools"]) {
    if (raw[key] !== undefined) config[key] = raw[key];
  }
  if (typeof config.url === "string") {
    const url = new URL(config.url);
    if (url.username || url.password || url.search || url.hash) throw new Error("Remove credentials and query parameters from the provider URL before adding an account.");
  }
  // Native executables can be shared, but a wrapper's arguments may carry auth.
  if (typeof raw.cli === "string" && (/^[\w.-]+$/.test(raw.cli) || existsSync(raw.cli))) config.cli = raw.cli;
  if (source.driver === "openai-compat") { config.key = ""; config.provider ??= ""; }
  return { driver: source.driver, displayName, accountProfile: "isolated", config,
    ...(source.access ? { access: source.access } : {}), ...(source.icon ? { icon: source.icon } : {}) };
}

/** Recomputed on every config read, so newly introduced ambient credentials do
 * not become credentials of an existing private profile. Empty env values
 * deliberately suppress drivers' nullish fallbacks to process.env. */
export function isolatedProfileEnvironment(dataDir: string, id: string, entry: InstanceConfig,
  ambient: NodeJS.ProcessEnv, credentialNames: readonly string[]): Record<string, string> {
  const root = join(dataDir, "providers", "accounts", id);
  const home = join(root, "home");
  const env: Record<string, string> = {};
  const extra = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS",
    "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_OAUTH_SCOPES",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
    "OPENAI_BASE_URL", "OPENAI_COMPAT_URL", "OPENAI_COMPAT_MODEL", "OPENAI_COMPAT_PROVIDER",
    "OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG_DIR", "GEMINI_CLI_HOME",
    "CLINE_PROVIDER_SETTINGS_PATH", "CLINE_MCP_SETTINGS_PATH", "CLINE_PROVIDER", "CLINE_MODEL",
    "GROK_CONFIG", "GROK_CONFIG_PATH", "GROK_AGENT", "KIMI_MODEL_BASE_URL", "KIMI_MODEL_NAME",
    "KIMI_MODEL_DISPLAY_NAME", "KIMI_MODEL_PROVIDER_TYPE",
    "KIMI_CODE_BASE_URL", "KIMI_CODE_OAUTH_HOST", "KIMI_OAUTH_HOST",
    "GOOGLE_APPLICATION_CREDENTIALS", "AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_CONFIG_FILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
    "QWEN_RUNTIME_DIR", "QWEN_HOME", "CURSOR_CONFIG_DIR"];
  for (const name of new Set([...credentialNames, ...extra, ...Object.keys(ambient).filter(name =>
    /(?:_API_KEY|_AUTH_TOKEN|_ACCESS_TOKEN|_REFRESH_TOKEN)$/.test(name.toUpperCase()))])) env[name] = "";
  // All native state roots use the same profile in auth, model discovery and turns.
  Object.assign(env, {
    HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"), XDG_STATE_HOME: join(home, ".local", "state"),
    CODEX_HOME: join(root, "codex"), CLAUDE_CONFIG_DIR: join(root, "claude"),
    KIMI_CODE_HOME: join(home, ".kimi-code"), GROK_HOME: join(home, ".grok"),
    FACTORY_HOME_OVERRIDE: home, CLINE_DIR: join(home, ".cline"), CLINE_DATA_DIR: join(home, ".cline", "data"),
    HERMES_HOME: join(home, ".hermes"), PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
  });
  // Explicit keys saved for this account are admitted; another account's are not.
  return { ...env, ...entry.environment };
}
