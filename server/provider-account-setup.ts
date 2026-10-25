import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { userHome, harnessHome } from "./env-path.ts";
import { managedHermesHome } from "./official-engine-install.ts";
import { PROVIDER_KEY_ENV } from "../shared/provider-account-setup.ts";
import { profileAccountForm } from "./provider-profiles.ts";
import type { InstanceConfigMap } from "./contracts.ts";
import { clineProviderSettingsPath } from "./drivers/acp/cline.ts";

export const providerAccountInput = z.object({
  key: z.string().trim().min(1).max(8192),
  url: z.string().trim().max(2048).optional(),
  model: z.string().trim().min(1).max(256).regex(/^[^\r\n]+$/).optional(),
  region: z.string().trim().regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/).optional(),
}).strict();

function record(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The existing provider settings are malformed. Repair them before changing this account.");
  return value as Record<string, any>;
}

function document(path: string, yaml = false): Record<string, any> {
  if (!existsSync(path)) return {};
  try {
    const text = readFileSync(path, "utf8");
    return record(yaml ? parseYaml(text) : JSON.parse(text));
  } catch { throw new Error("The existing provider settings could not be read. Repair them before changing this account."); }
}

function save(path: string, value: unknown, yaml = false): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileAtomic(path, yaml ? stringifyYaml(value) : JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}

/** Fixed vendor settings, using the same home as the instance's chat process. */
export function configureProviderAccount(instanceId: string, entry: InstanceConfigMap[string], raw: unknown,
  resolvedEnvironment?: Record<string, string | undefined>): InstanceConfigMap[string] {
  const form = profileAccountForm(instanceId, entry);
  if (!form) throw new Error("This provider uses its own in-app sign-in or API-key settings.");
  const input = providerAccountInput.parse(raw);
  const next = structuredClone(entry);
  if (form === "key") {
    const name = entry.driver === "claudeAgent" ? "ANTHROPIC_API_KEY" : PROVIDER_KEY_ENV[entry.driver];
    if (!name) throw new Error("This provider has no API-key account form.");
    next.environment = { ...next.environment, [name]: input.key };
    return next;
  }
  if (!input.model) throw new Error("Enter the model or inference profile ID.");
  if (form === "bedrock") {
    if (!input.region) throw new Error("Enter the AWS region for this model.");
    next.config = { ...next.config as object, key: input.key, model: input.model, catalog: "bedrock",
      url: `https://bedrock-runtime.${input.region}.amazonaws.com`, apiKeyEnv: "OMB_BEDROCK_API_KEY" };
    return next;
  }
  const url = new URL(input.url ?? "");
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) {
    throw new Error("Use an HTTPS provider URL, or HTTP for a local model server.");
  }
  const baseUrl = url.href.replace(/\/+$/, "");
  if (entry.driver === "openai-compat") {
    next.config = { ...next.config as object, url: baseUrl, model: input.model, key: input.key, provider: "" };
    return next;
  }
  const env = { ...process.env, ...(resolvedEnvironment ?? entry.environment) };
  if (entry.driver === "clineAgent") {
    const config = entry.config as { cli?: string } | undefined;
    const path = clineProviderSettingsPath(env, { cli: config?.cli || "cline", fullAuto: false });
    const settings = document(path);
    if (settings.version !== undefined && settings.version !== 1) throw new Error("This Cline settings version is unsupported. Update Cline before changing this account.");
    settings.version = 1;
    settings.providers = { ...record(settings.providers ?? {}), "openai-compatible": { settings: {
      provider: "openai-compatible", model: input.model, apiKey: input.key, baseUrl,
    } } };
    settings.lastUsedProvider = "openai-compatible";
    save(path, settings);
  } else if (entry.driver === "opencodeGo") {
    const path = join(env.XDG_CONFIG_HOME || join(userHome(env), ".config"), "opencode", "opencode.json");
    const settings = document(path);
    settings.provider = { ...record(settings.provider ?? {}), hattera: {
      npm: "@ai-sdk/openai-compatible", name: "Hattera account", options: { baseURL: baseUrl, apiKey: input.key },
      models: { [input.model]: { name: input.model } },
    } };
    settings.model = `hattera/${input.model}`;
    save(path, settings);
  } else if (entry.driver === "qwenAgent") {
    const path = join(harnessHome("qwen", env), "settings.json");
    const settings = document(path);
    settings.env = { ...settings.env, OPENMAUSBOT_QWEN_HATTERA_API_KEY: input.key };
    const providers = record(settings.modelProviders ?? {});
    const rows = providers.openai ?? [];
    if (!Array.isArray(rows)) throw new Error("The existing Qwen provider list is malformed.");
    providers.openai = [...rows.filter(row => row?.envKey !== "OPENMAUSBOT_QWEN_HATTERA_API_KEY"),
      { id: input.model, name: input.model, baseUrl, envKey: "OPENMAUSBOT_QWEN_HATTERA_API_KEY" }];
    settings.modelProviders = providers;
    settings.security = { ...settings.security, auth: { ...settings.security?.auth, selectedType: "openai" } };
    save(path, settings);
  } else if (entry.driver === "piAgent") {
    const path = join(env.PI_CODING_AGENT_DIR || join(userHome(env), ".pi", "agent"), "models.json");
    const settings = document(path);
    settings.providers = { ...record(settings.providers ?? {}), hattera: { baseUrl, api: "openai-completions", apiKey: input.key,
      models: [{ id: input.model, name: input.model, input: ["text"], contextWindow: 131072, maxTokens: 16384 }] } };
    save(path, settings);
  } else if (entry.driver === "hermesAgent") {
    const path = join(env.HERMES_HOME || managedHermesHome() || harnessHome("hermes", env), "config.yaml");
    const settings = document(path, true);
    settings.providers = { ...record(settings.providers ?? {}), hattera: { base_url: baseUrl, api_key: input.key } };
    settings.model = { provider: "custom:hattera", default: input.model };
    save(path, settings, true);
  }
  return next;
}
