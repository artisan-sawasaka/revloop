import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {assessBilling,assessClaudeSubscription,BillingSafetyError,requireSameAccount} from '../dist/billing.js';
import {codexFingerprint,validConfirmation,CONFIRMATION_TTL_MS} from '../dist/billing-confirmation.js';
import {parseClaudeUsageScreen,CLAUDE_USAGE_VERSION,parseClaudeAuthStatus,ClaudeAuthError} from '../dist/claude-usage.js';
import {runProcess} from '../dist/process.js';
import {start,review} from '../dist/engine.js';
const now=Date.now();
const zero=()=>({accountId:'test-account',authType:'chatgpt',authenticatedPlan:'prolite',rateLimitsByLimitId:{codex:{planType:'prolite',primary:{usedPercent:12,resetsAt:Math.floor(now/1000)+3600},secondary:null,credits:{hasCredits:false,unlimited:false,balance:'0'},spendControlReached:false,rateLimitReachedType:null}}});
const receipt=()=>({version:1,provider:'codex',source:'user-confirmed',autoReloadOff:true,accountFingerprint:codexFingerprint('test-account'),confirmedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now-1000+CONFIRMATION_TTL_MS).toISOString()});
const claude=()=>({evidence:'claude-usage-tty',version:CLAUDE_USAGE_VERSION,plan:'max',model:'opus',accountFingerprint:'a'.repeat(64),checkedAt:new Date(now-100).toISOString(),usageCreditsOff:true,quotaUsedPercent:[2,7]});
const screen=`Session
Total duration (API):  0s
Usage:                 0 input, 0 output, 0 cache read, 0 cache write
Current session
2% 2% used
Resets 3:09pm (Etc/GMT-9)
Current week (all models)
7% 7% used
Resets Oct 22, 8:59pm (Etc/GMT-9)
Usage credits
Usage credits are off · /usage-credits to turn them on`;
test('Codex allows fresh quota + zero credits + matching unexpired user OFF confirmation',()=>{
 const r=assessBilling('codex',zero(),receipt(),now);assert.equal(r.status,'ALLOW');assert.equal(r.modelExecutionAllowed,true);assert.ok(r.evidence.includes('user-confirmed-auto-reload-off'));assert.equal(r.observations.autoReloadEnabled,false);
 for(const plan of ['plus','pro','prolite']){
  const evidence=zero();evidence.authenticatedPlan=plan;evidence.rateLimitsByLimitId.codex.planType=plan;
  assert.equal(assessBilling('codex',evidence,receipt(),now).status,'ALLOW');
  assert.equal(assessBilling('codex',evidence,undefined,now).status,'BLOCKED');
 }
});
test('Codex fails closed without confirmation or on expiry/account change/future confirmation',()=>{
 for(const c of [undefined,{...receipt(),autoReloadOff:false},{...receipt(),accountFingerprint:'b'.repeat(64)},{...receipt(),expiresAt:new Date(now-1).toISOString()},{...receipt(),confirmedAt:new Date(now+5000).toISOString(),expiresAt:new Date(now+5000+CONFIRMATION_TTL_MS).toISOString()}])assert.equal(assessBilling('codex',zero(),c,now).status,'BLOCKED');
 assert.equal(validConfirmation(receipt(),codexFingerprint('test-account'),now),true);
});
test('Codex refuses paid credits, exhausted/expired/malformed windows, API auth and unsupported plans',()=>{
 for(const mutate of [r=>r.rateLimitsByLimitId.codex.credits.balance='1',r=>r.rateLimitsByLimitId.codex.credits.hasCredits=true,r=>r.rateLimitsByLimitId.codex.credits.unlimited=true,r=>r.rateLimitsByLimitId.codex.primary.usedPercent=100,r=>r.rateLimitsByLimitId.codex.primary.resetsAt=0,r=>r.rateLimitsByLimitId.codex.primary.usedPercent=NaN,r=>r.authType='apiKey',r=>r.authenticatedPlan='enterprise',r=>r.rateLimitsByLimitId={},r=>r.rateLimitsByLimitId=[],r=>r.rateLimitsByLimitId.codex.credits=null,r=>r.rateLimitsByLimitId.codex.rateLimitReachedType='rate_limit_reached',r=>r.rateLimitsByLimitId.codex.spendControlReached=null]){const r=zero();mutate(r);assert.equal(assessBilling('codex',r,receipt(),now).status,'BLOCKED');}
});
test('historical Claude usage evidence is still assessed without rewriting old guarantees',()=>{
 assert.equal(assessBilling('claude',claude(),undefined,now).status,'ALLOW');
 for(const change of [{usageCreditsOff:false},{quotaUsedPercent:[100,7]},{quotaUsedPercent:[0]},{quotaUsedPercent:[NaN,1]},{checkedAt:new Date(now-31_000).toISOString()},{version:'2.1.999'},{evidence:'manual'},{model:'fable'},{plan:'api'}])assert.equal(assessBilling('claude',{...claude(),...change},undefined,now).status,'BLOCKED');
});

