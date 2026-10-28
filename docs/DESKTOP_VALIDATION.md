# デスクトップ起点の実機検証 — 2026-10-18

この文書は初期デスクトップ実行履歴。最新の条件付き課金ガード版の両デスクトップPASSは[BILLING_SAFETY.md](BILLING_SAFETY.md)を参照。

CLIから作業担当を起動する過去のsmokeとは区別し、元デスクトップのAIがレビュー依頼と修正を担当する経路を確認する。別プロセスで元セッションをresumeしない。

## 対象と手順

- Codex: このCodexデスクトップの元チャット「revloopの公式仕様を調査」。導入済みrevloop Skillを、このチャットのユーザー依頼に応じて読み込み実行。sourceSessionはアプリのlist_threadsで確認したIDを使用。
- Claude: Claude Desktop 2.42304.0.0、Code画面、既存のローカルrevloop環境、表示上の権限は「編集を受け入れる」。Windows Computer Useで新規入力欄に `/revloop` を入力し、実際の候補を選択して検証依頼を送信。
- 準備: `node test/desktop-prepare.mjs`。検証用rootは `scratch/desktop-WBXXAw/codex` と `scratch/desktop-WBXXAw/claude`。対象ファイル2つをそれぞれ独立に配置。
- 不具合: applyDiscountが割引後価格ではなく割引額を返す。期待値を固定した3テストを同梱。
- 判定: 最初にFAIL、元AIが実装だけを修正、テスト成功、同じrun UUIDと同じreviewer sessionで再レビューPASS。テスト変更・入力変化・source session記録を監査。

## 現在の結果

| 起点 | 結果 | 証拠 |
| --- | --- | --- |
| Codexデスクトップ元チャット | PASS | [機械監査](evidence/desktop-20261018/codex/audit.json)、[状態](evidence/desktop-20261018/codex/state.json) |
| Claudeデスクトップの `/revloop` 選択・送信 | PASS | Code画面にrevloop候補が表示され、選択後に「revloop デスクトップ実機検証」チャットが開始 |
| Claudeデスクトップからのレビュー→修正→再レビュー | PASS（最終試験は追加指示・中断なし） | [状態・入力監査](evidence/desktop-20261018/claude-final/audit.json)、[元チャット順序監査](evidence/desktop-20261018/claude-final/desktop-transcript-audit.json)。同じrun・同じ元ID・同じ相手IDで完了 |
| 元チャットとレビュアーの同名化 | PASS（Claude起点） | [App Serverで実際のreviewer名を照合](evidence/desktop-20261018/claude-final/reviewer-title.json) |
| CodexアプリのSkillメニューをクリックして送信 | NOT RUN | このチャットでのSkill実行と、メニューUIの自動操作は区別する |

## Codex側の記録

- source session: `01a14c83-a547-70b0-baa1-af6092f2b81d`
- run: `e478bffd-0aff-48d7-861d-b638fb3ce834`
- reviewer session (Claude): `4a0a123c-399e-48f4-804d-a940e594ad3a`
- reviewer title: 元チャットと同じ「revloopの公式仕様を調査」を指定。
- round 1: FAIL。割引額を返す不具合を指摘。実際のnode:testも3件失敗。
- statusでNEEDS_FIXを確認後、元チャットで `price * (100 - percent) / 100` へ修正。テストの内容・期待値は変更しない。
- 修正後node:test: 3件PASS。round 2: PASS。同じreviewer session ID。
- `test/desktop-audit.mjs` が、2ラウンド、FAIL→PASS、元ID記録、相手ID維持、入力SHA-256、テスト不変、現ファイル一致を確認。

## 操作上の制約

### Claudeデスクトップの最終試験（中断なし）

