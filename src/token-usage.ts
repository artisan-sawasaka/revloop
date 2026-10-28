import type { Provider } from './types.js';

// CLI-reported tokens for one invocation, not monetary charges or subscription quota.
// Input includes cache reads/writes; cache and reasoning counts are breakdowns, not additions to total.
export interface TokenUsage {
  inputTokens: number | null; outputTokens: number | null; totalTokens: number | null;
  cacheReadTokens: number | null; cacheWriteTokens: number | null; reasoningTokens: number | null;
}
const record = (v: unknown): v is Record<string,unknown> => !!v && typeof v==='object' && !Array.isArray(v);
const count = (v: unknown): number | null => typeof v==='number' && Number.isSafeInteger(v) && v>=0 ? v : null;
function sum(...values: (number|null)[]): number|null {
  if(values.some(v=>v===null))return null;
  return count(values.reduce<number>((n,v)=>n+v!,0));
}
export function readTokenUsage(provider:Provider,stdout:string):TokenUsage|undefined {
  const events:Record<string,unknown>[]=[];
  try {const event:unknown=JSON.parse(stdout);if(record(event))events.push(event);}catch{/* JSONL is handled below. */}
  for(const line of events.length?[]:stdout.trim().split(/\r?\n/)){
    try {const event:unknown=JSON.parse(line);if(record(event))events.push(event);}catch{/* Incomplete output is not a usage report. */}
  }
  const event=events.filter(e=>provider==='claude'?e.type==='result':e.type==='turn.completed'||e.type==='turn.failed').at(-1);
  if(!event||!record(event.usage))return;
  const u=event.usage,outputTokens=count(u.output_tokens);
  const cacheReadTokens=count(provider==='claude'?u.cache_read_input_tokens:u.cached_input_tokens);
  const cacheWriteTokens=provider==='claude'?count(u.cache_creation_input_tokens):null;
  const inputTokens=provider==='claude'?sum(count(u.input_tokens),cacheReadTokens,cacheWriteTokens):count(u.input_tokens);
  const reasoningTokens=count(provider==='claude'&&record(u.output_tokens_details)?u.output_tokens_details.thinking_tokens:u.reasoning_output_tokens);
  if([count(u.input_tokens),outputTokens,cacheReadTokens,cacheWriteTokens,reasoningTokens].every(v=>v===null))return;
  return {inputTokens,outputTokens,totalTokens:sum(inputTokens,outputTokens),cacheReadTokens,cacheWriteTokens,reasoningTokens};
}
export function formatTokenUsage(usage?:TokenUsage):string {
  if(!usage)return 'トークン: 不明';
  const n=(v:number|null)=>v===null?'不明':v.toLocaleString('en-US');
  return `トークン: 入力 ${n(usage.inputTokens)} / 出力 ${n(usage.outputTokens)} / 合計 ${n(usage.totalTokens)}（キャッシュ読込 ${n(usage.cacheReadTokens)}・作成 ${n(usage.cacheWriteTokens)} / 推論 ${n(usage.reasoningTokens)}）`;
}
