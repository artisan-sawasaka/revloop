import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {start,review,stop,status} from '../dist/engine.js';
import {buildHaltReport} from '../dist/halt.js';
const id='11111111-2222-3333-4444-555555555555';
const pass={verdict:'PASS',summary:'ok',findings:[]};
const fail={verdict:'FAIL',summary:'repair needed',findings:[{severity:'P2',file:'x.ts',line:1,message:'wrong value',fix:'fix value'}]};
const reply=value=>async()=>({sessionId:id,review:value});
async function fixture(options={}){const root=await mkdtemp(path.join(os.tmpdir(),'revloop-halt-'));await writeFile(path.join(root,'x.ts'),'initial');const state=await start(root,{source:'codex',title:'halt',context:'fixture',files:['x.ts'],...options});return {root,state,dir:path.join(root,'.revloop/runs',state.id)};}
async function persisted(f){return JSON.parse(await readFile(path.join(f.dir,'halt.json'),'utf8'));}

test('BLOCKED hands caller the reviewer reason and persisted diagnostic paths',async()=>{
 const f=await fixture(),s=await review(f.root,f.state.id,reply({verdict:'BLOCKED',summary:'Reference image is missing',findings:[]}));
 const h=await persisted(f);assert.equal(h.reason,'Reference image is missing');assert.equal(h.status,'BLOCKED');assert.equal(h.reviewerSummary,s.reason);
 for(const file of Object.values(h.logs))await readFile(file);
 assert.match(await readFile(h.logs.halt,'utf8'),/Reference image is missing/);
 const r=spawnSync(process.execPath,[path.resolve('dist/cli.js'),'status','--root',f.root,'--run',s.id],{encoding:'utf8',windowsHide:true});
 assert.equal(r.status,2);const output=JSON.parse(r.stdout);assert.equal(output.halt.reason,h.reason);assert.equal(output.nextAction,h.nextAction);
});
test('idle stop records a custom reason and cannot later change PASS to STOPPED',async()=>{
 const f=await fixture(),reason='ユーザーが対象変更を指示したため停止';
 const result=await stop(f.root,f.state.id,reason);assert.equal(result.status,'STOPPED');assert.equal(result.reason,reason);assert.equal((await persisted(f)).reason,reason);
 assert.equal((await status(f.root,f.state.id)).reason,reason);
 assert.equal(JSON.parse(await readFile(path.join(f.dir,'STOP'),'utf8')).reason,reason);
 const g=await fixture();await review(g.root,g.state.id,reply(pass));
 assert.equal((await stop(g.root,g.state.id,'late stop')).status,'PASS');assert.ok(!(await readdir(g.dir)).includes('STOP'));assert.equal((await review(g.root,g.state.id,reply(fail))).status,'PASS');
});
test('active stop returns a request log and owner preserves reason on completion',async()=>{
 const f=await fixture(),reason='依頼取り消し';
 const s=await review(f.root,f.state.id,async()=>{
   const requested=await stop(f.root,f.state.id,reason);assert.equal(requested.status,'STOP_REQUESTED');assert.equal(requested.halt.reason,reason);
   assert.match(await readFile(requested.halt.logs.stopRequestLog,'utf8'),/依頼取り消し/);
   const pending=await status(f.root,f.state.id);assert.equal(pending.stopPending,true);assert.equal(pending.reason,reason);
   return {sessionId:id,review:pass};
 });
 assert.equal(s.status,'STOPPED');assert.equal(s.reason,reason);assert.equal((await persisted(f)).status,'STOPPED');
 const events=(await readFile(path.join(f.dir,'history.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(events.at(-1).halt.reason,reason);
});
test('limits, stagnation and process errors always save a specific reason',async()=>{
 const max=await fixture({maxRounds:1});await review(max.root,max.state.id,reply(fail));assert.match((await persisted(max)).reason,/最大レビュー回数 1/);
 const repeated=await fixture();await review(repeated.root,repeated.state.id,reply(fail));await review(repeated.root,repeated.state.id,reply(fail));assert.match((await persisted(repeated)).reason,/Input unchanged/);
 const stalled=await fixture({stallLimit:2});await review(stalled.root,stalled.state.id,reply(fail));await writeFile(path.join(stalled.root,'x.ts'),'modified');await review(stalled.root,stalled.state.id,reply(fail));assert.match((await persisted(stalled)).reason,/2 回連続/);
 const errored=await fixture();await review(errored.root,errored.state.id,async()=>{throw Error('TIMEOUT');});assert.equal((await persisted(errored)).reason,'TIMEOUT');
 const signal=await fixture();await review(signal.root,signal.state.id,async()=>{throw Error('STOPPED');});assert.match((await persisted(signal)).reason,/停止シグナル/);
});
test('billing failure before first round returns diagnostic reasons without inference',async()=>{
 const f=await fixture(),fake=path.join(f.root,'fake-claude.mjs');await writeFile(fake,'process.exit(1)');
 const r=spawnSync(process.execPath,[path.resolve('dist/cli.js'),'review','--root',f.root,'--run',f.state.id],{encoding:'utf8',windowsHide:true,env:{...process.env,REVLOOP_CLAUDE_PATH:fake}});
 assert.equal(r.status,2,r.stderr);const output=JSON.parse(r.stdout);assert.equal(output.rounds.length,0);assert.equal(output.halt.status,'BLOCKED');assert.ok(output.halt.billingReasons.includes('BILLING_PROBE_FAILED'));await readFile(output.halt.logs.billing);
 const preflight=spawnSync(process.execPath,[path.resolve('dist/cli.js'),'billing-check','--root',f.root,'--provider','claude'],{encoding:'utf8',windowsHide:true,env:{...process.env,REVLOOP_CLAUDE_PATH:fake}});
 assert.equal(preflight.status,2);const probe=JSON.parse(preflight.stdout)[0];assert.equal(probe.status,'BLOCKED');assert.ok(probe.reason);await readFile(probe.logs.billing);assert.match(await readFile(probe.logs.billingLog,'utf8'),/BILLING_PROBE_FAILED/);
});
test('CLI stop accepts reason and legacy halt statuses get a reason without fabricated log paths',async()=>{
 const f=await fixture();const r=spawnSync(process.execPath,[path.resolve('dist/cli.js'),'stop','--root',f.root,'--run',f.state.id,'--reason','確認待ちのため停止'],{encoding:'utf8',windowsHide:true});
 assert.equal(r.status,0,r.stderr);const out=JSON.parse(r.stdout);assert.equal(out.reason,'確認待ちのため停止');await readFile(out.halt.logs.halt);
 const g=await fixture();const legacy=buildHaltReport({...g.state,status:'MAX_ROUNDS'});assert.ok(legacy.reason);assert.equal(legacy.logs.halt,undefined);assert.ok(legacy.logs.state);
});
