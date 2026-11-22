// A person raises a thread's approval level while the bot is mid-turn.
//
// Boots the real harness with the fake Claude CLI told to ask for a file write
// (FAKE_CLAUDE_ASK_TOOL) and drives the thread over HTTP the way the app does:
// the turn starts at Ask and stops on a card; the level is raised; the engine
// is told over its control channel, the waiting card is re-read against the
// new level and answered as "allowed by level change", and the turn carries
// on. It also pins who may do this: a bot's own shell (a loopback caller with
// no browser origin) can lower its level but never raise it.
//
// The fake CLI is a script, so this runs where it can be exec'd directly
// (POSIX) or through a .cmd wrapper (Windows).
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");

let child: ChildProcess;
let home = "";
let base = "";
let stderr = "";

const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};
// the app's own requests carry a browser origin; a bot's shell does not
const fromApp = { origin: "http://127.0.0.1" };
const messages = async (threadId: string): Promise<any[]> => (await api("GET", `/api/threads/${threadId}/messages`)).body.messages ?? [];
const permissionCard = async (threadId: string) =>
  (await messages(threadId)).find((m) => m.kind === "options" && m.card?.requestType === "permission");

async function boot(askTool: string): Promise<void> {
  stderr = "";
  {
    home = mkdtempSync(join(tmpdir(), "omb-level-change-"));
    const data = join(home, ".openmausbot");
    mkdirSync(data, { recursive: true });
    let cli = FAKE_CLAUDE;
    // a script cannot be exec'd on Windows; `cli` may carry fixed leading arguments
    if (process.platform === "win32") cli = `"${process.execPath}" --experimental-strip-types "${FAKE_CLAUDE}"`;
    else chmodSync(FAKE_CLAUDE, 0o755);
    writeFileSync(join(data, "config.json"), JSON.stringify({
      instances: {
        claude: {
          driver: "claudeAgent",
          environment: { FAKE_CLAUDE_ASK_TOOL: askTool },
          config: { cli },
        },
      },
    }));
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: home,
        USERPROFILE: home,
        // a bare local request is the owner here (as on a personal install)
        OMB_LOOPBACK_TRUST: "owner",
        OMB_PORT: String(port),
        OMB_WEBHOOK_PORT: String(port + 1),
        TMPDIR: tmpdir(),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${stderr}`);
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
}
const shutdown = async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  await removeTempDir(home);
};

describe("raising the approval level under a running turn", () => {
  beforeAll(() => boot("Write"), 60_000);
  afterAll(shutdown);

  it("answers the waiting card as allowed by level change, and the turn carries on", async () => {
    const bot = (await api("GET", "/api/bots?messages=0")).body.bots[0];
    const setModel = await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "claude", model: "claude-fake" } });
    expect(setModel, JSON.stringify(setModel.body)).toMatchObject({ status: 200 });
    const threadId: string = bot.threadId;
    const patchLevel = (approvalMode: string, headers?: Record<string, string>) =>
      api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { approvalMode }, headers);

    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "write the file" })).status).toBe(202);
    try {
      await expect.poll(async () => Boolean(await permissionCard(threadId)), { timeout: 30_000 }).toBe(true);
    } catch (error) {
      throw new Error(`no card. messages: ${JSON.stringify(await messages(threadId))}
stderr: ${stderr}`, { cause: error });
    }
    expect((await permissionCard(threadId)).card.answered).toBeUndefined();
    await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots[0].busy, { timeout: 5_000 }).toBe(true);

    // the bot's own shell cannot raise the level of the turn it is running in
    const fromBotShell = await patchLevel("edits");
    expect(fromBotShell.status).toBe(409);
    expect(fromBotShell.body.error).toMatch(/app or a paired device/);
    expect((await permissionCard(threadId)).card.answered).toBeUndefined();

    // the person raises it from the app: no stop needed, the engine takes it
    const raised = await patchLevel("edits", fromApp);
    expect(raised.status).toBe(200);
    expect(raised.body.levelChange).toMatchObject({ requested: "edits", effective: "edits", appliesAt: "now", resolved: 1, stillOpen: 0 });

    await expect.poll(async () => (await permissionCard(threadId))?.card.answered, { timeout: 20_000 }).toBe("allow");
    expect((await permissionCard(threadId)).card.resolvedBy).toBe("level-change");
    // the turn continued under the new mode and finished
    await expect.poll(async () => (await messages(threadId)).some((m) => /ask allowed in acceptEdits mode/.test(m.text ?? "")), { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots[0].busy, { timeout: 20_000 }).toBe(false);
    // recorded as the level change's decision, not a person's tap
    const log = (await api("GET", "/api/decisions")).body;
    if (log?.rows) expect(log.rows.some((row: any) => row.source === "level-change")).toBe(true);
    // the level survived: it is what the thread is saved at
    const saved = (await api("GET", "/api/bots?messages=0")).body.bots[0];
    expect(saved.tasks.find((task: any) => task.threadId === threadId).approvalMode).toBe("edits");
  }, 90_000);
});

// A card the new level does not cover is not answered: it stays open, says
// why, and the response counts it, so nothing is silently allowed and nothing
// is left looking like it was handled.
describe("a level change that does not cover the waiting card", () => {
  beforeAll(() => boot("Bash"), 60_000);
  afterAll(shutdown);

  it("leaves a shell command waiting under Auto-accept edits, says so, and answers it when the person does", async () => {
    const bot = (await api("GET", "/api/bots?messages=0")).body.bots[0];
    expect((await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "claude", model: "claude-fake" } })).status).toBe(200);
    const threadId: string = bot.threadId;
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "run it" })).status).toBe(202);
    await expect.poll(async () => Boolean(await permissionCard(threadId)), { timeout: 30_000 }).toBe(true);
    await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots[0].busy, { timeout: 5_000 }).toBe(true);

    const threadLevel = async () => (await api("GET", "/api/bots?messages=0")).body.bots[0].tasks.find((task: any) => task.threadId === threadId).approvalMode;
    // give the thread a level of its own, so it no longer follows the bot's default
    expect((await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { approvalMode: "ask" }, fromApp)).status).toBe(200);
    expect(await threadLevel()).toBe("ask");

    // the bot-level setting while the bot works: a bot's own shell cannot widen it
    const botShell = await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "edits" });
    expect(botShell.status).toBe(409);
    // the person can save it; this thread has its own level, so the default is for new chats
    const botLevel = await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "edits" }, fromApp);
    expect(botLevel.status, JSON.stringify(botLevel.body)).toBe(200);
    expect(botLevel.body.levelChange).toMatchObject({ requested: "edits", appliesAt: "new-chats" });
    expect(await threadLevel()).toBe("ask");
    expect((await permissionCard(threadId)).card.answered).toBeUndefined();
    // Full still needs the bot stopped (and the trusted desktop transition)
    expect((await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "full" }, fromApp)).status).toBeGreaterThanOrEqual(400);

    // Refresh permissions copies the bot's level onto the running thread, by the composer's rule
    const raised = await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { refreshPermissions: true }, fromApp);
    expect(raised.status, JSON.stringify(raised.body)).toBe(200);
    // the engine took the level, but a shell command is not a file edit
    expect(raised.body.levelChange).toMatchObject({ requested: "edits", effective: "edits", appliesAt: "now", resolved: 0, stillOpen: 1 });
    const card = (await permissionCard(threadId)).card;
    expect(card.answered).toBeUndefined();
    expect(card.recheckedLevel).toBe("edits");
    expect(card.recheckedWhy).toBe("level");

    // still the person's to answer
    const answered = await api("POST", `/api/threads/${threadId}/respond`, { requestId: card.requestId, behavior: "allow" }, fromApp);
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots[0].busy, { timeout: 20_000 }).toBe(false);
  }, 90_000);
});

// The bot's own default reaches a working thread that follows it, by the same
// rule as the message box: handed to the engine now, the waiting card re-read.
describe("a bot-level change under a thread that follows the bot", () => {
  beforeAll(() => boot("Write"), 60_000);
  afterAll(shutdown);

  it("answers the waiting edit card as allowed by level change", async () => {
    const bot = (await api("GET", "/api/bots?messages=0")).body.bots[0];
    expect((await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "claude", model: "claude-fake" } })).status).toBe(200);
    const threadId: string = bot.threadId;
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "write it" })).status).toBe(202);
    await expect.poll(async () => Boolean(await permissionCard(threadId)), { timeout: 30_000 }).toBe(true);
    await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots[0].busy, { timeout: 5_000 }).toBe(true);

    const botLevel = await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "edits" }, fromApp);
    expect(botLevel.status, JSON.stringify(botLevel.body)).toBe(200);
    expect(botLevel.body.levelChange).toMatchObject({ requested: "edits", effective: "edits", appliesAt: "now", resolved: 1, stillOpen: 0 });
    await expect.poll(async () => (await permissionCard(threadId))?.card.answered, { timeout: 20_000 }).toBe("allow");
    expect((await permissionCard(threadId)).card.resolvedBy).toBe("level-change");
    await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots[0].busy, { timeout: 20_000 }).toBe(false);
  }, 90_000);
});
