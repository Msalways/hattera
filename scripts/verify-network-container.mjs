// Run only a new, disposable container. Never discover or restart a live app.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const image = process.env.OMB_VERIFY_NETWORK_IMAGE || "hattera-collaboration-verification";
const name = `hattera-network-check-${randomUUID()}`;
const docker = (args, options = {}) => execFileSync("docker", args, {
  encoding: "utf8", windowsHide: true, timeout: 120_000, ...options,
});
// Resolve the image user instead of assuming UID 1000 (already used by Node).
const uid = docker(["run", "--rm", "--tmpfs", "/data", "--entrypoint", "id", image, "-u"]).trim();
const gid = docker(["run", "--rm", "--tmpfs", "/data", "--entrypoint", "id", image, "-g"]).trim();
if (!/^\d+$/.test(uid) || uid === "0" || !/^\d+$/.test(gid)) throw new Error("Expected an image with a non-root app user");
const live = process.argv.includes("--live-network");
try {
  docker(["run", "--detach", "--name", name, "--memory", "512m", "--tmpfs", `/data:rw,uid=${uid},gid=${gid},mode=700`, image]);
  const result = docker(["exec", "-i", name, "node", "--input-type=module"], { input: `
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {delimiter,join} from 'node:path';
const base='http://127.0.0.1:8799';
for(let i=0;;i++) {
  try { if((await fetch(base+'/api/health')).ok) break; } catch {}
  assert.ok(i<60,'Server did not start');
  await new Promise(r=>setTimeout(r,500));
}
assert.notEqual(process.getuid?.(),0);
for(const cli of ['claude','codex','agy','antigravity','grok','gemini','kimi','droid','cursor-agent','agent','opencode','qwen','hermes','cline','pi','tailscale']) assert.equal((process.env.PATH??'').split(delimiter).some(dir=>existsSync(join(dir,cli))),false,cli+' was preinstalled');
const api=async(path,post=false)=>{
  const r=await fetch(base+path,{method:post?'POST':'GET',headers:{origin:base,'content-type':'application/json'},...(post?{body:'{}'}:{}),signal:AbortSignal.timeout(20000)});
  assert.equal(r.status,200,path+' returned '+r.status); return r.json();
};
const initial=await api('/api/private-network');
assert.equal(initial.available,true); assert.equal(initial.enabled,false);
const remote=await fetch(base+'/api/private-network',{headers:{host:'localhost','x-forwarded-for':'100.90.1.2','x-forwarded-proto':'http'}});
assert.ok([401,403].includes(remote.status),'Forwarded request acquired owner access');
if(${live}) {
  await api('/api/private-network/connect',true);
  let state;
  for(let i=0;i<45;i++) {
    state=await api('/api/private-network');
    if(state.authorizationUrl || state.state==='error') break;
    await new Promise(r=>setTimeout(r,1000));
  }
  assert.equal(new URL(state.authorizationUrl??'https://invalid.example').hostname,'login.tailscale.com',state.message??'Missing challenge');
  assert.notEqual(state.state,'connected','Inherited an existing identity');
  assert.equal((await api('/api/private-network/disconnect',true)).enabled,false);
}
console.log(JSON.stringify({ok:true,nonRoot:true,memoryLimitMiB:512,preinstalledEngines:false,accountAuthorized:false,publicChallengeChecked:${live}}));
` });
  const state = JSON.parse(docker(["inspect", "--format", "{{json .State}}", name]));
  if (!state.Running || state.OOMKilled) throw new Error("Verification container did not remain healthy");
  console.log(result.trim());
} finally {
  // The name is generated in this process; /data is tmpfs, never a user volume.
  docker(["rm", "--force", name], { stdio: "ignore" });
}
