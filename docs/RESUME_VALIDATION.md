# 課金・認証BLOCKEDの明示的再開検証

2026-10-19。公開コマンド `resume --root <project> --run <UUID>` を追加。

## 実装範囲

- `review` の終端判定は維持。明示的なresumeだけが現行ポリシーを再確認する。
- 履歴で課金・認証BLOCKEDを確認し、過去のALLOW記録と全完了roundの課金記録からアカウントを照合する。再確認がALLOWでも別アカウントなら拒否。
- 元のrun・セッション・入力範囲・文脈・回数と設定を保持。旧状態・診断・停止ログを `resume-<UUID>/` に退避し、現行診断と結果を追記する。
- 再開後、前回と同じ入力はNEEDS_FIX、変更済み入力はREADY。新しい推論を開始しない。
- STOP、上限、停滞、非課金BLOCKED、ERROR、実行途中のレビューや履歴不足を拒否。部分実行の有無が不明なroundを消したり使い直したりしない。
- Claudeはauth-onlyで `/usage` を呼ばない。Codexの従来ガードは維持。Claude残量・追加利用OFFは未検証。
- プロジェクトとユーザー共通の両ホスト用Skillへ、ユーザーの再開依頼時だけresumeを使う手順を反映。

## 自動検証

`npm test`：build成功、76件PASS、失敗0。

新規6件では、旧BLOCKEDの復旧、認証失敗後の明示再試行、アカウント変更拒否、同一セッションでの修正後再レビュー、過去入力の停滞、STOP・ロック・上限・非対象状態・部分実行・証拠不足の拒否を検証。公開CLIのfake-provider試験は `auth status` だけを記録し、resume自体の推論なし、通常reviewの自動解除なし、force/上限変更オプションなしを確認した。fake-providerと実モデルの検証を区別する。

4つのインストール済みSkillが生成元と一致。Codex側Skillのquick_validateはPASS。

## 実機の既存run

所有者が指定した対象：`C:\work\unity\Der`、run `b6f6a2e4-4c93-4b75-a5a0-f35d601c3f49`。

```powershell
node C:\work\revloop\dist\cli.js resume --root C:\work\unity\Der --run b6f6a2e4-4c93-4b75-a5a0-f35d601c3f49
```

2026-10-19T06:12:35Z 実行、終了コード0。

- 旧原因：`BILLING_PROBE_FAILED` / `CLAUDE_DIAGNOSTIC_UNVERIFIED`、Claude `/usage` タイムアウト。
- 現行確認：`subscription-auth-only` / ALLOW。同一アカウント照合成功。
- 状態：BLOCKED → READY。
- round数：3のまま。maxRounds=5、残り2回。
- reviewerSession：`94ecb18a-c91e-400a-9d9e-460ace665160` を維持。
- 退避先：対象run内 `resume-586affd6-d465-4ca4-8f85-43af47051e1b/`。
- 退避stateと新stateの機械比較で、変更キーは `status`、`reason`、`billing`、`resumeAttempt` のみ。rounds、scope、context、元チャット情報、制限値などその他すべて一致。

実機では再開処理までを検証した。新しい画像レビュー、画像修正、Unity実行はNOT RUN。READYはレビュー合格ではない。次は元の作業チャットで同じUUIDのreviewを実行する。
