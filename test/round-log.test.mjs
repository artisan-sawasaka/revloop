import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { start, review } from '../dist/engine.js';
import { defaults, readSettings, revisionOf, saveSettings } from '../dist/settings.js';
import { atomicJson } from '../dist/storage.js';

const home=await mkdtemp(path.join(os.tmpdir(),'revloop-round-log-'));
process.env.USERPROFILE=home;process.env.HOME=home;
const sessionId='11111111-2222-3333-4444-555555555555';
const finding={severity:'P2',file:'x.ts',line:1,message:'Incorrect sum\nwith detail',fix:'Use addition'};
const fail={verdict:'FAIL',summary:'Fix sum',findings:[finding]};
const pass={verdict:'PASS',summary:'OK',findings:[]};
const reply=review=>async()=>({sessionId,review});
async function fixture(){
  await saveSettings(defaults(),revisionOf(await readSettings()));
  const root=await mkdtemp(path.join(home,'project-'));
  await writeFile(path.join(root,'x.ts'),'source v1');
  const state=await start(root,{source:'codex',title:'logs',context:'Private context omitted from compact logs',files:['x.ts'],stallLimit:10});
  const dir=path.join(root,'.revloop','runs',state.id),file=path.join(dir,'rounds.jsonl');
  return {root,id:state.id,dir,file};
}
const entries=async file=>(await readFile(file,'utf8')).trim().split('\n').map(JSON.parse);
async function logging(enabled){const s=await readSettings();s.logging.enabled=enabled;await saveSettings(s,revisionOf(await readSettings()));}

test('compact log records FAIL then PASS, counters and required findings only, without duplicate terminal reads',async()=>{
  const f=await fixture();
  await review(f.root,f.id,reply({...fail,verdict:'PASS'}));
  await writeFile(path.join(f.root,'x.ts'),'source v2');
  const result=await review(f.root,f.id,reply(pass));
  assert.equal(result.roundLogFile,f.file);
  await review(f.root,f.id,()=>{throw Error('must not run');});
  const rows=await entries(f.file);
  assert.equal(rows.length,2);
  assert.deepEqual(rows.map(r=>[r.reviewCount,r.totalReviewCount,r.findingCount,r.status]),[[1,1,1,'NEEDS_FIX'],[2,2,0,'PASS']]);
  assert.equal(rows[0].reportedVerdict,'PASS');assert.equal(rows[0].effectiveVerdict,'FAIL');
  assert.deepEqual(rows[0].findings,[{severity:finding.severity,file:finding.file,line:finding.line,message:finding.message}]);
  const text=await readFile(f.file,'utf8');assert.ok(!text.includes('Private context'));assert.ok(!text.includes('source v1'));assert.ok(!text.includes('Use addition'));
});

test('logging toggles at review boundaries without backfilling or deleting earlier entries',async()=>{
  const f=await fixture();await logging(false);
  await review(f.root,f.id,reply(fail));
  await assert.rejects(readFile(f.file),{code:'ENOENT'});
  assert.equal(JSON.parse(await readFile(path.join(f.dir,'round-1','review.json'),'utf8')).findings.length,1);
  await logging(true);await writeFile(path.join(f.root,'x.ts'),'source v2');
  await review(f.root,f.id,async()=>{await logging(false);return {sessionId,review:fail};});
  await writeFile(path.join(f.root,'x.ts'),'source v3');await review(f.root,f.id,reply(fail));
  const rows=await entries(f.file);assert.equal(rows.length,1);assert.equal(rows[0].totalReviewCount,2);
  await logging(true);await writeFile(path.join(f.root,'x.ts'),'source v4');await review(f.root,f.id,reply(pass));
  assert.deepEqual((await entries(f.file)).map(r=>r.totalReviewCount),[2,4]);
});

test('reviewer error and rejected source drift record actual state and failure reason',async()=>{
  const f=await fixture();
  await review(f.root,f.id,async()=>{throw Error('reviewer timeout');});
  const [error]=await entries(f.file);assert.equal(error.status,'ERROR');assert.equal(error.reason,'reviewer timeout');assert.equal(error.reportedVerdict,null);
  const g=await fixture();
  await review(g.root,g.id,async()=>{await writeFile(path.join(g.root,'x.ts'),'drift');return {sessionId,review:pass};});
  const [drift]=await entries(g.file);assert.equal(drift.status,'ERROR');assert.match(drift.reason,/Source changed/);
});

test('simple log write failure does not replace a valid review result',async()=>{
  const f=await fixture();await mkdir(f.file);
  const result=await review(f.root,f.id,reply(pass));
  assert.equal(result.status,'PASS');assert.match(result.roundLogError,/簡易ログを保存できませんでした/);
  assert.equal(JSON.parse(await readFile(path.join(f.dir,'state.json'),'utf8')).status,'PASS');
});

test('compact counters preserve cumulative round numbers across a cycle',async()=>{
  const f=await fixture();await review(f.root,f.id,reply(fail));
  const file=path.join(f.dir,'state.json'),s=JSON.parse(await readFile(file,'utf8'));
  s.cycle={number:2,startRound:1,startedAt:new Date().toISOString(),archiveDirectory:'fixture'};
  await atomicJson(file,s);await writeFile(path.join(f.root,'x.ts'),'source v2');
  await review(f.root,f.id,reply(pass));
  const rows=await entries(f.file);assert.deepEqual(rows.map(r=>[r.cycle,r.reviewCount,r.totalReviewCount]),[[1,1,1],[2,1,2]]);
});
