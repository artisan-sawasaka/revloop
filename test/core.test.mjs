import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { start, review, stop, status } from '../dist/engine.js';
import { parseReview, assessReview } from '../dist/types.js';
import { snapshot, relativeFile } from '../dist/snapshot.js';
import { lock, runDir, recover } from '../dist/storage.js';
import { providerArgs, decodeResult } from '../dist/providers.js';
import { runProcess, subscriptionEnv } from '../dist/process.js';
import { install } from '../dist/install.js';
const sessionId = '11111111-2222-3333-4444-555555555555';
const fail = {verdict:'FAIL',summary:'Incorrect result',findings:[{severity:'P1',file:'calc.ts',line:1,message:'Addition returns subtraction',fix:'Use a + b'}]};
const pass = {verdict:'PASS',summary:'No unresolved defects',findings:[]};
const reply = review => async () => ({review,sessionId});
async function fixture(options={}) {
  const root = await mkdtemp(path.join(os.tmpdir(),'revloop-test-'));
  await writeFile(path.join(root,'calc.ts'),'export const add = (a,b) => a-b;\n');
  const state = await start(root,{source:'claude',context:'add must return the sum',title:'Test',files:['calc.ts'],...options});
  return {root,id:state.id,state};
}
test('FAIL -> source repair -> PASS retains reviewer ID, source chat, immutable history',async()=>{
  const {root,id}=await fixture({sourceSession:'original-chat'});
  const a=await review(root,id,reply(fail)); assert.equal(a.status,'NEEDS_FIX');
  await writeFile(path.join(root,'calc.ts'),'export const add = (a,b) => a+b;\n');
  const b=await review(root,id,async s=>{assert.equal(s.reviewerSession,sessionId); return {review:pass,sessionId};});
  assert.equal(b.status,'PASS'); assert.equal(b.rounds.length,2); assert.equal(b.sourceSession,'original-chat');
  assert.notEqual(b.rounds[0].fingerprint,b.rounds[1].fingerprint);
  assert.match(await readFile(path.join(root,'.revloop','runs',id,'round-1','input.json'),'utf8'),/a-b/);
  assert.equal((await review(root,id,()=>{throw Error('must not run');})).status,'PASS');
});
test('unchanged FAIL stops before another model request',async()=>{
  const {root,id}=await fixture(); await review(root,id,reply(fail));
  assert.equal((await review(root,id,()=>{throw Error('must not run');})).status,'STALLED');
});
test('cyclic input and repeated findings stop loops',async()=>{
  const {root,id}=await fixture({stallLimit:3}); await review(root,id,reply(fail));
  await writeFile(path.join(root,'calc.ts'),'second\n'); await review(root,id,reply(fail));
  await writeFile(path.join(root,'calc.ts'),'export const add = (a,b) => a-b;\n');
  assert.equal((await review(root,id,reply(pass))).status,'STALLED');
  const f=await fixture({stallLimit:2}); await review(f.root,f.id,reply(fail));
  await writeFile(path.join(f.root,'calc.ts'),'second\n');
  assert.equal((await review(f.root,f.id,reply(fail))).status,'STALLED');
});
test('max rounds and BLOCKED are terminal, never PASS',async()=>{
  const f=await fixture({maxRounds:1}); assert.equal((await review(f.root,f.id,reply(fail))).status,'MAX_ROUNDS');
  const b=await fixture(); assert.equal((await review(b.root,b.id,reply({verdict:'BLOCKED',summary:'Missing contract',findings:[]}))).status,'BLOCKED');
});
test('stop prevents further work and is visible between repairs',async()=>{
  const f=await fixture(); await stop(f.root,f.id); assert.equal((await status(f.root,f.id)).status,'STOPPED');
  assert.equal((await review(f.root,f.id,()=>{throw Error('must not invoke');})).status,'STOPPED');
});
test('source drift and reviewer input tampering reject even PASS',async()=>{
  const f=await fixture(); const s=await review(f.root,f.id,async()=>{await writeFile(path.join(f.root,'calc.ts'),'concurrent edit');return {review:pass,sessionId};});
  assert.equal(s.status,'ERROR'); assert.match(s.reason,/Source changed/);
  const g=await fixture(); const t=await review(g.root,g.id,async st=>{await writeFile(path.join(st.reviewerCwd,'input.json'),'tampered');return {review:pass,sessionId};});
  assert.equal(t.status,'ERROR'); assert.match(t.reason,/input modified/);
});
test('findings cannot direct the worker outside supplied files',async()=>{
  const f=await fixture(); const malicious={...fail,findings:[{...fail.findings[0],file:'../outside'}]};
  const s=await review(f.root,f.id,reply(malicious));assert.equal(s.status,'ERROR');assert.match(s.reason,/outside the supplied scope/);
});
test('provider exceptions persist error and release lock',async()=>{
  const f=await fixture(); const s=await review(f.root,f.id,async()=>{throw Error('expired OAuth');});
  assert.equal(s.status,'ERROR'); assert.equal(s.rounds[0].error,'expired OAuth');
  const release=await lock(await runDir(f.root,f.id)); await release();
});
test('concurrent review of same run is rejected',async()=>{
  const f=await fixture(); const release=await lock(await runDir(f.root,f.id));
  await assert.rejects(review(f.root,f.id,reply(pass)),/locked/); await release();
});
test('recovery refuses live process locks',async()=>{
  const f=await fixture(); const release=await lock(await runDir(f.root,f.id));
  await assert.rejects(recover(f.root,f.id),/still running/); await release();
});
test('strict review contract refuses malformed results without discarding valid findings and notes',()=>{
  for(const v of ['PASS','```json\n{}\n```',{}, {...pass,extra:1},{...pass,notes:'not an array'},{...pass,notes:['']},{...fail,findings:[{...fail.findings[0],line:-1}]}]) assert.throws(()=>parseReview(v));
  assert.deepEqual(parseReview(JSON.stringify(pass)),pass);
  assert.equal(assessReview(parseReview({...pass,findings:fail.findings})).effectiveVerdict,'FAIL');
  assert.equal(assessReview(parseReview({...fail,findings:[]})).effectiveVerdict,'BLOCKED');
  assert.equal(assessReview(parseReview({...pass,notes:['Optional future improvement']})).effectiveVerdict,'PASS');
});

