// What crosses from the launching shell into a fixture server: only what a
// test scripted on purpose. A real OpenAI key must never reach a fixture that
// could send it to OpenAI.
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { verificationServerEnvironment } from "./control-hattera.ts";
import { stripOmbEnv } from "../server/testing/hattera-env.ts";

const childEnv = (parentEnv: NodeJS.ProcessEnv) => verificationServerEnvironment(parentEnv, join(tmpdir(), "omb-fixture-env"), 9100);

describe("the fixture's Live call environment", () => {
  it("removes canonical and legacy runtime settings before child overrides", () => {
    expect(stripOmbEnv({ PATH: "fixture-path", HATTERA_DATA_DIR: "personal-data", HATTERA_PORT: "8080", OMB_DATA_DIR: "legacy-data", OPENMAUSBOT_URL: "http://127.0.0.1:8080" }))
      .toEqual({ PATH: "fixture-path" });
  });
  it("passes a loopback fake GPT-Live and its key through", () => {
    expect(childEnv({ OMB_OPENAI_LIVE_URL: " http://127.0.0.1:4100 ", OMB_OPENAI_LIVE_KEY: "sk-fake" }))
      .toMatchObject({ OMB_OPENAI_LIVE_URL: "http://127.0.0.1:4100", OMB_OPENAI_LIVE_KEY: "sk-fake" });
    const noKey = childEnv({ OMB_OPENAI_LIVE_URL: "http://127.0.0.1:4100" });
    expect(noKey.OMB_OPENAI_LIVE_URL).toBe("http://127.0.0.1:4100");
    expect(noKey).not.toHaveProperty("OMB_OPENAI_LIVE_KEY");
  });

  it("drops any other Live URL, and never lets the key cross without the fake", () => {
    for (const url of ["https://api.openai.com", "http://localhost:4100", "http://127.0.0.1:4100/v1", "http://192.0.2.1:4100", "http://127.0.0.1", ""]) {
      const env = childEnv({ OMB_OPENAI_LIVE_URL: url, OMB_OPENAI_LIVE_KEY: "sk-real" });
      expect(env, url).not.toHaveProperty("OMB_OPENAI_LIVE_URL");
      expect(env, url).not.toHaveProperty("OMB_OPENAI_LIVE_KEY");
    }
    expect(childEnv({ OMB_OPENAI_LIVE_KEY: "sk-real" })).not.toHaveProperty("OMB_OPENAI_LIVE_KEY");
  });
});
