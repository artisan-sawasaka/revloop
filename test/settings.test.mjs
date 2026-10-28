import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { defaults, readSettings, saveSettings, settingsFile, revisionOf, validateSettings, requireModelChoice } from '../dist/settings.js';
import { startSettingsServer } from '../dist/settings-server.js';
import { providerArgs } from '../dist/providers.js';
import { start, review } from '../dist/engine.js';

const home=await mkdtemp(path.join(os.tmpdir(),'revloop-settings-'));
process.env.USERPROFILE=home;process.env.HOME=home;
const catalog=[{model:'gpt-6-astra',label:'Astra',efforts:['low','medium','high']},{model:'gpt-6.1-sol',label:'Sol',efforts:['medium','high']}];
const id='11111111-2222-3333-4444-555555555555';
test('settings default, persist and reject corruption, billing fields and stale saves',async()=>{
  const file=path.join(home,'isolated','settings.json');
  assert.deepEqual(await readSettings(file),defaults());
  const changed=defaults();changed.codex.effort='high';
  await saveSettings(changed,revisionOf(defaults()),file);
  assert.deepEqual(await readSettings(file),changed);
  await assert.rejects(saveSettings(defaults(),revisionOf(defaults()),file),/changed elsewhere/);
  assert.throws(()=>validateSettings({...changed,allowCredits:true}),/Unknown/);
  assert.throws(()=>validateSettings({...changed,claude:{model:'sonnet',effort:'medium'}}),/Opus only/);
  assert.throws(()=>validateSettings({...changed,codex:{model:'gpt-6-astra',effort:'ultra'}}),/Unsupported/);
  assert.throws(()=>validateSettings({...changed,codex:{model:'gpt-5.6-sol',effort:'medium'}}),/Astra or 6.1 Sol/);
  assert.doesNotThrow(()=>validateSettings({...changed,codex:{model:'gpt-6.1-sol',effort:'medium'}}));
  assert.throws(()=>requireModelChoice({model:'absent-model',effort:'medium'},catalog),/No fallback/);
  await writeFile(file,'broken');await assert.rejects(readSettings(file));
});
test('initial and resumed argv explicitly carry settings while preserving read-only controls',()=>{
  for(const reviewer of ['codex','claude'])for(const reviewerSession of [undefined,id]) {
    const reviewerSettings={model:reviewer==='codex'?'gpt-6.1-sol':'opus',effort:'high'};
    const args=providerArgs({reviewer,reviewerSession,reviewerSettings,title:'test'},'schema.json');
    assert.equal(args[args.indexOf('--model')+1],reviewerSettings.model);
    if(reviewer==='codex'){assert.ok(args.includes('model_reasoning_effort="high"'));assert.ok(args.includes('read-only'));assert.ok(args.includes('--ignore-user-config'));}
    else{assert.equal(args[args.indexOf('--effort')+1],'high');assert.ok(args.includes('--restricted'));assert.equal(args[args.indexOf('--tools')+1],'');}
    if(reviewerSession)assert.ok(args.includes(id));
  }
});
test('next review reloads global settings, keeps the session and records each round selection',async()=>{
  await saveSettings(defaults(),revisionOf(await readSettings()));
  const root=path.join(home,'project');await mkdir(root);await writeFile(path.join(root,'sum.ts'),'export const sum=(a,b)=>a-b;');
  const state=await start(root,{source:'claude',context:'sum returns a+b',title:'Settings boundary',files:['sum.ts']});
  const fail={verdict:'FAIL',summary:'fix',findings:[{severity:'P1',file:'sum.ts',line:1,message:'subtraction',fix:'add'}]};
  await review(root,state.id,async s=>{assert.equal(s.reviewerSettings.effort,'medium');return {sessionId:id,review:fail};});
  const changed=defaults();changed.codex.effort='high';await saveSettings(changed,revisionOf(await readSettings()));
  await writeFile(path.join(root,'sum.ts'),'export const sum=(a,b)=>a+b;');
  const result=await review(root,state.id,async s=>{assert.equal(s.reviewerSession,id);assert.equal(s.reviewerSettings.effort,'high');return {sessionId:id,review:{verdict:'PASS',summary:'ok',findings:[]}};});
  assert.deepEqual(result.rounds.map(r=>r.reviewerSettings.effort),['medium','high']);
  const another=await start(root,{source:'codex',context:'sum returns a+b',title:'Corrupt config',files:['sum.ts']});
  await writeFile(settingsFile(),'{');
  const blocked=await review(root,another.id,async()=>{throw Error('must not call');});
  assert.equal(blocked.status,'ERROR');assert.equal(blocked.rounds.length,0);
  await writeFile(settingsFile(),JSON.stringify(defaults()));
});
test('GUI authenticates reads/writes, rejects foreign origin and billing overrides, persists valid settings',async t=>{
  const file=path.join(home,'gui','settings.json');
  const gui=await startSettingsServer(home,{file,models:async()=>catalog});t.after(()=>gui.close());
  const url=new URL(gui.url),base=url.origin,headers={Authorization:'Bearer '+url.hash.slice(1),'Content-Type':'application/json'};
  assert.equal((await fetch(base+'/api/settings')).status,403);
  assert.equal((await fetch(base+'/api/settings',{headers:{...headers,Origin:'https://example.invalid'}})).status,403);
  const page=await fetch(base);assert.equal(page.status,200);assert.ok(page.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  const initial=await (await fetch(base+'/api/settings',{headers})).json();
  assert.deepEqual(initial.settings,defaults());assert.equal(initial.catalogError,false);
  const changed=defaults();changed.claude.effort='high';
  const put=body=>fetch(base+'/api/settings',{method:'PUT',headers,body:JSON.stringify(body)});
  assert.equal((await put({revision:initial.revision,settings:{...changed,allowCredits:true}})).status,400);
  assert.equal((await put({revision:initial.revision,settings:{...changed,codex:{model:'unknown',effort:'medium'}}})).status,400);
  assert.equal((await put({revision:initial.revision,settings:changed})).status,200);
  assert.equal((await put({revision:initial.revision,settings:defaults()})).status,400);
  assert.deepEqual(await readSettings(file),changed);
  assert.equal((await fetch(base+'/api/close',{method:'POST',headers})).status,200);
});
test('GUI catalog failure prevents saving instead of accepting unverified models',async t=>{
  const file=path.join(home,'catalog-failure','settings.json');
  const gui=await startSettingsServer(home,{file,models:async()=>{throw Error('unavailable');}});t.after(()=>gui.close());
  const url=new URL(gui.url),headers={Authorization:'Bearer '+url.hash.slice(1),'Content-Type':'application/json'};
  const initial=await(await fetch(url.origin+'/api/settings',{headers})).json();assert.equal(initial.catalogError,true);
  const result=await fetch(url.origin+'/api/settings',{method:'PUT',headers,body:JSON.stringify({revision:initial.revision,settings:defaults()})});
  assert.equal(result.status,400);await assert.rejects(readFile(file));
});

test('legacy model settings gain loop defaults without losing choices; old GUI writes are refused',async()=>{
  const file=path.join(home,'legacy.json');
  const legacy={version:1,codex:{model:'gpt-6.1-sol',effort:'high'},claude:{model:'opus',effort:'low'}};
  await writeFile(file,JSON.stringify(legacy));
  const migrated=await readSettings(file);
  assert.deepEqual(migrated,{...legacy,version:2,loop:defaults().loop});
  assert.deepEqual(JSON.parse(await readFile(file,'utf8')),legacy);
  await assert.rejects(saveSettings(legacy,revisionOf(migrated),file),/Reopen/);
  await saveSettings(migrated,revisionOf(migrated),file);
  assert.equal(JSON.parse(await readFile(file,'utf8')).version,2);
  await writeFile(file,JSON.stringify({...legacy,allowCredits:true}));
  await assert.rejects(readSettings(file),/Unknown/);
});

test('loop limits reject missing, noninteger and out-of-range values',()=>{
  for(const [key,max] of [['maxRounds',50],['stallLimit',10],['timeoutSeconds',3600]]) {
    for(const value of [0,-1,max+1,1.5,null,'5',NaN,Infinity]) {
      const s=defaults();s.loop[key]=value;assert.throws(()=>validateSettings(s),/Invalid/);
    }
    for(const value of [1,max]) {const s=defaults();s.loop[key]=value;assert.doesNotThrow(()=>validateSettings(s));}
    const s=defaults();delete s.loop[key];assert.throws(()=>validateSettings(s),/Unknown/);
  }
  assert.throws(()=>validateSettings({...defaults(),loop:{...defaults().loop,disableStall:true}}),/Unknown/);
});

test('global limits reach both projects, explicit start options win, active runs keep their limits',async()=>{
  const original=await readSettings();
  try {
    const s=defaults();s.loop={maxRounds:2,stallLimit:2,timeoutSeconds:7};await saveSettings(s,revisionOf(original));
    const roots=[];for(const name of ['limits-project-a','limits-project-b']){const root=path.join(home,name);await mkdir(root);await writeFile(path.join(root,'x.ts'),'version 1');roots.push(root);}
    const options={source:'codex',context:'fixture',title:'limits',files:['x.ts']};
    const a=await start(roots[0],options),b=await start(roots[1],options);
    for(const run of [a,b])assert.deepEqual([run.maxRounds,run.stallLimit,run.timeoutMs],[2,2,7000]);
    const explicit=await start(roots[1],{...options,maxRounds:4,stallLimit:3,timeoutMs:9000});
    assert.deepEqual([explicit.maxRounds,explicit.stallLimit,explicit.timeoutMs],[4,3,9000]);
    const reply=message=>async st=>{assert.equal(st.timeoutMs,7000);return {sessionId:id,review:{verdict:'FAIL',summary:'fix',findings:[{severity:'P1',file:'x.ts',line:1,message,fix:'fix'}]}};};
    await review(roots[0],a.id,reply('first'));await review(roots[1],b.id,reply('same'));
    s.loop={maxRounds:50,stallLimit:10,timeoutSeconds:3600};await saveSettings(s,revisionOf(await readSettings()));
    for(const root of roots)await writeFile(path.join(root,'x.ts'),'version 2');
    assert.equal((await review(roots[0],a.id,reply('second'))).status,'MAX_ROUNDS');
    assert.equal((await review(roots[1],b.id,reply('same'))).status,'STALLED');
    const next=await start(roots[0],options);assert.deepEqual([next.maxRounds,next.stallLimit,next.timeoutMs],[50,10,3600000]);
    assert.equal((await review(roots[0],a.id,()=>{throw Error('must not run');})).status,'MAX_ROUNDS');
  } finally {await saveSettings(original,revisionOf(await readSettings()));}
});

test('GUI saves loop values, reloads them and rejects invalid values without changing disk',async t=>{
  const file=path.join(home,'gui-limits','settings.json');
  const gui=await startSettingsServer(home,{file,models:async()=>catalog});t.after(()=>gui.close());
  const url=new URL(gui.url),headers={Authorization:'Bearer '+url.hash.slice(1),'Content-Type':'application/json'};
  const initial=await(await fetch(url.origin+'/api/settings',{headers})).json();
  const settings=defaults();settings.loop={maxRounds:8,stallLimit:3,timeoutSeconds:600};
  const put=body=>fetch(url.origin+'/api/settings',{method:'PUT',headers,body:JSON.stringify(body)});
  assert.equal((await put({revision:initial.revision,settings})).status,200);
  const loaded=await(await fetch(url.origin+'/api/settings',{headers})).json();assert.deepEqual(loaded.settings.loop,settings.loop);
  for(const loop of [{...settings.loop,maxRounds:0},{...settings.loop,stallLimit:11},{...settings.loop,timeoutSeconds:3601}])assert.equal((await put({revision:loaded.revision,settings:{...settings,loop}})).status,400);
  assert.deepEqual(await readSettings(file),settings);
});
