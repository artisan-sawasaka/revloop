import { mkdir, lstat, realpath, readFile, writeFile, rename, open, unlink, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { State } from './types.js';
import {buildHaltReport,haltText} from './halt.js';
import type {BillingReport} from './billing.js';
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function canonicalRoot(root: string): Promise<string> { return realpath(path.resolve(root)); }
export async function safeDir(dir: string): Promise<void> {
  const parent = path.dirname(dir);
  if (parent !== dir) {
    try { const s = await lstat(parent); if (s.isSymbolicLink()) throw new Error(`Symlink directory refused: ${parent}`); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') await safeDir(parent); else throw e; }
  }
  await mkdir(dir, { recursive: true });
  const s = await lstat(dir); if (s.isSymbolicLink() || !s.isDirectory()) throw new Error(`Unsafe directory: ${dir}`);
}
export async function runDir(root: string, id: string): Promise<string> {
  if (!uuid.test(id)) throw new Error('Invalid run UUID');
  const base = path.join(root, '.revloop'); await safeDir(base); await safeDir(path.join(base, 'runs'));
  const dir = path.join(base, 'runs', id); await safeDir(dir); return dir;
}
export async function atomicJson(file: string, value: unknown): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  await rename(temp, file);
}
export async function loadState(root: string, id: string): Promise<State> {
  const dir = await runDir(root, id);
  const s = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8')) as State;
  if (s.version !== 1 || s.id !== id || s.root !== root) throw new Error('Run identity mismatch');
  return s;
}
export async function saveState(dir: string, s: State): Promise<void> {
  const report=buildHaltReport(s,true);if(report)s.reason=report.reason;
  await atomicJson(path.join(dir, 'state.json'), s);
  if(report){await atomicJson(path.join(dir,'halt.json'),report);await writeFile(path.join(dir,'halt.log'),haltText(report));}
}
export async function saveBillingDiagnostic(root:string,report:BillingReport):Promise<{reason:string;nextAction:string;logs:Record<string,string>}> {
  const base=path.join(root,'.revloop');await safeDir(base);
  const dir=path.join(base,'diagnostics');await safeDir(dir);
  const stem=`${new Date().toISOString().replace(/[:.]/g,'-')}-${report.provider}-${randomUUID()}`;
  const reason=report.reasons.join('; ')||'サブスク限定の実行条件を確認できませんでした。';
  const nextAction='停止理由を確認し、利用条件・認証・必要なユーザー確認を解決してください。課金ガードを解除しません。';
  const logs={billing:path.join(dir,stem+'.json'),billingLog:path.join(dir,stem+'.log')};
  await atomicJson(logs.billing!,{...report,reason,nextAction,logs});
  await writeFile(logs.billingLog!,[`provider: ${report.provider}`,`status: ${report.status}`,`reason: ${JSON.stringify(reason)}`,`nextAction: ${JSON.stringify(nextAction)}`,`report: ${JSON.stringify(logs.billing)}`,''].join('\n'));
  return {reason,nextAction,logs};
}
export async function event(dir: string, value: unknown): Promise<void> { await appendFile(path.join(dir, 'history.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...value as object }) + '\n'); }
export async function lock(dir: string): Promise<() => Promise<void>> {
  const file = path.join(dir, 'lock');
  try {
    const handle = await open(file, 'wx'); await handle.writeFile(JSON.stringify({ pid: process.pid })); await handle.close();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    throw new Error('This run is locked. Use status; if its process crashed, use recover.');
  }
  return async () => { await unlink(file); };
}
export async function recover(root: string, id: string): Promise<State> {
  const dir = await runDir(root,id), file = path.join(dir,'lock');
  const { pid } = JSON.parse(await readFile(file,'utf8'));
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid lock; manual inspection required');
  try { process.kill(pid, 0); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
    // Recovery closes this run; never resumes a potentially partial review.
    const s = await loadState(root,id); s.status = 'ERROR'; s.reason = 'Recovered abandoned run; start a new run after inspection.';
    await saveState(dir,s); await event(dir,{ type:'recovered' }); await unlink(file); return s;
  }
  throw new Error('Lock owner is still running; use stop');
}
