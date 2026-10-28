# プロバイダー別の実行条件

## 現在の方針（2026-10-19更新）

所有者の「/usageがタイムアウトするため、このチェックを外して」という指示により、Claudeのレビュー開始条件から `/usage` 診断を外した。`billing-check --provider claude` と各レビュー前の確認は `claude auth status` だけを使う。claude.ai / firstParty / Max、APIキー等のルーティング競合なし、同一アカウントを検証する。Fast無効とOpus指定は維持する。

Claudeのpolicyは `subscription-auth-only`。quotaUsedPercent=[]、paidUsageDisabled=nullとし、追加利用OFFや残量を確認したとは記録しない。warningsに未確認と、Claude側で追加利用OFFを維持する必要があることを記録する。サブスク認証だけでは追加利用の消費を防げないため、追加利用ONの場合の従量利用ゼロは保証しない。上限や認証エラーをCLIが返した場合は従来どおり停止し、別の課金方式へ切り替えない。

Codexの残量・残高0・自動補充OFF確認は変更していない。現行の判定条件・操作手順・実行フローは、この「現在の方針」節の下位見出しにまとめる。2026-10-18の旧方式は末尾の「以前の方式と検証履歴」節だけに隔離する。旧パーサーは過去の診断データ用に残るが、レビュー経路から呼ばない。

撤去直後の検証: 自動テスト69件成功。偽CLIを使ったレビュー経路の試験で、認証確認・doctor・print以外の呼び出しがなく、TTY /usageを起動しないことを確認。API認証・APIキー競合は引き続き拒否する。実アカウントの認証チェックも推論なしで確認する。

公式根拠: [Claudeのusage credits](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans) は、追加利用を有効にした場合、サブスク上限後に従量利用へ移行すること、無効時はプラン内の利用のみになることを説明している。

### 現行の判定条件

| レビュアー | 実行前に確認するもの | 確認しないもの |
|---|---|---|
| Claude | claude.ai / firstParty / Max、API・他プロバイダーへの競合設定なし、同一アカウント | /usage、残量、追加利用OFF、追加クレジット残高 |
| Codex | ChatGPT個人Plus/Pro/ProLite、同一アカウント、有効な残量枠が全て100%未満、credit残高0・hasCredits=false・unlimited=false、上限/支出制限未到達、自動補充OFFの24時間有効なユーザー確認 | 自動補充OFF設定そのものの自動取得（ユーザー確認に依存） |

Claudeの認証確認に失敗・診断が古い・未対応プランならBLOCKED。Claudeは残量不明だけではBLOCKEDにしない。Codexの確認不足・期限切れ・上限到達・正の残高はBLOCKED。どちらもアカウント切替はBLOCKEDになる。

### Codexの自動補充OFFの確認

この設定はCLIの公式残量応答から自動取得できない。ユーザーが該当アカウントの設定画面でOFFを確認した時だけ、次を実行する。アカウント設定を変更するコマンドではない。

```powershell
node dist/cli.js confirm-codex-no-auto-reload --acknowledge-off
node dist/cli.js billing-check --provider codex
```

記録先: `%USERPROFILE%/.revloop/billing/codex-auto-reload.json`。アカウント識別子のSHA-256、確認時刻、24時間後の有効期限、根拠がuser-confirmedであることを保存する。生のアカウントIDや認証トークンは保存しない。

24時間経過・アカウント切替でBLOCKEDになる。自動更新しない。OFFの再確認後に上のコマンドを実行する。自動補充をONに変える場合は先に記録を取り消す。

```powershell
node dist/cli.js revoke-codex-confirmation
```

**24時間以内でも、外部で自動補充設定を変更したことを自動検出する機能ではない。** 確認したOFF設定を維持することが運用条件。記録は残量や残高の検査を省略する強制解除にはならない。正の残高・上限到達は毎回拒否する。

### 現行の実行フロー

1. Skillは反対側の billing-check --provider claude|codex を実行する。引数なしは両方を診断する。
2. reviewの各ラウンド前に、Claudeは認証とアカウント照合だけを行う。Codexは認証・残量・credits・確認記録を再取得/再検証する。
3. 推論CLIを起動する直前にも同じプロバイダー別チェックを行い、round-N/billing-check.jsonに根拠を保存する。
4. 条件を満たさなければBLOCKED。推論CLIが利用上限・認証失敗などを返した場合も停止し、自動購入・API認証への切替・無料リセット・別モデルへの回避はしない。
5. STOPマーカー・Ctrl+Cは認証/課金確認中も監視する。

doctorは認証方式とCLI機能の診断で、レビューの実行許可はプロバイダー別のbilling-checkで判断する。startはローカル準備のみ。過去のPASS/ALLOWは新しい呼び出しの許可にはならない。

### 現行の対応範囲と限界

- Claudeの対応はMax / 通常Opus。auth statusの形式と必要なCLI機能を検証する。/usageパーサーのCLIバージョン固定は、本番レビューには適用しない。
- Claudeの追加利用OFFは運用上の前提で、自動検証していない。アカウント側で有効にすると従量利用を防げない。
- Codexの自動補充OFFは確認記録の有効期間内でも外部変更を検出できない。OFF設定を維持することが前提。
- 元デスクトップチャットの推論はrevloopの制御外。元ホスト側でも追加利用OFFを維持する。認証やproxy環境を削除して回避しない。
- 設定チェックに合格しても、認証の失効やサービス側の容量不足などで実際の呼び出しが失敗する場合がある。

## 以前の方式と検証履歴

この節と以下の下位見出しは2026-10-18当時の記録であり、現在の実行条件や保証ではない。特にClaudeの残量検査・対話診断・パーサーのバージョン固定は廃止済み。現行のCodex確認手順は上の「現在の方針」を参照する。

