import { readFile, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { atomicJson, safeDir } from './storage.js';
import { codexMetadata } from './codex-rpc.js';

export const CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;
export const confirmationFile = () => path.join(os.homedir(),'.revloop','billing','codex-auto-reload.json');
export interface CodexConfirmation { version:1; provider:'codex'; source:'user-confirmed'; autoReloadOff:true; accountFingerprint:string; confirmedAt:string; expiresAt:string }
export function codexFingerprint(accountId: unknown): string | null {
  return typeof accountId==='string'&&accountId.length>0 ? createHash('sha256').update('codex\0'+accountId).digest('hex') : null;
}
export function validConfirmation(value: unknown, fingerprint: string | null, now=Date.now()): value is CodexConfirmation {
  if(!value||typeof value!=='object'||!fingerprint)return false;
  const c=value as CodexConfirmation,at=Date.parse(c.confirmedAt),until=Date.parse(c.expiresAt);
  return c.version===1&&c.provider==='codex'&&c.source==='user-confirmed'&&c.autoReloadOff===true&&c.accountFingerprint===fingerprint&&Number.isFinite(at)&&Number.isFinite(until)&&at<=now&&until>now&&until-at===CONFIRMATION_TTL_MS;
}
export async function loadConfirmation(): Promise<unknown> {
  try{return JSON.parse(await readFile(confirmationFile(),'utf8'));}catch{return undefined;}
}
export async function confirmCodexAutoReloadOff(cwd: string): Promise<CodexConfirmation> {
  const auth=await codexMetadata('account/read',{refreshToken:false},cwd) as {account?:{type?:string;planType?:string}};
  if(auth.account?.type!=='chatgpt'||!['free','plus','pro','prolite'].includes(auth.account.planType??''))throw Error('A supported personal ChatGPT subscription is required');
  const usage=await codexMetadata('account/rateLimits/read',undefined,cwd) as {accountId?:unknown};
  const fingerprint=codexFingerprint(usage.accountId);if(!fingerprint)throw Error('Cannot bind confirmation to a verified account');
  const now=Date.now(),receipt:CodexConfirmation={version:1,provider:'codex',source:'user-confirmed',autoReloadOff:true,accountFingerprint:fingerprint,confirmedAt:new Date(now).toISOString(),expiresAt:new Date(now+CONFIRMATION_TTL_MS).toISOString()};
  await safeDir(path.dirname(confirmationFile()));await atomicJson(confirmationFile(),receipt);return receipt;
}
export async function revokeCodexConfirmation(): Promise<void> {try{await unlink(confirmationFile());}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
