import { readSettings } from './settings.js';
import { assessReview, reviewCount, type State } from './types.js';
import { buildHaltReport } from './halt.js';

export interface ChatLog { enabled: boolean | null; text: string; error?: string }

// Read state, not rounds.jsonl: chat output remains available with file logging OFF.
// Quote free text to keep each finding on one line and prevent forged log records.
export function formatChatLog(s: State): string {
  const rows=[`revloop: ${s.status}${s.stopPending?' (停止反映待ち)':''} / 今回 ${reviewCount(s)}/${s.maxRounds}回 / 累計 ${s.rounds.length}回`];
  for (const r of s.rounds) {
    if (r.review) {
      const decision=r.decision??assessReview(r.review);
      const verdict=decision.reportedVerdict===decision.effectiveVerdict?decision.effectiveVerdict:`${decision.reportedVerdict} → ${decision.effectiveVerdict}`;
      rows.push(`累計${r.number}回目: レビュー判定 ${verdict} / 指摘${r.review.findings.length}件${r.finishedAt?'':' / 未完了'}`);
      for (const f of r.review.findings) rows.push(`  ${f.severity} ${JSON.stringify(f.file)}:${f.line} ${JSON.stringify(f.message)}`);
    } else rows.push(`累計${r.number}回目: ${r.error?'ERROR':'未完了'} / レビュー結果なし`);
    if (r.error) rows.push(`  エラー: ${JSON.stringify(r.error)}`);
  }
  const reason=buildHaltReport(s)?.reason??s.reason;
  if (reason) rows.push(`理由: ${JSON.stringify(reason)}`);
  return rows.join('\n');
}

export async function chatLog(s: State): Promise<ChatLog> {
  try {
    const enabled=(await readSettings()).logging.chatEnabled;
    return {enabled,text:enabled?formatChatLog(s):''};
  } catch(e) {
    // Do not hide the actual run result or guess ON when settings are unreadable.
    return {enabled:null,text:'',error:`チャットログ表示設定を読み込めませんでした: ${(e as Error).message}`};
  }
}
