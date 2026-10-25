// Records real browser interactions in the existing disposable three-container fixture.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { launchCdpBrowser } from "./testing/cdp-browser.ts";

assert.equal(process.argv.length, 3, "Usage: record-collaboration-demo.ts output/hattera-team-<id>/report.json");
const manifest = resolve(process.argv[2]!);
const report = JSON.parse(await readFile(manifest, "utf8"));
assert.equal(report.ok, true, "Complete the live container verification first.");
const exec = promisify(execFile), pause = (ms: number) => new Promise(done => setTimeout(done, ms));
// The link command validates exact fixture names, labels, loopback mappings and CLI mode.
const links = (await exec(process.execPath, ["--experimental-strip-types", "scripts/verify-collaboration-containers.ts", "--links", manifest], { windowsHide: true, timeout: 360_000 })).stdout.trim().split(/\r?\n/).map(line => line.slice(line.indexOf(": ") + 2));
assert.equal(links.length, 3);
const persons = ["Alice", "Bob", "Chris"];
const directory = resolve(".omb-scratch", `${report.runId}-recording-${randomUUID().slice(0, 8)}`);
const browsers: Awaited<ReturnType<typeof launchCdpBrowser>>[] = [];
const pages: Awaited<ReturnType<(typeof browsers)[number]["page"]>>[] = [];
const frames: {timeMs: number}[] = [], phases: {timeMs:number;title:string;detail:string}[] = [];
const evidence: Record<string, any> = { ok: false, runId: report.runId, recordedAt: new Date().toISOString(), directory,
  transport: "Simulated Tailscale transport; real signed/encrypted application packets over Docker bridge",
  provider: "Real OpenCode 1.19.0 and public free MiMo model; separate profiles, not paid vendor identities" };
