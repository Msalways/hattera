// Claude's subscription allowance, behind the driver allowance capability.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  authRejected,
  addModelWindow,
  asRecord,
  closedWindow,
  couldNotReach,
  expiredCredential,
  extraLine,
  fetchJson,
  finiteNumber,
  isoOrNull,
  missingCredential,
  okRow,
  errorRow,
  openWindow,
  parseJson,
  planLabel,
  secretString,
  signInAgain,
  sortModelWindows,
  timeMs,
  unexpectedUsage,
  PROVIDER_TIMEOUT_MS,
  type AllowanceCapability,
  type CredentialSource,
  type PlanAccount,
  type PlanCredential,
  type PlanModelUsage,
  type PlanProviderRow,
  type PlanUsageDeps,
  type PlanWindow,
  type PlanWindows,
  type PlanExtra,
} from "../awareness/allowance-kit.ts";
import { resolveClaudeConfigDir } from "./claude.ts";

const KEYCHAIN_TIMEOUT_MS = 5_000;
const KEYCHAIN_MAX_BUFFER = 1_000_000;

const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

const CLAUDE_MODEL_FAMILIES = ["opus", "sonnet", "haiku"];

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

function claudeRoot(body: unknown): Record<string, unknown> | null {
  const root = asRecord(body);
  if (!root) return null;
  if ("five_hour" in root || "seven_day" in root) return root;
  const nested = asRecord(root.usage) ?? asRecord(root.windows);
  if (nested && ("five_hour" in nested || "seven_day" in nested)) return nested;
  return root;
}

function readClaudeWindow(value: unknown): PlanWindow | null {
  const record = asRecord(value);
  if (!record) return null;
  const utilization = finiteNumber(record.utilization);
  if (utilization == null) return null;
  return openWindow(utilization, isoOrNull(record.resets_at ?? record.resetsAt));
}

function claudeExtraLabel(key: string): string {
  const suffix = key.startsWith("seven_day_")
    ? key.slice("seven_day_".length)
    : key.replace(/^five_hour_/, "");
  return titleWords(suffix);
}

function titleWords(suffix: string): string {
  const words = suffix.split("_").filter((part) => part.length > 0);
  if (words.length === 0) return "Window";
  return words.map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()).join(" ");
}

/** Opus, Sonnet, and Haiku only. `seven_day_oauth_apps` and other windows stay extra lines. */
function claudeModelWindow(key: string): { name: string; window: string } | null {
  const weekly = key.startsWith("seven_day_");
  const fiveHour = key.startsWith("five_hour_");
  if (!weekly && !fiveHour) return null;
  const suffix = key.slice(weekly ? "seven_day_".length : "five_hour_".length);
  const lower = suffix.toLowerCase();
  const family = CLAUDE_MODEL_FAMILIES.find((name) => lower === name || lower.startsWith(`${name}_`));
  if (!family) return null;
  return { name: titleWords(suffix), window: weekly ? "Weekly" : "5-hour" };
}

export function parseClaudeUsage(body: unknown): PlanWindows {
  const root = claudeRoot(body);
  const extra: PlanExtra[] = [];
  const models: PlanModelUsage[] = [];
  if (root) {
    for (const [key, value] of Object.entries(root)) {
      if (key === "five_hour" || key === "seven_day") continue;
      if (!/^[a-z][a-z0-9_]{0,40}$/i.test(key)) continue;
      const window = readClaudeWindow(value);
      if (!window) continue;
      const model = claudeModelWindow(key);
      if (model) addModelWindow(models, model.name, extraLine(model.window, window));
      else extra.push(extraLine(claudeExtraLabel(key), window));
    }
  }
  sortModelWindows(models);
  return {
    plan: planLabel(root?.subscription_type ?? root?.plan ?? root?.plan_type),
    fiveHour: (root && readClaudeWindow(root.five_hour)) ?? closedWindow(),
    weekly: (root && readClaudeWindow(root.seven_day)) ?? closedWindow(),
    extra,
    models,
  };
}

