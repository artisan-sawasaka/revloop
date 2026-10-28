# revloop 調査・設計

調査日: 2026-10-18 (JST)。コード実装前の調査結果。公式Web仕様とインストール済みCLIの挙動は分けて記録する。

## 確認済み環境

- Windows / PowerShell、Node.js v24.12.0。
- Codex CLI 0.153.4。`codex login status`: ChatGPT認証。実際の `exec --json` と明示IDによる `exec resume` が成功し、同じthread ID・前ターンの内容を維持した。
- Claude Code 2.1.296。`claude auth status`: claude.ai / Max。しかし実推論はOAuth更新競合、その後期限切れで失敗。ログイン状態だけでは利用可能とは判定できない。再ログイン待ち。APIキーへ自動フォールバックしない。
- 初期フォルダは空でGit未初期化。調査用ファイル以外の既存実装なし。
- `docs/evidence/` にヘルプと実行結果。アカウントのメールアドレスや認証トークンは記録しない。

## 公式仕様と判断

| 要求 | 実現方法 / 制約 |
| --- | --- |
| Claudeから `/revloop` | `.claude/skills/revloop/SKILL.md`。公式の直接呼び出し形式。[Claude skills](https://code.claude.com/docs/en/skills) |
| Codexから `/revloop` | 現環境のTUIで `Unrecognized command '/revloop'` を確認。独自slash alias登録は保証しない。`.agents/skills/revloop/SKILL.md` の `$revloop` または `/skills` を使用。[Codex skills](https://learn.chatgpt.com/docs/build-skills)、[commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli) |
| 相手側の新規セッション | `codex exec --json` / `claude -p --output-format json` を子プロセス起動。IDを永続化し、再レビューは明示IDでresume。[Codex noninteractive](https://learn.chatgpt.com/docs/non-interactive-mode)、[Claude headless](https://code.claude.com/docs/en/headless) |
| 同名化 | 元名が取得できる場合、Claude `--name`。Codex execにnameオプションなし。App Server `thread/name/set` が公式に存在。インストール済みschemaで確認し実機検証後に採用。失敗時はlocal manifestの表示名を保持して警告。UIに自動でタブが開くことは保証しない。[App Server](https://learn.chatgpt.com/docs/app-server) |
| 元チャット維持 | Skill内で元AIが修正する。revloopは元セッションをresumeしない。対話セッションを外から同時再開する方式を採用しない。ホストによる中断・コンテキスト上限は自動反復の外部制約。 |
| 文脈引継ぎ | 元AIが目的・決定事項・制約・検証状況をcontextファイルへ出力。対象ファイル、Git差分、source session ID/titleを添付。異種AIの内部会話状態そのものは共有できない。秘密情報を含む全履歴の自動探索はしない。 |
| 読み取り専用 | レビュー専用スナップショット。Codex `--sandbox read-only -a never`、Claude `--safe-mode --restricted --tools Read,Glob,Grep --permission-mode dontAsk --strict-mcp-config`。権限エラー時にsandboxを緩めない。Claudeのツール制限はOS全体のsandboxではない。管理者policyは別途適用される。[Claude CLI](https://code.claude.com/docs/en/cli-reference) |
| サブスクリプション認証 | 各公式CLIの既存ログインを使用。OAuth秘密値の抽出・転用なし。API課金用環境変数があれば停止。Claude `--bare` はOAuthを読まないため不採用。契約枠・追加利用設定はCLI/アカウント側に従う。無料・無制限とは保証しない。[Codex auth](https://learn.chatgpt.com/docs/auth)、[Claude authentication](https://code.claude.com/docs/en/authentication) |
| Windows EXE | 初期版はNode.js CLI。shell文字列を作らずargv/stdinで起動。npmのcmd/ps1ラッパーはJSエントリへ解決。将来Node SEAへbundle可能な構成。両AIのCLIと認証は別途必要。署名・EXE配布は次段階。 |

## 実装計画

1. TypeScript CLI: `doctor`, `install`, `start`, `review`, `status`, `stop`。ローカル `.revloop/runs/<UUID>/` に状態・context・fingerprint・diff・prompt・raw結果・履歴を保存。
2. `start --source codex|claude --context <file> --title <name> [--source-session <id>]`。Git tracked + untracked（ignored除外）を列挙。非Gitの場合は明示ファイル指定を必須とする。
3. `review --run <id>` が相手CLIを起動し、strict JSONのPASS/FAIL/BLOCKEDを受ける。FAILのみ元AIが修正して同コマンドを反復。元チャットは生きたまま。
4. 最大レビュー回数（既定5）、同一入力再投入・入力循環・指摘の反復、各回timeout、stopファイル、プロセスツリー終了、排他ロック。クラッシュは明示ERRORとして復旧し、PASS扱いしない。
5. スナップショットの上限超過・symlink・除外対象は黙って欠落させず停止。レビュー中の対象変更とsnapshot改変をfingerprintで検出しPASSを採用しない。
6. プロジェクトローカルSkillを生成。既存Skillの上書きはしない。Skillは同じrun IDを使い、終了状態で必ず停止。通常のコード編集・テスト権限を引き継ぐ。
7. 自動テストで状態遷移、JSON不正、CLIエラー、停滞、上限、stop、パス安全性、Windows argv、同時実行を確認。実CLIで一回レビュー・resume・同名化・認証・停止を検証する。実AIの双方向ループは両方の認証が利用可能な範囲で検証。

## 受入れと未確認の区別

実装済み、モック検証、実CLI検証、手動確認待ちをREADMEと検証記録で区別する。現状のClaude OAuth問題で双方向実機検証をPASSとはしない。Codex `/revloop` の非対応は代替入口を仕様として明示する。

## 実装時に判明した点

- Codex App Serverのインストール済みJSON schemaで `thread/name/set` の `threadId` / `name` を確認。実際に自身の検証用レビューthreadを改名し、`thread/read` で同名を確認できた。
- 最初のCodexレビューは、Windowsの実行ポリシーによって `Get-Content input.json` が拒否されBLOCKED。権限を緩めず、完全なスナップショットをstdinへ渡す構成へ変更した。512 KB上限で、超過時は停止する。
- 最終のClaudeアダプターは `--tools ""` を使用。Codexは `features list` で確認した `shell_tool`, `unified_exec`, `multi_agent`, `multi_agent_v2` を `--disable`。web_searchは[公式設定](https://learn.chatgpt.com/docs/web-search)のdisabled。元AIが実行したテスト結果はcontextへ記録し、レビュアー自身はコードを実行しない。
- ユーザーがClaudeへ再ログインした後にclaude.ai認証を確認。この時点のCLIは2.1.302だった（revloopによる更新ではない）。後続の実機結果はVALIDATION.md参照。
