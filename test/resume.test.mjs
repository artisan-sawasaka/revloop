import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,unlink} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {start,review,status} from '../dist/engine.js';
import {resume} from '../dist/resume.js';
import {atomicJson,event,lock,saveState} from '../dist/storage.js';
import {assessBilling,assessClaudeSubscription,BillingSafetyError} from '../dist/billing.js';
import {runProcess} from '../dist/process.js';

const account='a'.repeat(64),session='11111111-2222-3333-4444-555555555555';
const allow=()=>assessClaudeSubscription({evidence:'claude-auth-status',plan:'max',model:'opus',accountFingerprint:account,checkedAt:new Date().toISOString()});
const fail={verdict:'FAIL',summary:'repair needed',findings:[{severity:'P2',file:'x.ts',line:1,message:'incorrect constant',fix:'use 2'}]};
async function blocked({round=true,...options}={}) {
 const root=await mkdtemp(path.join(os.tmpdir(),'revloop-resume-'));await writeFile(path.join(root,'x.ts'),'export const x=1;');
 let s=await start(root,{source:'codex',title:'legacy',context:'x must be 2',files:['x.ts'],sourceSession:'source-chat',...options});
 const dir=path.join(root,'.revloop/runs',s.id);
 if(round){
  await event(dir,{type:'billing-allowed',provider:'claude',accountFingerprint:account});
  s=await review(root,s.id,async()=>({sessionId:session,review:fail}));
  await atomicJson(path.join(dir,'round-1/billing-check.json'),allow());
 }
 s.status='BLOCKED';s.billing=assessBilling('claude');s.billing.reasons=['BILLING_PROBE_FAILED','CLAUDE_DIAGNOSTIC_UNVERIFIED'];s.reason='old /usage timeout';
 await atomicJson(path.join(dir,'billing-check.json'),s.billing);await saveState(dir,s);
 await event(dir,{type:'billing-blocked',provider:'claude',reasons:s.billing.reasons});await event(dir,{type:'state',status:'BLOCKED',round:s.rounds.length});
 return {root,id:s.id,dir,s};
}
test('explicit resume preserves completed history, session and limits; repair then re-review passes',async()=>{
 const f=await blocked(),before=await readFile(path.join(f.dir,'state.json'),'utf8'),history=await readFile(path.join(f.dir,'history.jsonl'),'utf8');
 const raw=await readFile(path.join(f.dir,'round-1/review.json'),'utf8');
 const s=await resume(f.root,f.id,async()=>allow());assert.equal(s.status,'NEEDS_FIX');assert.equal(s.reason,undefined);
 assert.equal(s.reviewerSession,session);assert.equal(s.sourceSession,'source-chat');assert.deepEqual(s.rounds,f.s.rounds);assert.equal(s.maxRounds,f.s.maxRounds);assert.equal(s.stallLimit,f.s.stallLimit);assert.equal(s.timeoutMs,f.s.timeoutMs);
 assert.equal(await readFile(path.join(s.resumeAttempt.directory,'state.json'),'utf8'),before);assert.ok((await readFile(path.join(f.dir,'history.jsonl'),'utf8')).startsWith(history));assert.equal(await readFile(path.join(f.dir,'round-1/review.json'),'utf8'),raw);
 assert.ok(existsSync(path.join(s.resumeAttempt.directory,'halt.log')));assert.ok(!existsSync(path.join(f.dir,'halt.log')));
 await writeFile(path.join(f.root,'x.ts'),'export const x=2;');
 const done=await review(f.root,f.id,async st=>{assert.equal(st.reviewerSession,session);return {sessionId:session,review:{verdict:'PASS',summary:'fixed',findings:[]}};});assert.equal(done.status,'PASS');assert.equal(done.rounds.length,2);
});
test('changed input resumes READY, but unchanged review still trips stagnation',async()=>{
 const f=await blocked();await writeFile(path.join(f.root,'x.ts'),'export const x=2;');assert.equal((await resume(f.root,f.id,async()=>allow())).status,'READY');
 const g=await blocked();await resume(g.root,g.id,async()=>allow());assert.equal((await review(g.root,g.id,async()=>{throw Error('must not infer');})).status,'STALLED');
});
test('failed recheck stays blocked and subsequent explicit retry uses original identity',async()=>{
 const f=await blocked();const wrong={...allow(),accountFingerprint:'b'.repeat(64)};
 let s=await resume(f.root,f.id,async()=>wrong);assert.equal(s.status,'BLOCKED');assert.deepEqual(s.billing.reasons,['ACCOUNT_CHANGED_DURING_RUN']);
 s=await resume(f.root,f.id,async()=>{throw new BillingSafetyError(assessClaudeSubscription());});assert.equal(s.status,'BLOCKED');assert.equal(s.rounds.length,1);
 s=await resume(f.root,f.id,async()=>allow());assert.equal(s.status,'NEEDS_FIX');
});
test('resume rejects other states, non-billing blocks, partial attempts, missing evidence, STOP and exhausted limits',async()=>{
 const never=async()=>{assert.fail('must reject before diagnostic');};
 for(const state of ['PASS','ERROR','STALLED','STOPPED','MAX_ROUNDS','READY']){const f=await blocked();f.s.status=state;await saveState(f.dir,f.s);await assert.rejects(resume(f.root,f.id,never),/requires a billing/);}
 const b=await blocked();b.s.billing=allow();await saveState(b.dir,b.s);await assert.rejects(resume(b.root,b.id,never),/requires a billing/);
 const p=await blocked();delete p.s.rounds[0].review;await saveState(p.dir,p.s);await assert.rejects(resume(p.root,p.id,never),/partial/);
 const m=await blocked();await unlink(path.join(m.dir,'round-1/billing-check.json'));await assert.rejects(resume(m.root,m.id,never),/ENOENT/);
 const stop=await blocked();await writeFile(path.join(stop.dir,'STOP'),'user stop');await assert.rejects(resume(stop.root,stop.id,never),/STOP/);
 const max=await blocked({maxRounds:1});await assert.rejects(resume(max.root,max.id,never),/maximum/);
 const stall=await blocked({stallLimit:1});await assert.rejects(resume(stall.root,stall.id,never),/stagnation/);
 const invalid=await blocked();await writeFile(path.join(invalid.dir,'history.jsonl'),JSON.stringify({type:'state',status:'BLOCKED'})+'\n');await assert.rejects(resume(invalid.root,invalid.id,never),/history/);
});
test('resume respects exclusive lock and stop arriving during authentication',async()=>{
 const f=await blocked(),release=await lock(f.dir);await assert.rejects(resume(f.root,f.id,async()=>allow()),/locked/);await release();
 const s=await resume(f.root,f.id,async()=>{await writeFile(path.join(f.dir,'STOP'),'cancel during recheck');return allow();});assert.equal(s.status,'STOPPED');assert.equal(s.reason,'cancel during recheck');assert.equal((await status(f.root,f.id)).status,'STOPPED');
});
test('public resume probes auth only, requires explicit invocation, and rejects force/limit options',async()=>{
 const f=await blocked({round:false}),fake=path.join(f.root,'fake.mjs'),log=path.join(f.root,'calls.jsonl');
 await writeFile(fake,`import {appendFileSync} from 'node:fs';const a=process.argv.slice(2);appendFileSync(process.env.FAKE_LOG,JSON.stringify(a)+'\\n');if(a.join(' ')==='auth status')console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'max',email:'fixture@example.invalid',orgId:'fixture'}));else process.exitCode=91;`);
 const cmd={executable:process.execPath,prefix:[path.resolve('dist/cli.js')]},env={...process.env,REVLOOP_CLAUDE_PATH:fake,FAKE_LOG:log};
 let result=await runProcess(cmd,['review','--run',f.id],{cwd:f.root,env});assert.equal(result.code,2);assert.ok(!existsSync(log));
 for(const option of [['--force'],['--max-rounds','50']]){result=await runProcess(cmd,['resume','--run',f.id,...option],{cwd:f.root,env});assert.equal(result.code,1);assert.ok(!existsSync(log));}
 result=await runProcess(cmd,['resume','--run',f.id],{cwd:f.root,env});assert.equal(result.code,0,result.stderr);const s=JSON.parse(result.stdout);assert.equal(s.status,'READY');assert.equal(s.rounds.length,0);assert.equal(s.billingPolicy,'subscription-auth-only');
 assert.deepEqual((await readFile(log,'utf8')).trim().split('\n').map(JSON.parse),[['auth','status']]);
});
