import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { launchCdpBrowser } from "./testing/cdp-browser.ts";

assert.ok(process.argv.length === 3 || process.argv.length === 4 && process.argv[3] === "--execute", "Usage: verify-collaboration-container-ui.ts report.json [--execute]");
const manifest = resolve(process.argv[2] ?? "");
const report = JSON.parse(readFileSync(manifest, "utf8"));
assert.equal(report.ok, true, "Complete the native memory checks first.");
const executable = process.env.OMB_VERIFY_BROWSER_CHROME ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
assert.ok(existsSync(executable), "Set OMB_VERIFY_BROWSER_CHROME to a Chromium browser.");
const links = (await promisify(execFile)(process.execPath, ["--experimental-strip-types", "scripts/verify-collaboration-containers.ts", "--links", manifest], { windowsHide: true })).stdout.trim().split(/\r?\n/).map(line => line.slice(line.indexOf(": ") + 2));
const browser = await launchCdpBrowser(executable, resolve(".omb-scratch", `${report.runId}-browser-${randomUUID().slice(0,8)}`));
const screenshots: string[] = [];
const pages: Awaited<ReturnType<typeof browser.page>>[] = [];
try {
  for (const [index, person] of ["Alice", "Bob", "Chris"].entries()) {
    const page = await browser.page();
    pages.push(page);
    if (index === 0) {
      const invalid = new URL(links[index]!);
      invalid.hash = "code=0000-0000-0000";
      await page.send("Page.navigate", { url: invalid.href });
      await page.wait(() => page.evaluate('!!document.querySelector("#pair-code:not([disabled])")&&!!document.querySelector("[role=alert]")'), "invalid CLI link fails closed to pairing form", 45_000);
      assert.equal(await page.evaluate('!!document.querySelector("[data-sidebar]")'), false);
    }
    await page.send("Page.navigate", { url: links[index] });
    await page.send("Page.bringToFront");
    await page.wait(() => page.evaluate('!!document.querySelector("[data-sidebar]")'), "CLI link opens app without login", 45_000);
    assert.equal(await page.evaluate('location.pathname==="/"&&!location.hash&&!location.search'), true, "CLI credential is removed after connection");
    // Existing profiles can have completed onboarding. When a tour is offered,
    // dismiss its visible control, including delayed account hydration.
    for (let attempt = 0; attempt < 14; attempt++) {
      const visible = await page.evaluate('Array.from(document.querySelectorAll("button")).some(item=>item.textContent.trim()==="Skip tour"&&item.getClientRects().length)');
      if (visible) await page.button("Skip tour");
      await new Promise(done => setTimeout(done, 400));
    }
    await page.wait(() => page.evaluate('!document.querySelector("[data-tour-card]")&&!document.querySelector(".welcome-card")'), "onboarding dismissed");
    await page.wait(() => page.evaluate('document.querySelector("[data-chat-route]")?.textContent.includes("Next request: this server")&&!!Array.from(document.querySelectorAll("[data-chat-route] button")).find(item=>item.textContent.includes("OpenCode container team"))'), "local account route and team shortcut");
    await page.button("Open team: OpenCode container team", "[data-chat-route]");
    await page.wait(() => page.evaluate('!!document.querySelector(\'button[aria-label="Share this group"]\')'), "group controls");
    // The existing feature walkthrough can start after the brand welcome tour.
    // Dismiss visible controls and wait for its delayed hydration before capture.
    for (let attempt = 0; attempt < 14; attempt++) {
      const visible = await page.evaluate('Array.from(document.querySelectorAll("button")).some(item=>item.textContent.trim()==="Skip tour"&&item.getClientRects().length)');
      if (visible) await page.button("Skip tour");
      await new Promise(done => setTimeout(done, 400));
    }
    await page.wait(() => page.evaluate('!Array.from(document.querySelectorAll("button")).some(item=>item.textContent.trim()==="Skip tour"&&item.getClientRects().length)'), "all first-visit guides dismissed");
    await page.click('button[aria-label="Share this group"]');
    await page.wait(() => page.evaluate('(() => {const text=document.querySelector(\'section[aria-label="Share this group"]\')?.innerText; return ["Alice","Bob","Chris"].every(name=>text?.includes(name));})()'), "three real group memberships");
    const people = join(report.directory, `${person.toLowerCase()}-people.png`);
    await page.screenshot(people); screenshots.push(people);
    await page.click('section[aria-label="Share this group"] button[aria-label="Close"]');
    await page.wait(() => page.evaluate('document.querySelector(\'select[aria-label="Run with"]\')?.options.length>=3'), "two colleague provider choices", 45_000);
    assert.equal(await page.evaluate('document.querySelector("[data-execution-route]")?.textContent.includes("this server")'), true);
    const owner = ["Bob", "Chris", "Alice"][index]!;
    await page.wait(() => page.evaluate(`Array.from(document.querySelector('select[aria-label="Run with"]')?.options??[]).some(item=>item.textContent.startsWith(${JSON.stringify(owner + " (")})&&!item.disabled)`), "selected teammate's account has finished checking", 90_000);
    // Select a real teammate account through the browser's native select control.
    await page.evaluate(`(() => { const select=document.querySelector('select[aria-label="Run with"]');const option=Array.from(select.options).find(item=>item.textContent.startsWith(${JSON.stringify(owner + " (")}));if(!option||option.disabled)throw new Error('Teammate unavailable');select.focus();select.selectedIndex=option.index;select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    await page.wait(() => page.evaluate(`document.querySelector('[data-execution-route]')?.textContent.includes(${JSON.stringify(owner + "'s server")})`), "selected teammate owns next request");
    const route = join(report.directory, `${person.toLowerCase()}-route.png`);
    await page.screenshot(route); screenshots.push(route);
    await page.click('section[aria-label="Shared execution"] > details > summary');
    const executions = join(report.directory, `${person.toLowerCase()}-executions.png`);
    await page.screenshot(executions); screenshots.push(executions);
    await page.button("Open shared conversation", "[data-execution-manage]");
    await page.wait(() => page.evaluate('document.querySelector("[data-execution-receipt]")?.textContent.includes("This shared request:")&&document.querySelector("[data-execution-receipt]")?.textContent.includes("Account profile:")'), "saved request shows actual owner and account");
    if (index === 0) {
      await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      await page.wait(() => page.evaluate('(() => {const box=document.querySelector("[data-group-execution]")?.getBoundingClientRect();return box&&box.left>=0&&box.right<=innerWidth;})()'), "mobile routing panel fits screen");
      await page.evaluate('document.querySelector("[data-group-execution]").scrollTop=0');
      const mobile = join(report.directory, "alice-route-mobile.png");
      await page.screenshot(mobile); screenshots.push(mobile);
    }
    console.log(`${person}: pairing, people and shared providers passed`);
  }
  if (process.argv[3] === "--execute") {
    const api = async (index: number, path: string) => {
      const source = `const r=await fetch(${JSON.stringify(`http://127.0.0.1:8799${path}`)});if(!r.ok)throw Error('Fixture API refused');console.log(JSON.stringify(await r.json()));`;
      return JSON.parse((await promisify(execFile)("docker", ["exec", report.containers[index], "node", "--input-type=module", "-e", source], { windowsHide: true, timeout: 30_000 })).stdout);
    };
    const endpoint = `/api/collaboration/${report.groupId}/execution`;
    const alice = pages[0]!, bob = pages[1]!;
    const memory = (await api(1, `/api/bots/${report.bots[1].id}/memory`)).text;
    const expected = /routing passphrase: (\S+)/.exec(memory)?.[1];
    assert.ok(expected, "Bob must have a private memory fact");
    const nonce = randomUUID(), request = `Browser verification ${nonce}. Recall the Project Cinder routing passphrase from your own persistent MEMORY.md. Reply with that passphrase. Do not change memory.`;
    assert.ok(!request.includes(expected));
    await alice.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await alice.evaluate('document.querySelector("[data-group-execution]").scrollTop=0');
    await alice.fill('[data-group-execution] textarea', request);
    await alice.button("Send execution request", "[data-group-execution]");
    const owned = await bob.wait(async () => (await api(1, endpoint)).incoming.find((job: any) => job.text === request), "Bob receives the browser's request", 90_000);
    assert.equal(owned.state, "pending-approval");
    const markJob = `(() => {const card=Array.from(document.querySelectorAll('[data-execution-manage] li')).find(item=>item.textContent.includes(${JSON.stringify(nonce)}));if(!card)return false;card.setAttribute('data-verify-job','browser');return true;})()`;
    await bob.send("Page.bringToFront");
    await bob.evaluate('document.querySelector("[data-execution-manage]").open=true');
    await bob.wait(() => bob.evaluate(markJob), "owner's approval card", 30_000);
    await bob.evaluate('document.querySelector(\'[data-verify-job="browser"]\').scrollIntoView({block:"center"})');
    const approval = join(report.directory, "bob-browser-approval.png");
    await bob.screenshot(approval); screenshots.push(approval);
    await bob.button("Approve and run", '[data-verify-job="browser"]');
    const completed = await alice.wait(async () => {
      const job = (await api(0, endpoint)).outgoing.find((value: any) => value.id === owned.id);
      if (["failed", "denied", "cancelled", "uncertain"].includes(job?.state)) throw new Error(`Browser execution ${job.state}: ${job.error ?? "No provider reply"}`);
      return job?.state === "succeeded" ? job : false;
    }, "Bob's live native OpenCode reply", 240_000);
    assert.ok(completed.result.includes(expected), "Only Bob's private memory contains the expected answer");
    assert.equal(completed.owner, "Bob"); assert.equal(completed.target.driver, "opencodeGo");
    assert.equal(completed.target.model, report.model);
    const incoming = (await api(1, endpoint)).incoming.filter((job: any) => job.id === owned.id);
    assert.equal(incoming.length, 1);
    const transcript = await api(1, `/api/threads/${incoming[0].threadId}/messages`);
    const nativeTurns = [...new Set(transcript.messages.filter((message: any) => message.turnSucceeded === true && message.turnId).map((message: any) => message.turnId))];
    assert.equal(nativeTurns.length, 1, "The browser request must dispatch exactly one native turn on Bob");
    for (const index of [0, 1, 2]) {
      assert.equal((await api(index, endpoint)).incoming.some((job: any) => job.id === owned.id), index === 1, "Only Bob owns the native execution");
      await pages[index]!.wait(async () => {
        const room = (await api(index, "/api/bots")).groups.find((group: any) => group.id === report.bots[index].groupId);
        const task = room.tasks.find((value: any) => value.sharedTopicId === owned.id);
        if (!task) return false;
        const view = await api(index, `/api/threads/${task.threadId}/messages`);
        return view.messages.filter((message: any) => message.role === "bot" && message.text?.includes(completed.result.trim())).length === 1;
      }, "all three teammates receive the reply once", 60_000);
    }
    await alice.evaluate('document.querySelector("[data-execution-manage]").open=true');
    await alice.wait(() => alice.evaluate(markJob), "Alice's completed request receipt");
    await alice.button("Open shared conversation", '[data-verify-job="browser"]');
    await alice.wait(() => alice.evaluate(`(() => {const text=document.querySelector('[data-execution-receipt]')?.textContent;return text?.includes(${JSON.stringify(completed.target.account)})&&text.includes('Completed');})()`), "completed account receipt on the actual conversation");
    await alice.evaluate('document.querySelector("[data-execution-manage]").open=false');
    await alice.wait(() => alice.evaluate(`document.body.innerText.includes(${JSON.stringify(nonce)})`), "the actual new shared conversation is visible");
    const result = join(report.directory, "alice-browser-live-result.png");
    await alice.screenshot(result); screenshots.push(result);
    report.browserExecution = { ok: true, id: owned.id, requester: completed.requester, owner: completed.owner, account: completed.target.account,
      driver: completed.target.driver, model: completed.target.model, container: report.containers[1], nativeThreadId: incoming[0].threadId,
      nativeTurns, result: completed.result, usage: completed.usage, approval: "owner clicked Approve in the browser", promptContainsExpectedFact: false, replicatedOnceToEachOfThreeMembers: true };
    console.log("Browser request: Alice → Bob's OpenCode → Bob approval → private memory reply on all three installations passed");
  }
  report.browser = { ok: true, pairedInstallations: 3, automaticCliConnection: true, invalidCliLinkDenied: true, freshLinkAfterInvalidAttempt: true, visibleAccountRouting: true, savedRequestOwnerVisible: true, mobileRouteFits: true, peoplePerGroup: 3, colleagueProvidersPerInstallation: 2, screenshots };
  writeFileSync(manifest, JSON.stringify(report, null, 2) + "\n");
} catch (error) {
  report.browser = { ok: false, error: error instanceof Error ? error.message : String(error), screenshots };
  (report.browserAttempts ??= []).push({ ...report.browser, at: new Date().toISOString() });
  writeFileSync(manifest, JSON.stringify(report, null, 2) + "\n");
  throw error;
} finally { await browser.close(); }