- 最終fixture: `scratch/desktop-WBXXAw/claude-final-wzlaXC`。前のrunがPASSで終了してから、独立した未修正fixtureを使った。
- `/revloop` をデスクトップの候補から選択し、1回送信。その後は画面の観察と読み取り監査だけを行い、追加の続行指示を送っていない。
- run: `9ce72a19-4546-40a7-b017-3d0724d741d9`
- 元チャットID: `98c7ef7e-58de-4c41-88fe-87ea298a7e2b` を維持。
- Codex reviewer: `01a14cd5-81dd-7801-9f02-d689cc2d5499` を両レビューで維持。
- 元チャットとreviewerの名前は「revloop デスクトップ実機検証」で一致。実際のthread/read.nameを照合。
- round 1: FAIL。元Claudeが `price * (1 - percent / 100)` へ修正。元Claudeのnode:testは3件PASS。round 2: PASS。
- 元transcriptで最終試験の途中中断なしを確認。status結果index 261 → Edit index 265 → test結果index 273 → 再レビューindex 277 の順序を確認。
- 入力SHA-256、テスト内容不変、現在ファイルと最終snapshot一致、元IDと相手IDを機械監査。
- 実行時の元Claudeデスクトップの権限表示は「権限をバイパス」。ユーザーの許可操作後に観測した状態であり、こちらから変更していない。レビュアーCodexには引き続きread-only・shell無効・承認要求なしの制限が適用される。「編集を受け入れる」モードで無承認完走した証拠ではない。

### Claudeデスクトップの再開試験

- 元チャットID: `98c7ef7e-58de-4c41-88fe-87ea298a7e2b`
- run: `4af253cc-5633-484c-ad89-2f8061d6b321`
- Codex reviewer: `01a14cd1-3802-7192-b871-94095bc9b78c`
- 元デスクトップと同じタイトル「revloop デスクトップ実機検証」を引継ぎ。
- 1回目FAIL→元Claudeが実装修正→UI送信確認操作後にターン中断→同じチャットへ続行指示→3テストPASS→同じrunの2回目レビューPASS。
- 中断は元transcriptの `[Request interrupted by user]` として記録されている。Windowsのaccessibility情報と実際のスクリーンショットの更新がずれていたため、以降はスクリーンショットの送信ボタンを一度だけ操作する方法に変更。この試験は完全無介入の証拠としては使わない。
- 同じrunを再開可能であることは[機械監査](evidence/desktop-20261018/claude-resumed/audit.json)で確認。追加の独立したfixtureで、中断なしの最終確認も完了した。

### 許可後に見つかった認証チェックの不具合

Claude Desktopの環境に `ANTHROPIC_BASE_URL` が存在し、初期版の全プロバイダー共通チェックがCodexの起動まで拒否した。元Claudeセッション `98c7ef7e-58de-4c41-88fe-87ea298a7e2b` はrunを作成せず、fixtureを変更せず停止した。

修正は `subscriptionEnv(provider)` と `doctor --provider`。呼び出す相手CLIに影響する認証変数だけを検査する。CodexのAPIキー・独自URL拒否、ClaudeのAPIキー・独自URL・他クラウド拒否は継続する。環境変数自体は親・子とも削除・変更しない。デスクトップを模した環境で、相手だけの診断成功、両方診断時のClaude側拒否、全既存拒否条件の維持をテストし、26件PASS。

許可後のClaude UIは「権限をバイパス」と表示されていた。こちらのUI操作やrevloopによる権限設定変更はしていない。この実行条件は、元の「編集を受け入れる」で確認なしに完走できた証拠とは区別する。

Computer Useのguidanceはアプリ内のsecurity/privacy権限リクエストの代理承認を禁止している。そのためClaudeの権限ダイアログはユーザーに操作を依頼し、設定ファイル変更・別プロセス実行・権限緩和で回避しない。

同じguidanceはChatGPTデスクトップUIの自動操作も禁止している。現在のCodexデスクトップはアプリ一覧でChatGPTとして識別されるため、自己UIの入力自動化は行わず、この元デスクトップチャットを作業担当として検証した。

Claude側の許可待ちコマンド:

```text
node 'C:\work\revloop\dist\cli.js' doctor --root 'C:\work\revloop\scratch\desktop-WBXXAw\claude'
```

## 再現と監査

```powershell
# 新しい2組のfixtureとチャット投入用promptを作成する（AIは起動しない）
node test/desktop-prepare.mjs
# 各デスクトップで、生成されたpromptを対応するSkillとともに送信する
# 完了後、runを再実行せず保存結果を検査する
node test/desktop-audit.mjs <fixture-root> <evidence-directory>
```

判定を行うauditはレビュー実行・ファイル修正・テスト実行を行わない。上のnode:test結果は元チャットが実際に実行した結果であり、監査スクリプトが再実行したものではない。
