// Run inside a disposable, ENGINES-empty Hattera server container.
// This checks public downloads through the same API used by Settings.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = "http://127.0.0.1:8799";
const headers = { origin: root, "content-type": "application/json" };
const cliByPackage = new Map([
  ["@xai-official/grok", "grok"],
  ["@moonshot-ai/kimi-code", "kimi"],
  ["droid", "droid"],
  ["@anthropic-ai/claude-code", "claude"],
  ["@openai/codex", "codex"],
  ["opencode-ai", "opencode"],
  ["@qwen-code/qwen-code", "qwen"],
  ["cline", "cline"],
  ["@earendil-works/pi-coding-agent", "pi"],
  ["@google/gemini-cli", "gemini"],
]);

async function api(method, path) {
  const response = await fetch(root + path, {
    method, headers, ...(method === "POST" ? { body: "{}" } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function install(instance) {
  const id = instance.instanceId;
  const label = instance.install.server?.package ?? instance.install.server?.vendor ?? "managed";
  const start = Date.now();
  const result = await api("POST", `/api/instances/${id}/install`);
  if (result.install?.state !== "running" || Date.now() - start > 30_000) {
    throw new Error(`${id}: install request did not start promptly`);
  }
  console.log(`START ${id} (${label})`);
  const deadline = Date.now() + 70 * 60_000;
  let nextProgress = Date.now() + 60_000;
  for (;;) {
    const { install: job } = await api("GET", `/api/instances/${id}/install/status`);
    if (job?.state === "failed") throw new Error(`${id}: ${job.error}`);
    if (job?.state === "succeeded") break;
    if (Date.now() > deadline) throw new Error(`${id}: install timed out`);
    if (Date.now() >= nextProgress) {
      console.log(`WAIT ${id} ${Math.round((Date.now() - start) / 60_000)}m`);
      nextProgress = Date.now() + 60_000;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  const pkg = instance.install.server?.package;
  if (pkg) {
    const cli = cliByPackage.get(pkg);
    if (!cli) throw new Error(`${id}: no CLI verification mapping for ${pkg}`);
    const slot = `/data/.openmausbot/tools/engines/${cli}`;
    const { version } = JSON.parse(readFileSync(join(slot, "active.json"), "utf8"));
    const probe = spawnSync(join(slot, version, "bin", cli), ["--version"], {
      encoding: "utf8", timeout: 30_000,
    });
    if (probe.status !== 0) throw new Error(`${id}: CLI probe failed: ${probe.stderr}`);
    console.log(`PASS ${id} ${String(probe.stdout || probe.stderr).trim()} (${Math.round((Date.now() - start) / 1000)}s)`);
  } else {
    const after = (await api("GET", "/api/instances")).instances.find((item) => item.instanceId === id);
    if (after?.snapshot?.state === "unavailable") throw new Error(`${id}: installer succeeded but provider remains unavailable: ${after.snapshot.reason}`);
    console.log(`PASS ${id} ${after?.snapshot?.version ?? "CLI verified by server"} (${Math.round((Date.now() - start) / 1000)}s)`);
  }
}

const before = (await api("GET", "/api/instances")).instances;
const targets = before.filter((item) => item.install?.server || item.install?.managed);
const selected = targets.filter((item) => !["chatgpt", "claudeApi"].includes(item.instanceId));
const requested = process.argv.slice(2);
const group = requested.length === 1 && ["--npm", "--vendor"].includes(requested[0]) ? requested[0] : null;
const run = group === "--npm" ? selected.filter((item) => item.install?.server?.package)
  : group === "--vendor" ? selected.filter((item) => !item.install?.server?.package)
  : requested.length ? selected.filter((item) => requested.includes(item.instanceId)) : selected;
if (!group && requested.some((id) => !selected.some((item) => item.instanceId === id))) {
  throw new Error(`Unknown install target. Available: ${selected.map((item) => item.instanceId).join(", ")}`);
}
if (!run.length) throw new Error(`No install targets found for ${group ?? requested.join(", ")}`);
console.log(`Offered install targets: ${selected.map((item) => item.instanceId).join(", ")}`);
const failures = [];
for (const item of run) {
  try { await install(item); }
  catch (error) { failures.push({ id: item.instanceId, error: String(error) }); console.error(`FAIL ${item.instanceId}: ${error}`); }
}
console.log(JSON.stringify({ tested: run.map((item) => item.instanceId), failures }, null, 2));
if (failures.length) process.exitCode = 1;
