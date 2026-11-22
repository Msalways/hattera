// A person raises a thread's approval level while the bot is mid-turn.
//
// Boots the real harness with the fake Claude CLI told to ask for a file write
// (FAKE_CLAUDE_ASK_TOOL) and drives the thread over HTTP the way the app does:
// the turn starts at Ask and stops on a card; the level is raised; the engine
// is told over its control channel, the waiting card is re-read against the
// new level and answered as "allowed by level change", and the turn carries
// on. It also pins who may do this: only a request that proves the person made
// it (the desktop app's owner capability here; a signed-in session in the
// browser) may raise it. A bot's own shell is a loopback caller that can send
// any header a browser does, so a forged Origin, Referer, Sec-Fetch-Site or
// Host proves nothing and is refused on every route that can widen.
//
// The fake CLI is a script, so this runs where it can be exec'd directly
// (POSIX) or through a .cmd wrapper (Windows).
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");

let child: ChildProcess;
let home = "";
let base = "";
let stderr = "";
// Set when the server runs as the desktop app runs it: the owner capability
// the app (and nothing a bot's shell can read) presents on every change.
let ownerToken: string | undefined;

// a request exactly as a bot's shell can make it: whatever headers it likes, never the capability
const bare = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};
// the person's own UI request: the same, plus the app's owner capability when there is one
const api = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  bare(method, path, body, { ...headers, ...(ownerToken ? { "x-openmausbot-desktop-owner": ownerToken } : {}) });
// a bare request with an arbitrary Host header (fetch cannot set one)
const bareWithHost = (method: string, path: string, body: unknown, host: string): Promise<{ status: number; body: any }> =>
  new Promise((resolve, reject) => {
    const url = new URL(`${base}${path}`);
    const req = httpRequest({ host: url.hostname, port: url.port, path: url.pathname, method, headers: { host, "content-type": "application/json" } }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : {} }));
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
// the app's own requests carry a browser origin; a bot's shell can send one too
const fromApp = { origin: "http://127.0.0.1" };
const messages = async (threadId: string): Promise<any[]> => (await api("GET", `/api/threads/${threadId}/messages`)).body.messages ?? [];
const permissionCard = async (threadId: string) =>
  (await messages(threadId)).find((m) => m.kind === "options" && m.card?.requestType === "permission");

async function boot(askTool: string, desktop = false): Promise<void> {
  stderr = "";
  ownerToken = desktop ? randomBytes(32).toString("base64url") : undefined;
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
    child = spawn(process.execPath, [
      ...(desktop ? ["--import", pathToFileURL(join(SERVER_DIR, "testing", "desktop-parent.mjs")).href] : []),
      join(SERVER_DIR, "index.ts"),
    ], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: home,
        USERPROFILE: home,
        // a bare local request is the owner here (as on a personal install), unless run as the desktop app
        OMB_LOOPBACK_TRUST: "owner",
        ...(desktop ? { OMB_DESKTOP_PARENT: "1", OMB_TEST_DESKTOP_OWNER_TOKEN: ownerToken! } : {}),
        OMB_PORT: String(port),
        OMB_WEBHOOK_PORT: String(port + 1),
        TMPDIR: tmpdir(),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    const deadline = Date.now() + 90_000;
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
  beforeAll(() => boot("Write", true), 100_000);
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
    const fromBotShell = await bare("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { approvalMode: "edits" }, fromApp);
    expect(fromBotShell.status).toBe(403);
    expect(fromBotShell.body.error).toMatch(/desktop app or a paired device/);
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
  beforeAll(() => boot("Bash", true), 100_000);
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
    const botShell = await bare("PATCH", `/api/bots/${bot.id}`, { approvalMode: "edits" }, fromApp);
    expect(botShell.status).toBe(403);
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
  beforeAll(() => boot("Write", true), 100_000);
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

// Where a bare local request is the owner (a personal install started from
// the command line) nothing a bot's shell cannot also send separates it from
// the person's page: Origin, Referer, Sec-Fetch-Site and Host are all the
// caller's choice. So a widening while a bot works is refused whatever the
// headers say, on every route that can widen, and the card stays waiting.
describe("a bot's own shell forging browser headers", () => {
  beforeAll(() => boot("Write", false), 100_000);
  afterAll(shutdown);

  const forged: Array<[string, Record<string, string>]> = [
    ["a same-origin Origin", { origin: "http://127.0.0.1" }],
    ["a Referer from the app's own page", { referer: "http://127.0.0.1/" }],
    ["Sec-Fetch-Site: same-origin", { "sec-fetch-site": "same-origin" }],
    ["all of them together", { origin: "http://127.0.0.1", referer: "http://127.0.0.1/", "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" }],
  ];

  it("cannot widen the level, answer a card or add to the allow-list on any route while a bot works", async () => {
    const bot = (await api("GET", "/api/bots?messages=0")).body.bots[0];
    expect((await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "claude", model: "claude-fake" } })).status).toBe(200);
    const threadId: string = bot.threadId;
    // while nothing works, the owner sets the bot's default to Auto-accept edits and pins this thread to Ask
    expect((await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "edits" })).status).toBe(200);
    expect((await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { approvalMode: "ask" })).status).toBe(200);
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "write the file" })).status).toBe(202);
    await expect.poll(async () => Boolean(await permissionCard(threadId)), { timeout: 30_000 }).toBe(true);
    await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots[0].busy, { timeout: 5_000 }).toBe(true);

    const taskPath = `/api/bots/${bot.id}/tasks/${threadId}`;
    const routes: Array<[string, (headers: Record<string, string>) => Promise<{ status: number; body: any }>]> = [
      ["thread level", (h) => bare("PATCH", taskPath, { approvalMode: "edits" }, h)],
      ["bot level", (h) => bare("PATCH", `/api/bots/${bot.id}`, { approvalMode: "auto", acknowledgeLocalAuto: true }, h)],
      ["bot allow-list", (h) => bare("PATCH", `/api/bots/${bot.id}`, { alwaysAllow: ["Write"] }, h)],
      ["thread refresh (bot's wider level onto the thread)", (h) => bare("PATCH", taskPath, { refreshPermissions: true }, h)],
    ];
    for (const [label, headers] of forged) {
      for (const [route, send] of routes) {
        const res = await send(headers);
        expect(res.status, `${route} with ${label}: ${JSON.stringify(res.body)}`).toBe(409);
        expect(res.body.error).toMatch(/signed-in session or the desktop app/);
      }
      const forgedHost = await bareWithHost("PATCH", taskPath, { approvalMode: "edits" }, "localhost");
      expect(forgedHost.status, JSON.stringify(forgedHost.body)).toBe(409);
    }
    // the unwanted host is no better a way in
    const evilHost = await bareWithHost("PATCH", taskPath, { approvalMode: "edits" }, "evil.example");
    expect(evilHost.status).toBeGreaterThanOrEqual(400);

    // nothing changed: the card still waits and the thread is still Ask
    expect((await permissionCard(threadId)).card.answered).toBeUndefined();
    const saved = (await api("GET", "/api/bots?messages=0")).body.bots[0];
    expect(saved.approvalMode).toBe("edits");
    expect(saved.tasks.find((task: any) => task.threadId === threadId).approvalMode).toBe("ask");
    expect(saved.alwaysAllow ?? []).toEqual([]);

    // narrowing stays open to a bot's shell: it can always ask for more oversight
    expect((await bare("PATCH", taskPath, { approvalMode: "ask" })).status).toBe(200);
  }, 120_000);
});
