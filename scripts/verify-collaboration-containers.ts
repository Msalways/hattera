// Local, user-inspectable three-person demo. No live home or provider login mounts.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";

const exec = promisify(execFile);
assert.ok(process.argv.length === 2 || process.argv.length === 4 && ["--links", "--resume"].includes(process.argv[2]!)
  || process.argv.length === 5 && process.argv[2] === "--links" && process.argv[4] === "--open",
  "Usage: node --experimental-strip-types scripts/verify-collaboration-containers.ts [--links report.json [--open] | --resume report.json]");
async function printLocalLinks(manifest: {runId:string;containers:string[];ports:number[]}, open = false) {
  assert.match(manifest.runId, /^hattera-team-[a-f0-9]{8}$/);
  const names = ["alice", "bob", "chris"].map(person => `${manifest.runId}-${person}`);
  assert.deepEqual(manifest.containers, names);
  const inspected = JSON.parse((await exec("docker", ["inspect", ...names], {windowsHide:true,timeout:20_000})).stdout);
  for (const [index, container] of inspected.entries()) {
    assert.equal(container.Config.Labels["hattera.fixture"], manifest.runId);
    const port = manifest.ports[index];
    assert.ok(Number.isInteger(port) && port! > 0 && port! <= 65535, "Invalid local fixture port");
    assert.ok(container.HostConfig.PortBindings["8080/tcp"]?.some((binding: {HostIp:string;HostPort:string}) => binding.HostIp === "127.0.0.1" && binding.HostPort === String(port)), "Report does not match the container's loopback port");
  }
  const stopped = inspected.filter((container: {State:{Running:boolean}}) => !container.State.Running);
  if (stopped.length) await exec("docker", ["start", ...stopped.map((container: {Name:string}) => container.Name)], {windowsHide:true,timeout:60_000});
  const urls: string[] = [];
  for (const [index, person] of ["alice", "bob", "chris"].entries()) {
    const name = `${manifest.runId}-${person}`;
    const code = `const deadline=Date.now()+90000;
let descriptor;
while(Date.now()<deadline){
  try{
    const health=await fetch('http://127.0.0.1:8799/api/health',{signal:AbortSignal.timeout(5000)});
    if(health.ok&&(await health.json()).app==='openmausbot'){
      const environment=await fetch('http://127.0.0.1:8799/.well-known/openmausbot/environment',{signal:AbortSignal.timeout(5000)});
      if(environment.ok)descriptor=await environment.json();
    }
  }catch{}
  if(descriptor?.capabilities)break;
  await new Promise(done=>setTimeout(done,500));
}
if(!descriptor?.capabilities)throw new Error('Fixture did not become ready within 90 seconds');
if(!descriptor.capabilities.localCli)throw new Error('This installation is self-hosted, not a local CLI demo. Use its configured sign-in.');
const r=await fetch('http://127.0.0.1:8799/api/auth/pairing',{method:'POST',headers:{'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(10000)});
if(!r.ok)throw new Error('Pairing refused');console.log(JSON.stringify(await r.json()));`;
    const paired = JSON.parse((await exec("docker", ["exec",name,"node","--input-type=module","-e",code], {windowsHide:true,timeout:110_000})).stdout);
    const url = `http://127.0.0.1:${manifest.ports[index]}/pair?cli=1#code=${encodeURIComponent(paired.code)}`;
    urls.push(url); console.log(`${person}: ${url}`);
  }
  if (open) for (const url of urls) {
    const command = process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open";
    await exec(command, process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url], {windowsHide:true,timeout:10_000});
  }
}
if (process.argv[2] === "--links") {
  await printLocalLinks(JSON.parse(readFileSync(resolve(process.argv[3] ?? ""), "utf8")), process.argv[4] === "--open");
  process.exit(0);
}
const root = process.cwd();
const resumed = process.argv[2] === "--resume" ? JSON.parse(readFileSync(resolve(process.argv[3] ?? ""), "utf8")) : null;
if (resumed) assert.match(resumed.runId, /^hattera-team-[a-f0-9]{8}$/);
if (resumed) assert.equal(resumed.ok, false, "This demo already passed. Use --links to inspect it instead of rerunning its mutations.");
const runId = resumed?.runId ?? `hattera-team-${randomUUID().slice(0, 8)}`;
const directory = resolve("output", runId), context = resolve(".omb-scratch", runId);
mkdirSync(directory, { recursive: true }); mkdirSync(context, { recursive: true });
const model = resumed?.model ?? process.env.OMB_TEAM_MODEL ?? "opencode/mimo-v2.6-flash-free";
assert.ok(model.endsWith("-free"), "This unattended demo uses an explicitly free model only.");
const persons = ["Alice", "Bob", "Chris"];
const containers = persons.map(name => `${runId}-${name.toLowerCase()}`);
const ports = [18081, 18082, 18083];
const report: Record<string, any> = resumed ?? { ok: false, runId, directory, containers, ports, model, checks: [],
  realOpenCode: true, modelInference: "live public free model", vpnTransport: "simulated; encrypted app packets cross an isolated Docker bridge",
  cliLaunch: "node /app/dist-server/hattera.js web --cli-only --json --data-dir /data/profile --port 8799; no forced CLI/trust environment flags",
  vendorAccountIdentitiesQualified: false,
  physicalTailnetQualified: false, profiles: "three isolated named volumes; no user credentials mounted" };
