import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Provider } from './types.js';
export interface Command { executable: string; prefix: string[] }
export interface ProcessResult { code: number; stdout: string; stderr: string; failure?: string }
export function resolveCommand(name: string): Command {
  const override = process.env[`REVLOOP_${name.toUpperCase()}_PATH`];
  const candidates = override ? [path.resolve(override)] : (process.env.PATH ?? '').split(path.delimiter).flatMap(dir =>
    process.platform === 'win32' ? [path.join(dir, name + '.exe'), path.join(dir, name + '.cmd'), path.join(dir, name + '.ps1')] : [path.join(dir, name)]);
  if (!override && name === 'claude') candidates.push(path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'));
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    if (/\.(cmd|ps1)$/i.test(candidate)) {
      if (name !== 'codex') continue;
      const js = path.join(path.dirname(candidate), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (existsSync(js)) return { executable: process.execPath, prefix: [js] };
      continue; // Never execute unescaped cmd/PowerShell wrappers.
    }
    if (/\.[cm]?js$/i.test(candidate)) return { executable: process.execPath, prefix: [candidate] };
    return { executable: candidate, prefix: [] };
  }
  throw new Error(`${name} CLI not found. Set REVLOOP_${name.toUpperCase()}_PATH to its executable or JS entrypoint.`);
}
const subscriptionConflicts: Record<Provider, string[]> = {
  codex: ['OPENAI_API_KEY','CODEX_API_KEY','OPENAI_BASE_URL'],
  claude: ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY','ANTHROPIC_PROFILE','ANTHROPIC_FEDERATION_RULE_ID']
};
export function subscriptionEnv(provider: Provider, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!subscriptionConflicts[provider]) throw new Error('Unknown authentication provider');
  const blocked = new Set(subscriptionConflicts[provider]);
  const active = Object.keys(source).filter(key => blocked.has(key.toUpperCase()) && source[key]);
  if (active.length) throw new Error(`Subscription-only mode (${provider}): conflicting environment variables: ${active.join(', ')}. No values were logged.`);
  // Validate only the CLI being launched. Do not remove or override the desktop host's environment.
  return { ...source };
}
export function killTree(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => child.kill());
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}
export async function runProcess(command: Command, args: string[], options: { cwd: string; input?: string; timeoutMs?: number; stopFile?: string; env?: NodeJS.ProcessEnv }): Promise<ProcessResult> {
  if (options.stopFile && existsSync(options.stopFile)) return { code:-1,stdout:'',stderr:'',failure:'STOPPED' };
  return new Promise(resolve => {
    const child = spawn(command.executable, [...command.prefix, ...args], { cwd: options.cwd, env: options.env ?? process.env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe','pipe','pipe'] });
    let stdout = '', stderr = '', failure: string | undefined;
    const cancel = (reason: string) => { if (!failure) { failure = reason; killTree(child); } };
    const timer = setTimeout(() => cancel('TIMEOUT'), options.timeoutMs ?? 30_000);
    const interval = setInterval(() => { if (options.stopFile && existsSync(options.stopFile)) cancel('STOPPED'); }, 200);
    const onSignal = () => cancel('STOPPED');
    process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
    const done = (code: number) => { clearTimeout(timer); clearInterval(interval); process.off('SIGINT',onSignal); process.off('SIGTERM',onSignal); resolve({ code, stdout, stderr, failure }); };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { if (Buffer.byteLength(stdout) + Buffer.byteLength(chunk) > 4_000_000) cancel('OUTPUT_LIMIT'); else stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { if (Buffer.byteLength(stderr) + Buffer.byteLength(chunk) > 4_000_000) cancel('OUTPUT_LIMIT'); else stderr += chunk; });
    child.on('error', e => { failure = e.message; done(-1); });
    child.on('close', code => done(code ?? -1));
    child.stdin.on('error', () => {}); // EPIPE is reflected by the child result.
    child.stdin.end(options.input ?? '');
  });
}
export function checkProcess(result: ProcessResult): void {
  if (result.failure || result.code !== 0) throw new Error(result.failure ?? `CLI exited ${result.code}: ${result.stderr.slice(-1000)}`);
}