test('PASS with required findings enters repair, retains reported verdict, and allows notes on completion',async()=>{
  for(const severity of ['P0','P3']) {
    const f=await fixture();const reported={...pass,findings:[{...fail.findings[0],severity}]};
    const first=await review(f.root,f.id,reply(reported));
    assert.equal(first.status,'NEEDS_FIX');assert.equal(first.rounds[0].review.verdict,'PASS');
    assert.deepEqual(first.rounds[0].review.findings,reported.findings);
    assert.equal(first.rounds[0].decision.effectiveVerdict,'FAIL');assert.match(first.reason,/PASS_WITH_REQUIRED_FINDINGS/);
    const recorded=JSON.parse(await readFile(path.join(f.root,'.revloop/runs',f.id,'round-1/decision.json'),'utf8'));assert.equal(recorded.reportedVerdict,'PASS');
    await writeFile(path.join(f.root,'calc.ts'),'export const add=(a,b)=>a+b;');
    const second=await review(f.root,f.id,async s=>{assert.equal(s.reviewerSession,sessionId);return {sessionId,review:{...pass,notes:['Optional: consider additional examples later.']}};});
    assert.equal(second.status,'PASS');assert.equal(second.reason,undefined);assert.equal(second.rounds[1].review.notes.length,1);
  }
});