test('Claude auth-only policy does not require quota or assert paid usage is disabled',()=>{
 const proof={evidence:'claude-auth-status',plan:'max',model:'opus',accountFingerprint:'a'.repeat(64),checkedAt:new Date(now-100).toISOString()};
 const r=assessClaudeSubscription(proof,now);assert.equal(r.status,'ALLOW');assert.equal(r.policy,'subscription-auth-only');assert.equal(r.observations.paidUsageDisabled,null);assert.deepEqual(r.observations.quotaUsedPercent,[]);assert.ok(r.warnings.includes('CLAUDE_USAGE_NOT_CHECKED'));
 for(const change of [{plan:'api'},{accountFingerprint:null},{checkedAt:new Date(now-31_000).toISOString()},{checkedAt:new Date(now+1000).toISOString()},{evidence:'claude-usage-tty'}])assert.equal(assessClaudeSubscription({...proof,...change},now).status,'BLOCKED');
 for(const plan of ['pro','max']){const allowed=assessClaudeSubscription({...proof,plan},now);assert.equal(allowed.status,'ALLOW');assert.equal(allowed.plan,plan);assert.equal(allowed.observations.paidUsageDisabled,null);}
});

test('Claude Pro and Max auth preserve account identity and reject unsupported plans, API routing and missing identity with safe reasons',()=>{
 const base={loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'max',email:'private@example.invalid',orgId:'private-org'};
 const max=parseClaudeAuthStatus(base),pro=parseClaudeAuthStatus({...base,subscriptionType:'pro'});
 assert.equal(pro.plan,'pro');assert.equal(max.plan,'max');assert.equal(pro.accountFingerprint,max.accountFingerprint);
 for(const [change,reason] of [[{loggedIn:false},'CLAUDE_AUTH_NOT_LOGGED_IN'],[{authMethod:'apiKey'},'CLAUDE_AUTH_METHOD_NOT_SUBSCRIPTION'],[{apiProvider:'bedrock'},'CLAUDE_API_PROVIDER_NOT_FIRST_PARTY'],[{subscriptionType:'free'},'CLAUDE_SUBSCRIPTION_PLAN_UNSUPPORTED'],[{subscriptionType:'team'},'CLAUDE_SUBSCRIPTION_PLAN_UNSUPPORTED'],[{subscriptionType:null},'CLAUDE_SUBSCRIPTION_PLAN_UNSUPPORTED'],[{email:' '},'CLAUDE_ACCOUNT_IDENTITY_MISSING'],[{orgId:null},'CLAUDE_ACCOUNT_IDENTITY_MISSING']]){
   assert.throws(()=>parseClaudeAuthStatus({...base,...change}),e=>e instanceof ClaudeAuthError&&e.reasons.includes(reason)&&!e.message.includes(base.email)&&!e.message.includes(base.orgId));
 }
 for(const invalid of [null,[],true,'json'])assert.throws(()=>parseClaudeAuthStatus(invalid),/CLAUDE_AUTH_RESPONSE_INVALID/);
 assert.notEqual(parseClaudeAuthStatus({...base,orgId:'another-org'}).accountFingerprint,max.accountFingerprint);
});

