import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { CollaborationService } from "./collaboration-service.ts";
import { CollaborationExecution, type ExecutionRuntime } from "./collaboration-execution.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import type { PrivateNetworkState } from "../shared/private-network.ts";
import type { ExecutionJob } from "../shared/collaboration-execution.ts";
import { executionCommand } from "../shared/collaboration-execution.ts";

const cleanup: Array<()=>Promise<void>>=[];
afterEach(async()=>{await Promise.all(cleanup.splice(0).map(close=>close()));});
async function fixture() {
  const peers=new Map<string,CollaborationService>();
  const create=(name:string,index:number)=>{
    const directory=mkdtempSync(join(tmpdir(),'hattera-execution-test-'));
    const address=`http://100.65.2.${index}`;
    let fingerprint='original', lost=false, online=true, hang=false, ready=true, checkGate:Promise<void>|undefined;
    const calls: Array<ExecutionJob & { threadId?: string }>=[], stops:string[]=[];
    const tasks=new Map<string,{busy:boolean;succeeded:boolean;result:string}>();
    const network={async status():Promise<PrivateNetworkState>{return {available:true,enabled:online,state:online?'connected':'disconnected',origin:address,authorizationUrl:null,message:null,peers:[],peerTransport:true};},
      async peer(endpoint:string,body:unknown){
        if(!online)throw new Error('offline');
        const peer=peers.get(endpoint);if(!peer)throw new Error('missing peer');
        try{const result=await peer.handlePeer(body);if(lost){lost=false;throw new Error('lost receipt');}return {status:200,body:result};}catch{return {status:403,body:{error:'refused'}};}
      }};
    const service=new CollaborationService({dataDir:directory,network});peers.set(address,service);
    const runtime:ExecutionRuntime={
      fingerprint:()=>fingerprint,
      describe:async(_botId,cached)=>{if(!cached)await checkGate;return {botName:`${name} bot`,account:`${name} account`,driver:index===1?'claudeAgent':'codex',model:'native-model',effort:'high',ready:cached||ready,fingerprint};},
      prepare:()=>({threadId:randomUUID(),roomThreadId:randomUUID()}),
      start:async job=>{calls.push(job);tasks.set(job.threadId!,{busy:hang,succeeded:!hang,result:`From ${name}`});},
      inspect:job=>({...tasks.get(job.threadId!)??{busy:false,succeeded:false,result:''},waiting:false,usage:{input:10,output:5,tokensReported:true,costUsd:null}}),
      stop:async job=>{stops.push(job.id);const task=tasks.get(job.threadId!);if(task)task.busy=false;},
      publish:()=>{},capacity:()=>true,
    };
    let execution=new CollaborationExecution({dataDir:directory,service,runtime});
    cleanup.push(async()=>{execution.close();service.close();await removeTempDir(directory);});
    return {name,service,get execution(){return execution;},directory,calls,stops,tasks,
      changeConfig(){fingerprint='changed';},loseReply(){lost=true;},hang(){hang=true;},offline(){online=false;},unavailable(){ready=false;},
      holdDispatchCheck(){let release!:()=>void;checkGate=new Promise<void>(resolve=>{release=resolve;});return release;},
      restart(){execution.close();execution=new CollaborationExecution({dataDir:directory,service,runtime});}};
  };
  const a=create('Alice',1),b=create('Bob',2),c=create('Chris',3);
  const group=await a.service.share('alice-room','Feature','Alice');
  for(const peer of [b,c]){await peer.service.join(await a.service.invite(group),'room',peer.name);await peer.service.synchronize(group);}
  await b.service.synchronize(group,group);
  const alice=a.service.localMember(group).publicKey,bob=b.service.localMember(group).publicKey,chris=c.service.localMember(group).publicKey;
  return {a,b,c,group,alice,bob,chris};
}
async function settle(execution:CollaborationExecution){await execution.reconcile();await Promise.resolve();await execution.reconcile();}

