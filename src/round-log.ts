import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { reviewCount, type State, type Round } from './types.js';

// One JSON line per finished reviewer attempt. No prompts, source, fixes or raw output.
export async function writeRoundLog(dir: string, s: State, round: Round): Promise<string> {
  const file=path.join(dir,'rounds.jsonl');
  const entry={at:round.finishedAt??new Date().toISOString(),cycle:s.cycle?.number??1,
    reviewCount:reviewCount(s),totalReviewCount:round.number,status:s.status,
    reportedVerdict:round.review?.verdict??null,effectiveVerdict:round.decision?.effectiveVerdict??null,
    tokenUsage:round.tokenUsage??null,quotaUsage:round.quotaUsage??null,
    findingCount:round.review?.findings.length??0,
    findings:round.review?.findings.map(({severity,file,line,message})=>({severity,file,line,message}))??[],
    ...(s.reason?{reason:s.reason}:{})};
  await appendFile(file,JSON.stringify(entry)+'\n');
  return file;
}
