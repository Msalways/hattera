import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createCollaborationFixture } from "./testing/collaboration-fixture.ts";

it("three isolated application processes share existing groups, continue without the creator, restart and enforce revocation", async () => {
  const fixture = await createCollaborationFixture();
  const { homes, origins, urls, launch, api, stop } = fixture;
  try {
    for (let index = 0; index < 3; index++) await launch(index);
    const groups: Array<{ id: string; threadId: string }> = [];
    for (let index = 0; index < 3; index++) {
      expect(await api(index, "/api/private-network")).toMatchObject({ state: "connected", peerTransport: true, origin: origins[index] });
      const bot = (await api(index, "/api/bots", { name: `Local member ${index}`, modelSelection: { instanceId: "fixture", model: "fixture" } })).bot;
      const { group } = await api(index, "/api/groups", { name: `Local group ${index}`, memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "mentions" } } }); groups.push(group);
    }
    const shared = (await api(0, "/api/collaboration/share", { localGroupId: groups[0]!.id, memberName: "Alice", includeHistory: false })).groupId;
    const invitation = (await api(0, "/api/collaboration/invite", { groupId: shared, role: "manager" })).invitation;
    await api(1, "/api/collaboration/join", { localGroupId: groups[1]!.id, memberName: "Bob", invitation });
    await expect.poll(async () => (await api(1, "/api/collaboration")).groups[0]?.joining, { timeout: 20_000 }).toBeUndefined();
    const fromBob = (await api(1, "/api/collaboration/invite", { groupId: shared, role: "member" })).invitation;
    await stop(0);
    await api(2, "/api/collaboration/join", { localGroupId: groups[2]!.id, memberName: "Chris", invitation: fromBob });
    await expect.poll(async () => (await api(2, "/api/collaboration")).groups[0]?.joining, { timeout: 20_000 }).toBeUndefined();
    await api(1, `/api/groups/${groups[1]!.id}/messages`, { text: "Bob without a permanent host", sendId: "peer-fixture-bob" });
    await api(2, `/api/groups/${groups[2]!.id}/messages`, { text: "Chris without a permanent host", sendId: "peer-fixture-chris" });
    const sharedText = async (index: number) => {
      const data = await api(index, "/api/bots");
      const group = data.groups.find((value: { id: string }) => value.id === groups[index]!.id);
      const results: string[] = [];
      for (const task of group.tasks) {
        const page = await api(index, `/api/threads/${task.threadId}/messages`);
        for (const message of page.messages) if (message.shared) results.push(message.text);
      }
      return results;
    };
    for (const index of [1, 2]) await expect.poll(() => sharedText(index), { timeout: 25_000 }).toEqual(expect.arrayContaining(["Bob without a permanent host", "Chris without a permanent host"]));
    await stop(1); await launch(1);
    await expect.poll(() => sharedText(1), { timeout: 20_000 }).toEqual(expect.arrayContaining(["Bob without a permanent host", "Chris without a permanent host"]));
    expect((await sharedText(1)).filter(text => text === "Chris without a permanent host")).toHaveLength(1);
    await launch(0);
    await expect.poll(() => sharedText(0), { timeout: 25_000 }).toEqual(expect.arrayContaining(["Bob without a permanent host", "Chris without a permanent host"]));
    writeFileSync(join(homes[0]!, "local-only.txt"), "This must never be downloadable through a peer's text.");
    await api(0, `/api/groups/${groups[0]!.id}`, { cwd: homes[0] }, "PATCH");
    await api(1, `/api/groups/${groups[1]!.id}/messages`, { text: "@Local member 1 Produce a link fixture", sendId: "peer-fixture-file-boundary" });
    await expect.poll(() => sharedText(0), { timeout: 35_000 }).toEqual(expect.arrayContaining([expect.stringContaining("Remote link fixture")]));
    let remoteFileMessage: { threadId: string; id: string } | undefined;
    const room = (await api(0, "/api/bots")).groups.find((value: { id: string }) => value.id === groups[0]!.id);
    for (const task of room.tasks) {
      const message = (await api(0, `/api/threads/${task.threadId}/messages`)).messages.find((value: { role: string; text?: string; shared?: { remote: boolean } }) => value.role === "bot" && value.shared?.remote && value.text?.includes("Remote link fixture"));
      if (message) remoteFileMessage = { threadId: task.threadId, id: message.id };
    }
    expect(remoteFileMessage).toBeDefined();
    const fileRequest = await fetch(`${urls[0]}/api/threads/${remoteFileMessage!.threadId}/messages/${remoteFileMessage!.id}/file`, { method: "POST", headers: { "content-type": "application/json", origin: urls[0]! }, body: JSON.stringify({ path: join(homes[0]!, "local-only.txt") }) });
    expect(fileRequest.status).toBe(403);
    expect(await fileRequest.text()).not.toContain("This must never");
    const status = (await api(0, "/api/collaboration")).groups[0];
    const bob = status.members.find((member: { name: string }) => member.name === "Bob");
    await api(0, "/api/collaboration/revoke", { groupId: shared, grantId: bob.grantId });
    const lineCount = readFileSync(join(homes[0]!, "collaboration", `${shared}.jsonl`), "utf8").split("\n").length;
    await api(1, `/api/groups/${groups[1]!.id}/messages`, { text: "Blocked after removal", sendId: "peer-fixture-removed" });
    await expect.poll(async () => (await api(1, "/api/collaboration")).groups[0]?.error, { timeout: 20_000 }).toMatch(/not accepted/);
    expect(readFileSync(join(homes[0]!, "collaboration", `${shared}.jsonl`), "utf8").split("\n")).toHaveLength(lineCount);
    const denied = await fetch(urls[0] + "/api/collaboration", { headers: { "x-forwarded-for": "100.65.0.2" } }); expect([401, 403]).toContain(denied.status);
    const forged = await fetch(urls[0] + "/api/collaboration/peer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ groupId: shared }) }); expect(forged.status).toBe(403);
    expect(JSON.stringify(await api(0, "/api/collaboration"))).not.toContain(invitation);
    // Damaging the separate peer identity must never take ordinary app
    // startup down or silently issue a replacement identity for old grants.
    await stop(0);
    const identityPath = join(homes[0]!, "collaboration/identity.json");
    unlinkSync(identityPath);
    await launch(0);
    expect((await api(0, "/api/collaboration")).groups[0]).toMatchObject({ blocked: true });
    expect(existsSync(identityPath)).toBe(false);
    expect((await api(0, "/api/bots")).groups.some((value: { id: string }) => value.id === groups[0]!.id)).toBe(true);
  } catch (error) {
    if (process.env.OMB_E2E_ARTIFACT_DIR) fixture.saveEvidence(join(process.env.OMB_E2E_ARTIFACT_DIR, "collaboration-http"));
    throw error;
  } finally { await fixture.close(); }
}, 240_000);
