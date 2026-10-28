import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {start,review,status,stop} from '../dist/engine.js';
import {restart,RestartError} from '../dist/restart.js';
import {resume} from '../dist/resume.js';
import {reviewCount} from '../dist/types.js';
import {atomicJson,saveState,event,lock} from '../dist/storage.js';
import {defaults,settingsFile} from '../dist/settings.js';
import {assessClaudeSubscription,BillingSafetyError} from '../dist/billing.js';
import {runProcess} from '../dist/process.js';
import {buildHaltReport} from '../dist/halt.js';

const home=await mkdtemp(path.join(os.tmpdir(),'revloop-cycle-home-'));
process.env.USERPROFILE=home;process.env.HOME=home;
await mkdir(path.dirname(settingsFile()),{recursive:true});
await atomicJson(settingsFile(),{...defaults(),loop:{maxRounds:2,stallLimit:7,timeoutSeconds:17}});
const session='11111111-2222-3333-4444-555555555555';
const account=createHash('sha256').update('fixture@example.invalid\0fixture').digest('hex');
const allow=()=>assessClaudeSubscription({evidence:'claude-auth-status',plan:'max',model:'opus',accountFingerprint:account,checkedAt:new Date().toISOString()});
const fail=message=>({verdict:'FAIL',summary:message,findings:[{severity:'P1',file:'x.ts',line:1,message,fix:'repair'}]});
const reply=value=>async()=>({sessionId:session,review:value});
async function fixture(){
 const root=await mkdtemp(path.join(home,'project-'));await writeFile(path.join(root,'x.ts'),'first');
 let s=await start(root,{source:'codex',title:'cycle test',context:'fixture',sourceSession:'source',files:['x.ts'],maxRounds:1,stallLimit:2,timeoutMs:8000});
 s=await review(root,s.id,reply(fail('old finding')));assert.equal(s.status,'MAX_ROUNDS');
 const dir=path.join(root,'.revloop/runs',s.id);s.billing=allow();await saveState(dir,s);await atomicJson(path.join(dir,'billing-check.json'),s.billing);await atomicJson(path.join(dir,'round-1/billing-check.json'),s.billing);
 return {root,id:s.id,s,dir};
}
test('new cycle resets only current count, applies shared maximum, retains findings, scope and complete evidence',async()=>{
 const f=await fixture(),before=await readFile(path.join(f.dir,'state.json'),'utf8'),raw=await readFile(path.join(f.dir,'round-1/review.json'),'utf8');
 const next=await restart(f.root,f.id,async()=>allow());assert.equal(next.status,'NEEDS_FIX');assert.equal(reviewCount(next),0);assert.equal(next.maxRounds,2);assert.equal(next.cycle.number,2);
 assert.equal(next.stallLimit,2);assert.equal(next.timeoutMs,8000);assert.equal(next.reviewerSession,session);assert.equal(next.sourceSession,'source');assert.deepEqual(next.rounds,f.s.rounds);assert.deepEqual(next.files,f.s.files);assert.equal(next.context,f.s.context);
 assert.equal(await readFile(path.join(next.cycle.archiveDirectory,'state.json'),'utf8'),before);assert.equal(await readFile(path.join(f.dir,'round-1/review.json'),'utf8'),raw);assert.ok(!existsSync(path.join(f.dir,'halt.json')));
 await writeFile(path.join(f.root,'x.ts'),'second');let s=await review(f.root,f.id,reply(fail('new finding')));assert.equal(s.status,'NEEDS_FIX');assert.equal(reviewCount(s),1);
 await writeFile(path.join(f.root,'x.ts'),'third');s=await review(f.root,f.id,reply(fail('third finding')));assert.equal(s.status,'MAX_ROUNDS');assert.equal(reviewCount(s),2);assert.equal(s.rounds.length,3);
 const halt=buildHaltReport(s);assert.equal(halt.round,2);assert.equal(halt.totalReviews,3);assert.equal(halt.cycleNumber,2);
 assert.equal((await review(f.root,f.id,async()=>assert.fail('automatic loop must stop'))).status,'MAX_ROUNDS');
 s=await restart(f.root,f.id,async()=>allow());assert.equal(reviewCount(s),0);assert.equal(s.cycle.number,3);assert.equal(s.rounds.length,3);
});
test('unchanged input and identical findings remain stalled across cycle boundaries',async()=>{
 const f=await fixture();await restart(f.root,f.id,async()=>allow());assert.equal((await review(f.root,f.id,async()=>assert.fail('no inference'))).status,'STALLED');
 const g=await fixture();await restart(g.root,g.id,async()=>allow());await writeFile(path.join(g.root,'x.ts'),'changed');assert.equal((await review(g.root,g.id,reply(fail('old finding')))).status,'STALLED');
});
test('fresh authentication failure and changed account preserve the exhausted cycle and write reason logs',async()=>{
 const f=await fixture(),before=await readFile(path.join(f.dir,'state.json'),'utf8');
 for(const check of [async()=>{throw new BillingSafetyError(assessClaudeSubscription());},async()=>({...allow(),accountFingerprint:'b'.repeat(64)})]){
  await assert.rejects(restart(f.root,f.id,check),e=>{assert.ok(e instanceof RestartError);assert.equal(e.diagnostic.status,'BLOCKED');assert.ok(e.diagnostic.billingReasons.length);assert.ok(existsSync(e.diagnostic.logs.result));return true;});
  assert.equal(await readFile(path.join(f.dir,'state.json'),'utf8'),before);
 }
 assert.equal(reviewCount(await restart(f.root,f.id,async()=>allow())),0);
});
test('STOP including concurrent stop, locks, other terminal statuses and incomplete reviews cannot restart',async()=>{
 for(const st of ['STALLED','STOPPED','BLOCKED','ERROR','PASS','READY','NEEDS_FIX','REVIEWING']){const f=await fixture();f.s.status=st;await saveState(f.dir,f.s);await assert.rejects(restart(f.root,f.id,async()=>assert.fail('must not check')),/maximum review count/);}
 const partial=await fixture();partial.s.rounds[0].error='interrupted';await saveState(partial.dir,partial.s);await assert.rejects(restart(partial.root,partial.id,async()=>allow()),/partial/);
 const f=await fixture(),release=await lock(f.dir);await assert.rejects(restart(f.root,f.id,async()=>allow()),/locked/);await release();
 await assert.rejects(restart(f.root,f.id,async()=>{const r=await stop(f.root,f.id,'user cancelled restart');assert.equal(r.status,'STOP_REQUESTED');return allow();}),/STOP/);
 assert.equal((await status(f.root,f.id)).status,'STOPPED');assert.equal((await status(f.root,f.id)).maxRounds,1);
});
test('billing-blocked later cycle can resume even when lifetime total exceeds this cycle budget',async()=>{
 const f=await fixture();let s=await restart(f.root,f.id,async()=>allow());
 await writeFile(path.join(f.root,'x.ts'),'second');s=await review(f.root,f.id,reply(fail('second finding')));
 await atomicJson(path.join(f.dir,'round-2/billing-check.json'),allow());
 s.status='BLOCKED';s.billing=assessClaudeSubscription();s.reason='auth unavailable';await saveState(f.dir,s);
 await event(f.dir,{type:'billing-blocked',provider:'claude',reasons:s.billing.reasons});await event(f.dir,{type:'state',status:'BLOCKED'});
 s=await resume(f.root,f.id,async()=>allow());assert.equal(s.status,'NEEDS_FIX');assert.equal(reviewCount(s),1);assert.equal(s.rounds.length,2);assert.equal(s.maxRounds,2);
});
test('public review reinvocation at MAX_ROUNDS starts count zero without inference; next call keeps session and resumes review',async()=>{
 const f=await fixture(),fake=path.join(f.root,'fake.mjs'),log=path.join(f.root,'calls.jsonl');
 await writeFile(fake,`import {appendFileSync} from 'node:fs';const a=process.argv.slice(2);appendFileSync(process.env.FAKE_LOG,JSON.stringify(a)+'\\n');if(a[0]==='auth')console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'max',email:'fixture@example.invalid',orgId:'fixture'}));else if(a[0]==='--version')console.log('2.1.999 (Claude Code)');else if(a[0]==='--help')console.log('--safe-mode --restricted --strict-mcp-config --tools --json-schema --name');else if(a.includes('-p'))console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,session_id:'${session}',structured_output:{verdict:'PASS',summary:'fixture fixed',findings:[],notes:[]}}));else process.exitCode=97;`);
 const cmd={executable:process.execPath,prefix:[path.resolve('dist/cli.js')]},env={...process.env,REVLOOP_CLAUDE_PATH:fake,FAKE_LOG:log};
 let r=await runProcess(cmd,['review','--run',f.id],{cwd:f.root,env});assert.equal(r.code,0,r.stderr);let s=JSON.parse(r.stdout);assert.equal(s.status,'NEEDS_FIX');assert.equal(s.reviewCount,0);assert.equal(s.totalReviewCount,1);assert.equal(s.maxRounds,2);assert.deepEqual((await readFile(log,'utf8')).trim().split('\n').map(JSON.parse),[['auth','status']]);
 await writeFile(path.join(f.root,'x.ts'),'fixed');r=await runProcess(cmd,['review','--run',f.id],{cwd:f.root,env});assert.equal(r.code,0,r.stderr);s=JSON.parse(r.stdout);assert.equal(s.status,'PASS');assert.equal(s.reviewCount,1);assert.equal(s.totalReviewCount,2);assert.equal(s.reviewerSession,session);
 const calls=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);const inference=calls.filter(a=>a.includes('-p'));assert.equal(inference.length,1);assert.ok(inference[0].includes('--resume'));assert.ok(inference[0].includes(session));assert.ok(calls.every(a=>!a.includes('/usage')));
 const bad=await runProcess(cmd,['restart','--run',f.id],{cwd:f.root,env});assert.equal(bad.code,2);const d=JSON.parse(bad.stdout);assert.equal(d.runStatus,'PASS');assert.ok(existsSync(d.logs.result));assert.equal((await status(f.root,f.id)).status,'PASS');
});