const api = async (index: number, path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
  const code = `const r=await fetch(${JSON.stringify(`http://127.0.0.1:8799${path}`)},{method:${JSON.stringify(method)},headers:{'content-type':'application/json'},${body === undefined ? "" : `body:${JSON.stringify(JSON.stringify(body))},`}signal:AbortSignal.timeout(20000)});const value=await r.json();if(!r.ok)throw Error(JSON.stringify(value));console.log(JSON.stringify(value));`;
  return JSON.parse((await exec("docker", ["exec", report.containers[index], "node", "--input-type=module", "-e", code], { windowsHide: true, timeout: 35_000 })).stdout);
};
let recording = false, capture: Promise<void> | undefined, started = 0, ended = 0, captureError: unknown;
const phase = (title: string, detail: string) => { phases.push({timeMs:Date.now()-started,title,detail}); console.log(title); };
const sharing = 'section[aria-label="Share this group"]';
const dismissTour = async (page: (typeof pages)[number]) => {
  for (let attempt = 0; attempt < 14; attempt++) {
    if (await page.evaluate('Array.from(document.querySelectorAll("button")).some(item=>item.textContent.trim()==="Skip tour"&&item.getClientRects().length)')) await page.button("Skip tour");
    await pause(400);
  }
};
try {
  // Only isolated fixture state is prepared. All sharing and grants below use the UI.
  const groups: {id:string}[] = [];
  for (const index of [0, 1, 2]) groups.push((await api(index, "/api/groups", {name:"Recorded OpenCode team",memberIds:[report.bots[index].id],setup:{bulletin:"Three independent CLI installations",defaultResponder:{kind:"mentions"}}})).group);
  evidence.localGroupIds = groups.map(group => group.id);
  const memory = (await api(1, `/api/bots/${report.bots[1].id}/memory`)).text;
  const expected = /routing passphrase: (\S+)/.exec(memory)?.[1];
  assert.ok(expected, "Bob needs an owner-private memory fact.");
  for (const index of [0, 1, 2]) {
    const browser = await launchCdpBrowser(process.env.OMB_VERIFY_BROWSER_CHROME ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", join(directory, "profiles", persons[index]!.toLowerCase()));
    browsers.push(browser); const page = await browser.page(); pages.push(page);
    await mkdir(join(directory, persons[index]!.toLowerCase()), {recursive:true});
    await page.send("Emulation.setDeviceMetricsOverride", {width:640,height:900,deviceScaleFactor:1,mobile:false});
    // Use an invalid code to exercise recovery without a five-minute sleep.
    // The published recording used already-expired links from its original run.
    const stale = new URL(links[index]!); stale.hash = "code=0000-0000-0000";
    await page.send("Page.navigate", {url:stale.href});
    await page.wait(() => page.evaluate('!!document.querySelector("#pair-code:not([disabled])")&&!!document.querySelector("[role=alert]")'), "old code rejected", 45_000);
    assert.equal(await page.evaluate('!!document.querySelector("[data-sidebar]")'), false);
  }
  started = Date.now(); recording = true;
  phase("Invalid or expired launch links require fresh links", "Unavailable codes fail closed. The helper creates new one-use links and can open all three immediately.");
  capture = (async () => {
    try {
      let consecutiveDrops=0;
      while (recording) {
        const timeMs = Date.now()-started, index = frames.length;
        // Chromium may reject a screenshot during navigation. Keep the actual
        // timestamps and log dropped samples; never manufacture a replacement.
        let images;
        try {
          images=await Promise.all(pages.map(page => page.send("Page.captureScreenshot", {format:"jpeg",quality:78,captureBeyondViewport:false})));
          consecutiveDrops=0;
        } catch(error) {
          (evidence.droppedSamples??=[]).push({timeMs,error:String(error)});
          if(++consecutiveDrops>=3)throw error;
          await pause(500);continue;
        }
        await Promise.all(images.map((result, person) => writeFile(join(directory, persons[person]!.toLowerCase(), `frame-${String(index).padStart(6,"0")}.jpg`), Buffer.from(result.data,"base64"))));
        frames.push({timeMs}); await pause(Math.max(1, 500-(Date.now()-started-timeMs)));
      }
    } catch (error) { captureError = error; recording = false; console.error(`Capture failed: ${String(error)}`); }
  })();
  await pause(3500);
  phase("Fresh CLI launch: no GitHub login or manual code entry", "Each browser redeems its local launch link; normal authenticated sessions are retained.");
  await Promise.all([0, 1, 2].map(async index => {
    const page = pages[index]!;
    await page.send("Page.navigate", {url:links[index]});
    await page.wait(() => page.evaluate('!!document.querySelector("[data-sidebar]")'), "fresh CLI launch", 45_000);
    assert.equal(await page.evaluate('location.pathname==="/"&&!location.hash&&!location.search'),true);
    await dismissTour(page);
    await page.send("Page.reload");
    await page.wait(() => page.evaluate('!!document.querySelector("[data-sidebar]")'), "reload keeps authenticated session",45_000);
    await page.wait(()=>page.evaluate(`!!document.querySelector('[data-sidebar-group-row="${groups[index].id}"]')&&!!document.querySelector('[data-chat-route]')`),"server snapshot includes the new local group",45_000);
    await page.click('[data-mobile-menu]');
    await page.click(`[data-sidebar-group-row="${groups[index].id}"]`);
    await dismissTour(page);
    await page.click('button[aria-label="Share this group"]');
    await page.fill(`${sharing} input:not([type=checkbox])`, persons[index]!);
    await page.wait(()=>page.evaluate(`(() => {const box=document.querySelector('${sharing}')?.getBoundingClientRect();return box&&box.left>=0&&box.right<=innerWidth&&box.top>=0&&box.bottom<=innerHeight;})()`),"sharing panel stays inside viewport");
  }));
  evidence.unavailableLinksRejected = 3; evidence.freshLaunches = 3; evidence.authenticatedReloads = 3;
  phase("Connect independent groups with invitations", "Alice starts sharing. Bob and Chris each accept their own invitation in their own installation.");
  await pages[0]!.button("Start sharing this group", sharing);
  await pages[0]!.wait(() => pages[0]!.evaluate(`!!Array.from(document.querySelectorAll('${sharing} button')).find(item=>item.textContent==='Create invitation')`), "shared group created");
  let previousInvitation = "";
  for (const index of [1, 2]) {
    await pages[0]!.button("Create invitation", sharing);
    const invitation = await pages[0]!.wait(async () => {const value=await pages[0]!.evaluate(`document.querySelector('${sharing} textarea[readonly]')?.value`);return value&&value!==previousInvitation?value:false;}, "one-use invitation");
    previousInvitation=invitation;
    await pages[index]!.fill(`${sharing} textarea`, invitation);
    await pages[index]!.button("Join with invitation", sharing);
    await pages[index]!.wait(() => pages[index]!.evaluate(`document.querySelector('${sharing}')?.innerText.includes('Alice')&&!document.querySelector('${sharing}')?.innerText.includes('Joining…')`), "membership accepted", 60_000);
    // A new invitation must replace this one before the next invitee reads it.
    if (index === 1) await pages[0]!.wait(() => pages[0]!.evaluate(`document.querySelector('${sharing}')?.innerText.includes('Bob')`), "Alice sees Bob", 60_000);
  }
  for (const page of pages) await page.wait(() => page.evaluate(`['Alice','Bob','Chris'].every(name=>document.querySelector('${sharing}')?.innerText.includes(name))`), "three people on every installation", 60_000);
  const groupId = (await api(0,"/api/collaboration")).groups.find((group:any)=>group.localGroupId===groups[0].id).groupId;
  evidence.groupId = groupId;
  await pause(4000);
  for (const page of pages) await page.click(`${sharing} button[aria-label="Close"]`);
  phase("Bob chooses which people may use his bot account", "The group invitation shares messages. A separate owner grant authorizes provider execution.");
  const bob = pages[1]!, alice = pages[0]!;
  await bob.click('[data-execution-manage] > summary');
  await bob.click('[data-execution-share] > summary');
  await bob.fill('[data-execution-share] input[aria-label="Shared provider name"]', "Bob OpenCode memory");
  const checks = await bob.evaluate('Array.from(document.querySelectorAll("[data-execution-share] input[type=checkbox]")).map(item=>({text:item.parentElement.textContent,checked:item.checked}))');
  assert.equal(checks.length,4);
  for (const index of [0,1,3]) {
    // Mark the real checkbox for the browser click; its React state changes normally.
    await bob.evaluate(`document.querySelectorAll('[data-execution-share] input[type=checkbox]')[${index}].setAttribute('data-record-check','next')`);
    await bob.click('[data-record-check="next"]');
    await bob.evaluate("document.querySelector('[data-record-check]').removeAttribute('data-record-check')");
  }
  await pause(2500);
  await bob.button("Share selected bot", "[data-execution-share]");
  await bob.wait(() => bob.evaluate('!document.querySelector("[data-execution-share]").open'), "owner grant saved");
  await bob.click('[data-execution-manage] > summary');
  const endpoint = `/api/collaboration/${groupId}/execution`;
  await alice.wait(() => alice.evaluate('Array.from(document.querySelector(\'select[aria-label="Run with"]\')?.options??[]).some(item=>item.textContent.startsWith("Bob (")&&!item.disabled)'), "Bob account ready",90_000);
  phase("Alice switches from this server to Bob's account", "The route states the owner, account profile and model before any request is sent.");
  await alice.evaluate('(() => {const select=document.querySelector(\'select[aria-label="Run with"]\');select.selectedIndex=Array.from(select.options).find(item=>item.textContent.startsWith("Bob (")&&!item.disabled).index;select.dispatchEvent(new Event("change",{bubbles:true}));})()');
  await alice.wait(() => alice.evaluate('document.querySelector("[data-execution-route]")?.textContent.includes("Bob\'s server")'), "remote account route");
  const nonce = randomUUID().slice(0,8);
  const request = `Demo ${nonce}: Recall the Project Cinder routing passphrase from your own persistent MEMORY.md. Reply with the passphrase. Do not change memory.`;
  assert.ok(!request.includes(expected));
  await alice.fill('[data-group-execution] textarea',request);
  await pause(3500);
  await alice.button("Send execution request", "[data-group-execution]");
  const owned = await bob.wait(async () => (await api(1,endpoint)).incoming.find((job:any)=>job.text===request), "owner receives request",60_000);
  assert.equal(owned.state,"pending-approval");
  phase("Bob reviews and approves the incoming request", "Only Bob's installation starts the native OpenCode turn. Credentials and private memory stay there.");
  const mark = `(() => {const item=Array.from(document.querySelectorAll('[data-execution-manage] li')).find(item=>item.textContent.includes(${JSON.stringify(nonce)}));if(!item)return false;item.setAttribute('data-record-job','current');return true;})()`;
  await bob.evaluate('document.querySelector("[data-execution-manage]").open=true');
  await bob.wait(() => bob.evaluate(mark),"approval card",30_000);
  await bob.evaluate('document.querySelector("[data-record-job]").scrollIntoView({block:"center"})');
  await pause(4500);
  await bob.button("Approve and run", "[data-record-job]");
  phase("Live OpenCode reads Bob's persistent memory", "Waiting for the real public model response. The expected fact was not included in Alice's prompt.");
  const completed = await alice.wait(async () => {
    const job = (await api(0,endpoint)).outgoing.find((job:any)=>job.id===owned.id);
    if (["failed","denied","cancelled","uncertain"].includes(job?.state)) throw Error(`Native execution ${job.state}: ${job.error}`);
    return job?.state==="succeeded"?job:false;
  }, "real model result",240_000);
  assert.ok(completed.result.includes(expected));
  assert.equal(completed.target.driver,"opencodeGo"); assert.equal(completed.target.model,report.model);
  const native = (await api(1,endpoint)).incoming.find((job:any)=>job.id===owned.id);
  const transcript = await api(1,`/api/threads/${native.threadId}/messages`);
  const turns = [...new Set(transcript.messages.filter((message:any)=>message.turnSucceeded&&message.turnId).map((message:any)=>message.turnId))];
  assert.equal(turns.length,1);
  phase("One reply appears in all three shared conversations", "The receipt records Bob's actual account and model. This demonstrates delegated work, not copied credentials.");
  for (const index of [0,1,2]) {
    const page = pages[index]!;
    assert.equal((await api(index,endpoint)).incoming.some((job:any)=>job.id===owned.id),index===1);
    await page.wait(async () => {
      const group=(await api(index,"/api/bots")).groups.find((value:any)=>value.id===groups[index].id);
      const task=group.tasks.find((value:any)=>value.sharedTopicId===owned.id);
      if(!task)return false;
      const view=await api(index,`/api/threads/${task.threadId}/messages`);
      return view.messages.filter((message:any)=>message.role==="bot"&&message.text?.includes(completed.result.trim())).length===1;
    },"reply replicated once",60_000);
    await page.evaluate('document.querySelector("[data-execution-manage]").open=true');
    // Chris did not request or own this job; open the replicated task via sidebar instead.
    if(index===2){
      await page.click('[data-mobile-menu]');
      const group=(await api(index,"/api/bots")).groups.find((value:any)=>value.id===groups[index].id);
      const task=group.tasks.find((value:any)=>value.sharedTopicId===owned.id);
      await page.click(`[data-sidebar-thread-row="${task.threadId}"]`);
      if(await page.evaluate('document.querySelector("[data-mobile-menu]")?.getAttribute("aria-expanded")==="true"')) {
        // Close the drawer through its backdrop if this build leaves it open.
        await page.send("Input.dispatchMouseEvent",{type:"mousePressed",x:630,y:400,button:"left",clickCount:1});
        await page.send("Input.dispatchMouseEvent",{type:"mouseReleased",x:630,y:400,button:"left",clickCount:1});
        await page.wait(()=>page.evaluate('document.querySelector("[data-mobile-menu]")?.getAttribute("aria-expanded")==="false"'),"conversation unobscured");
      }
    } else {
      await page.wait(()=>page.evaluate(mark),"completed request card");
      await page.button("Open shared conversation","[data-record-job]");
    }
    await page.evaluate('document.querySelector("[data-execution-manage]").open=false');
    await page.wait(()=>page.evaluate(`document.body.innerText.includes(${JSON.stringify(expected)})`),"actual reply visible");
  }
  evidence.execution={id:owned.id,owner:completed.owner,account:completed.target.account,model:completed.target.model,nativeTurns:turns,result:completed.result,usage:completed.usage,promptContainsExpectedFact:false,repliesPerInstallation:1};
  evidence.ok=true;
  // Allow drawer transitions to settle before selecting the poster frame.
  evidence.posterTimeMs=Date.now()-started+2000;
  await pause(7000);
  recording=false; await capture; ended=Date.now()-started;
  await alice.click('button[aria-label="Share this group"]');
  evidence.sharingViewportChecks=[];
  for(const width of [390,640,768,1280]) {
    await alice.send("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:false});
    await alice.wait(()=>alice.evaluate(`(() => {const box=document.querySelector('${sharing}')?.getBoundingClientRect();return box&&box.left>=0&&box.right<=innerWidth&&box.top>=0&&box.bottom<=innerHeight;})()`),`sharing panel fits ${width}px`);
    await alice.screenshot(join(directory,`sharing-${width}.png`));
    evidence.sharingViewportChecks.push(width);
  }
} catch(error) {
  evidence.error=error instanceof Error?error.message:String(error);
  console.error(evidence.error); process.exitCode=1;
} finally {
  recording=false; await capture;
  if(captureError){evidence.ok=false;evidence.captureError=String(captureError);process.exitCode=1;}
  await mkdir(directory,{recursive:true});
  await writeFile(join(directory,"timeline.json"),JSON.stringify({width:640,height:900,frames,phases,durationMs:Math.max(ended||Date.now()-started,(frames.at(-1)?.timeMs??0)+1),posterTimeMs:evidence.posterTimeMs},null,2));
  await writeFile(join(directory,"evidence.json"),JSON.stringify(evidence,null,2));
  for(const browser of browsers)await browser.close();
  console.log(`Recording evidence: ${directory}`);
}
