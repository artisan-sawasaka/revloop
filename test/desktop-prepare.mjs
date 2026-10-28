// Prepare two independent fixtures. This does NOT launch an AI or run a review.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { install } from '../dist/install.js';
const project=fileURLToPath(new URL('../',import.meta.url));
await mkdir(path.join(project,'scratch'),{recursive:true});
const base=await mkdtemp(path.join(project,'scratch','desktop-'));
const bug='export function applyDiscount(price: number, percent: number): number { return price * percent / 100; }\n';
const tests=`import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDiscount } from './discount.ts';
test('20 percent off 100 is 80',()=>assert.equal(applyDiscount(100,20),80));
test('zero percent preserves price',()=>assert.equal(applyDiscount(250,0),250));
test('100 percent off is zero',()=>assert.equal(applyDiscount(80,100),0));
`;
const context='要件: applyDiscount(price, percent) は割引後の価格を返す。対象入力は有限の非負priceと0以上100以下のpercentに限定する。入力範囲外の検証や通貨丸めは今回の対象外。例: (100,20)=>80, (250,0)=>250, (80,100)=>0。discount.tsとdiscount.test.mjsだけがレビュー対象。初回レビュー前の修正は禁止。元デスクトップチャットがFAIL後に修正し同じrunを再レビューする。';
for(const provider of ['codex','claude']) {
  const root=path.join(base,provider);await mkdir(root);await install(root,path.join(project,'dist','cli.js'));
  await writeFile(path.join(root,'discount.ts'),bug);await writeFile(path.join(root,'discount.test.mjs'),tests);
  await mkdir(path.join(root,'.revloop'));await writeFile(path.join(root,'.revloop','context.md'),context+'\n検証状況: 準備時点でテスト未実行。\n');
  const prompt=`${provider==='claude'?'/revloop':'$revloop'} デスクトップ実機検証です。作業フォルダは ${root}。このフォルダのdiscount.tsとdiscount.test.mjsだけを対象に、反対側のAIへレビューを依頼してください。applyDiscountは割引後の価格を返す要件で、詳細はこのフォルダの.revloop/context.mdにあります。タイトルは revloop-desktop-${provider}。最初は修正せずレビューし、FAIL後はこの元チャットで修正とテストを行い、同じrun UUIDと同じレビュアーIDでPASSまで再レビューしてください。run開始時は両ファイルを明示し、CLIの全操作で作業フォルダを指定してください。contextは用意済みです。source-sessionは実際のIDが取得できれば記録してください。テストの期待値は変更しないでください。権限を緩めず、既存セッションを再開する別workerやサブエージェントは作らず、コミットもしません。必要な操作が拒否されたら停止して理由を報告してください。最後にrun UUID、元チャットID、レビュアーID、各ラウンドの判定、テスト結果を報告してください。`;
  await writeFile(path.join(base,`${provider}-prompt.txt`),prompt);
}
await writeFile(path.join(base,'manifest.json'),JSON.stringify({base,preparedAt:new Date().toISOString(),roots:{codex:path.join(base,'codex'),claude:path.join(base,'claude')}},null,2));
console.log(JSON.stringify({base,roots:{codex:path.join(base,'codex'),claude:path.join(base,'claude')}},null,2));
