import { readFile, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { atomicJson, safeDir } from './storage.js';
import { codexMetadata } from './codex-rpc.js';
import type { Provider } from './types.js';

export const efforts = ['low','medium','high','xhigh','max'] as const;
export const codexModelOptions = [{model:'gpt-6-astra',label:'Astra'},{model:'gpt-6.1-sol',label:'6.1 Sol'}] as const;
export type Effort = typeof efforts[number];
export interface ReviewerSettings { model: string; effort: Effort }
export interface LoopSettings { maxRounds: number; stallLimit: number; timeoutSeconds: number }
export interface Settings { version: 2; codex: ReviewerSettings; claude: ReviewerSettings; loop: LoopSettings }
export interface ModelChoice { model: string; label: string; efforts: Effort[]; imageInput?:boolean }
export const settingsFile = () => path.join(os.homedir(), '.revloop', 'settings.json');
export const loopDefaults = (): LoopSettings => ({maxRounds:5,stallLimit:2,timeoutSeconds:300});
export const defaults = (): Settings => ({version:2,codex:{model:'gpt-6-astra',effort:'medium'},claude:{model:'opus',effort:'medium'},loop:loopDefaults()});
function object(v: unknown): v is Record<string, unknown> { return !!v && typeof v === 'object' && !Array.isArray(v); }
function keys(v: Record<string,unknown>, expected: string[]) { if (Object.keys(v).length !== expected.length || expected.some(k=>!(k in v))) throw Error('Unknown or missing settings field'); }
export function validateReviewer(provider: Provider, value: unknown): ReviewerSettings {
  if (!object(value)) throw Error('Reviewer settings must be an object');
  keys(value,['model','effort']);
  if (typeof value.model !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,79}$/.test(value.model)) throw Error('Invalid model identifier');
  if (!efforts.includes(value.effort as Effort)) throw Error('Unsupported reasoning effort');
  if (provider === 'codex' && !codexModelOptions.some(m=>m.model===value.model)) throw Error('Codex model must be Astra or 6.1 Sol');
  // Normal Opus is the currently supported Claude reviewer model.
  if (provider === 'claude' && value.model !== 'opus') throw Error('Claude reviewer currently supports Opus only');
  return {model:value.model,effort:value.effort as Effort};
}
export function validateSettings(value: unknown): Settings {
  if (!object(value)) throw Error('Settings must be an object');
  if (value.version !== 2) throw Error('Unsupported settings version. Reopen the settings GUI.');
  keys(value,['version','codex','claude','loop']);
  if (!object(value.loop)) throw Error('Loop settings must be an object');
  keys(value.loop,['maxRounds','stallLimit','timeoutSeconds']);
  for (const [name,min,max] of [['maxRounds',1,50],['stallLimit',1,10],['timeoutSeconds',1,3600]] as const) {
    const n=value.loop[name];
    if (typeof n!=='number'||!Number.isInteger(n)||n<min||n>max) throw Error(`Invalid ${name}: integer ${min}..${max} required`);
  }
  return {version:2,codex:validateReviewer('codex',value.codex),claude:validateReviewer('claude',value.claude),loop:{maxRounds:value.loop.maxRounds as number,stallLimit:value.loop.stallLimit as number,timeoutSeconds:value.loop.timeoutSeconds as number}};
}
export const revisionOf = (s: Settings) => createHash('sha256').update(JSON.stringify(s)).digest('hex');
export async function readSettings(file=settingsFile()): Promise<Settings> {
  let text: string;
  try { text=await readFile(file,'utf8'); } catch(e) { if ((e as NodeJS.ErrnoException).code==='ENOENT') return defaults(); throw e; }
  if (Buffer.byteLength(text)>16_384) throw Error('Settings file is too large');
  const value:unknown=JSON.parse(text);
  // Only a complete valid v1 file receives new defaults; preserve its model choices.
  // Older GUI clients cannot save v1 over v2 settings through saveSettings.
  if (object(value)&&value.version===1) {
    keys(value,['version','codex','claude']);
    return validateSettings({...value,version:2,loop:loopDefaults()});
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
      if (choice&&supported.length) result.push({model:choice.model,label:choice.label,efforts:supported,imageInput:Array.isArray(row.inputModalities)&&row.inputModalities.includes('image')});
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
}
