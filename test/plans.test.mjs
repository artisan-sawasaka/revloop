import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { defaults,readSettings,saveSettings,revisionOf,validateSettings,selectReviewerSettings,settingsFile } from '../dist/settings.js';
import { profilePlan,planAvailability,planModels } from '../dist/plans.js';
import { providerArgs } from '../dist/providers.js';
import { settingsPage } from '../dist/settings-page.js';
import { runInNewContext } from 'node:vm';
import { start } from '../dist/engine.js';

const home=await mkdtemp(path.join(os.tmpdir(),'revloop-plans-'));
process.env.USERPROFILE=home;process.env.HOME=home;
const cli=path.resolve('dist/cli.js');
async function save(s){await saveSettings(s,revisionOf(await readSettings()));}

test('profiles select the authenticated plan, normalize ProLite, keep independent values and reject unsupported plans',()=>{
 const s=defaults();s.planProfiles.codex.plus={model:'gpt-6.1-sol',effort:'low'};s.planProfiles.codex.pro={model:'gpt-6-astra',effort:'max'};
 s.planProfiles.claude.pro={model:'sonnet',effort:'high'};s.planProfiles.claude.max={model:'opus',effort:'max'};
 for(const [provider,plan,model,effort] of [['codex','plus','gpt-6.1-sol','low'],['codex','pro','gpt-6-astra','max'],['codex','prolite','gpt-6-astra','max'],['claude','pro','sonnet','high'],['claude','max','opus','max']])assert.deepEqual(selectReviewerSettings(s,provider,plan),{model,effort});
 assert.deepEqual(selectReviewerSettings(s,'codex','free'),s.planProfiles.codex.free);
 assert.throws(()=>selectReviewerSettings(s,'claude','free'),/CLI/);
 for(const [provider,plans] of [['codex',['max','enterprise',null]],['claude',['plus','api',null]]])for(const plan of plans)assert.throws(()=>selectReviewerSettings(s,provider,plan),/No profile fallback/);
 assert.equal(profilePlan('codex','prolite'),'pro');
 for(const provider of ['codex','claude'])assert.equal(planAvailability[provider].length,3);
});

test('profile validation cannot override billing or add unsupported plans and credit-only models',()=>{
 for(const mutate of [s=>s.planProfiles.codex.free={model:'gpt-6-astra',effort:'low'},s=>s.planProfiles.claude.plus=null,s=>delete s.planProfiles.codex.plus,s=>s.planProfiles.claude.pro={model:'fable',effort:'high'},s=>s.planProfiles.claude.pro={model:'sonnet',effort:'ultra'},s=>s.planProfiles.codex.pro={model:'gpt-6-astra',effort:'high',allowCredits:true}]){const s=defaults();mutate(s);assert.throws(()=>validateSettings(s));}
 const s=defaults();s.planProfiles.claude.max={model:'fable',effort:'low'};assert.doesNotThrow(()=>validateSettings(s));
 for(const p of ['codex','claude']){const n=defaults();n.planProfiles[p].pro=null;assert.throws(()=>validateSettings(n));}
});

test('v4 migration preserves models, loop and log preferences and copies common choices into independent profiles without rewriting the file',async()=>{
 const v4={version:4,codex:{model:'gpt-6.1-sol',effort:'high'},claude:{model:'opus',effort:'low'},loop:defaults().loop,logging:{enabled:false,chatEnabled:false}};
 const file=path.join(home,'legacy-v4.json');await writeFile(file,JSON.stringify(v4));
 const migrated=await readSettings(file);assert.equal(migrated.version,7);assert.deepEqual(migrated.loop,v4.loop);assert.deepEqual(migrated.logging,v4.logging);for(const plan of ['plus','pro'])assert.deepEqual(migrated.planProfiles.codex[plan],v4.codex);for(const plan of ['pro','max'])assert.deepEqual(migrated.planProfiles.claude[plan],v4.claude);
 assert.deepEqual(JSON.parse(await readFile(file,'utf8')),v4);
 await assert.rejects(saveSettings(v4,revisionOf(migrated),file),/Reopen/);
});

