#!/usr/bin/env node
// Offline UI fixture only. Explicit opt-in and a disposable HOME are required.
// Approve by creating HOME/.omb-fake-codex-login-approved; this never opens a
// network connection or creates real provider credentials.
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const home = process.env.HOME;
if (process.env.OMB_DEVICE_AUTH_FIXTURE !== "1" || !home || !isAbsolute(home)) {
  process.stderr.write("This fake CLI requires OMB_DEVICE_AUTH_FIXTURE=1 and an isolated HOME.\n");
  process.exit(2);
}
const authenticated = join(home, ".omb-fake-codex-authenticated");
const approved = join(home, ".omb-fake-codex-login-approved");
const args = process.argv.slice(2).join(" ");

if (args === "--version") {
  process.stdout.write("codex-cli 0.153.4\n");
} else if (args === "login status") {
  const signedIn = existsSync(authenticated);
  process.stderr.write(signedIn ? "Logged in using ChatGPT\n" : "Not logged in\n");
  process.exitCode = signedIn ? 0 : 1;
} else if (args === "logout") {
  if (existsSync(authenticated)) unlinkSync(authenticated);
  process.stderr.write("Logged out\n");
} else if (args === "login --device-auth") {
  if (process.env.OMB_DEVICE_AUTH_FIXTURE_NETWORK === "1") {
    process.stderr.write("Error logging in with device code: error sending request for url (https://auth.openai.com/api/accounts/deviceauth/usercode): secret-token\n");
    process.exit(1);
  }
  writeFileSync(join(home, ".omb-fake-codex-device.pid"), String(process.pid), { mode: 0o600 });
  process.stderr.write("Offline OMB verification fixture — do not enter this code at OpenAI.\n");
  process.stderr.write("https://auth.openai.com/codex/device\nTEST-12345\n");
  const timer = setInterval(() => {
    if (!existsSync(approved)) return;
    clearInterval(timer);
    writeFileSync(authenticated, "Offline fixture; not a credential.\n", { mode: 0o600 });
    process.stderr.write("Successfully logged in\n");
  }, 100);
} else if (args === "login") {
  if (process.env.OMB_DEVICE_AUTH_FIXTURE_NETWORK === "1") {
    process.stderr.write("Error logging in: error sending request for url (https://auth.openai.com/oauth/token): secret-token\n");
    process.exit(1);
  }
  process.stderr.write("https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_fixture&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback&code_challenge=fixture_abc&code_challenge_method=S256&state=fixture_123\n");
  const timer = setInterval(() => {
    if (!existsSync(approved)) return;
    clearInterval(timer);
    writeFileSync(authenticated, "Offline fixture; not a credential.\n", { mode: 0o600 });
    process.stderr.write("Successfully logged in\n");
  }, 100);
} else if (process.argv[2] === "app-server") {
  process.env.FAKE_CODEX_ASTRA = "1";
  process.env.FAKE_CODEX_MODE = "happy";
  delete process.env.FAKE_CODEX_DUMP;
  await import("./fake-codex-app-server.ts");
} else {
  process.stderr.write("Unsupported offline fixture command.\n");
  process.exitCode = 2;
}
