import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {readTokenUsage,formatTokenUsage} from '../dist/token-usage.js';
import {decodeResult} from '../dist/providers.js';
import {start,review} from '../dist/engine.js';
import {formatChatLog,chatLog} from '../dist/chat-log.js';
import {defaults,readSettings,saveSettings,revisionOf} from '../dist/settings.js';

const home=await mkdtemp(path.join(os.tmpdir(),'revloop-usage-'));
process.env.HOME=home;process.env.USERPROFILE=home;
const sessionId='11111111-2222-3333-4444-555555555555';
const pass={verdict:'PASS',summary:'fixture',findings:[]};
const claudeUsage={input_tokens:10,cache_read_input_tokens:100,cache_creation_input_tokens:20,output_tokens:30,output_tokens_details:{thinking_tokens:7}};
const normalized={inputTokens:130,outputTokens:30,totalTokens:160,cacheReadTokens:100,cacheWriteTokens:20,reasoningTokens:7};

test('Claude JSON and stream result usage includes cache once, excludes cumulative modelUsage and preserves zero',()=>{
 const result={type:'result',usage:claudeUsage,modelUsage:{opus:{inputTokens:99999}}};
 for(const raw of [JSON.stringify(result),JSON.stringify(result,null,2),JSON.stringify({type:'assistant',message:{usage:claudeUsage}})+'\n'+JSON.stringify(result)])assert.deepEqual(readTokenUsage('claude',raw),normalized);
 assert.equal(readTokenUsage('claude',JSON.stringify({type:'result',usage:{input_tokens:0,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}})).totalTokens,0);
 // Resumed results' modelUsage can be cumulative; usage is scoped to the current call.
 assert.deepEqual(readTokenUsage('claude',JSON.stringify({...result,modelUsage:{opus:{inputTokens:200000}}})),normalized);
});

test('Codex turn usage counts cached input and reasoning only as breakdowns, never adds item usage',()=>{
 const stdout=JSON.stringify({type:'item.completed',usage:{input_tokens:999}})+'\n'+JSON.stringify({type:'turn.completed',usage:{input_tokens:130,cached_input_tokens:100,output_tokens:30,reasoning_output_tokens:7}});
 assert.deepEqual(readTokenUsage('codex',stdout),{...normalized,cacheWriteTokens:null});
 const raw={code:0,stdout:JSON.stringify({type:'thread.started',thread_id:sessionId})+'\n'+JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(pass)}})+'\n'+stdout,stderr:''};
 assert.equal(decodeResult('codex',raw).tokenUsage.totalTokens,160);
});

test('missing, truncated, negative, fractional and unsafe counts remain unknown, not estimated zero',()=>{
 for(const stdout of ['','{','{}',JSON.stringify({type:'result',modelUsage:{opus:{inputTokens:42}}}),JSON.stringify({type:'result',usage:{}})])assert.equal(readTokenUsage('claude',stdout),undefined);
 for(const value of [-1,1.2,'3',Number.MAX_SAFE_INTEGER+1,null]){
  const u=readTokenUsage('claude',JSON.stringify({type:'result',usage:{...claudeUsage,input_tokens:value}}));assert.equal(u.inputTokens,null);assert.equal(u.totalTokens,null);assert.equal(u.outputTokens,30);
 }
 const partial=readTokenUsage('claude',JSON.stringify({type:'result',usage:{input_tokens:10,output_tokens:30}}));assert.equal(partial.totalTokens,null);assert.match(formatTokenUsage(partial),/合計 不明/);
 assert.match(formatTokenUsage(),/不明/);
 assert.equal(readTokenUsage('claude',JSON.stringify({type:'result',usage:{...claudeUsage,input_tokens:Number.MAX_SAFE_INTEGER}})).totalTokens,null);
});

async function fixture(){
 const root=await mkdtemp(path.join(home,'project-'));await writeFile(path.join(root,'x.ts'),'fixture');
 const state=await start(root,{source:'codex',title:'usage',context:'fixture',files:['x.ts']});
 return {root,id:state.id,dir:path.join(root,'.revloop','runs',state.id)};
}
async function preferences(file,chat){const s=defaults();s.logging={enabled:file,chatEnabled:chat};await saveSettings(s,revisionOf(await readSettings()));}

test('usage is persisted before rejected findings and file/chat toggles remain independent',async()=>{
 for(const file of [false,true])for(const chat of [false,true]){
  await preferences(file,chat);const f=await fixture();
  const s=await review(f.root,f.id,async()=>({sessionId,review:pass,tokenUsage:normalized}));
  assert.deepEqual(s.rounds[0].tokenUsage,normalized);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.dir,'state.json'),'utf8')).rounds[0].tokenUsage,normalized);
  if(file){const entry=JSON.parse((await readFile(path.join(f.dir,'rounds.jsonl'),'utf8')).trim());assert.deepEqual(entry.tokenUsage,normalized);}else await assert.rejects(readFile(path.join(f.dir,'rounds.jsonl')),{code:'ENOENT'});
  const log=await chatLog(s);assert.equal(log.enabled,chat);if(chat)assert.match(log.text,/入力 130 \/ 出力 30 \/ 合計 160/);else assert.equal(log.text,'');
 }
 await preferences(true,true);const f=await fixture();const s=await review(f.root,f.id,async()=>({sessionId,tokenUsage:normalized,review:{verdict:'FAIL',summary:'fixture',findings:[{severity:'P1',file:'outside.ts',line:1,message:'outside',fix:'none'}]}}));
 assert.equal(s.status,'ERROR');assert.deepEqual(s.rounds[0].tokenUsage,normalized);
 const legacy={...s,rounds:s.rounds.map(({tokenUsage,...r})=>r)};assert.match(formatChatLog(legacy),/トークン: 不明/);
});

test('actual Claude adapter retains reported usage on successful and nonzero error results',async t=>{
 await preferences(true,true);
 const fake=path.join(home,'fake-claude.mjs');
 await writeFile(fake,`const a=process.argv.slice(2);if(a[0]==='auth')console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'max',email:'test@example.invalid',orgId:'fixture'}));else if(a[0]==='--version')console.log('fixture');else if(a[0]==='--help')console.log('--safe-mode --restricted --strict-mcp-config --tools --json-schema --name');else if(a.includes('-p')){console.log(JSON.stringify({type:'result',subtype:'success',is_error:process.env.FAKE_TOKEN_ERROR==='1',session_id:'${sessionId}',structured_output:${JSON.stringify(pass)},usage:${JSON.stringify(claudeUsage)}}));if(process.env.FAKE_TOKEN_ERROR==='1')process.exitCode=1;}else process.exitCode=98;`);
 const old=process.env.REVLOOP_CLAUDE_PATH;process.env.REVLOOP_CLAUDE_PATH=fake;
 t.after(()=>{if(old===undefined)delete process.env.REVLOOP_CLAUDE_PATH;else process.env.REVLOOP_CLAUDE_PATH=old;delete process.env.FAKE_TOKEN_ERROR;});
 for(const error of [false,true]){
  process.env.FAKE_TOKEN_ERROR=error?'1':'0';const f=await fixture(),s=await review(f.root,f.id);
  assert.equal(s.status,error?'ERROR':'PASS',s.reason);assert.deepEqual(s.rounds[0].tokenUsage,normalized);
  assert.deepEqual(JSON.parse((await readFile(path.join(f.dir,'rounds.jsonl'),'utf8')).trim()).tokenUsage,normalized);
 }
});
