# デスクトップとCLIの6.1 Solモデル一覧の差

2026-10-19 JST。

## 原因と対応

PATHではnpm版Codex CLI 0.153.4がデスクトップ付属CLIより優先されていた。デスクトップ付属CLIは0.163.0-alpha.10.2。同じCODEX_HOME・ChatGPTアカウント・ユーザー設定で公式App Serverのmodel/listを比較した結果:

- npm CLI 0.153.4: Astraと5.6系のみ。includeHidden=trueでも6.1 Solはない。
- デスクトップ付属0.163.0-alpha.10.2: gpt-6.1-sol、gpt-6-sol、gpt-6-lunaも返す。
- 公式npm安定版0.163.0を隔離フォルダーで検証: 6.1 Solを返し、revloopのdoctorも成功。
- 新版でモデル取得した後でも、旧0.153.4は旧一覧を返した。単なる共有キャッシュの更新だけでは解消しなかった。

同じアカウントのfingerprintとサブスク認証を確認し、PATHのnpm CLIを公式安定版0.163.0に更新した。デスクトップアプリ、認証情報、追加利用設定は変更していない。revloopのモデル検証を迂回せず、実際のモデル一覧に6.1 Solが現れることを確認した。

更新に使用したコマンド: `npm install --global @openai/codex@0.163.0 --no-audit --no-fund`。revloop自身がCLIを自動更新する機能は追加していない。

## GUIと実行結果

GUIでAstraと6.1 Solの両方が選択可能になり、6.1 Sol / mediumを選択して保存した。

実レビューは **ERROR**。run `48fa6402-e0a7-4a21-aff2-2fdb2403bea7`、session `01a1517e-e498-7930-bebd-f77e8940d6a9`。

公式thread/readでも設定がgpt-6.1-sol / mediumであることを確認したが、サービスから `Selected model is at capacity. Please try a different model.` が返り、レビュー結果は得られなかった。これはモデルが実際に推論を完了した証拠ではない。修正・再レビューはNOT RUN。別モデルへの切替、終端runの作り直し、追加クレジット利用による回避は行っていない。

実行直前のbilling-checkはALLOW、ChatGPT個人サブスク、creditBalance=0、hasCredits=false、残量あり、自動補充OFFの有効なユーザー確認記録。同じ確認記録を維持し、自動更新していない。

この試験で、revloopがstderrのPowerShell警告を主エラーとして表示し、stdout JSON内のサービスエラーを隠していたことも判明。非ゼロ終了時のCodex JSONエラーを優先表示するよう修正し、実際の失敗ログを新デコーダーで読み直して容量不足が表示されることを確認した。タイムアウト等のプロセス制御エラーは引き続き優先する。

検証後は共通設定をAstra / mediumに復元。Claudeとループ上限は変更していない。自動テスト49件成功。

証拠: [診断](evidence/sol61-20261019/diagnosis.json)、[実行監査](evidence/sol61-20261019/audit.json)、[GUIで選択・保存した画面](evidence/sol61-20261019/gui-sol61.png)、[テスト](evidence/sol61-20261019/tests.txt)。

公式仕様: [Codexモデル](https://learn.chatgpt.com/docs/models) は `gpt-6.1-sol` のCLI選択を案内している。モデル一覧への掲載と、一時的なサービス容量や実行成功は別の判定である。