const save = () => writeFileSync(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
const docker = async (args: string[], timeout = 120_000) => (await exec("docker", args, { cwd: root, windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
const poll = async (label: string, check: () => Promise<any>, timeout = 120_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await new Promise(done => setTimeout(done, 1000)); }
  throw new Error(`Timed out: ${label}`);
};
const api = async (index: number, path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
  // Run only on the exact named disposable container; no host runtime discovery.
  const code = `const response=await fetch(${JSON.stringify(`http://127.0.0.1:8799${path}`)},{method:${JSON.stringify(method)},headers:{'content-type':'application/json'},${body === undefined ? "" : `body:${JSON.stringify(JSON.stringify(body))},`}signal:AbortSignal.timeout(20000)});const value=await response.json();if(!response.ok)throw new Error(JSON.stringify({status:response.status,value}));console.log(JSON.stringify(value));`;
  return JSON.parse(await docker(["exec", containers[index]!, "node", "--input-type=module", "-e", code], 35_000));
};
save();
try {
  console.log(`Container team: ${runId}; ${directory}`);
  if (resumed) {
    for (const name of containers) {
      const labels = JSON.parse(await docker(["inspect", "--format", "{{json .Config.Labels}}", name]));
      assert.equal(labels["hattera.fixture"], runId);
      await docker(["start", name]);
    }
    (report.previousAttempts ??= []).push({ error: report.error, finishedAt: report.finishedAt });
    delete report.error; report.ok = false;
  } else {
  // Reuse audited Linux runtime/real CLI layers, refresh every application file.
  cpSync(resolve("dist-server"), join(context, "dist-server"), { recursive: true });
  cpSync(resolve("dist"), join(context, "dist"), { recursive: true });
  cpSync(resolve("scripts/testing/collaboration-container-start.mjs"), join(context, "start.mjs"));
  await exec("go", ["build", "-o", join(context, "peer"), resolve("server/testing/fake-peer-network.go")], {
    cwd: root, windowsHide: true, timeout: 120_000, env: { ...process.env, GOOS: "linux", GOARCH: "amd64", CGO_ENABLED: "0" },
  });
  writeFileSync(join(context, "Dockerfile"), `FROM hattera-render-opencode-default:local\nUSER root\nCOPY --chown=maus:maus dist-server /app/dist-server\nCOPY --chown=maus:maus dist /app/dist\nCOPY start.mjs /fixture/start.mjs\nCOPY --chmod=755 peer /fixture/peer\nUSER maus\nCMD ["node","/fixture/start.mjs"]\n`);
  console.log("Building current app with the real OpenCode binary…");
  await docker(["build", "--pull=false", "-t", runId, context], 600_000);
  await docker(["network", "create", "--label", `hattera.fixture=${runId}`, runId]);
  for (let index = 0; index < 3; index++) {
    await docker(["volume", "create", "--label", `hattera.fixture=${runId}`, `${containers[index]}-data`]);
    await docker(["run", "--detach", "--pull", "never", "--name", containers[index]!, "--label", `hattera.fixture=${runId}`,
      "--network", runId, "--network-alias", persons[index]!.toLowerCase(), "--memory", "1536m", "--cpus", "1.5",
      "-p", `127.0.0.1:${ports[index]}:8080`, "-v", `${containers[index]}-data:/data`, "-e", `TEAM_PERSON=${persons[index]!.toLowerCase()}`, runId]);
    await poll(`${persons[index]} readiness`, async () => { try { return (await api(index, "/api/health")).app; } catch { return false; } });
    assert.equal(await docker(["exec", containers[index]!, "opencode", "--version"]), "1.19.0");
    assert.equal((await api(index, "/.well-known/openmausbot/environment")).capabilities.localCli, true);
    assert.equal((await api(index, "/api/auth/session")).kind, "loopback");
    assert.ok((await api(index, "/api/auth/session")).scopes.includes("admin"));
    assert.equal((await api(index, "/api/local-runtime")).persistent, true);
    assert.ok((await docker(["logs", containers[index]!])).includes("CLI launch: node /app/dist-server/hattera.js web"));
  }
  }
  const bots: any[] = [], groups: any[] = [];
  let secrets = persons.map(person => `${person.toUpperCase()}_${randomUUID().replaceAll("-", "")}`);
  if (!resumed) {
  for (let index = 0; index < 3; index++) {
    bots.push((await api(index, "/api/bots", { name: `${persons[index]} OpenCode`, modelSelection: { instanceId: "opencode", model }, cwd: "/data/project" })).bot);
    groups.push((await api(index, "/api/groups", { name: "OpenCode container team", memberIds: [bots[index].id], setup: { bulletin: "Isolated live OpenCode collaboration demo", defaultResponder: { kind: "mentions" } } })).group);
    await api(index, `/api/bots/${bots[index].id}/memory`, { text: `# Team memory\n\nProject Cinder routing passphrase: ${secrets[index]}\nThis fact belongs to ${persons[index]}'s profile.\n` }, "PUT");
  }
  const groupId = (await api(0, "/api/collaboration/share", { localGroupId: groups[0].id, memberName: "Alice", includeHistory: false })).groupId;
  for (const index of [1, 2]) {
    const invitation = (await api(0, "/api/collaboration/invite", { groupId, role: "manager" })).invitation;
    await api(index, "/api/collaboration/join", { localGroupId: groups[index].id, memberName: persons[index], invitation });
    await poll("joined person", async () => !(await api(index, "/api/collaboration")).groups[0].joining);
  }
  await poll("all three people", async () => (await api(1, "/api/collaboration")).groups[0].members.filter((member: any) => member.active).length === 3);
  report.groupId = groupId;
  report.bots = bots.map((bot, index) => ({ person: persons[index], id: bot.id, groupId: groups[index].id }));
  } else {
    for (let index = 0; index < 3; index++) {
      await poll("resumed readiness", async () => {try{return (await api(index,"/api/health")).app;}catch{return false;}});
      bots.push({id:resumed.bots[index].id}); groups.push({id:resumed.bots[index].groupId});
    }
    secrets = await Promise.all(bots.map(async (bot,index) => {
      const memory = await api(index,`/api/bots/${bot.id}/memory`);
      const value = /routing passphrase: (\S+)/.exec(memory.text)?.[1];
      assert.ok(value); return value;
    }));
  }
  const groupId = report.groupId;
  const members = (await api(0, "/api/collaboration")).groups[0].members;
  const key = (index: number) => members.find((member: any) => member.name === persons[index]).publicKey;
  const endpoint = `/api/collaboration/${groupId}/execution`;
  const grants: string[] = [];
  for (let index = 0; index < 3; index++) grants.push(resumed
    ? (await api(index,endpoint)).grants.find((grant:any)=>grant.botId===bots[index].id&&grant.enabled).id
    : (await api(index, `${endpoint}/grants`, { botId: bots[index].id,
      label: `${persons[index]}'s real OpenCode`, members: [0, 1, 2].filter(value => value !== index).map(key), approval: true, acknowledge: true })).id);
  report.groupId = groupId; report.bots = bots.map((bot, index) => ({ person: persons[index], id: bot.id, groupId: groups[index].id }));
  report.checks.push("three-independent-profiles-and-human-memberships"); save();
  const execute = async (from: number, owner: number, expected: string, label: string) => {
    if (report.checks.includes(label)) return;
    console.log(`Live memory test: ${persons[from]} → ${persons[owner]} (${label})`);
    await poll("shared account ready", async () => (await api(from, endpoint)).peers.find((peer: any) => peer.publicKey === key(owner))?.targets.some((target: any) => target.id === grants[owner] && target.ready), 180_000);
    const text = "Recall the Project Cinder routing passphrase from your own persistent MEMORY.md. Reply with that passphrase. Do not invent one. Do not change memory.";
    const prior = (await api(from,endpoint)).outgoing.find((job:any)=>job.ownerKey===key(owner)&&job.text===text&&job.state==='delivery-unknown');
    const id = prior?.id ?? randomUUID();
    assert.ok(!text.includes(expected), "The expected memory must not be supplied in the request.");
    const admission = await poll("admission receipt with stable-ID retry", async () => {
      const received = (await api(owner,endpoint)).incoming.find((job:any)=>job.id===id);
      if (received) return received;
      const receipt = (await api(from,`${endpoint}/requests`,{id,ownerKey:key(owner),targetId:grants[owner],text})).job;
      if (receipt.state === 'delivery-unknown') (report.deliveryRetries ??= []).push({id,from:persons[from],owner:persons[owner],at:new Date().toISOString()});
      return receipt.state === 'delivery-unknown' ? false : receipt;
    });
    assert.equal(admission.state, "pending-approval");
    await api(owner, `${endpoint}/decide`, { id, allow: true });
    const job = await poll("native OpenCode memory answer", async () => {
      const current = (await api(from, endpoint)).outgoing.find((value: any) => value.id === id);
      if (["failed", "cancelled", "uncertain", "denied"].includes(current?.state)) throw new Error(`Native request ${current.state}: ${current.error ?? current.result ?? "Review owner's task"}`);
      return current?.state === "succeeded" ? current : false;
    }, 240_000);
    assert.ok(job.result?.includes(expected), `Memory mismatch: ${job.result}`);
    assert.equal(job.ownerKey, key(owner));
    const owned = (await api(owner,endpoint)).incoming.filter((value:any)=>value.id===id);
    assert.equal(owned.length,1);
    const messages = (await api(owner,`/api/threads/${owned[0].threadId}/messages`)).messages;
    const nativeTurns = [...new Set(messages.filter((message:any)=>message.turnSucceeded===true&&message.turnId).map((message:any)=>message.turnId))];
    assert.equal(nativeTurns.length,1,'A stable request ID dispatched more than one native turn');
    (report.nativeExecutions ??= []).push({id,container:containers[owner],threadId:owned[0].threadId,nativeTurns});
    report.checks.push(label); (report.jobs ??= []).push(job); save();
    return job;
  };
  await execute(0, 1, secrets[1]!, "alice-uses-bobs-persistent-memory-through-real-opencode");
  const aliceMemory = await api(0, `/api/bots/${bots[0].id}/memory`);
  assert.ok(!aliceMemory.text.includes(secrets[1]), "Bob's private memory was copied into Alice's memory.");
  assert.ok(aliceMemory.text.includes(secrets[0]));
  report.checks.push("owner-memory-remains-local"); save();
  await execute(1, 0, secrets[0]!, "bob-uses-alices-persistent-memory-in-reverse");
  await docker(["stop", containers[0]!]);
  await execute(1, 2, secrets[2]!, "bob-uses-chris-memory-with-creator-stopped");
  await docker(["start", containers[0]!]);
  await poll("creator return", async () => { try { return (await api(0, "/api/health")).app; } catch { return false; } });
  const changed = `BOB_UPDATED_${randomUUID().replaceAll("-", "")}`;
  await api(1, `/api/bots/${bots[1].id}/memory`, { text: `# Team memory\n\nProject Cinder routing passphrase: ${changed}\n` }, "PUT");
  await docker(["restart", containers[1]!]);
  await poll("Bob restart", async () => { try { return (await api(1, "/api/health")).app; } catch { return false; } });
  await execute(0, 1, changed, "fresh-remote-memory-survives-owner-container-restart");
  for (let viewer = 0; viewer < 3; viewer++) {
    for (const job of report.jobs) {
      await poll("shared reply on every installation", async () => {
        const room = (await api(viewer,"/api/bots")).groups.find((group:any)=>group.id===groups[viewer].id);
        const task = room.tasks.find((value:any)=>value.sharedTopicId===job.id);
        if (!task) return false;
        const page = await api(viewer,`/api/threads/${task.threadId}/messages`);
        return page.messages.filter((message:any)=>message.role==='bot'&&message.text?.includes(job.result.trim())).length===1;
      });
    }
  }
  report.checks.push("all-three-group-copies-have-every-shared-reply-once");
  report.ok = true;
  delete report.error;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error); console.error(report.error); process.exitCode = 1;
} finally {
  for (const [index, name] of containers.entries()) {
    try {
      const log = await docker(["logs", name]);
      writeFileSync(join(directory, `${persons[index]}.log`), log);
      const receipt = log.split(/\r?\n/).map(line => { try { return JSON.parse(line); } catch { return null; } }).find(value => typeof value?.logPath === "string");
      if (receipt && /^\/tmp\/hattera-web-[^/]+\/server.log$/.test(receipt.logPath)) {
        const source = `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(receipt.logPath)},'utf8'));`;
        writeFileSync(join(directory, `${persons[index]}.runtime.log`), await docker(["exec", name, "node", "-e", source]));
      }
    } catch { /* Container may not have been created. */ }
  }
  report.finishedAt = new Date().toISOString();
  report.checks = [...new Set(report.checks)];
  report.inspect = containers.map((name, index) => ({ person: persons[index], container: name, url: `http://127.0.0.1:${ports[index]}` }));
  // Deliberately left running for the user. No cleanup of user resources.
  save(); console.log(JSON.stringify({ ok: report.ok, report: join(directory, "report.json"), containers: report.inspect }, null, 2));
  if (report.ok) await printLocalLinks({ runId, containers, ports });
}
