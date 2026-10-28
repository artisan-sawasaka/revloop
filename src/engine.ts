import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { snapshot, hash } from './snapshot.js';
import { atomicJson, event, loadState, lock, runDir, safeDir, saveState } from './storage.js';
import { codexMetadata, invokeReviewer, type ProviderResult } from './providers.js';
import { terminal, hasVisualCoverage, assessReview, reviewCount, type Provider, type State } from './types.js';
import { BillingSafetyError, requireIncludedBilling, requireSameAccount } from './billing.js';
import { readSettings, selectReviewerSettings } from './settings.js';
import { writeRoundLog } from './round-log.js';
import {storeImages,loadImages} from './images.js';
import {buildHaltReport,haltText,stopReason,type HaltReport} from './halt.js';
export interface StartOptions { source: Provider; context: string; title: string; sourceSession?: string; files?: string[]; maxRounds?: number; stallLimit?: number; timeoutMs?: number; visual?:boolean }
export async function start(root: string, options: StartOptions): Promise<State> {
  if (!['codex','claude'].includes(options.source)) throw new Error('--source must be codex or claude');
  if (!options.context.trim() || Buffer.byteLength(options.context) > 64_000) throw new Error('Context must be nonempty and at most 64 KB');
  if (!options.title.trim() || options.title.length > 200) throw new Error('Title must be 1..200 characters');
  const settings=await readSettings();
  const maxRounds = options.maxRounds ?? settings.loop.maxRounds, stallLimit = options.stallLimit ?? settings.loop.stallLimit, timeoutMs = options.timeoutMs ?? settings.loop.timeoutSeconds*1000;
  for (const [name,n,min,max] of [['maxRounds',maxRounds,1,50],['stallLimit',stallLimit,1,10],['timeoutMs',timeoutMs,1000,3_600_000]] as const) if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid ${name} (${min}..${max})`);
  const initial=await snapshot(root,options.files ?? [],options.context); // Validate before creating the run.
  if(options.visual&&!initial.images.length)throw Error('Visual review requires PNG, JPEG or WebP image files in --file scope');
  const id = randomUUID(), dir = await runDir(root,id);
  const reviewerCwd = await mkdtemp(path.join(os.tmpdir(),'revloop-'));
  const s: State = {version:1,id,root,source:options.source,reviewer:options.source === 'codex' ? 'claude' : 'codex',sourceSession:options.sourceSession,title:options.title,reviewerCwd,context:options.context,files:options.files ?? [],maxRounds,stallLimit,timeoutMs,status:'READY',createdAt:new Date().toISOString(),rounds:[]};
  s.visualRequired=options.visual===true||initial.images.length>0;
  await saveState(dir,s); await writeFile(path.join(dir,'context.txt'),s.context); await event(dir,{type:'start',source:s.source,reviewer:s.reviewer,sourceSession:s.sourceSession}); return s;
}
type Reviewer = (s: State, roundDir: string, stopFile: string) => Promise<ProviderResult>;
export async function review(root: string, id: string, reviewer: Reviewer = invokeReviewer): Promise<State> {
  const dir = await runDir(root,id), release = await lock(dir);
  let s: State | undefined;
  let logEnabled=false, pendingRound: State['rounds'][number] | undefined;
  const stopFile = path.join(dir,'STOP');
  const finish = async () => {
    if (existsSync(stopFile)) { s!.status='STOPPED'; s!.reason=await stopReason(dir); }
    if (logEnabled&&pendingRound) {
      const round=pendingRound;pendingRound=undefined;
      try { s!.roundLogFile=await writeRoundLog(dir,s!,round);delete s!.roundLogError; }
      catch(e) { s!.roundLogError=`簡易ログを保存できませんでした: ${(e as Error).message}`; }
    }
    await saveState(dir,s!); await event(dir,{type:'state',status:s!.status,round:s!.rounds.length,reason:s!.reason,halt:buildHaltReport(s!)}); return s!;
  };
  try {
    s = await loadState(root,id);
    if (terminal(s.status)) return s;
    if (existsSync(stopFile)) { s.status = 'STOPPED'; return await finish(); }
    if (s.status === 'REVIEWING') throw new Error('Previous review was interrupted; start a new run');
    if (reviewCount(s) >= s.maxRounds) { s.status = 'MAX_ROUNDS'; s.reason=`最大レビュー回数 ${s.maxRounds} 回に到達しました（今回 ${reviewCount(s)} 回、累計 ${s.rounds.length} 回）。`; return await finish(); }
    const settings=await readSettings();
    logEnabled=settings.logging.enabled;
    if(reviewer!==invokeReviewer)s.reviewerSettings=settings.planProfiles[s.reviewer].pro!;
    // Mock reviewers never perform inference. The real adapter also gates itself when called directly.
    if (reviewer === invokeReviewer) {
      const billing=await requireIncludedBilling(s.reviewer,process.cwd(),stopFile);
      requireSameAccount(s.billing,billing);s.billing=billing;
      s.reviewerSettings=selectReviewerSettings(settings,s.reviewer,billing.plan);
      s.reviewerPlan=billing.plan!;
      if(s.reviewer==='claude')billing.model=s.reviewerSettings.model as 'opus'|'sonnet'|'fable';
      await atomicJson(path.join(dir,'billing-check.json'),billing);
      await event(dir,{type:'billing-allowed',provider:s.reviewer,accountFingerprint:billing.accountFingerprint,checkedAt:billing.checkedAt});
    }
    const snap = await snapshot(root,s.files,s.context);
    if(s.visualRequired&&!snap.images.length){s.status='BLOCKED';s.reason='Visual review NOT RUN: required images are missing';return await finish();}
    if (s.rounds.some(r => r.fingerprint === snap.fingerprint)) { s.status = 'STALLED'; s.reason = 'Input unchanged or repeated; no new reviewer request sent'; return await finish(); }
    const round = {number:s.rounds.length+1,fingerprint:snap.fingerprint,startedAt:new Date().toISOString(),reviewerSettings:{...s.reviewerSettings},...(s.reviewerPlan?{reviewerPlan:s.reviewerPlan}:{})} as State['rounds'][number];
    round.visualReview={status:'NOT_RUN',images:snap.images.map(i=>i.path),reason:snap.images.length?'Awaiting visual reviewer result':'Text-only scope; no images attached'};
    s.rounds.push(round); s.status = 'REVIEWING'; delete s.reason; await saveState(dir,s);
    pendingRound=round;
    const roundDir = path.join(dir,`round-${round.number}`); await safeDir(roundDir);
    await writeFile(path.join(roundDir,'input.json'),snap.input);
    await storeImages(roundDir,snap.images);
    await safeDir(s.reviewerCwd); await writeFile(path.join(s.reviewerCwd,'input.json'),snap.input);
    await event(dir,{type:'review-start',round:round.number,fingerprint:snap.fingerprint});
    const result = await reviewer(s,roundDir,stopFile);
    if(result.tokenUsage)round.tokenUsage=result.tokenUsage;
    const knownFiles = new Set<string>(JSON.parse(snap.input).files.map((f: { path: string }) => f.path));
    for (const finding of result.review.findings) if (!knownFiles.has(finding.file)) throw new Error(`Reviewer finding refers outside the supplied scope: ${finding.file}`);
    round.review = result.review; round.sessionId = result.sessionId; round.finishedAt = new Date().toISOString();
    round.decision=assessReview(result.review);
    s.reviewerSession = result.sessionId;
    await atomicJson(path.join(roundDir,'review.json'),result.review);
    await atomicJson(path.join(roundDir,'decision.json'),round.decision);
    if (existsSync(stopFile)) { s.status = 'STOPPED'; return await finish(); }
    if (hash(await readFile(path.join(s.reviewerCwd,'input.json'))) !== hash(snap.input)) throw new Error('Reviewer input modified; verdict rejected');
    if ((await snapshot(root,s.files,s.context)).fingerprint !== snap.fingerprint) throw new Error('Source changed during review; verdict rejected');
    if(snap.images.length) {
      await loadImages(roundDir,JSON.parse(snap.input).files); // Verify copies against original digests, not mutable manifests.
      if(!hasVisualCoverage(result.review,snap.images.map(i=>i.path))) {
        s.status='BLOCKED';s.reason='Visual review NOT RUN or incomplete: every supplied image requires an observation';round.visualReview.reason=s.reason;return await finish();
      }
      round.visualReview={status:'REVIEWED',images:snap.images.map(i=>i.path)};
    }
    if(round.decision.warnings.length)s.reason=round.decision.warnings.join(' ');
    if (round.decision.effectiveVerdict === 'PASS') s.status = 'PASS';
    else if (round.decision.effectiveVerdict === 'BLOCKED') { s.status = 'BLOCKED'; s.reason = s.reason??result.review.summary; }
    else {
      round.findingKey = hash(JSON.stringify(result.review.findings.map(f => `${f.severity}|${f.file}|${f.message.replace(/\s+/g,' ').trim()}`).sort()));
      const recent = s.rounds.slice(-s.stallLimit);
      if (recent.length === s.stallLimit && recent.every(r => r.findingKey === round.findingKey)) { s.status = 'STALLED'; s.reason = `同じ指摘が ${s.stallLimit} 回連続したため停止しました。`; }
      else {s.status = reviewCount(s) >= s.maxRounds ? 'MAX_ROUNDS' : 'NEEDS_FIX';if(s.status==='MAX_ROUNDS')s.reason=`最大レビュー回数 ${s.maxRounds} 回に到達しました（未解決指摘 ${result.review.findings.length} 件）。`;}
    }
    if (s.reviewer === 'codex' && s.rounds.length === 1 && reviewer === invokeReviewer) {
      try { await codexMetadata('thread/name/set',{threadId:s.reviewerSession,name:s.title},s.reviewerCwd); }
      catch (e) { s.warning = `Reviewer title is stored locally; Codex rename failed: ${(e as Error).message}`; }
    }
    return await finish();
  } catch (e) {
    if (!s) throw e;
    s.status = existsSync(stopFile) || (e as Error).message === 'STOPPED' ? 'STOPPED' : e instanceof BillingSafetyError ? 'BLOCKED' : 'ERROR'; s.reason = (e as Error).message;
    if (e instanceof BillingSafetyError) {
      s.billing = e.report;
      await atomicJson(path.join(dir,'billing-check.json'),e.report);
      await event(dir,{type:'billing-blocked',provider:s.reviewer,reasons:e.report.reasons});
    }
    const round = s.rounds.at(-1); if (round && !round.finishedAt) { round.error = s.reason; round.finishedAt = new Date().toISOString(); if(round.visualReview?.status==='NOT_RUN')round.visualReview.reason=s.reason; }
    return await finish();
  } finally { await release(); }
}
export async function stop(root: string, id: string,reason='revloop stopによる停止要求を受け付けました。'): Promise<{ id: string; status: string; reason:string; historyDirectory:string; halt?:HaltReport }> {
  if(!reason.trim()||reason.length>2000)throw Error('Stop reason must contain 1..2000 characters');
  const dir = await runDir(root,id),s=await loadState(root,id);
  if(terminal(s.status)&&!(s.status==='MAX_ROUNDS'&&existsSync(path.join(dir,'lock'))))return {id,status:s.status,reason:`Run is already ${s.status}; no new stop request was written.`,historyDirectory:dir,halt:buildHaltReport(s)};
  if(existsSync(path.join(dir,'STOP')))reason=await stopReason(dir);
  else await atomicJson(path.join(dir,'STOP'),{requestedAt:new Date().toISOString(),reason:reason.trim()});
  const halt=buildHaltReport({...s,status:'STOPPED',reason:reason.trim(),stopPending:true})!;
  halt.status='STOP_REQUESTED';halt.logs.stopRequestLog=path.join(dir,'stop-request.log');
  await writeFile(halt.logs.stopRequestLog,haltText(halt));await event(dir,{type:'stop-requested',reason:halt.reason,halt});
  // The running owner observes STOP and kills only its own process tree. No persisted PID is killed.
  let release:()=>Promise<void>;
  try{release=await lock(dir);}catch(e){if(!((e as Error).message.startsWith('This run is locked.')))throw e;return {id,status:'STOP_REQUESTED',reason:halt.reason,historyDirectory:dir,halt};}
  try {
    const latest=await loadState(root,id);
    if(!terminal(latest.status)){latest.status='STOPPED';latest.reason=await stopReason(dir);await saveState(dir,latest);await event(dir,{type:'state',status:latest.status,reason:latest.reason,halt:buildHaltReport(latest)});}
    return {id,status:latest.status,reason:latest.reason??`Run is already ${latest.status}.`,historyDirectory:dir,halt:buildHaltReport(latest)};
  } finally {await release();}
}
export async function status(root: string, id: string): Promise<State> {
  const s = await loadState(root,id), dir = await runDir(root,id);
  if (existsSync(path.join(dir,'STOP')) && !terminal(s.status)) return {...s,status:'STOPPED',reason:await stopReason(dir),stopPending:existsSync(path.join(dir,'lock'))};
  return s;
}
