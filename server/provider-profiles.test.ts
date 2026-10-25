import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isolatedProfileEnvironment, newProviderProfile, PROFILE_DRIVERS, profileAccountForm } from "./provider-profiles.ts";
import { instanceConfigs, persistableInstanceConfigs, type AppConfig } from "./config.ts";
import { configureProviderAccount } from "./provider-account-setup.ts";
import { PROVIDER_KEY_ENV } from "../shared/provider-account-setup.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";

const homes: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(homes.splice(0).map(home => removeTempDir(home))); });
function temp() { const path = mkdtempSync(join(tmpdir(), "hattera-profiles-")); homes.push(path); return path; }

describe("independent provider profiles", () => {
  it("has an explicit isolation decision for every registered provider", () => {
    expect(BUILT_IN_DRIVERS.map(driver => driver.driverKind).filter(driver => !PROFILE_DRIVERS.has(driver))).toEqual(["customAcp"]);
  });
  it.each([...PROFILE_DRIVERS])("never copies credentials or an auth-selecting wrapper for %s", driver => {
    const entry = newProviderProfile({ driver, config: { cli: "node wrapper.mjs --config /other/account", key: "source-key", configDir: "/other", headers: { Authorization: "secret" }, fullAuto: true }, environment: { ANTHROPIC_API_KEY: "other-account" }, enabled: false }, "Work");
    expect(entry).toMatchObject({ driver, displayName: "Work", accountProfile: "isolated" });
    expect(entry.environment).toBeUndefined();
    expect(JSON.stringify(entry)).not.toMatch(/source-key|other-account|Authorization|fullAuto|\/other|wrapper/);
  });

  it("does not guess isolation for a custom ACP protocol", () => {
    expect(() => newProviderProfile({ driver: "customAcp" }, "Unknown")).toThrow(/does not support/);
  });

  it("keeps Bedrock routing and native ChatGPT-plan auth without copying its login", () => {
    const bedrock = newProviderProfile({ driver: "openai-compat", config: { catalog: "bedrock", url: "https://bedrock-runtime.eu-west-1.amazonaws.com", apiKeyEnv: "SECRET_KEY", model: "fixture", key: "secret" } }, "AWS");
    expect(profileAccountForm("account-new", bedrock)).toBe("bedrock");
    expect(bedrock.config).toMatchObject({ catalog: "bedrock", model: "fixture", key: "" });
    expect(newProviderProfile({ driver: "codex", config: { authMode: "chatgpt-plan" } }, "Personal").config).toEqual({ authMode: "chatgpt-plan" });
    expect(() => newProviderProfile({ driver: "openai-compat", config: { url: "https://example.test/v1?key=secret" } }, "Unsafe")).toThrow(/credentials/);
  });

  it("suppresses ambient credentials and state roots while admitting only this account's explicit key", () => {
    const env = isolatedProfileEnvironment(temp(), "account-a", { driver: "piAgent", environment: { OPENAI_API_KEY: "my-key" } },
      { NEW_VENDOR_API_KEY: "ambient", HOME: "/old", OPENCODE_CONFIG_CONTENT: "secret" }, ["ANTHROPIC_API_KEY"]);
    expect(env.OPENAI_API_KEY).toBe("my-key");
    expect(env.NEW_VENDOR_API_KEY).toBe("");
    expect(env.ANTHROPIC_API_KEY).toBe("");
    expect(env.OPENCODE_CONFIG_CONTENT).toBe("");
    expect(env.HOME).toContain("account-a");
    expect(env.USERPROFILE).toBe(env.HOME);
    expect(env.FACTORY_HOME_OVERRIDE).toBe(env.HOME);
    for (const key of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "CLINE_DIR", "KIMI_CODE_HOME", "PI_CODING_AGENT_DIR", "HERMES_HOME", "XDG_CONFIG_HOME"]) expect(env[key]).toContain("account-a");
  });

  it.each(["mistral", "minimax", "cerebras", "groq", "grok", "openai-compat", "claudeAgent", "opencodeGo"])("does not inherit workspace credentials for %s or persist derived environment", driver => {
    vi.stubEnv("OPENAI_COMPAT_API_KEY", "ambient-key");
    vi.stubEnv("MISTRAL_API_KEY", "ambient-mistral");
    const entry = newProviderProfile({ driver }, "A");
    const cfg = { instances: { "account-a": entry }, mistral: { key: "workspace-key" }, opencodeGo: { apiKey: "workspace-opencode" }, openaiCompat: { key: "workspace-compat", url: "https://workspace.test/v1" } } as AppConfig;
    const runtime = instanceConfigs(cfg)["account-a"];
    expect(runtime.environment?.MISTRAL_API_KEY).toBe("");
    expect(runtime.environment?.OPENAI_COMPAT_API_KEY).toBe("");
    expect(runtime.environment?.OPENCODE_API_KEY).toBe("");
    expect(JSON.stringify(runtime)).not.toMatch(/workspace-key|workspace-opencode|workspace-compat|workspace.test/);
    expect(persistableInstanceConfigs(cfg)["account-a"]).toEqual(entry);
  });

  it.each(Object.entries(PROVIDER_KEY_ENV))("saves a key only into the chosen %s profile", (driver, name) => {
    const entry = newProviderProfile({ driver }, "A");
    const saved = configureProviderAccount("account-a", entry, { key: "new-key" });
    expect(saved.environment).toEqual({ [name]: "new-key" });
    expect(entry.environment).toBeUndefined();
  });

  it.each(["clineAgent", "qwenAgent", "piAgent", "hermesAgent", "opencodeGo"])("writes %s native settings in the resolved account home without persisting derived paths", driver => {
    const root = temp();
    const entry = newProviderProfile({ driver }, "A");
    const env = isolatedProfileEnvironment(root, "account-a", entry, {}, []);
    const saved = configureProviderAccount("account-a", entry, { key: "private-key", url: "https://models.example.test/v1", model: "fixture-model" }, env);
    expect(saved.environment).toBeUndefined();
    const files: Record<string, string> = {
      clineAgent: join(env.CLINE_DATA_DIR, "settings", "providers.json"),
      qwenAgent: join(env.HOME, ".qwen", "settings.json"), piAgent: join(env.PI_CODING_AGENT_DIR, "models.json"),
      hermesAgent: join(env.HERMES_HOME, "config.yaml"), opencodeGo: join(env.XDG_CONFIG_HOME, "opencode", "opencode.json"),
    };
    expect(readFileSync(files[driver], "utf8")).toContain("private-key");
  });
});
