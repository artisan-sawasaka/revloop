import {readFile,copyFile,unlink} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomicJson,event,loadState,lock,runDir,safeDir,saveState} from './storage.js';
import {BillingSafetyError,requireIncludedBilling,type BillingReport} from './billing.js';
import {assessReview,reviewCount,type State} from './types.js';
import {snapshot} from './snapshot.js';
import {stopReason} from './halt.js';

// Explicit recovery only: review() must continue to treat BLOCKED as terminal.
// A partial reviewer attempt is deliberately ineligible; absence of output is not
// evidence that inference never started. No rounds or STOP markers are deleted.
export async function resume(root:string,id:string,check:typeof requireIncludedBilling=requireIncludedBilling):Promise<State> {
  const dir=await runDir(root,id),release=await lock(dir),stopFile=path.join(dir,'STOP');
  try {
    const s=await loadState(root,id);
    if(s.status!=='BLOCKED'||s.billing?.status!=='BLOCKED'||s.billing.modelExecutionAllowed!==false)
      throw Error('resume requires a billing/authentication BLOCKED run; other terminal states cannot be reopened');
    if(existsSync(stopFile))throw Error('resume refused: STOP marker exists; stopping cannot be bypassed');
    if(reviewCount(s)>=s.maxRounds)throw Error('resume refused: maximum review count reached');
    if(s.rounds.some(r=>!r.review||!r.finishedAt||r.error))throw Error('resume refused: partial or failed reviewer attempt requires inspection; its input cannot be retried automatically');
    const last=s.rounds.at(-1);
    if(last&&assessReview(last.review!).effectiveVerdict!=='FAIL')throw Error('resume refused: the last completed review did not request repairs');
    const recent=s.rounds.slice(-s.stallLimit);
    if(recent.length===s.stallLimit&&recent[0]?.findingKey&&recent.every(r=>r.findingKey===recent[0]!.findingKey))
      throw Error('resume refused: repeated findings reached the stagnation limit');
    const history=(await readFile(path.join(dir,'history.jsonl'),'utf8')).trim().split(/\r?\n/).map(line=>JSON.parse(line));
    const lastState=[...history].reverse().find(e=>e.type==='state');
    const lastGate=[...history].reverse().find(e=>e.type==='billing-blocked'||e.type==='billing-allowed'||e.type==='review-start');
    if(lastState?.status!=='BLOCKED'||lastGate?.type!=='billing-blocked'||lastGate.provider!==s.reviewer||
       JSON.stringify(lastGate.reasons)!==JSON.stringify(s.billing.reasons))
      throw Error('resume refused: saved history does not establish a billing block');
    const identities=new Set<string>();
    for(const e of history.filter(e=>e.type==='billing-allowed'&&e.provider===s.reviewer)) {
      if(typeof e.accountFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(e.accountFingerprint))throw Error('resume refused: historical account identity is invalid');
      identities.add(e.accountFingerprint);
    }
    for(const round of s.rounds) {
      const report=JSON.parse(await readFile(path.join(dir,`round-${round.number}`,'billing-check.json'),'utf8')) as BillingReport;
      if(report.provider!==s.reviewer||report.status!=='ALLOW'||!report.modelExecutionAllowed||!report.accountFingerprint)
        throw Error('resume refused: completed round lacks account evidence');
      identities.add(report.accountFingerprint);
    }
    if(identities.size>1||((s.rounds.length||s.reviewerSession)&&identities.size!==1))throw Error('resume refused: historical account identity is missing or inconsistent');
    const attempt=path.join(dir,`resume-${randomUUID()}`);await safeDir(attempt);
    for(const file of ['state.json','billing-check.json','halt.json','halt.log'])if(existsSync(path.join(dir,file)))await copyFile(path.join(dir,file),path.join(attempt,file));
    await event(dir,{type:'resume-requested',attempt,previousPolicy:s.billing.policy,round:s.rounds.length});
    s.resumeAttempt={at:new Date().toISOString(),directory:attempt};
    try {
      const report=await check(s.reviewer,process.cwd(),stopFile);
      await atomicJson(path.join(attempt,'current-billing.json'),report);
      if(report.provider!==s.reviewer||report.status!=='ALLOW'||!report.modelExecutionAllowed||!report.accountFingerprint)
        throw new BillingSafetyError({...report,status:'BLOCKED',modelExecutionAllowed:false,reasons:[...report.reasons,'RESUME_AUTH_NOT_VERIFIED']});
      if(identities.size&&!identities.has(report.accountFingerprint))
        throw new BillingSafetyError({...report,status:'BLOCKED',modelExecutionAllowed:false,reasons:['ACCOUNT_CHANGED_DURING_RUN']});
      const snap=await snapshot(root,s.files,s.context);
      if(s.visualRequired&&!snap.images.length)throw Error('Visual review requires the original image scope');
      if(s.rounds.slice(0,-1).some(r=>r.fingerprint===snap.fingerprint))throw Error('resume refused: input repeats an earlier round');
      if(existsSync(stopFile))throw Error('STOPPED');
      s.billing=report;
      s.status=last?.fingerprint===snap.fingerprint?'NEEDS_FIX':'READY';
      delete s.reason;
      await atomicJson(path.join(dir,'billing-check.json'),report);
      await event(dir,{type:'billing-allowed',provider:s.reviewer,accountFingerprint:report.accountFingerprint,checkedAt:report.checkedAt,via:'resume'});
    } catch(e) {
      if(e instanceof BillingSafetyError) {
        s.billing=e.report;await atomicJson(path.join(dir,'billing-check.json'),e.report);
        await event(dir,{type:'billing-blocked',provider:s.reviewer,reasons:e.report.reasons,via:'resume'});
      }
      s.reason=(e as Error).message;
      // A failed recheck never unlocks work. Preserve the original evidence above.
      s.status=existsSync(stopFile)||(e as Error).message==='STOPPED'?'STOPPED':'BLOCKED';
    }
    if(existsSync(stopFile)){s.status='STOPPED';s.reason=await stopReason(dir);}
    await saveState(dir,s);
    if(s.status==='READY'||s.status==='NEEDS_FIX')for(const file of ['halt.json','halt.log'])if(existsSync(path.join(dir,file)))await unlink(path.join(dir,file));
    await atomicJson(path.join(attempt,'result.json'),{status:s.status,reason:s.reason,round:s.rounds.length,reviewerSession:s.reviewerSession});
    await event(dir,{type:'resume-result',attempt,status:s.status,reason:s.reason,round:s.rounds.length});
    await event(dir,{type:'state',status:s.status,reason:s.reason,round:s.rounds.length});
    return s;
  } finally {await release();}
}
