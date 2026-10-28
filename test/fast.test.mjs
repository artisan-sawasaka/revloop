import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {runInNewContext} from 'node:vm';
import {defaults,readSettings,saveSettings,revisionOf,validateSettings,requireModelChoice,codexModels} from '../dist/settings.js';
import {modelAllowedForPlan} from '../dist/plans.js';
import {providerArgs} from '../dist/providers.js';
import {start} from '../dist/engine.js';
import {startSettingsServer} from '../dist/settings-server.js';
import {settingsPage} from '../dist/settings-page.js';
import {confirmationFile,codexFingerprint,CONFIRMATION_TTL_MS} from '../dist/billing-confirmation.js';

const home=await mkdtemp(path.join(os.tmpdir(),'revloop-fast-'));
process.env.HOME=home;process.env.USERPROFILE=home;
const catalog=[{model:'gpt-6-astra',label:'Astra',efforts:['medium'],fast:true},{model:'gpt-6.1-sol',label:'Sol',efforts:['medium'],fast:false}];

test('Fast persists independently per plan, old v5 defaults to OFF and stale clients cannot overwrite it',async()=>{
 const old={version:5,codex:defaults().planProfiles.codex.pro,claude:defaults().planProfiles.claude.pro,loop:defaults().loop,logging:defaults().logging,planProfiles:{codex:{plus:null,pro:null},claude:{pro:null,max:null}}};old.planProfiles.codex.plus={model:'gpt-6-astra',effort:'medium'};
 const file=path.join(home,'v5.json');await writeFile(file,JSON.stringify(old));
 const next=await readSettings(file);assert.equal(next.version,7);assert.equal(Boolean(next.planProfiles.codex.plus.fast),false);
 assert.deepEqual(JSON.parse(await readFile(file,'utf8')),old);
 await assert.rejects(saveSettings(old,revisionOf(next),file),/Reopen/);
 next.planProfiles.codex.plus.fast=true;next.planProfiles.codex.pro={model:'gpt-6.1-sol',effort:'medium',fast:false};
 await saveSettings(next,revisionOf(await readSettings(file)),file);assert.deepEqual(await readSettings(file),next);
 for(const fast of [null,1,'true']){const s=structuredClone(next);s.planProfiles.codex.pro.fast=fast;assert.throws(()=>validateSettings(s),/boolean/);}
 for(const plan of ['pro','max']){const s=defaults();s.planProfiles.claude[plan]={model:'opus',effort:'medium',fast:true};assert.throws(()=>validateSettings(s),/paid usage credits/);}
 assert.throws(()=>providerArgs({reviewer:'claude',reviewerSettings:{model:'opus',effort:'medium',fast:true}},'schema'),/billing guard/);
});

test('plan policy, live model/effort restrictions and live Fast availability all fail closed',()=>{
 assert.equal(modelAllowedForPlan('codex','free','gpt-6-luna'),true);
 assert.equal(modelAllowedForPlan('claude','plus','opus'),false);
 assert.equal(modelAllowedForPlan('claude','pro','fable'),false);
 for(const setting of [{model:'gpt-6-luna',effort:'medium'},{model:'gpt-6-astra',effort:'max'},{model:'gpt-6.1-sol',effort:'medium',fast:true}])assert.throws(()=>requireModelChoice(setting,catalog),/unavailable/);
 assert.doesNotThrow(()=>requireModelChoice({model:'gpt-6-astra',effort:'medium',fast:true},catalog));
 for(const fast of [false,true])for(const reviewerSession of [undefined,'11111111-2222-3333-4444-555555555555']){
  const args=providerArgs({reviewer:'codex',reviewerSession,reviewerSettings:{model:'gpt-6-astra',effort:'medium',fast}},'schema');
  assert.ok(args.includes(`service_tier="${fast?'fast':'default'}"`));assert.ok(args.includes(`features.fast_mode=${fast}`));assert.ok(args.includes('--ignore-user-config'));assert.ok(args.includes('read-only'));
 }
});

