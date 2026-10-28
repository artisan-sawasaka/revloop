# サブスク枠内でレビューを実行する方法の再調査

2026-10-18の調査記録。この調査後、条件付き実行を実装し両デスクトップで検証した。現在の仕様は[BILLING_SAFETY.md](BILLING_SAFETY.md)を参照。以下は実装前の調査時点の内容。

## 結論と前回の訂正

アカウント側の追加利用禁止を確認し、対象プランに含まれる通常モデルを使う方法がある。**実行単位の「no-credit」フラグがないだけで一律停止する必要はない。** 前回はアカウント側の禁止とCLI側の制御を混同し、過剰な条件を設定した。

現実装の `requireIncludedBilling()` は条件に関係なくthrowするためレビューが使えない。これは暫定ガードの実装上の制約であり、公式CLIでサブスク枠を使うことが不可能という意味ではない。この調査では実行許可ロジックはまだ変更していない。

## 実際に得られた情報

| 対象 | 確認方法 | 結果 |
| --- | --- | --- |
| Claude Max・CLI 2.1.302 | 非推論の対話CLIで組込み `/usage` | `Usage credits are off` を明示的に取得。セッション2%、週間7%、Fable週間5%使用 |
| Claudeの設定画面 | Desktopの使用量設定を読み取り | 使用クレジットOFF、残高$0、自動再読込みOFFを再確認 |
| Claude診断の推論有無 | `/usage` のSession欄 | API時間0秒、入力0・出力0・cache read 0・cache write 0、cost $0.0000 |
| Codex | 公式のrate-limit情報 | ordinaryUsageAllowed=true、週間15%使用、credits.hasCredits=false、unlimited=false、balance=0 |
| Codex自動補充 | このチャットでユーザーが確認して回答 | OFF。APIによる自動取得ではなくユーザー確認である |

Claude診断の証拠: [claude-usage-tty.json](evidence/billing-20261018/claude-usage-tty.json)。診断専用セッションは終了済み。レビュー、テスト用モデル呼出し、APIキーへの切替、アカウント設定変更はしていない。

## Claudeに使える方法

公式説明は、使用クレジットを無効にするとプラン内の利用だけになると明記している。[Manage usage credits](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans)

実機で確認した診断起動:

```powershell
claude --safe-mode --strict-mcp-config --tools '' --permission-mode dontAsk --ax-screen-reader
# 起動した対話CLIへ、組込みコマンド /usage を送る
```

これにより、対象CLIのログインに対応するusageと追加利用OFFを読めた。`claude -p /usage` の機械出力は検証していないため代用しない。実装時はWindows ConPTY（例えば[microsoft/node-pty](https://github.com/microsoft/node-pty)）で対話CLIを起動し、端末を正しく描画・解釈する必要がある。ANSIイベントを単純検索すると、古い表示や更新中の数字を採用する危険がある。

許可条件の案:

1. CLIの認証が対象のclaude.aiサブスクアカウントで、APIキー・独自gateway・別クラウドへの切替がない。
2. 最新のusage表示に `Usage credits are off` があり、利用するモデルに対応した枠が残っている。
3. 対象プランに含まれる通常モデルを明示する。Fastモードは公式の `CLAUDE_CODE_DISABLE_FAST_MODE=1` で無効化する。[環境変数](https://code.claude.com/docs/en/env-vars)
4. 診断のタイムアウト、表示形式変更、認証不一致、`Showing last-known usage` など古いデータしか得られない状態なら停止する。[usageのキャッシュ挙動](https://code.claude.com/docs/en/costs)
5. 実レビューが利用上限エラーを返したら再試行せず停止し、クレジット購入・有効化・モデル切替・API認証への切替を行わない。

Fastモードは残量があっても使用クレジットを使う。Fableや一部1Mモデルにもプラン依存のクレジット条件があるため、単に「サブスク認証」「残量あり」だけでモデルを無制限に許可しない。[Fast mode](https://code.claude.com/docs/en/fast-mode)、[Model configuration](https://code.claude.com/docs/en/model-config)

`DISABLE_EXTRA_USAGE_COMMAND=1` は購入コマンドを隠すだけなので、追加利用OFFの確認の代わりには使わない。

## Codexに使える方法

公式料金説明では、追加creditsはプラン内の上限に達した後の継続に使う。通常のサブスク枠とAPI課金は別である。[Pricing](https://learn.chatgpt.com/docs/pricing)

既存の `account/rateLimits/read` は利用枠・リセット時刻・追加credits残高を取得できる。[App Server](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt)

許可条件の案:

1. ChatGPTサブスク認証。APIキーや別providerへの切替なし。
2. 対象アカウントの自動補充OFFを設定画面または明示的なユーザー確認で確認する。現在はユーザーからOFFの回答を得た。
3. 公式RPCでcredit balance=0、hasCredits=false、unlimited=falseを確認し、対象の利用枠が残っていることを確認する。
4. 毎ラウンド前に最新の残量・credit残高を再取得する。アカウント変更、残高増加、上限到達、取得失敗時は停止する。
5. 設定確認記録は対象アカウント・確認方法・時刻に紐付ける。ユーザー確認を「APIで検証済み」と偽らず、別アカウントへ使い回さない。有効期限と再確認条件は実装時に定める。

Codexの購入済みクレジット消費そのものをOFFにする独立したスイッチは、今回の公式CLI調査では確認できなかった。したがって「自動補充OFFだけで、既存のcreditsも消費しない」とは扱わない。残高がある場合はこの方式では停止する。

この設計は、確認したアカウント設定を実行中に変更しないことを前提にした運用方式であり、CLIの1リクエストごとに課金禁止フラグを渡す方式ではない。変更される可能性まで排除する絶対的な保証とは区別する。

## revloopの修正方針

`BLOCKED` しか返せない現在のモデルを、確認済みの条件を満たす場合に限る許可判定へ変更する。

- ALLOW: サブスク認証、プラン内モデル、追加利用禁止の確認、必要な枠の残量を確認済み。
- BLOCKED: 上限到達、追加credits有効／残高あり、認証不一致、古い／欠落した確認情報。
- 確認手段は区別する: Codex公式RPC、Claudeのバージョン固定TTY診断、ユーザーによる設定確認。
- APIキー拒否・最大回数・停滞・停止・同一reviewer sessionは維持する。
- 各サービスは上限到達時に進行中ターンを短く完了させる猶予を設けることがある。revloopは上限の検出後に新しいラウンドを開始しない。猶予を一律に従量課金とみなさない。[Claude wrap-up](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)、[Codex pricing](https://learn.chatgpt.com/docs/pricing)

## 残る実装・検証

- Node.jsからConPTYを扱うClaude診断アダプターと、古い／不正な表示を拒否するパーサー。
- 通常モデル・Fast無効の固定、アカウント照合、Codex設定確認記録の取扱い。
- 現在の無条件throwを条件判定に変更し、残量不足・OFF→ON・アカウント切替・CLI形式変更のテストを追加する。
- 条件付き許可を実装した後の実AI再レビューはNOT RUN。今回の調査では課金ガードを解除していない。
