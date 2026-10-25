import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createCollaborationFixture } from "./testing/collaboration-fixture.ts";

it("routes shared jobs through three native provider adapters with consent, both directions, no primary and no duplicate dispatch", async () => {
  const fixture = await createCollaborationFixture({ diverseProviders: true });
  const { api, launch, stop, homes } = fixture;
  try {
    const bots: any[] = [], groups: any[] = [];
    const names = ["Alice", "Bob", "Chris"];
    const models = ["fixture", "gpt-fake-default", "fixture/test"];
    for (let i = 0; i < 3; i++) {
      await launch(i);
      bots.push((await api(i, "/api/bots", { name: `${names[i]} worker`, modelSelection: { instanceId: "fixture", model: models[i] } })).bot);
      groups.push((await api(i, "/api/groups", { name: `Shared work ${i}`, memberIds: [bots[i].id], setup: { bulletin: "", defaultResponder: { kind: "mentions" } } })).group);
    }
    const groupId = (await api(0, "/api/collaboration/share", { localGroupId: groups[0].id, memberName: "Alice", includeHistory: false })).groupId;
    for (const i of [1, 2]) {
      const invitation = (await api(0, "/api/collaboration/invite", { groupId, role: "manager" })).invitation;
      await api(i, "/api/collaboration/join", { localGroupId: groups[i].id, memberName: names[i], invitation });
      await expect.poll(async () => (await api(i, "/api/collaboration")).groups[0]?.joining, { timeout: 25_000 }).toBeUndefined();
    }
    await expect.poll(async () => (await api(1, "/api/collaboration")).groups[0]?.members.filter((m: any) => m.active).length, { timeout: 25_000 }).toBe(3);
    const keys = (await api(0, "/api/collaboration")).groups[0].members;
    const key = (i: number) => keys.find((m: any) => m.name === names[i]).publicKey;
    const root = `/api/collaboration/${groupId}/execution`;
    const status = (i: number) => api(i, root);
    const grant = async (i: number, approval: boolean) => (await api(i, `${root}/grants`, { botId: bots[i].id, label: `${names[i]} account`, members: [0, 1, 2].filter(n => n !== i).map(key), approval, acknowledge: true })).id;
    const grants = [await grant(0, false), await grant(1, true), await grant(2, false)];
    const findTarget = async (from: number, owner: number) => {
      await expect.poll(async () => (await status(from)).peers.find((p: any) => p.publicKey === key(owner))?.targets.some((t: any) => t.id === grants[owner] && t.ready), { timeout: 40_000 }).toBe(true);
    };
    await findTarget(0, 1);
    const id = randomUUID(), text = "Return a short execution result; do not use tools.";
    const body = { id, ownerKey: key(1), targetId: grants[1], text };
    expect((await api(0, `${root}/requests`, body)).job.state).toBe("pending-approval");
    expect(existsSync(join(homes[1]!, "native-codex.json"))).toBe(false);
    await api(1, `${root}/decide`, { id, allow: true });
    await expect.poll(async () => (await status(0)).outgoing.find((j: any) => j.id === id)?.state, { timeout: 45_000 }).toBe("succeeded");
    const receipt = (await status(0)).outgoing.find((j: any) => j.id === id);
    expect(receipt).toMatchObject({ owner: "Bob", requester: "Alice", target: { driver: "codex", model: models[1] } });
    expect(receipt.result).toBeTruthy();
    expect(receipt.usage.input).toBeGreaterThan(0);
    expect(receipt.threadId).toBeUndefined();
    const native = JSON.parse(readFileSync(join(homes[1]!, "native-codex.json"), "utf8"));
    expect(native.calls.filter((c: any) => c.method === "turn/start")).toHaveLength(1);
    expect(native.calls.find((c: any) => c.method === "thread/start").params.model).toBe(models[1]);
    expect(existsSync(join(homes[0]!, "native-claude.json"))).toBe(false);
    await api(0, `${root}/requests`, body);
    expect(JSON.parse(readFileSync(join(homes[1]!, "native-codex.json"), "utf8")).calls.filter((c: any) => c.method === "turn/start")).toHaveLength(1);
    // Each execution is projected into a stable shared conversation on every peer.
    await expect.poll(async () => (await api(0, "/api/bots")).groups.find((g: any) => g.id === groups[0].id)?.tasks.some((t: any) => t.sharedTopicId === id), { timeout: 25_000 }).toBe(true);
    const room = (await api(0, "/api/bots")).groups.find((g: any) => g.id === groups[0].id).tasks.find((t: any) => t.sharedTopicId === id);
    await expect.poll(async () => (await api(0, `/api/threads/${room.threadId}/messages`)).messages.filter((m: any) => m.role === "bot" && m.shared?.remote).length, { timeout: 25_000 }).toBe(1);

    const execute = async (from: number, owner: number) => {
      await findTarget(from, owner);
      const jobId = randomUUID();
      await api(from, `${root}/requests`, { id: jobId, ownerKey: key(owner), targetId: grants[owner], text: `Native round trip ${names[from]} to ${names[owner]}` });
      await expect.poll(async () => (await status(from)).outgoing.find((j: any) => j.id === jobId)?.state, { timeout: 45_000 }).toBe("succeeded");
      return (await status(from)).outgoing.find((j: any) => j.id === jobId);
    };
    expect((await execute(1, 0)).target.driver).toBe("claudeAgent");
    expect(existsSync(join(homes[0]!, "native-claude.json"))).toBe(true);
    await stop(0);
    expect((await execute(1, 2)).target.driver).toBe("opencodeGo");
    const acpTurns = readFileSync(join(homes[2]!, "native-acp.json.prompts.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(acpTurns).toHaveLength(1);
    expect(acpTurns[0].model).toBe(models[2]);
    // Pending work can be cancelled remotely and must never start afterwards.
    await findTarget(2, 1);
    const pending = randomUUID();
    await api(2, `${root}/requests`, { id: pending, ownerKey: key(1), targetId: grants[1], text: "Never execute this cancelled request" });
    await api(2, `${root}/cancel`, { id: pending, incoming: false });
    expect((await status(1)).incoming.find((j: any) => j.id === pending).state).toBe("cancelled");
    await api(1, `${root}/revoke`, { id: grants[1] });
    expect((await execute(1, 2)).owner).toBe("Chris");
    await stop(2); await launch(2);
    expect((await status(2)).incoming.filter((j: any) => j.state === "succeeded")).toHaveLength(2);
  } catch (error) {
    fixture.saveEvidence(join(process.env.OMB_E2E_ARTIFACT_DIR ?? "output/shared-execution-e2e", "logs"));
    throw error;
  } finally { await fixture.close(); }
}, 300_000);