it('never dispatches a request cancelled while its fresh account check was pending',async()=>{
  const {b,group,alice}=await fixture();
  const target=await b.execution.grant({groupId:group,botId:'bot',label:'Owner account',members:[alice],approval:true});
  const id=randomUUID();await b.execution.receive(group,b.service.member(group,alice),{op:'submit',id,targetId:target,text:'Cancel during the slow check'});
  await b.execution.decide(group,id,true);
  const release=b.holdDispatchCheck(),checking=b.execution.reconcile();
  await Promise.resolve();await b.execution.cancel(group,id,true);release();await checking;await settle(b.execution);
  const reply=await b.execution.receive(group,b.service.member(group,alice),{op:'read',id});
  expect(reply.kind==='job'&&reply.job.state).toBe('cancelled');expect(b.calls).toHaveLength(0);
},20000);

it('rechecks actual account readiness before native dispatch even when admission had a cached ready snapshot',async()=>{
  const {a,b,group,alice}=await fixture();
  const target=await b.execution.grant({groupId:group,botId:'bot',label:'Owner account',members:[alice],approval:true});
  b.unavailable();
  const id=randomUUID();
  const reply=await b.execution.receive(group,b.service.member(group,alice),{op:'submit',id,targetId:target,text:'Do not execute with an unavailable account'});
  expect(reply.kind==='job'&&reply.job.state).toBe('pending-approval');
  await b.execution.decide(group,id,true);await settle(b.execution);
  const current=await b.execution.receive(group,b.service.member(group,alice),{op:'read',id});
  expect(current.kind==='job'&&current.job).toMatchObject({state:'failed',error:expect.stringContaining('no longer ready')});
  expect(a.calls).toHaveLength(0);expect(b.calls).toHaveLength(0);
},20000);

it('requires an owner grant and approval, routes both ways, and never executes on the requesting machine',async()=>{
  const {a,b,c,group,alice,bob}=await fixture();
  await expect(a.service.callExecution(group,bob,{op:'submit',id:randomUUID(),targetId:randomUUID(),text:'No grant'})).rejects.toThrow(/could not accept/);
  const target=await b.execution.grant({groupId:group,botId:'same-local-id',label:'Bob Codex',members:[alice],approval:true});
  const id=randomUUID();
  const admitted=await a.service.callExecution(group,bob,{op:'submit',id,targetId:target,text:'Build this feature'});
  expect(admitted.kind==='job'&&admitted.job.state).toBe('pending-approval');
  await settle(b.execution);expect(b.calls).toHaveLength(0);
  await b.execution.decide(group,id,true);await settle(b.execution);
  expect(b.calls).toHaveLength(1);expect(a.calls).toHaveLength(0);expect(c.calls).toHaveLength(0);
  const result=await a.service.callExecution(group,bob,{op:'read',id});
  expect(result.kind==='job'&&result.job).toMatchObject({state:'succeeded',owner:'Bob',requester:'Alice',result:'From Bob',usage:{input:10,output:5}});
  const reverse=await a.execution.grant({groupId:group,botId:'same-local-id',label:'Alice Claude',members:[bob],approval:false});
  await b.service.callExecution(group,alice,{op:'submit',id:randomUUID(),targetId:reverse,text:'Run on Alice'});await settle(a.execution);
  expect(a.calls).toHaveLength(1);expect(b.calls).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain('fingerprint');expect(JSON.stringify(result)).not.toContain('threadId');
},20000);

