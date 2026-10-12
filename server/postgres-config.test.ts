import { describe, expect, it } from "vitest";
import { postgresConnectionUrl } from "./postgres-config.ts";

describe("PostgreSQL opt-in", () => {
  it("keeps SQLite as the default even when a provider injects DATABASE_URL", () => {
    expect(postgresConnectionUrl({ DATABASE_URL: "postgresql://db.example/app" })).toBeNull();
    expect(postgresConnectionUrl({ OMB_POSTGRES_ENABLED: "false", DATABASE_URL: "postgresql://db.example/app" })).toBeNull();
  });

  it("requires a valid PostgreSQL URL without echoing credentials", () => {
    expect(postgresConnectionUrl({ OMB_POSTGRES_ENABLED: "true", DATABASE_URL: "postgresql://alice:secret@db.example/app" })).toBe("postgresql://alice:secret@db.example/app");
    for (const url of [undefined, "", "sqlite:///tmp/app.db", "postgresql://alice:secret@db.example/"]) {
      let error = "";
      try { postgresConnectionUrl({ OMB_POSTGRES_ENABLED: "true", DATABASE_URL: url }); }
      catch (caught) { error = String(caught); }
      expect(error).toBeTruthy();
      expect(error).not.toContain("secret");
    }
  });

  it("rejects mistyped flags", () => {
    expect(() => postgresConnectionUrl({ OMB_POSTGRES_ENABLED: "1" })).toThrow("OMB_POSTGRES_ENABLED must be true or false");
  });
});
