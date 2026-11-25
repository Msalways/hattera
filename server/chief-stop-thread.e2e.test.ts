// A Chief of Staff can stop a teammate's running thread it opened, and
// withdraw a request that has not started — through the real injected agents
// MCP proxy (scripted fixture turns), against a real isolated server.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerArgs, verificationServerEnvironment } from "../scripts/control-hattera.ts";
import { request } from "../scripts/mcp-server.ts";
import { waitForExit } from "./testing/cleanup.ts";

const CAPABILITY_KEY = "chief-stop-thread-e2e-capability";

const SETTLED = "Your downstream room requests have settled.";
const OUTSTANDING = "Assignments you already sent are still outstanding";

async function fixture(test: (f: any) => Promise<void>) {
  const session = await launchVerificationServer({ ...process.env }, undefined, undefined, undefined, undefined, { scripted: true });
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: session.info.url } }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") => request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
  try {
    const chief = (await cli("new-bot", "--name", "Clive", "--section", "Leadership")).bot;
    const lead = (await cli("new-bot", "--name", "Engineering lead", "--section", "Engineering")).bot;
    await api(`/api/bots/${chief.id}`, { chiefOfStaff: true, managedSections: ["Engineering"], acknowledgePeerScope: true }, "PATCH");
    const planPath = join(session.info.dataDir, "room-plan.json");
    const plan: Record<string, any> = {};
    const save = () => writeFileSync(planPath, JSON.stringify(plan));
    const nodes = () => existsSync(join(session.info.dataDir, "room-handoffs.json")) ? JSON.parse(readFileSync(join(session.info.dataDir, "room-handoffs.json"), "utf8")) : [];
    const evidence = () => existsSync(`${planPath}.evidence.jsonl`) ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
    const messages = async (threadId: string) => (await api(`/api/threads/${threadId}/messages`)).messages as any[];
    const say = (text: string) => cli("send", "--bot", chief.id, "--task", chief.activeTaskId, "--text", text);
    const settled = () => cli("wait", "--bot", chief.id, "--task", chief.activeTaskId, "--timeout", "30");
    /** The chief turn a script entry ran, and what its tool calls answered. */
    const turn = (key: string) => evidence().find((t: any) => t.botId === chief.id && t.planKey === key);
    const answers = (key: string) => (turn(key)?.evidence ?? []).filter((e: any) => e.step).map((e: any) => ({
      error: Boolean(e.response.error || e.response.result?.isError), text: String(e.response.result?.content?.[0]?.text ?? e.response.error?.message ?? "") }));
    const childNode = () => nodes().find((node: any) => node.parentId && node.botId === lead.id);
    const stopStep = (threadId: string, expectError = false) => ({ tool: "stop_thread", expectError, arguments: { thread_id: threadId, reason: "The user asked to pause this" } });
    await test({ session, cli, api, chief, lead, plan, save, nodes, evidence, messages, say, settled, turn, answers, childNode, stopStep });
  } finally { await session.close(); }
}

const assign = { tool: "coordinate_bots", arguments: { bot_ids: ["lead"], message: "Build the export and keep going until told otherwise" } };

