import { requireIncludedBilling } from '../dist/billing.js';
// Explicit, opt-in real CLI smoke test. Not part of npm test; consumes subscription usage.
import { mkdtemp,writeFile,readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { start,review } from '../dist/engine.js';
import { codexMetadata } from '../dist/providers.js';
const reviewer = process.argv[2];
if (!['codex','claude'].includes(reviewer)) throw Error('usage: node test/live-smoke.mjs codex|claude');
const root=await mkdtemp(path.join(os.tmpdir(),`revloop-live-${reviewer}-`));
await requireIncludedBilling(reviewer,process.cwd()); // No live smoke may bypass the production billing policy.
await writeFile(path.join(root,'calc.ts'),'export function add(a: number, b: number): number { return a - b; }\n');
const s=await start(root,{source:reviewer==='codex'?'claude':'codex',context:'Review calc.ts: add must return the arithmetic sum of its two numbers. Pure function; no dependencies. Test evidence is not supplied. Report the arithmetic defect if present; PASS only when fixed.',title:`revloop-live-${reviewer}`,files:['calc.ts'],timeoutMs:120000});
console.log(JSON.stringify({root,run:s.id,phase:'review-bug'}));
const first=await review(root,s.id);console.log(JSON.stringify({status:first.status,review:first.rounds.at(-1)?.review,reason:first.reason}));
if(first.status!=='NEEDS_FIX') {process.exitCode=1;}
else {
  await writeFile(path.join(root,'calc.ts'),'export function add(a: number, b: number): number { return a + b; }\n');
  const second=await review(root,s.id);console.log(JSON.stringify({phase:'review-fix',status:second.status,review:second.rounds.at(-1)?.review,reason:second.reason,sessionId:second.reviewerSession}));
  if(second.status!=='PASS'||second.rounds[0].sessionId!==second.rounds[1].sessionId)process.exitCode=1;
  if(reviewer==='codex'&&second.reviewerSession){const m=await codexMetadata('thread/read',{threadId:second.reviewerSession},root);console.log(JSON.stringify({name:m.thread.name,titleMatches:m.thread.name===s.title}));}
}
console.log(JSON.stringify({history:path.join(root,'.revloop','runs',s.id)}));
