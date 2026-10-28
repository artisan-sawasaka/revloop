import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runProcess, checkProcess } from './process.js';
import { isImagePath, imageLimits, inspectImage, type SnapshotImage, type ImageInfo } from './images.js';
export const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export interface Snapshot { fingerprint: string; input: string; images:SnapshotImage[] }
export function relativeFile(file: string): string {
  const p = file.replaceAll('\\', '/');
  if (!p || path.isAbsolute(file) || p.split('/').some(v => !v || v === '..' || v === '.') || /[:\x00-\x1f]/.test(p)) throw new Error(`Unsafe relative path: ${file}`);
  if (p.split('/').some(v => ['.git','.revloop','node_modules'].includes(v.toLowerCase()))) throw new Error(`Internal path excluded: ${file}`);
  if (/(^|\/)(\.env($|\.)|credentials(?:\.|$)|id_(rsa|ed25519)$)|\.(pem|p12|pfx|key)$/i.test(p)) throw new Error(`Potential credential file refused: ${file}. Narrow the review scope.`);
  return p;
}
async function git(root: string, args: string[], allowFailure = false): Promise<string> {
  const r = await runProcess({ executable: 'git', prefix: [] }, ['-c','core.quotePath=false',...args], { cwd: root, timeoutMs: 30_000 });
  if (allowFailure && r.code !== 0) return '';
  checkProcess(r); return r.stdout;
}
export async function snapshot(root: string, requested: string[], context: string): Promise<Snapshot> {
  const isGit = (await git(root,['rev-parse','--is-inside-work-tree'],true)).trim() === 'true';
  if (!isGit && !requested.length) throw new Error('Not a Git repository: supply --file for each review file');
  const paths = requested.length ? requested.map(relativeFile) : (await git(root,['ls-files','--cached','--others','--exclude-standard','-z'])).split('\0').filter(Boolean).filter(f => !f.startsWith('.revloop/')).map(relativeFile);
  const files = [...new Set(paths)].sort();
  const tracked = isGit ? new Set((await git(root,['ls-files','--cached','-z'])).split('\0')) : new Set<string>();
  if (!files.length || files.length > 2000) throw new Error('Review scope must contain 1..2000 files; use --file to narrow it');
  let bytes = Buffer.byteLength(context),imageBytes=0;
  const images:SnapshotImage[]=[];
  const entries: { path: string; sha256: string | null; content: string | null; kind?:'image'; image?:ImageInfo }[] = [];
  for (const file of files) {
    let missing = false;
    const parts = file.split('/');
    for (let i = 1; i <= parts.length; i++) {
      try { if ((await lstat(path.join(root,...parts.slice(0,i)))).isSymbolicLink()) throw new Error(`Symlink refused: ${file}`); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') { missing = true; break; } throw e; }
    }
    if (missing) {
      if(isImagePath(file))throw Error(`Review image is missing: ${file}. Visual review cannot silently omit it.`);
      if (!tracked.has(file)) throw new Error(`Review file does not exist and is not a tracked deletion: ${file}`);
      entries.push({ path:file, sha256:null, content:null }); continue;
    }
    const full = path.join(root,file), stat = await lstat(full);
    const actual = await realpath(full), rel = path.relative(root,actual);
    if (rel.startsWith('..') || path.isAbsolute(rel) || !stat.isFile() || stat.size > (isImagePath(file)?imageLimits.perImageBytes:1_000_000)) throw new Error(`Unsafe or oversized review file: ${file}`);
    const data = await readFile(full);
    if(isImagePath(file)) {
      imageBytes+=data.length;if(images.length>=imageLimits.count||imageBytes>imageLimits.totalBytes)throw Error('Too many or oversized images; narrow the review scope');
      const item=await inspectImage(file,data,images.length+1);images.push(item);
      entries.push({path:file,sha256:item.sha256,content:null,kind:'image',image:item.image});continue;
    }
    bytes += data.length;
    if (bytes > 8_000_000) throw new Error('Snapshot exceeds 8 MB; narrow --file scope');
    let content: string;
    try { content = new TextDecoder('utf-8',{ fatal:true }).decode(data); } catch { throw new Error(`Non-UTF8 file: ${file}`); }
    if (content.includes('\0')) throw new Error(`Binary file: ${file}`);
    entries.push({ path:file, sha256:hash(data), content });
  }
  const pathspec = requested.length ? requested.map(p => `:(literal)${relativeFile(p)}`) : ['.',':(exclude).revloop'];
  const head = isGit ? (await git(root,['rev-parse','--verify','HEAD'],true)).trim() : '';
  // Both parts matter: staged-only changes can differ while the worktree is identical.
  const staged = isGit ? await git(root,['diff','--no-ext-diff','--no-textconv','--cached','--',...pathspec]) : '';
  const unstaged = isGit ? await git(root,['diff','--no-ext-diff','--no-textconv','--',...pathspec]) : '';
  const input = JSON.stringify({ context, scope: requested.length ? 'explicit files' : 'all non-ignored Git files', git:{ head:head || null, staged, unstaged }, files:entries },null,2);
  if (Buffer.byteLength(input) > 512_000) throw new Error('Snapshot plus diff exceeds 512 KB; narrow scope. Nothing was truncated.');
  return { input, fingerprint:hash(input),images };
}
