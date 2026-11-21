// Codex's subscription allowance, behind the driver allowance capability.
import { join } from "node:path";
import {
  authRejected,
  addModelWindow,
  asRecord,
  assignDurationWindows,
  couldNotReach,
  durationWindows,
  expiredCredential,
  fetchJson,
  missingCredential,
  okRow,
  errorRow,
  parseJson,
  planLabel,
  pushAssignedLines,
  secretString,
  signInAgain,
  sortModelWindows,
  timeMs,
  unexpectedUsage,
  PROVIDER_TIMEOUT_MS,
  type AllowanceCapability,
  type PlanAccount,
  type PlanCredential,
  type PlanModelUsage,
  type PlanProviderRow,
  type PlanUsageDeps,
  type PlanWindows,
  type PlanExtra,
} from "../awareness/allowance-kit.ts";
import { codexHome } from "./codex-identity.ts";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

function codexLimitName(record: Record<string, unknown>): string | null {
  return planLabel(record.limit_name) ?? planLabel(record.metered_feature) ?? planLabel(record.name);
}

function collectCodexNamedLimits(root: Record<string, unknown>, models: PlanModelUsage[], extra: PlanExtra[]): void {
  const buckets: Array<{ name: string | null; node: unknown }> = [];
  if (root.code_review_rate_limit) buckets.push({ name: "Code review", node: root.code_review_rate_limit });
  const additional = root.additional_rate_limits;
  if (Array.isArray(additional)) {
    for (const item of additional) {
      const record = asRecord(item);
      buckets.push({ name: record ? codexLimitName(record) : null, node: item });
    }
  } else {
    const named = asRecord(additional);
    if (named) {
      for (const [key, value] of Object.entries(named)) buckets.push({ name: planLabel(key), node: value });
    }
  }
  for (const bucket of buckets) {
    const assigned = assignDurationWindows(durationWindows(bucket.node));
    if (!bucket.name) {
      pushAssignedLines(assigned, extra);
      continue;
    }
    const lines: PlanExtra[] = [];
    pushAssignedLines(assigned, lines);
    for (const line of lines) addModelWindow(models, bucket.name, line);
  }
}

export function parseCodexUsage(body: unknown): PlanWindows {
  const root = asRecord(body);
  const assigned = assignDurationWindows(durationWindows(root?.rate_limit));
  const models: PlanModelUsage[] = [];
  const extra = [...assigned.extra];
  if (root) collectCodexNamedLimits(root, models, extra);
  sortModelWindows(models);
  return { ...assigned, extra, models, plan: planLabel(root?.plan_type ?? root?.plan) };
}

function readCodexCredential(
  env: NodeJS.ProcessEnv,
  readText: (path: string) => string | null,
  now: number,
): PlanCredential {
  const home = codexHome(env);
  if (!home) return missingCredential();
  const root = asRecord(parseJson(readText(join(home, "auth.json"))));
  if (!root) return missingCredential();
  const tokens = asRecord(root.tokens);
  const token = secretString(tokens?.access_token) ?? secretString(root.access_token);
  if (!token) return missingCredential();
  const expiry = timeMs(tokens?.expires_at ?? tokens?.expiresAt ?? root.expires_at ?? root.expiresAt);
  if (expiry != null && expiry <= now) return expiredCredential();
  const accountId = secretString(tokens?.account_id) ?? secretString(root.account_id);
  return { token, accountId, expired: false };
}

async function fetchCodex(
  account: PlanAccount,
  token: string,
  accountId: string | null,
  deps: PlanUsageDeps,
): Promise<PlanProviderRow> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  if (accountId) headers["ChatGPT-Account-Id"] = accountId;
  const result = await fetchJson(deps.fetch, CODEX_USAGE_URL, headers, deps.timeoutMs ?? PROVIDER_TIMEOUT_MS);
  if (authRejected(result.status)) return errorRow(account, signInAgain("Codex"));
  if (!result.ok || result.body === null || typeof result.body !== "object") {
    return errorRow(account, result.status === 0 || result.status >= 500 ? couldNotReach("Codex") : unexpectedUsage("Codex"));
  }
  return okRow(account, parseCodexUsage(result.body));
}

export const codexAllowance: AllowanceCapability = {
  id: "codex",
  product: "Codex",
  readCredential: (_account, env, source, now) => readCodexCredential(env, source.readText, now),
  fetchUsage: (account, credential, deps) => fetchCodex(account, credential.token ?? "", credential.accountId, deps),
};
