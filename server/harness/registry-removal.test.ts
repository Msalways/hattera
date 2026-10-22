import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ProviderRegistry } from "./registry.ts";
import { makeFakeDriver } from "../testing/fake-driver.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { engineRemoved } from "../engine-removal.ts";

const scratch: string[] = [];
function setup() {
  const base = mkdtempSync(join(tmpdir(), "hattera-runtime-registry-")); scratch.push(base);
  const fake = makeFakeDriver({ kind: "antigravityAgent" });
  Object.assign(fake.driver, { install: { managed: { label: "Install", downloadBytes: 1 } } });
  const create = fake.driver.create.bind(fake.driver);
  let failInstall = false;
  fake.driver.create = async input => {
    const instance = await create(input);
    return { ...instance, installRuntime: async () => {
      if (failInstall) throw new Error("fixture download failed");
      mkdirSync(join(base, "tools", "antigravity-acp", `${process.platform}-${process.arch}`), { recursive: true });
    } };
  };
  const registry = new ProviderRegistry([fake.driver], { enginesBaseDir: base });
  const configs = { a: { driver: "antigravityAgent", config: { cli: "/external/fixture" }, environment: { SECRET: "keep" } },
    b: { driver: "antigravityAgent", enabled: false, access: "api" as const } };
  return { base, fake, registry, configs, fail: () => { failInstall = true; } };
}
afterEach(async () => { for (const path of scratch.splice(0)) await removeTempDir(path); });

it("disables every account sharing a runtime, survives restart, and requires explicit restore", async () => {
  const { base, fake, registry, configs } = setup();
  await registry.load(configs);
  expect(registry.runtimeInstanceIds("a")).toEqual(["a", "b"]);
  expect(await registry.removeRuntime("a")).toBe(true);
  expect(fake.disposed).toEqual(expect.arrayContaining(["a", "b"]));
  expect(registry.instances()).toHaveLength(0);
  for (const item of await registry.describe()) {
    expect(item.snapshot.state).toBe("unavailable");
    expect(item.models.options).toEqual([]);
    expect(item.runtimeRemoval).toMatchObject({ removed: true, managed: false, accounts: 2 });
  }
  const restarted = new ProviderRegistry([fake.driver], { enginesBaseDir: base });
  await restarted.load(configs);
  expect(restarted.instances()).toHaveLength(0);
  expect(await restarted.restoreRuntime("b")).toBe(true);
  expect(restarted.instances()).toHaveLength(2);
  expect(restarted.access("b")).toBe("api");
  expect(fake.decodedConfigs.at(-1)).toEqual(configs.a.config);
  await restarted.disposeAll();
});

it("reinstalls a removed managed runtime, reloads all aliases, and preserves account data", async () => {
  const { base, registry, configs } = setup();
  const credential = join(base, "account-token.json"); writeFileSync(credential, "private-fixture");
  await registry.load(configs);
  await registry.installRuntime("a");
  const runtimeRoot = join(base, "tools", "antigravity-acp", `${process.platform}-${process.arch}`);
  expect(existsSync(runtimeRoot)).toBe(true);
  await registry.removeRuntime("b");
  expect(existsSync(runtimeRoot)).toBe(false);
  expect(await registry.installRuntime("a")).toBe(true);
  expect(existsSync(runtimeRoot)).toBe(true);
  expect(engineRemoved({ key: "antigravity", managed: true }, base)).toBe(false);
  expect(registry.instances()).toHaveLength(2);
  expect(readFileSync(credential, "utf8")).toBe("private-fixture");
  await registry.disposeAll();
});

it("keeps a removed runtime disabled when reinstall fails", async () => {
  const { base, registry, configs, fail } = setup();
  await registry.load(configs); await registry.removeRuntime("a"); fail();
  await expect(registry.installRuntime("a")).rejects.toThrow("fixture download failed");
  expect(engineRemoved({ key: "antigravity", managed: true }, base)).toBe(true);
  expect(registry.instances()).toHaveLength(0);
});

it("keeps software files when the running engine cannot stop safely", async () => {
  const { base, registry, configs } = setup();
  await registry.load(configs); await registry.installRuntime("a");
  const old = registry.get("a")!;
  old.dispose = async () => { throw new Error("cannot stop"); };
  await expect(registry.removeRuntime("b")).rejects.toThrow("could not stop safely");
  expect(existsSync(join(base, "tools", "antigravity-acp", `${process.platform}-${process.arch}`))).toBe(true);
  expect(registry.instances()).toHaveLength(0);
  expect((await registry.describe()).every(item => item.runtimeRemoval?.removed)).toBe(true);
  await expect(registry.restoreRuntime("a")).rejects.toThrow("has not stopped safely");
  await expect(registry.installRuntime("b")).rejects.toThrow("has not stopped safely");
  await expect(registry.removeRuntime("a")).rejects.toThrow("could not stop safely");
  expect(existsSync(join(base, "tools", "antigravity-acp", `${process.platform}-${process.arch}`))).toBe(true);
  old.dispose = async () => {};
  expect(await registry.removeRuntime("b")).toBe(true);
  expect(existsSync(join(base, "tools", "antigravity-acp", `${process.platform}-${process.arch}`))).toBe(false);
  expect(await registry.restoreRuntime("a")).toBe(true);
  await registry.disposeAll();
});