function claudeCredentialFromText(text: string | null, now: number): PlanCredential {
  const oauth = asRecord(asRecord(parseJson(text))?.claudeAiOauth);
  const token = secretString(oauth?.accessToken);
  if (!token) return missingCredential();
  const expiry = timeMs(oauth?.expiresAt);
  if (expiry != null && expiry <= now) return expiredCredential();
  return { token, accountId: null, expired: false };
}

/** macOS 26 `security -w` may print the JSON secret as hex. */
function decodeKeychainSecret(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("{") && trimmed.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex").toString("utf8");
  }
  return trimmed;
}

function claudeKeychainServices(account: PlanAccount, env: NodeJS.ProcessEnv, resolvedDir: string): string[] {
  if (!account.configDir?.trim() && !env.CLAUDE_CONFIG_DIR?.trim()) return [CLAUDE_KEYCHAIN_SERVICE];
  let defaultDir: string | null = null;
  try {
    const withoutConfig = { ...env };
    delete withoutConfig.CLAUDE_CONFIG_DIR;
    defaultDir = resolveClaudeConfigDir(undefined, withoutConfig);
  } catch {
    defaultDir = null;
  }
  if (defaultDir != null && resolvedDir === defaultDir) return [CLAUDE_KEYCHAIN_SERVICE];
  const suffix = createHash("sha256").update(resolvedDir).digest("hex").slice(0, 8);
  return [`${CLAUDE_KEYCHAIN_SERVICE}-${suffix}`];
}

export function readDarwinClaudeKeychain(service: string): Promise<string | null> {
  if (process.platform !== "darwin") return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      execFile(
        "security",
        ["find-generic-password", "-s", service, "-w"],
        {
          timeout: KEYCHAIN_TIMEOUT_MS,
          maxBuffer: KEYCHAIN_MAX_BUFFER,
          windowsHide: true,
          shell: false,
          encoding: "utf8",
        },
        (error, stdout) => {
          resolve(error || !stdout ? null : stdout);
        },
      );
    } catch {
      resolve(null);
    }
  });
}

async function readClaudeCredential(
  account: PlanAccount,
  env: NodeJS.ProcessEnv,
  source: CredentialSource,
  now: number,
): Promise<PlanCredential> {
  let resolvedDir: string;
  try {
    resolvedDir = resolveClaudeConfigDir(account.configDir, env);
  } catch {
    return missingCredential();
  }
  const file = claudeCredentialFromText(source.readText(join(resolvedDir, ".credentials.json")), now);
  if (file.token || !source.readClaudeKeychain) return file;
  let sawExpired = file.expired;
  for (const service of claudeKeychainServices(account, env, resolvedDir)) {
    let raw: string | null = null;
    try {
      raw = (await source.readClaudeKeychain(service)) ?? null;
    } catch {
      raw = null;
    }
    const parsed = claudeCredentialFromText(decodeKeychainSecret(raw), now);
    if (parsed.token) return parsed;
    if (parsed.expired) sawExpired = true;
  }
  return sawExpired ? expiredCredential() : missingCredential();
}

async function fetchClaude(account: PlanAccount, token: string, deps: PlanUsageDeps): Promise<PlanProviderRow> {
  const result = await fetchJson(deps.fetch, CLAUDE_USAGE_URL, {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "anthropic-beta": "oauth-2025-04-20",
  }, deps.timeoutMs ?? PROVIDER_TIMEOUT_MS);
  if (authRejected(result.status)) return errorRow(account, signInAgain("Claude"));
  if (!result.ok || result.body === null || typeof result.body !== "object") {
    return errorRow(account, result.status === 0 || result.status >= 500 ? couldNotReach("Claude") : unexpectedUsage("Claude"));
  }
  return okRow(account, parseClaudeUsage(result.body));
}

export const claudeAllowance: AllowanceCapability = {
  id: "claude",
  product: "Claude",
  defaultSource: () => (process.platform === "darwin" ? { readClaudeKeychain: readDarwinClaudeKeychain } : {}),
  readCredential: (account, env, source, now) => readClaudeCredential(account, env, source, now),
  fetchUsage: (account, credential, deps) => fetchClaude(account, credential.token ?? "", deps),
};
