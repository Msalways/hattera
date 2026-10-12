import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codexBrowserSignInLink, codexBrowserSignInPrompt } from "../../shared/device-sign-in.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { CodexBrowserAuthController } from "./codex-device-auth.ts";

const URL = "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_fixture&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback&code_challenge=fixture_abc&code_challenge_method=S256&state=fixture_123";

describe("Codex CLI browser sign-in URL", () => {
  it("accepts only a complete official PKCE URL with the local callback", () => {
    expect(codexBrowserSignInPrompt(`Open this link:\n${URL}`)).toBeNull();
    expect(codexBrowserSignInPrompt(`Open this link:\n${URL}\n`)).toEqual({ authorizationUrl: URL });
    for (const value of [
      URL.replace("auth.openai.com", "auth.openai.com.evil.test"),
      URL.replace("https://", "http://"),
      URL.replace("127.0.0.1%3A1455", "evil.test%3A1455"),
      URL.replace("%2Fauth%2Fcallback", "%2Fother"),
      URL.replace("code_challenge_method=S256", "code_challenge_method=plain"),
      `${URL}#secret`,
      `${URL}&state=duplicate`,
      "https://auth.openai.com/codex/device",
    ]) expect(codexBrowserSignInLink(value)).toBeNull();
  });
});

describe("Codex CLI browser authentication", () => {
  let home: string;
  let controller: CodexBrowserAuthController;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "omb-browser-auth-"));
    const cli = join(home, "codex-fixture.mjs");
    writeFileSync(cli, `#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2).join(' ');
const home = process.env.CODEX_HOME;
appendFileSync(join(home, 'calls'), args + '\\n');
if (args === 'login status') {
  if (existsSync(join(home, 'authenticated'))) { console.log('Logged in using ChatGPT'); process.exit(0); }
  console.log('Not logged in'); process.exit(1);
}
if (args === 'login') {
  console.log(${JSON.stringify(URL)});
  setTimeout(() => { writeFileSync(join(home, 'authenticated'), 'fixture'); process.exit(0); }, 100);
} else process.exit(3);
`, { mode: 0o700 });
    chmodSync(cli, 0o700);
    controller = new CodexBrowserAuthController({
      cli, environment: () => ({ ...process.env, HOME: home, CODEX_HOME: home }),
      startupTimeoutMs: 10_000, lifetimeMs: 15_000,
    });
  });
  afterEach(async () => { await controller.dispose(); await removeTempDir(home); });

  it("runs plain codex login and confirms the stored sign-in", async () => {
    const started = await controller.start();
    expect(started).toMatchObject({ phase: "waiting", authorizationUrl: URL });
    expect(started.userCode).toBeUndefined();
    await expect.poll(() => controller.get(started.flowId!), { timeout: 10_000 })
      .toEqual({ phase: "succeeded", flowId: started.flowId, authorizationUrl: null, expiresAt: null });
    expect(readFileSync(join(home, "calls"), "utf8").trim().split("\n"))
      .toEqual(["login status", "login", "login status"]);
  });
});
