import { readFile, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { atomicJson, safeDir } from './storage.js';
import { codexMetadata } from './codex-rpc.js';
import type { Provider } from './types.js';
import { profilePlans, requirePlanModel, requireCliPlan } from './plans.js';

export const efforts = ['low','medium','high','xhigh','max'] as const;
export const codexModelOptions = [{model:'gpt-6-astra',label:'Astra 6'},{model:'gpt-6.1-sol',label:'Sol 6.1'},{model:'gpt-6-luna',label:'Luna 6'},{model:'gpt-6.1-terra',label:'Terra 6.1'}] as const;
export const claudeModelOptions = [{model:'opus',label:'Opus 5.5'},{model:'sonnet',label:'Sonnet 5.5'},{model:'fable',label:'Fable 5.1'}] as const;
export type Effort = typeof efforts[number];
export interface ReviewerSettings { model: string; effort: Effort; fast?:boolean }
export interface LoopSettings { maxRounds: number; stallLimit: number; timeoutSeconds: number }
export interface Settings { version: 7; planProfiles:Record<Provider,Record<string,ReviewerSettings>>; loop: LoopSettings; logging: { enabled: boolean; chatEnabled: boolean } }
export interface ModelChoice { model: string; label: string; efforts: Effort[]; imageInput?:boolean; fast?:boolean }
export const settingsFile = () => path.join(os.homedir(), '.revloop', 'settings.json');
export const loopDefaults = (): LoopSettings => ({maxRounds:5,stallLimit:2,timeoutSeconds:300});
export const defaultProfiles = ():Settings['planProfiles'] => ({
  codex:{free:{model:'gpt-6-luna',effort:'medium',fast:false},plus:{model:'gpt-6.1-sol',effort:'medium',fast:false},pro:{model:'gpt-6-astra',effort:'medium',fast:false}},
  claude:{free:{model:'sonnet',effort:'medium',fast:false},pro:{model:'opus',effort:'medium',fast:false},max:{model:'opus',effort:'medium',fast:false}}
});
export const defaults = (): Settings => ({version:7,planProfiles:defaultProfiles(),loop:loopDefaults(),logging:{enabled:true,chatEnabled:true}});
function object(v: unknown): v is Record<string, unknown> { return !!v && typeof v === 'object' && !Array.isArray(v); }
function keys(v: Record<string,unknown>, expected: string[]) { if (Object.keys(v).length !== expected.length || expected.some(k=>!(k in v))) throw Error('Unknown or missing settings field'); }
export function validateReviewer(provider: Provider, value: unknown): ReviewerSettings {
  if (!object(value)) throw Error('Reviewer settings must be an object');
  keys(value,'fast' in value?['model','effort','fast']:['model','effort']);
  if('fast' in value&&typeof value.fast!=='boolean')throw Error('Invalid fast: boolean required');
  if(provider==='claude'&&value.fast===true)throw Error('Claude Fast requires paid usage credits and is blocked by the billing guard');
  if (typeof value.model !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,79}$/.test(value.model)) throw Error('Invalid model identifier');
  if (!efforts.includes(value.effort as Effort)) throw Error('Unsupported reasoning effort');
  if (provider === 'codex' && !codexModelOptions.some(m=>m.model===value.model)) throw Error('Codex model must be Sol, Astra, Terra or Luna');
  if (provider === 'claude' && !claudeModelOptions.some(m=>m.model===value.model)) throw Error('Claude model must be Opus, Fable or Sonnet');
  return {model:value.model,effort:value.effort as Effort,...('fast' in value?{fast:value.fast as boolean}:{})};
}
export function validateSettings(value: unknown): Settings {
  if (!object(value)) throw Error('Settings must be an object');
  if (value.version !== 7) throw Error('Unsupported settings version. Reopen the settings GUI.');
  keys(value,['version','loop','logging','planProfiles']);
  if(!object(value.planProfiles))throw Error('Plan profiles must be an object');
  keys(value.planProfiles,['codex','claude']);
  const planProfiles=defaultProfiles();
  for(const provider of ['codex','claude'] as const){
    const profiles=value.planProfiles[provider];
    if(!object(profiles))throw Error('Plan profiles must be an object');
    keys(profiles,[...profilePlans[provider]]);
    for(const plan of profilePlans[provider]){
      const profile=validateReviewer(provider,profiles[plan]);
      requirePlanModel(provider,plan,profile.model,profile.fast===true);
      planProfiles[provider][plan]=profile;
    }
  }
  if (!object(value.logging)) throw Error('Logging settings must be an object');
  keys(value.logging,['enabled','chatEnabled']);
  if (typeof value.logging.enabled !== 'boolean') throw Error('Invalid logging.enabled: boolean required');
  if (typeof value.logging.chatEnabled !== 'boolean') throw Error('Invalid logging.chatEnabled: boolean required');
  if (!object(value.loop)) throw Error('Loop settings must be an object');
  keys(value.loop,['maxRounds','stallLimit','timeoutSeconds']);
  for (const [name,min,max] of [['maxRounds',1,50],['stallLimit',1,10],['timeoutSeconds',1,3600]] as const) {
    const n=value.loop[name];
    if (typeof n!=='number'||!Number.isInteger(n)||n<min||n>max) throw Error(`Invalid ${name}: integer ${min}..${max} required`);
  }
  return {version:7,planProfiles,loop:{maxRounds:value.loop.maxRounds as number,stallLimit:value.loop.stallLimit as number,timeoutSeconds:value.loop.timeoutSeconds as number},logging:{enabled:value.logging.enabled,chatEnabled:value.logging.chatEnabled}};
}
export function selectReviewerSettings(settings:Settings,provider:Provider,plan:unknown):ReviewerSettings {
  const key=requireCliPlan(provider,plan);
  const selected=validateReviewer(provider,settings.planProfiles[provider][key]);
  requirePlanModel(provider,key,selected.model,selected.fast===true);
  return selected;
}
export const revisionOf = (s: Settings) => createHash('sha256').update(JSON.stringify(s)).digest('hex');
export async function readSettings(file=settingsFile()): Promise<Settings> {
  let text: string;
  try { text=await readFile(file,'utf8'); } catch(e) { if ((e as NodeJS.ErrnoException).code==='ENOENT') return defaults(); throw e; }
  if (Buffer.byteLength(text)>16_384) throw Error('Settings file is too large');
  let value:unknown=JSON.parse(text);
  // Validate legacy fields too; migrate in memory without changing the saved file.
  // Old GUI clients cannot overwrite the new settings through saveSettings.
  if (object(value)&&value.version===1) {
    keys(value,['version','codex','claude']);
    value={...value,version:4,loop:loopDefaults(),logging:defaults().logging};
  }
  if (object(value)&&value.version===2) {
    keys(value,['version','codex','claude','loop']);
    value={...value,version:4,logging:defaults().logging};
  }
  if (object(value)&&value.version===3) {
    keys(value,['version','codex','claude','loop','logging']);
    if (!object(value.logging)) throw Error('Logging settings must be an object');
    keys(value.logging,['enabled']);
    value={...value,version:4,logging:{...value.logging,chatEnabled:true}};
  }
  if(object(value)&&value.version===4){
    keys(value,['version','codex','claude','loop','logging']);
    value={...value,version:5,planProfiles:{codex:{plus:null,pro:null},claude:{pro:null,max:null}}};
  }
  if(object(value)&&(value.version===5||value.version===6)) {
    keys(value,['version','codex','claude','loop','logging','planProfiles']);
    const old=value, profiles=defaultProfiles();
    if(!object(old.planProfiles))throw Error('Invalid legacy profiles');
    keys(old.planProfiles,['codex','claude']);
    for(const provider of ['codex','claude'] as const){
      const base=validateReviewer(provider,old[provider]), existing=old.planProfiles[provider];
      if(!object(existing))throw Error('Invalid legacy profiles');
      keys(existing,provider==='codex'?['plus','pro']:['pro','max']);
      for(const plan of Object.keys(existing))profiles[provider][plan]=existing[plan]===null?{...base}:validateReviewer(provider,existing[plan]);
    }
    value={version:7,planProfiles:profiles,loop:old.loop,logging:old.logging};
  }
  return validateSettings(value); // Invalid files never silently revert to defaults.
}
export async function saveSettings(value: unknown, expectedRevision: string, file=settingsFile()): Promise<Settings> {
  const settings=validateSettings(value), dir=path.dirname(file);
  await safeDir(dir);
  const lockFile=file+'.lock', handle=await open(lockFile,'wx');
  try {
    if (revisionOf(await readSettings(file))!==expectedRevision) throw Error('Settings changed elsewhere. Reload before saving.');
    await atomicJson(file,settings);
    return settings;
  } finally { await handle.close(); await unlink(lockFile); }
}
export async function codexModels(cwd: string, stopFile?: string): Promise<ModelChoice[]> {
  const result: ModelChoice[]=[]; let cursor: string | undefined;
  const seen=new Set<string>();
  do {
    const raw=await codexMetadata('model/list',{includeHidden:false,...(cursor?{cursor}:{})},cwd,stopFile);
    if (!object(raw) || !Array.isArray(raw.data)) throw Error('Codex model catalog unavailable');
    for (const row of raw.data) {
      if (!object(row) || typeof row.model!=='string' || typeof row.displayName!=='string' || !Array.isArray(row.supportedReasoningEfforts)) continue;
      const advertised=row.supportedReasoningEfforts;
      const supported=efforts.filter(e=>advertised.some((item: unknown)=>object(item)&&item.reasoningEffort===e));
      const choice=codexModelOptions.find(m=>m.model===row.model);
      const fast=Array.isArray(row.additionalSpeedTiers)&&row.additionalSpeedTiers.includes('fast')||Array.isArray(row.serviceTiers)&&row.serviceTiers.some(t=>object(t)&&t.name==='Fast'&&(t.id==='priority'||t.id==='fast'));
      if (choice&&supported.length) result.push({model:choice.model,label:choice.label,efforts:supported,imageInput:Array.isArray(row.inputModalities)&&row.inputModalities.includes('image'),fast});
    }
    if (raw.nextCursor!==null && raw.nextCursor!==undefined && typeof raw.nextCursor!=='string') throw Error('Invalid model catalog cursor');
    cursor=raw.nextCursor as string | undefined;
    if (cursor) { if (seen.has(cursor)||seen.size>=20) throw Error('Model catalog pagination failed'); seen.add(cursor); }
  } while (cursor);
  if (!result.length) throw Error('No supported Codex models available');
  return result;
}
export function requireModelChoice(setting: ReviewerSettings, models: ModelChoice[]): void {
  if (!models.some(m=>m.model===setting.model&&m.efforts.includes(setting.effort))) throw Error(`Requested model/effort is unavailable: ${setting.model} / ${setting.effort}. No fallback was used.`);
  if(setting.fast===true&&!models.some(m=>m.model===setting.model&&m.fast===true))throw Error(`Fast is unavailable for ${setting.model}. No fallback was used.`);
}
