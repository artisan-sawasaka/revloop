# revloop

Windows向けの、Claude CodeとCodexの相互レビューツール。TypeScript / Node.js製。元チャットのAIが修正し、反対側のCLIが独立したセッションでレビューします。

**Claudeはサブスク認証を確認して実行し、`/usage` は呼びません（2026-10-19の所有者指示）。** Claudeの追加利用OFFと残量は自動検査しないため、Claude側で追加利用OFFを維持してください。APIキーへのフォールバックはしません。Codexは従来どおり残量・残高0・自動補充OFFの確認を必須とします。[現在の確認条件と検証記録](docs/BILLING_SAFETY.md)

**入口はClaude Codeで `/revloop`、Codexデスクトップでは「revloopスキルを使って…」です。** Codex CLI / IDEでは `$revloop` または `/skills` を使います。Codex CLI 0.153.4では `/revloop` は未認識でした。[公式Codex Skills](https://learn.chatgpt.com/docs/build-skills) / [公式Claude Skills](https://code.claude.com/docs/en/skills)

## セットアップ

Node.js 22以上、Git、両方の公式CLIが必要です。実機確認: Windows、Node 24.12.0、Codex 0.153.4、Claude Code 2.1.302。CLIをrevloopから勝手に更新しません。

```powershell
cd C:\work\revloop
npm ci
npm run build
# Codexの自動補充OFFをユーザーが確認した後だけ実行（24時間有効）
node dist/cli.js confirm-codex-no-auto-reload --acknowledge-off
node dist/cli.js billing-check
node dist/cli.js doctor
# このWindowsユーザーの全ローカルプロジェクトへ入口を登録（1回だけ）
node dist/cli.js install --global
```

`install --global` は現在のユーザーのホームへ登録します。プロジェクトごとのインストールは不要です。

- Codex: `%USERPROFILE%\.agents\skills\revloop\SKILL.md`
- Claude Code: `%USERPROFILE%\.claude\skills\revloop\SKILL.md`

両デスクトップで対象プロジェクトのローカルチャットを開いて起動します。Skillの場所ではなく、そのチャットのプロジェクトを対象にし、履歴も対象プロジェクトの `.revloop/runs/` に保存します。Git管理するプロジェクトでは `.revloop/` を `.gitignore` に追加してください（インストーラーは既存プロジェクトを変更しません）。Claudeの通常Chat・Cowork・クラウドや別PCにはこの登録は適用されません。Skillが表示されない場合はアプリを再起動してください。

一つのプロジェクトだけへ登録する従来の方法も使用できます。

```powershell
node C:\work\revloop\dist\cli.js install --root C:\work\your-project
```

既存の同名Skillは上書きせずエラーにします。`--global` と `--root` の併用もエラーです。プロジェクト用の設置先は `.agents/skills/revloop/SKILL.md` と `.claude/skills/revloop/SKILL.md`。この開発フォルダには従来の両入口も残しています。ユーザー用とプロジェクト用が重複すると、Codexは両方を候補に表示し、Claudeは個人用を優先します。既存のプロジェクト用Skillを自動削除しません。生成Skillはビルド済みCLIの絶対パスを参照するため、revloopを移動した場合は参照を更新してください。

認証は `codex login`、Claude Code内の `/login` で行います。`doctor` は認証方式と機能の確認だけで、トークンが実際に使えるかはレビュー時に確認します。ChatGPT / claude.ai認証以外やAPIキー等の競合する環境変数がある場合は停止します。APIキーへのフォールバックやOAuthトークンの抽出を行いません。契約枠や追加利用の設定は各CLI・アカウントに従います。

Claudeは `auth status` でclaude.ai / firstParty / Pro or Maxと同一アカウントを確認し、設定されたモデル（Opus／Sonnet、MaxではFableも可）・Fast無効で実行します。`/usage` のタイムアウトで止まる経路はレビューから外しました。確認方針は `subscription-auth-only`、残量は空欄、`paidUsageDisabled` はnullで、未確認であることをwarningsに残します。認証失敗・APIキー等の競合変数は引き続きBLOCKEDです。Codexは `included-subscription-only` として公式APIの残量・残高0、24時間有効のユーザーによる自動補充OFF確認を維持します。

デスクトップからは、呼び出す相手だけを `doctor --provider codex` または `doctor --provider claude` で確認します。Skillにはその選択を組み込んでいます。認証・ルーティング変数の検査も相手CLI別です。例えばClaudeデスクトップに `ANTHROPIC_BASE_URL` が存在してもCodexのレビューを妨げませんが、Claudeをレビュアーとして呼ぶ場合は引き続き拒否します。親・子プロセスの環境変数を削除して回避する実装ではありません。引数なしのdoctorは両方を診断するため、片方だけ利用可能でも終了コード1になります。

PATHで見つからない場合は `REVLOOP_CODEX_PATH` / `REVLOOP_CLAUDE_PATH` に実行ファイル（またはJSエントリ）の絶対パスを指定できます。WindowsのCodex npm shimは隣接する公式JSエントリへ解決します。shell文字列連結はしません。

## モデル・推論強度を変更する

モデル設定はプランごとに独立しています。既定値は **Codex: Free Luna／Plus Sol／Pro Astra、Claude: Pro・Max Opus、推論強度は中（medium）、FastはOFF** です。保存先は `%USERPROFILE%\.revloop\settings.json`。元のデスクトップチャットのモデル設定とは独立しています。

- Codexデスクトップ：「revloopの設定画面を開いて」
- Claude Codeデスクトップ：`/revloop settings`、または「revloopの設定画面を開いて」
- アプリを使わず開く：[revloop-settings.cmd](revloop-settings.cmd) をダブルクリック

```powershell
node C:\work\revloop\dist\cli.js settings
# 設定を見るだけ（推論なし）
node C:\work\revloop\dist\cli.js config
```

専用のローカルWeb GUIが開きます。「設定を保存」で反映し、「既定値を入力」は保存するまで反映しません。Codexのモデル候補は公式CLIのmodel/listから取得し、取得失敗時は保存できません。GUIはモデル推論を行いません。通常ブラウザーを開けないホストでは `settings --no-open` の返すURLを開いてください。画面は15分操作がないと終了します。期限切れ時はsettingsコマンドで開き直してください。

各レビュー開始時に最新設定を読み、モデルと推論強度をCLIに明示的に渡します。同じセッションの再レビューにも適用し、各回の `state.json` 内roundsと `round-N/invocation.json` に保存します。実行途中の変更は次の回から適用します。設定不正・Codexの未対応モデルや推論強度は停止し、別モデルへフォールバックしません。既存runにも次のレビューから適用します。

ClaudeはProでOpus／Sonnet、MaxでOpus／Fable／Sonnetから選べます。FableのMax専用枠を使い、追加利用OFFをClaude側で維持します。推論強度は低・中・高・非常に高い・最大から選べます。Codexは取得したモデルごとの対応範囲内で選びます（自動委譲を伴うultraは提供しません）。CLIや管理ポリシーが強度を制限する場合があります。認証チェック、Codexの課金ガード、Claude Fast無効は設定画面から変更できません。Codexの自動補充OFF確認記録も別管理で、自動更新しません。

GUIは127.0.0.1の一時ポートだけで待受し、起動ごとのトークンで読み書きを制限します。外部Origin・不正Host・競合保存を拒否します。壊れた設定ファイルは既定値で上書きせずエラーにするため、内容を修復してから開き直してください。

両CLIの再レビュー・GUI保存・実際に使用されたモデルと推論強度の検証は [設定機能の検証記録](docs/SETTINGS_VALIDATION.md) を参照してください。

デスクトップで使えるモデルがCLIに出ない場合は、`codex --version` と `Get-Command codex -All` でPATH上のCLIを確認してください。この環境では旧npm CLI 0.153.4が優先されており、公式安定版0.163.0への更新で6.1 Solの選択が可能になりました。[原因・実機検証と容量不足エラー](docs/SOL61_CLI_VALIDATION.md)

### プラン別のモデル・推論強度

各カードの「編集するプラン」で個別にモデル・推論強度・Fastを設定します。共通モデル設定や継承はありません。CodexはFree／Plus／Pro、ClaudeはFree／Pro／Maxだけを表示します。

| プラン | Codexのモデル候補 | Claudeのモデル候補 |
|---|---|---|
| Free | Luna（CLIの利用権・残量を実行前に確認） | Sonnetを表示、Claude Code CLIは利用不可 |
| Plus | Sol、Astra、Terra | プランなし |
| Pro | Sol、Astra、Terra（ProLiteもこの設定） | Opus、Sonnet |
| Max | プランなし | 優先順：Opus → Fable → Sonnet |

[OpenAI公式プラン案内](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)ではFreeもCodex対象で、CLIへのChatGPTログインを案内しています。revloopのFree候補はLunaに限定します。実際の利用権はCLIでも確認します。[Claude公式認証案内](https://code.claude.com/docs/en/authentication)では個人向けClaude CodeはPro／Maxのため、Freeのモデル・強度・Fast編集は無効です。[MaxにはFable専用の週間枠があります](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans)。追加利用OFFの自動検証は行いません。

編集対象の選択でログインや契約プランは変わりません。各回で認証された実際のプランに対応する設定を選び、使用プランとモデル・強度をroundsに記録します。未対応・不明なプランや実行直前のプラン変更は停止し、別プランや別モデルにフォールバックしません。Maxの優先順はメニューの順序で、自動切替ではありません。

Codexの候補はrevloopのプラン別メニューと現在のCLI一覧の両方で制限し、推論強度もモデルの対応範囲内から選びます。他プランの利用権を保証するものではなく、契約変更後は再読み込みが必要です。保存APIでもプランの対応表と編集したCodex設定を検査し、現在の一覧にある保存済みモデルの強度・Fastも検査します。現在の一覧にない未変更の設定は、他プランやログの保存を妨げず保持します。実行直前には選択されたモデル・強度・Fastを必ず確認します。Claudeの強度は最新モデルの対応範囲を表示し、公式CLIや管理ポリシーによる制限も受けます。

### Fastモード

Codexは、選択モデルのFast対応が公式CLIのモデル一覧で確認できる場合だけONにできます。Plus／Proの個別設定に保存し（FreeはStandardのみ）、、各回の設定記録にも残します。ONは明示的にFast、OFFはStandardをCLIへ渡し、再レビューでも前回のFastを引き継ぎません。モデルを変更した場合はFastをOFFに戻します。対応情報がなくなった保存済みFastはOFFへ戻せますが、ONのままの保存・実行は拒否します。

[OpenAI公式Speed案内](https://learn.chatgpt.com/docs/agent-configuration/speed)によるとCodex Fastはサブスク枠を通常の2.5倍消費します。残量・残高0・自動補充OFFの確認を引き続き必須とし、Ultrafastは提供しません。

[Claude公式Fast案内](https://code.claude.com/docs/en/fast-mode)では、Pro／MaxでもFastは追加クレジット専用で、Sonnet／Haikuは非対応です。既存の課金ガードを維持するため、ClaudeのFastは理由を表示してONを無効にし、設定ファイルやAPIからのONも拒否します。子プロセスのFast無効化も維持します。

### 回数・タイムアウトの共通設定

同じGUIで次の3項目も変更できます。

| 項目 | 初期値 | 設定範囲 |
|---|---:|---:|
| 最大レビュー回数（初回を含む） | 5回 | 1〜50回 |
| 同じ指摘が連続した場合の停滞検出 | 2回 | 1〜10回 |
| 各回のレビュアーCLIのタイムアウト | 300秒 | 1〜3600秒 |

回数・タイムアウトは **新しく開始するrunに適用** します。実行中のサイクルでは現在の上限を維持し、回数上限で停止した後にユーザーがrevloopを再実行すると、今回のカウントを0に戻して共通設定の最大回数を読み直します。停滞回数とタイムアウトは既存runの値を維持します。モデル・推論強度の「次の再レビューから適用」とは異なります。`start` に明示した `--max-rounds`、`--stall-limit`、`--timeout-seconds` は開始時の共通設定より優先します。最大回数は新サイクルへの移行時に共通設定へ更新します。入力が前回と同じ、または過去の入力に戻った場合の即停止、強制停止、課金確認の停止条件は独立して維持します。課金確認には別の診断タイムアウトがあります。

設定ファイルはversion 7で、プラン別の `planProfiles` に加えて、`loop: {maxRounds, stallLimit, timeoutSeconds}` と `logging: {enabled, chatEnabled}` を保存します。旧version 1〜6の共通値は、継承していた有料プランの個別設定へコピーします。既存の個別設定・回数・ログの選択を保持し、Freeは既定値を追加します。メモリ上だけで移行し、画面で保存するとversion 7になります。新しい候補から外れた旧モデルはエラーにして、黙って別モデルへ変えません。旧画面からの書き戻しは拒否されるため、更新前に開いた画面はsettingsコマンドで開き直してください。

### 簡易ログ出力

利用枠の使用率・残量も取得できた範囲で%表示します。Codexは課金確認で取得した実行直前の使用率と、実行後に読み取り専用で再取得した使用率の差を「増加の目安」として記録します。Claudeはレビューのstream-jsonに含まれるrate_limit_eventを受動的に読み、前回のレビュー終了時の観測値との差を使います（初回や未取得時は増加不明）。枠ごとに表示し、同時実行・反映遅延・Claudeのレビュー間の利用も含み得ます。増加は%ポイント、残量は100−使用率です。リセット時刻が変わる・使用率が減る・値が欠ける場合は差分不明とします。トークンから%を推測せず、Claudeに /usage や追加の推論を実行しません。使用率取得の失敗だけでレビューを失敗にせず、既存の認証・課金ガードは維持します。Claudeの残量を実行許可条件として検査する仕組みは追加していません。各roundとファイルログの quotaUsage に前後の観測値を保存します。

各回のレビュアーCLIが返すトークン使用量も記録します。`state.json` の各roundと `rounds.jsonl` に `tokenUsage`（入力・出力・合計・キャッシュ読込／作成・推論）を保存し、チャットログにも表示します。入力はキャッシュを含み、キャッシュと推論は内訳のため合計に重ねて加算しません。Claudeはその呼び出しの `usage`、Codexは `turn.completed` の `usage` を使い、セッション累積の `modelUsage` や金額から推測しません。エラー時も取得済みの使用量を残します。CLIが返さない値・旧履歴は不明（null）、使用量全体がないファイルログは `tokenUsage:null` です。CLI報告値であり、課金額やサブスク残量を表すものではありません。過去のログの書き換えはしません。ファイル出力OFFでもstate経由でチャット表示でき、チャットOFFでも有効なファイル出力は維持します。

設定画面の「簡易ログのファイル出力」（`logging.enabled`）でON／OFFを変更できます（既定ON）。次のレビュー開始時に読み直し、各回の終了時に `.revloop/runs/<UUID>/rounds.jsonl` へ1行のJSONを追記します。サイクル番号・今回／累計のレビュー回数・終了状態・生判定と実効判定・指摘件数・各指摘の重要度／ファイル／行／内容を記録し、異常終了した試行も理由を残します。元チャットの修正作業や会話全文は含みません。実行中に設定を変更した場合は次の回から適用します。

OFFの間は簡易ログを追記せず、ONに戻しても過去の回を補完しません。既存ログは削除せず、再開・診断用の `state.json`、`history.jsonl`、各回の入出力は引き続き保存します。簡易ログの保存に失敗した場合はCLIの `roundLogError` で通知し、レビュー結果は維持します。保存したファイルの絶対パスは `roundLogFile` で返します。

### 終了後にチャットへログ表示

「終了後にチャットへログ表示」（`logging.chatEnabled`、既定ON）はファイル出力とは独立した設定です。`start`・`review`・`status`・`stop`等のrun出力には `chatLog: {enabled, text}` を返します。ONでは今回／累計の回数、各回のレビュー判定・指摘件数・重要度／ファイル／行／内容をCLIが表示用テキストにまとめます。生判定と実効判定の相違、失敗・未完了の回、停止理由も区別します。元チャットの会話全文や修正内容の推測は含みません。

更新済みのCodex・Claude用スキルは、最終報告前に同じrunの `status` を読み直し、ONなら `chatLog.text` を一度だけコードブロックとして表示し、OFFなら各回の経過ログを省略します。終了時の設定を適用するため、実行中の変更や過去runへの変更も反映します。`rounds.jsonl` ではなく保存状態から生成するため、ファイル出力OFF／チャット表示ONも可能です。チャット表示OFFでも最終結果・回数・修正やテストの要約・停止理由・必要な次の操作・ログ保存エラーは報告します。ツール実行結果や作業中の進捗表示を隠す設定ではありません。

設定を読めない場合は実際のrun結果を維持し、`chatLog.enabled: null`、空の `text` と `chatLog.error` を返します。スキルはこの制約を報告し、表示設定を推測しません。CLIの結果に `chatLog` がない失敗時も、runがあれば `status` で取得します。新規インストール用のスキルにも同じ指示を含めています。チャット表示はホストAIによる指示の実行に依存し、アプリのUIへ強制挿入する機能ではありません。以前から読み込み済みのチャットは古い指示を保持する可能性があるため、更新したスキルを読み直して使用してください。

## チャットで使う

Claude Codeで `/revloop`、Codexデスクトップで「revloopスキルを使って、今回変更したファイルをレビューし、FAILなら修正・再レビューしてください」とレビュー対象を指定してください。Codex CLI / IDEは `$revloop` です。Skillが文脈を整理し、run作成→レビュー→元チャットで修正→再レビューを行います。デフォルトは最大5回、同じ指摘が2回続くと停滞、各回5分のタイムアウトです。入力が前回と同じ、または過去の入力へ戻った場合は追加の推論をせず停止します。

元チャットを外部からresumeする処理はありません。反復の修正部分は元AIがSkillに従って進めます。CLIだけを起動しても修正AIは起動しません。ホストがターンを中断した場合の自律継続は保証しません。同じチャットでrun IDを指定して続行できます。終端状態のrunを自動で作り直して上限を回避しません。

この環境ではClaudeデスクトップの `/revloop` 選択から、FAIL→元Claudeで修正・テスト→再レビューPASSまで追加指示なしで実証済みです。元Claudeの権限はユーザー許可後の「権限をバイパス」表示で検証しています。revloopがアプリの権限設定を変更することはありません。元チャットにはCLI実行と編集の権限が必要です。

Codex側も、この元デスクトップチャットで導入済みSkillを使い、Claudeにレビューを依頼して元チャットで修正し、同じClaude IDでPASSへ到達しました。アプリのSkillメニューのクリック操作は未検証です。別プロセスCodexを作業担当として起動する旧試験のread-only制約とは区別しています。詳しくは[デスクトップ検証記録](docs/DESKTOP_VALIDATION.md)を参照してください。

## CLIを直接使う

### 回数上限後に再実行する

上限で停止した後、同じチャットでrevloopを再度呼び出すと、同じrunの新サイクルを開始します。追加の例外許可や新runの作成は不要です。

```powershell
node C:\work\revloop\dist\cli.js review --root C:\path\to\project --run <UUID>
# 新サイクルの開始だけを明示する場合も同じ動作
node C:\work\revloop\dist\cli.js restart --root C:\path\to\project --run <UUID>
```

MAX_ROUNDSに対するこの呼び出しは、新サイクルの開始だけを行い、モデル推論は行いません。`reviewCount` は0、`maxRounds` は現在の共通設定になります。例えば5回で停止した後に共通設定が10回なら「今回0/10回、累計5回」です。次のレビューは今回1回目・累計6回目になります。履歴フォルダの `round-N` は累計番号を維持します。

未解消指摘・レビュアーセッション・入力範囲と文脈・全レビュー履歴を引き継ぎ、以前の状態・停止ログを `restart-<UUID>/` に保存します。入力が未変更ならNEEDS_FIXに戻るため、元チャットで修正してからレビューを続けます。変更済みならREADYです。現在の認証・課金条件と同一アカウントを再確認し、確認失敗時はカウントをリセットせず、理由とログを返します。

同じ自動ループ内では上限到達時に停止します。新しいユーザー呼び出しが新サイクル開始の合図です。STOP・停滞・ERROR・資料不足のBLOCKEDはこの処理では解除しません。繰り返し入力や同一指摘の停滞履歴も保持します。共通設定の保存だけでは停止中のrunを自動起動しません。

### 過去の課金・認証BLOCKEDを再開する

認証の復旧やポリシー変更後、ユーザーが再開を依頼した場合は、同じrunを次の公開コマンドで再確認できます。

```powershell
node C:\work\revloop\dist\cli.js resume --root C:\path\to\project --run <UUID>
```

`resume` 自体はモデル推論も修正も行いません。現在のレビュアー認証・課金ポリシーと過去のアカウントを照合し、旧状態・課金診断・停止ログをrun内の `resume-<UUID>/` に保存します。元のrun UUID、レビュアーセッション、レビュー履歴、範囲、回数上限・停滞回数・タイムアウトを維持します。旧 `/usage` タイムアウトも対象です。Claudeは現在のサブスク認証方式を使い、`/usage` は呼びません。残量・追加利用OFFを確認したという意味ではありません。Codexの課金ガードは従来どおりです。

- `READY`：修正済み入力で、同じUUIDの `review` を実行できます。
- `NEEDS_FIX`：入力が前回と同じです。元の作業チャットで `status` を確認して指摘を修正し、同じUUIDで再レビューします。
- 再確認失敗：`BLOCKED` を維持し、理由と試行ログを保存します。

通常の `review` はBLOCKEDを自動解除しません。STOPマーカー、回数上限、停滞、レビュアー判断のBLOCKED、ERROR、実行途中のレビュー、履歴やアカウント証拠の不足は再開を拒否します。`--force` や回数リセットはありません。状態ファイルの手動書き換えは不要です。`recover` は放置されたロックをERRORとして閉じる別操作です。

### 画像の視覚レビュー

PNG・JPEG・WebPを `--file` で対象に含めると、ファイル内容を画像として両CLIへ添付します。チャットでは「revloopで `Reference.png` と `Candidate.png` を視覚レビューして」と、画像と受入条件を指定してください。元チャットに画像を表示しただけでは反対側CLIに渡りません。

```powershell
node C:\work\revloop\dist\cli.js start --root C:\work\your-project --source codex --context context.md --title '画面比較' --visual --file Reference.png --file Candidate.png
```

`--visual` は画像がない状態での開始を拒否します。画像を指定したrunは自動的に視覚レビュー必須になります。対応は静止画のみ、最大8枚、1枚3.5 MB、合計16 MB、各辺4096px・1600万画素まで。画像は縮小・切抜きせず保存・添付しますが、モデル側での解像度処理は別です。大きい画像や未対応形式は停止し、黙って除外しません。PDF・動画・GIF・FBX・Blendファイル自体の視覚レビューには未対応です。必要な静止画を用意してください。

Codexは `--image`、Claudeは `--input-format stream-json --output-format stream-json --verbose` の画像ブロックを使用し、シェル・Read・編集ツールの権限は増やしません。サブスク確認は従来どおり各回・推論直前に実行します。再レビューでも同じセッションに最新画像を再添付します。

各回に `images/` とハッシュ・寸法・添付順序を保存し、元画像と保存コピーの差し替えを検出します。画像ごとの具体的な観察結果が揃わない場合はBLOCKED、プロトコル不正や入力改変はERRORです。テキストのみ・過去の記録は全体がPASSでも `visualReview.status=NOT_RUN`。`REVIEWED` はレビュアーが全画像を確認したと報告したことを示し、画素単位の一致や未実施の実機テストの証明ではありません。

検証記録: [画像レビュー](docs/VISUAL_REVIEW_VALIDATION.md)。

実行場所は対象プロジェクト、または `--root` で指定します。

```powershell
# 目的・受入条件・制約・検証結果をUTF-8のcontext.mdに書いておく
node C:\work\revloop\dist\cli.js start --source codex --context context.md --title 'チャット名' --file src/main.ts --file test/main.test.ts
# 出力されたUUIDを使う
node C:\work\revloop\dist\cli.js review --run <UUID>
# NEEDS_FIXなら元チャットで修正し、同じコマンドを再実行
node C:\work\revloop\dist\cli.js status --run <UUID>
node C:\work\revloop\dist\cli.js stop --run <UUID>
```

`--source` は作業担当側です。`codex` を指定するとClaudeがレビューし、`claude` を指定するとCodexがレビューします。`--source-session` は分かる場合だけ元IDを保存します。元タイトルがホストから取得できない場合は説明的なタイトルを指定します。Claudeは `--name`、CodexはApp Serverの `thread/name/set` でレビューセッションを同名化します。Codex側の同名化が失敗してもローカルの対応表は保存し、warningを返します。

Git配下で `--file` を省略すると、trackedと非ignoredのuntrackedをレビューします。非Gitフォルダは `--file` 必須です。対象のstaged/unstaged差分、削除、HEAD、現ファイルを記録します。レビュー範囲が狭い場合、必要な依存ファイルも含めてください。contextはrun中は不変です。要件変更時は停止し、新しい文脈でrunを作成します。

制限: context 64 KB、テキスト入力と画像メタデータ512 KB、最大2000ファイル。テキストはUTF-8、画像は上記の形式・別容量枠で扱います。上限超過、symlink/junction、秘密鍵・典型的な認証ファイル名、対象不存在は停止します。欠落や切詰めによるPASSは行いません。ファイル名検査は一般的な秘密情報の完全検出器ではありません。

## 状態・停止・記録

### 停止理由のログ

BLOCKED・STOPPED・MAX_ROUNDS・STALLED・ERRORでは、CLIの返すJSONに `halt` を含めます。停止理由 `reason`、実行回数と上限、課金判定の理由コード、レビュアーの要約、次に確認すること、各ログの絶対パスを返します。両Skillも停止理由とログのリンクを最終回答へ渡します。

- 終端状態の保存時: `.revloop/runs/<UUID>/halt.json` と `halt.log`。`history.jsonl` にも理由と停止情報を記録。
- 手動停止: `stop-request.log` とJSON形式の `STOP` に要求理由を保存。実行中は `STOP_REQUESTED`、所有プロセスが停止を反映すると `STOPPED`。実行中の `status` が返す `stopPending: true` は停止反映待ち。
- 未実行のrunの停止: ロックを取得できれば、その場でSTOPPEDを保存。完了済みrunをstopしても過去のPASS等を上書きしない。
- run開始前の `billing-check` がBLOCKED: `.revloop/diagnostics/` にJSONとlogを保存し、そのパスを返す。保存に失敗してもBLOCKEDを維持し、元の理由とlogErrorを返す。
- 旧runのstatusでも理由を補って表示し、実在する既存ログへのパスを返す。過去の履歴を自動改変・再実行しない。

```powershell
node C:\work\revloop\dist\cli.js stop --root C:\work\your-project --run '<UUID>' --reason '対象変更の指示があったため停止'
node C:\work\revloop\dist\cli.js status --root C:\work\your-project --run '<UUID>'
```

理由を省略した場合も既定の理由を記録します。課金・上限・停滞の制御は維持し、ログを理由に自動で再開したり上限を回避したりしません。

レビューの `findings` は受入前に必要な修正、`notes` は合否を妨げない参考意見です。参考意見付きPASSは受理します。PASSと要修正指摘が矛盾する場合は、生回答を残して実効FAIL→NEEDS_FIXとし、実行エラーにはしません。FAILなのに修正指摘がない場合はBLOCKEDです。`decision.json` とCLIの `reviewDecision` に生判定・実効判定・警告を保存します。P3を一律に無視する処理はありません。画像確認の完了は全体判定と別に保持します。[判定ルールと皇帝B案の調査](docs/VERDICT_HANDLING.md)

| 状態 | 意味 / 次の処理 |
| --- | --- |
| READY | review開始可能 |
| REVIEWING | CLIレビュー実行中。重複実行不可 |
| NEEDS_FIX | 元チャットで修正し、同じrunを再レビュー |
| PASS | 記録された範囲のレビューを通過 |
| BLOCKED | 課金安全性を確認できず推論前に停止、またはレビュアーが証拠不足と判定 |
| MAX_ROUNDS / STALLED | 上限または停滞。停止 |
| STOPPED / ERROR | キャンセルまたは処理失敗。停止 |

終了コードは通常処理・PASS・NEEDS_FIXが0、BLOCKED/上限/停滞/停止が2、ERRORが1です。stdoutのJSON状態を判断に使ってください。Claudeの `is_error:true` はプロセス終了コード0でもERRORです。

`stop` は停止マーカーを保存し、実行中レビューの子プロセスツリーを終了させます（Windowsは自分が起動したPIDへの `taskkill /T /F`）。修正中の元AIそのものを止める場合はチャットの停止ボタンも使用してください。Skillは修正前に停止状態を確認します。Ctrl+Cとタイムアウトでもレビュープロセスを終了します。

クラッシュでlockが残った場合は `recover --run <UUID>`。生存プロセスのlockは解除せず、停止済みのrunだけERRORとして閉じます。クラッシュ途中のレビューをPASSとして復元しません。

`.revloop/runs/<UUID>/` に以下を保存します。認証・課金ポリシーの確認は元起動フォルダで行います。Claudeの対話型 `/usage` と、その診断用フォルダーの信頼確認は不要になりました。

- `state.json` / `history.jsonl`: 元・相手のセッションID、タイトル、上限、状態遷移。
- `context.txt`: 元チャットの引継ぎ要約。
- `billing-check.json` / `round-N/billing-check.json`: 各実行前のポリシー判定、アカウント指紋、確認方法。Claudeの残量・追加利用OFFは未確認と記録し、Codexは残量とクレジット判定も保存。
- `round-N/input.json`: ファイル本文・差分・HEAD。SHA-256をstateに保存。
- `round-N/prompt.txt`, `invocation.json`, `stdout.txt`, `stderr.txt`, `process.json`, `review.json`: 実際の入出力と判定。起動前エラーでは一部は未作成。

相手セッションは各CLIで `codex resume <ID>` / `claude --resume <ID>` から確認できます。レビュー実行中に同じIDを別クライアントで再開しないでください。アプリのタブを自動で開く機能ではありません。

レビューにはスナップショットを標準入力で渡します。Windowsでファイル読取りのshellコマンドを許可する必要はありません。Codexはread-only、shell/unified_exec/multi_agentを無効化、web_searchをdisabled、ユーザーconfig/rulesを不使用。Claudeはsafe-mode/restricted、builtin toolsなし、MCPを読み込まない設定です。管理者policyは引き続き適用されます。レビュー後は入力と元ファイルを再指紋化し、変更があれば結果を採用しません。

`.revloop/` はGitへ追加しないでください。本文・差分はローカル履歴と各CLIの会話履歴に残ります。レビュー用の作業ディレクトリはOSのTempにrunごとに作成し、履歴の追跡用にパスをstateに残します。

## 検証と今後

```powershell
npm test
# 実際のCLIで小さなFAIL→fixture修正→PASS。契約の利用枠を消費する明示テスト
node test/live-smoke.mjs codex
node test/live-smoke.mjs claude
```

根拠は [調査・設計](docs/RESEARCH.md) と [検証記録](docs/VALIDATION.md)。実AIのレビュー検証と、ホスト上でのSkill全体の自動修正検証を区別しています。

Windows EXEは次段階です。状態機械とCLIアダプターを分離しています。Claudeの診断にはnode-ptyのネイティブConPTY部品とxterm/headlessを使うため、Node SEA等への同梱も別途検証が必要です。EXEにしても両公式CLIのインストール・認証は必要です。配布時にはNodeランタイム解決、署名、更新、クリーンWindows環境での起動を別途検証します。[Node SEA](https://nodejs.org/api/single-executable-applications.html)
