#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { canonicalRoot, recover, saveBillingDiagnostic } from './storage.js';
import { doctor } from './providers.js';
import { checkBilling } from './billing.js';
import { confirmCodexAutoReloadOff, revokeCodexConfirmation } from './billing-confirmation.js';
import { install } from './install.js';
import { review, start, status, stop } from './engine.js';
import { resume } from './resume.js';
import { restart, RestartError } from './restart.js';
import { reviewCount, type Provider, type State } from './types.js';
import { readSettings, settingsFile } from './settings.js';
import { launchSettings, startSettingsServer } from './settings-server.js';
import {buildHaltReport} from './halt.js';
import {chatLog} from './chat-log.js';
const help = `revloop 0.1.0 — Claude Code <-> Codex review loops

  doctor [--provider codex|claude]         Check selected reviewer (default: both; no inference)
  billing-check [--provider codex|claude]  Check provider policy; Claude auth only, Codex credits/quota
  confirm-codex-no-auto-reload --acknowledge-off  Record your OFF confirmation for this account (24h)
  revoke-codex-confirmation               Invalidate that confirmation (no account change)
  install [--global]                      Install project or current-user skills; never overwrite
  settings [--no-open]                    Open global reviewer settings GUI (local browser)
  config                                  Show global reviewer settings and file path
  start --source codex|claude --context FILE --title TITLE
        [--source-session ID] [--file RELATIVE_PATH ...] [--visual]
        [--max-rounds 5] [--stall-limit 2] [--timeout-seconds 300]
  review --run UUID                        Review once; the source skill repairs and repeats
                                          At MAX_ROUNDS: restart cycle only, without inference
  restart --run UUID                       Restart MAX_ROUNDS at count 0, retaining all history
  resume --run UUID                        Recheck a billing-blocked run; no inference or round reset
  status --run UUID                        Read saved status
  stop --run UUID [--reason TEXT]          Cancel reviewer and record why it stopped
  recover --run UUID                       Close an abandoned locked run as ERROR

Common: --root DIRECTORY (default cwd). install --global uses the user home and rejects --root.
All output is JSON except help.
Claude: /revloop. Codex: $revloop or /skills (not /revloop).
Exit: 0=success/PASS/NEEDS_FIX; 2=stopped/blocked/limit/stall; 1=error.
`;
async function publicState(s: State) {
  const {context, ...rest} = s;
  const halt=buildHaltReport(s);
  const checkInstruction=s.reviewer==='claude'
    ? 'Claudeのサブスク認証（claude.ai / firstParty / Pro or Max）と同一アカウントを確認してから実行します。残量と追加利用OFFは未確認です。Claude側で追加利用OFFを維持してください。/usageは呼びません。'
    : 'Mandatory billing-check precedes review. No model runs when no-credit safety is unverified.';
  const nextAction=halt?.nextAction??(s.status==='NEEDS_FIX'?`${checkInstruction} Run billing-check before repair and retain the SAME run UUID.`:s.status==='READY'?checkInstruction:'Stop. Do not start another run to bypass this result.');
  return {...rest,chatLog:await chatLog(s),reviewCount:reviewCount(s),totalReviewCount:s.rounds.length,cycleNumber:s.cycle?.number??1, reason:halt?.reason??s.reason, halt, reviewDecision:s.rounds.at(-1)?.decision, visualReview:s.rounds.at(-1)?.visualReview??{status:'NOT_RUN',images:[],reason:s.visualRequired?'Visual review has not completed':'No recorded visual review; PASS does not cover appearance'},billingPolicy:s.billing?.policy??(s.reviewer==='claude'?'subscription-auth-only':'included-subscription-only'), historyDirectory:path.join(s.root,'.revloop','runs',s.id),nextAction};
}
async function main() {
  const {values:v,positionals} = parseArgs({allowPositionals:true,strict:true,options:{root:{type:'string'},visual:{type:'boolean'},global:{type:'boolean'},'no-open':{type:'boolean'},serve:{type:'boolean'},source:{type:'string'},provider:{type:'string'},context:{type:'string'},title:{type:'string'},'source-session':{type:'string'},file:{type:'string',multiple:true},'max-rounds':{type:'string'},'stall-limit':{type:'string'},'timeout-seconds':{type:'string'},run:{type:'string'},reason:{type:'string'},'acknowledge-off':{type:'boolean'},help:{type:'boolean',short:'h'}}});
  const command = positionals[0];
  if (v.help || !command || command === 'help') { console.log(help); return; }
  if (positionals.length !== 1) throw new Error('Unexpected positional arguments');
  const allowed: Record<string,string[]> = {
    doctor:['provider'],'billing-check':['provider'],'confirm-codex-no-auto-reload':['acknowledge-off'],'revoke-codex-confirmation':[],install:['global'],settings:['no-open','serve'],config:[],start:['visual','source','context','title','source-session','file','max-rounds','stall-limit','timeout-seconds'],review:['run'],restart:['run'],resume:['run'],status:['run'],stop:['run','reason'],recover:['run']
  };
  if (!allowed[command]) throw new Error(`Unknown command: ${command}`);
  for (const key of Object.keys(v)) if (key !== 'root' && !allowed[command]!.includes(key)) throw new Error(`Option --${key} is not valid for ${command}`);
  if (v.global && v.root !== undefined) throw new Error('install --global cannot be combined with --root');
  const root = await canonicalRoot(v.global ? homedir() : v.root ?? process.cwd());
  const required = (name: keyof typeof v): string => { const value = v[name]; if (typeof value !== 'string' || !value) throw new Error(`--${name} is required`); return value; };
  let result: unknown;
  if(command==='settings') {
    if(v.serve) {const gui=await startSettingsServer(root);if(process.send)process.send({url:gui.url});else console.log(JSON.stringify({url:gui.url}));return;}
    result=await launchSettings(fileURLToPath(import.meta.url),root,!v['no-open']);
  } else if(command==='config') result={path:settingsFile(),settings:await readSettings()};
  else if (command === 'doctor' || command === 'billing-check') {
    if (v.provider !== undefined && !['codex','claude'].includes(v.provider)) throw new Error('--provider must be codex or claude');
    const checks = [];
    const providers: Provider[] = v.provider ? [v.provider as Provider] : ['codex','claude'];
    for (const provider of providers) {
      if (command === 'billing-check') {
        const check=await checkBilling(provider,root);
        if(!check.modelExecutionAllowed){
          process.exitCode=2;
          try{checks.push({...check,...await saveBillingDiagnostic(root,check)});}
          catch(e){checks.push({...check,reason:check.reasons.join('; '),logError:`診断ログを保存できませんでした: ${(e as Error).message}`});}
        }else checks.push(check);
      }
      else { try { checks.push({...await doctor(provider,root),billingSafety:'NOT_VERIFIED: auth success does not authorize model execution'}); } catch(e) { checks.push({provider,error:(e as Error).message}); process.exitCode=1; } }
    }
    result = checks;
  } else if(command==='confirm-codex-no-auto-reload') {
    if(v['acknowledge-off']!==true)throw new Error('Explicit --acknowledge-off is required after the user confirms auto-reload is OFF');
    result=await confirmCodexAutoReloadOff(root);
  } else if(command==='revoke-codex-confirmation') {await revokeCodexConfirmation();result={revoked:true};}
  else if (command === 'install') result = {scope:v.global?'user':'project',installed:await install(root,fileURLToPath(import.meta.url)),codex:'Use the revloop skill in the current project chat; CLI: $revloop',claude:'/revloop'};
  else if (command === 'stop') {
    const stopped=await stop(root,required('run'),v.reason);
    result={...stopped,chatLog:await chatLog(await status(root,required('run')))};
  }
  else {
    const s = command === 'start' ? await start(root,{
      source:required('source') as Provider,context:await readFile(path.resolve(root,required('context')),'utf8'),title:required('title'),sourceSession:v['source-session'],files:v.file,visual:v.visual,
      maxRounds:v['max-rounds']===undefined?undefined:Number(v['max-rounds']),stallLimit:v['stall-limit']===undefined?undefined:Number(v['stall-limit']),timeoutMs:v['timeout-seconds']===undefined?undefined:Number(v['timeout-seconds'])*1000
    }) : command === 'review' ? ((await status(root,required('run'))).status==='MAX_ROUNDS' ? await restart(root,required('run')) : await review(root,required('run'))) : command === 'restart' ? await restart(root,required('run')) : command === 'resume' ? await resume(root,required('run')) : command === 'recover' ? await recover(root,required('run')) : await status(root,required('run'));
    result=await publicState(s);
    if (s.status==='ERROR') process.exitCode=1;
    else if (['BLOCKED','MAX_ROUNDS','STALLED','STOPPED'].includes(s.status)) process.exitCode=2;
  }
  console.log(JSON.stringify(result,null,2));
}
main().catch(e => {if(process.send)process.send({error:(e as Error).message});if(e instanceof RestartError){console.log(JSON.stringify(e.diagnostic,null,2));process.exitCode=2;}else {console.error(JSON.stringify({status:'ERROR',error:(e as Error).message}));process.exitCode=1;}});
