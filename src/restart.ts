import {readFile,copyFile,unlink} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomicJson,event,loadState,lock,runDir,safeDir,saveState} from './storage.js';
import {BillingSafetyError,requireIncludedBilling,requireSameAccount} from './billing.js';
import {assessReview,reviewCount,type State} from './types.js';
import {snapshot} from './snapshot.js';
import {readSettings} from './settings.js';
import {stopReason} from './halt.js';

export class RestartError extends Error {
  constructor(readonly diagnostic:{status:'BLOCKED';id:string;runStatus:State['status'];reason:string;billingReasons:string[];logs:Record<string,string>;nextAction:string}) {super(diagnostic.reason);}
}

// A new cycle has its own review budget, but retains all evidence, session,
// unresolved findings and stagnation history. This never performs inference.
export async function restart(root:string,id:string,check:typeof requireIncludedBilling=requireIncludedBilling):Promise<State> {
  const dir=await runDir(root,id),release=await lock(dir),stopFile=path.join(dir,'STOP');
  try {
    const s=await loadState(root,id);
    const attempt=path.join(dir,`restart-${randomUUID()}`);await safeDir(attempt);
    const logs={result:path.join(attempt,'result.json'),history:path.join(dir,'history.jsonl'),state:path.join(dir,'state.json')};
    let next:State;
    try {
      if(s.status!=='MAX_ROUNDS'||reviewCount(s)<s.maxRounds)throw Error('restart requires a run stopped at its maximum review count');
      if(existsSync(stopFile))throw Error('restart refused: STOP marker exists');
      if(s.rounds.some(r=>!r.review||!r.finishedAt||r.error))throw Error('restart refused: partial or failed review requires inspection');
      const last=s.rounds.at(-1);
      if(!last||assessReview(last.review!).effectiveVerdict!=='FAIL')throw Error('restart refused: no unresolved repair verdict');
      const recent=s.rounds.slice(-s.stallLimit);
      if(recent.length===s.stallLimit&&recent[0]?.findingKey&&recent.every(r=>r.findingKey===recent[0]!.findingKey))throw Error('restart refused: stagnation limit reached');
      const history=(await readFile(path.join(dir,'history.jsonl'),'utf8')).trim().split(/\r?\n/).map(line=>JSON.parse(line));
      if(history.reverse().find(e=>e.type==='state')?.status!=='MAX_ROUNDS')throw Error('restart refused: history does not establish the review limit');
      if(s.billing?.provider!==s.reviewer||s.billing.status!=='ALLOW'||!s.billing.modelExecutionAllowed||!s.billing.accountFingerprint)throw Error('restart refused: historical account evidence missing');
      for(const file of ['state.json','billing-check.json','halt.json','halt.log'])if(existsSync(path.join(dir,file)))await copyFile(path.join(dir,file),path.join(attempt,file));
      await event(dir,{type:'restart-requested',attempt,previousCycle:s.cycle?.number??1,previousCount:reviewCount(s),totalReviews:s.rounds.length});
      const settings=await readSettings();
      const billing=await check(s.reviewer,process.cwd(),stopFile);
      await atomicJson(path.join(attempt,'current-billing.json'),billing);
      if(billing.provider!==s.reviewer||billing.status!=='ALLOW'||!billing.modelExecutionAllowed||!billing.accountFingerprint)throw new BillingSafetyError({...billing,status:'BLOCKED',modelExecutionAllowed:false,reasons:[...billing.reasons,'RESTART_AUTH_NOT_VERIFIED']});
      requireSameAccount(s.billing,billing);
      const snap=await snapshot(root,s.files,s.context);
      if(s.visualRequired&&!snap.images.length)throw Error('restart refused: required images missing');
      if(s.rounds.slice(0,-1).some(r=>r.fingerprint===snap.fingerprint))throw Error('restart refused: input repeats an earlier round');
      if(existsSync(stopFile))throw Error('restart refused: STOP marker exists');
      next={...s,maxRounds:settings.loop.maxRounds,billing,status:last.fingerprint===snap.fingerprint?'NEEDS_FIX':'READY',cycle:{number:(s.cycle?.number??1)+1,startRound:s.rounds.length,startedAt:new Date().toISOString(),archiveDirectory:attempt}};
      delete next.reason;
    } catch(e) {
      if(existsSync(stopFile)){s.status='STOPPED';s.reason=await stopReason(dir);await saveState(dir,s);await event(dir,{type:'state',status:s.status,round:s.rounds.length,reason:s.reason});}
      const diagnostic={status:'BLOCKED' as const,id,runStatus:s.status,reason:(e as Error).message,billingReasons:e instanceof BillingSafetyError?e.report.reasons:[],logs,nextAction:'元のrun状態・回数は維持しています。停止理由を解決し、再開を希望する場合だけ再実行してください。STOP・停滞・認証条件は回避できません。'};
      if(e instanceof BillingSafetyError)await atomicJson(path.join(attempt,'current-billing.json'),e.report);
      await atomicJson(logs.result,diagnostic);await event(dir,{type:'restart-refused',...diagnostic});
      throw new RestartError(diagnostic);
    }
    await atomicJson(path.join(dir,'billing-check.json'),next.billing);
    if(existsSync(stopFile)){next.status='STOPPED';next.reason=await stopReason(dir);}
    await saveState(dir,next);
    if(next.status!=='STOPPED')for(const file of ['halt.json','halt.log'])if(existsSync(path.join(dir,file)))await unlink(path.join(dir,file));
    await atomicJson(logs.result,{status:next.status,id,cycle:next.cycle,reviewCount:reviewCount(next),totalReviews:next.rounds.length,maxRounds:next.maxRounds});
    await event(dir,{type:'cycle-restarted',cycle:next.cycle,previousMaxRounds:s.maxRounds,maxRounds:next.maxRounds,reviewCount:0,totalReviews:next.rounds.length});
    await event(dir,{type:'billing-allowed',provider:next.reviewer,accountFingerprint:next.billing!.accountFingerprint,checkedAt:next.billing!.checkedAt,via:'restart'});
    await event(dir,{type:'state',status:next.status,round:next.rounds.length,reviewCount:0});
    return next;
  } finally {await release();}
}
