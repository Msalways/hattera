import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createCollaborationFixture } from "../server/testing/collaboration-fixture.ts";
import { launchCdpBrowser } from "./testing/cdp-browser.ts";

const executable = process.env.OMB_VERIFY_BROWSER_CHROME;
if (!executable || !existsSync(executable)) throw new Error("Run npm run test:e2e to prepare the isolated browser first.");
const artifacts = resolve(process.env.OMB_E2E_ARTIFACT_DIR ?? "output/e2e/collaboration-ui");
const fixture = await createCollaborationFixture();
const panel = 'section[aria-label="Share this group"]';
const checks: string[] = [], screenshots: string[] = [];
let browser: Awaited<ReturnType<typeof launchCdpBrowser>> | undefined;
const pages: Awaited<ReturnType<NonNullable<typeof browser>["page"]>>[] = [];
let stage = "startup";
const checkpoint = (name: string) => { stage = name; console.error(`Collaboration browser: ${name}`); };

try {
  const groups: Array<{ id: string; name: string }> = [];
  for (let index = 0; index < 3; index++) {
    await fixture.launch(index);
    const bot = (await fixture.api(index, "/api/bots", { name: `Local browser bot ${index}`, modelSelection: { instanceId: "fixture", model: "fixture" } })).bot;
    groups.push((await fixture.api(index, "/api/groups", { name: `Browser group ${index}`, memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "mentions" } } })).group);
  }
  browser = await launchCdpBrowser(executable, join(fixture.directory, "browser-profile"));
  for (let index = 0; index < 3; index++) {
    const page = await browser.page(); pages.push(page);
    await page.send("Page.navigate", { url: fixture.urls[index] });
    await page.send("Page.bringToFront");
    await page.wait(() => page.evaluate('!!document.querySelector("[data-sidebar]")'), "app shell");
    // Dismiss onboarding through its controls; no injected store or mocked UI.
    for (let attempt = 0; attempt < 10; attempt++) {
      await page.evaluate('Array.from(document.querySelectorAll("button")).find(item => item.textContent.trim() === "Skip tour")?.click()');
      if (attempt > 2 && await page.evaluate('!document.querySelector("[data-tour-card]") && !document.querySelector(".welcome-card")')) break;
      await new Promise(done => setTimeout(done, 400));
    }
    await page.click(`[data-sidebar-group-row="${groups[index]!.id}"]`);
    await page.wait(() => page.evaluate('!!document.querySelector(\'button[aria-label="Share this group"]\')'), "sharing control");
  }
  const open = async (index: number) => { await pages[index]!.click('button[aria-label="Share this group"]'); await pages[index]!.wait(() => pages[index]!.evaluate(`!!document.querySelector(${JSON.stringify(panel)})`), "sharing panel"); };
  const close = async (index: number) => { await pages[index]!.click(`${panel} button[aria-label="Close"]`); };
  const waitMember = async (index: number, name: string) => pages[index]!.wait(async () => {
    const status = (await fixture.api(index, "/api/collaboration")).groups.find((value: { localGroupId: string }) => value.localGroupId === groups[index]!.id);
    return status && !status.joining && status.members.some((member: { name: string; active: boolean }) => member.name === name && member.active);
  }, `active ${name} membership`, 25_000);
  checkpoint("start sharing through UI");
  await open(0);
  await pages[0]!.wait(() => pages[0]!.evaluate(`!!document.querySelector('${panel} input[autocomplete=name]')`), "sharing form");
  assert.equal(await pages[0]!.evaluate(`document.querySelector('${panel} input[type=checkbox]').checked`), false);
  await pages[0]!.fill(`${panel} input[autocomplete=name]`, "Alice");
  await pages[0]!.button("Start sharing this group", panel);
  await waitMember(0, "Alice"); checks.push("share-ui-history-consent");
  await pages[0]!.wait(() => pages[0]!.evaluate(`!!Array.from(document.querySelectorAll('${panel} button')).find(item => item.textContent.trim() === 'Create invitation')`), "invitation controls");
  await pages[0]!.click(`${panel} input[type=checkbox]`);
  await pages[0]!.button("Create invitation", panel);
  const invitation = await pages[0]!.wait(() => pages[0]!.evaluate(`document.querySelector('${panel} textarea[readonly]')?.value`), "manager invitation");
  checkpoint("join through UI");
  await open(1);
  await pages[1]!.wait(() => pages[1]!.evaluate(`!!document.querySelector('${panel} input[autocomplete=name]')`), "join form");
  await pages[1]!.fill(`${panel} input[autocomplete=name]`, "Bob");
  await pages[1]!.fill(`${panel} textarea`, invitation);
  await pages[1]!.button("Join with invitation", panel);
  await waitMember(1, "Bob"); checks.push("invitation-ui-consent-and-join");
  await close(0); await close(1);
  checkpoint("creator offline; second manager invites through UI");
  await fixture.stop(0); await open(1);
  await pages[1]!.wait(() => pages[1]!.evaluate(`!!Array.from(document.querySelectorAll('${panel} button')).find(item => item.textContent.trim() === 'Create invitation')`), "offline manager");
  await pages[1]!.button("Create invitation", panel);
  const secondInvitation = await pages[1]!.wait(() => pages[1]!.evaluate(`document.querySelector('${panel} textarea[readonly]')?.value`), "second invitation");
  await open(2);
  await pages[2]!.wait(() => pages[2]!.evaluate(`!!document.querySelector('${panel} input[autocomplete=name]')`), "third join form");
  await pages[2]!.fill(`${panel} input[autocomplete=name]`, "Chris"); await pages[2]!.fill(`${panel} textarea`, secondInvitation);
  await pages[2]!.button("Join with invitation", panel); await waitMember(2, "Chris");
  checks.push("creator-offline-ui-invitation"); await close(1); await close(2);
  const send = async (index: number, text: string) => {
    await pages[index]!.fill('textarea[aria-label^="Message"]', text);
    await pages[index]!.wait(() => pages[index]!.evaluate('!!document.querySelector(\'button[aria-label="Send message"]:not([disabled])\')'), "composer send");
    await pages[index]!.click('button[aria-label="Send message"]');
  };
  checkpoint("bidirectional browser messages without a primary");
  await send(1, "Bob browser offline creator message");
  await pages[2]!.wait(() => pages[2]!.evaluate('document.querySelector("main")?.innerText.includes("Bob browser offline creator message")'), "shared conversation opened on recipient", 25_000);
  await send(2, "Chris browser concurrent message");
  for (const index of [1, 2]) await pages[index]!.wait(() => pages[index]!.evaluate('document.querySelector("main")?.innerText.includes("Bob browser offline creator message") && document.querySelector("main")?.innerText.includes("Chris browser concurrent message")'), "both shared messages rendered", 25_000);
  checks.push("bidirectional-ui-messages-without-primary");
  checkpoint("owner grants a provider through UI; remote request waits for approval");
  const execution = 'section[aria-label="Shared execution"]';
  const manage = async (index: number) => {
    await pages[index]!.send("Page.bringToFront");
    await pages[index]!.wait(() => pages[index]!.evaluate(`!!document.querySelector('${execution} details')`), "execution panel");
    if (!await pages[index]!.evaluate(`document.querySelector('${execution} details').open`)) await pages[index]!.click(`${execution} summary`);
  };
  await manage(2);
  await pages[2]!.click(`${execution} [data-execution-share] summary`);
  await pages[2]!.wait(() => pages[2]!.evaluate(`Array.from(document.querySelectorAll('${execution} fieldset label')).some(label=>label.textContent.trim().startsWith('Bob ·'))`), "explicit member permission");
  assert.equal(await pages[2]!.evaluate(`document.querySelector('${execution} details form > label:nth-last-of-type(2) input').checked`), true);
  assert.equal(await pages[2]!.evaluate(`document.querySelector('${execution} details form > label:last-of-type input').checked`), false);
  await pages[2]!.fill(`${execution} input[aria-label="Shared provider name"]`, "Chris shared account");
  const bobCheckbox = await pages[2]!.evaluate(`(() => { const input=Array.from(document.querySelectorAll('${execution} fieldset label')).find(label=>label.textContent.trim().startsWith('Bob ·')).querySelector('input'); input.setAttribute('data-verify-bob',''); return '[data-verify-bob]'; })()`);
  await pages[2]!.click(bobCheckbox);
  await pages[2]!.click(`${execution} details form > label:last-of-type input`);
  await pages[2]!.button("Share selected bot", execution);
  await pages[2]!.wait(() => pages[2]!.evaluate(`document.querySelector('${execution} details')?.innerText.includes('Revoke execution access')`), "owner grant saved");
  checks.push("explicit-per-person-provider-grant-ui");
  await pages[1]!.send("Page.bringToFront");
  const choice = await pages[1]!.wait(() => pages[1]!.evaluate(`Array.from(document.querySelectorAll('${execution} select[aria-label="Run with"] option')).find(option=>option.textContent.includes('Chris shared account')&&!option.disabled)?.value`), "qualified remote target", 40_000);
  await pages[1]!.evaluate(`(() => { const select=document.querySelector('${execution} select[aria-label="Run with"]'); select.value=${JSON.stringify(choice)}; select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await pages[1]!.fill(`${execution} textarea[aria-label="Task for the shared provider"]`, "Run this with Chris's configured provider");
  await pages[1]!.button("Send execution request", execution);
  await manage(2);
  await pages[2]!.wait(() => pages[2]!.evaluate(`document.querySelector('${execution}')?.innerText.includes('Waiting for owner approval')`), "owner approval request", 25_000);
  assert.equal(existsSync(join(fixture.homes[2]!, "native-claude.json")), false, "Execution started before owner approval");
  await pages[2]!.evaluate(`Array.from(document.querySelectorAll('${execution} [role=status]')).find(item=>item.textContent==='Waiting for owner approval').closest('li').scrollIntoView({block:'center'})`);
  const pendingScreenshot = join(artifacts, "shared-provider-owner-approval.png"); await pages[2]!.screenshot(pendingScreenshot); screenshots.push(pendingScreenshot);
  await pages[2]!.button("Approve and run", execution);
  await pages[2]!.wait(() => pages[2]!.evaluate(`Array.from(document.querySelectorAll('${execution} [role=status]')).some(item=>item.textContent==='Completed')`), "native execution completion", 40_000);
  assert.equal(existsSync(join(fixture.homes[2]!, "native-claude.json")), true, "Owner's native provider never ran");
  await manage(1);
  await pages[1]!.wait(() => pages[1]!.evaluate(`document.querySelector('${execution}')?.innerText.includes('Remote link fixture')`), "remote result rendered", 30_000);
  await pages[1]!.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await pages[1]!.evaluate(`Array.from(document.querySelectorAll('${execution} [role=status]')).find(item=>item.textContent==='Completed').closest('li').scrollIntoView({block:'center'})`);
  const executionPhone = join(artifacts, "shared-provider-result-phone.png"); await pages[1]!.screenshot(executionPhone); screenshots.push(executionPhone);
  assert.equal(await pages[1]!.evaluate(`(() => { const node=document.querySelector('${execution}'), box=node.getBoundingClientRect(); return box.left>=0 && box.right<=innerWidth && node.scrollWidth<=node.clientWidth+1 && document.documentElement.scrollWidth<=innerWidth+1; })()`), true);
  checks.push("owner-approval-native-execution-result-and-phone-ui");
  // Returning to the local option must restore the ordinary group composer.
  await pages[1]!.evaluate(`(() => { const select=document.querySelector('${execution} select[aria-label="Run with"]'); select.value=''; select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await pages[1]!.wait(() => pages[1]!.evaluate('!!document.querySelector(\'textarea[aria-label^="Message"]\')'), "local composer restored");
  await pages[1]!.click(`${execution} summary`);
  checkpoint("phone shared roster and bot profiles");
  await pages[1]!.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await open(1);
  await pages[1]!.wait(() => pages[1]!.evaluate(`document.querySelector(${JSON.stringify(panel)})?.innerText.includes('Chris')`), "shared roster");
  await pages[1]!.wait(() => pages[1]!.evaluate(`document.querySelector(${JSON.stringify(panel)})?.innerText.includes('Local browser bot 2')`), "peer bot profile");
  assert.equal(await pages[1]!.evaluate(`(() => { const node = document.querySelector(${JSON.stringify(panel)}); const box = node.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && node.scrollWidth <= node.clientWidth + 1; })()`), true);
  const phone = join(artifacts, "shared-group-phone.png"); await pages[1]!.screenshot(phone); screenshots.push(phone); checks.push("phone-roster-and-bot-profiles");
  await close(1);
  checkpoint("restart and browser reconnect");
  await fixture.stop(1); await fixture.launch(1);
  await pages[1]!.send("Page.navigate", { url: fixture.urls[1] });
  await pages[1]!.wait(() => pages[1]!.evaluate(`!!document.querySelector('[data-sidebar-group-row="${groups[1]!.id}"]')`), "restarted sidebar");
  await pages[1]!.click('button[aria-label="Open bot list"]');
  await pages[1]!.click(`[data-sidebar-group-row="${groups[1]!.id}"]`);
  await pages[1]!.wait(() => pages[1]!.evaluate('document.querySelector("main")?.innerText.includes("Chris browser concurrent message")'), "durable shared history");
  assert.equal(await pages[1]!.evaluate('(document.querySelector("main").innerText.match(/Chris browser concurrent message/g) ?? []).length'), 1, "Restart duplicated a shared message");
  checks.push("restart-ui-reconnect-without-duplicate");
  checkpoint("pause and resume through UI");
  await open(1); await pages[1]!.wait(() => pages[1]!.evaluate(`!!Array.from(document.querySelectorAll('${panel} button')).find(item => item.textContent.trim() === 'Pause this device')`), "pause control");
  await pages[1]!.button("Pause this device", panel);
  await pages[1]!.wait(async () => (await fixture.api(1, "/api/collaboration")).groups[0]?.enabled === false, "sharing paused");
  await pages[1]!.button("Resume sharing", panel);
  await pages[1]!.wait(async () => (await fixture.api(1, "/api/collaboration")).groups[0]?.enabled === true, "sharing resumed"); await close(1); checks.push("pause-resume-ui");
  checkpoint("creator returns and revokes through UI");
  await fixture.launch(0); await pages[0]!.send("Page.navigate", { url: fixture.urls[0] });
  await pages[0]!.wait(() => pages[0]!.evaluate(`!!document.querySelector('[data-sidebar-group-row="${groups[0]!.id}"]')`), "returned creator");
  await pages[0]!.click(`[data-sidebar-group-row="${groups[0]!.id}"]`); await waitMember(0, "Chris"); await open(0);
  await pages[0]!.wait(() => pages[0]!.evaluate(`!!Array.from(document.querySelectorAll('${panel} li')).find(item => item.innerText.includes('Bob') && item.querySelector('button'))`), "remove member");
  await pages[0]!.button("Remove", panel);
  await pages[0]!.button("Remove membership", panel);
  await pages[0]!.wait(async () => (await fixture.api(0, "/api/collaboration")).groups[0]?.members.some((member: { name: string; active: boolean }) => member.name === "Bob" && !member.active), "revocation persisted");
  const revoked = join(artifacts, "revoked-group-desktop.png"); await pages[0]!.screenshot(revoked); screenshots.push(revoked);
  await close(0); await send(1, "Removed browser message must stay local");
  // The creator was offline, so its existing exponential retry can take
  // up to one minute. Require an actual refusal, not an old offline error.
  await pages[1]!.wait(async () => {
    const status = (await fixture.api(1, "/api/collaboration")).groups[0];
    // A surviving member may deliver the revocation before the removed peer
    // receives an HTTP refusal from the creator. Both end its authority.
    return /not accepted/.test(status?.error ?? "") || status?.members.some((member: {name:string;active:boolean}) => member.name === "Bob" && !member.active);
  }, "removed peer refused or learned its revocation", 75_000);
  assert.equal(await pages[0]!.evaluate('document.querySelector("main")?.innerText.includes("Removed browser message must stay local")'), false);
  checks.push("ui-revocation-refuses-further-messages");
  console.log(JSON.stringify({ ok: true, simulatedProviders: true, simulatedPeerTransport: true, accountAuthorized: false, checks, screenshots }, null, 2));
} catch (error) {
  fixture.saveEvidence(join(artifacts, "logs"));
  for (const [index, page] of pages.entries()) await page.screenshot(join(artifacts, `failure-peer-${index}.png`)).catch(() => {});
  throw new Error(`Collaboration UI failed during ${stage}`, { cause: error });
} finally { await browser?.close(); await fixture.close(); }