test('FAIL without actionable findings is BLOCKED rather than an execution error',async()=>{
  const f=await fixture();const s=await review(f.root,f.id,reply({...fail,findings:[]}));
  assert.equal(s.status,'BLOCKED');assert.equal(s.rounds[0].decision.reportedVerdict,'FAIL');assert.match(s.reason,/FAIL_WITHOUT_FINDINGS/);
  assert.equal((await review(f.root,f.id,()=>{throw Error('must not retry');})).status,'BLOCKED');
});
test('Claude code-zero api_error is not a successful review',()=>{
  const raw={code:0,stderr:'',stdout:JSON.stringify({type:'result',subtype:'success',is_error:true,session_id:sessionId,result:'OAuth expired'})};
  assert.throws(()=>decodeResult('claude',raw),/Claude failed/);
  raw.stdout=JSON.stringify({type:'result',subtype:'success',is_error:false,session_id:sessionId,structured_output:pass});
  assert.equal(decodeResult('claude',raw).review.verdict,'PASS');
});
test('Codex requires completed turn, valid session, and valid final JSON',()=>{
  const events=[{type:'thread.started',thread_id:sessionId},{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(pass)}},{type:'turn.completed'}];
  const raw={code:0,stderr:'',stdout:events.map(JSON.stringify).join('\n')};
  assert.equal(decodeResult('codex',raw).review.verdict,'PASS');
  assert.throws(()=>decodeResult('codex',raw,'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),/session changed/);
  assert.throws(()=>decodeResult('codex',{...raw,stdout:events.slice(0,-1).map(JSON.stringify).join('\n')}),/did not complete/);
  assert.throws(()=>decodeResult('codex',{...raw,code:1}),/exited/);
});
test('argv locks down reviewer privileges on initial and resumed calls',()=>{
  for(const reviewer of ['codex','claude']) for(const reviewerSession of [undefined,sessionId]) {
    const a=providerArgs({reviewer,reviewerSession,title:'日本語 title " & % !'},'C:\\with spaces\\schema.json');
    assert.ok(!a.some(x=>x.includes('bypass')));
    if(reviewer==='codex'){assert.ok(a.includes('read-only'));assert.ok(a.includes('--ignore-user-config'));}
    else {assert.equal(a[a.indexOf('--tools')+1],'');assert.ok(a.includes('--safe-mode'));assert.ok(a.includes('--restricted'));}
    if(reviewerSession) assert.ok(a.includes(sessionId));
  }
});

test('Codex service error is shown instead of an unrelated stderr warning',()=>{
  const raw={code:1,stderr:'WARN: PowerShell snapshot not supported',stdout:JSON.stringify({type:'turn.failed',error:{message:'Selected model is at capacity. Please try a different model.'}})};
  assert.throws(()=>decodeResult('codex',raw),/Codex failed: Selected model is at capacity/);
  assert.throws(()=>decodeResult('codex',{...raw,failure:'TIMEOUT'}),/TIMEOUT/);
});
test('scope path traversal, secrets, oversized/binary input fail closed',async()=>{
  for(const p of ['../outside','C:\\secret','a/../../b','.git/config','.revloop/state','.env','secrets.key','a\nb']) assert.throws(()=>relativeFile(p));
  const f=await fixture(); await writeFile(path.join(f.root,'binary'),Buffer.from([1,0,3]));
  await assert.rejects(snapshot(f.root,['binary'],'context'),/Binary/);
  await writeFile(path.join(f.root,'large'),'x'.repeat(1_000_001)); await assert.rejects(snapshot(f.root,['large'],'context'),/oversized/);
  await assert.rejects(snapshot(f.root,[],'context'),/Not a Git repository/);
  await assert.rejects(snapshot(f.root,['typo.ts'],'context'),/does not exist/);
  await writeFile(path.join(f.root,'large-json.txt'),'a'.repeat(512_000));
  await assert.rejects(snapshot(f.root,['large-json.txt'],'context'),/512 KB/);
});
test('directory junction cannot escape review root',async t=>{
  const f=await fixture(), outside=await mkdtemp(path.join(os.tmpdir(),'revloop-outside-'));
  await writeFile(path.join(outside,'private'),'data');
  try {await symlink(outside,path.join(f.root,'link'),'junction');} catch(e) {if(e.code==='EPERM') {t.skip('symlink permission unavailable');return;} throw e;}
  await assert.rejects(snapshot(f.root,['link/private'],'context'),/Symlink/);
});
test('Git snapshot captures staged + unstaged + untracked and deletion',async()=>{
  const f=await fixture(); const git=async args=>{const r=await runProcess({executable:'git',prefix:[]},args,{cwd:f.root});assert.equal(r.code,0,r.stderr);};
  await git(['init']);await git(['add','calc.ts']);
  await writeFile(path.join(f.root,'calc.ts'),'changed after staging');await writeFile(path.join(f.root,'new.ts'),'new file');
  const s=JSON.parse((await snapshot(f.root,[],'context')).input);
  assert.match(s.git.staged,/a-b/);assert.match(s.git.unstaged,/changed after staging/);assert.equal(s.files.find(f=>f.path==='new.ts').content,'new file');
  assert.ok(!s.files.some(f=>f.path.startsWith('.revloop/')));
  await unlink(path.join(f.root,'calc.ts'));const deleted=JSON.parse((await snapshot(f.root,['calc.ts'],'context')).input);assert.equal(deleted.files[0].content,null);
});
test('child process argv and UTF8 stdin survive shell metacharacters',async()=>{
  const arg='日本語 " & | %PATH% ! $() spaces';
  const r=await runProcess({executable:process.execPath,prefix:[]},['-e','process.stdin.setEncoding("utf8"); let s=""; process.stdin.on("data",x=>s+=x); process.stdin.on("end",()=>console.log(JSON.stringify([process.argv[1],s])));',arg],{cwd:process.cwd(),input:arg});
  assert.equal(r.code,0);assert.deepEqual(JSON.parse(r.stdout),[arg,arg]);
});
test('timeouts and stop files terminate children',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'revloop-process-')),cmd={executable:process.execPath,prefix:[]},args=['-e','setInterval(()=>{},1000)'];
  assert.equal((await runProcess(cmd,args,{cwd:root,timeoutMs:150})).failure,'TIMEOUT');
  const stopFile=path.join(root,'STOP');setTimeout(()=>writeFile(stopFile,'stop'),200);
  assert.equal((await runProcess(cmd,args,{cwd:root,timeoutMs:5000,stopFile})).failure,'STOPPED');
  const alreadyStopped=await runProcess({executable:'nonexistent-executable',prefix:[]},[],{cwd:root,stopFile});
  assert.equal(alreadyStopped.failure,'STOPPED');
});
test('timeout kills the owned process tree including a grandchild',async()=>{
  const program='const {spawn}=require("node:child_process"); const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit"}); console.log(c.pid); setInterval(()=>{},1000);';
  const r=await runProcess({executable:process.execPath,prefix:[]},['-e',program],{cwd:process.cwd(),timeoutMs:700});
  assert.equal(r.failure,'TIMEOUT');const pid=Number(r.stdout.trim());assert.ok(pid>0);
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});
test('excessive provider output terminates instead of exhausting memory',async()=>{
  const r=await runProcess({executable:process.execPath,prefix:[]},['-e','setInterval(()=>process.stdout.write("x".repeat(100000)),1)'],{cwd:process.cwd(),timeoutMs:5000});
  assert.equal(r.failure,'OUTPUT_LIMIT');assert.ok(Buffer.byteLength(r.stdout)<=4_000_000);
});
test('subscription env refuses API key without exposing its value',()=>{
  for(const [provider,key] of [['claude','ANTHROPIC_API_KEY'],['codex','OPENAI_API_KEY']]) {
    assert.throws(()=>subscriptionEnv(provider,{[key]:'secret-do-not-log'}),e=>e.message.includes(key)&&!e.message.includes('secret-do-not-log'));
  }
});
test('desktop provider environment does not block the opposite reviewer or mutate host variables',()=>{
  const claudeHost={ANTHROPIC_BASE_URL:'https://desktop.example.invalid',ANTHROPIC_AUTH_TOKEN:'private-value',PATH:'example'};
  const codexChild=subscriptionEnv('codex',claudeHost);assert.deepEqual(codexChild,claudeHost);assert.notEqual(codexChild,claudeHost);
  assert.throws(()=>subscriptionEnv('claude',claudeHost),/ANTHROPIC_BASE_URL/);
  const codexHost={OPENAI_BASE_URL:'https://example.invalid'};
  assert.deepEqual(subscriptionEnv('claude',codexHost),codexHost);assert.throws(()=>subscriptionEnv('codex',codexHost),/OPENAI_BASE_URL/);
});
test('all relevant provider routing/auth overrides remain blocked, including case variants',()=>{
  for(const key of ['OPENAI_API_KEY','CODEX_API_KEY','OPENAI_BASE_URL'])assert.throws(()=>subscriptionEnv('codex',{[key.toLowerCase()]:'value'}));
  for(const key of ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY','ANTHROPIC_PROFILE','ANTHROPIC_FEDERATION_RULE_ID'])assert.throws(()=>subscriptionEnv('claude',{[key]:'value'}));
  assert.throws(()=>subscriptionEnv('unknown',{}),/Unknown/);
});
test('doctor can check only the opposite reviewer inside a desktop environment',async()=>{
  const f=await fixture(),fake=path.join(f.root,'fake-codex.mjs');
  await writeFile(fake,`const args=process.argv.slice(2);if(args.includes('--version'))console.log('codex-test');else if(args.includes('--help'))console.log('--ignore-user-config --ignore-rules --output-schema --sandbox --json');else if(args[0]==='features')console.log('shell_tool stable true\\nunified_exec stable true\\nmulti_agent stable true\\nmulti_agent_v2 stable true');else if(args[0]==='login')console.log('Logged in using ChatGPT');else process.exitCode=99;`);
  const env={...process.env,REVLOOP_CODEX_PATH:fake,REVLOOP_CLAUDE_PATH:path.join(f.root,'absent.exe'),ANTHROPIC_BASE_URL:'https://desktop.example.invalid'};
  delete env.OPENAI_API_KEY;delete env.CODEX_API_KEY;delete env.OPENAI_BASE_URL;
  const command={executable:process.execPath,prefix:[path.resolve('dist/cli.js')]};
  const selected=await runProcess(command,['doctor','--provider','codex'],{cwd:f.root,env});assert.equal(selected.code,0,selected.stderr);assert.equal(JSON.parse(selected.stdout).length,1);assert.equal(JSON.parse(selected.stdout)[0].auth,'ChatGPT');
  const both=await runProcess(command,['doctor'],{cwd:f.root,env});assert.equal(both.code,1);assert.equal(JSON.parse(both.stdout)[0].auth,'ChatGPT');assert.match(JSON.parse(both.stdout)[1].error,/ANTHROPIC_BASE_URL/);
  const bad=await runProcess(command,['doctor','--provider','unknown'],{cwd:f.root,env});assert.equal(bad.code,1);assert.match(bad.stderr,/must be codex or claude/);
});
test('installation writes both entrypoints and preserves existing skills',async()=>{
  const f=await fixture();const files=await install(f.root,'C:\\Program Files\\revloop\\cli.js');
  assert.equal(files.length,2);const before=await readFile(files[0],'utf8');assert.match(before,/SAME UUID/);
  await assert.rejects(install(f.root,'other'),/already exists/);assert.equal(await readFile(files[0],'utf8'),before);
});
