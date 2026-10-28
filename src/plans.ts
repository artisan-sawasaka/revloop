import type { Provider } from './types.js';

export const profilePlans = {codex:['free','plus','pro'],claude:['free','pro','max']} as const;
// revloop's requested model menu. Live account/CLI restrictions still apply at execution.
export const planModels:Record<Provider,Record<string,readonly string[]>> = {
  codex:{free:['gpt-6-luna'],plus:['gpt-6.1-sol','gpt-6-astra','gpt-6.1-terra'],pro:['gpt-6.1-sol','gpt-6-astra','gpt-6.1-terra']},
  claude:{free:['sonnet'],pro:['opus','sonnet'],max:['opus','fable','sonnet']}
};
export const planAvailability = {
  codex:[
    {plan:'free',label:'Free',supported:true,reason:'Lunaのみ。CLIが返すモデル・強度・残量を実行直前に確認します。FastはOFFです。'},
    {plan:'plus',label:'Plus',supported:true,reason:'Sol・Astra・Terra。利用可否と推論強度は現在のCLIでも確認します。'},
    {plan:'pro',label:'Pro',supported:true,reason:'Sol・Astra・Terra。ProLiteもこの個別設定を使用します。'}
  ],
  claude:[
    {plan:'free',label:'Free',supported:false,reason:'Sonnetは通常チャット向けです。Claude FreeはClaude Codeの個人向け認証対象外のため、CLIレビューは利用できません。'},
    {plan:'pro',label:'Pro',supported:true,reason:'Opus・Sonnet。追加利用OFFをClaude側で維持してください。'},
    {plan:'max',label:'Max',supported:true,reason:'優先順：Opus → Fable → Sonnet。FableにはMax専用枠があります。追加利用OFFを維持してください。'}
  ]
};
export function profilePlan(provider:Provider,plan:unknown):string {
  const normalized=provider==='codex'&&plan==='prolite'?'pro':plan;
  if(typeof normalized!=='string'||!profilePlans[provider].some(p=>p===normalized))throw Error('Unsupported '+provider+' plan. No profile fallback was used.');
  return normalized;
}
export function modelAllowedForPlan(provider:Provider,plan:string,model:string):boolean {
  return (planModels[provider][plan]??[]).includes(model);
}
export function requirePlanModel(provider:Provider,plan:unknown,model:string,fast=false):void {
  const key=profilePlan(provider,plan);
  if(!modelAllowedForPlan(provider,key,model))throw Error('Model '+model+' is unavailable for '+provider+' '+key+'. No fallback was used.');
  if(provider==='codex'&&key==='free'&&fast)throw Error('Codex Free supports Standard speed only');
}
export function requireCliPlan(provider:Provider,plan:unknown):string {
  const key=profilePlan(provider,plan);
  if(!planAvailability[provider].some(row=>row.plan===key&&row.supported))throw Error(provider+' '+key+' does not support CLI reviews');
  return key;
}
