// Who may read GET /api/bots/:id/capabilities, through the real server.
// It is a read-only client route with the ordinary bot-visibility check: a
// member sees it for a bot they may see, a hidden or unknown id is "not found"
// (never "forbidden"), another bot's thread is refused, and no session at all
// is refused. A member used to get 403 here because the route was never
// listed for client sessions. No engine is needed: the answer is the same
// read the Computer panel makes.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SessionRegistry } from "./sessions.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const BOSS = "boss@example.test";
const ADA = "ada@example.test";
const BOB = "bob@example.test";
const tokens: Record<string, string> = {};
let child: ChildProcess;
let home = "";
let base = "";
let log = "";

const api = async (method: string, path: string, as?: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(as ? { authorization: `Bearer ${tokens[as]}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

describe("GET /api/bots/:id/capabilities access", () => {
  const ids = { pub: "", pubThread: "", hr: "", hrThread: "" };
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "omb-caps-access-"));
    const data = join(home, ".openmausbot");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "config.json"), JSON.stringify({ signIn: { admins: [BOSS], members: [ADA, BOB] } }));
    const role = (email: string) => (email === BOSS ? ["admin", "client"] as const : ["client"] as const);
    const registry = new SessionRegistry({ file: join(data, "sessions.json"), emailScopes: (email) => [...role(email)] });
    for (const email of [BOSS, ADA, BOB]) tokens[email] = registry.issue({ label: email, email, scopes: [...role(email)] }).token;
    registry.close();
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: home, USERPROFILE: home, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), TMPDIR: tmpdir(),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (c) => (log += c));
    child.stderr!.on("data", (c) => (log += c));
    const deadline = Date.now() + 90_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${log}`);
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`server never came up:\n${log}`);
      await new Promise((r) => setTimeout(r, 150));
    }
    const make = async (name: string) => {
      const created = await api("POST", "/api/bots", BOSS, { name, section: "Ops" });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      return created.body.bot as { id: string; threadId: string };
    };
    const pub = await make("Helpdesk Otter");
    const hr = await make("Payroll Zebra");
    Object.assign(ids, { pub: pub.id, pubThread: pub.threadId, hr: hr.id, hrThread: hr.threadId });
    const restricted = await api("PATCH", `/api/bots/${hr.id}`, BOSS, { visibility: { people: [ADA] } });
    expect(restricted.status, JSON.stringify(restricted.body)).toBe(200);
  }, 100_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("gives a member the answer for a bot they may see, not a 403", async () => {
    for (const who of [BOB, ADA, BOSS]) {
      const res = await api("GET", `/api/bots/${ids.pub}/capabilities?threadId=${ids.pubThread}`, who);
      expect(res.status, `${who}: ${JSON.stringify(res.body)}`).toBe(200);
      expect(typeof res.body.browser.available).toBe("boolean");
      expect(typeof res.body.thisPc.shell.available).toBe("boolean");
    }
    expect((await api("GET", `/api/bots/${ids.hr}/capabilities`, ADA)).status).toBe(200); // may see Payroll
  });

  it("answers a hidden or unknown bot as not found, never forbidden", async () => {
    for (const path of [`/api/bots/${ids.hr}/capabilities`, "/api/bots/does-not-exist/capabilities"]) {
      const res = await api("GET", path, BOB);
      expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain("forbidden");
    }
  });

  it("refuses another bot's thread, even for a bot the member may see", async () => {
    const own = await api("GET", `/api/bots/${ids.pub}/capabilities?threadId=${ids.hrThread}`, ADA);
    expect(own.status).toBe(404);
    expect((await api("GET", `/api/bots/${ids.pub}/capabilities?threadId=nope`, BOB)).status).toBe(404);
  });

  it("refuses a request with no session, and a write method from a member", async () => {
    const anon = await api("GET", `/api/bots/${ids.pub}/capabilities`);
    expect([401, 403]).toContain(anon.status);
    expect((await api("POST", `/api/bots/${ids.pub}/capabilities`, BOB, { x: 1 })).status).toBe(403);
  });
});