test('settings API rejects unavailable models, effort and Fast in every Codex plan override',async t=>{
 const gui=await startSettingsServer(home,{file:path.join(home,'api.json'),models:async()=>catalog});t.after(()=>gui.close());
 const url=new URL(gui.url),headers={Authorization:'Bearer '+url.hash.slice(1),'Content-Type':'application/json'};
 let data=await(await fetch(url.origin+'/api/settings',{headers})).json();
 const put=settings=>fetch(url.origin+'/api/settings',{method:'PUT',headers,body:JSON.stringify({settings,revision:data.revision})});
 for(const plan of ['plus','pro'])for(const profile of [{model:'gpt-6-luna',effort:'medium'},{model:'gpt-6-astra',effort:'max'},{model:'gpt-6.1-sol',effort:'medium',fast:true}]){
  const s=defaults();s.planProfiles.codex[plan]=profile;assert.equal((await put(s)).status,400);
 }
 const s=defaults();s.planProfiles.codex.plus={model:'gpt-6-astra',effort:'medium',fast:true};assert.equal((await put(s)).status,200);
 data=await(await fetch(url.origin+'/api/settings',{headers})).json();assert.equal(data.settings.planProfiles.codex.plus.fast,true);
});

test('GUI disables unavailable models per plan, preserves Fast per plan and locks Claude Fast with its billing reason',async()=>{
 const elements=new Map(),el=id=>{if(!elements.has(id))elements.set(id,{value:'',checked:false,disabled:true,children:[],handlers:{},replaceChildren(){this.children=[];},append(o){this.children.push(o);},addEventListener(e,f){this.handlers[e]=f;},get valueAsNumber(){return Number(this.value);}});return elements.get(id);};
 let settings=defaults(),submitted;
 runInNewContext(settingsPage.match(/<script>([\s\S]*)<\/script>/)[1],{document:{getElementById:el,createElement:()=>({})},location:{hash:'#token',pathname:'/'},sessionStorage:{getItem(){},setItem(){}},history:{replaceState(){}},fetch:async(route,options)=>{if(options.method==='PUT'){submitted=JSON.parse(options.body).settings;settings=submitted;}return {ok:true,json:async()=>({settings,revision:'fixture',models:catalog})};}});
 await new Promise(r=>setImmediate(r));
 const choose=(p,plan)=>{el(p+'-plan').value=plan;el(p+'-plan').handlers.change();};
 for(const plan of ['plus','pro']){choose('codex',plan);assert.equal(el('codex-model').children.some(o=>o.value==='gpt-6-luna'),false);}
 choose('codex','plus');el('codex-model').value='gpt-6-astra';el('codex-model').handlers.change();
 assert.equal(el('codex-fast').disabled,false);el('codex-fast').checked=true;el('codex-fast').handlers.change();
 choose('codex','pro');assert.equal(el('codex-fast').checked,false);choose('codex','plus');assert.equal(el('codex-fast').checked,true);
 await el('form').handlers.submit({preventDefault(){}});assert.equal(submitted.planProfiles.codex.plus.fast,true);
 el('codex-model').value='gpt-6.1-sol';el('codex-model').handlers.change();assert.equal(el('codex-fast').checked,false);assert.equal(el('codex-fast').disabled,true);
 // A previously saved Fast preference must remain switchable to OFF if availability disappears.
 settings.planProfiles.codex.plus={model:'gpt-6.1-sol',effort:'medium',fast:true};
 el('reload').handlers.click();await new Promise(r=>setImmediate(r));
 assert.equal(el('codex-fast').checked,true);assert.equal(el('codex-fast').disabled,false);
 el('codex-fast').checked=false;el('codex-fast').handlers.change();assert.equal(el('codex-fast').disabled,true);
 for(const plan of ['pro','max']){choose('claude',plan);assert.equal(el('claude-fast').disabled,true);assert.match(el('claude-fast-note').textContent,/追加クレジット/);}
 choose('codex','free');assert.equal(el('codex-model').disabled,false);assert.equal(el('codex-fast').disabled,true);assert.ok(el('codex-model').children.every(o=>o.disabled));
});

