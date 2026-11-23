import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-hattera.ts";
import { removeTempDir } from "./testing/cleanup.ts";

it("one capability answer (panel route), and the team catalog lists a ready engine nobody has selected without authorising its models", async () => {
  const gates = mkdtempSync(join(tmpdir(), "omb-capability-truth-"));
  const gate = join(gates, "finish");
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate }, undefined, undefined, undefined, undefined, undefined, ["codex"]);
  const api = async (method: string, path: string, body?: unknown, expected = 200, token?: string) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", origin: fixture.info.url,
      ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json() as any;
    expect(response.status, JSON.stringify(result)).toBe(expected);
    return result;
  };
  try {
    const instances = (await api("GET", "/api/instances")).instances;
    const claude = instances.find((item: any) => item.instanceId === "claude");
    expect(instances.find((item: any) => item.instanceId === "codex")).toBeDefined();
    // Only a Claude bot exists: no bot or setting selects a Codex model.
    const chief = (await api("POST", "/api/bots", { name: "Clive", title: "Chief of Staff", section: "Operations",
      modelSelection: { instanceId: "claude", model: claude.models.default } }, 201)).bot;
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true });

    // The panel's answer is internally consistent and matches what a turn would mount.
    const caps = await api("GET", `/api/bots/${chief.id}/capabilities?threadId=${chief.threadId}`);
    expect(caps.browser.available).toBe(caps.browser.availableReason === "ready");
    expect(caps.browser.mounts).toBe(caps.browser.available); // Auto, nothing reached yet: readiness == mount
    expect(typeof caps.thisPc.shell.available).toBe("boolean");
    expect(typeof caps.thisPc.control.ready).toBe("boolean");
    await api("GET", "/api/bots/does-not-exist/capabilities", undefined, 404);
    // Turning this bot's browser off changes the single answer, with the reason.
    await api("PATCH", `/api/bots/${chief.id}`, { browser: false });
    const off = await api("GET", `/api/bots/${chief.id}/capabilities?threadId=${chief.threadId}`);
    expect(off.browser).toMatchObject({ mounts: false, available: false, availableReason: "bot-off" });

    // UX-12: a ready engine with no selected model is still listed; its models are not offered.
    if (existsSync(gate)) unlinkSync(gate);
    await runControlOmb(["send", "--bot", chief.id, "--task", chief.threadId, "--text", "list engines", "--url", fixture.info.url]);
    await expect.poll(() => existsSync(fixture.fixtureDumpPath), { timeout: 15_000 }).toBe(true);
    const token = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN as string;
    const catalog = await api("GET", "/api/internal/team-setup-catalog", undefined, 200, token);
    const codex = catalog.instances.find((item: any) => item.instanceId === "codex");
    expect(codex, "codex is ready and must be listed").toBeDefined();
    expect(codex).toMatchObject({ ready: true, modelsChosen: false });
    expect(codex.models.options).toEqual([]);
    expect(catalog.instances.find((item: any) => item.instanceId === "claude")).toMatchObject({ modelsChosen: true });
    // Listing is not authorisation: a Codex model nobody chose is still refused.
    const codexModel = instances.find((item: any) => item.instanceId === "codex").models.default;
    await api("POST", "/api/internal/team-setup-requests", { plan: { reason: "try an unselected engine", newTeams: [], operations: [
      { action: "create", key: "X", fields: { name: "X", title: "t", soul: "s", section: "Operations", modelSelection: { instanceId: "codex", model: codexModel } } }] } }, 400, token);
  } finally {
    writeFileSync(gate, "finish");
    await fixture.close(); await removeTempDir(gates);
  }
}, 120_000);
