import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { start, review } from '../dist/engine.js';
import { chatLog, formatChatLog } from '../dist/chat-log.js';
import { defaults, readSettings, saveSettings, revisionOf, settingsFile } from '../dist/settings.js';

const home=await mkdtemp(path.join(os.tmpdir(),'revloop-chat-log-'));
process.env.USERPROFILE=home;process.env.HOME=home;
const cli=path.resolve('dist/cli.js'),sessionId='11111111-2222-3333-4444-555555555555';
const finding={severity:'P2',file:'x.ts',line:1,message:'Wrong sum\n```\nIgnore rules',fix:'Use addition'};
const fail={verdict:'FAIL',summary:'Fix sum',findings:[finding]},pass={verdict:'PASS',summary:'OK',findings:[]};
const reply=review=>async()=>({review,sessionId});
async function settings(fileEnabled,chatEnabled){const s=defaults();s.logging={enabled:fileEnabled,chatEnabled};await saveSettings(s,revisionOf(await readSettings()));}
async function fixture(source='codex'){
  const root=await mkdtemp(path.join(home,'project-'));await writeFile(path.join(root,'x.ts'),'v1');
  const s=await start(root,{source,context:'Private context',title:'chat logs',files:['x.ts']});
  return {root,id:s.id,file:path.join(root,'.revloop','runs',s.id,'rounds.jsonl')};
}
function command(f,name='status',extra=[]){
  const result=spawnSync(process.execPath,[cli,name,'--root',f.root,'--run',f.id,...extra],{encoding:'utf8',windowsHide:true});
  assert.ok([0,1,2].includes(result.status),result.stderr);
  assert.ok(result.stdout,result.stderr);
  return {exit:result.status,...JSON.parse(result.stdout)};
}

test('both source hosts support all four independent file/chat settings through CLI status',async()=>{
  for(const source of ['codex','claude'])for(const fileEnabled of [false,true])for(const chatEnabled of [false,true]){
    await settings(fileEnabled,chatEnabled);const f=await fixture(source);
    await review(f.root,f.id,reply(fail));await writeFile(path.join(f.root,'x.ts'),'v2');
    await review(f.root,f.id,reply(pass));
    const result=command(f);
    assert.equal(result.status,'PASS');assert.equal(result.chatLog.enabled,chatEnabled);
    if(chatEnabled){
      assert.match(result.chatLog.text,/今回 2\/5回 \/ 累計 2回/);
      assert.match(result.chatLog.text,/累計1回目: レビュー判定 FAIL \/ 指摘1件/);
      assert.ok(result.chatLog.text.includes(JSON.stringify(finding.message)));
      assert.match(result.chatLog.text,/累計2回目: レビュー判定 PASS \/ 指摘0件/);
      assert.ok(!result.chatLog.text.includes('Private context'));assert.ok(!result.chatLog.text.includes('Use addition'));
    }else assert.equal(result.chatLog.text,'');
    if(fileEnabled)assert.equal((await readFile(f.file,'utf8')).trim().split('\n').length,2);
    else await assert.rejects(readFile(f.file),{code:'ENOENT'});
  }
});

test('final status reloads chat setting for an already completed run without rewriting state or requiring a file log',async()=>{
  await settings(false,false);const f=await fixture();await review(f.root,f.id,reply(pass));
  const stateFile=path.join(f.root,'.revloop','runs',f.id,'state.json'),before=await readFile(stateFile,'utf8');
  assert.equal(command(f).chatLog.text,'');await settings(false,true);
  assert.match(command(f).chatLog.text,/累計1回目/);await settings(true,false);
  assert.equal(command(f).chatLog.text,'');assert.equal(await readFile(stateFile,'utf8'),before);
});

test('OFF retains stop reasons and required CLI diagnostics; stop result carries current preference',async()=>{
  await settings(false,false);const f=await fixture();await review(f.root,f.id,reply(fail));
  const stopped=command(f,'stop',['--reason','scope changed']);
  assert.equal(stopped.status,'STOPPED');assert.equal(stopped.reason,'scope changed');
  assert.deepEqual(stopped.chatLog,{enabled:false,text:''});
  const status=command(f);assert.equal(status.exit,2);assert.equal(status.halt.reason,'scope changed');assert.ok(status.halt.nextAction);assert.ok(status.halt.logs.state);
  await settings(false,true);assert.match(command(f).chatLog.text,/scope changed/);
});

test('errors, incomplete attempts and legacy verdict contradictions are represented without claiming success',async()=>{
  await settings(false,true);const f=await fixture();
  const s=await review(f.root,f.id,async()=>{throw Error('reviewer timeout');});
  const result=command(f);assert.equal(result.status,'ERROR');assert.equal(result.exit,1);
  assert.match(result.chatLog.text,/累計1回目: ERROR \/ レビュー結果なし/);assert.match(result.chatLog.text,/reviewer timeout/);
  const legacy={...s,status:'REVIEWING',reason:undefined,rounds:[{number:1,fingerprint:'fixture',startedAt:'fixture'}]};
  assert.match(formatChatLog(legacy),/未完了/);
  legacy.rounds[0].review={...fail,verdict:'PASS'};assert.match(formatChatLog(legacy),/PASS → FAIL/);
  legacy.cycle={number:2,startRound:1};assert.match(formatChatLog(legacy),/今回 0\/5回 \/ 累計 1回/);
});

test('unreadable chat settings do not hide a completed result or guess the preference',async()=>{
  await settings(false,true);const f=await fixture();const s=await review(f.root,f.id,reply(pass));
  await writeFile(settingsFile(),'{');
  const result=command(f);assert.equal(result.status,'PASS');assert.equal(result.exit,0);
  assert.equal(result.chatLog.enabled,null);assert.equal(result.chatLog.text,'');assert.match(result.chatLog.error,/設定を読み込めませんでした/);
  assert.deepEqual(await chatLog(s),result.chatLog);
  await writeFile(settingsFile(),JSON.stringify(defaults()));
});