test('Claude review uses auth status without invoking /usage, while API auth remains blocked',async()=>{
 const root=await fixture(),fake=path.join(root,'fake-auth-claude.mjs'),log=path.join(root,'calls.jsonl');
 await writeFile(fake,`import {appendFileSync} from 'node:fs';const a=process.argv.slice(2);appendFileSync(process.env.FAKE_LOG,JSON.stringify(a)+'\\n');if(a[0]==='auth')console.log(JSON.stringify({loggedIn:true,authMethod:process.env.FAKE_AUTH_METHOD||'claude.ai',apiProvider:'firstParty',subscriptionType:process.env.FAKE_PLAN||'max',email:'fixture@example.invalid',orgId:'fixture-org'}));else if(a[0]==='--version')console.log('2.1.999 (Claude Code)');else if(a[0]==='--help')console.log('--safe-mode --restricted --strict-mcp-config --tools --json-schema --name');else if(a.includes('-p'))console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,session_id:'11111111-2222-3333-4444-555555555555',structured_output:{verdict:'PASS',summary:'fixture only',findings:[],notes:[]}}));else process.exitCode=97;`);
 const s=await start(root,{source:'codex',context:'auth-only fixture',title:'No usage TTY',files:['x.ts']});
 const cmd={executable:process.execPath,prefix:[path.resolve('dist/cli.js')]},env={...process.env,REVLOOP_CLAUDE_PATH:fake,FAKE_LOG:log};
 const r=await runProcess(cmd,['review','--root',root,'--run',s.id],{cwd:root,env});assert.equal(r.code,0,r.stderr);
 const result=JSON.parse(r.stdout);assert.equal(result.status,'PASS');assert.equal(result.billingPolicy,'subscription-auth-only');assert.equal(result.billing.observations.paidUsageDisabled,null);
 const calls=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);assert.ok(calls.filter(a=>a[0]==='auth').length>=2);assert.ok(calls.some(a=>a.includes('-p')));assert.ok(calls.every(a=>['auth','--version','--help'].includes(a[0])||a.includes('-p')));assert.ok(calls.every(a=>!a.includes('--ax-screen-reader')));
 const bad=await runProcess(cmd,['billing-check','--provider','claude'],{cwd:root,env:{...env,FAKE_AUTH_METHOD:'apiKey'}});assert.equal(bad.code,2);
 assert.ok(JSON.parse(bad.stdout)[0].reasons.includes('CLAUDE_AUTH_METHOD_NOT_SUBSCRIPTION'));assert.ok(!bad.stdout.includes('fixture@example.invalid'));
 const pro=await runProcess(cmd,['billing-check','--provider','claude'],{cwd:root,env:{...env,FAKE_PLAN:'pro'}});assert.equal(pro.code,0);assert.equal(JSON.parse(pro.stdout)[0].plan,'pro');
 const free=await runProcess(cmd,['billing-check','--provider','claude'],{cwd:root,env:{...env,FAKE_PLAN:'free'}});assert.equal(free.code,2);assert.ok(JSON.parse(free.stdout)[0].reasons.includes('CLAUDE_SUBSCRIPTION_PLAN_UNSUPPORTED'));
 const before=await readFile(log,'utf8');const key=await runProcess(cmd,['billing-check','--provider','claude'],{cwd:root,env:{...env,ANTHROPIC_API_KEY:'never-log-this'}});assert.equal(key.code,2);assert.equal(await readFile(log,'utf8'),before);assert.ok(!key.stdout.includes('never-log-this'));
});