test('real Codex adapter checks live catalog before sending Fast and records explicit OFF on resumed calls',async()=>{
 const root=await mkdtemp(path.join(home,'runtime-')),fake=path.join(root,'fake.mjs'),log=path.join(root,'inference.jsonl');
 await writeFile(path.join(root,'x.ts'),'v1');
 await writeFile(fake,`import fs from 'node:fs';import {createInterface} from 'node:readline';const a=process.argv.slice(2),fast=process.env.FAKE_FAST==='1',plan=process.env.FAKE_PLAN||'plus';
 if(a[0]==='app-server')createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===1)console.log(JSON.stringify({id:1,result:{}}));else if(m.id===2){const now=Date.now();const result=m.method==='account/read'?{account:{type:'chatgpt',planType:plan}}:m.method==='model/list'?{data:[{model:plan==='free'?'gpt-6-luna':'gpt-6-astra',displayName:'fixture',supportedReasoningEfforts:[{reasoningEffort:'medium'}],additionalSpeedTiers:fast?['fast']:[]}],nextCursor:null}:{accountId:'fixture',rateLimitsByLimitId:{codex:{planType:plan,primary:{usedPercent:1,resetsAt:Math.floor(now/1000)+3600},secondary:null,credits:{hasCredits:false,unlimited:false,balance:'0'},spendControlReached:false,rateLimitReachedType:null}}};console.log(JSON.stringify({id:2,result}));}});
 else if(a.includes('--version'))console.log('fixture');else if(a.includes('--help'))console.log('--ignore-user-config --ignore-rules --output-schema --sandbox --json');else if(a[0]==='features')console.log('shell_tool stable false\\nunified_exec stable false\\nmulti_agent stable false\\nmulti_agent_v2 stable false\\nfast_mode stable true');else if(a[0]==='login')console.log('Logged in using ChatGPT');else if(a.includes('exec')){fs.appendFileSync(process.env.FAKE_LOG,JSON.stringify(a)+'\\n');for(const event of [{type:'thread.started',thread_id:'11111111-2222-3333-4444-555555555555'},{type:'item.completed',item:{type:'agent_message',text:JSON.stringify({verdict:process.env.FAKE_FAIL?'FAIL':'PASS',summary:'fixture',findings:process.env.FAKE_FAIL?[{severity:'P1',file:'x.ts',line:1,message:'fix',fix:'fix'}]:[]})}},{type:'turn.completed'}])console.log(JSON.stringify(event));}else process.exitCode=97;`);
 const now=Date.now();await mkdir(path.dirname(confirmationFile()),{recursive:true});await writeFile(confirmationFile(),JSON.stringify({version:1,provider:'codex',source:'user-confirmed',autoReloadOff:true,accountFingerprint:codexFingerprint('fixture'),confirmedAt:new Date(now-100).toISOString(),expiresAt:new Date(now-100+CONFIRMATION_TTL_MS).toISOString()}));
 const settings=defaults();settings.planProfiles.codex.plus={model:'gpt-6-astra',effort:'medium',fast:true};await saveSettings(settings,revisionOf(await readSettings()));
 const run=await start(root,{source:'claude',title:'Fast fixture',context:'fixture',files:['x.ts']});
 const invoke=env=>{const r=spawnSync(process.execPath,[path.resolve('dist/cli.js'),'review','--root',root,'--run',run.id],{encoding:'utf8',windowsHide:true,env:{...process.env,REVLOOP_CODEX_PATH:fake,FAKE_LOG:log,...env}});return JSON.parse(r.stdout);};
 const first=invoke({FAKE_FAST:'1',FAKE_FAIL:'1'});assert.equal(first.status,'NEEDS_FIX',JSON.stringify(first));assert.equal(first.rounds[0].reviewerSettings.fast,true);assert.equal(first.rounds[0].quotaUsage.before[0].usedPercent,1);assert.equal(first.rounds[0].quotaUsage.after[0].usedPercent,1);
 settings.planProfiles.codex.plus.fast=false;await saveSettings(settings,revisionOf(await readSettings()));await writeFile(path.join(root,'x.ts'),'v2');
 const second=invoke({FAKE_FAST:'1'});assert.equal(second.status,'PASS',JSON.stringify(second));
 const args=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);assert.ok(args[0].includes('service_tier="fast"'));assert.ok(args[1].includes('service_tier="default"'));assert.ok(args[1].includes('resume'));
 settings.planProfiles.codex.plus.fast=true;await saveSettings(settings,revisionOf(await readSettings()));
 const blocked=await start(root,{source:'claude',title:'unavailable Fast',context:'fixture',files:['x.ts']});
 const r=spawnSync(process.execPath,[path.resolve('dist/cli.js'),'review','--root',root,'--run',blocked.id],{encoding:'utf8',windowsHide:true,env:{...process.env,REVLOOP_CODEX_PATH:fake,FAKE_LOG:log,FAKE_FAST:'0'}});
 assert.equal(JSON.parse(r.stdout).status,'ERROR');assert.equal((await readFile(log,'utf8')).trim().split('\n').length,2);
 const free=await start(root,{source:'claude',title:'Free fixture',context:'fixture',files:['x.ts']});
 const freeResult=spawnSync(process.execPath,[path.resolve('dist/cli.js'),'review','--root',root,'--run',free.id],{encoding:'utf8',windowsHide:true,env:{...process.env,REVLOOP_CODEX_PATH:fake,FAKE_LOG:log,FAKE_PLAN:'free',FAKE_FAST:'0'}});
 const freeState=JSON.parse(freeResult.stdout);assert.equal(freeState.status,'PASS',JSON.stringify(freeState));assert.equal(freeState.reviewerPlan,'free');assert.equal(freeState.reviewerSettings.model,'gpt-6-luna');assert.equal(freeState.reviewerSettings.fast,false);assert.equal(freeState.billing.observations.paidUsageDisabled,true);
 process.env.REVLOOP_CODEX_PATH=fake;process.env.FAKE_FAST='1';assert.equal((await codexModels(root))[0].fast,true);process.env.FAKE_FAST='0';assert.equal((await codexModels(root))[0].fast,false);
});

test('absent unchanged models do not block other preferences, but changed models and unverified Fast do',async t=>{
 const file=path.join(home,'partial-catalog.json');
 const gui=await startSettingsServer(home,{file,models:async()=>[{model:'gpt-6-luna',label:'Luna',efforts:['medium'],fast:false}]});t.after(()=>gui.close());
 const url=new URL(gui.url),headers={Authorization:'Bearer '+url.hash.slice(1),'Content-Type':'application/json'};
 let data=await(await fetch(url.origin+'/api/settings',{headers})).json();
 const put=settings=>fetch(url.origin+'/api/settings',{method:'PUT',headers,body:JSON.stringify({revision:data.revision,settings})});
 const s=defaults();s.logging.enabled=false;s.planProfiles.claude.max={model:'fable',effort:'high',fast:false};assert.equal((await put(s)).status,200);
 data=await(await fetch(url.origin+'/api/settings',{headers})).json();
 const changed=structuredClone(s);changed.planProfiles.codex.pro.effort='high';assert.equal((await put(changed)).status,400);
 const fast=structuredClone(s);fast.planProfiles.codex.pro.fast=true;assert.equal((await put(fast)).status,400);
 assert.deepEqual(await readSettings(file),s);
});
