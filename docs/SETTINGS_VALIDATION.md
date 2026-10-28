# 共通モデル設定とGUIの検証

検証日: 2026-10-19 (JST)。Windows / Node.js 24.12.0、Claude Code 2.1.302、Codex CLI。

## 実装

- 保存先: `%USERPROFILE%\.revloop\settings.json`。version=1、codex/claudeそれぞれmodelとeffortを持つ。
- 既定値: `gpt-6-astra / medium` と `opus / medium`。
- `settings` は常駐不要のローカルWeb GUIを別プロセスで起動。15分無操作、または終了ボタンで閉じる。`config` は読み取り専用。
- 両デスクトップのユーザー共通Skillへ設定画面への導線を追加。通常チャットのモデル選択はrevloop設定を編集するものではないため、専用GUIを採用した。
- Codexのモデル・推論強度は公式App Server `model/list` から確認。保存時と実推論前に組み合わせを検証する。Claudeは現在のサブスク診断対象であるOpusに限定。
- レビュー開始時に設定を固定し、その回の実行引数と履歴へ保存。次のレビューで再読込する。再レビュー時は既存reviewer sessionを維持しつつ引数を明示する。
- 課金ガード、確認記録の24時間期限、各回・推論直前の再確認、Claude Fast無効、API認証拒否は維持。モデル設定から課金ポリシーを変更できない。

## 実レビュー

独立した2つの小さな検証フォルダーで、sumが誤って減算する不具合をレビューした。レビューを受けてこのCodexデスクトップチャットが修正し、2つのテストが成功した後に同じrunを再レビューした。Claudeデスクトップを作業担当とするレビュー反復の再試験ではなく、今回変更したCLIアダプターの両方向の試験。

| レビュアー | run | 判定 | 実際のモデル・強度 |
|---|---|---|---|
| Codex | 3a20d4dc-83e1-49f2-ab95-2d0482ad17e7 | FAIL → PASS | gpt-6-astra / medium、両回 |
| Claude | 43af341d-2bdd-4ab6-a97a-d593eea5ee5a | FAIL → PASS | claude-opus-5-5 / medium、両回 |

Codexは公式thread/readのmodel/reasoningEffortとローカルrolloutの両turn_contextを確認。ClaudeはローカルセッションのAPIリクエストのoutput_config.effortとassistantのeffort/perTurnEffortを確認。Claudeのservice_tierは両回standard。APIリクエスト形式のログが存在することはAPIキー課金を意味せず、課金可否は別のbilling-checkで判定している。

全4回でbilling-check=ALLOW。Codex残高0・自動補充OFFの有効なユーザー確認記録、Claude使用クレジットOFFと残量を確認。確認記録を更新していない。

証拠: [audit.json](evidence/settings-20261019/audit.json)、provider別のaudit.jsonとround-N/。機密情報や会話全体を転記せず、モデルと強度のメタデータを抽出した。

## GUIと自動テスト

Codexデスクトップのブラウザで両方の強度を高へ変更して保存し、ファイル反映を確認。その後「既定値を入力」→保存で両方中へ戻し、上記実レビューを行った。

Claudeデスクトップの既存「revloop デスクトップ実機検証」チャットへ設定画面の起動だけを依頼。ユーザー共通Skillを読み直し、settingsコマンドを実行、HTTP 200とアプリ内ブラウザでの表示を確認した。「設定を読み込みました」と両方mediumが表示され、ブラウザのコンソールエラーなし。Claude側は保存やレビューを実行していない。CodexのSkillメニューをクリックする試験ではなく、このCodexデスクトップチャットからの起動を確認した。

通常Chromeでも保存済み設定を表示できた。[GUIスクリーンショット](evidence/settings-20261019/settings-gui.png)。

44テスト成功。追加したテストは設定不正・課金フィールドの拒否、競合保存、未対応モデル拒否、初回とresume引数、回の間でmedium→highに変えた場合の反映とセッション維持、壊れた設定で推論前停止、GUI認証・Origin拒否・モデル取得失敗時の保存拒否。

## 回数・タイムアウト設定の追加検証

2026-10-19追記。version 2へ拡張し、loop.maxRounds（1〜50）、loop.stallLimit（1〜10）、loop.timeoutSeconds（1〜3600）を追加。既定値は5・2・300。version 1のモデル選択を保つ互換読込と、旧GUIからの上書き拒否を追加した。

自動テスト48件成功。旧ファイルの移行、境界値・小数・文字列・欠落の拒否、2プロジェクトの新規runへの共通値反映、CLI明示指定の優先、開始後に共通上限を上げても元のrunがMAX_ROUNDS/STALLEDで停止すること、GUI APIでの保存・再読込・不正値の保存拒否を検証した。サブスク限定の既存テストも継続して成功。

この変更の検証でモデル推論は実行していない。実レビューの課金・モデル・同一セッション検証は上記の記録を参照。

GUIで8回・3回・600秒へ変更して保存し、2つの別フォルダーから実CLIのstartを実行。どちらもmaxRounds=8、stallLimit=3、timeoutMs=600000を保持した。証拠: [loop-gui-audit.json](evidence/settings-20261019/loop-gui-audit.json)。検証後はモデル設定を保ち、回数・タイムアウトのみ5・2・300へ戻して保存した。

## 公式仕様

- [Codex設定](https://learn.chatgpt.com/docs/config-file/config-reference): modelとmodel_reasoning_effort。
- [Codexアプリの設定](https://learn.chatgpt.com/docs/developer-settings): アプリ自身の設定とCLIとの共有範囲。
- [Claudeモデル設定](https://code.claude.com/docs/en/model-config): model、effort、環境変数の優先順位、管理ポリシーによる制限。
- [Claudeデスクトップ](https://code.claude.com/docs/en/desktop): Codeのモデル選択はそのセッションに適用。

実機の `codex exec --help`、`codex exec resume --help`、`claude --help` で使用フラグも確認済み。
