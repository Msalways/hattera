import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, verificationServerEnvironment } from "../scripts/control-hattera.ts";

it("dispatches persisted direct and room selections through fake native adapters without default changes", async () => {
  let ids: any;
  const session = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, {
    scripted: true,
    prepare(dir) {
      const file = join(dir, "config.json");
      const cfg = JSON.parse(readFileSync(file, "utf8"));
      const base = cfg.instances.claude;
      cfg.instances = Object.fromEntries(["account-a", "account-b"].map((id, i) => {
        const configDir = join(dir, id); mkdirSync(configDir);
        return [id, {...base,
          config: {...base.config, configDir, managed: true, managedModels: [`opaque-${i}`]},
          environment: {...base.environment, FAKE_CLAUDE_ROUTE_ID: id,
            ANTHROPIC_API_KEY: "fixture-only", ANTHROPIC_BASE_URL: "http://127.0.0.1:1"}}];
      }));
      cfg.defaultModelSelection = {instanceId: "account-a", model: "opaque-0"};
      writeFileSync(file, JSON.stringify(cfg));
      const code = `
        import {Store} from ${JSON.stringify(new URL("./store.ts", import.meta.url).href)};
        import {RoomHandoffs} from ${JSON.stringify(new URL("./room-handoffs.ts", import.meta.url).href)};
        import {writeFileSync} from 'node:fs';
        import {join} from 'node:path';
        const dir = process.env.OMB_DATA_DIR;
        const a={instanceId:'account-a',model:'opaque-0'};
        const b={instanceId:'account-b',model:'opaque-1',effort:'high'};
        const store=new Store(()=>a);
        const source=store.createBot({name:'Source',modelSelection:a});
        const direct=store.createBot({name:'Direct',modelSelection:a});
        const roomBot=store.createBot({name:'Room',modelSelection:a});
        store.createBot({name:'Configured choice',modelSelection:b});
        const second=store.createTask(direct.id,'Second',false);
        const group=store.createGroup('Isolated room',[roomBot.id],false,undefined,{completed:true});
        const hooks={validate:()=>undefined,busy:()=>true,run:async()=>({ok:true,text:'unused'}),report:()=>{},changed:()=>{}};
        const handoffs=new RoomHandoffs(join(dir,'room-handoffs.json'),hooks);
        const from={botId:source.id,threadId:source.threadId};
        const add=(target,selection,text)=>handoffs.enqueue(from,'seed',undefined,target,text,text,false,false,'',undefined,undefined,selection).node;
        const first=add({botId:direct.id,threadId:direct.threadId},b,'route B');
        const next=add({botId:direct.id,threadId:second.threadId},a,'route A');
        const room=add({botId:roomBot.id,groupId:group.id,threadId:group.threadId},b,'room B');
        const legacyBot=store.createBot({name:'Legacy',modelSelection:a});
        const legacy=add({botId:legacyBot.id,threadId:legacyBot.threadId},undefined,'legacy');
        const badBot=store.createBot({name:'Unavailable',modelSelection:a});
        store.createBot({name:'Configured unavailable route',modelSelection:{instanceId:'gone',model:'missing'}});
        const bad=add({botId:badBot.id,threadId:badBot.threadId},{instanceId:'gone',model:'missing'},'must fail');
        writeFileSync(join(dir,'seed-ids.json'),JSON.stringify({direct:direct.id,roomBot:roomBot.id,legacyBot:legacyBot.id,badBot:badBot.id,requests:[first.id,next.id,room.id,legacy.id,bad.id]}));
        const plan=Object.fromEntries([source,direct,roomBot,legacyBot,badBot].map(bot=>[bot.id,{reply:'isolated complete'}]));
        writeFileSync(join(dir,'room-plan.json'),JSON.stringify(plan));
      `;
      const seeded = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code],
        {encoding: "utf8", env: verificationServerEnvironment(process.env, dir, 1)});
      if (seeded.status !== 0) throw new Error(seeded.stderr);
      ids = JSON.parse(readFileSync(join(dir, "seed-ids.json"), "utf8"));
    },
  });
  try {
    const nodes = () => JSON.parse(readFileSync(join(session.info.dataDir, "room-handoffs.json"), "utf8"));
    await expect.poll(() => ids.requests.every((id: string) => nodes().some((n: any) => n.id === id && ["completed", "failed"].includes(n.status))), {timeout: 45000}).toBe(true);
    expect(ids.requests.slice(0,4).map((id: string) => nodes().find((n: any) => n.id === id)?.result)).toEqual(Array(4).fill("isolated complete"));
    const rows = () => {
      const p = join(session.info.dataDir, "room-plan.json.evidence.jsonl");
      return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").map(s => JSON.parse(s)) : [];
    };
    const ran = rows();
    expect(ran.filter((r: any) => r.botId === ids.direct).map((r: any) => [r.instanceTag,r.model,r.effort]).sort())
      .toEqual([["account-a","opaque-0",undefined],["account-b","opaque-1","high"]].sort());
    expect(ran.find((r: any) => r.botId === ids.roomBot)).toMatchObject({instanceTag:"account-b",model:"opaque-1",effort:"high"});
    expect(ran.find((r: any) => r.botId === ids.legacyBot)).toMatchObject({instanceTag:"account-a",model:"opaque-0"});
    expect(ran.some((r: any) => r.botId === ids.badBot)).toBe(false);
    expect(nodes().find((n: any) => n.id === ids.requests[4])).toMatchObject({status:"failed",result:expect.stringMatching(/authorized|ready/)});
    const bots = JSON.parse(readFileSync(join(session.info.dataDir, "bots.json"), "utf8"));
    for (const id of [ids.direct,ids.roomBot,ids.badBot]) expect(bots.find((b: any) => b.id === id).modelSelection).toEqual({instanceId:"account-a",model:"opaque-0"});
  } finally { await session.close(); }
}, 90000);