async function fixture(){
 const root=await mkdtemp(path.join(home,'project-')),fake=path.join(root,'fake-claude.mjs'),log=path.join(root,'inference.jsonl'),authCount=path.join(root,'auth-count');
 await writeFile(path.join(root,'x.ts'),'v1');
 await writeFile(fake,`import fs from 'node:fs';const a=process.argv.slice(2);if(a[0]==='auth'){let n=0;try{n=Number(fs.readFileSync(process.env.FAKE_AUTH_COUNT,'utf8'));}catch{}fs.writeFileSync(process.env.FAKE_AUTH_COUNT,String(++n));console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:process.env.FAKE_CHANGE_PLAN&&n>=3?'max':process.env.FAKE_PLAN,email:'fixture@example.invalid',orgId:'fixture'}));}else if(a[0]==='--version')console.log('fixture');else if(a[0]==='--help'){if(process.env.FAKE_CHANGE_SETTINGS){const f=process.env.FAKE_CHANGE_SETTINGS,s=JSON.parse(fs.readFileSync(f,'utf8'));s.planProfiles.claude.pro.effort='high';fs.writeFileSync(f,JSON.stringify(s));}console.log('--safe-mode --restricted --strict-mcp-config --tools --json-schema --name');}else if(a.includes('-p')){fs.appendFileSync(process.env.FAKE_LOG,JSON.stringify(a)+'\\n');console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,session_id:'11111111-2222-3333-4444-555555555555',structured_output:{verdict:'PASS',summary:'fixture only',findings:[],notes:[]}}));}else process.exitCode=98;`);
 const s=await start(root,{source:'codex',title:'plan fixture',context:'fixture',files:['x.ts']});
 return {root,id:s.id,fake,log,authCount};
}
function run(f,env){const r=spawnSync(process.execPath,[cli,'review','--root',f.root,'--run',f.id],{env:{...process.env,REVLOOP_CLAUDE_PATH:f.fake,FAKE_LOG:f.log,FAKE_AUTH_COUNT:f.authCount,...env},encoding:'utf8',windowsHide:true});assert.ok(r.stdout,r.stderr);return {exit:r.status,...JSON.parse(r.stdout)};}

test('real CLI adapter uses Pro and Max profiles rather than shared defaults and records selected plan/model',async()=>{
 const s=defaults();s.planProfiles.claude.pro={model:'sonnet',effort:'low'};s.planProfiles.claude.max={model:'fable',effort:'high'};await save(s);
 for(const plan of ['pro','max']){
   const f=await fixture(),result=run(f,{FAKE_PLAN:plan});assert.equal(result.status,'PASS',JSON.stringify(result));
   assert.equal(result.reviewerPlan,plan);assert.deepEqual(result.rounds[0].reviewerSettings,s.planProfiles.claude[plan]);
   assert.equal(result.billing.model,s.planProfiles.claude[plan].model);
   const args=JSON.parse((await readFile(f.log,'utf8')).trim());assert.equal(args[args.indexOf('--model')+1],s.planProfiles.claude[plan].model);assert.equal(args[args.indexOf('--effort')+1],s.planProfiles.claude[plan].effort);
 }
});

test('a plan change before inference blocks instead of using the wrong profile',async()=>{
 await save(defaults());const f=await fixture(),result=run(f,{FAKE_PLAN:'pro',FAKE_CHANGE_PLAN:'1'});
 assert.equal(result.status,'BLOCKED');assert.ok(result.billing.reasons.includes('PLAN_CHANGED_BEFORE_INFERENCE'));
 await assert.rejects(readFile(f.log),{code:'ENOENT'});
});

test('profile settings stay frozen for an active round and newly saved settings apply at the next boundary',async()=>{
 const s=defaults();s.planProfiles.claude.pro={model:'sonnet',effort:'low'};await save(s);
 const f=await fixture(),result=run(f,{FAKE_PLAN:'pro',FAKE_CHANGE_SETTINGS:settingsFile()});assert.equal(result.status,'PASS',JSON.stringify(result));
 assert.equal(result.rounds[0].reviewerSettings.effort,'low');assert.equal((await readSettings()).planProfiles.claude.pro.effort,'high');
 const next=await fixture(),second=run(next,{FAKE_PLAN:'pro'});assert.equal(second.rounds[0].reviewerSettings.effort,'high');
});

