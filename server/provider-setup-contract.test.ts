import { describe, expect, it } from "vitest";
import { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";
import { providerAccountForm } from "../shared/provider-account-setup.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTempDir } from "./testing/cleanup.ts";

describe("built-in provider setup contracts", () => {
  it("gives every installed CLI a user-facing account setup path", () => {
    for (const driver of BUILT_IN_DRIVERS) {
      const cli = (driver.defaultConfig() as { cli?: unknown }).cli;
      if (typeof cli !== "string" || !cli) continue;
      expect(driver.install, `${driver.driverKind}: missing install descriptor`).toBeDefined();
      expect(
        Boolean(driver.install?.signInCommand || driver.install?.managed),
        `${driver.driverKind}: installed CLI has no account setup path`,
      ).toBe(true);
    }
  });

  it("classifies direct xAI requests as API-key access", () => {
    expect(BUILT_IN_DRIVERS.find((driver) => driver.driverKind === "grok")?.metadata.access).toBe("api");
  });

  it("requires an in-app setup path for every built-in CLI instead of accepting a terminal command as coverage", async () => {
    const home = mkdtempSync(join(tmpdir(), "hattera-setup-contract-"));
    const cli = fileURLToPath(new URL("./testing/fake-acp-cli.ts", import.meta.url));
    try {
      for (const driver of BUILT_IN_DRIVERS) {
        const config = driver.defaultConfig() as { cli?: string };
        if (!config.cli || driver.driverKind === "customAcp" || driver.install?.managed || driver.install?.settings === "connections") continue;
        if (providerAccountForm(driver.driverKind, "fixture") || driver.driverKind === "opencodeGo") continue;
        const instance = await driver.create({ instanceId: `setup-${driver.driverKind}`, displayName: "Isolated setup check", enabled: true,
          config: { ...config, cli }, environment: { HOME: home, USERPROFILE: home } });
        try { expect(instance.startAuthentication, `${driver.driverKind} has only a terminal command`).toBeTypeOf("function"); }
        finally { await instance.dispose(); }
      }
    } finally { await removeTempDir(home); }
  }, 60_000);
});
