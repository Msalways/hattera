// Subscription allowance for the engines Hattera already signs in. Which
// drivers report allowance is not decided here: a driver exports an optional
// `allowance` capability and this module discovers it. Parsers are pure. The
// fetcher takes fetch and a credential reader so tests never touch the network
// or a real login file. Access tokens stay in the request header only — never
// in the JSON result.
import { readFileSync, statSync } from "node:fs";
import {
  CREDENTIAL_READ_MAX_BYTES,
  asRecord,
  couldNotReach,
  errorRow,
  signInAgain,
  type AllowanceCapability,
  type AllowanceRegistry,
  type CredentialReader,
  type CredentialSource as KitCredentialSource,
  type PlanAccount,
  type PlanCredential,
  type PlanFetch,
  type PlanProviderRow,
  type PlanUsageDeps,
  type PlanUsageReport,
} from "./awareness/allowance-kit.ts";
import type { AnyProviderDriver, InstanceConfigMap } from "./contracts.ts";
import { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";

export type {
  AllowanceCapability, AllowanceRegistry, CredentialReader, PlanAccount, PlanCredential, PlanExtra, PlanFetch,
  PlanModelUsage, PlanProviderRow, PlanResponse, PlanUsageDeps, PlanUsageReport, PlanWindow, PlanWindows,
} from "./awareness/allowance-kit.ts";
import type { ClaudeKeychainReader } from "./drivers/claude-allowance.ts";
export { parseClaudeUsage } from "./drivers/claude-allowance.ts";

/** The credential source plan-usage callers pass: the generic facilities plus the
 * Claude keychain reader, which lives with the Claude driver, not in awareness. */
export type CredentialSource = KitCredentialSource & { readClaudeKeychain?: ClaudeKeychainReader };
export { parseCodexUsage } from "./drivers/codex-allowance.ts";
export { parseGrokUsage } from "./drivers/acp/grok-allowance.ts";

/** A driver id as carried on accounts and rows. Any driver that exports an
 * allowance capability may introduce one. */
export type PlanDriver = string;

export function allowanceRegistry(drivers: readonly AnyProviderDriver[] = BUILT_IN_DRIVERS): AllowanceRegistry {
  const registry = new Map<string, AllowanceCapability>();
  for (const driver of drivers) {
    const capability = driver.allowance;
    if (capability) registry.set(driver.driverKind, capability);
  }
  return registry;
}

const PLAN_USAGE_CACHE_MS = 45_000;

export function planAccountsFromInstances(
  instances: InstanceConfigMap,
  registry: AllowanceRegistry = allowanceRegistry(),
): PlanAccount[] {
  const accounts: PlanAccount[] = [];
  for (const [id, entry] of Object.entries(instances)) {
    const capability = registry.get(entry.driver);
    if (!capability) continue;
    const config = asRecord(entry.config);
    const configDir = typeof config?.configDir === "string" ? config.configDir : undefined;
    accounts.push({
      id,
      name: entry.displayName?.trim() || capability.product,
      driver: capability.id,
      environment: { ...entry.environment },
      ...(configDir ? { configDir } : {}),
    });
  }
  return accounts;
}

function capabilityById(registry: AllowanceRegistry, id: string): AllowanceCapability | undefined {
  for (const capability of registry.values()) if (capability.id === id) return capability;
  return undefined;
}

export function fileCredentialReader(
  source: CredentialSource,
  registry: AllowanceRegistry = allowanceRegistry(),
): CredentialReader {
  const env = source.env ?? process.env;
  const now = source.now ?? Date.now;
  return {
    async read(account) {
      const capability = capabilityById(registry, account.driver);
      if (!capability) return { token: null, accountId: null, expired: false };
      const merged: NodeJS.ProcessEnv = { ...env, ...account.environment };
      return capability.readCredential(account, merged, source, now());
    },
  };
}

export function defaultCredentialReader(
  env: NodeJS.ProcessEnv = process.env,
  registry: AllowanceRegistry = allowanceRegistry(),
): CredentialReader {
  const extras: Partial<CredentialSource> = {};
  for (const capability of registry.values()) Object.assign(extras, capability.defaultSource?.());
  return fileCredentialReader({
    env,
    readText(path) {
      try {
        const stat = statSync(path);
        if (!stat.isFile() || stat.size > CREDENTIAL_READ_MAX_BYTES) return null;
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    ...extras,
  }, registry);
}

export async function fetchPlanUsage(accounts: PlanAccount[], deps: PlanUsageDeps): Promise<PlanUsageReport> {
  const now = deps.now?.() ?? Date.now();
  const registry = deps.capabilities ?? allowanceRegistry();
  const providers = await Promise.all(accounts.map((account) => fetchProvider(account, deps, registry)));
  return { fetchedAt: new Date(now).toISOString(), providers };
}

let cachedReport: { at: number; key: string; report: PlanUsageReport } | null = null;

export function clearPlanUsageCache(): void {
  cachedReport = null;
}

export async function loadPlanUsage(input: {
  accounts: PlanAccount[];
  refresh?: boolean;
  now?: number;
  fetch?: PlanFetch;
  credentials?: CredentialReader;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<PlanUsageReport> {
  const now = input.now ?? Date.now();
  const key = planUsageCacheKey(input.accounts);
  if (!input.refresh && cachedReport && cachedReport.key === key && now - cachedReport.at < PLAN_USAGE_CACHE_MS) {
    return cachedReport.report;
  }
  const report = await fetchPlanUsage(input.accounts, {
    fetch: input.fetch ?? ((url, init) => globalThis.fetch(url, init)),
    credentials: input.credentials ?? defaultCredentialReader(input.env),
    now: () => now,
    timeoutMs: input.timeoutMs,
  });
  cachedReport = { at: now, key, report };
  return report;
}

function planUsageCacheKey(accounts: PlanAccount[]): string {
  return accounts.map((account) => {
    const environment = Object.entries(account.environment)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([name, value]) => `${name}=${value}`)
      .join("\n");
    return [account.id, account.driver, account.name, account.configDir ?? "", environment].join("\u0000");
  }).join("\n");
}

async function fetchProvider(
  account: PlanAccount,
  deps: PlanUsageDeps,
  registry: AllowanceRegistry,
): Promise<PlanProviderRow> {
  const capability = capabilityById(registry, account.driver);
  if (!capability) return errorRow(account, couldNotReach(account.name));
  const product = capability.product;
  let credential: PlanCredential;
  try {
    credential = await deps.credentials.read(account);
  } catch {
    return errorRow(account, signInAgain(product));
  }
  if (credential.expired || !credential.token) return errorRow(account, signInAgain(product));
  try {
    return await capability.fetchUsage(account, credential, deps);
  } catch {
    return errorRow(account, couldNotReach(product));
  }
}
