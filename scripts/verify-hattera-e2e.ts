// One fresh-build acceptance command. Never attaches to a live app or borrows
// provider logins. Optional external challenges still require no account consent.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureUiBrowser } from "./testing/control-hattera-ui.ts";
import { preparePeerFixture } from "../server/testing/collaboration-fixture.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = new Set(process.argv.slice(2));
if ([...args].some(arg => !["--live-network", "--docker"].includes(arg))) throw new Error("Usage: npm run test:e2e -- [--live-network] [--docker]");
const directory = join(root, "output/e2e", `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const report: { ok: boolean; startedAt: string; finishedAt?: string; error?: string; node: string; platform: string; providerAuthorization: string; peerTransport: string; physicalTailnetQualification: string; stages: Array<{ name: string; status: string; durationMs?: number; log?: string; error?: string }> } = {
  ok: false, startedAt: new Date().toISOString(), node: process.version, platform: `${process.platform}-${process.arch}`,
  providerAuthorization: "simulated; no real account authorized", peerTransport: "simulated loopback between independent apps",
  physicalTailnetQualification: "not performed; requires consenting signed-in devices", stages: [],
};
const save = () => writeFileSync(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
save();
const environment: NodeJS.ProcessEnv = { ...process.env, OMB_E2E_ARTIFACT_DIR: directory, OMB_VERIFY_SERVER_ENTRY: join(root, "dist-server/index.js"), OMB_VERIFY_WEB_DIST: join(root, "dist") };
let child: ReturnType<typeof spawn> | undefined;
let cancelled = false;
const interrupt = () => { cancelled = true; child?.kill("SIGTERM"); };
process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);

async function stage(name: string, command: string, argv: string[], options: { cwd?: string; timeout?: number } = {}) {
  if (cancelled) throw new Error("E2E run cancelled.");
  const entry: typeof report.stages[number] = { name, status: "running", log: join(directory, `${name}.log`) };
  report.stages.push(entry); save();
  console.log(`E2E: ${name}`);
  const started = Date.now(); let output = "";
  try {
    await new Promise<void>((done, fail) => {
      const running = spawn(command, argv, { cwd: options.cwd ?? root, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); child = running;
      const capture = (chunk: Buffer) => { output += String(chunk); if (output.length > 8 * 1024 * 1024) running.kill("SIGTERM"); };
      running.stdout!.on("data", capture); running.stderr!.on("data", capture);
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; running.kill("SIGTERM"); }, options.timeout ?? 600_000);
      running.once("error", error => { clearTimeout(timer); fail(error); });
      running.once("close", (code, signal) => { clearTimeout(timer); child = undefined; if (code === 0 && !timedOut && !cancelled) done(); else fail(new Error(timedOut ? `${name} exceeded its deadline` : `${name} exited with ${code ?? signal}`)); });
    });
    entry.status = "passed";
  } catch (error) {
    entry.status = "failed"; entry.error = error instanceof Error ? error.message : String(error);
    console.error(output.slice(-6000)); throw error;
  } finally {
    entry.durationMs = Date.now() - started; writeFileSync(entry.log!, output, { mode: 0o600 }); save();
  }
}
const node = (name: string, argv: string[], options?: Parameters<typeof stage>[3]) => stage(name, process.execPath, argv, options);

try {
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Hattera E2E requires Node.js 24 or newer.");
  for (const dependency of ["typescript/bin/tsc", "vitest/vitest.mjs", "vite/bin/vite.js"]) if (!existsSync(join(root, "node_modules", dependency))) throw new Error("Install repository dependencies before running npm run test:e2e.");
  await stage("go-prerequisite", "go", ["version"], { timeout: 15_000 });
  await node("frontend-types", ["node_modules/typescript/bin/tsc", "-b"]);
  await node("server-types", ["node_modules/typescript/bin/tsc", "-p", "tsconfig.server.json"]);
  await node("e2e-types", ["node_modules/typescript/bin/tsc", "-p", "tsconfig.e2e.json"]);
  await node("locales", ["scripts/generate-locale.mjs", "--check"]);
  await node("brand", ["scripts/check-hattera-brand.mjs"]);
  await node("brand-compatibility", ["--test", "shared/product-compat.node-test.mjs"]);
  await node("contrast", ["scripts/check-skin-contrast.mjs"]);
  await node("build-server", ["scripts/bundle-server.mjs"]);
  await node("build-web", ["node_modules/vite/bin/vite.js", "build", "--configLoader", "runner"]);
  await stage("network-contract", "go", ["test", "-p=2", "./..."], { cwd: join(root, "network"), timeout: 300_000 });
  await node("build-network", ["scripts/prepare-network.mjs", "--current"]);
  environment.OMB_VERIFY_PEER_HELPER = await preparePeerFixture();
  console.log("E2E: preparing isolated browser tooling");
  const browser = await ensureUiBrowser({ ...process.env,
    ...(process.env.OMB_VERIFY_BROWSER_BINARY ? { OMB_AGENT_BROWSER_PATH: process.env.OMB_VERIFY_BROWSER_BINARY } : {}),
    ...(process.env.OMB_VERIFY_BROWSER_CHROME ? { AGENT_BROWSER_EXECUTABLE_PATH: process.env.OMB_VERIFY_BROWSER_CHROME } : {}),
  }, line => console.log(`E2E: ${line}`));
  if (!browser.chrome || !existsSync(browser.chrome)) throw new Error("Browser preparation did not produce a Chrome executable.");
  environment.OMB_VERIFY_BROWSER_BINARY = browser.binary; environment.OMB_VERIFY_BROWSER_CHROME = browser.chrome;
  const tests = [
    "server/collaboration.e2e.test.ts", "server/collaboration-execution.e2e.test.ts", "server/collaboration-execution.test.ts", "server/provider-account-setup.e2e.test.ts", "server/local-runtime.e2e.test.ts", "server/usage-ledger-api.test.ts",
    "server/engine-install.e2e.test.ts", "server/engine-removal.e2e.test.ts", "server/codex-auth-methods.e2e.test.ts", "server/codex-auth-network.e2e.test.ts", "server/live-config-auth.e2e.test.ts",
    "server/provider-auth-sessions.test.ts", "server/official-engine-install.test.ts", "server/provider-profiles.test.ts",
    "server/account-usage.test.ts", "server/api-account-usage.test.ts", "server/drivers/provider-usage.test.ts", "server/private-network.test.ts",
    "server/provider-account-setup.test.ts", "server/usage-ledger.test.ts", "server/group-thread-usage.test.ts",
    "server/collaboration-service.test.ts", "server/collaboration-groups.test.ts", "server/collaboration-ledger.test.ts", "server/collaboration-box.test.ts",
  ];
  await node("application-contracts", ["node_modules/vitest/vitest.mjs", "run", ...tests, "--maxWorkers", "1", "--reporter=default", "--reporter=json", `--outputFile=${join(directory, "tests.json")}`], { timeout: 900_000 });
  const results = JSON.parse((await import("node:fs")).readFileSync(join(directory, "tests.json"), "utf8"));
  if (!results.success || results.numPendingTests || results.numTodoTests || results.numTotalTests < 1) throw new Error("E2E requires successful executed tests with no pending/skipped scenarios. Inspect tests.json.");
  // These contracts include explicit Windows/POSIX branches. Their skipped
  // platform cases are reported separately and execute on the matching CI OS.
  await node("platform-install-contracts", ["node_modules/vitest/vitest.mjs", "run", "server/engine-install.test.ts", "--maxWorkers", "1", "--reporter=json", `--outputFile=${join(directory, "platform-tests.json")}`]);
  await node("browser-app", ["--experimental-strip-types", "scripts/verify-hattera-app.ts"], { timeout: 360_000 });
  await node("browser-collaboration", ["--experimental-strip-types", "scripts/verify-collaboration-ui.ts"], { timeout: 300_000 });
  await node("account-network", ["--experimental-strip-types", "scripts/verify-account-network.ts", ...(args.has("--live-network") ? ["--live-network"] : [])], { timeout: 120_000 });
  if (args.has("--docker")) {
    await stage("docker-prerequisite", "docker", ["version"], { timeout: 20_000 });
    environment.OMB_VERIFY_NETWORK_IMAGE = `hattera-e2e-${randomUUID().slice(0, 8)}`;
    let built = false;
    try {
      await stage("docker-build", "docker", ["build", "--build-arg", "ENGINES=", "--target", "server", "-t", environment.OMB_VERIFY_NETWORK_IMAGE, "."], { timeout: 1_800_000 });
      built = true;
      await node("docker-network", ["scripts/verify-network-container.mjs", ...(args.has("--live-network") ? ["--live-network"] : [])]);
    } finally { if (built) await stage("docker-image-cleanup", "docker", ["image", "rm", environment.OMB_VERIFY_NETWORK_IMAGE], { timeout: 30_000 }); }
  }
  report.ok = true;
} catch (error) { report.error = error instanceof Error ? error.message : String(error); console.error(report.error); process.exitCode = 1; }
finally {
  report.finishedAt = new Date().toISOString(); save();
  console.log(`E2E ${report.ok ? "passed" : "failed"}. Report: ${join(directory, "report.json")}`);
  process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
}
