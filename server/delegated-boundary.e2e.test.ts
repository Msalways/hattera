import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-hattera.ts";

async function fixture(check: (f: any) => Promise<void>, review = false) {
  let ids: any;
  const session = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, {
    scripted: true, prepare(dir) {
      const file = join(dir,"config.json"), cfg = JSON.parse(readFileSync(file,"utf8")), base = cfg.instances.claude;
      cfg.instances = {foreign: cfg.instances.opencodeGo, ...Object.fromEntries(["account-a","account-b"].map((id,i) => {
        const configDir = join(dir,id); mkdirSync(configDir);
        return [id,{...base, config:{...base.config,configDir,managed:true,managedModels:[`opaque-${i}`]},
          environment:{...base.environment,FAKE_CLAUDE_ROUTE_ID:id,ANTHROPIC_API_KEY:"fixture-only",ANTHROPIC_BASE_URL:"http://127.0.0.1:1"}}];
      }))};
      cfg.defaultModelSelection = {instanceId:"account-a",model:"opaque-0"}; writeFileSync(file,JSON.stringify(cfg));
      const code = `
        import {Store} from ${JSON.stringify(new URL("./store.ts",import.meta.url).href)};
        import {writeFileSync} from 'node:fs'; import {join} from 'node:path';
        const a={instanceId:'account-a',model:'opaque-0'}, b={instanceId:'account-b',model:'opaque-1',effort:'high'};
        const store=new Store(()=>a), make=name=>store.createBot({name,modelSelection:a});
        const source=make('Source'), direct=make('Direct'), roomBot=make('Room'), legacy=make('Legacy');
        const donor=store.createBot({name:'Configured B',modelSelection:b});
        const gone={instanceId:'gone',model:'missing'}; store.createBot({name:'Configured gone',modelSelection:gone});
        const foreign={instanceId:'foreign',model:'fixture/opencode'}; store.createBot({name:'Configured foreign',modelSelection:foreign});
        const full=make('Full receiver'); store.patchBot(full.id,{approvalMode:'full'});
        const group=store.createGroup('Ready room',[roomBot.id],false,undefined,{completed:true});
        const dir=process.env.OMB_DATA_DIR, gate=join(dir,'release-direct');
        const step=(bot,message,selection,expectError=false,group_id)=>({arguments:{bot_ids:[bot.id],message,...(selection===undefined?{}:{selection}),...(group_id?{group_id}:{})},expectError});
        const invalid=[step(direct,'malformed',null,true),step(direct,'unconfigured',{...b,model:'unconfigured'},true),
          step(direct,'unavailable',gone,true),step(direct,'unsupported',{...b,effort:'none'},true),
          step(full,'incompatible',foreign,true)];
        const steps=${review} ? [step(direct,'unsupported',{...b,effort:'none'},true),step(direct,'deny selected',b,true),step(direct,'revalidate selected',b,true)]
          : [...invalid,step(direct,'same queued job',b),step(direct,'same queued job',a),step(roomBot,'room selected',b,false,group.id),step(legacy,'legacy')];
        if(${review})store.patchBot(source.id,{approvePeerComms:true});
        writeFileSync(join(dir,'room-plan.json'),JSON.stringify({[source.id]:{steps,reply:'source finished'},
          [direct.id]:{gateFile:gate,reply:'direct finished'},[roomBot.id]:{reply:'room finished'},[legacy.id]:{reply:'legacy finished'}}));
        writeFileSync(join(dir,'ids.json'),JSON.stringify({source:source.id,sourceThread:source.threadId,direct:direct.id,roomBot:roomBot.id,legacy:legacy.id,donor:donor.id,gate}));
      `;
      const seeded=spawnSync(process.execPath,["--experimental-strip-types","--input-type=module","-e",code],
        {encoding:"utf8",env:verificationServerEnvironment(process.env,dir,1)});
      if(seeded.status!==0)throw new Error(seeded.stderr);
      ids=JSON.parse(readFileSync(join(dir,"ids.json"),"utf8"));
    },
  }, ["opencode"]);
  const api=async (path: string, body?: unknown, method="POST") => {
    const res=await fetch(session.info.url+path,{method:body===undefined?"GET":method,
      headers:{origin:session.info.url,"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const result=await res.json(); expect(res.ok,JSON.stringify(result)).toBe(true); return result as any;
  };
  const rows=()=>{const p=join(session.info.dataDir,"room-plan.json.evidence.jsonl");return existsSync(p)?readFileSync(p,"utf8").trim().split("\n").map(s=>JSON.parse(s)):[];};
  const nodes=()=>{const p=join(session.info.dataDir,"room-handoffs.json");return existsSync(p)?JSON.parse(readFileSync(p,"utf8")):[];};
  try {
    await runControlOmb(["send","--bot",ids.source,"--text","Run the isolated task routing plan"],{env:{OPENMAUSBOT_URL:session.info.url}});
    await check({ids,session,api,rows,nodes});
  } finally {writeFileSync(ids.gate,"release");await session.close();}
}

it("validates real tool/HTTP requests and preserves per-request direct/room selection through the queue",()=>fixture(async f=>{
  await expect.poll(()=>Boolean(f.rows().find((r:any)=>r.botId===f.ids.source)),{timeout:45000}).toBe(true);
  const evidence=f.rows().find((r:any)=>r.botId===f.ids.source).evidence.filter((e:any)=>e.step);
  expect(evidence,JSON.stringify(evidence)).toHaveLength(9);
  for(const e of evidence.slice(0,5))expect(e.response.result.isError,JSON.stringify(e)).toBe(true);
  expect(JSON.stringify(evidence[4])).toMatch(/incompatible/);
  const children=f.nodes().filter((n:any)=>n.parentId);
  expect(children).toHaveLength(4);
  const direct=children.filter((n:any)=>n.botId===f.ids.direct);
  expect(new Set(direct.map((n:any)=>n.threadId)).size).toBe(1);
  expect(direct.map((n:any)=>n.selection.instanceId).sort()).toEqual(["account-a","account-b"]);
  const before=await f.api("/api/bots");
  expect(before.bots.find((b:any)=>b.id===f.ids.direct).modelSelection).toEqual({instanceId:"account-a",model:"opaque-0"});
  writeFileSync(f.ids.gate,"release");
  await expect.poll(()=>f.rows().filter((r:any)=>r.botId===f.ids.direct).length,{timeout:45000}).toBe(2);
  await expect.poll(()=>f.nodes().filter((n:any)=>n.parentId).every((n:any)=>["completed","failed"].includes(n.status)),{timeout:45000}).toBe(true);
  expect(f.nodes().filter((n:any)=>n.parentId&&n.status==="failed")).toEqual([]);
  expect(f.rows().filter((r:any)=>r.botId===f.ids.direct).map((r:any)=>[r.instanceTag,r.model,r.effort]).sort())
    .toEqual([["account-a","opaque-0",undefined],["account-b","opaque-1","high"]].sort());
  expect(f.rows().find((r:any)=>r.botId===f.ids.roomBot)).toMatchObject({instanceTag:"account-b",model:"opaque-1",effort:"high"});
  expect(f.rows().find((r:any)=>r.botId===f.ids.legacy)).toMatchObject({instanceTag:"account-a",model:"opaque-0"});
}),120000);

it("sends nothing during pending/denied review and revalidates authorization after approval",()=>fixture(async f=>{
  const card=async()=>{
    const messages=(await f.api(`/api/threads/${f.ids.sourceThread}/messages`)).messages;
    return messages.findLast((m:any)=>m.card?.requestId&&!m.card.answered);
  };
  await expect.poll(async()=>Boolean(await card()),{timeout:45000}).toBe(true);
  const denied=await card(); expect(JSON.stringify(denied)).toContain("deny selected");
  expect(f.nodes().filter((n:any)=>n.parentId)).toHaveLength(0);
  await f.api(`/api/threads/${f.ids.sourceThread}/respond`,{requestId:denied.card.requestId,behavior:"deny"});
  await expect.poll(async()=>{const c=await card();return Boolean(c&&c.card.requestId!==denied.card.requestId);},{timeout:45000}).toBe(true);
  const allowed=await card(); expect(JSON.stringify(allowed)).toContain("revalidate selected");
  expect(f.nodes().filter((n:any)=>n.parentId)).toHaveLength(0);
  await f.api(`/api/bots/${f.ids.donor}`,{modelSelection:{instanceId:"account-a",model:"opaque-0"}},"PATCH");
  await f.api(`/api/threads/${f.ids.sourceThread}/respond`,{requestId:allowed.card.requestId,behavior:"allow"});
  await expect.poll(()=>f.rows().find((r:any)=>r.botId===f.ids.source)?.evidence?.filter((e:any)=>e.step).length,{timeout:45000}).toBe(3);
  const steps=f.rows().find((r:any)=>r.botId===f.ids.source).evidence.filter((e:any)=>e.step);
  expect(steps.every((e:any)=>e.response.result.isError)).toBe(true);
  expect(f.nodes().filter((n:any)=>n.parentId)).toHaveLength(0);
  expect(f.rows().some((r:any)=>r.botId===f.ids.direct)).toBe(false);
},true),120000);
