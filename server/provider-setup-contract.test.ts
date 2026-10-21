import { describe, expect, it } from "vitest";
import { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";

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
});
