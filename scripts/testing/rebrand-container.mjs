// Prove canonical flags cannot turn a self-hosted container into a local CLI.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const image=process.argv[2];
assert.ok(image,"Usage: rebrand-container.mjs <existing-local-server-image>");
const name=`hattera-rebrand-${randomUUID().slice(0,8)}`,exec=promisify(execFile);
const docker=async args=>(await exec("docker",args,{windowsHide:true,timeout:120_000,maxBuffer:2*1024*1024})).stdout;
try {
  await docker(["run","--detach","--pull","never","--name",name,"--label",`hattera.fixture=${name}`,"--network","none","--memory","2g","--cpus","2",
    "--mount",`type=bind,source=${resolve("dist-server")},target=/app/dist-server,readonly`,
    "--mount",`type=bind,source=${resolve("deploy/render/start.mjs")},target=/app/render/start.mjs,readonly`,
    "-e","HATTERA_LOCAL_CLI=1","-e","HATTERA_PERSISTENT_WEB=1","-e","HATTERA_LOOPBACK_TRUST=owner",
    "-e","GITHUB_CLIENT_ID=fixture-client","-e","GITHUB_CLIENT_SECRET=fixture-secret","-e","GITHUB_OWNER_ID=1",
    "-e","HATTERA_PUBLIC_URL=https://fixture.hattera.invalid","-e","GITHUB_REDIRECT_URI=https://fixture.hattera.invalid/identity/callback/github",
    "-e","BETTER_AUTH_SECRET=fixture-only-secret-at-least-thirty-two-characters",
    "-e","HATTERA_PORT=8799","--entrypoint","node",image,"/app/render/start.mjs"]);
  const code=`const deadline=Date.now()+90000;let ready=false;
while(Date.now()<deadline){try{ready=(await fetch('http://127.0.0.1:8799/api/health',{signal:AbortSignal.timeout(3000)})).ok;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,500));}
if(!ready)throw Error('Container not ready');
const base='http://127.0.0.1:8799';
const canonical=await fetch(base+'/.well-known/hattera/environment').then(r=>r.json());
const legacy=await fetch(base+'/.well-known/openmausbot/environment').then(r=>r.json());
const status=(await fetch(base+'/api/config')).status;
const remoteStatus=(await fetch(base+'/api/bots',{headers:{'x-forwarded-for':'192.0.2.20','x-forwarded-proto':'https'}})).status;
const brand=await fetch(base+'/api/brand').then(r=>r.json());
console.log(JSON.stringify({canonicalDescriptor:canonical.environmentId===legacy.environmentId,localCli:canonical.capabilities.localCli===true,protectedStatus:status,remoteStatus,brand:brand.brand.name}));`;
  const proof=JSON.parse(await docker(["exec",name,"node","--input-type=module","-e",code]));
  assert.equal(proof.canonicalDescriptor,true);assert.equal(proof.localCli,false);
  assert.ok([401,403].includes(proof.protectedStatus));assert.ok([401,403].includes(proof.remoteStatus));assert.equal(proof.brand,"Hattera");
  mkdirSync("output/rebranding",{recursive:true});
  writeFileSync("output/rebranding/container.json",JSON.stringify({ok:true,image,at:new Date().toISOString(),...proof},null,2)+"\n");
  console.log(JSON.stringify({ok:true,...proof}));
} catch(error) {
  const logs=await exec("docker",["logs","--tail","40",name],{windowsHide:true,timeout:10_000}).catch(()=>null);
  console.error(logs ? (logs.stdout+logs.stderr).slice(-6000) : "Container logs unavailable");
  console.error(await docker(["inspect","--format","{{json .State}}",name]).catch(()=>"Container state unavailable"));
  throw error;
} finally {
  // A timed-out run may have created its container before losing the reply.
  const found=await docker(["ps","--all","--quiet","--filter",`name=^/${name}$`]);
  if(found.trim()){const [container]=JSON.parse(await docker(["inspect",name]));assert.equal(container.Config.Labels["hattera.fixture"],name);await docker(["rm","--force",name]);}
}
