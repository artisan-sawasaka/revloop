export interface QuotaWindow { key:string; label:string; usedPercent:number; resetsAt:number|null }
export interface QuotaUsage { approximate:true; before:QuotaWindow[]; after:QuotaWindow[] }
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const percent=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=100;
const reset=(v:unknown):number|null=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0?v:null;
export function codexQuotaWindows(raw:unknown):QuotaWindow[]{
  if(!object(raw))return [];
  const buckets=object(raw.rateLimitsByLimitId)?raw.rateLimitsByLimitId:object(raw.rateLimits)&&typeof raw.rateLimits.limitId==='string'?{[raw.rateLimits.limitId]:raw.rateLimits}:{};
  const windows:QuotaWindow[]=[];
  for(const [id,bucket] of Object.entries(buckets)){
    if(!/^[a-zA-Z0-9_-]{1,80}$/.test(id)||!object(bucket))continue;
    for(const key of ['primary','secondary']){
      const w=bucket[key];if(!object(w)||!percent(w.usedPercent))continue;
      const name=w.windowDurationMins===300?'5時間枠':w.windowDurationMins===10080?'週間枠':key==='primary'?'主枠':'副枠';
      windows.push({key:id+'.'+key,label:id+' / '+name,usedPercent:w.usedPercent,resetsAt:reset(w.resetsAt)});
    }
  }
  return windows;
}
const claudeNames:Record<string,string>={five_hour:'5時間枠',seven_day:'週間枠',seven_day_opus:'週間Opus枠',seven_day_sonnet:'週間Sonnet枠',seven_day_fable:'週間Fable枠'};
// Best effort: these events may omit utilization entirely. Never infer percentages from tokens/status.
export function claudeQuotaWindows(stdout:string):QuotaWindow[]{
  const windows=new Map<string,QuotaWindow>();
  const add=(key:string,value:unknown)=>{
    if(!Object.hasOwn(claudeNames,key)||!object(value)||typeof value.utilization!=='number'||!percent(value.utilization*100))return;
    windows.set(key,{key,label:claudeNames[key]!,usedPercent:value.utilization*100,resetsAt:reset(value.resetsAt)});
  };
  for(const line of stdout.trim().split(/\r?\n/)){
    let event:unknown;try{event=JSON.parse(line);}catch{continue;}
    if(!object(event)||event.type!=='rate_limit_event'||!object(event.rate_limit_info))continue;
    const info=event.rate_limit_info;
    if(object(info.unifiedWindows))for(const [key,value] of Object.entries(info.unifiedWindows))add(key,value);
    if(typeof info.rateLimitType==='string')add(info.rateLimitType,info);
  }
  return [...windows.values()];
}
export function formatQuotaUsage(usage?:QuotaUsage):string[]{
  if(!usage?.after.length)return ['利用枠: 不明'];
  const n=(v:number)=>String(Math.round(v*10)/10);
  return usage.after.map(w=>{
    const before=usage.before.find(b=>b.key===w.key);
    const comparable=before&&w.resetsAt!==null&&before.resetsAt===w.resetsAt&&w.usedPercent>=before.usedPercent;
    const delta=comparable?'+'+n(w.usedPercent-before.usedPercent)+'ポイント':'不明';
    return `利用枠（目安） ${w.label}: 使用 ${n(w.usedPercent)}% / 残り ${n(100-w.usedPercent)}% / 増加 ${delta}`;
  });
}
