import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import { configureProviderAccount } from "./provider-account-setup.ts";
import { readQwenModelCatalog } from "./drivers/acp/qwen.ts";
import { hermesConfiguredModel } from "./drivers/acp/hermes.ts";
import { removeTempDir } from "./testing/cleanup.ts";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "hattera-account-")); });
afterEach(async () => { await removeTempDir(home); });

const input = { key: "fixture-private-key", url: "https://models.example.test/v1", model: "fixture-model" };
const entry = (driver: string) => ({ driver, environment: { HOME: home, USERPROFILE: home, HERMES_HOME: join(home, "hermes"), QWEN_HOME: join(home, "qwen"), PI_CODING_AGENT_DIR: join(home, "pi") } });

it("saves Cline's selected compatible provider and preserves other accounts", () => {
  const original = entry("clineAgent");
  const data = join(home, "cline-data");
  original.environment = { ...original.environment, CLINE_DATA_DIR: data } as typeof original.environment;
  mkdirSync(join(data, "settings"), { recursive: true });
  const path = join(data, "settings", "providers.json");
  writeFileSync(path, JSON.stringify({ version: 1, providers: { cline: { settings: { apiKey: "keep-me" } } } }));
  configureProviderAccount("cline", original, input);
  const saved = JSON.parse(readFileSync(path, "utf8"));
  expect(saved.lastUsedProvider).toBe("openai-compatible");
  expect(saved.providers.cline.settings.apiKey).toBe("keep-me");
  expect(saved.providers["openai-compatible"].settings).toMatchObject({ apiKey: input.key, model: input.model, baseUrl: input.url });
});

it.each([["cursorAgent", "CURSOR_API_KEY"], ["droidAgent", "FACTORY_API_KEY"], ["geminiAgent", "GEMINI_API_KEY"]])("configures %s through its own scoped key", (driver, variable) => {
  const original = entry(driver);
  const next = configureProviderAccount("fixture", original, { key: input.key });
  expect(next.environment?.[variable]).toBe(input.key);
  expect(original.environment).not.toHaveProperty(variable);
  expect(() => configureProviderAccount("fixture", original, { key: input.key, environment: { EVIL: "not allowed" } })).toThrow();
});

it("saves a Qwen model route that the real driver discovers, preserving unrelated routes", () => {
  const original = entry("qwenAgent");
  const path = join(home, ".qwen", "settings.json");
  mkdirSync(join(home, ".qwen"), { recursive: true });
  writeFileSync(path, JSON.stringify({ modelProviders: { anthropic: [{ id: "keep-me" }] } }));
  configureProviderAccount("qwen", original, input);
  expect(readQwenModelCatalog(original.environment).options.map(model => model.id)).toContain("fixture-model(openai)");
  const saved = JSON.parse(readFileSync(path, "utf8"));
  expect(saved.env.OPENMAUSBOT_QWEN_HATTERA_API_KEY).toBe(input.key);
  expect(saved.modelProviders.anthropic).toEqual([{ id: "keep-me" }]);
});

it("saves pi's native provider schema without changing other accounts", () => {
  configureProviderAccount("pi", entry("piAgent"), input);
  const saved = JSON.parse(readFileSync(join(home, "pi", "models.json"), "utf8"));
  expect(saved.providers.hattera).toMatchObject({ api: "openai-completions", apiKey: input.key, baseUrl: input.url, models: [{ id: input.model }] });
});

it("saves a Hermes route that its catalog can select", () => {
  const original = entry("hermesAgent");
  configureProviderAccount("hermes", original, input);
  expect(hermesConfiguredModel(original.environment)).toEqual({ id: "custom:hattera:fixture-model", label: "fixture-model", custom: true });
});

it("configures Bedrock's native endpoint with only the requested model and key", () => {
  const next = configureProviderAccount("bedrock", { driver: "openai-compat" }, { key: input.key, model: "us.anthropic.fixture-v1:0", region: "us-east-1" });
  expect(next.config).toMatchObject({ url: "https://bedrock-runtime.us-east-1.amazonaws.com", catalog: "bedrock", apiKeyEnv: "OMB_BEDROCK_API_KEY", key: input.key, model: "us.anthropic.fixture-v1:0" });
});

it("refuses insecure endpoints, unexpected providers and malformed existing settings", () => {
  expect(() => configureProviderAccount("pi", entry("piAgent"), { ...input, url: "http://external.example/v1" })).toThrow("HTTPS");
  expect(() => configureProviderAccount("custom", entry("customAcp"), input)).toThrow("own in-app");
  const path = join(home, ".qwen", "settings.json");
  mkdirSync(join(home, ".qwen"), { recursive: true });
  writeFileSync(path, '{"private":"existing-secret"');
  expect(() => configureProviderAccount("qwen", entry("qwenAgent"), input)).toThrow("could not be read");
  expect(readFileSync(path, "utf8")).toBe('{"private":"existing-secret"');
});
