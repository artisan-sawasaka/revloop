import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {codexQuotaWindows,claudeQuotaWindows,formatQuotaUsage} from '../dist/quota-usage.js';
import {decodeResult,providerArgs} from '../dist/providers.js';
import {start,review} from '../dist/engine.js';
import {formatChatLog} from '../dist/chat-log.js';

const sessionId='11111111-2222-3333-4444-555555555555';
const pass={verdict:'PASS',summary:'fixture',findings:[]};
test('Codex windows preserve bucket identity, separate quotas, and percentage point changes',()=>{
 const raw=n=>({rateLimitsByLimitId:{codex:{primary:{usedPercent:n,windowDurationMins:300,resetsAt:2000000000},secondary:{usedPercent:40,windowDurationMins:10080,resetsAt:2000100000}}}});
 const before=codexQuotaWindows(raw(20)),after=codexQuotaWindows(raw(23));
 assert.deepEqual(before.map(w=>w.label),['codex / 5時間枠','codex / 週間枠']);
 const lines=formatQuotaUsage({approximate:true,before,after});assert.match(lines[0],/使用 23% \/ 残り 77% \/ 増加 \+3ポイント/);assert.match(lines[1],/増加 \+0ポイント/);
 assert.deepEqual(codexQuotaWindows({rateLimits:{limitId:'codex',primary:{usedPercent:0}}})[0],{key:'codex.primary',label:'codex / 主枠',usedPercent:0,resetsAt:null});
});
test('missing, reset and decreased usage are not fabricated as zero consumption',()=>{
 const w={key:'five_hour',label:'5時間枠',usedPercent:25,resetsAt:2000000000};
 for(const before of [[],[{...w,resetsAt:1999999999}],[{...w,usedPercent:30}],[{...w,resetsAt:null}]])assert.match(formatQuotaUsage({approximate:true,before,after:[w]})[0],/増加 不明/);
 assert.deepEqual(formatQuotaUsage(),['利用枠: 不明']);
 for(const usedPercent of [null,'20',-1,101])assert.deepEqual(codexQuotaWindows({rateLimits:{limitId:'codex',primary:{usedPercent}}}),[]);
});
test('Claude rate-limit observations are passive, optional and fractional, not inferred from status or tokens',()=>{
 const event=rate_limit_info=>JSON.stringify({type:'rate_limit_event',rate_limit_info});
 const output=[event({status:'allowed'}),event({unifiedWindows:{five_hour:{utilization:.24,resetsAt:2000000000},seven_day:{utilization:.41,resetsAt:2000100000}}}),event({rateLimitType:'five_hour',utilization:.27,resetsAt:2000000000})].join('\n');
 const windows=claudeQuotaWindows(output);assert.deepEqual(windows.map(w=>w.usedPercent),[27,41]);
 assert.deepEqual(claudeQuotaWindows(event({status:'allowed',rateLimitType:'five_hour'})),[]);
 assert.deepEqual(claudeQuotaWindows(event({rateLimitType:'five_hour',utilization:27})),[]);
 const args=providerArgs({reviewer:'claude',reviewerSettings:{model:'opus',effort:'medium'}},'schema');assert.equal(args[args.indexOf('--output-format')+1],'stream-json');assert.ok(args.includes('--verbose'));
 const result=decodeResult('claude',{code:0,stderr:'',stdout:output+'\n'+JSON.stringify({type:'result',subtype:'success',is_error:false,session_id:sessionId,structured_output:pass})});assert.deepEqual(result.review,pass);
});
test('Claude real adapter stores passive remaining percentages and compares resumed rounds without /usage',async t=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'revloop-quota-'));process.env.HOME=home;process.env.USERPROFILE=home;
 const fake=path.join(home,'fake.mjs'),root=path.join(home,'project');await (await import('node:fs/promises')).mkdir(root);await writeFile(path.join(root,'x.ts'),'v1');
 await writeFile(fake,`const a=process.argv.slice(2);if(a[0]==='auth')console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'max',email:'test@example.invalid',orgId:'fixture'}));else if(a[0]==='--version')console.log('fixture');else if(a[0]==='--help')console.log('--safe-mode --restricted --strict-mcp-config --tools --json-schema --name');else if(a.includes('-p')){const resumed=a.includes('--resume');console.log(JSON.stringify({type:'rate_limit_event',rate_limit_info:{unifiedWindows:{five_hour:{utilization:resumed?.27:.24,resetsAt:2000000000}}}}));console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,session_id:'${sessionId}',structured_output:resumed?${JSON.stringify(pass)}:{verdict:'FAIL',summary:'fixture',findings:[{severity:'P1',file:'x.ts',line:1,message:'fixture',fix:'fix'}]}}));}else process.exitCode=98;`);
 const old=process.env.REVLOOP_CLAUDE_PATH;process.env.REVLOOP_CLAUDE_PATH=fake;t.after(()=>{if(old===undefined)delete process.env.REVLOOP_CLAUDE_PATH;else process.env.REVLOOP_CLAUDE_PATH=old;});
 const run=await start(root,{source:'codex',title:'quota',context:'fixture',files:['x.ts']});
 const first=await review(root,run.id);assert.equal(first.status,'NEEDS_FIX');assert.equal(first.rounds[0].quotaUsage.after[0].usedPercent,24);assert.match(formatChatLog(first),/残り 76% \/ 増加 不明/);
 await writeFile(path.join(root,'x.ts'),'v2');const second=await review(root,run.id);assert.equal(second.status,'PASS');assert.match(formatChatLog(second),/残り 73% \/ 増加 \+3ポイント/);
 const entries=(await readFile(path.join(root,'.revloop','runs',run.id,'rounds.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(entries[1].quotaUsage.before[0].usedPercent,24);assert.equal(entries[1].quotaUsage.after[0].usedPercent,27);
 assert.equal(second.billing.observations.paidUsageDisabled,null);assert.deepEqual(second.billing.observations.quotaUsedPercent,[]);
});
