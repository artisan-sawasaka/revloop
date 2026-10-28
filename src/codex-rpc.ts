import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { killTree, resolveCommand, subscriptionEnv } from './process.js';

type Method = 'thread/name/set' | 'thread/read' | 'account/rateLimits/read' | 'account/read' | 'model/list';
// Explicit allowlist: no turn/start, purchases, credit resets, login, or account changes.
export async function codexMetadata(method: Method, params: Record<string,unknown> | undefined, cwd: string, stopFile?: string): Promise<unknown> {
  if (!['thread/name/set','thread/read','account/rateLimits/read','account/read','model/list'].includes(method)) throw new Error('Unsupported metadata method');
  if(stopFile&&existsSync(stopFile))throw Error('STOPPED');
  const cmd = resolveCommand('codex');
  return new Promise((resolve,reject) => {
    const child = spawn(cmd.executable,[...cmd.prefix,'app-server','--listen','stdio://'],{cwd,env:subscriptionEnv('codex'),shell:false,windowsHide:true,detached:process.platform !== 'win32',stdio:['pipe','pipe','pipe']});
    let buffer = '', finished = false;
    const end = (error?: Error, value?: unknown) => { if (finished) return; finished = true; clearTimeout(timer);clearInterval(poll);process.off('SIGINT',cancel);process.off('SIGTERM',cancel); killTree(child); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => end(new Error('Codex metadata request timed out')),15_000);
    const cancel=()=>end(Error('STOPPED'));
    const poll=setInterval(()=>{if(stopFile&&existsSync(stopFile))cancel();},200);
    process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
    const send = (v: unknown) => child.stdin.write(JSON.stringify(v)+'\n');
    child.stdout.setEncoding('utf8'); child.stderr.resume(); child.stdin.on('error',e => end(e));
    child.on('error',e => end(e)); child.on('exit',() => end(new Error('Codex metadata process exited early')));
    child.stdout.on('data',(chunk: string) => {
      buffer += chunk; if (buffer.length > 1_000_000) return end(new Error('Metadata output limit'));
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0,newline); buffer = buffer.slice(newline+1);
        let msg; try { msg = JSON.parse(line); } catch { return end(new Error('Invalid metadata JSON')); }
        if (msg.error && (msg.id === 1 || msg.id === 2)) return end(new Error(JSON.stringify(msg.error)));
        if (msg.id === 1) { send({method:'initialized',params:{}}); send({id:2,method,params}); }
        if (msg.id === 2) return end(undefined,msg.result);
      }
    });
    send({id:1,method:'initialize',params:{clientInfo:{name:'revloop',version:'0.1.0'}}});
  });
}