test('menus contain only provider plans and allowed models, with Max priority Opus Fable Sonnet',async()=>{
 const elements=new Map(),el=id=>{if(!elements.has(id))elements.set(id,{value:'',checked:false,disabled:true,children:[],handlers:{},replaceChildren(){this.children=[];},append(o){this.children.push(o);},addEventListener(e,f){this.handlers[e]=f;}});return elements.get(id);};
 const models=Object.values(planModels.codex).flat().filter((m,i,a)=>a.indexOf(m)===i).map(model=>({model,efforts:model==='gpt-6-luna'?['medium']:['low','medium','high'],fast:true}));
 runInNewContext(settingsPage.match(/<script>([\s\S]*)<\/script>/)[1],{document:{getElementById:el,createElement:()=>({})},location:{hash:'#fixture',pathname:'/'},sessionStorage:{getItem(){},setItem(){}},history:{replaceState(){}},fetch:async()=>({ok:true,json:async()=>({settings:defaults(),revision:'fixture',models})})});
 await new Promise(r=>setImmediate(r));
 assert.doesNotMatch(settingsPage,/-inherit|共通設定を使う|共通設定（既定値）/);
 for(const [provider,plans] of Object.entries({codex:['free','plus','pro'],claude:['free','pro','max']})){
   assert.deepEqual(el(provider+'-plan').children.map(o=>o.value),plans);
   for(const plan of plans){el(provider+'-plan').value=plan;el(provider+'-plan').handlers.change();assert.deepEqual(el(provider+'-model').children.map(o=>o.value),planModels[provider][plan]);}
 }
 assert.deepEqual(el('claude-model').children.map(o=>o.textContent),['Opus 5.5','Fable 5.1','Sonnet 5.5']);
 el('codex-plan').value='free';el('codex-plan').handlers.change();assert.deepEqual(el('codex-effort').children.map(o=>o.value),['medium']);assert.equal(el('codex-fast').disabled,true);
});

test('Fable requires authenticated Max and Free cannot enable Fast',()=>{
 for(const reviewerPlan of [undefined,'free','pro'])assert.throws(()=>providerArgs({reviewer:'claude',reviewerPlan,reviewerSettings:{model:'fable',effort:'medium'}},'schema'),/Max/);
 assert.ok(providerArgs({reviewer:'claude',reviewerPlan:'max',reviewerSettings:{model:'fable',effort:'medium'}},'schema').includes('fable'));
 const s=defaults();s.planProfiles.codex.free.fast=true;assert.throws(()=>validateSettings(s),/Standard/);
});

test('v6 migration preserves independent overrides and copies only inheriting profiles without writing disk',async()=>{
 const old={version:6,codex:{model:'gpt-6.1-sol',effort:'low',fast:false},claude:{model:'sonnet',effort:'high',fast:false},planProfiles:{codex:{plus:null,pro:{model:'gpt-6-astra',effort:'max',fast:true}},claude:{pro:null,max:{model:'opus',effort:'max',fast:false}}},loop:{maxRounds:10,stallLimit:5,timeoutSeconds:300},logging:{enabled:false,chatEnabled:true}};
 const file=path.join(home,'v6.json');await writeFile(file,JSON.stringify(old));const next=await readSettings(file);
 assert.deepEqual(next.planProfiles.codex.plus,old.codex);assert.deepEqual(next.planProfiles.codex.pro,old.planProfiles.codex.pro);assert.deepEqual(next.planProfiles.claude.pro,old.claude);assert.deepEqual(next.planProfiles.claude.max,old.planProfiles.claude.max);assert.deepEqual(next.loop,old.loop);assert.deepEqual(next.logging,old.logging);assert.deepEqual(next.planProfiles.codex.free,defaults().planProfiles.codex.free);assert.equal('codex' in next,false);assert.deepEqual(JSON.parse(await readFile(file,'utf8')),old);
 next.planProfiles.codex.plus.effort='high';assert.equal(next.planProfiles.codex.pro.effort,'max');
});