it("stops a running teammate thread the Chief opened, keeps its history, and returns the stop to the Chief", () => fixture(async f => {
  const hold = join(f.session.info.dataDir, "never-opens");
  f.plan[f.lead.id] = { gateFile: hold, reply: "never reached" };
  f.plan[f.chief.id] = { script: [
    { key: "assign", match: ["Pause test: assign"], steps: [{ ...assign, arguments: { ...assign.arguments, bot_ids: [f.lead.id] } }], reply: "Assigned" },
    { key: "stop", match: ["Pause test: stop now"], steps: [f.stopStep("filled-later")], reply: "Stopped it" },
    { key: "again", match: ["Pause test: again"], steps: [f.stopStep("filled-later", true), f.stopStep(f.chief.activeTaskId, true)], reply: "Refusals checked" },
    { key: "resume", match: [SETTLED], repeat: true, reply: "Noted the stop" },
  ] };
  f.save();
  await f.say("Pause test: assign");
  await expect.poll(() => f.childNode()?.status, { timeout: 20_000 }).toBe("running");
  const leadThread = f.childNode().threadId;
  await expect.poll(async () => (await f.api("/api/bots")).bots.find((b: any) => b.id === f.lead.id).tasks.find((t: any) => t.threadId === leadThread)?.busy, { timeout: 15_000 }).toBe(true);
  for (const key of ["stop", "again"]) f.plan[f.chief.id].script.find((e: any) => e.key === key).steps[0].arguments.thread_id = leadThread;
  f.save();

  await f.say("Pause test: stop now");
  await expect.poll(() => f.childNode()?.status, { timeout: 30_000 }).toBe("cancelled");
  expect(f.childNode().result).toBe("Stopped by Clive — The user asked to pause this");
  // The turn told the Chief the work was out before it stopped it.
  await expect.poll(() => f.turn("stop")).toBeTruthy();
  expect(JSON.stringify(f.turn("stop").prompt) + f.turn("stop").system).toContain(OUTSTANDING);
  expect(f.answers("stop")).toEqual([expect.objectContaining({ error: false, text: expect.stringContaining("Stopped Engineering lead's thread") })]);

  // The stopped thread keeps its history and says who stopped it and why.
  await expect.poll(async () => (await f.messages(leadThread)).some((m: any) => m.kind === "activity" && m.tool?.name === "Stopped by Clive — The user asked to pause this")).toBe(true);
  const history = await f.messages(leadThread);
  expect(history.some((m: any) => String(m.text).includes("Build the export"))).toBe(true);
  await expect.poll(async () => (await f.api("/api/bots")).bots.find((b: any) => b.id === f.lead.id).tasks.find((t: any) => t.threadId === leadThread)?.busy, { timeout: 15_000 }).toBe(false);

  // The outcome reaches the Chief's conversation like any other result.
  await expect.poll(async () => (await f.messages(f.chief.activeTaskId)).some((m: any) =>
    m.roomRequest?.phase === "result" && m.tool?.name === "Engineering lead — cancelled: Stopped by Clive — The user asked to pause this" && m.tool?.ok === false)).toBe(true);
  expect((await f.messages(f.chief.activeTaskId)).some((m: any) => (m.tool?.name ?? "").startsWith("Stopped Engineering lead's thread"))).toBe(true);
  expect((await f.settled()).status).toBe("settled");

  // It is idle now, so a second stop is refused; so is a thread of the Chief's own.
  await f.say("Pause test: again");
  await expect.poll(() => f.turn("again"), { timeout: 30_000 }).toBeTruthy();
  const refused = f.answers("again");
  expect(refused[0]).toMatchObject({ error: true });
  expect(refused[0].text).toMatch(/is idle — there is nothing running to stop/);
  expect(refused[1]).toMatchObject({ error: true });
  expect(refused[1].text).toMatch(/one of your own threads/);
  // Nothing was outstanding any more.
  expect(JSON.stringify(f.turn("again").prompt) + f.turn("again").system).not.toContain(OUTSTANDING);
}), 120_000);

it("refuses to stop a thread the Chief did not open and leaves it untouched", () => fixture(async f => {
  f.plan[f.chief.id] = { script: [
    { key: "stranger", match: ["Pause test: stranger"], steps: [f.stopStep(f.lead.activeTaskId, true), f.stopStep("no-such-thread", true)], reply: "Refused" },
  ] };
  f.save();
  await f.say("Pause test: stranger");
  await expect.poll(() => f.turn("stranger"), { timeout: 30_000 }).toBeTruthy();
  const [notOpened, missing] = f.answers("stranger");
  expect(notOpened).toMatchObject({ error: true });
  expect(notOpened.text).toMatch(/not yours to stop/);
  expect(missing).toMatchObject({ error: true });
  expect(missing.text).toMatch(/no such thread/);
  expect((await f.messages(f.lead.activeTaskId)).some((m: any) => (m.tool?.name ?? "").startsWith("Stopped by"))).toBe(false);
}), 60_000);