test('READY guidance distinguishes Claude auth-only from Codex credit verification',async()=>{
 const root=await fixture(),cmd={executable:process.execPath,prefix:[path.resolve('dist/cli.js')]};
 for(const source of ['codex','claude']) {
  const result=await runProcess(cmd,['start','--source',source,'--context','x.ts','--title','Policy guidance','--file','x.ts'],{cwd:root});
  assert.equal(result.code,0,result.stderr);const state=JSON.parse(result.stdout);assert.equal(state.status,'READY');
  if(source==='codex'){assert.equal(state.billingPolicy,'subscription-auth-only');assert.match(state.nextAction,/追加利用OFFは未確認/);assert.ok(!state.nextAction.includes('no-credit safety'));}
  else {assert.equal(state.billingPolicy,'included-subscription-only');assert.match(state.nextAction,/no-credit safety/);}
 }
});
test('usage-screen parser rejects stale, updating, missing, conflicting, or non-diagnostic screens',()=>{
 assert.deepEqual(parseClaudeUsageScreen(screen),{usageCreditsOff:true,quotaUsedPercent:[2,7]});
 for(const s of [screen+'\nRefreshing…',screen+'\nShowing last-known usage',screen+'\nPermission Required: Accessing workspace',screen.replace('are off','are on'),screen.replace('0 input','5 input'),screen.replace('7% 7%','7% 100%'),screen.replace('Current session','Unknown session'),screen+'\nCurrent session\n3% used\nResets tomorrow',screen.replace('0s','1s')])assert.equal(parseClaudeUsageScreen(s),null);
});
test('rendered terminal replacements cannot be accepted by matching stale raw history',async()=>{
 const {default:xterm}=await import('@xterm/headless');const term=new xterm.Terminal({cols:160,rows:100,allowProposedApi:true});const write=s=>new Promise(resolve=>term.write(s,resolve));
 await write(screen.replaceAll('\n','\r\n'));await write('\x1b[2J\x1b[HUsage endpoint is rate limited\r\nShowing last-known usage');
 const b=term.buffer.active;const rendered=Array.from({length:100},(_,i)=>b.getLine(b.baseY+i)?.translateToString(true)||'').join('\n');assert.equal(parseClaudeUsageScreen(rendered),null);term.dispose();
});
test('account changes between rounds are rejected even when both accounts independently allow',()=>{
 const previous=assessBilling('claude',claude(),undefined,now),next={...previous,accountFingerprint:'b'.repeat(64)};assert.throws(()=>requireSameAccount(previous,next),BillingSafetyError);assert.doesNotThrow(()=>requireSameAccount(previous,previous));
});
async function fixture(){const root=await mkdtemp(path.join(os.tmpdir(),'revloop-billing-'));await writeFile(path.join(root,'x.ts'),'export const x=1;');return root;}
test('confirmation failure blocks actual adapter before a round or inference',async()=>{
 const root=await fixture(),fake=path.join(root,'fake-claude.mjs');await writeFile(fake,'process.exit(1)');
 const s=await start(root,{source:'codex',context:'review',title:'No spawn',files:['x.ts']});
 const cmd={executable:process.execPath,prefix:[path.resolve('dist/cli.js')]};
 const result=await runProcess(cmd,['review','--run',s.id],{cwd:root,env:{...process.env,REVLOOP_CLAUDE_PATH:fake}});
 assert.equal(result.code,2);const r=JSON.parse(result.stdout);assert.equal(r.status,'BLOCKED');assert.equal(r.rounds.length,0);assert.equal(r.reviewerSession,undefined);assert.ok(!(await readdir(path.join(root,'.revloop','runs',s.id))).some(f=>f.startsWith('round-')));
});
test('legacy NEEDS_FIX run is blocked if its current billing check fails',async()=>{
 const root=await fixture(),s=await start(root,{source:'codex',context:'review',title:'Legacy',files:['x.ts']});
 await review(root,s.id,async()=>({sessionId:'11111111-2222-3333-4444-555555555555',review:{verdict:'FAIL',summary:'fix',findings:[{severity:'P2',file:'x.ts',line:1,message:'change',fix:'fix'}]}}));
 const result=await runProcess({executable:process.execPath,prefix:[path.resolve('dist/cli.js')]},['review','--run',s.id],{cwd:root,env:{...process.env,REVLOOP_CLAUDE_PATH:path.join(root,'absent.exe')}});assert.equal(result.code,2);assert.equal(JSON.parse(result.stdout).rounds.length,1);
});
test('Codex probe only reads account/limits, no inference or credit operations, no force flag',async()=>{
 const root=await fixture(),fake=path.join(root,'fake-codex.mjs'),log=path.join(root,'calls.jsonl');
 const raw=zero();raw.accountId='different-fake-account';
 await writeFile(fake,`import {appendFileSync} from 'node:fs';import {createInterface} from 'node:readline';const log=process.env.FAKE_LOG;appendFileSync(log,JSON.stringify({argv:process.argv.slice(2)})+'\\n');if(process.argv[2]!=='app-server')process.exit(88);createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);appendFileSync(log,JSON.stringify({method:m.method})+'\\n');if(m.id===1)console.log(JSON.stringify({id:1,result:{}}));else if(m.id===2)console.log(JSON.stringify({id:2,result:m.method==='account/read'?{account:{type:'chatgpt',planType:'prolite'}}:${JSON.stringify(raw)}}));});`);
 const env={...process.env,REVLOOP_CODEX_PATH:fake,FAKE_LOG:log};for(const k of ['OPENAI_API_KEY','CODEX_API_KEY','OPENAI_BASE_URL'])delete env[k];const cmd={executable:process.execPath,prefix:[path.resolve('dist/cli.js')]};
 const r=await runProcess(cmd,['billing-check','--provider','codex'],{cwd:root,env});assert.equal(r.code,2,r.stderr);assert.ok(!r.stdout.includes('different-fake-account'));
 const calls=await readFile(log,'utf8');assert.ok(calls.includes('account/rateLimits/read'));assert.ok(!calls.includes('turn/start'));assert.ok(!calls.includes('"exec"'));
 const bad=await runProcess(cmd,['billing-check','--allow-credits'],{cwd:root,env});assert.equal(bad.code,1);assert.equal(await readFile(log,'utf8'),calls);
 const confirm=await runProcess(cmd,['confirm-codex-no-auto-reload'],{cwd:root,env});assert.equal(confirm.code,1);assert.equal(await readFile(log,'utf8'),calls);
});

test('Codex metadata stop marker prevents even the diagnostic CLI launch',async()=>{
 const {codexMetadata}=await import('../dist/codex-rpc.js');const root=await fixture(),stop=path.join(root,'STOP');await writeFile(stop,'stop');await assert.rejects(codexMetadata('account/rateLimits/read',undefined,root,stop),/STOPPED/);
});
