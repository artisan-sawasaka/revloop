import path from 'node:path';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {reviewCount,type State} from './types.js';

export const haltedStatuses=['BLOCKED','STOPPED','MAX_ROUNDS','STALLED','ERROR'] as const;
export interface HaltReport {
  runId:string;status:string;reason:string;reviewer:string;round:number;totalReviews:number;cycleNumber:number;
  limits:{maxRounds:number;stallLimit:number;timeoutSeconds:number};
  billingReasons:string[];reviewerSummary?:string;decisionWarnings:string[];
  nextAction:string;logs:Record<string,string>;
}
export function buildHaltReport(s:State,planned=false):HaltReport|undefined {
  if(!haltedStatuses.includes(s.status as typeof haltedStatuses[number]))return;
  const dir=path.join(s.root,'.revloop','runs',s.id),round=s.rounds.at(-1);
  const fallback:Record<string,string>={
    BLOCKED:s.billing?.status==='BLOCKED'?`課金・利用条件を確認できません: ${s.billing.reasons.join('; ')}`:round?.review?.summary||'レビューを完了するための条件・資料が不足しています。',
    STOPPED:'停止要求または停止シグナルを検出しました。',
    MAX_ROUNDS:`最大レビュー回数 ${s.maxRounds} 回に到達しました（今回 ${reviewCount(s)} 回、累計 ${s.rounds.length} 回）。`,
    STALLED:`同一入力の再出現、または同じ指摘が ${s.stallLimit} 回連続したため停止しました。`,
    ERROR:round?.error||'レビュー処理に失敗しました。実行ログを確認してください。'
  };
  const next:Record<string,string>={
    BLOCKED:s.billing?.status==='BLOCKED'?`billingReasonsを確認し、利用条件・認証・ユーザー確認を解決してください。ユーザーが再開を依頼した場合だけ resume --run ${s.id} で現在のポリシーを再確認できます。課金ガード・回数・停止要求を回避せず、自動再試行しません。`:'不足資料・未確認条件を確認し、継続方針を決めてください。自動修正・再試行は停止しています。',
    STOPPED:s.stopPending?'停止要求を記録済みです。実行中の処理の停止完了はstatusで確認してください。':'停止済みです。元チャットの修正作業は、必要に応じてホスト側でも停止してください。',
    MAX_ROUNDS:`今回のサイクルは停止しました。ユーザーがrevloopを再実行した場合、review --run ${s.id} で履歴・未解消指摘を維持したままカウント0の新サイクルへ移ります。共通設定の最大回数を適用します。同じ自動ループ内では再開しません。`,
    STALLED:'改善しない理由と残る指摘を確認してください。入力・指摘の反復を自動継続しません。',
    ERROR:'reasonと実行ログで原因を確認してください。エラーをFAILとして自動修正・再試行しません。'
  };
  const candidates:Record<string,string>={state:path.join(dir,'state.json'),history:path.join(dir,'history.jsonl'),stopRequest:path.join(dir,'STOP'),stopRequestLog:path.join(dir,'stop-request.log'),halt:path.join(dir,'halt.log'),haltJson:path.join(dir,'halt.json'),billing:path.join(dir,'billing-check.json')};
  if(round)for(const [key,file] of Object.entries({review:'review.json',decision:'decision.json',stdout:'stdout.txt',stderr:'stderr.txt',process:'process.json',roundBilling:'billing-check.json'}))candidates[key]=path.join(dir,`round-${round.number}`,file);
  const logs=Object.fromEntries(Object.entries(candidates).filter(([key,file])=>existsSync(file)||(planned&&['halt','haltJson'].includes(key))));
  const reason=s.reason?.trim()&&s.reason!=='STOPPED'?s.reason:fallback[s.status]!;
  return {runId:s.id,status:s.status,reason,reviewer:s.reviewer,round:reviewCount(s),totalReviews:s.rounds.length,cycleNumber:s.cycle?.number??1,limits:{maxRounds:s.maxRounds,stallLimit:s.stallLimit,timeoutSeconds:s.timeoutMs/1000},billingReasons:s.status==='BLOCKED'&&s.billing?.status==='BLOCKED'?s.billing.reasons:[],reviewerSummary:round?.review?.summary,decisionWarnings:round?.decision?.warnings??[],nextAction:next[s.status]!,logs};
}
export function haltText(report:HaltReport):string {
  // Quote free text so newlines inside reviewer/user content cannot forge log fields.
  return [`run: ${report.runId}`,`status: ${report.status}`,`reason: ${JSON.stringify(report.reason)}`,`reviewer: ${report.reviewer}`,`round: ${report.round}/${report.limits.maxRounds}`,`totalReviews: ${report.totalReviews}`,`cycle: ${report.cycleNumber}`,`limits: ${JSON.stringify(report.limits)}`,`billingReasons: ${JSON.stringify(report.billingReasons)}`,`reviewerSummary: ${JSON.stringify(report.reviewerSummary??null)}`,`decisionWarnings: ${JSON.stringify(report.decisionWarnings)}`,`nextAction: ${JSON.stringify(report.nextAction)}`,...Object.entries(report.logs).map(([key,file])=>`${key}: ${JSON.stringify(file)}`),''].join('\n');
}
export async function stopReason(dir:string):Promise<string> {
  try {
    const text=await readFile(path.join(dir,'STOP'),'utf8');
    try {const request=JSON.parse(text);if(typeof request.reason==='string'&&request.reason.trim())return request.reason.trim().slice(0,2000);}catch{}
    return text.trim().slice(0,2000)||'停止マーカーを検出しました。';
  }catch{return '停止マーカーを検出しましたが、詳細理由を読み取れませんでした。';}
}
