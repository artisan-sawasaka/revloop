import type { QuotaUsage } from './quota-usage.js';
import type { TokenUsage } from './token-usage.js';
import type { BillingReport } from './billing.js';
import type { ReviewerSettings } from './settings.js';
export type Provider = 'claude' | 'codex';
export type Status = 'READY' | 'REVIEWING' | 'NEEDS_FIX' | 'PASS' | 'BLOCKED' | 'MAX_ROUNDS' | 'STALLED' | 'STOPPED' | 'ERROR';
export interface Finding { severity: 'P0' | 'P1' | 'P2' | 'P3'; file: string; line: number; message: string; fix: string }
export interface VisualResult {status:'REVIEWED'|'NOT_RUN';observations:{file:string;observation:string}[]}
export interface Review { verdict: 'PASS' | 'FAIL' | 'BLOCKED'; summary: string; findings: Finding[]; notes?:string[]; visual?:VisualResult }
export interface ReviewDecision {reportedVerdict:Review['verdict'];effectiveVerdict:Review['verdict'];warnings:string[]}
export interface Round { quotaUsage?:QuotaUsage; tokenUsage?:TokenUsage; number: number; fingerprint: string; findingKey?: string; review?: Review; decision?:ReviewDecision; sessionId?: string; error?: string; startedAt: string; finishedAt?: string; reviewerSettings?: ReviewerSettings; reviewerPlan?:string; visualReview?:{status:'REVIEWED'|'NOT_RUN';images:string[];reason?:string} }
export interface State {
  version: 1; id: string; root: string; source: Provider; reviewer: Provider;
  sourceSession?: string; title: string; reviewerSession?: string;
  status: Status; maxRounds: number; stallLimit: number; timeoutMs: number;
  files: string[]; context: string; createdAt: string; rounds: Round[];
  warning?: string; reason?: string; reviewerCwd: string; billing?: BillingReport;
  reviewerSettings?: ReviewerSettings;
  reviewerPlan?:string;
  roundLogFile?:string;
  roundLogError?:string;
  visualRequired?:boolean;
  stopPending?:boolean;
  resumeAttempt?:{at:string;directory:string};
  cycle?:{number:number;startRound:number;startedAt:string;archiveDirectory:string};
}
export const reviewCount = (s:State) => s.rounds.length-(s.cycle?.startRound??0);
export const terminal = (s: Status) => !['READY', 'REVIEWING', 'NEEDS_FIX'].includes(s);
export const reviewSchema = {
  type: 'object', additionalProperties: false, required: ['verdict', 'summary', 'findings', 'notes'],
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'FAIL', 'BLOCKED'] }, summary: { type: 'string' },
    notes:{type:'array',items:{type:'string'}},
    findings: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['severity', 'file', 'line', 'message', 'fix'], properties: {
        severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] }, file: { type: 'string' },
        line: { type: 'integer', minimum: 0 }, message: { type: 'string' }, fix: { type: 'string' }
      } } }
  }
};
export const visualReviewSchema={...reviewSchema,required:[...reviewSchema.required,'visual'],properties:{...reviewSchema.properties,visual:{type:'object',additionalProperties:false,required:['status','observations'],properties:{status:{type:'string',enum:['REVIEWED','NOT_RUN']},observations:{type:'array',items:{type:'object',additionalProperties:false,required:['file','observation'],properties:{file:{type:'string'},observation:{type:'string'}}}}}}}};
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
export function parseReview(value: unknown,requireVisual=false): Review {
  if (typeof value === 'string') value = JSON.parse(value);
  if (!record(value))throw new Error('Invalid review object');
  const expected=['findings','summary','verdict',...(requireVisual?['visual']:[]),...('notes' in value?['notes']:[])].sort().join();
  if (Object.keys(value).sort().join() !== expected ||
      !['PASS', 'FAIL', 'BLOCKED'].includes(String(value.verdict)) || typeof value.summary !== 'string' || !value.summary.trim() || !Array.isArray(value.findings)) throw new Error('Invalid review object');
  for (const f of value.findings) {
    if (!record(f) || Object.keys(f).sort().join() !== 'file,fix,line,message,severity' ||
        !['P0','P1','P2','P3'].includes(String(f.severity)) || typeof f.file !== 'string' || typeof f.message !== 'string' || !f.message.trim() || typeof f.fix !== 'string' || !Number.isInteger(f.line) || Number(f.line) < 0) throw new Error('Invalid finding');
  }
  // Older saved responses lack notes. Preserve their contents and assess contradictory verdicts separately.
  if('notes' in value&&(!Array.isArray(value.notes)||!value.notes.every(n=>typeof n==='string'&&n.trim())))throw new Error('Invalid review notes');
  if(requireVisual) {
    const visual=value.visual;
    if(!record(visual)||Object.keys(visual).sort().join()!=='observations,status'||!['REVIEWED','NOT_RUN'].includes(String(visual.status))||!Array.isArray(visual.observations))throw Error('Invalid visual review result');
    for(const item of visual.observations)if(!record(item)||Object.keys(item).sort().join()!=='file,observation'||typeof item.file!=='string'||typeof item.observation!=='string'||!item.observation.trim())throw Error('Invalid visual observation');
  }
  return value as unknown as Review;
}
export function assessReview(review:Review):ReviewDecision {
  const decision:ReviewDecision={reportedVerdict:review.verdict,effectiveVerdict:review.verdict,warnings:[]};
  if(review.verdict==='PASS'&&review.findings.length){
    decision.effectiveVerdict='FAIL';
    decision.warnings.push('PASS_WITH_REQUIRED_FINDINGS: required findings remain; treated as FAIL for repair, not an execution ERROR. Non-blocking suggestions belong in notes.');
  } else if(review.verdict==='FAIL'&&!review.findings.length){
    decision.effectiveVerdict='BLOCKED';
    decision.warnings.push('FAIL_WITHOUT_FINDINGS: no actionable repair is supplied; clarification is required.');
  }
  return decision;
}
export function hasVisualCoverage(review:Review,files:string[]):boolean {
  if(review.visual?.status!=='REVIEWED')return false;
  const observed=review.visual.observations.map(o=>o.file);
  return observed.length===files.length&&new Set(observed).size===files.length&&files.every(f=>observed.includes(f))&&review.visual.observations.every(o=>o.observation.trim());
}