it('isolates people, groups and request IDs, and deduplicates after a lost response and restart',async()=>{
  const {a,b,c,group,alice,bob}=await fixture();
  const target=await b.execution.grant({groupId:group,botId:'bot',label:'Work account',members:[alice],approval:false});
  const id=randomUUID(),submit={op:'submit' as const,id,targetId:target,text:'Exactly once'};
  a.loseReply();await expect(a.service.callExecution(group,bob,submit)).rejects.toThrow();
  await a.service.callExecution(group,bob,submit);await settle(b.execution);expect(b.calls).toHaveLength(1);
  b.restart();await a.service.callExecution(group,bob,submit);await settle(b.execution);expect(b.calls).toHaveLength(1);
  await expect(c.service.callExecution(group,bob,{op:'read',id})).rejects.toThrow();
  await expect(c.service.callExecution(group,bob,{op:'submit',id:randomUUID(),targetId:target,text:'Not authorized'})).rejects.toThrow();
  await expect(a.service.callExecution(group,bob,{...submit,text:'Different prompt'})).rejects.toThrow();
  expect(readFileSync(join(b.directory,'collaboration/execution.json'),'utf8')).not.toContain('privateKey');
},20000);

it('revalidates configuration and membership, cancels revoked running work, and leaves independent people intact',async()=>{
  const {a,b,c,group,alice,bob,chris}=await fixture();
  const target=await b.execution.grant({groupId:group,botId:'bot',label:'Codex',members:[alice,chris],approval:true});
  const id=randomUUID();await a.service.callExecution(group,bob,{op:'submit',id,targetId:target,text:'Pending'});
  b.changeConfig();await expect(b.execution.decide(group,id,true)).rejects.toThrow(/configuration/);expect(b.calls).toHaveLength(0);
  const runningId=randomUUID();await c.service.callExecution(group,bob,{op:'submit',id:runningId,targetId:target,text:'Run until stopped'});
  b.hang();await b.execution.decide(group,runningId,true);await b.execution.reconcile();await Promise.resolve();
  b.execution.revoke(group,target);await b.execution.reconcile();
  expect(b.stops).toContain(runningId);
  expect(b.service.member(group,alice).active).toBe(true);expect(b.service.member(group,chris).active).toBe(true);
  expect(()=>b.execution.assertThread(b.calls[0]!.threadId!)).toThrow();
},20000);

it('marks a running job uncertain after restart instead of replaying it',async()=>{
  const {a,b,group,alice,bob}=await fixture();b.hang();
  const target=await b.execution.grant({groupId:group,botId:'bot',label:'Work',members:[alice],approval:false});
  const id=randomUUID();await a.service.callExecution(group,bob,{op:'submit',id,targetId:target,text:'May have side effects'});
  await b.execution.reconcile();await Promise.resolve();b.restart();await b.execution.reconcile();
  const reply=await a.service.callExecution(group,bob,{op:'read',id});
  expect(reply.kind==='job'&&reply.job.state).toBe('uncertain');expect(b.calls).toHaveLength(1);
},20000);

it('admits concurrent copies once and keeps interrupted sender delivery retryable after restart',async()=>{
  const {a,b,group,alice}=await fixture();
  const target=await b.execution.grant({groupId:group,botId:'bot',label:'Work',members:[alice],approval:false});
  const command={op:'submit' as const,id:randomUUID(),targetId:target,text:'Only one native dispatch'};
  const member=b.service.member(group,alice);
  const replies=await Promise.all([b.execution.receive(group,member,command),b.execution.receive(group,member,command)]);
  expect(replies[0]).toEqual(replies[1]);
  await settle(b.execution);expect(b.calls).toHaveLength(1);
  const job=replies[0].kind==='job'?replies[0].job:null;expect(job).not.toBeNull();
  writeFileSync(join(a.directory,'collaboration/execution.json'),JSON.stringify({version:1,grants:[],incoming:[],outgoing:[{...job,state:'sending'}]}));
  a.restart();
  expect((await a.execution.status(group)).outgoing[0]?.state).toBe('delivery-unknown');
},20000);

it('refuses local attachment authority and extra dispatch options at the peer boundary',()=>{
  expect(executionCommand.safeParse({op:'submit',id:randomUUID(),targetId:randomUUID(),text:'<attached-file path="C:/private/key" />'}).success).toBe(false);
  expect(executionCommand.safeParse({op:'submit',id:randomUUID(),targetId:randomUUID(),text:'hello',cwd:'C:/private',fullAuto:true}).success).toBe(false);
});
