import { requireIncludedBilling } from '../dist/billing.js';
// Explicit integration test of the Codex source host and Claude reviewer.
import { mkdtemp,writeFile,readFile,readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { install } from '../dist/install.js';
import { resolveCommand,runProcess } from '../dist/process.js';
const root=await mkdtemp(path.join(os.tmpdir(),'revloop-worker-codex-'));
await requireIncludedBilling('codex',process.cwd()); // No live smoke may bypass the production billing policy.
const cli=fileURLToPath(new URL('../dist/cli.js',import.meta.url));
await install(root,cli);
await writeFile(path.join(root,'calc.ts'),'export function add(a: number, b: number): number { return a - b; }\n');
const prompt=`$revloop Review only calc.ts with Claude Code. Requirement: add returns the arithmetic sum of its two numbers. Use title revloop-worker-codex. Review BEFORE fixing, use --file calc.ts because this is not a Git repo. Follow the installed revloop skill, repair in THIS session after NEEDS_FIX, and automatically re-review the SAME run until PASS. This is an authorized isolated integration test. Do not touch unrelated files, commit or spawn other workers. CLI path: ${cli}. If the environment blocks necessary commands, stop and explain; never bypass sandbox or permission policy.`;
console.log(JSON.stringify({root,phase:'source-AI-start'}));
const result=await runProcess(resolveCommand('codex'),['-a','never','exec','--ignore-user-config','--ignore-rules','--sandbox','workspace-write','--skip-git-repo-check','--disable','multi_agent','--disable','multi_agent_v2','--json','-'],{cwd:root,input:prompt,timeoutMs:180000});
await writeFile(path.join(root,'source-result.jsonl'),result.stdout);await writeFile(path.join(root,'source-stderr.txt'),result.stderr);
console.log(JSON.stringify({code:result.code,failure:result.failure,sourceResult:result.stdout}));
const runs=await readdir(path.join(root,'.revloop','runs')).catch(()=>[]);
const states=await Promise.all(runs.map(async id=>JSON.parse(await readFile(path.join(root,'.revloop','runs',id,'state.json'),'utf8'))));
const good=states.length===1&&states[0].status==='PASS'&&states[0].rounds.length===2&&states[0].rounds[0].review.verdict==='FAIL'&&states[0].rounds[1].review.verdict==='PASS';
console.log(JSON.stringify({verified:good,runIds:runs,statuses:states.map(s=>s.status),code:await readFile(path.join(root,'calc.ts'),'utf8')}));
if(!good||result.code!==0||result.failure)process.exitCode=1;
