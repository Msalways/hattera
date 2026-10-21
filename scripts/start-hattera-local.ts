// A fresh local app for checking real provider downloads from a normal terminal.
// Its home stays inside this checkout and never reads a live Hattera profile.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { verificationServerEnvironment } from "./control-omb.ts";
import { freePortBlock } from "../server/testing/ports.ts";
import { waitForExit } from "../server/testing/cleanup.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const tailscale = process.argv.slice(2).includes("--tailscale");
if (process.argv.slice(2).some((arg) => arg !== "--tailscale")) throw new Error("Usage: node --experimental-strip-types scripts/start-hattera-local.ts [--tailscale]");
const dist = join(root, "dist");
if (!existsSync(join(dist, "index.html"))) throw new Error("Build the app first: .\\node_modules\\.bin\\vite.CMD build --configLoader runner");

const scratch = join(root, ".omb-scratch");
mkdirSync(scratch, { recursive: true });
const dataDir = mkdtempSync(join(scratch, "hattera-install-review-"));
mkdirSync(join(dataDir, "tmp"), { recursive: true });
const port = await freePortBlock([0, 1]);
const platformEnv = Object.fromEntries(["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "TZ"]
  .map((key) => [key, Object.entries(process.env).find(([name]) => name.toUpperCase() === key)?.[1]]));
const env = verificationServerEnvironment(platformEnv, dataDir, port);
delete env.FAKE_CLAUDE_MODE;
delete env.FAKE_CLAUDE_DUMP;
delete env.OMB_TEST_SEALED_PATH;
if (process.env.PATH) env.PATH = process.env.PATH;
// A normal terminal may need its network proxy or custom certificate to reach npm.
for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "CODEX_CA_CERTIFICATE", "SSL_CERT_FILE"]) {
  if (process.env[key]) env[key] = process.env[key];
}
if (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy) env.NODE_USE_ENV_PROXY = "1";
env.OMB_STATIC_DIR = dist;

const child = spawn(process.execPath, ["--experimental-strip-types", join(root, "server", tailscale ? "openmausbot.ts" : "index.ts"),
  ...(tailscale ? ["serve", "--port", String(port), "--data-dir", dataDir, "--tailscale", "--no-open"] : [])],
  { cwd: root, env, stdio: "inherit", windowsHide: true });
const closed = new Promise<number>((resolve) => child.once("close", (code) => resolve(code ?? 1)));
const url = `http://127.0.0.1:${port}`;
console.log(`Hattera app data: ${dataDir}`);
child.once("error", (error) => console.error(`Hattera could not start: ${error.message}`));
process.on("SIGINT", () => { void waitForExit(child, { signal: "SIGTERM" }); });

let ready = false;
for (let attempt = 0; attempt < 120 && child.exitCode === null && child.signalCode === null; attempt++) {
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) });
    if (response.ok) { ready = true; break; }
  } catch { /* Server is still starting. */ }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
if (ready) {
  console.log(`Hattera HTTP is ready locally: ${url}`);
  await Promise.all([
    ["Codex sign-in", "https://auth.openai.com/.well-known/openid-configuration"],
    ["npm provider downloads", "https://registry.npmjs.org/"],
  ].map(async ([feature, target]) => {
    try {
      // Any HTTP response proves transport; credentials and vendor policy are
      // checked only by the actual sign-in or install action.
      await fetch(target, { method: "HEAD", signal: AbortSignal.timeout(5_000) });
      console.log(`${feature}: external host reachable from this process`);
    } catch {
      console.warn(`${feature}: external host unreachable from this process. ${feature === "Codex sign-in" ? "Codex sign-in" : "npm downloads"} will fail here until outbound HTTPS, proxy, DNS, or CA settings are fixed.`);
    }
  }));
}
else if (child.exitCode !== null || child.signalCode !== null) {
  console.error("Hattera exited before it was ready. Check the server error above.");
} else {
  console.error("Hattera did not become ready within one minute. Check the server output above.");
  await waitForExit(child, { signal: "SIGTERM" });
}
const exitCode = await closed;
process.exitCode = ready ? exitCode : 1;
