import { codexMetadata } from './codex-rpc.js';
import { subscriptionEnv } from './process.js';
import { readClaudeSubscription, CLAUDE_USAGE_VERSION, claudeSubscriptionPlans, ClaudeAuthError } from './claude-usage.js';
import { codexFingerprint, loadConfirmation, validConfirmation } from './billing-confirmation.js';
import type { Provider } from './types.js';

export interface BillingReport {
  policy: 'included-subscription-only'|'subscription-auth-only'; provider: Provider; checkedAt: string;
  status: 'ALLOW' | 'BLOCKED'; modelExecutionAllowed: boolean;
  accountFingerprint: string | null; plan: string | null; model: 'opus' | 'sonnet' | 'fable' | null;
  evidence: string[]; confirmationExpiresAt?: string;
  reasons: string[];
  warnings?:string[];
  observations: { quotaUsedPercent: number[]; creditBalance: string | null; hasCredits: boolean | null; autoReloadEnabled: boolean | null; paidUsageDisabled: boolean | null };
}
const object = (v: unknown): v is Record<string,unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const supportedPlans = ['free','plus','pro','prolite'];
export function assessBilling(provider: Provider, raw?: unknown, confirmation?: unknown, now=Date.now()): BillingReport {
  const r: BillingReport = {policy:'included-subscription-only',provider,checkedAt:new Date(now).toISOString(),status:'BLOCKED',modelExecutionAllowed:false,accountFingerprint:null,plan:null,model:null,evidence:[],reasons:[],observations:{quotaUsedPercent:[],creditBalance:null,hasCredits:null,autoReloadEnabled:null,paidUsageDisabled:null}};
  if(provider==='claude') {
    if(!object(raw)||raw.evidence!=='claude-usage-tty'||raw.version!==CLAUDE_USAGE_VERSION||raw.plan!=='max'||raw.model!=='opus'||typeof raw.accountFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(raw.accountFingerprint))r.reasons.push('CLAUDE_DIAGNOSTIC_UNVERIFIED');
    else {
      r.accountFingerprint=raw.accountFingerprint;r.plan='max';r.model='opus';r.evidence.push('claude-auth-status','claude-usage-tty');
      const at=typeof raw.checkedAt==='string'?Date.parse(raw.checkedAt):NaN;
      if(!Number.isFinite(at)||at>now||now-at>30_000)r.reasons.push('STALE_USAGE_READING');
      if(raw.usageCreditsOff!==true)r.reasons.push('CLAUDE_USAGE_CREDITS_NOT_OFF');
      else r.observations.paidUsageDisabled=true;
      if(!Array.isArray(raw.quotaUsedPercent)||raw.quotaUsedPercent.length!==2)r.reasons.push('INCLUDED_QUOTA_UNKNOWN');
      else for(const n of raw.quotaUsedPercent){
        if(typeof n!=='number'||!Number.isFinite(n)||n<0||n>100)r.reasons.push('INVALID_QUOTA_WINDOW');
        else {r.observations.quotaUsedPercent.push(n);if(n>=100)r.reasons.push('INCLUDED_QUOTA_EXHAUSTED');}
      }
    }
  } else if(provider==='codex') {
    if(!object(raw)){r.reasons.push('USAGE_STATUS_UNAVAILABLE');return r;}
    r.accountFingerprint=codexFingerprint(raw.accountId);
    if(!r.accountFingerprint)r.reasons.push('ACCOUNT_IDENTITY_UNKNOWN');
    if(raw.authType!=='chatgpt'||typeof raw.authenticatedPlan!=='string'||!supportedPlans.includes(raw.authenticatedPlan))r.reasons.push('SUPPORTED_SUBSCRIPTION_AUTH_REQUIRED');
    else {r.plan=raw.authenticatedPlan;r.evidence.push('codex-account-read','codex-rate-limits');}
    if(!validConfirmation(confirmation,r.accountFingerprint,now))r.reasons.push('AUTO_RELOAD_OFF_CONFIRMATION_REQUIRED: user confirmation is missing, expired, or for another account');
    else {r.observations.autoReloadEnabled=false;r.confirmationExpiresAt=confirmation.expiresAt;r.evidence.push('user-confirmed-auto-reload-off');}
    let buckets: unknown[]=[];
    if(raw.rateLimitsByLimitId!==undefined&&raw.rateLimitsByLimitId!==null){
      if(object(raw.rateLimitsByLimitId)&&object(raw.rateLimitsByLimitId.codex))buckets=Object.values(raw.rateLimitsByLimitId);
    } else if(object(raw.rateLimits)&&raw.rateLimits.limitId==='codex')buckets=[raw.rateLimits];
    if(!buckets.length)r.reasons.push('USAGE_STATUS_UNAVAILABLE');
    let allCreditsZero=buckets.length>0;
    for(const bucket of buckets){
      if(!object(bucket)){r.reasons.push('INVALID_USAGE_STATUS');allCreditsZero=false;continue;}
      if(bucket.planType!==undefined&&bucket.planType!==null&&bucket.planType!==r.plan)r.reasons.push('PLAN_MISMATCH');
      let windows=0;
      for(const key of ['primary','secondary']){
        const w=bucket[key];if(w===null||w===undefined)continue;
        if(!object(w)||typeof w.usedPercent!=='number'||!Number.isFinite(w.usedPercent)||w.usedPercent<0||w.usedPercent>100||typeof w.resetsAt!=='number'||w.resetsAt*1000<=now){r.reasons.push('INVALID_OR_EXPIRED_QUOTA_WINDOW');continue;}
        windows++;r.observations.quotaUsedPercent.push(w.usedPercent);if(w.usedPercent>=100)r.reasons.push('INCLUDED_QUOTA_EXHAUSTED');
      }
      if(!windows)r.reasons.push('INCLUDED_QUOTA_UNKNOWN');
      const credits=bucket.credits;
      if(!object(credits)||typeof credits.hasCredits!=='boolean'||typeof credits.unlimited!=='boolean'||typeof credits.balance!=='string'||!/^\d+(?:\.\d+)?$/.test(credits.balance)){r.reasons.push('CREDIT_STATUS_UNKNOWN');allCreditsZero=false;}
      else {r.observations.hasCredits=credits.hasCredits;r.observations.creditBalance=credits.balance;if(credits.hasCredits||credits.unlimited||Number(credits.balance)!==0){r.reasons.push('CREDITS_AVAILABLE');allCreditsZero=false;}}
      if(bucket.rateLimitReachedType!==null||bucket.spendControlReached!==false)r.reasons.push('PROVIDER_LIMIT_REACHED_OR_UNKNOWN');
    }
    if(allCreditsZero&&r.observations.autoReloadEnabled===false)r.observations.paidUsageDisabled=true;
  } else throw Error('Unknown billing provider');
  r.reasons=[...new Set(r.reasons)];r.modelExecutionAllowed=r.reasons.length===0;r.status=r.modelExecutionAllowed?'ALLOW':'BLOCKED';return r;
}
export function assessClaudeSubscription(raw?:unknown,now=Date.now()):BillingReport {
  // The former usage-screen evaluator remains for historical evidence; new reviews use auth only.
  const r=assessBilling('claude',undefined,undefined,now);
  r.policy='subscription-auth-only';r.reasons=[];
  r.warnings=['CLAUDE_USAGE_NOT_CHECKED','EXTRA_USAGE_OFF_MUST_BE_MAINTAINED_IN_CLAUDE_SETTINGS'];
  if(!object(raw)||raw.evidence!=='claude-auth-status'||!claudeSubscriptionPlans.includes(raw.plan as 'pro'|'max')||raw.model!=='opus'||typeof raw.accountFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(raw.accountFingerprint))r.reasons.push('CLAUDE_SUBSCRIPTION_AUTH_UNVERIFIED');
  else {
    r.accountFingerprint=raw.accountFingerprint;r.plan=raw.plan as 'pro'|'max';r.model='opus';r.evidence=['claude-auth-status'];
    const at=typeof raw.checkedAt==='string'?Date.parse(raw.checkedAt):NaN;
    if(!Number.isFinite(at)||at>now||now-at>30_000)r.reasons.push('STALE_AUTH_READING');
  }
  r.modelExecutionAllowed=r.reasons.length===0;r.status=r.modelExecutionAllowed?'ALLOW':'BLOCKED';
  // Quota and paidUsageDisabled intentionally remain unknown, never asserted from subscription auth.
  return r;
}
export async function checkBilling(provider: Provider, cwd: string, stopFile?: string): Promise<BillingReport> {
  try {
    subscriptionEnv(provider);
    if(provider==='claude')return assessClaudeSubscription(await readClaudeSubscription(cwd,stopFile));
    const auth=await codexMetadata('account/read',{refreshToken:false},cwd,stopFile) as {account?:{type?:unknown;planType?:unknown}};
    const usage=await codexMetadata('account/rateLimits/read',undefined,cwd,stopFile);
    return assessBilling(provider,{...(object(usage)?usage:{}),authType:auth.account?.type,authenticatedPlan:auth.account?.planType},await loadConfirmation());
  } catch(e) {
    if(e instanceof Error&&e.message==='STOPPED')throw e;
    const r=provider==='claude'?assessClaudeSubscription():assessBilling(provider);r.reasons.unshift('BILLING_PROBE_FAILED');
    if(e instanceof ClaudeAuthError)r.reasons.push(...e.reasons);
    if(e instanceof Error&&/^(Unsupported Claude|Claude \/usage|Claude Max|Claude account|Subscription-only mode)/.test(e.message))r.reasons.push(e.message);
    return r;
  }
}
export class BillingSafetyError extends Error {
  constructor(readonly report: BillingReport) { super(`${report.policy==='subscription-auth-only'?'Subscription authentication':'Paid-credit safety'} unverified for ${report.provider}; model execution blocked. ${report.reasons.join(' ')}`); }
}
export async function requireIncludedBilling(provider: Provider,cwd: string,stopFile?:string): Promise<BillingReport> {
  const report=await checkBilling(provider,cwd,stopFile);if(!report.modelExecutionAllowed)throw new BillingSafetyError(report);return report;
}
export function requireSameAccount(previous: BillingReport | undefined,current: BillingReport): void {
  if(previous?.modelExecutionAllowed&&previous.accountFingerprint!==current.accountFingerprint)throw new BillingSafetyError({...current,status:'BLOCKED',modelExecutionAllowed:false,reasons:['ACCOUNT_CHANGED_DURING_RUN']});
}