今回の記録は、このチャットでのユーザーの「OFFになっている」という回答に基づく。有効期限は2026-10-19 17:10 JST。以後の自動更新はしていない。

2026-10-18。常にBLOCKEDだった暫定版を、以下を確認できた時だけALLOWする実装に変更した。判断条件を満たせない場合は推論前に止める。アカウントの追加利用設定を実行中に変更しないことが前提。

### 判定条件

| レビュアー | ALLOWする条件 | 確認手段 |
| --- | --- | --- |
| Claude | claude.ai / firstParty / Max、使用クレジットOFF、セッションと週間枠がともに100%未満、同じアカウント | auth statusの前後照合と対話CLIの組込み `/usage` |
| Codex | ChatGPTの個人Plus/Pro/ProLite、残高0・hasCredits=false・unlimited=false、全取得枠が100%未満、自動補充OFFの有効なアカウント別確認 | 公式account/read・account/rateLimits/read＋ユーザー確認記録 |

Claudeの診断パーサーは **2.1.302のみ検証済み**。別バージョン、表示変更、古いデータ、更新中、認証失敗、空欄、信頼確認ダイアログ、タイムアウトは停止する。通常Opusを指定し、子プロセスに `CLAUDE_CODE_DISABLE_FAST_MODE=1` を設定する。Fastや課金前提の別モデルへ切り替えない。

Codexの追加クレジットが存在する場合、自動補充OFFでも実行しない。取得失敗、上限到達、アカウント・プラン不一致、期限切れ確認、停止要求でも実行しない。

### 旧方式の実行フロー

1. Skillは呼び出す相手の `billing-check --provider claude|codex` を実行する。引数なしは両方を診断する。
2. `review` は各ラウンド前に生の残量情報を再取得し、以前と同じアカウントか照合する。
3. 実際の推論CLIを起動する直前にも再チェックする。各回の `round-N/billing-check.json` に根拠を保存する。
4. 不成立ならBLOCKED。上限エラーや認証エラーを修正指示FAILとして扱わず、反復を止める。自動購入、API認証への切替、無料リセット権の自動消費はしない。
5. STOPマーカー・Ctrl+Cは課金診断中も監視する。

`doctor` の成功は認証・CLI機能の確認だけで、課金のALLOWではない。`start` はローカル準備のみ。完了済みPASSは過去の結果であり、次の実行許可には使わない。

Claudeの対話診断は既に信頼されている元の起動フォルダで行う。別フォルダをレビューするときも、起動フォルダは維持し `--root` で対象を指定する。レビュー資料は一時フォルダで隔離し、診断のために一時フォルダを自動で信頼しない。

### 旧方式の対応範囲と限界

- 当時実証した環境: Windows x64、Node.js 24.12.0、Claude Code 2.1.302 / Max、Codex 0.153.4 / ProLite。
- Claudeの他プラン・他CLIバージョンは確認不能として停止。パーサーの検証を追加してから対応する。
- UI生出力には更新前の値が混ざるため、node-ptyのConPTYとxterm/headlessで現在の画面を再構成して読む。過去のANSI出力の単純検索ではALLOWしない。
- 元デスクトップチャットへ送信した時点の推論はrevloopの制御外。元ホストの追加利用もOFFを維持する必要がある。元Claudeデスクトップの内部proxy環境を削除してCLIを再起動することはしない。
- サービス側は上限到達時に進行中の応答を短く終える猶予を設ける場合がある。これを自動で従量課金とみなさない。新しいレビューラウンドは上限検出後に開始しない。

### 検証結果

- 自動テスト: 37件PASS。OFF確認の一致・期限、ONの確認記録、正の残高、上限100%、古い/不正な画面、API認証、別アカウント、停止マーカーなどを検証。
- [Codex元デスクトップ→Claude](evidence/conditional-billing-20261018/codex/audit.json): 2回でFAIL→PASS、3テスト成功、両ラウンド直前ALLOW。
- [Claudeデスクトップ→Codex](evidence/conditional-billing-20261018/claude/audit.json): 追加の続行指示なしで2回のFAIL→PASS、3テスト成功、両ラウンド直前ALLOW。
- いずれも元IDと相手IDを維持し、テスト内容不変、入力SHA-256と現ファイル一致を確認。
- Claudeデスクトップの元transcriptも監査し、途中中断なし・status結果後の編集・テスト後の再レビューを確認。Claudeレビュアーの実応答では両ラウンドともOpus 5.5 / Fast OFFを確認した。[実行時モデル](evidence/conditional-billing-20261018/claude-runtime.json)
- 初回の一時フォルダでの診断は信頼確認でBLOCKED・レビュー0回になった。起動フォルダを分離した修正後に独立したfixtureで再検証。信頼設定を自動承認していない。
- 実アカウントの残量を意図的に使い切る試験や、追加利用ONへの変更は行っていない。上限・ON・取得失敗は非課金のテストデータで検証。

Claude元デスクトップの権限表示は前回ユーザー承認後の「権限をバイパス」。今回も変更していない。レビュアー側の読み取り専用・ツール制限は維持。Codex側はこの元デスクトップチャットでSkillを実行し、メニュークリック自体は未検証。

### 根拠

- [Claude使用クレジット](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans): 無効化するとプラン内利用に限定される。
- [Claude costs](https://code.claude.com/docs/en/costs): usage表示と古い表示の扱い。
- [Claude環境変数](https://code.claude.com/docs/en/env-vars): Fast無効化。購入コマンド非表示は課金禁止の代用にしない。
- [Codex App Server](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt): 残量・credits情報。
- [Codex pricing](https://learn.chatgpt.com/docs/pricing): サブスク枠と追加creditsの区別。
