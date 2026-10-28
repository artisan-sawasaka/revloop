import { claudeEnv } from '../dist/claude-usage.js';
import { requireIncludedBilling } from '../dist/billing.js';
// Explicit real source-AI workflow test. Isolated temporary workspace; consumes subscription usage.
import { mkdtemp,writeFile,readFile,readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { install } from '../dist/install.js';
import { resolveCommand,runProcess } from '../dist/process.js';
const root=await mkdtemp(path.join(os.tmpdir(),'revloop-worker-claude-'));
await requireIncludedBilling('claude',process.cwd()); // No live smoke may bypass the production billing policy.
const cli=fileURLToPath(new URL('../dist/cli.js',import.meta.url));
await install(root,cli);
await writeFile(path.join(root,'calc.ts'),'export function add(a: number, b: number): number { return a - b; }\n');
const prompt=`/revloop Review only calc.ts with Codex. Requirement: add returns the arithmetic sum of two numbers. Use title revloop-worker-claude. Start the review BEFORE making any fix so it can catch the defect. Use --file calc.ts because this is not a Git repo. Follow the installed revloop skill, fix in THIS session after NEEDS_FIX, and automatically re-review the SAME run until PASS. No external files or unrelated changes. This is an authorized isolated integration test. Do not ask permission for the local fix. No git commits. Use node and native Read/Write/Edit tools only. CLI path: ${cli}. Return the final status and IDs.`;
console.log(JSON.stringify({root,phase:'source-AI-start'}));
const result=await runProcess(resolveCommand('claude'),['-p','--model','opus','--strict-mcp-config','--setting-sources','project','--tools','Read,Write,Edit,Bash,PowerShell,Skill','--allowedTools','Read,Write,Edit,Bash(node *),PowerShell(node *),Skill(revloop)','--permission-mode','acceptEdits','--output-format','json','--name','revloop-worker-claude'],{cwd:root,input:prompt,timeoutMs:240000,env:claudeEnv()});
await writeFile(path.join(root,'source-result.json'),result.stdout);await writeFile(path.join(root,'source-stderr.txt'),result.stderr);
console.log(JSON.stringify({code:result.code,failure:result.failure,sourceResult:result.stdout}));
const runs=await readdir(path.join(root,'.revloop','runs')).catch(()=>[]);
const states=await Promise.all(runs.map(async id=>JSON.parse(await readFile(path.join(root,'.revloop','runs',id,'state.json'),'utf8'))));
const sourceResult=JSON.parse(result.stdout);
const good=sourceResult.is_error===false&&states.length===1&&states[0].sourceSession===sourceResult.session_id&&states[0].status==='PASS'&&states[0].rounds.length===2&&states[0].rounds[0].review.verdict==='FAIL'&&states[0].rounds[1].review.verdict==='PASS'&&states[0].rounds[0].sessionId===states[0].rounds[1].sessionId;
console.log(JSON.stringify({verified:good,runIds:runs,statuses:states.map(s=>s.status),code:await readFile(path.join(root,'calc.ts'),'utf8')}));
if(!good||result.code!==0||result.failure)process.exitCode=1;