it("withdraws a queued request, refuses a second withdrawal, and clears the outstanding assignment", () => fixture(async f => {
  await f.api("/api/config", { threads: { maxConcurrentPerBot: 1 } }, "PUT");
  const hold = join(f.session.info.dataDir, "lead-busy");
  f.plan[f.lead.id] = { turns: [{ gateFile: hold, reply: "Unrelated work completed" }] };
  f.plan[f.chief.id] = { script: [
    { key: "assign", match: ["Pause test: assign"], steps: [{ ...assign, arguments: { ...assign.arguments, bot_ids: [f.lead.id] } }], reply: "Assigned" },
    { key: "withdraw", match: ["Pause test: withdraw"], steps: [{ tool: "cancel_request", expectError: false, arguments: { request_id: "filled-later" } }], reply: "Withdrawn" },
    { key: "recheck", match: ["Pause test: recheck"], steps: [
      { tool: "cancel_request", expectError: true, arguments: { request_id: "filled-later" } },
      { tool: "cancel_request", expectError: true, arguments: { request_id: "no-such-request" } },
    ], reply: "Checked" },
    { key: "resume", match: [SETTLED], repeat: true, reply: "Noted the withdrawal" },
  ] };
  f.save();
  await f.cli("send", "--bot", f.lead.id, "--task", f.lead.activeTaskId, "--text", "My unrelated task");
  await f.say("Pause test: assign");
  await expect.poll(() => f.childNode()?.status, { timeout: 20_000 }).toBe("queued");
  const requestId = f.childNode().id;
  // The assigning turn has ended before the Chief is spoken to again.
  await expect.poll(() => f.turn("assign"), { timeout: 20_000 }).toBeTruthy();
  for (const key of ["withdraw", "recheck"]) f.plan[f.chief.id].script.find((e: any) => e.key === key).steps[0].arguments.request_id = requestId;
  f.save();

  await f.say("Pause test: withdraw");
  await expect.poll(() => f.childNode()?.status, { timeout: 30_000 }).toBe("cancelled");
  expect(f.childNode().result).toBe("Withdrawn by Clive before it started");
  await expect.poll(() => f.turn("withdraw"), { timeout: 20_000 }).toBeTruthy();
  expect(f.answers("withdraw")).toEqual([expect.objectContaining({ error: false, text: expect.stringContaining("Withdrew your queued request") })]);
  expect(JSON.stringify(f.turn("withdraw").prompt) + f.turn("withdraw").system).toContain(OUTSTANDING);
  // The withdrawal comes back as that assignment's result.
  await expect.poll(async () => (await f.messages(f.chief.activeTaskId)).some((m: any) =>
    m.roomRequest?.phase === "result" && m.tool?.name === "Engineering lead — cancelled: Withdrawn by Clive before it started")).toBe(true);
  expect((await f.settled()).status).toBe("settled");

  await f.say("Pause test: recheck");
  await expect.poll(() => f.turn("recheck"), { timeout: 30_000 }).toBeTruthy();
  const [again, missing] = f.answers("recheck");
  expect(again.text).toMatch(/already cancelled/);
  expect(missing.text).toMatch(/no such request/);
  expect(JSON.stringify(f.turn("recheck").prompt) + f.turn("recheck").system).not.toContain(OUTSTANDING);

  // The unrelated work finishes; the withdrawn request never started.
  writeFileSync(hold, "");
  await expect.poll(async () => (await f.messages(f.lead.activeTaskId)).some((m: any) => m.text === "Unrelated work completed"), { timeout: 30_000 }).toBe(true);
  expect(f.evidence().filter((t: any) => t.botId === f.lead.id)).toHaveLength(1);
}), 120_000);

it("refuses to stop a sectionless peer's thread even though blank sections compare equal", () => fixture(async f => {
  await f.api(`/api/bots/${f.chief.id}`, { section: "" }, "PATCH");
  await f.api(`/api/bots/${f.lead.id}`, { section: "" }, "PATCH");
  const hold = join(f.session.info.dataDir, "boundary-hold");
  f.plan[f.lead.id] = { gateFile: hold, reply: "never reached" };
  f.plan[f.chief.id] = { script: [
    { key: "assign", match: ["Boundary: assign"], steps: [{ ...assign, arguments: { ...assign.arguments, bot_ids: [f.lead.id] } }], reply: "Assigned" },
    { key: "stop", match: ["Boundary: stop"], steps: [f.stopStep("filled-later", true)], reply: "Checked" },
  ] };
  f.save();
  await f.say("Boundary: assign");
  await expect.poll(() => f.childNode()?.status, { timeout: 30_000 }).toBe("running");
  await expect.poll(() => f.turn("assign"), { timeout: 30_000 }).toBeTruthy();
  const leadThread = f.childNode().threadId;
  f.plan[f.chief.id].script.find((e: any) => e.key === "stop").steps[0].arguments.thread_id = leadThread;
  f.save();
  await f.say("Boundary: stop");
  await expect.poll(() => f.turn("stop"), { timeout: 30_000 }).toBeTruthy();
  const [answer] = f.answers("stop");
  expect(answer).toMatchObject({ error: true });
  expect(answer.text).toMatch(/named section/);
  expect(f.childNode().status).toBe("running");
  expect((await f.messages(leadThread)).some((m: any) => (m.tool?.name ?? "").startsWith("Stopped by"))).toBe(false);
}), 120_000);

it("answers 404 not found for a thread of a bot outside the Chief's team", () => fixture(async f => {
  const outsider = (await f.cli("new-bot", "--name", "Outsider", "--section", "Finance")).bot;
  f.plan[f.chief.id] = { script: [
    { key: "outside", match: ["Boundary: outside"], steps: [f.stopStep(outsider.activeTaskId, true)], reply: "Checked" },
  ] };
  f.save();
  await f.say("Boundary: outside");
  await expect.poll(() => f.turn("outside"), { timeout: 30_000 }).toBeTruthy();
  const [answer] = f.answers("outside");
  expect(answer).toMatchObject({ error: true });
  expect(answer.text).toMatch(/no such thread/);
}), 60_000);

