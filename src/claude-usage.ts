import * as pty from 'node-pty';
import xterm from '@xterm/headless';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { checkProcess, resolveCommand, runProcess, subscriptionEnv } from './process.js';

export const CLAUDE_USAGE_VERSION = '2.1.302';
export const claudeSubscriptionPlans=['pro','max'] as const;
export class ClaudeAuthError extends Error {
  constructor(readonly reasons:string[]) { super(`Claude subscription authentication rejected: ${reasons.join(', ')}`); }
}
export function parseClaudeAuthStatus(value:unknown):{plan:'pro'|'max';accountFingerprint:string} {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new ClaudeAuthError(['CLAUDE_AUTH_RESPONSE_INVALID']);
  const a=value as Record<string,unknown>,reasons:string[]=[];
  if(a.loggedIn!==true)reasons.push('CLAUDE_AUTH_NOT_LOGGED_IN');
  if(a.authMethod!=='claude.ai')reasons.push('CLAUDE_AUTH_METHOD_NOT_SUBSCRIPTION');
  if(a.apiProvider!=='firstParty')reasons.push('CLAUDE_API_PROVIDER_NOT_FIRST_PARTY');
  if(!claudeSubscriptionPlans.includes(a.subscriptionType as 'pro'|'max'))reasons.push('CLAUDE_SUBSCRIPTION_PLAN_UNSUPPORTED');
  if(typeof a.email!=='string'||!a.email.trim()||typeof a.orgId!=='string'||!a.orgId.trim())reasons.push('CLAUDE_ACCOUNT_IDENTITY_MISSING');
  if(reasons.length)throw new ClaudeAuthError(reasons);
  return {plan:a.subscriptionType as 'pro'|'max',accountFingerprint:createHash('sha256').update((a.email as string).toLowerCase()+'\0'+a.orgId).digest('hex')};
}
export interface ClaudeUsage {
  version: string; accountFingerprint: string; plan: 'max'; model: 'opus';
  usageCreditsOff: boolean; quotaUsedPercent: number[]; checkedAt: string;
  evidence: 'claude-usage-tty';
}
export function claudeEnv(): NodeJS.ProcessEnv {
  return {...subscriptionEnv('claude'), CLAUDE_CODE_DISABLE_FAST_MODE:'1', CLAUDE_CODE_DISABLE_TERMINAL_TITLE:'1'};
}
/** Accept the rendered current screen only, never search the raw ANSI history. */
export function parseClaudeUsageScreen(screen: string): {usageCreditsOff: boolean; quotaUsedPercent: number[]} | null {
  if (/Refreshing|Loading|Showing last.known usage|usage endpoint is rate limited|could not|failed to|error|sign in|log in|Permission Required|Enter y\/n/i.test(screen)) return null;
  if (!/Total duration \(API\):\s*0s/.test(screen) || !/Usage:\s*0 input, 0 output, 0 cache read, 0 cache write/.test(screen)) return null;
  if (!/Usage credits are off\b/.test(screen) || /Now using credits|Usage credits are on|Usage credits.*(?:enabled|Unlimited)/i.test(screen)) return null;
  const readWindow = (label: string) => {
    const escaped=label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const matches=[...screen.matchAll(new RegExp(`^${escaped}\\s*\\n([^\\n]*)\\nResets [^\\n]+`,'gm'))];
    if(matches.length!==1)return null;
    const percentages=[...matches[0]![1]!.matchAll(/(\d+(?:\.\d+)?)%/g)].map(m=>Number(m[1]));
    if(!percentages.length||percentages.some(n=>!Number.isFinite(n)||n<0||n>100||n!==percentages[0]))return null;
    return percentages[0]!;
  };
  const session=readWindow('Current session'),week=readWindow('Current week (all models)');
  if(session===null||week===null)return null;
  return {usageCreditsOff:true,quotaUsedPercent:[session,week]};
}
async function auth(cwd: string, stopFile?: string) {
  const result=await runProcess(resolveCommand('claude'),['auth','status'],{cwd,env:claudeEnv(),stopFile});
  if(result.failure==='STOPPED')throw Error('STOPPED');
  if(result.failure||result.code!==0)throw new ClaudeAuthError(['CLAUDE_AUTH_PROCESS_FAILED']);
  let value:unknown;
  try{value=JSON.parse(result.stdout);}catch{throw new ClaudeAuthError(['CLAUDE_AUTH_RESPONSE_INVALID']);}
  return parseClaudeAuthStatus(value);
}
export async function readClaudeSubscription(cwd:string,stopFile?:string) {
  const {accountFingerprint,plan}=await auth(cwd,stopFile);
  return {evidence:'claude-auth-status',plan,model:'opus',accountFingerprint,checkedAt:new Date().toISOString()};
}
export async function readClaudeUsage(cwd: string, stopFile?: string): Promise<ClaudeUsage> {
  const cmd=resolveCommand('claude'),env=claudeEnv();
  const version=await runProcess(cmd,['--version'],{cwd,env,stopFile});checkProcess(version);
  if(version.stdout.trim()!==`${CLAUDE_USAGE_VERSION} (Claude Code)`)throw Error('Unsupported Claude usage-screen version; revalidate the parser before updating the allowlist');
  const authenticated=await auth(cwd,stopFile);
  if(authenticated.plan!=='max')throw Error('Unsupported Claude usage-screen plan; historical usage diagnostics require Max');
  const {accountFingerprint}=authenticated;
  const usage=await new Promise<{usageCreditsOff:boolean;quotaUsedPercent:number[]}>((resolve,reject)=>{
    const terminal=new xterm.Terminal({cols:160,rows:100,scrollback:0,allowProposedApi:true});
    let child: pty.IPty | undefined, sent=false, finished=false, bytes=0, lastChange=Date.now(),screen='';
    const finish=(error?:Error,result?:{usageCreditsOff:boolean;quotaUsedPercent:number[]})=>{
      if(finished)return;finished=true;clearTimeout(timeout);clearInterval(poll);process.off('SIGINT',cancel);process.off('SIGTERM',cancel);
      try{child?.kill();}catch{} terminal.dispose(); error?reject(error):resolve(result!);
    };
    const cancel=()=>finish(Error('STOPPED'));
    const timeout=setTimeout(()=>finish(Error('Claude /usage could not be verified before timeout')),45_000);
    const poll=setInterval(()=>{
      if(stopFile&&existsSync(stopFile))return cancel();
      if(/Permission Required: Accessing workspace|Enter y\/n:/.test(screen))return finish(Error('Claude /usage requires an already trusted launch directory'));
      if(!sent&&screen.includes(`Claude Code v${CLAUDE_USAGE_VERSION}`)&&/^\$\s*$/m.test(screen)){
        sent=true;lastChange=Date.now();child!.write('/usage\r');return;
      }
      if(sent&&Date.now()-lastChange>=1000){const result=parseClaudeUsageScreen(screen);if(result)finish(undefined,result);}
    },200);
    process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
    try {
      child=pty.spawn(cmd.executable,[...cmd.prefix,'--safe-mode','--strict-mcp-config','--tools','','--permission-mode','dontAsk','--ax-screen-reader','--model','opus'],{name:'xterm-256color',cols:160,rows:100,cwd,env:Object.fromEntries(Object.entries(env).filter((e):e is [string,string]=>typeof e[1]==='string')),useConpty:true});
      terminal.onData(data=>{if(!finished)child!.write(data);});
      child.onData(data=>{
        if(finished)return;bytes+=Buffer.byteLength(data);if(bytes>2_000_000)return finish(Error('Usage diagnostic output limit'));
        terminal.write(data,()=>{
          if(finished)return;let current='';const b=terminal.buffer.active;for(let i=b.baseY;i<b.baseY+terminal.rows;i++)current+=(b.getLine(i)?.translateToString(true)??'')+'\n';
          if(current!==screen){screen=current;lastChange=Date.now();}
        });
      });
      child.onExit(()=>{if(!finished)finish(Error('Claude usage diagnostic exited without a verified reading'));});
    } catch(e) {finish(e as Error);}
  });
  const current=await auth(cwd,stopFile);
  if(current.accountFingerprint!==accountFingerprint||current.plan!=='max')throw Error('Claude account changed during billing check');
  return {...usage,version:CLAUDE_USAGE_VERSION,accountFingerprint,plan:'max',model:'opus',checkedAt:new Date().toISOString(),evidence:'claude-usage-tty'};
}
