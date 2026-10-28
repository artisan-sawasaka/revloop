// Read-only verification of a desktop-driven fixture; never invokes either AI.
import { readFile, readdir, mkdir, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
const [rootArg, outputArg] = process.argv.slice(2);
if (!rootArg || !outputArg) throw Error('usage: node test/desktop-audit.mjs FIXTURE_ROOT EVIDENCE_DIRECTORY');
const root=path.resolve(rootArg), output=path.resolve(outputArg);
const sha=data=>createHash('sha256').update(data).digest('hex');
const ids=await readdir(path.join(root,'.revloop','runs'));
if(ids.length!==1)throw Error('Expected exactly one run; do not silently pick the latest');
const dir=path.join(root,'.revloop','runs',ids[0]);
const s=JSON.parse(await readFile(path.join(dir,'state.json'),'utf8'));
const checks={twoRounds:s.rounds.length===2,finalPass:s.status==='PASS',firstFail:s.rounds[0]?.review?.verdict==='FAIL',secondPass:s.rounds[1]?.review?.verdict==='PASS',sameReviewer:s.rounds.length===2&&s.rounds[0].sessionId===s.rounds[1].sessionId,sourceSessionRecorded:typeof s.sourceSession==='string'&&s.sourceSession.length>0,inputFingerprints:true,testUnchanged:true,currentFilesMatch:true,sourceChanged:false};
const inputs=[];
for(const round of s.rounds){const data=await readFile(path.join(dir,`round-${round.number}`,'input.json'),'utf8');checks.inputFingerprints&&=sha(data)===round.fingerprint;inputs.push(JSON.parse(data));}
const first=inputs[0],last=inputs.at(-1);
const beforeTest=first?.files.find(f=>f.path==='discount.test.mjs');
checks.testUnchanged=!!beforeTest&&inputs.every(i=>i.files.find(f=>f.path==='discount.test.mjs')?.sha256===beforeTest.sha256);
checks.sourceChanged=first?.files.find(f=>f.path==='discount.ts')?.sha256!==last?.files.find(f=>f.path==='discount.ts')?.sha256;
for(const f of last?.files??[]) checks.currentFilesMatch&&=sha(await readFile(path.join(root,f.path)))===f.sha256;
if(s.billing){
  checks.billingAllowed=s.billing.status==='ALLOW'&&s.billing.modelExecutionAllowed===true;
  checks.billingBeforeEveryReview=true;
  for(const round of s.rounds){
    const file=path.join(dir,`round-${round.number}`,'billing-check.json');
    if(!existsSync(file)){checks.billingBeforeEveryReview=false;continue;}
    const b=JSON.parse(await readFile(file,'utf8'));
    checks.billingBeforeEveryReview&&=b.status==='ALLOW'&&b.modelExecutionAllowed===true&&b.accountFingerprint===s.billing.accountFingerprint&&Date.parse(b.checkedAt)>=Date.parse(round.startedAt)&&Date.parse(b.checkedAt)<=Date.parse(round.finishedAt);
  }
}
const result={verified:Object.values(checks).every(Boolean),observedAt:new Date().toISOString(),root,run:s.id,source:s.source,sourceSession:s.sourceSession,reviewer:s.reviewer,reviewerSession:s.reviewerSession,title:s.title,status:s.status,checks};
await mkdir(output,{recursive:true});await writeFile(path.join(output,'audit.json'),JSON.stringify(result,null,2));
for(const file of ['state.json','history.jsonl','context.txt'])await copyFile(path.join(dir,file),path.join(output,file));
for(const round of s.rounds){const target=path.join(output,`round-${round.number}`);await mkdir(target,{recursive:true});for(const file of ['input.json','review.json','process.json','billing-check.json']){const source=path.join(dir,`round-${round.number}`,file);if(existsSync(source))await copyFile(source,path.join(target,file));}}
console.log(JSON.stringify(result,null,2));if(!result.verified)process.exitCode=1;