/** The stop route itself, called with a Chief's turn capability so the HTTP
 * status is observable (the agents proxy flattens it into tool text). The
 * fixture server is restarted on its own data with the test capability key. */
async function directRoute(test: (f: any) => Promise<void>) {
  const fixture = await launchVerificationServer({ ...process.env });
  const { url, dataDir, logPath } = fixture.info;
  let server: ChildProcess | undefined;
  try {
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const childEnv = { ...verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), OMB_TEST_HARNESS: "1", OMB_TEST_INTERNAL_CAPABILITY_KEY: CAPABILITY_KEY };
    const log = openSync(logPath, "a", 0o600);
    server = spawn(process.execPath, verificationServerArgs(childEnv), { cwd: join(import.meta.dirname, ".."), env: childEnv, stdio: ["ignore", log, log] });
    closeSync(log);
    await expect.poll(async () => { try { return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; } }, { timeout: 30_000 }).toBe(true);
    const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: url } }) as Promise<any>;
    const api = (path: string, body?: unknown, method = "POST") => request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, url) as Promise<any>;
    const chief = (await cli("new-bot", "--name", "Clive", "--section", "Leadership")).bot;
    const lead = (await cli("new-bot", "--name", "Engineering lead", "--section", "Engineering")).bot;
    await api(`/api/bots/${chief.id}`, { chiefOfStaff: true, managedSections: ["Engineering"], acknowledgePeerScope: true }, "PATCH");
    const stop = async (threadId: string, reason = "The user asked to pause this") => {
      const minted = await fetch(`${url}/api/testing/internal-capability`, {
        method: "POST", headers: { "content-type": "application/json", "x-openmausbot-test-capability": CAPABILITY_KEY },
        body: JSON.stringify({ botId: chief.id, threadId: chief.activeTaskId }),
      });
      expect(minted.status).toBe(201);
      const { token } = await minted.json() as { token: string };
      const res = await fetch(`${url}/api/internal/stop-thread`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ fromBotId: chief.id, fromThreadId: chief.activeTaskId, toThreadId: threadId, reason }),
      });
      return { status: res.status, error: String(((await res.json()) as any).error ?? "") };
    };
    await test({ cli, api, chief, lead, stop });
  } finally {
    if (server) await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
  }
}

it("answers 404 for a thread of an out-of-team bot and for a hidden peer, by status code", () => directRoute(async f => {
  const outsider = (await f.cli("new-bot", "--name", "Outsider", "--section", "Finance")).bot;
  expect(await f.stop(outsider.activeTaskId)).toMatchObject({ status: 404, error: expect.stringMatching(/no such thread/) });
  // In the Chief's managed section but hidden: indistinguishable from a thread that does not exist.
  const secret = (await f.cli("new-bot", "--name", "Secret engineer", "--section", "Engineering")).bot;
  await f.api(`/api/bots/${secret.id}`, { hidden: true }, "PATCH");
  expect(await f.stop(secret.activeTaskId)).toMatchObject({ status: 404, error: expect.stringMatching(/no such thread/) });
  expect(await f.stop("no-such-thread")).toMatchObject({ status: 404 });
}), 90_000);

it("answers 403 when the Chief and the target are both sectionless, by status code", () => directRoute(async f => {
  await f.api(`/api/bots/${f.chief.id}`, { section: "" }, "PATCH");
  await f.api(`/api/bots/${f.lead.id}`, { section: "" }, "PATCH");
  expect(await f.stop(f.lead.activeTaskId)).toMatchObject({ status: 403, error: expect.stringMatching(/named section/) });
}), 90_000);

// A same-section peer's thread that no handoff, delegation or openedBy record
// ties to the Chief (the shape of a thread the person opened, or one that
// predates those records) is refused: stop_thread only stops threads this
// Chief opened. It is seeded as the peer's own starter thread; no
// start_thread call is involved.
it("refuses, with 403, to stop a same-section peer's legacy thread that has no handoff or opener record", () => directRoute(async f => {
  expect(await f.stop(f.lead.activeTaskId)).toMatchObject({ status: 403, error: expect.stringMatching(/not yours to stop/) });
  const history = (await f.api(`/api/threads/${f.lead.activeTaskId}/messages`)).messages as any[];
  expect(history.some(m => String(m.tool?.name ?? "").startsWith("Stopped by"))).toBe(false);
}), 90_000);
